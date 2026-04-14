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

// ======================== 互斥锁 ========================
// Cookie 锁：保护全局 cookie store 的读写不被并发覆盖
// Storage 锁：保护 accounts/settings 的 read-modify-write 事务
// 两者独立，因为状态查询流程需要同时持有两把锁，但锁定范围不同。
//
// .then(fn, fn) 双参形式：无论前一个 task 成功或失败，下一个都继续执行，
// 避免一次失败把整条链卡死。fn 必须是无参箭头函数（不接收 promise value）。
//
// 加 LOCK_TIMEOUT_MS 兜底：单任务超时自动 reject，避免永久挂起。
const LOCK_TIMEOUT_MS = 30000;

function makeLock() {
  let chain = Promise.resolve();
  return function withLock(fn) {
    const gated = chain.then(() => fn(), () => fn());
    // ⚠️ 关键：锁的排队链必须绑定在 gated（真实任务）上，而不是 race 结果。
    // JS Promise 无法被强制取消——如果 chain = race(gated, timeout) 的 catch 结果，
    // timeout 触发 30s 后 chain 立即 resolve → 下一个 withLock 进入 → 但 gated 的 fn 还在跑，
    // 导致并发冲突（两个任务同时操作 cookie/storage）。
    // 正确做法：chain 锁住直到 gated 真正结束；timeout 只是让调用方收到超时 rejection，
    // 但锁本身继续保持到 fn 实际完成（即使 fn 卡死，后续操作也会一直等，但这比并发冲突安全）。
    chain = gated.catch(() => {});
    const timedOut = new Promise((_, reject) => {
      setTimeout(() => reject(new Error(`lock timeout (${LOCK_TIMEOUT_MS}ms)`)), LOCK_TIMEOUT_MS);
    });
    return Promise.race([gated, timedOut]);
  };
}

const withCookieLock = makeLock();
const withStorageLock = makeLock();

// ======================== Pending Restore 阶段化状态机（SW 崩溃防护）========================
// 三阶段状态，防止"成功切换但未清标记"窗口内崩溃导致下次启动反向恢复：
//   armed      : 刚备份 snapshot，业务未开始 → 崩溃时应恢复
//   business   : 业务执行中                → 崩溃时应恢复（同 armed）
//   committing : 业务已成功完成，准备清标记 → 崩溃时**不恢复**（避免回滚成功切换）
//
// tryRecover 仅在 armed/business 状态才真正恢复，committing 状态直接清除标记。
// 恢复前检查 restoreCookies 的返回值，失败时保留 pending 让下次启动再试（最多 3 次）。
const PENDING_RESTORE_KEY = '__pending_cookie_restore';
const MAX_RECOVERY_ATTEMPTS = 3;

async function persistPendingRestore(snapshot, stage = 'armed') {
  try {
    // 冲突检测：如果上次的 pending 还没清掉，说明可能是恢复失败或上次崩溃
    const existing = (await chrome.storage.local.get(PENDING_RESTORE_KEY))[PENDING_RESTORE_KEY];
    if (existing?.cookies?.length && existing.stage !== 'committing') {
      console.warn(`[即梦切换器] 检测到未完成的 pending (stage=${existing.stage})，将被新业务覆盖`);
    }
    // 新业务从 attempts=0 开始，不继承旧值（避免被旧失败次数过早触发 MAX）
    await chrome.storage.local.set({
      [PENDING_RESTORE_KEY]: {
        cookies: snapshot,
        stage,
        ts: Date.now(),
        attempts: 0,
      },
    });
  } catch (e) {
    console.warn('[即梦切换器] 持久化 pending restore 失败:', e);
  }
}

async function markPendingStage(stage) {
  try {
    const r = await chrome.storage.local.get(PENDING_RESTORE_KEY);
    const pending = r[PENDING_RESTORE_KEY];
    if (!pending) return;
    pending.stage = stage;
    pending.ts = Date.now();
    await chrome.storage.local.set({ [PENDING_RESTORE_KEY]: pending });
  } catch {}
}

