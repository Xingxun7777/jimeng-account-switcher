// ================================================================
// 即梦账号切换器 - Background Service Worker V3
// 精简版：快速切换账号 + 积分/VIP 状态展示
// 不做积分领取（即梦免费积分登录即领，次日过期，无需囤积）
// ================================================================

// ======================== 常量 ========================
const JIMENG_DOMAIN = '.jianying.com';
const JIMENG_URL = 'https://jimeng.jianying.com';
const JIMENG_HOME = `${JIMENG_URL}/ai-tool/home`;
const STORAGE_KEY = 'jimeng_accounts';
const SETTINGS_KEY = 'jimeng_settings';

const API_PATH = {
  userInfo: '/passport/account/info/v2?account_sdk_source=web',
  userCredit: '/commerce/v1/benefits/user_credit',
  subscription: '/commerce/v1/subscription/user_info',
};

const COOKIE_APPLY_DELAY_MS = 600;
const TAB_INIT_GRACE_MS = 1500;
const TAB_LOAD_TIMEOUT_MS = 20000;

// ======================== 进度广播 ========================
async function broadcastProgress(payload) {
  try {
    await chrome.runtime.sendMessage({ __progress: true, ...payload });
  } catch {}
}

// ======================== Cookie 互斥锁 ========================
// 所有会操作全局 cookie store 的任务必须串行，防止并发覆盖。
// 前一个任务无论成功或失败（.then(fn, fn) 的双参形式），后续任务都继续执行，
// 避免一次失败把整条链卡死。注意 fn 必须是无参箭头函数（不接收 promise value）。
let cookieLock = Promise.resolve();
function withCookieLock(fn) {
  const run = cookieLock.then(() => fn(), () => fn());
  cookieLock = run.catch(() => {});
  return run;
}

// ======================== Pending Restore（SW 崩溃防护）========================
// 开始批量操作前把原始 cookie 快照持久化，结束时清除。
// 下次 SW 启动/安装时若发现有残留 → 说明上次异常终止 → 自动恢复。
const PENDING_RESTORE_KEY = '__pending_cookie_restore';

async function persistPendingRestore(snapshot) {
  try {
    await chrome.storage.local.set({ [PENDING_RESTORE_KEY]: { cookies: snapshot, ts: Date.now() } });
  } catch (e) {
    console.warn('[即梦切换器] 持久化 pending restore 失败:', e);
  }
}

async function clearPendingRestore() {
  try { await chrome.storage.local.remove(PENDING_RESTORE_KEY); } catch {}
}

async function tryRecoverPendingRestore() {
  try {
    const r = await chrome.storage.local.get(PENDING_RESTORE_KEY);
    const pending = r[PENDING_RESTORE_KEY];
    if (!pending?.cookies?.length) return;
    // 只恢复 1 小时内的快照（太旧可能已无意义）
    if (Date.now() - (pending.ts || 0) > 60 * 60 * 1000) {
      await clearPendingRestore();
      return;
    }
    console.warn('[即梦切换器] 检测到上次批量操作异常终止，正在恢复原 cookie...');
    await clearDomainCookies();
    await restoreCookies(pending.cookies);
    await clearPendingRestore();
  } catch (e) {
    console.error('[即梦切换器] 自动恢复失败:', e);
  }
}

chrome.runtime.onStartup.addListener(() => { tryRecoverPendingRestore(); });
chrome.runtime.onInstalled.addListener(() => { tryRecoverPendingRestore(); });

// ======================== Cookie 操作 ========================

async function getAllDomainCookies() {
  const [a, b] = await Promise.all([
    chrome.cookies.getAll({ domain: JIMENG_DOMAIN }),
    chrome.cookies.getAll({ domain: 'jimeng.jianying.com' }),
  ]);
  const seen = new Set();
  const all = [];
  for (const c of [...a, ...b]) {
    const key = `${c.name}|${c.domain}|${c.path}`;
    if (!seen.has(key)) { seen.add(key); all.push(c); }
  }
  return all;
}

