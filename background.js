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
let cookieLock = Promise.resolve();
function withCookieLock(fn) {
  const run = cookieLock.then(fn, fn);
  cookieLock = run.catch(() => {});
  return run;
}

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
  const authNames = new Set(['sessionid', 'sessionid_ss', 'sid_tt', 'sid_guard', 'uid_tt', 'uid_tt_ss']);
  const normal = savedCookies.filter(c => !authNames.has(c.name));
  const auth = savedCookies.filter(c => authNames.has(c.name));

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
    try {
      const result = await chrome.cookies.set(details);
      if (!result && authNames.has(cookie.name)) {
        details.url = `http://${domain}${cookie.path}`;
        details.secure = false;
        delete details.sameSite;
        await chrome.cookies.set(details);
      }
    } catch (e) {
      console.warn(`[即梦切换器] 设置 cookie 失败: ${cookie.name}`, e);
    }
  }
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
  const existIdx = accounts.findIndex(a => a.cookies?.find(c => c.name === 'sessionid')?.value === sid.value);
  const user = status.user || {};
  const account = {
    id: existIdx >= 0 ? accounts[existIdx].id : crypto.randomUUID(),
    name: customName || user.nickname || `账号 ${accounts.length + 1}`,
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

  await clearDomainCookies();
  await new Promise(r => setTimeout(r, 100));
  await restoreCookies(target.cookies);
  await new Promise(r => setTimeout(r, COOKIE_APPLY_DELAY_MS));

  const verified = await verifySession();
  if (!verified) {
    await clearDomainCookies();
    await new Promise(r => setTimeout(r, 200));
    await restoreCookies(target.cookies);
    await new Promise(r => setTimeout(r, COOKIE_APPLY_DELAY_MS));
    if (!(await verifySession())) {
      return { success: false, error: 'Cookie 恢复失败，请重新保存该账号' };
    }
  }

  const tabs = await chrome.tabs.query({ url: '*://*.jianying.com/*' });
  if (tabs.length > 0) {
    for (const tab of tabs) {
      await clearJimengLocalStorage(tab.id);
      chrome.tabs.reload(tab.id, { bypassCache: true });
    }
  } else {
    chrome.tabs.create({ url: JIMENG_HOME });
  }

  return { success: true, account: target };
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

async function importAccounts(incoming, mode) {
  if (!Array.isArray(incoming)) return { success: false, error: '数据不是数组' };
  const sanitized = incoming.filter(a => a?.cookies?.length).map(a => ({
    id: a.id || crypto.randomUUID(), name: a.name || '未命名',
    userId: a.userId || '', nickname: a.nickname || '', avatar: a.avatar || '',
    cookies: a.cookies, savedAt: a.savedAt || Date.now(),
    cachedCredits: a.cachedCredits || null, cachedVip: a.cachedVip || null,
    sessionValid: a.sessionValid ?? null, lastChecked: a.lastChecked || null,
  }));
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

async function checkAccountStatus(accountId) {
  const accounts = await loadAccounts();
  const target = accounts.find(a => a.id === accountId);
  if (!target) return { success: false, error: '账号不存在' };

  const originalCookies = serializeCookies(await getAllDomainCookies());
  const session = new JimengTabSession();
  let status = { valid: false, credits: null, vip: null, user: null };

  try {
    await session.ensure();
    await clearDomainCookies();
    await restoreCookies(target.cookies);
    await new Promise(r => setTimeout(r, COOKIE_APPLY_DELAY_MS));
    await session.reload();
    status = await fetchStatusViaSession(session);
    target.cachedCredits = status.credits;
    target.cachedVip = status.vip;
    target.sessionValid = status.valid;
    target.lastChecked = Date.now();
    await saveAccountsToStorage(accounts);
  } finally {
    await session.cleanup();
    await clearDomainCookies();
    if (originalCookies.length > 0) await restoreCookies(originalCookies);
  }
  return { success: true, status, accountId };
}

async function checkAllStatuses() {
  const accounts = await loadAccounts();
  if (!accounts.length) return { success: false, error: '没有保存的账号' };

  const originalCookies = serializeCookies(await getAllDomainCookies());
  const session = new JimengTabSession();
  const results = [];
  const total = accounts.length;

  try {
    await broadcastProgress({ phase: 'init', current: 0, total, message: '准备查询...' });
    await session.ensure();

    for (let i = 0; i < accounts.length; i++) {
      if (i > 0) await new Promise(r => setTimeout(r, 1000));
      const acc = accounts[i];
      await broadcastProgress({ phase: 'check', current: i + 1, total, name: acc.name, step: 'querying' });

      let status = { valid: false, credits: null, vip: null, user: null };
      try {
        await clearDomainCookies();
        await restoreCookies(acc.cookies);
        await new Promise(r => setTimeout(r, COOKIE_APPLY_DELAY_MS));
        await session.reload();
        status = await fetchStatusViaSession(session);
      } catch (e) {
        console.warn(`[即梦切换器] 查询 ${acc.name} 失败:`, e);
      }

      acc.cachedCredits = status.credits;
      acc.cachedVip = status.vip;
      acc.sessionValid = status.valid;
      acc.lastChecked = Date.now();
      results.push({ accountId: acc.id, name: acc.name, ...status });
    }
    // 最后一次性保存（不再每个账号 flush，避免触发 popup 频繁 re-render）
    await saveAccountsToStorage(accounts);
  } finally {
    await broadcastProgress({ phase: 'restore', current: total, total, message: '恢复登录状态...' });
    await session.cleanup();
    await clearDomainCookies();
    if (originalCookies.length > 0) await restoreCookies(originalCookies);
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
        case 'saveCurrentAccount': return await saveCurrentAccount(msg.name);
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