async function clearPendingRestore() {
  try { await chrome.storage.local.remove(PENDING_RESTORE_KEY); } catch {}
}

// 防止 onStartup 和 onInstalled 并发触发两份恢复任务
let recoveryPromise = null;

async function tryRecoverPendingRestore() {
  if (recoveryPromise) return recoveryPromise;
  recoveryPromise = (async () => {
    try {
      // 关键：所有对 pending 的读/写都必须在 cookieLock 下，
      // 防止和 switchAccount / checkAllStatuses 的 pending 操作竞争导致误删。
      await withCookieLock(async () => {
        const r = await chrome.storage.local.get(PENDING_RESTORE_KEY);
        const pending = r[PENDING_RESTORE_KEY];
        if (!pending?.cookies?.length) return;

        // committing 状态：业务已成功，不恢复，直接清
        if (pending.stage === 'committing') {
          console.log('[即梦切换器] 清理已提交的 pending（不恢复）');
          await clearPendingRestore();
          return;
        }

        // 超出尝试次数
        const attempts = (pending.attempts || 0) + 1;
        if (attempts > MAX_RECOVERY_ATTEMPTS) {
          console.warn('[即梦切换器] pending 恢复尝试超限，放弃');
          await clearPendingRestore();
          return;
        }

        // 超过 1 小时也不恢复
        if (Date.now() - (pending.ts || 0) > 60 * 60 * 1000) {
          await clearPendingRestore();
          return;
        }

        console.warn(`[即梦切换器] 检测到上次异常终止（stage=${pending.stage}），尝试第 ${attempts} 次恢复...`);
        // 先更新 attempts 计数，即使恢复失败也不丢信息
        pending.attempts = attempts;
        await chrome.storage.local.set({ [PENDING_RESTORE_KEY]: pending });

        await clearDomainCookies();
        const res = await restoreCookies(pending.cookies);
        if (!res.success) {
          // 恢复失败：保留 pending，下次再试
          console.error(`[即梦切换器] 恢复失败（authFailed=${res.authFailed}），保留 pending`);
          return;
        }
        // 恢复成功，清除
        await clearPendingRestore();
        console.log('[即梦切换器] 恢复成功');
      });
    } catch (e) {
      console.error('[即梦切换器] 自动恢复流程异常:', e);
    } finally {
      recoveryPromise = null;
    }
  })();
  return recoveryPromise;
}

chrome.runtime.onStartup.addListener(() => { tryRecoverPendingRestore(); });
chrome.runtime.onInstalled.addListener(() => { tryRecoverPendingRestore(); });