async function clearDomainCookies() {
  const cookies = await getAllDomainCookies();
  await Promise.all(cookies.map(cookie => {
    const domain = cookie.domain.startsWith('.') ? cookie.domain.slice(1) : cookie.domain;
    return chrome.cookies.remove({ url: `https://${domain}${cookie.path}`, name: cookie.name });
  }));
  const remaining = await getAllDomainCookies();
  if (remaining.length > 0) {
    for (const c of remaining) {
      const d = c.domain.startsWith('.') ? c.domain.slice(1) : c.domain;
      try { await chrome.cookies.remove({ url: `http://${d}${c.path}`, name: c.name }); } catch {}
      try { await chrome.cookies.remove({ url: `https://${d}${c.path}`, name: c.name }); } catch {}
    }
  }
}

async function restoreCookies(savedCookies) {
  // 关键 auth cookie 名单。先写普通 cookie 再写 auth，确保顺序正确。
  const authNames = new Set(['sessionid', 'sessionid_ss', 'sid_tt', 'sid_guard', 'uid_tt', 'uid_tt_ss']);
  const normal = savedCookies.filter(c => !authNames.has(c.name));
  const auth = savedCookies.filter(c => authNames.has(c.name));
  const failures = [];

  for (const cookie of [...normal, ...auth]) {
    const domain = cookie.domain.startsWith('.') ? cookie.domain.slice(1) : cookie.domain;
    const details = {
      url: `https://${domain}${cookie.path}`,
      name: cookie.name, value: cookie.value, domain: cookie.domain,
      path: cookie.path, secure: cookie.secure, httpOnly: cookie.httpOnly,
    };
    if (cookie.sameSite && cookie.sameSite !== 'unspecified') {
      details.sameSite = cookie.sameSite;
      if (cookie.sameSite === 'no_restriction') details.secure = true;
    }
    if (cookie.expirationDate) details.expirationDate = cookie.expirationDate;

    // 安全策略：只允许 HTTPS + secure cookie 写入。
    // v1.0~v1.2.x 曾在 auth cookie 写入失败时降级为 http+secure:false+去 sameSite 重试，
    // 这等价于把关键登录凭证暴露在明文上下文，已在 v1.3.0 移除。
    try {
      const result = await chrome.cookies.set(details);
      if (!result) {
        failures.push({ name: cookie.name, isAuth: authNames.has(cookie.name) });
        console.warn(`[即梦切换器] cookie 写入失败（不降级重试）: ${cookie.name}`);
      }
    } catch (e) {
      failures.push({ name: cookie.name, isAuth: authNames.has(cookie.name), error: e.message });
      console.warn(`[即梦切换器] cookie 写入异常: ${cookie.name}`, e);
    }
  }

  return {
    success: failures.length === 0,
    failures,
    authFailed: failures.some(f => f.isAuth),
  };
}

async function verifySession() {
  const sid = await chrome.cookies.get({ url: 'https://jimeng.jianying.com/', name: 'sessionid' });
  return !!(sid && sid.value);
}

function serializeCookies(cookies) {
  return cookies.map(c => ({
    name: c.name, value: c.value, domain: c.domain, path: c.path,
    secure: c.secure, httpOnly: c.httpOnly, sameSite: c.sameSite,
    expirationDate: c.expirationDate, hostOnly: c.hostOnly,
  }));
}

// ======================== JimengTabSession ========================
class JimengTabSession {
  constructor() { this.tabId = null; this.isInternal = false; }

  async ensure() {
    if (this.tabId !== null) {
      try { await chrome.tabs.get(this.tabId); return; } catch { this.tabId = null; }
    }
    const tab = await chrome.tabs.create({ url: JIMENG_HOME, active: false });
    this.tabId = tab.id;
    this.isInternal = true;
    await this.waitForComplete();
  }