// 每次敏感操作入口（经由消息路由）也懒触发一次检查，
// 应对 MV3 SW 空闲挂起后被消息唤醒的场景（onStartup/onInstalled 都不会触发）。
let lastRecoveryCheckTs = 0;
async function maybeRecoverOnWakeup() {
  // 节流：同一次 SW 生命周期内每 30 秒最多检查一次
  if (Date.now() - lastRecoveryCheckTs < 30000) return;
  lastRecoveryCheckTs = Date.now();
  try {
    const r = await chrome.storage.local.get(PENDING_RESTORE_KEY);
    if (r[PENDING_RESTORE_KEY]?.cookies?.length) {
      await tryRecoverPendingRestore();
    }
  } catch {}
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
  // 关键 auth cookie 名单。先写普通 cookie 再写 auth，确保顺序正确。
  const authNames = new Set(['sessionid', 'sessionid_ss', 'sid_tt', 'sid_guard', 'uid_tt', 'uid_tt_ss']);
  const normal = savedCookies.filter(c => !authNames.has(c.name));
  const auth = savedCookies.filter(c => authNames.has(c.name));
  const failures = [];

  for (const cookie of [...normal, ...auth]) {
    const domain = cookie.domain.startsWith('.') ? cookie.domain.slice(1) : cookie.domain;
    const details = {
      url: `https://${domain}${cookie.path}`,
      name: cookie.name, value: cookie.value,
      path: cookie.path, secure: cookie.secure, httpOnly: cookie.httpOnly,
    };
    // host-only cookie 不传 domain（浏览器从 url 推断为 host-only）
    // 否则 chrome.cookies.set 拿到 domain 会把它转为 domain cookie，作用域被放宽
    if (cookie.hostOnly !== true) {
      details.domain = cookie.domain;
    }
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

// 两级校验：
//   浅层：只确认 sessionid cookie 存在（快，用于批量场景）
//   深层：创建临时 tab 调 userInfo API，验证返回的 userId 匹配目标账号（慢，用于切换）
//
// expectedAccount: 可选，传入后做深层校验（要求 API 返回的 userId 与该账号保存的 userId 一致）
async function verifySession(expectedAccount = null) {
  const sid = await chrome.cookies.get({ url: 'https://jimeng.jianying.com/', name: 'sessionid' });
  if (!sid?.value) return false;

  // 无目标账号 → 浅层校验够
  if (!expectedAccount || !expectedAccount.userId) return true;

  // 深层校验：用 TabSession 调 userInfo，匹配 userId
  // 只有保存过 userId 的账号才能做深层校验（旧版保存的账号可能没有 userId）
  const session = new JimengTabSession();
  try {
    await session.ensure();
    const resp = await session.fetch(API_PATH.userInfo, {}, 'POST');
    if (isAuthFailure(resp)) return false;
    const user = extractUserObj(resp?.data);
    const actualId = user?.userId;
    if (!actualId) return false;
    if (String(actualId) !== String(expectedAccount.userId)) {
      console.warn(`[即梦切换器] session userId 不匹配: 期望 ${expectedAccount.userId}, 实际 ${actualId}`);
      return false;
    }
    return true;
  } catch (e) {
    console.warn('[即梦切换器] 深层 verifySession 失败:', e);
    return false;
  } finally {
    await session.cleanup();
  }
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
  // fetch 完全失败（断网/跨域/tab 关闭等）：status=0 且带 error
  // 这种情况不是确定的未登录，但也不能当作成功，返回 true 让上游按失效处理
  if (resp.status === 0 || !resp.ok) {
    if (resp.error) return true;
    if (resp.status === 401 || resp.status === 403) return true;
    // 其他非 ok 状态（5xx 等）：保守当作失效
    if (resp.status >= 500) return true;
  }
  if (resp.status === 401 || resp.status === 403) return true;
  const d = resp.data;
  if (!d) return !resp.ok; // 无 data 且不 ok → 失效
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

  const snapshot = serializeCookies(await getAllDomainCookies());
  await persistPendingRestore(snapshot, 'armed');

  const tryRestore = async () => {
    await clearDomainCookies();
    await new Promise(r => setTimeout(r, 100));
    const rr = await restoreCookies(target.cookies);
    await new Promise(r => setTimeout(r, COOKIE_APPLY_DELAY_MS));
    return rr;
  };

  // 回滚：尝试恢复 snapshot，消费返回值决定是否保留 pending
  const rollback = async (reason) => {
    console.warn(`[即梦切换器] switchAccount 回滚: ${reason}`);
    try {
      await clearDomainCookies();
      if (snapshot.length > 0) {
        const restoreRes = await restoreCookies(snapshot);
        if (!restoreRes.success) {
          // 回滚也失败：保留 pending（让下次启动再试），不清除
          console.error('[即梦切换器] 回滚部分失败，保留 pending');
          return { rolledBack: 'partial', restoreFailures: restoreRes.failures };
        }
      }
    } catch (e) {
      console.error('[即梦切换器] 回滚异常:', e);
      return { rolledBack: 'error' };
    }
    // 回滚成功，清 pending
    await clearPendingRestore();
    return { rolledBack: 'full' };
  };

  try {
    await markPendingStage('business');
    let r = await tryRestore();

    // 第一次失败 → 重试一次
    if (r.authFailed || !(await verifySession(target))) {
      console.warn('[即梦切换器] 首次切换失败，重试一次');
      r = await tryRestore();
    }

    // 两次都失败 → 回滚
    if (r.authFailed || !(await verifySession(target))) {
      const rb = await rollback('两次尝试后 session 仍无效');
      return {
        success: false,
        error: rb.rolledBack === 'full'
          ? 'Cookie 恢复失败，已回滚到原账号。请重新保存该账号的 cookie。'
          : 'Cookie 恢复失败，回滚也未完全成功，请手动重新登录即梦。',
        rolledBack: rb.rolledBack,
      };
    }

    // reload tabs（多窗口处理见 reloadJimengTabsForSwitch）
    await reloadJimengTabsForSwitch(target.name);

    // 提交：先标 committing 再清除 pending。
    // 即使崩在 markPendingStage 和 clearPendingRestore 之间，下次启动也不会误回滚。
    await markPendingStage('committing');
    await clearPendingRestore();
    return { success: true, account: target };
  } catch (e) {
    console.error('[即梦切换器] switchAccount 异常:', e);
    const rb = await rollback(`异常: ${e.message}`);
    return { success: false, error: `切换失败: ${e.message}`, rolledBack: rb.rolledBack };
  }
}

// 多窗口安全的 reload：每个窗口只 reload 该窗口的 active tab，其他 tab 注入非阻塞 toast
async function reloadJimengTabsForSwitch(accountName) {
  const tabs = await chrome.tabs.query({ url: '*://*.jianying.com/*' });
  if (tabs.length === 0) {
    try { await chrome.tabs.create({ url: JIMENG_HOME }); } catch {}
    return;
  }
  // 按 windowId 分组，每个 window 内找 active tab
  const activeByWindow = new Map();
  for (const tab of tabs) {
    if (tab.active && !activeByWindow.has(tab.windowId)) {
      activeByWindow.set(tab.windowId, tab.id);
    }
  }
  for (const tab of tabs) {
    if (activeByWindow.get(tab.windowId) === tab.id) {
      try {
        await clearJimengLocalStorage(tab.id);
        await chrome.tabs.reload(tab.id, { bypassCache: true });
      } catch {}
    } else {
      await notifyTabAccountSwitched(tab.id, accountName);
    }
  }
}

// 非阻塞提示：向目标 tab 注入一条 Shadow DOM 隔离的浮动 toast
// 用 Shadow DOM 隔离避免被页面全局 CSS（特别是 reset.css 或 !important 规则）污染
async function notifyTabAccountSwitched(tabId, newAccountName) {
  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      args: [newAccountName],
      func: (name) => {
        const HOST_ID = '__jimeng_switcher_toast_host__';
        document.getElementById(HOST_ID)?.remove();
        const host = document.createElement('div');
        host.id = HOST_ID;
        host.style.cssText = 'all:initial;position:fixed;top:0;right:0;z-index:2147483647';
        const shadow = host.attachShadow({ mode: 'closed' });
        const style = document.createElement('style');
        style.textContent = `
          .toast {
            position: fixed; top: 16px; right: 16px;
            background: #4361ee; color: #fff;
            padding: 10px 14px; border-radius: 8px;
            font: 13px -apple-system, "Microsoft YaHei", "PingFang SC", sans-serif;
            box-shadow: 0 4px 12px rgba(0,0,0,0.2);
            cursor: pointer; max-width: 280px; line-height: 1.4;
          }
        `;
        const div = document.createElement('div');
        div.className = 'toast';
        div.textContent = `账号已切换为「${name}」，刷新页面后生效`;
        div.onclick = () => location.reload();
        shadow.appendChild(style);
        shadow.appendChild(div);
        document.documentElement.appendChild(host);
        setTimeout(() => host.remove(), 8000);
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

// 严格 domain 匹配（防正则绕过 "eviljianying.com"）
function isAllowedCookieDomain(d) {
  if (typeof d !== 'string' || !d) return false;
  // 去掉 leading dot（Chrome cookies 的 domain 可能带或不带）
  const bare = d.startsWith('.') ? d.slice(1) : d;
  return bare === 'jianying.com' || bare.endsWith('.jianying.com');
}

// 校验单个 cookie 对象：只接受 jianying.com 域、字段类型合法、未过期
function sanitizeCookie(c) {
  if (!c || typeof c !== 'object') return null;
  if (typeof c.name !== 'string' || !c.name) return null;
  if (typeof c.value !== 'string') return null;
  if (!isAllowedCookieDomain(c.domain)) return null;
  if (typeof c.path !== 'string' || !c.path.startsWith('/')) return null;

  // 过期过滤：expirationDate 是秒级 Unix 时间戳，小于 now 就是过期 cookie
  if (typeof c.expirationDate === 'number' && c.expirationDate > 0) {
    const nowSec = Date.now() / 1000;
    if (c.expirationDate < nowSec) return null;
  }

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
    // 导入的 userId 标记为 unverified：不作为身份校验依据，只作为备注
    // 首次通过 checkStatus 成功后，由 mergeAccountStatus 用 API 真实 userId 回填到 userId 字段
    userId: '',
    importedUserId: typeof a.userId === 'string' ? a.userId : '',
    nickname: typeof a.nickname === 'string' ? a.nickname.slice(0, 100) : '',
    avatar: sanitizeAvatar(a.avatar),
    cookies,
    savedAt: typeof a.savedAt === 'number' ? a.savedAt : Date.now(),
    cachedCredits: (a.cachedCredits && typeof a.cachedCredits === 'object') ? a.cachedCredits : null,
    cachedVip: (a.cachedVip && typeof a.cachedVip === 'object') ? a.cachedVip : null,
    // sessionValid 必须由 check 重新验证，不信任导入值（可能伪造）
    sessionValid: null,
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
  // 两级去重索引：userId 优先，fallback sessionid（对齐 saveCurrentAccount 的策略）
  const byUid = new Map();
  const bySid = new Map();
  for (const a of current) {
    if (a.userId) byUid.set(a.userId, a);
    const sid = getSid(a);
    if (sid) bySid.set(sid, a);
  }
  let added = 0, updated = 0;
  for (const a of sanitized) {
    let match = null;
    // R4-J: 导入的 userId 不可信任，但如果匹配到现有账号（现有 userId 是之前 API 验证过的），可以安全 merge
    if (a.userId && byUid.has(a.userId)) match = byUid.get(a.userId);
    if (!match) {
      const sid = getSid(a);
      if (sid && bySid.has(sid)) match = bySid.get(sid);
    }
    if (match) {
      // 同账号（按 userId 或 sessionid）→ 合并（保留原 id）
      Object.assign(match, a, { id: match.id });
      updated++;
    } else {
      current.push(a);
      if (a.userId) byUid.set(a.userId, a);
      const sid = getSid(a);
      if (sid) bySid.set(sid, a);
      added++;
    }
  }
  await saveAccountsToStorage(current);
  return { success: true, added, updated };
}

// ======================== 状态查询 ========================

// 公共 primitive：切到目标账号 cookie → 等生效 → reload tab → 执行 fn → 不恢复（由调用方统一恢复）
// 如果 restoreCookies 失败（尤其是 auth cookie 失败），抛错让调用方捕获，不继续执行 fn
class RestoreFailureError extends Error {
  constructor(failures) {
    super(`restoreCookies 失败: ${failures.map(f => f.name).join(', ')}`);
    this.name = 'RestoreFailureError';
    this.failures = failures;
  }
}

async function withAccountCookies(account, session, fn) {
  await clearDomainCookies();
  const rr = await restoreCookies(account.cookies);
  if (!rr.success) {
    throw new RestoreFailureError(rr.failures);
  }
  await new Promise(r => setTimeout(r, COOKIE_APPLY_DELAY_MS));
  if (session) await session.reload();
  return fn();
}

// 身份断言：status 返回的 userId 必须匹配目标账号（cookie 串号保护）
// 如果账号本身没有 userId（旧版保存的）→ 跳过断言，相当于无保护但不破坏旧数据
function assertUserIdMatch(targetAccount, status) {
  if (!targetAccount.userId) return true; // 无 userId 的旧账号跳过
  if (!status?.user?.userId) return !status?.valid; // API 没拿到 user 但 valid=false 允许（失效状态）
  return String(status.user.userId) === String(targetAccount.userId);
}

// load+merge：只把新状态 merge 到最新的 accounts（而不是覆盖整份），
// 避免用户在批量查询期间做的删除/重命名/导入被覆盖。
// 必须在 storageLock 下执行（解决 load/save 之间 TOCTOU）。
async function mergeAccountStatus(accountId, status) {
  return withStorageLock(async () => {
    const accounts = await loadAccounts();
    const target = accounts.find(a => a.id === accountId);
    if (!target) return; // 用户中途删除了，不回写
    // 身份断言：状态里的 userId 必须匹配目标账号，避免 cookie 串号把 A 的状态写到 B
    if (!assertUserIdMatch(target, status)) {
      console.warn(`[即梦切换器] userId 不匹配，拒绝 merge 状态到账号 ${target.name}（${target.userId} vs ${status?.user?.userId}）`);
      // 仍然把 sessionValid 标记为 false（这个账号的状态查询失败）
      target.sessionValid = false;
      target.lastChecked = Date.now();
      await saveAccountsToStorage(accounts);
      return;
    }
    target.cachedCredits = status.credits;
    target.cachedVip = status.vip;
    target.sessionValid = status.valid;
    target.lastChecked = Date.now();
    // 如果该账号还没有 userId（旧版保存），且本次拿到了真实 userId，就回填
    if (!target.userId && status.user?.userId) {
      target.userId = String(status.user.userId);
    }
    await saveAccountsToStorage(accounts);
  });
}

// 批量 merge：一次 load + 一次 save，避免 checkAllStatuses 里 N 次 load+save 的 O(N) IO 开销。
// 同样加 userId 身份断言。
// statusById: Map<accountId, {valid, credits, vip, user}>
async function mergeMultipleAccountStatuses(statusById) {
  return withStorageLock(async () => {
    const accounts = await loadAccounts();
    const now = Date.now();
    let changed = false;
    for (const acc of accounts) {
      if (!statusById.has(acc.id)) continue;
      const status = statusById.get(acc.id);
      if (!assertUserIdMatch(acc, status)) {
        console.warn(`[即梦切换器] 批量 merge: ${acc.name} userId 不匹配，跳过状态写入`);
        acc.sessionValid = false;
        acc.lastChecked = now;
        changed = true;
        continue;
      }
      acc.cachedCredits = status.credits;
      acc.cachedVip = status.vip;
      acc.sessionValid = status.valid;
      acc.lastChecked = now;
      if (!acc.userId && status.user?.userId) {
        acc.userId = String(status.user.userId);
      }
      changed = true;
    }
    if (changed) await saveAccountsToStorage(accounts);
  });
}

async function checkAccountStatus(accountId) {
  const accountsSnapshot = await loadAccounts();
  const target = accountsSnapshot.find(a => a.id === accountId);
  if (!target) return { success: false, error: '账号不存在' };

  const originalCookies = serializeCookies(await getAllDomainCookies());
  await persistPendingRestore(originalCookies, 'armed');
  const session = new JimengTabSession();
  let status = { valid: false, credits: null, vip: null, user: null };
  let restoreFailed = false;

  try {
    await markPendingStage('business');
    await session.ensure();
    status = await withAccountCookies(target, session, () => fetchStatusViaSession(session));
    await mergeAccountStatus(accountId, status);
  } finally {
    await session.cleanup();
    await clearDomainCookies();
    if (originalCookies.length > 0) {
      const rr = await restoreCookies(originalCookies);
      if (!rr.success) restoreFailed = true;
    }
    if (restoreFailed) {
      // 恢复失败：保留 pending 让下次再试，不 committing
      console.error('[即梦切换器] checkAccountStatus 恢复原 cookie 失败，保留 pending');
    } else {
      await markPendingStage('committing');
      await clearPendingRestore();
    }
  }
  return { success: true, status, accountId, restoreFailed };
}

async function checkAllStatuses() {
  const accountsSnapshot = await loadAccounts();
  if (!accountsSnapshot.length) return { success: false, error: '没有保存的账号' };

  const originalCookies = serializeCookies(await getAllDomainCookies());
  await persistPendingRestore(originalCookies, 'armed');
  const session = new JimengTabSession();
  const results = [];
  const statusById = new Map(); // 内存收集，循环结束一次性写回，避免 O(N) storage I/O
  const total = accountsSnapshot.length;
  let restoreFailed = false;

  try {
    await markPendingStage('business');
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

      statusById.set(acc.id, status);
      results.push({ accountId: acc.id, name: acc.name, ...status });
    }

    // 一次性批量 merge：只做 1 次 load + 1 次 save，而不是 N 次
    if (statusById.size > 0) {
      await mergeMultipleAccountStatuses(statusById);
    }
  } finally {
    await broadcastProgress({ phase: 'restore', current: total, total, message: '恢复登录状态...' });
    await session.cleanup();
    await clearDomainCookies();
    if (originalCookies.length > 0) {
      const rr = await restoreCookies(originalCookies);
      if (!rr.success) restoreFailed = true;
    }
    if (restoreFailed) {
      console.error('[即梦切换器] checkAllStatuses 恢复原 cookie 失败，保留 pending');
    } else {
      await markPendingStage('committing');
      await clearPendingRestore();
    }
    await broadcastProgress({ phase: 'done', current: total, total });
  }

  return { success: true, results, restoreFailed };
}

// ======================== 消息路由 ========================

// 需要在执行业务前等待 pending restore 完成的敏感操作
const SENSITIVE_ACTIONS = new Set([
  'saveCurrentAccount', 'switchAccount',
  'checkStatus', 'checkAllStatuses',
  'deleteAccount', 'renameAccount', 'importAccounts',
]);

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  const handler = async () => {
    // 敏感操作前必须 await 恢复完成，避免新业务在脏 cookie 状态上开始
    // 非敏感操作（getAccounts/getSettings/detectCurrent）也调但不阻塞太久（节流 30s）
    if (SENSITIVE_ACTIONS.has(msg.action)) {
      await maybeRecoverOnWakeup();
    } else {
      maybeRecoverOnWakeup(); // fire-and-forget，不阻塞读操作
    }
    try {
      switch (msg.action) {
        case 'getAccounts':    return await loadAccounts();
        case 'getSettings':    return await loadSettings();
        case 'saveSettings':   await saveSettings(msg.patch || {}); return { success: true };
        case 'detectCurrent':  return await detectCurrentAccount();
        case 'saveCurrentAccount':
          return await withCookieLock(() => withStorageLock(() => saveCurrentAccount(msg.name)));
        case 'switchAccount':
          return await withCookieLock(() => switchAccount(msg.accountId));
        case 'deleteAccount':
          return await withStorageLock(() => deleteAccount(msg.accountId));
        case 'renameAccount':
          return await withStorageLock(() => renameAccount(msg.accountId, msg.name));
        case 'importAccounts':
          return await withStorageLock(() => importAccounts(msg.accounts, msg.mode || 'merge'));
        case 'checkStatus':
          return await withCookieLock(() => checkAccountStatus(msg.accountId));
        case 'checkAllStatuses':
          return await withCookieLock(() => checkAllStatuses());
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