  async waitForComplete(timeoutMs = TAB_LOAD_TIMEOUT_MS) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      try {
        const tab = await chrome.tabs.get(this.tabId);
        if (tab.status === 'complete') {
          await new Promise(r => setTimeout(r, TAB_INIT_GRACE_MS));
          return;
        }
      } catch (e) { throw new Error(`Tab 已关闭: ${e.message}`); }
      await new Promise(r => setTimeout(r, 300));
    }
    throw new Error(`Tab 加载超时 (${timeoutMs / 1000}s)`);
  }

  async reload() {
    if (this.tabId === null) throw new Error('Tab 未初始化');
    await chrome.tabs.reload(this.tabId, { bypassCache: true });
    await new Promise(r => setTimeout(r, 300));
    await this.waitForComplete();
  }

  async fetch(path, body = {}, method = 'POST') {
    if (this.tabId === null) throw new Error('Tab 未初始化');
    const results = await chrome.scripting.executeScript({
      target: { tabId: this.tabId },
      world: 'MAIN',
      args: [path, body, method],
      func: async (p, b, m) => {
        try {
          const init = {
            method: m, credentials: 'include',
            headers: { 'Content-Type': 'application/json', 'Accept': 'application/json, text/plain, */*' },
          };
          if (m === 'POST') init.body = JSON.stringify(b || {});
          const resp = await fetch(`https://jimeng.jianying.com${p}`, init);
          const text = await resp.text();
          let data = null;
          try { data = JSON.parse(text); } catch {}
          return { ok: resp.ok, status: resp.status, data };
        } catch (e) { return { ok: false, status: 0, error: String(e?.message || e) }; }
      },
    });
    if (!results?.[0]) throw new Error('executeScript 返回空');
    return results[0].result || { ok: false, error: '空结果' };
  }

  async cleanup() {
    if (this.isInternal && this.tabId !== null) {
      try { await chrome.tabs.remove(this.tabId); } catch {}
    }
    this.tabId = null;
    this.isInternal = false;
  }
}

// ======================== 数据提取 ========================

function extractCreditsObj(resp) {
  const c = resp?.data?.data?.credit || resp?.data?.credit;
  if (!c) return null;
  const gift = c.gift_credit || 0, purchase = c.purchase_credit || 0, vip = c.vip_credit || 0;
  return { gift, purchase, vip, total: gift + purchase + vip };
}

function extractVipObj(resp) {
  const v = resp?.data?.data || resp?.data;
  if (!v) return null;
  return {
    isVip: !!(v.is_vip || v.vip_type),
    vipType: v.vip_type_name || v.vip_type || '',
    expireTime: v.expire_time || v.vip_expire_time || 0,
  };
}

function extractUserObj(resp) {
  const d = resp?.data?.user_id ? resp.data : (resp?.data?.data || resp?.data);
  if (!d) return null;
  return {
    userId: String(d.user_id || d.uid || ''),
    nickname: d.name || d.screen_name || d.nickname || '',
    avatar: d.avatar_url || d.avatar_large || '',
  };
}

function isAuthFailure(resp) {
  if (!resp) return true;
  if (resp.status === 401 || resp.status === 403) return true;
  const d = resp.data;
  if (!d) return false;
  const errno = d.errno ?? d.status_code ?? d.ret;
  if (errno === 10000 || errno === 10001 || errno === 40001) return true;
  const msg = String(d.errmsg || d.message || '').toLowerCase();
  return msg.includes('not login') || msg.includes('未登录') || msg.includes('login required');
}

// ======================== 账号存储 ========================

async function loadAccounts() {
  const r = await chrome.storage.local.get(STORAGE_KEY);
  return r[STORAGE_KEY] || [];
}

async function saveAccountsToStorage(accounts) {
  await chrome.storage.local.set({ [STORAGE_KEY]: accounts });
}

async function loadSettings() {
  const r = await chrome.storage.local.get(SETTINGS_KEY);
  return r[SETTINGS_KEY] || {};
}

async function saveSettings(patch) {
  const cur = await loadSettings();
  await chrome.storage.local.set({ [SETTINGS_KEY]: { ...cur, ...patch } });
}

// ======================== 账号业务逻辑 ========================

async function detectCurrentAccount() {
  const cookies = await getAllDomainCookies();
  const sid = cookies.find(c => c.name === 'sessionid');
  if (!sid || !sid.value) return null;
  const accounts = await loadAccounts();
  const match = accounts.find(a => a.cookies?.find(c => c.name === 'sessionid')?.value === sid.value);
  return match ? match.id : null;
}

async function fetchStatusViaSession(session) {
  const result = { valid: false, credits: null, vip: null, user: null };
  const infoResp = await session.fetch(API_PATH.userInfo, {}, 'POST');
  if (isAuthFailure(infoResp)) return result;
  result.user = extractUserObj(infoResp?.data);
  result.valid = !!(result.user?.userId);
  if (!result.valid) return result;
  try { result.credits = extractCreditsObj(await session.fetch(API_PATH.userCredit, {}, 'POST')); } catch {}
  try { result.vip = extractVipObj(await session.fetch(API_PATH.subscription, {}, 'POST')); } catch {}
  return result;
}

async function saveCurrentAccount(customName) {
  const cookies = await getAllDomainCookies();
  if (!cookies.length) return { success: false, error: '未检测到即梦登录状态，请先在浏览器中登录即梦' };
  const sid = cookies.find(c => c.name === 'sessionid');
  if (!sid?.value) return { success: false, error: '未找到 sessionid cookie，请确认已登录即梦' };

  const session = new JimengTabSession();
  let status = { valid: false, credits: null, vip: null, user: null };
  try { await session.ensure(); status = await fetchStatusViaSession(session); }
  catch (e) { console.warn('[即梦切换器] 查询状态失败:', e); }
  finally { await session.cleanup(); }

  const accounts = await loadAccounts();
  const user = status.user || {};
  // 去重优先级：userId > sessionid
  // 同一账号重新登录 sessionid 会变，但 userId 不变——按 userId 能识别为同一账号自动更新
  let existIdx = -1;
  if (user.userId) {
    existIdx = accounts.findIndex(a => a.userId && a.userId === user.userId);
  }
  if (existIdx < 0) {
    existIdx = accounts.findIndex(a => a.cookies?.find(c => c.name === 'sessionid')?.value === sid.value);
  }

  const account = {
    id: existIdx >= 0 ? accounts[existIdx].id : crypto.randomUUID(),
    // 已存在的账号保留用户自定义 name，除非显式 customName
    name: customName || (existIdx >= 0 ? accounts[existIdx].name : (user.nickname || `账号 ${accounts.length + 1}`)),
    userId: user.userId || '', nickname: user.nickname || '', avatar: user.avatar || '',
    cookies: serializeCookies(cookies), savedAt: Date.now(),
    cachedCredits: status.credits, cachedVip: status.vip,
    sessionValid: status.valid, lastChecked: Date.now(),
  };
  if (existIdx >= 0) accounts[existIdx] = account; else accounts.push(account);
  await saveAccountsToStorage(accounts);
  return { success: true, account, isUpdate: existIdx >= 0 };
}

async function clearJimengLocalStorage(tabId) {
  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      func: () => {
        const keys = [];
        for (let i = 0; i < localStorage.length; i++) {
          const k = localStorage.key(i);
          if (k.includes('passport') || k.includes('token') || k.includes('user_status') ||
              k.includes('receive_credits') || k.includes('dialog_manager_daily') ||
              k.includes('intro_dialog_has_showed') || k.includes('bind_capcut_dialog') ||
              k.includes('__tea_cache_tokens')) keys.push(k);
        }
        keys.forEach(k => localStorage.removeItem(k));
        sessionStorage.clear();
      },
    });
  } catch {}
}

async function switchAccount(accountId) {
  const accounts = await loadAccounts();
  const target = accounts.find(a => a.id === accountId);
  if (!target) return { success: false, error: '账号不存在' };

  // 快照原 cookie，失败时回滚
  const snapshot = serializeCookies(await getAllDomainCookies());
  await persistPendingRestore(snapshot);

  const tryRestore = async () => {
    await clearDomainCookies();
    await new Promise(r => setTimeout(r, 100));
    const restoreResult = await restoreCookies(target.cookies);
    await new Promise(r => setTimeout(r, COOKIE_APPLY_DELAY_MS));
    return restoreResult;
  };

  try {
    let r = await tryRestore();
    if (r.authFailed || !(await verifySession())) {
      console.warn('[即梦切换器] 首次切换失败，重试一次');
      r = await tryRestore();
      if (r.authFailed || !(await verifySession())) {
        // 彻底失败，回滚原 cookie
        await clearDomainCookies();
        if (snapshot.length > 0) await restoreCookies(snapshot);
        await clearPendingRestore();
        return {
          success: false,
          error: 'Cookie 恢复失败，已回滚到原账号。请重新保存该账号的 cookie。',
          rolledBack: true,
        };
      }
    }

    // 切换成功：P1-13 只 reload 当前激活的 jimeng tab，其他 tab 注入提示
    const tabs = await chrome.tabs.query({ url: '*://*.jianying.com/*' });
    if (tabs.length > 0) {
      for (const tab of tabs) {
        if (tab.active) {
          await clearJimengLocalStorage(tab.id);
          try { await chrome.tabs.reload(tab.id, { bypassCache: true }); } catch {}
        } else {
          // 非 active tab 只注入非阻塞提示，不强制 reload，保留用户未保存工作
          await notifyTabAccountSwitched(tab.id, target.name);
        }
      }
    } else {
      try { await chrome.tabs.create({ url: JIMENG_HOME }); } catch {}
    }

    await clearPendingRestore();
    return { success: true, account: target };
  } catch (e) {
    // 异常路径：尝试回滚
    console.error('[即梦切换器] switchAccount 异常，尝试回滚:', e);
    try {
      await clearDomainCookies();
      if (snapshot.length > 0) await restoreCookies(snapshot);
    } catch {}
    await clearPendingRestore();
    return { success: false, error: `切换失败: ${e.message}`, rolledBack: true };
  }
}

// 非阻塞提示：向目标 tab 注入一条浮动 toast，告知账号已切换
async function notifyTabAccountSwitched(tabId, newAccountName) {
  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      args: [newAccountName],
      func: (name) => {
        const id = '__jimeng_switcher_toast__';
        document.getElementById(id)?.remove();
        const div = document.createElement('div');
        div.id = id;
        div.textContent = `账号已切换为「${name}」，刷新页面后生效`;
        div.style.cssText = [
          'position:fixed', 'top:16px', 'right:16px', 'z-index:2147483647',
          'background:#4361ee', 'color:#fff', 'padding:10px 14px', 'border-radius:8px',
          'font-size:13px', 'font-family:-apple-system,"Microsoft YaHei",sans-serif',
          'box-shadow:0 4px 12px rgba(0,0,0,0.2)', 'cursor:pointer',
          'max-width:280px', 'line-height:1.4',
        ].join(';');
        div.onclick = () => location.reload();
        document.body.appendChild(div);
        setTimeout(() => div.remove(), 8000);
      },
    });
  } catch {}
}

async function deleteAccount(accountId) {
  const accounts = await loadAccounts();
  await saveAccountsToStorage(accounts.filter(a => a.id !== accountId));
  return { success: true };
}

async function renameAccount(accountId, newName) {
  const accounts = await loadAccounts();
  const target = accounts.find(a => a.id === accountId);
  if (!target) return { success: false, error: '账号不存在' };
  target.name = newName;
  await saveAccountsToStorage(accounts);
  return { success: true };
}

// 校验单个 cookie 对象：只接受 jianying.com 域、字段类型合法
function sanitizeCookie(c) {
  if (!c || typeof c !== 'object') return null;
  if (typeof c.name !== 'string' || !c.name) return null;
  if (typeof c.value !== 'string') return null;
  if (typeof c.domain !== 'string' || !/\.?jianying\.com$/i.test(c.domain)) return null;
  if (typeof c.path !== 'string' || !c.path.startsWith('/')) return null;
  const clean = {
    name: c.name, value: c.value, domain: c.domain, path: c.path,
    secure: c.secure === true, httpOnly: c.httpOnly === true,
  };
  if (typeof c.sameSite === 'string' &&
      ['strict', 'lax', 'no_restriction', 'unspecified'].includes(c.sameSite)) {
    clean.sameSite = c.sameSite;
  }
  if (typeof c.expirationDate === 'number' && c.expirationDate > 0) {
    clean.expirationDate = c.expirationDate;
  }
  if (typeof c.hostOnly === 'boolean') clean.hostOnly = c.hostOnly;
  return clean;
}

// 校验头像 URL：只允许 https 协议
function sanitizeAvatar(url) {
  if (typeof url !== 'string' || !url) return '';
  try {
    const u = new URL(url);
    return u.protocol === 'https:' ? url : '';
  } catch { return ''; }
}

function sanitizeImportedAccount(a) {
  if (!a || typeof a !== 'object') return null;
  const cookies = Array.isArray(a.cookies) ? a.cookies.map(sanitizeCookie).filter(Boolean) : [];
  if (!cookies.length) return null;
  // 必须有 sessionid 才算有效账号
  if (!cookies.find(c => c.name === 'sessionid')) return null;
  return {
    id: typeof a.id === 'string' && a.id ? a.id : crypto.randomUUID(),
    name: typeof a.name === 'string' ? a.name.slice(0, 50) : '未命名',
    userId: typeof a.userId === 'string' ? a.userId : '',
    nickname: typeof a.nickname === 'string' ? a.nickname.slice(0, 100) : '',
    avatar: sanitizeAvatar(a.avatar),
    cookies,
    savedAt: typeof a.savedAt === 'number' ? a.savedAt : Date.now(),
    cachedCredits: (a.cachedCredits && typeof a.cachedCredits === 'object') ? a.cachedCredits : null,
    cachedVip: (a.cachedVip && typeof a.cachedVip === 'object') ? a.cachedVip : null,
    sessionValid: typeof a.sessionValid === 'boolean' ? a.sessionValid : null,
    lastChecked: typeof a.lastChecked === 'number' ? a.lastChecked : null,
  };
}

async function importAccounts(incoming, mode) {
  if (!Array.isArray(incoming)) return { success: false, error: '数据不是数组' };
  const sanitized = incoming.map(sanitizeImportedAccount).filter(Boolean);
  if (!sanitized.length) return { success: false, error: '没有有效的账号数据（所有条目都因字段校验失败被拒绝）' };
  if (mode === 'replace') {
    await saveAccountsToStorage(sanitized);
    return { success: true, added: sanitized.length, updated: 0 };
  }
  const current = await loadAccounts();
  const getSid = a => a.cookies?.find(c => c.name === 'sessionid')?.value;
  const bySid = new Map(current.map(a => [getSid(a), a]));
  let added = 0, updated = 0;
  for (const a of sanitized) {
    const sid = getSid(a);
    if (sid && bySid.has(sid)) { Object.assign(bySid.get(sid), a, { id: bySid.get(sid).id }); updated++; }
    else { current.push(a); added++; }
  }
  await saveAccountsToStorage(current);
  return { success: true, added, updated };
}

// ======================== 状态查询 ========================

// 公共 primitive：切到目标账号 cookie → 等生效 → reload tab → 执行 fn → 不恢复（由调用方统一恢复）
async function withAccountCookies(account, session, fn) {
  await clearDomainCookies();
  await restoreCookies(account.cookies);
  await new Promise(r => setTimeout(r, COOKIE_APPLY_DELAY_MS));
  if (session) await session.reload();
  return fn();
}

// load+merge：只把新状态 merge 到最新的 accounts（而不是覆盖整份），
// 避免用户在批量查询期间做的删除/重命名/导入被覆盖。
async function mergeAccountStatus(accountId, status) {
  const accounts = await loadAccounts();
  const target = accounts.find(a => a.id === accountId);
  if (!target) return; // 用户中途删除了，不回写
  target.cachedCredits = status.credits;
  target.cachedVip = status.vip;
  target.sessionValid = status.valid;
  target.lastChecked = Date.now();
  await saveAccountsToStorage(accounts);
}

async function checkAccountStatus(accountId) {
  const accountsSnapshot = await loadAccounts();
  const target = accountsSnapshot.find(a => a.id === accountId);
  if (!target) return { success: false, error: '账号不存在' };

  const originalCookies = serializeCookies(await getAllDomainCookies());
  await persistPendingRestore(originalCookies);
  const session = new JimengTabSession();
  let status = { valid: false, credits: null, vip: null, user: null };

  try {
    await session.ensure();
    status = await withAccountCookies(target, session, () => fetchStatusViaSession(session));
    await mergeAccountStatus(accountId, status);
  } finally {
    await session.cleanup();
    await clearDomainCookies();
    if (originalCookies.length > 0) await restoreCookies(originalCookies);
    await clearPendingRestore();
  }
  return { success: true, status, accountId };
}

async function checkAllStatuses() {
  const accountsSnapshot = await loadAccounts();
  if (!accountsSnapshot.length) return { success: false, error: '没有保存的账号' };

  const originalCookies = serializeCookies(await getAllDomainCookies());
  await persistPendingRestore(originalCookies);
  const session = new JimengTabSession();
  const results = [];
  const total = accountsSnapshot.length;

  try {
    await broadcastProgress({ phase: 'init', current: 0, total, message: '准备查询...' });
    await session.ensure();

    for (let i = 0; i < accountsSnapshot.length; i++) {
      if (i > 0) await new Promise(r => setTimeout(r, 1000));
      const acc = accountsSnapshot[i];
      await broadcastProgress({ phase: 'check', current: i + 1, total, name: acc.name, step: 'querying' });

      let status = { valid: false, credits: null, vip: null, user: null };
      try {
        status = await withAccountCookies(acc, session, () => fetchStatusViaSession(session));
      } catch (e) {
        console.warn(`[即梦切换器] 查询 ${acc.name} 失败:`, e);
      }

      // 每个账号独立 merge，不覆盖用户中间修改
      await mergeAccountStatus(acc.id, status);
      results.push({ accountId: acc.id, name: acc.name, ...status });
    }
  } finally {
    await broadcastProgress({ phase: 'restore', current: total, total, message: '恢复登录状态...' });
    await session.cleanup();
    await clearDomainCookies();
    if (originalCookies.length > 0) await restoreCookies(originalCookies);
    await clearPendingRestore();
    await broadcastProgress({ phase: 'done', current: total, total });
  }

  return { success: true, results };
}

// ======================== 消息路由 ========================

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  const handler = async () => {
    try {
      switch (msg.action) {
        case 'getAccounts':    return await loadAccounts();
        case 'getSettings':    return await loadSettings();
        case 'saveSettings':   await saveSettings(msg.patch || {}); return { success: true };
        case 'detectCurrent':  return await detectCurrentAccount();
        case 'saveCurrentAccount': return await withCookieLock(() => saveCurrentAccount(msg.name));
        case 'switchAccount':  return await withCookieLock(() => switchAccount(msg.accountId));
        case 'deleteAccount':  return await deleteAccount(msg.accountId);
        case 'renameAccount':  return await renameAccount(msg.accountId, msg.name);
        case 'importAccounts': return await importAccounts(msg.accounts, msg.mode || 'merge');
        case 'checkStatus':    return await withCookieLock(() => checkAccountStatus(msg.accountId));
        case 'checkAllStatuses': return await withCookieLock(() => checkAllStatuses());
        default: return { error: `未知操作: ${msg.action}` };
      }
    } catch (e) {
      console.error('[即梦切换器] 错误:', e);
      return { success: false, error: e.message };
    }
  };
  handler().then(sendResponse);
  return true;
});
