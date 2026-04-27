// ================================================================
// 即梦账号切换器 - Background Service Worker V3
// 精简版：快速切换账号 + 积分/VIP 状态展示
// 不做积分领取（即梦免费积分登录即领，次日过期，无需囤积）
// ================================================================


// Firefox 使用 browser.* Promise API；Chromium 使用 chrome.* Promise API。
// 统一入口后，核心逻辑可以在两类 WebExtension 运行时复用。
const extensionApi = globalThis.browser || globalThis.chrome;
if (!extensionApi) throw new Error('WebExtension API unavailable');
// ======================== 常量 ========================
const JIMENG_DOMAIN = '.jianying.com';
const JIMENG_URL = 'https://jimeng.jianying.com';
const JIMENG_HOME = `${JIMENG_URL}/ai-tool/home`;
const STORAGE_KEY = 'jimeng_accounts';
const STORAGE_BACKUP_KEY = 'jimeng_accounts_backup';
const STORAGE_JOURNAL_KEY = 'jimeng_accounts_journal';
const MAX_ACCOUNTS_JOURNAL = 12;
const DIAGNOSTIC_LOG_KEY = 'jimeng_diagnostic_logs';
const MAX_DIAGNOSTIC_LOGS = 200;
const SETTINGS_KEY = 'jimeng_settings';
const DEFAULT_SETTINGS = {
  saveDraftName: '',
  repairAccountId: null,
  autoSaveOnLogin: true,
};
const SERVICE_WORKER_STARTED_AT = Date.now();

const API_PATH = {
  userInfo: '/passport/account/info/v2?account_sdk_source=web',
  userCredit: '/commerce/v1/benefits/user_credit',
  creditHistory: '/commerce/v1/benefits/user_credit_history',
  subscription: '/commerce/v1/subscription/user_info',
};

// Chromium 扩展环境下，extensionApi.cookies.getAll(...) 对部分即梦登录 cookie
// （尤其是若干非 secure / HttpOnly 组合）返回并不完整。
// 实测 sessionid / sid_tt / sid_guard / uid_tt 等能通过 cookies.get(url,name)
// 单独读取，但不会稳定出现在 getAll(domain) 结果里。
// 因此这里显式补拉一组关键 cookie，和 getAll 结果合并去重。
const SUPPLEMENTAL_COOKIE_NAMES = [
  'sessionid', 'sessionid_ss',
  'sid_tt', 'sid_guard',
  'uid_tt', 'uid_tt_ss',
  'passport_csrf_token', 'passport_csrf_token_default', 'passport_csrf_token_wap_state',
  'session_tlb_tag', 'n_mh', 'odin_tt',
  'is_staff_user', 'has_biz_token',
  '_tea_web_id', 's_v_web_id', 'fpk1',
  'user_spaces_idc', '_uetsid', '_uetvid',
];
const AUTH_COOKIE_NAMES = new Set(['sessionid', 'sessionid_ss', 'sid_tt', 'sid_guard', 'uid_tt', 'uid_tt_ss']);
const DEVICE_COOKIE_NAMES = ['s_v_web_id', 'passport_csrf_token', 'fpk1', '_tea_web_id'];
const LOGIN_ISOLATION_REASON = 'prepare-isolated-login';

const COOKIE_APPLY_DELAY_MS = 600;
const TAB_INIT_GRACE_MS = 1500;
const TAB_LOAD_TIMEOUT_MS = 20000;
const JIMENG_TAB_URL_PATTERNS = ['https://*.jianying.com/*'];

// ======================== 进度广播 ========================
async function broadcastProgress(payload) {
  try {
    await extensionApi.runtime.sendMessage({ __progress: true, ...payload });
  } catch {}
}

// ======================== 安全诊断日志 ========================
// 诊断只记录 cookie 名称/数量/身份决策，不记录任何 cookie/token 值。
function sanitizeDiagnosticPayload(value, depth = 0) {
  if (depth > 6) return '[max-depth]';
  if (value == null || typeof value === 'boolean' || typeof value === 'number' || typeof value === 'string') return value;
  if (Array.isArray(value)) return value.slice(0, 80).map(item => sanitizeDiagnosticPayload(item, depth + 1));
  if (typeof value === 'object') {
    const out = {};
    for (const [key, raw] of Object.entries(value)) {
      const lower = key.toLowerCase();
      if (lower === 'cookies' || lower === 'cookie' || lower === 'cookievalue') {
        out[key] = '[redacted-cookie-data]';
      } else if (
        lower === 'value'
        || lower.endsWith('value')
        || lower.includes('tokenvalue')
        || lower === 'sessionidvalue'
        || lower === 'sidvalue'
      ) {
        out[key] = '[redacted]';
      } else {
        out[key] = sanitizeDiagnosticPayload(raw, depth + 1);
      }
    }
    return out;
  }
  return String(value);
}

function summarizeCookiesForDiagnostics(cookies = []) {
  const list = Array.isArray(cookies) ? cookies : [];
  const names = [...new Set(list.map(c => c?.name).filter(Boolean))].sort();
  const authCookieNames = names.filter(name => AUTH_COOKIE_NAMES.has(name));
  const domainCounts = {};
  for (const cookie of list) {
    const domain = cookie?.domain || '(unknown)';
    domainCounts[domain] = (domainCounts[domain] || 0) + 1;
  }
  return {
    cookieCount: list.length,
    hasSessionid: names.includes('sessionid'),
    authCookieNames,
    cookieNames: names,
    domainCounts,
  };
}

function summarizeStatusForDiagnostics(status = {}) {
  return {
    valid: !!status?.valid,
    unknown: !!status?.unknown,
    creditsUnknown: !!status?.creditsUnknown,
    vipUnknown: !!status?.vipUnknown,
    user: status?.user ? {
      userId: status.user.userId || '',
      nickname: status.user.nickname || '',
      hasAvatar: !!status.user.avatar,
    } : null,
    credits: status?.credits ? {
      total: status.credits.total ?? null,
      detailTotal: status.credits.detailTotal ?? null,
      source: status.credits.source || '',
      nextDailyFreeAt: status.credits.nextDailyFreeAt || 0,
      nextSubscriptionCreditAt: status.credits.nextSubscriptionCreditAt || 0,
    } : null,
    vip: status?.vip ? {
      isVip: !!status.vip.isVip,
      vipType: status.vip.vipType || status.vip.planName || '',
      expireTime: status.vip.expireTime || 0,
      source: status.vip.source || '',
    } : null,
  };
}

function summarizeAccountsForDiagnostics(accounts = []) {
  return (Array.isArray(accounts) ? accounts : []).map((account, index) => ({
    index,
    id: account?.id || '',
    name: account?.name || '',
    userId: account?.userId || '',
    nickname: account?.nickname || '',
    sessionValid: account?.sessionValid ?? null,
    cookieCount: Array.isArray(account?.cookies) ? account.cookies.length : 0,
    cachedCredits: account?.cachedCredits ? {
      total: account.cachedCredits.total ?? null,
      detailTotal: account.cachedCredits.detailTotal ?? null,
      source: account.cachedCredits.source || '',
    } : null,
    cachedVip: account?.cachedVip ? {
      isVip: !!account.cachedVip.isVip,
      vipType: account.cachedVip.vipType || account.cachedVip.planName || '',
      expireTime: account.cachedVip.expireTime || 0,
      source: account.cachedVip.source || '',
    } : null,
  }));
}

async function writeDiagnosticLog(event, payload = {}) {
  try {
    const entry = {
      ts: Date.now(),
      iso: new Date().toISOString(),
      event,
      payload: sanitizeDiagnosticPayload(payload),
      version: extensionApi.runtime.getManifest?.().version || '',
    };
    const current = (await extensionApi.storage.local.get(DIAGNOSTIC_LOG_KEY))[DIAGNOSTIC_LOG_KEY];
    const next = [...(Array.isArray(current) ? current : []), entry].slice(-MAX_DIAGNOSTIC_LOGS);
    await extensionApi.storage.local.set({ [DIAGNOSTIC_LOG_KEY]: next });
    console.log('[即梦切换器诊断]', event, entry.payload);
  } catch (e) {
    console.warn('[即梦切换器] 写入诊断日志失败:', e);
  }
}

async function getDiagnosticLogs() {
  return (await extensionApi.storage.local.get(DIAGNOSTIC_LOG_KEY))[DIAGNOSTIC_LOG_KEY] || [];
}

async function clearDiagnosticLogs() {
  await extensionApi.storage.local.set({ [DIAGNOSTIC_LOG_KEY]: [] });
  return { success: true };
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
const PENDING_RESTORE_STALE_MS = 5 * 60 * 1000;

function isStalePendingRestore(pending, maxAgeMs = PENDING_RESTORE_STALE_MS) {
  if (!pending?.cookies?.length) return false;
  const ts = Number(pending.ts || 0);
  return !ts || (Date.now() - ts > maxAgeMs);
}

class PendingConflictError extends Error {
  constructor(existingStage) {
    super(`上次恢复未完成 (stage=${existingStage})，拒绝覆盖现有快照以保护数据`);
    this.name = 'PendingConflictError';
    this.existingStage = existingStage;
  }
}

async function persistPendingRestore(snapshot, stage = 'armed') {
  // 冲突检测：如果已有 pending 且非 committing 阶段 → **拒绝覆盖**
  // 原因：当前 cookie 可能是残缺/污染状态，覆盖快照会把唯一正常账号备份丢掉。
  // 让调用方先显式处理（例如等下次 SW 启动或让用户介入）。
  const existing = (await extensionApi.storage.local.get(PENDING_RESTORE_KEY))[PENDING_RESTORE_KEY];
  if (existing?.cookies?.length && existing.stage !== 'committing') {
    if (isStalePendingRestore(existing)) {
      console.warn('[即梦切换器] 清理超时 pending restore，允许新操作继续');
      await clearPendingRestore();
    } else {
      throw new PendingConflictError(existing.stage);
    }
  }
  try {
    await extensionApi.storage.local.set({
      [PENDING_RESTORE_KEY]: {
        cookies: snapshot,
        stage,
        ts: Date.now(),
        attempts: 0,
      },
    });
  } catch (e) {
    console.warn('[即梦切换器] 持久化 pending restore 失败:', e);
    throw e;
  }
}

async function markPendingStage(stage) {
  try {
    const r = await extensionApi.storage.local.get(PENDING_RESTORE_KEY);
    const pending = r[PENDING_RESTORE_KEY];
    if (!pending) return;
    pending.stage = stage;
    pending.ts = Date.now();
    await extensionApi.storage.local.set({ [PENDING_RESTORE_KEY]: pending });
  } catch {}
}

async function clearPendingRestore() {
  try { await extensionApi.storage.local.remove(PENDING_RESTORE_KEY); } catch {}
}

function hasCriticalRestoreFailure(result) {
  return !result || result.authFailed === true;
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
        const r = await extensionApi.storage.local.get(PENDING_RESTORE_KEY);
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

        // 超时 pending 不再恢复旧 cookie，直接清理。
        // 真实用户反馈里出现过旧 pending 长时间残留，下一次保存/切换若恢复旧快照会把当前登录态反向覆盖。
        if (isStalePendingRestore(pending)) {
          console.warn('[即梦切换器] pending restore 已超时，清理而不恢复旧 cookie');
          await clearPendingRestore();
          return;
        }

        console.warn(`[即梦切换器] 检测到上次异常终止（stage=${pending.stage}），尝试第 ${attempts} 次恢复...`);
        // 先更新 attempts 计数，即使恢复失败也不丢信息
        pending.attempts = attempts;
        await extensionApi.storage.local.set({ [PENDING_RESTORE_KEY]: pending });

        await clearDomainCookies();
        const res = await restoreCookies(pending.cookies);
        if (hasCriticalRestoreFailure(res)) {
          // 关键登录 cookie 恢复失败：保留 pending，下次再试
          console.error(`[即梦切换器] 关键登录 cookie 恢复失败，保留 pending`);
          return;
        }
        if (!res.success) {
          console.warn('[即梦切换器] 部分非关键 cookie 恢复失败，已忽略并清理 pending:', res.failures);
        }
        // 关键登录 cookie 已恢复，清除
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

extensionApi.runtime.onStartup.addListener(() => { tryRecoverPendingRestore(); });
extensionApi.runtime.onInstalled.addListener(() => { tryRecoverPendingRestore(); });
extensionApi.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.status !== 'complete') return;
  if (!tab?.url || !isJimengHost(tab.url)) return;
  scheduleAutoLoginIsolation(tabId, 'tab-updated');
  scheduleAutoSaveCurrentAccount('tab-updated');
});

extensionApi.cookies.onChanged.addListener((info) => {
  const cookie = info?.cookie;
  if (info?.removed) return;
  if (!cookie || !isJimengHost(cookie.domain) || !isAuthCookieName(cookie.name)) return;
  scheduleAutoSaveCurrentAccount(`cookie:${cookie.name}`, 1500);
});


// 每次敏感操作入口（经由消息路由）也懒触发一次检查，
// 应对 MV3 SW 空闲挂起后被消息唤醒的场景（onStartup/onInstalled 都不会触发）。
let lastRecoveryCheckTs = 0;
async function maybeRecoverOnWakeup() {
  try {
    // 先查 pending 是否存在（便宜操作）：
    // 如果 pending 有且非 committing，**无视节流**立即尝试恢复
    // （场景：前一次恢复失败后，pending 残留，新业务必须等恢复完成再进行）
    const r = await extensionApi.storage.local.get(PENDING_RESTORE_KEY);
    const pending = r[PENDING_RESTORE_KEY];
    const hasActivePending = pending?.cookies?.length && pending.stage !== 'committing';

    if (hasActivePending) {
      // 有残留 pending，必须恢复
      lastRecoveryCheckTs = Date.now();
      await tryRecoverPendingRestore();
      return;
    }

    // 无残留 → 节流：同一次 SW 生命周期内每 30 秒最多检查一次
    if (Date.now() - lastRecoveryCheckTs < 30000) return;
    lastRecoveryCheckTs = Date.now();
    // 这里其实已经没有 pending 了，不用再调 tryRecoverPendingRestore
  } catch {}
}

// ======================== Cookie 操作 ========================

async function getAllDomainCookies() {
  const [a, b, supplemental] = await Promise.all([
    extensionApi.cookies.getAll({ domain: JIMENG_DOMAIN }),
    extensionApi.cookies.getAll({ domain: 'jimeng.jianying.com' }),
    Promise.all(SUPPLEMENTAL_COOKIE_NAMES.map(name =>
      extensionApi.cookies.get({ url: 'https://jimeng.jianying.com/', name }).catch(() => null)
    )),
  ]);
  const seen = new Set();
  const all = [];
  for (const c of [...a, ...b, ...supplemental.filter(Boolean)]) {
    const key = `${c.name}|${c.domain}|${c.path}`;
    if (!seen.has(key)) { seen.add(key); all.push(c); }
  }
  return all;
}

async function clearDomainCookies() {
  const cookies = await getAllDomainCookies();
  await Promise.all(cookies.map(cookie => {
    const domain = cookie.domain.startsWith('.') ? cookie.domain.slice(1) : cookie.domain;
    return extensionApi.cookies.remove({ url: `https://${domain}${cookie.path}`, name: cookie.name });
  }));
  const remaining = await getAllDomainCookies();
  if (remaining.length > 0) {
    for (const c of remaining) {
      const d = c.domain.startsWith('.') ? c.domain.slice(1) : c.domain;
      try { await extensionApi.cookies.remove({ url: `http://${d}${c.path}`, name: c.name }); } catch {}
      try { await extensionApi.cookies.remove({ url: `https://${d}${c.path}`, name: c.name }); } catch {}
    }
  }
}

function buildCookieStabilitySignature(cookies) {
  return (cookies || [])
    .filter(c => AUTH_COOKIE_NAMES.has(c.name) || SUPPLEMENTAL_COOKIE_NAMES.includes(c.name))
    .map(c => `${c.name}|${c.domain}|${c.path}|${c.value}`)
    .sort()
    .join('\n');
}

async function getStableDomainCookies({ attempts = 3, delayMs = 700 } = {}) {
  let previous = null;
  let previousSig = '';
  for (let i = 0; i < attempts; i += 1) {
    const current = (await getAllDomainCookies()) || [];
    const sig = buildCookieStabilitySignature(current);
    const sid = current.find(c => c.name === 'sessionid')?.value || '';
    if (sid && previous && sig === previousSig) {
      return current;
    }
    previous = current;
    previousSig = sig;
    if (i < attempts - 1) await new Promise(r => setTimeout(r, delayMs));
  }
  return previous || [];
}

async function restoreCookies(savedCookies) {
  // 关键 auth cookie 名单。先写普通 cookie 再写 auth，确保顺序正确。
  const restorableCookies = (savedCookies || []).filter(c => !isExpiredCookie(c));
  const normal = restorableCookies.filter(c => !AUTH_COOKIE_NAMES.has(c.name));
  const auth = restorableCookies.filter(c => AUTH_COOKIE_NAMES.has(c.name));
  const failures = [];

  for (const cookie of [...normal, ...auth]) {
    const domain = cookie.domain.startsWith('.') ? cookie.domain.slice(1) : cookie.domain;
    const details = {
      url: `https://${domain}${cookie.path}`,
      name: cookie.name, value: cookie.value,
      path: cookie.path, secure: cookie.secure, httpOnly: cookie.httpOnly,
    };
    // host-only cookie 不传 domain（浏览器从 url 推断为 host-only）
    // 否则 extensionApi.cookies.set 拿到 domain 会把它转为 domain cookie，作用域被放宽
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
      const result = await extensionApi.cookies.set(details);
      if (!result) {
        failures.push({ name: cookie.name, isAuth: AUTH_COOKIE_NAMES.has(cookie.name) });
        console.warn(`[即梦切换器] cookie 写入失败（不降级重试）: ${cookie.name}`);
      }
    } catch (e) {
      failures.push({ name: cookie.name, isAuth: AUTH_COOKIE_NAMES.has(cookie.name), error: e.message });
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
async function verifySession(expectedAccount = null, options = {}) {
  const sid = await extensionApi.cookies.get({ url: 'https://jimeng.jianying.com/', name: 'sessionid' });
  if (!sid?.value) return false;

  // 无目标账号 → 浅层校验够
  if (!expectedAccount || !expectedAccount.userId) return true;

  const forceInternal = options.forceInternal === true;

  // 深层校验：用 TabSession 调 userInfo，匹配 userId
  // 只有保存过 userId 的账号才能做深层校验（旧版保存的账号可能没有 userId）
  const session = new JimengTabSession({ forceInternal });
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

async function validateRestoredAccountForSwitch(expectedAccount = null) {
  const sid = await extensionApi.cookies.get({ url: 'https://jimeng.jianying.com/', name: 'sessionid' });
  if (!sid?.value) {
    return { ok: false, reason: 'missing-sessionid', status: null };
  }

  // 切换成功与否必须以真实 API 身份为准，而不是只看 cookie 是否存在。
  //
  // 关键产品修正：切换流程不能再复用“用户正在看的即梦页面”做验证。
  // 旧实现会先 reload 可见页，再在页面上下文读取会员/积分详情；真实 Chrome 下页面 app 会在
  // cookie 清空→恢复的瞬间自己弹“你已退出登录”，表现为切换成功后后台还在转、几秒后又登出。
  //
  // 现在切换验证只在扩展后台直接请求 userInfo：验证目标 cookie 的真实 userId。
  // 成功后再统一刷新即梦页一次，让用户页面从稳定的目标 cookie 启动。
  try {
    const status = await fetchStatusViaDirectWithRetry();
    if (status?.unknown) return { ok: false, reason: 'identity-unknown', status };
    if (!status?.valid || !status?.user?.userId) return { ok: false, reason: 'invalid-session', status };

    const actualUserId = String(status.user.userId);
    const expectedUserId = expectedAccount?.userId ? String(expectedAccount.userId) : '';
    if (expectedUserId && expectedUserId !== actualUserId) {
      console.warn(`[即梦切换器] 保存账号元数据与 cookie 身份不一致，拒绝切换: 期望 ${expectedUserId}, 实际 ${actualUserId}`);
      return {
        ok: false,
        reason: 'identity-mismatch',
        status,
        actualUserId,
        expectedUserId,
        repaired: false,
        reloadedTabIds: [],
      };
    }

    return {
      ok: true,
      reason: expectedUserId ? 'matched' : 'verified-without-saved-userid',
      status,
      actualUserId,
      repaired: !expectedUserId,
      reloadedTabIds: [],
    };
  } catch (e) {
    console.warn('[即梦切换器] switchAccount 身份校验失败:', e);
    return { ok: false, reason: `exception:${e.message}`, status: null, reloadedTabIds: [] };
  }
}

function serializeCookies(cookies) {
  return (cookies || []).filter(c => !isExpiredCookie(c)).map(c => ({
    name: c.name, value: c.value, domain: c.domain, path: c.path,
    secure: c.secure, httpOnly: c.httpOnly, sameSite: c.sameSite,
    expirationDate: c.expirationDate, hostOnly: c.hostOnly,
  }));
}

function isExpiredCookie(cookie, nowSec = Math.floor(Date.now() / 1000)) {
  const expirationDate = Number(cookie?.expirationDate || 0);
  return !!expirationDate && expirationDate <= nowSec;
}

// ======================== JimengTabSession ========================
class JimengTabSession {
  constructor(options = {}) {
    this.tabId = null;
    this.isInternal = false;
    this.forceInternal = !!options.forceInternal;
    this.allowCreate = options.allowCreate !== false;
  }

  async ensure() {
    if (this.tabId !== null) {
      try { await extensionApi.tabs.get(this.tabId); return; } catch { this.tabId = null; }
    }
    if (!this.forceInternal) {
      const reusable = await findReusableJimengTab();
      if (reusable?.id != null) {
        this.tabId = reusable.id;
        this.isInternal = false;
        if (reusable.status !== 'complete') {
          await this.waitForComplete();
        } else {
          await new Promise(r => setTimeout(r, TAB_INIT_GRACE_MS));
        }
        return;
      }
    }
    if (!this.allowCreate) {
      throw new Error('没有可复用的即梦标签页');
    }
    const tab = await extensionApi.tabs.create({ url: JIMENG_HOME, active: false });
    this.tabId = tab.id;
    this.isInternal = true;
    await this.waitForComplete();
  }

  async waitForComplete(timeoutMs = TAB_LOAD_TIMEOUT_MS) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      try {
        const tab = await extensionApi.tabs.get(this.tabId);
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
    await extensionApi.tabs.reload(this.tabId, { bypassCache: true });
    await new Promise(r => setTimeout(r, 300));
    await this.waitForComplete();
  }

  async fetch(path, body = {}, method = 'POST') {
    if (this.tabId === null) throw new Error('Tab 未初始化');
    const results = await extensionApi.scripting.executeScript({
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
      try { await extensionApi.tabs.remove(this.tabId); } catch {}
    }
    this.tabId = null;
    this.isInternal = false;
  }
}

async function fetchJimengApiDirect(path, body = {}, method = 'POST') {
  try {
    const init = {
      method,
      credentials: 'include',
      cache: 'no-store',
      headers: { 'Content-Type': 'application/json', 'Accept': 'application/json, text/plain, */*' },
    };
    if (method === 'POST') init.body = JSON.stringify(body || {});
    const resp = await fetch(`${JIMENG_URL}${path}`, init);
    const text = await resp.text();
    let data = null;
    try { data = JSON.parse(text); } catch {}
    return { ok: resp.ok, status: resp.status, data };
  } catch (e) {
    return { ok: false, status: 0, error: String(e?.message || e) };
  }
}

async function findReusableJimengTab() {
  const tabs = await extensionApi.tabs.query({ url: JIMENG_TAB_URL_PATTERNS });
  if (!tabs.length) return null;

  return tabs.find(tab => tab.active && tab.status === 'complete')
    || tabs.find(tab => tab.status === 'complete')
    || tabs.find(tab => tab.active)
    || tabs[0]
    || null;
}

// ======================== 数据提取 ========================

function vipLevelToDisplayName(level = '') {
  const normalized = String(level || '').toLowerCase();
  if (/maestro|max|advanced|premium|高级/.test(normalized)) return '高级会员';
  if (/standard|pro|标准/.test(normalized)) return '标准会员';
  if (/basic|基础/.test(normalized)) return '基础会员';
  return level || '';
}

function monthlyQuotaForVipLevel(level = '') {
  const name = vipLevelToDisplayName(level);
  if (name === '高级会员') return 15000;
  if (name === '标准会员') return 4000;
  if (name === '基础会员') return 1080;
  return null;
}

function formatBillingCycle(v = {}) {
  const cycle = Number(v.subscribe_cycle || v.cycle || 0);
  const unit = String(v.cycle_unit || '').toUpperCase();
  const type = String(v.subscribe_type || v.subscription_type || '').toLowerCase();
  if (cycle >= 12 && unit === 'MONTH') return type === 'auto' ? '连续包年' : '包年';
  if (cycle === 1 && unit === 'MONTH') return type === 'auto' ? '连续包月' : '包月';
  if (cycle && unit) return `${cycle}${unit === 'MONTH' ? '个月' : unit}`;
  return '';
}

function extractCreditsObj(resp) {
  const payload = unwrapApiPayload(resp);
  const c = payload?.credit || payload?.data?.credit || resp?.data?.data?.credit || resp?.data?.credit;
  if (!c) return null;
  const gift = c.gift_credit || 0, purchase = c.purchase_credit || 0, vip = c.vip_credit || 0;
  const detail = payload?.credits_detail || payload?.data?.credits_detail || resp?.data?.data?.credits_detail || {};
  const expiring = payload?.expiring_credits || payload?.data?.expiring_credits || [];
  const vipCredits = Array.isArray(detail.vip_credits) ? detail.vip_credits : [];
  const giftCredits = Array.isArray(detail.gift_credits) ? detail.gift_credits : [];
  const vipLevel = vipCredits[0]?.vip_level || '';
  const monthlyQuota = monthlyQuotaForVipLevel(vipLevel);
  return {
    gift, purchase, vip, total: gift + purchase + vip,
    detailTotal: gift + purchase + vip,
    panelTotal: gift + purchase + vip,
    monthlyQuota,
    monthlyQuotaText: monthlyQuota ? `${monthlyQuota.toLocaleString('zh-CN')}积分/月` : '',
    nextSubscriptionCreditAt: Number(vipCredits[0]?.credits_life_end || 0),
    nextDailyFreeAt: Number(giftCredits[0]?.credits_life_end || expiring[0]?.expire_time || 0),
    dailyFreeAmount: gift || null,
    source: 'commerce-api',
  };
}

function extractVipObj(resp) {
  const payload = unwrapApiPayload(resp);
  const v = payload?.data || payload || resp?.data?.data || resp?.data;
  if (!v) return null;
  const rawLevel = v.vip_type_name || v.vip_type || v.vip_level || v.cur_vip_level || v.expired_vip_level || '';
  const vipType = vipLevelToDisplayName(rawLevel);
  const expireTime = Number(v.expire_time || v.vip_expire_time || v.vip_real_end || v.end_time || 0);
  const monthlyQuota = monthlyQuotaForVipLevel(rawLevel);
  return {
    isVip: !!(v.is_vip || v.vip_type || v.flag || expireTime || rawLevel),
    vipType,
    planName: vipType,
    billingCycle: formatBillingCycle(v),
    expireTime,
    nextRenewalTime: Number(v.next_renewal_time || 0),
    monthlyQuota,
    monthlyQuotaText: monthlyQuota ? `${monthlyQuota.toLocaleString('zh-CN')}积分/月` : '',
    source: 'subscription-api',
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

function tryParseJson(value) {
  if (typeof value !== 'string' || !value.trim()) return null;
  try { return JSON.parse(value); } catch { return null; }
}

function unwrapApiPayload(resp) {
  const data = resp?.data;
  if (!data || typeof data !== 'object') return null;
  if (data.data && typeof data.data === 'object') return data.data;
  if (data.response && typeof data.response === 'object') return data.response;
  const parsedResponse = tryParseJson(data.response);
  if (parsedResponse && typeof parsedResponse === 'object') return parsedResponse;
  return data;
}

function parseCompactDisplayedNumber(text) {
  const raw = String(text || '').trim().toLowerCase();
  if (!raw) return null;

  const normalized = raw.replace(/,/g, '').replace(/\s+/g, '');
  const match = normalized.match(/(\d+(?:\.\d+)?)/);
  if (!match) return null;

  const value = Number(match[1]);
  if (!Number.isFinite(value)) return null;
  if (normalized.includes('万')) return Math.round(value * 10000);
  if (normalized.includes('千') || normalized.endsWith('k')) return Math.round(value * 1000);
  if (normalized.includes('亿')) return Math.round(value * 100000000);
  return Math.round(value);
}

function formatJimengEpochLocalText(seconds) {
  const n = Number(seconds || 0);
  if (!Number.isFinite(n) || n <= 0) return '';
  const d = new Date(n * 1000);
  const pad = (v) => String(v).padStart(2, '0');
  return `${d.getFullYear()}.${pad(d.getMonth() + 1)}.${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function parseJimengLocalDateTime(text) {
  const match = String(text || '').match(/(20\d{2})[.\/-](\d{1,2})[.\/-](\d{1,2})\s+(\d{1,2}):(\d{2})/);
  if (!match) return 0;
  const [, y, mo, d, h, mi] = match;
  const date = new Date(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi), 0, 0);
  const ts = Math.floor(date.getTime() / 1000);
  return Number.isFinite(ts) ? ts : 0;
}

function addMonthsEpoch(seconds, months = 1) {
  if (!seconds) return 0;
  const date = new Date(seconds * 1000);
  const day = date.getDate();
  date.setMonth(date.getMonth() + months);
  // JS 会把 1/31 + 1 month 滚到 3 月；这里回落到目标月最后一天，避免展示离谱日期。
  if (date.getDate() !== day) date.setDate(0);
  const ts = Math.floor(date.getTime() / 1000);
  return Number.isFinite(ts) ? ts : 0;
}

function nextLocalMidnightEpoch(nowMs = Date.now()) {
  const date = new Date(nowMs);
  date.setHours(24, 0, 0, 0);
  return Math.floor(date.getTime() / 1000);
}

function extractCreditHistoryDetails(raw) {
  const payload = raw?.data && typeof raw.data === 'object' ? raw.data : raw;
  const unwrapped = (payload?.data && typeof payload.data === 'object')
    ? payload.data
    : (payload?.response && typeof payload.response === 'object')
      ? payload.response
      : tryParseJson(payload?.response) || payload;
  const data = unwrapped?.data && typeof unwrapped.data === 'object' ? unwrapped.data : unwrapped;
  const list = data?.records || data?.credits_history_list || data?.credit_history_list || data?.history_list || data?.list || [];
  if (!Array.isArray(list) || !list.length) {
    return data?.total_credit != null ? { totalCredit: Number(data.total_credit) || 0, history: [] } : null;
  }

  const normalized = list
    .map(item => ({
      title: String(item?.title || item?.name || ''),
      amount: Number(item?.amount || 0),
      createTime: Number(item?.create_time || item?.createTime || item?.time || 0),
      tradeSource: String(item?.trade_source || item?.source || ''),
      historyType: item?.history_type,
    }))
    .filter(item => item.title || item.createTime || item.amount)
    .sort((a, b) => (b.createTime || 0) - (a.createTime || 0));

  const daily = normalized.find(item => /每日|免费/.test(item.title) && !/清零|到期/.test(item.title));
  const subscription = normalized.find(item => /订阅积分|会员积分|VIP/i.test(item.title) && !/清零|到期/.test(item.title));
  const clear = normalized.find(item => /清零|到期/.test(item.title));
  const totalCredit = Number(data?.total_credit ?? data?.totalCredit ?? 0) || 0;

  return {
    totalCredit: totalCredit || null,
    dailyFreeAmount: daily?.amount || null,
    lastDailyFreeAt: daily?.createTime || 0,
    nextDailyFreeAt: daily ? nextLocalMidnightEpoch() : 0,
    lastSubscriptionCreditAt: subscription?.createTime || 0,
    nextSubscriptionCreditAt: subscription?.createTime ? addMonthsEpoch(subscription.createTime, 1) : 0,
    lastCreditClearAt: clear?.createTime || 0,
    history: normalized.slice(0, 8),
  };
}


function firstNumber(...values) {
  for (const value of values) {
    const n = Number(value);
    if (Number.isFinite(n) && n > 0) return n;
  }
  return 0;
}

function normalizeHistoryList(value) {
  if (Array.isArray(value)) return value;
  if (value && typeof value === 'object') return Object.values(value);
  return [];
}

function parseAppServiceSnapshot(snapshot = {}) {
  if (!snapshot || typeof snapshot !== 'object' || !snapshot.available) return { credits: null, vip: null };

  const creditInfo = snapshot.creditInfo || {};
  const creditsDetail = snapshot.creditsDetail || {};
  const vipCredits = Array.isArray(creditsDetail.vipCredits) ? creditsDetail.vipCredits : [];
  const giftCredits = Array.isArray(creditsDetail.giftCredits) ? creditsDetail.giftCredits : [];
  const purchaseCredits = Array.isArray(creditsDetail.purchaseCredits) ? creditsDetail.purchaseCredits : [];
  const expiring = Array.isArray(snapshot.expiringCreditInfoList) ? snapshot.expiringCreditInfoList : [];
  const historyList = normalizeHistoryList(snapshot.creditHistoryList).map(item => ({
    title: String(item?.title || ''),
    amount: Number(item?.amount || 0),
    createTime: Number(item?.createTime || item?.create_time || 0),
    tradeSource: String(item?.tradeSource || item?.trade_source || ''),
    historyType: item?.historyType ?? item?.history_type,
    status: item?.status || '',
  })).filter(item => item.title || item.createTime || item.amount);

  const vip = Number(creditInfo.vipCredit ?? creditInfo.vip_credit ?? 0) || 0;
  const gift = Number(creditInfo.giftCredit ?? creditInfo.gift_credit ?? 0) || 0;
  const purchase = Number(creditInfo.purchaseCredit ?? creditInfo.purchase_credit ?? 0) || 0;
  const totalFromInfo = vip + gift + purchase;
  const localCredit = Number(snapshot.localCredit || 0) || 0;
  const total = localCredit || totalFromInfo || null;

  const vipLevel = snapshot.currentVipLevel || vipCredits[0]?.vipLevel || snapshot.vipInfo?.curVipLevel || snapshot.vipInfo?.cur_vip_level || '';
  const monthlyQuota = monthlyQuotaForVipLevel(vipLevel) || Number(vipCredits[0]?.residualCredits || 0) || null;
  const history = extractCreditHistoryDetails({ data: { records: historyList, total_credit: total || 0 } }) || null;
  const nextSubscriptionCreditAt = firstNumber(
    vipCredits[0]?.creditsLifeEnd,
    vipCredits[0]?.credits_life_end,
    history?.nextSubscriptionCreditAt,
  );
  const nextDailyFreeAt = firstNumber(
    giftCredits[0]?.creditsLifeEnd,
    giftCredits[0]?.credits_life_end,
    expiring[0]?.expireTime,
    expiring[0]?.expire_time,
    history?.nextDailyFreeAt,
  );
  const nextPurchaseCreditAt = firstNumber(purchaseCredits[0]?.creditsLifeEnd, purchaseCredits[0]?.credits_life_end);

  const credits = total != null ? {
    total,
    detailTotal: total,
    panelTotal: total,
    gift,
    purchase,
    vip,
    monthlyQuota,
    monthlyQuotaText: monthlyQuota ? `${monthlyQuota.toLocaleString('zh-CN')}积分/月` : '',
    dailyFreeAmount: history?.dailyFreeAmount || gift || null,
    lastDailyFreeAt: history?.lastDailyFreeAt || 0,
    nextDailyFreeAt,
    lastSubscriptionCreditAt: history?.lastSubscriptionCreditAt || 0,
    nextSubscriptionCreditAt,
    nextPurchaseCreditAt,
    lastCreditClearAt: history?.lastCreditClearAt || 0,
    expiringCreditInfoList: expiring,
    creditsDetail,
    history: historyList.slice(0, 8),
    source: 'app-service',
  } : null;

  const rawVip = snapshot.vipInfo || {};
  const rawLevel = rawVip.curVipLevel || rawVip.cur_vip_level || rawVip.level || vipLevel;
  const vipType = vipLevelToDisplayName(rawLevel);
  const expireTime = Number(rawVip.endTime || rawVip.end_time || rawVip.vipRealEnd || rawVip.vip_real_end || 0) || 0;
  const nextRenewalTime = Number(rawVip.nextRenewalTime || rawVip.next_renewal_time || rawVip.currentAutoRenewPlan?.nextRenewalTime || 0) || 0;
  const vipObj = (snapshot.isVip || expireTime || rawLevel) ? {
    isVip: !!snapshot.isVip || !!expireTime || !!rawLevel,
    vipType,
    planName: vipType,
    billingCycle: formatBillingCycle({
      subscribe_cycle: rawVip.subscribeCycle ?? rawVip.subscribe_cycle,
      cycle_unit: rawVip.cycleUnit ?? rawVip.cycle_unit,
      subscribe_type: rawVip.subscribeType ?? rawVip.subscribe_type,
    }),
    expireTime,
    expireText: formatJimengEpochLocalText(expireTime),
    nextRenewalTime,
    monthlyQuota,
    monthlyQuotaText: monthlyQuota ? `${monthlyQuota.toLocaleString('zh-CN')}积分/月` : '',
    nextSubscriptionCreditAt,
    source: 'app-service',
  } : null;

  return { credits, vip: vipObj };
}

function parseMemberPanelSnapshot(snapshot = {}) {
  const modalText = String(snapshot.modalText || snapshot.bodyText || '');
  const lines = modalText.split(/\n+/).map(line => line.trim()).filter(Boolean);
  const compact = lines.join('\n');
  if (!/积分详情|订阅计划|会员|积分/.test(compact)) return { credits: null, vip: null };

  const expireText = (compact.match(/(20\d{2}[.\/-]\d{1,2}[.\/-]\d{1,2}\s+\d{1,2}:\d{2})/) || [])[1] || '';
  const expireTime = parseJimengLocalDateTime(expireText);
  const accountHeaderIndex = lines.findIndex(line => /^用户/.test(line));
  const vipSearchWindow = accountHeaderIndex >= 0 ? lines.slice(accountHeaderIndex + 1, accountHeaderIndex + 6) : lines;
  const vipLine = vipSearchWindow.find(line => /^(高级会员|标准会员|基础会员|会员)$/.test(line))
    || lines.find(line => /^(高级会员|标准会员|基础会员|会员)$/.test(line))
    || lines.find(line => /高级会员|标准会员|基础会员/.test(line))
    || '';
  const vipType = (vipLine.match(/(高级会员|标准会员|基础会员|会员)/) || [])[1] || '';
  const cycle = lines.find(line => /连续包年|连续包月|单月购买|包年|包月|免费/.test(line)) || '';

  let detailTotal = null;
  const detailMatch = compact.match(/积分详情\s*\n?\s*([\d,.]+\s*(?:万|千|k)?)/i);
  if (detailMatch) detailTotal = parseCompactDisplayedNumber(detailMatch[1]);
  if (detailTotal == null) {
    const totalMatch = compact.match(/(?:总积分|当前积分|积分)\s*[:：]?\s*([\d,.]+\s*(?:万|千|k)?)/i);
    if (totalMatch) detailTotal = parseCompactDisplayedNumber(totalMatch[1]);
  }

  const planLabel = vipType || '高级会员';
  let monthlyQuotaText = '';
  let monthlyQuota = null;
  const planQuotaRe = new RegExp(`${planLabel}[\\s\\S]{0,260}?([\\d,]+)\\s*积分每月`);
  let quotaMatch = compact.match(planQuotaRe);
  if (!quotaMatch) quotaMatch = compact.match(/([\d,]+)\s*积分每月/);
  if (quotaMatch) {
    monthlyQuota = parseCompactDisplayedNumber(quotaMatch[1]);
    monthlyQuotaText = `${quotaMatch[1].replace(/\s+/g, '')}积分/月`;
  }

  const history = extractCreditHistoryDetails(snapshot.historyPayload) || extractCreditHistoryDetails(snapshot.historyResponse) || null;
  const source = snapshot.source || 'member-panel-dom';
  const creditsTotal = history?.totalCredit || detailTotal;
  const credits = (creditsTotal != null || monthlyQuota != null || history) ? {
    total: creditsTotal != null ? creditsTotal : detailTotal,
    gift: history?.dailyFreeAmount || 0,
    purchase: 0,
    vip: monthlyQuota || 0,
    detailTotal: detailTotal != null ? detailTotal : null,
    panelTotal: detailTotal != null ? detailTotal : null,
    monthlyQuota,
    monthlyQuotaText,
    dailyFreeAmount: history?.dailyFreeAmount || null,
    lastDailyFreeAt: history?.lastDailyFreeAt || 0,
    nextDailyFreeAt: history?.nextDailyFreeAt || 0,
    lastSubscriptionCreditAt: history?.lastSubscriptionCreditAt || 0,
    nextSubscriptionCreditAt: history?.nextSubscriptionCreditAt || 0,
    lastCreditClearAt: history?.lastCreditClearAt || 0,
    history: history?.history || [],
    source,
  } : null;

  const vip = (vipType || expireTime || monthlyQuota) ? {
    isVip: !!vipType && !/免费/.test(vipType),
    vipType: vipType || '',
    planName: vipType || '',
    billingCycle: cycle || '',
    expireTime,
    expireText,
    monthlyQuota,
    monthlyQuotaText,
    nextSubscriptionCreditAt: history?.nextSubscriptionCreditAt || 0,
    source,
  } : null;

  return { credits, vip };
}


async function readAppServiceDetailedStatus(tabId, { timeoutMs = 7000 } = {}) {
  if (tabId == null) return { credits: null, vip: null };

  const results = await extensionApi.scripting.executeScript({
    target: { tabId },
    world: 'MAIN',
    args: [timeoutMs],
    func: async (timeout) => {
      const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));
      const toPlain = (value) => {
        if (value == null) return value;
        try { return JSON.parse(JSON.stringify(value)); } catch {}
        if (Array.isArray(value)) return value.map(toPlain);
        if (typeof value === 'object') {
          const out = {};
          for (const key of Object.keys(value)) {
            const v = value[key];
            if (typeof v !== 'function') out[key] = toPlain(v);
          }
          return out;
        }
        return value;
      };
      const historyArray = (value) => {
        if (!value) return [];
        try { return Array.from(value).map(toPlain); } catch {}
        if (typeof value === 'object') return Object.values(value).map(toPlain);
        return [];
      };

      const deadline = Date.now() + timeout;
      let cf = null, cc = null, vip = null;
      while (Date.now() < deadline) {
        cf = window.__debugger?.DreaminaCommercialFeatureService;
        cc = cf?.commercialCreditService || cf?._commercialCreditService;
        vip = cf?.vipService || cf?._vipService;
        if (cf && cc && vip && (cc.isLocalCreditReady || cc.localCredit != null || vip.isVipReady)) break;
        await sleep(250);
      }
      if (!cc && !vip) return { available: false, reason: 'app-service-unavailable' };

      // 直接读取即梦页面内部会员/积分服务已缓存的只读状态。这里不调用 syncHistoryData / loadMoreCreditHistory，
      // 避免扩展额外触发带签名的真实网络请求或留下可识别的自定义 contextType。刷新由即梦页面自身完成。
      await sleep(300);

      const rawVipInfo = vip?.vipInfo;
      return {
        available: true,
        source: 'app-service',
        localCredit: Number(cc?.localCredit || 0) || 0,
        creditInfo: toPlain(cc?.creditInfo) || null,
        creditsDetail: toPlain(cc?.creditsDetail) || null,
        expiringCreditInfoList: toPlain(cc?.expiringCreditInfoList) || [],
        creditHistoryList: historyArray(cc?.creditHistoryList),
        currentVipLevel: vip?.currentVipLevel || rawVipInfo?.curVipLevel || '',
        isVip: !!vip?.isVip,
        isVipReady: !!vip?.isVipReady,
        vipInfo: rawVipInfo ? {
          flag: !!rawVipInfo.flag,
          curVipLevel: rawVipInfo.curVipLevel || rawVipInfo.cur_vip_level || vip?.currentVipLevel || '',
          subscribeType: rawVipInfo.subscribeType || rawVipInfo.subscribe_type || '',
          subscribeCycle: rawVipInfo.subscribeCycle || rawVipInfo.subscribe_cycle || 0,
          cycleUnit: rawVipInfo.cycleUnit || rawVipInfo.cycle_unit || '',
          startTime: rawVipInfo.startTime || rawVipInfo.start_time || 0,
          endTime: rawVipInfo.endTime || rawVipInfo.end_time || 0,
          nextRenewalTime: rawVipInfo.nextRenewalTime || rawVipInfo.next_renewal_time || 0,
          currentAutoRenewPlan: toPlain(rawVipInfo.currentAutoRenewPlan) || null,
        } : null,
      };
    },
  });

  const snapshot = results?.[0]?.result;
  if (!snapshot) return { credits: null, vip: null };
  return parseAppServiceSnapshot(snapshot);
}

async function readDetailedMemberPanelStatus(tabId, { timeoutMs = 7000 } = {}) {
  if (tabId == null) return { credits: null, vip: null };

  const results = await extensionApi.scripting.executeScript({
    target: { tabId },
    world: 'MAIN',
    args: [timeoutMs],
    func: async (timeout) => {
      const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));
      const visible = (el) => {
        if (!el) return false;
        const rect = el.getBoundingClientRect?.();
        const style = getComputedStyle(el);
        return !!rect && rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none';
      };
      const text = (el) => (el?.textContent || '').replace(/\u00a0/g, ' ').trim();
      const safeClick = (el) => {
        if (!el) return false;
        try { el.scrollIntoView?.({ block: 'center', inline: 'center' }); } catch {}
        try { el.focus?.(); } catch {}
        const rect = el.getBoundingClientRect?.();
        const opts = {
          bubbles: true, cancelable: true, composed: true, view: window,
          clientX: rect ? rect.left + rect.width / 2 : 1,
          clientY: rect ? rect.top + rect.height / 2 : 1,
          button: 0, buttons: 1, pointerId: 1, pointerType: 'mouse', isPrimary: true,
        };
        try {
          for (const type of ['pointerover', 'mouseover', 'pointermove', 'mousemove', 'pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click']) {
            const EventCtor = type.startsWith('pointer') && typeof PointerEvent === 'function' ? PointerEvent : MouseEvent;
            el.dispatchEvent(new EventCtor(type, opts));
          }
          try { el.click(); } catch {}
          return true;
        } catch {
          try { el.click(); return true; } catch { return false; }
        }
      };
      const modalRoots = () => Array.from(document.querySelectorAll('[role="dialog"], .lv-modal-wrapper, .lv-modal, [class*="managerModal"], [class*="vipUserCard"], [class*="creditItem"], [class*="commerce"]'))
        .filter(visible);
      const modalText = () => {
        const roots = modalRoots();
        const picked = roots.filter(el => /积分详情|订阅管理|订阅计划|积分每月|连续包/.test(text(el)));
        const raw = (picked.length ? picked : roots).map(text).filter(Boolean).join('\n');
        return raw || text(document.body);
      };
      const findClickableByText = (needle) => Array.from(document.querySelectorAll('button, [role="button"], a, div, span'))
        .filter(visible)
        .find(el => text(el) === needle || text(el).includes(needle));
      const closeBlockingDialog = async () => {
        const pageText = text(document.body);
        if (!/继续绑定|即梦资产支持剪映|绑定剪映/.test(pageText) || /积分详情|订阅计划/.test(modalText())) return;
        const roots = Array.from(document.querySelectorAll('[role="dialog"], .lv-modal-wrapper, .lv-modal, [class*="modal"], div'))
          .filter(visible)
          .filter(el => /继续绑定|即梦资产支持剪映|绑定剪映/.test(text(el)));
        const hasClose = (el) => !!el.querySelector?.('[aria-label*="关闭"], [class*="close"], [class*="modal-close"], button');
        const root = roots.filter(hasClose).sort((a, b) => text(a).length - text(b).length)[0]
          || roots.sort((a, b) => text(a).length - text(b).length)[0]
          || document;
        const close = Array.from(root.querySelectorAll?.('[aria-label*="关闭"], [class*="close"], [class*="modal-close"], button') || [])
          .filter(visible)
          .find(el => {
            const t = text(el);
            const cls = String(el.className || '');
            return /close/i.test(cls) || /关闭|×|✕|x/i.test(t) || /关闭/.test(el.getAttribute('aria-label') || '');
          });
        if (close) safeClick(close);
        document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
        await sleep(700);
      };
      const openPersonalPage = async () => {
        const personal = document.querySelector('#Personal')
          || document.querySelector('[id="Personal"]')
          || Array.from(document.querySelectorAll('[role="menuitem"], [class*="avatar"], img')).filter(visible).find(el => /avatar|Personal|个人|用户/.test(String(el.id || '') + String(el.className || '') + text(el)));
        if (personal) {
          safeClick(personal);
          await sleep(1800);
          return true;
        }
        return false;
      };
      const openCreditPanel = () => {
        const selectors = [
          '[class*="credit-display-menu-container"]',
          '[role="menuitem"][class*="credit"]',
          '[class*="credit-display-container"]',
          '[class*="credit-amount-container"]',
          '[class*="credit-container"]',
          '[class*="sider-menu-credit"]',
        ];
        for (const selector of selectors) {
          const el = Array.from(document.querySelectorAll(selector)).filter(visible).find(node => /\d|积分|万|会员/.test(text(node)));
          if (el && safeClick(el)) return true;
        }
        const textCandidate = Array.from(document.querySelectorAll('button, [role="button"], div, span'))
          .filter(visible)
          .find(el => /\d+(?:\.\d+)?\s*(?:万|千|k)?/.test(text(el)) && /会员|积分|万/.test(text(el)));
        return safeClick(textCandidate);
      };

      const captured = [];
      const originalFetch = window.fetch;
      window.fetch = async (...args) => {
        const url = String(args[0]?.url || args[0] || '');
        const resp = await originalFetch.apply(window, args);
        if (/user_credit_history|subscription\/price_list|subscription\/user_info|benefits\/user_credit/.test(url)) {
          resp.clone().text().then(body => {
            try { captured.push({ url, body: JSON.parse(body) }); }
            catch { captured.push({ url, bodyText: body.slice(0, 4000) }); }
          }).catch(() => {});
        }
        return resp;
      };

      let openedByUs = false;
      try {
        await closeBlockingDialog();
        if (!/积分详情|订阅计划|积分每月/.test(modalText())) {
          openedByUs = openCreditPanel();
        }
        let deadline = Date.now() + Math.min(timeout, 3500);
        while (Date.now() < deadline && !/积分详情|订阅计划|积分每月/.test(modalText())) await sleep(250);

        // 部分新会话首页会先弹“绑定剪映”，或首页侧栏积分项只更新状态不弹会员面板；
        // 和人工路径一致：先进个人页，再点左下角积分/会员入口。
        if (!/积分详情|订阅计划|积分每月/.test(modalText())) {
          await closeBlockingDialog();
          await openPersonalPage();
          await closeBlockingDialog();
          openedByUs = openCreditPanel() || openedByUs;
          deadline = Date.now() + timeout;
          while (Date.now() < deadline && !/积分详情|订阅计划|积分每月/.test(modalText())) await sleep(250);
        }

        const detail = findClickableByText('积分详情');
        if (detail) {
          safeClick(detail);
          await sleep(1200);
        }

        const historyEvent = [...captured].reverse().find(item => /user_credit_history/.test(item.url));
        const snapshot = {
          source: 'member-panel-dom',
          modalText: modalText(),
          bodyText: text(document.body),
          historyPayload: historyEvent?.body || null,
          capturedUrls: captured.map(item => item.url).slice(-8),
          openedByUs,
        };

        if (openedByUs) {
          const close = Array.from(document.querySelectorAll('[aria-label*="关闭"], [class*="close"], button'))
            .filter(visible)
            .find(el => /关闭|×|✕|x/i.test(text(el)) || /close/i.test(el.className || '') || /close/i.test(el.getAttribute('aria-label') || ''));
          if (close) safeClick(close);
          else document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
        }

        return snapshot;
      } finally {
        window.fetch = originalFetch;
      }
    },
  });

  const snapshot = results?.[0]?.result;
  if (!snapshot) return { credits: null, vip: null };
  return parseMemberPanelSnapshot(snapshot);
}

function nonEmptyObjectFields(obj = {}) {
  const out = {};
  for (const [key, value] of Object.entries(obj || {})) {
    if (value == null || value === '') continue;
    if (typeof value === 'number' && value === 0 && !['gift', 'purchase', 'vip', 'total'].includes(key)) continue;
    if (Array.isArray(value) && !value.length) continue;
    out[key] = value;
  }
  return out;
}

function mergeDetailedStatusIntoResult(result, detailed) {
  if (!detailed) return result;
  if (detailed.credits) {
    result.credits = { ...(result.credits || {}), ...nonEmptyObjectFields(detailed.credits) };
    if (result.credits.total == null && result.credits.detailTotal != null) result.credits.total = result.credits.detailTotal;
    result.creditsUnknown = false;
  }
  if (detailed.vip) {
    result.vip = { ...(result.vip || {}), ...nonEmptyObjectFields(detailed.vip) };
    result.vipUnknown = false;
  }
  return result;
}

async function readDisplayedAccountStatus(tabId, { retries = 4, delayMs = 800 } = {}) {
  if (tabId == null) return { credits: null, vip: null };

  const readOnce = async () => {
    const results = await extensionApi.scripting.executeScript({
      target: { tabId },
      world: 'MAIN',
      func: () => {
        const parseCompactDisplayedNumber = (text) => {
          const raw = String(text || '').trim().toLowerCase();
          if (!raw) return null;
          const normalized = raw.replace(/,/g, '').replace(/\s+/g, '');
          const match = normalized.match(/(\d+(?:\.\d+)?)/);
          if (!match) return null;
          const value = Number(match[1]);
          if (!Number.isFinite(value)) return null;
          if (normalized.includes('万')) return Math.round(value * 10000);
          if (normalized.includes('千') || normalized.endsWith('k')) return Math.round(value * 1000);
          if (normalized.includes('亿')) return Math.round(value * 100000000);
          return Math.round(value);
        };
        const textOf = (selectors) => {
          for (const selector of selectors) {
            const el = document.querySelector(selector);
            const text = el?.textContent?.trim();
            if (text) return text;
          }
          return '';
        };

        const creditText = textOf([
          '[class*="credit-amount-text"]',
          '[class*="credit-amount-container"]',
          '[class*="credit-display-container"]',
        ]);
        const vipText = textOf([
          '[class*="upgrade-text"]',
          '[class*="vip-text"]',
          '[class*="member-text"]',
          '[class*="credit-display-container"] [class*="text"]',
        ]);

        const total = parseCompactDisplayedNumber(creditText);
        const normalizedVip = vipText.replace(/\s+/g, '');

        return {
          credits: total == null ? null : { total, gift: total, purchase: 0, vip: 0 },
          vip: normalizedVip ? {
            isVip: !/开通|普通|游客|未开通/.test(normalizedVip),
            vipType: normalizedVip,
            expireTime: 0,
          } : null,
        };
      },
    });
    return results?.[0]?.result || { credits: null, vip: null };
  };

  for (let attempt = 0; attempt <= retries; attempt += 1) {
    const displayed = await readOnce();
    if (displayed?.credits || displayed?.vip) return displayed;
    if (attempt < retries) await new Promise(r => setTimeout(r, delayMs));
  }

  return { credits: null, vip: null };
}

// 传输层失败：断网 / tab 关闭 / 5xx 等——这些情况下不能判断 session 是否有效，
// 应返回到"状态未知"分支，不覆盖现有 cachedCredits/sessionValid。
function isTransportFailure(resp) {
  if (!resp) return true;
  if (resp.error) return true; // executeScript 失败
  if (resp.status === 0) return true; // fetch 完全失败
  if (resp.status >= 500) return true; // 服务端错误
  return false;
}

// 严格的 auth failure：确定性的"已登录凭证失效"（401/403/业务错误码/明确错误消息）。
// 不包括传输层失败（由 isTransportFailure 单独判断）。
function isAuthFailure(resp) {
  if (!resp) return false; // 空响应在 isTransportFailure 那边判
  if (isTransportFailure(resp)) return false; // 传输失败不算 auth 失败
  if (resp.status === 401 || resp.status === 403) return true;
  const d = resp.data;
  if (!d) return false;
  const payload = (d.data && typeof d.data === 'object') ? d.data : d;
  const errno = d.errno ?? d.status_code ?? d.ret ?? d.error_code ?? payload.error_code;
  if (errno === 13 || errno === 10000 || errno === 10001 || errno === 40001) return true;
  const msg = String([
    d.errmsg, d.message, d.description, d.name,
    payload.errmsg, payload.message, payload.description, payload.name,
  ].filter(Boolean).join(' ')).toLowerCase();
  return msg.includes('not login')
    || msg.includes('未登录')
    || msg.includes('会话过期')
    || msg.includes('session expired')
    || msg.includes('login required')
    || msg.includes('account_info_error');
}

// ======================== 账号存储 ========================

function cloneAccountsSnapshot(accounts) {
  return JSON.parse(JSON.stringify(Array.isArray(accounts) ? accounts : []));
}

function buildAccountsSignature(accounts) {
  return JSON.stringify((accounts || []).map(a => ({
    id: a.id || '',
    userId: a.userId || '',
    name: a.name || '',
    sessionValid: a.sessionValid ?? null,
    cookieCount: Array.isArray(a.cookies) ? a.cookies.length : 0,
    sid: a.cookies?.find(c => c.name === 'sessionid')?.value || '',
  })));
}

function getAccountSessionId(account) {
  return account?.cookies?.find(c => c.name === 'sessionid')?.value || '';
}


function getAccountCookieValue(accountOrCookies, name) {
  const cookies = Array.isArray(accountOrCookies)
    ? accountOrCookies
    : (Array.isArray(accountOrCookies?.cookies) ? accountOrCookies.cookies : []);
  return cookies.find(c => c?.name === name)?.value || '';
}

function getDeviceIdentitySignature(accountOrCookies) {
  // 这些不是账号凭证本身，而是即梦/剪映登录链路复用的浏览器设备身份线索。
  // 实测同一 Chrome 里连续登录多个新账号时，它们会共享这些值，后登录账号可能把前一个账号的 session 挤掉。
  // 只在本地比较，不外传、不展示原值。
  const parts = DEVICE_COOKIE_NAMES.map(name => `${name}=${getAccountCookieValue(accountOrCookies, name) || ''}`);
  const hasStrongDeviceId = !!getAccountCookieValue(accountOrCookies, 's_v_web_id')
    || !!getAccountCookieValue(accountOrCookies, 'passport_csrf_token');
  return hasStrongDeviceId ? parts.join('&') : '';
}

function findDeviceIdentityCollisions(accounts, account) {
  const sig = getDeviceIdentitySignature(account);
  if (!sig) return [];
  const uid = account?.userId ? String(account.userId) : '';
  return (accounts || [])
    .filter(existing => existing?.id !== account?.id)
    .filter(existing => uid && existing?.userId && String(existing.userId) !== uid)
    .filter(existing => getDeviceIdentitySignature(existing) === sig)
    .map(existing => ({ id: existing.id || '', name: existing.name || '', userId: existing.userId || '' }));
}

function isGenericAccountName(name = '') {
  const text = String(name || '').trim();
  return !text
    || text === '未命名'
    || /^用户\d+$/.test(text)
    || /^账号\s*\d+$/.test(text);
}

function accountFreshness(account = {}) {
  return Math.max(
    Number(account.lastChecked || 0) || 0,
    Number(account.savedAt || 0) || 0,
  );
}

function accountCookieCount(account = {}) {
  return Array.isArray(account.cookies) ? account.cookies.length : 0;
}

function pickBestAccountData(accounts) {
  return [...accounts].sort((a, b) => {
    const validScore = (b.sessionValid === true ? 1 : 0) - (a.sessionValid === true ? 1 : 0);
    if (validScore) return validScore;
    const cookieScore = accountCookieCount(b) - accountCookieCount(a);
    if (cookieScore) return cookieScore;
    return accountFreshness(b) - accountFreshness(a);
  })[0] || accounts[0];
}

function pickBestAccountName(accounts, fallback) {
  const custom = [...accounts]
    .filter(a => !isGenericAccountName(a.name))
    .sort((a, b) => accountFreshness(b) - accountFreshness(a))[0]?.name;
  if (custom) return custom;

  const nickname = [...accounts]
    .map(a => a.nickname || a.name)
    .find(name => !isGenericAccountName(name));
  return nickname || fallback?.nickname || fallback?.name || '账号';
}

function mergeDuplicateAccountGroup(group) {
  if (group.length <= 1) return cloneAccountsSnapshot(group)[0];

  const bestData = pickBestAccountData(group);
  const anchor = group.find(a => !isGenericAccountName(a.name)) || group[0] || bestData;
  const merged = cloneAccountsSnapshot([bestData])[0] || {};
  const resolvedUserId = bestData.userId || anchor.userId || group.find(a => a.userId)?.userId || '';

  merged.id = anchor.id || bestData.id || crypto.randomUUID();
  merged.name = pickBestAccountName(group, bestData);
  merged.userId = resolvedUserId;
  merged.nickname = bestData.nickname || anchor.nickname || merged.name || '';
  merged.avatar = bestData.avatar || anchor.avatar || '';
  merged.cookies = Array.isArray(bestData.cookies)
    ? cloneAccountsSnapshot(bestData.cookies)
    : [];
  merged.cachedCredits = bestData.cachedCredits || anchor.cachedCredits || null;
  merged.cachedVip = bestData.cachedVip || anchor.cachedVip || null;
  // 不要因为同组里某张历史卡曾经标记 valid，就把实际承载 cookies 的 bestData 强行改成 valid。
  // 真实事故里，旧版 identity-repair 产生过同 userId 脏卡；合并时若用 any-valid，会把失效 cookie
  // 伪装成健康账号，直到用户点击切换才失败。
  merged.sessionValid = bestData.sessionValid ?? null;
  const savedAtCandidates = group
    .map(a => Number(a.savedAt || 0) || 0)
    .filter(Boolean);
  merged.savedAt = Number(bestData.savedAt || 0)
    || (savedAtCandidates.length ? Math.max(...savedAtCandidates) : Date.now());
  merged.lastChecked = Math.max(...group.map(a => Number(a.lastChecked || 0) || 0), 0) || bestData.lastChecked || null;
  if (resolvedUserId) delete merged.importedUserId;
  delete merged.lastError;
  return merged;
}

function normalizeAccountList(accounts) {
  const list = cloneAccountsSnapshot(accounts).filter(a => a && typeof a === 'object');
  const parent = list.map((_, idx) => idx);
  const find = (idx) => {
    while (parent[idx] !== idx) {
      parent[idx] = parent[parent[idx]];
      idx = parent[idx];
    }
    return idx;
  };
  const union = (a, b) => {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent[rb] = ra;
  };
  const byUserId = new Map();
  const bySession = new Map();

  list.forEach((account, idx) => {
    const uid = account.userId ? String(account.userId) : '';
    if (uid) {
      if (byUserId.has(uid)) union(byUserId.get(uid), idx);
      else byUserId.set(uid, idx);
    }

    const sid = getAccountSessionId(account);
    if (sid) {
      if (bySession.has(sid)) union(bySession.get(sid), idx);
      else bySession.set(sid, idx);
    }
  });

  const groups = new Map();
  list.forEach((account, idx) => {
    const root = find(idx);
    if (!groups.has(root)) groups.set(root, []);
    groups.get(root).push(account);
  });

  const normalized = [...groups.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([, group]) => mergeDuplicateAccountGroup(group));

  return {
    accounts: normalized,
    removed: list.length - normalized.length,
    changed: JSON.stringify(list) !== JSON.stringify(normalized),
  };
}

function findDuplicateImportedIdentity(accounts) {
  const seenSessions = new Map();
  const seenImportHints = new Map();
  for (const account of accounts || []) {
    const sid = getAccountSessionId(account);
    if (sid) {
      const prev = seenSessions.get(sid);
      if (prev) {
        return { type: 'sessionid', a: prev.name || '未命名', b: account.name || '未命名' };
      }
      seenSessions.set(sid, account);
    }

    // importedUserId 是弱线索，不能用来覆盖 cookies；但同一个导入文件里重复出现
    // 同一个 userId 时，通常意味着用户拿错了文件或同一账号被导出了多份。
    // 直接拒绝比生成“多张卡其实同一账号”更安全。
    const hint = account.userId || account.importedUserId || '';
    if (hint) {
      const prev = seenImportHints.get(hint);
      if (prev) {
        return { type: 'userId', a: prev.name || '未命名', b: account.name || '未命名' };
      }
      seenImportHints.set(hint, account);
    }
  }
  return null;
}

async function loadAccounts({ allowRecovery = true } = {}) {
  const r = await extensionApi.storage.local.get([STORAGE_KEY, STORAGE_BACKUP_KEY, STORAGE_JOURNAL_KEY]);
  if (Array.isArray(r[STORAGE_KEY])) {
    const normalized = normalizeAccountList(r[STORAGE_KEY]);
    if (normalized.changed) {
      console.warn(`[即梦切换器] 检测到重复/污染账号卡，自动合并 ${normalized.removed} 张重复卡`);
      await saveAccountsToStorage(normalized.accounts, 'normalize-accounts');
    }
    return normalized.accounts;
  }

  if (allowRecovery && Array.isArray(r[STORAGE_BACKUP_KEY])) {
    const normalized = normalizeAccountList(r[STORAGE_BACKUP_KEY]);
    await extensionApi.storage.local.set({ [STORAGE_KEY]: normalized.accounts });
    return normalized.accounts;
  }

  if (allowRecovery && Array.isArray(r[STORAGE_JOURNAL_KEY])) {
    const last = [...r[STORAGE_JOURNAL_KEY]].reverse().find(entry => Array.isArray(entry?.accounts));
    if (last) {
      const normalized = normalizeAccountList(last.accounts);
      await extensionApi.storage.local.set({
        [STORAGE_KEY]: normalized.accounts,
        [STORAGE_BACKUP_KEY]: normalized.accounts,
      });
      return normalized.accounts;
    }
  }

  return [];
}

async function saveAccountsToStorage(accounts, reason = 'update') {
  const normalized = normalizeAccountList(accounts);
  const snapshot = cloneAccountsSnapshot(normalized.accounts);
  const effectiveReason = normalized.changed && !String(reason).includes('normalize')
    ? `${reason}+normalize`
    : reason;
  const before = await extensionApi.storage.local.get([STORAGE_KEY, STORAGE_BACKUP_KEY, STORAGE_JOURNAL_KEY]);
  const previous = Array.isArray(before[STORAGE_KEY])
    ? before[STORAGE_KEY]
    : (Array.isArray(before[STORAGE_BACKUP_KEY]) ? before[STORAGE_BACKUP_KEY] : []);
  const journal = Array.isArray(before[STORAGE_JOURNAL_KEY]) ? before[STORAGE_JOURNAL_KEY] : [];
  const nextJournal = [...journal, {
    ts: Date.now(),
    reason: effectiveReason,
    count: snapshot.length,
    accounts: snapshot,
  }].slice(-MAX_ACCOUNTS_JOURNAL);

  await extensionApi.storage.local.set({
    [STORAGE_KEY]: snapshot,
    [STORAGE_BACKUP_KEY]: snapshot,
    [STORAGE_JOURNAL_KEY]: nextJournal,
  });

  const verify = (await extensionApi.storage.local.get(STORAGE_KEY))[STORAGE_KEY];
  const expectedSig = buildAccountsSignature(snapshot);
  const actualSig = Array.isArray(verify) ? buildAccountsSignature(verify) : null;
  if (!actualSig || expectedSig != actualSig) {
    await extensionApi.storage.local.set({
      [STORAGE_KEY]: previous,
      [STORAGE_BACKUP_KEY]: previous,
    });
    throw new Error(`账号数据写入校验失败（reason=${effectiveReason}）`);
  }

  return snapshot;
}

async function loadSettings() {
  const r = await extensionApi.storage.local.get(SETTINGS_KEY);
  return { ...DEFAULT_SETTINGS, ...(r[SETTINGS_KEY] || {}) };
}

async function saveSettings(patch) {
  const cur = await loadSettings();
  await extensionApi.storage.local.set({ [SETTINGS_KEY]: { ...DEFAULT_SETTINGS, ...cur, ...patch } });
}


async function getRuntimeDiagnostics() {
  const manifest = extensionApi.runtime.getManifest?.() || {};
  const pending = (await extensionApi.storage.local.get(PENDING_RESTORE_KEY))[PENDING_RESTORE_KEY] || null;
  return {
    version: manifest.version || '',
    serviceWorkerStartedAt: SERVICE_WORKER_STARTED_AT,
    pendingRestore: pending?.cookies?.length ? {
      stage: pending.stage || '',
      ageMs: Date.now() - Number(pending.ts || 0),
      stale: isStalePendingRestore(pending),
      cookieCount: Array.isArray(pending.cookies) ? pending.cookies.length : 0,
    } : null,
  };
}

// ======================== 账号业务逻辑 ========================

async function detectCurrentAccount() {
  const cookies = await getAllDomainCookies();
  const sid = cookies.find(c => c.name === 'sessionid');
  if (!sid || !sid.value) return null;
  const accounts = await loadAccounts();
  const bySession = accounts.find(a => a.cookies?.find(c => c.name === 'sessionid')?.value === sid.value);
  if (bySession) return bySession.id;
  const accountsWithUserId = accounts.filter(a => a.userId);
  if (!accountsWithUserId.length) return null;

  try {
    const status = await fetchStatusViaDirectWithRetry();
    if (!status?.valid || !status?.user?.userId) return null;
    const byUserId = accountsWithUserId.find(a => String(a.userId) === String(status.user.userId));
    return byUserId ? byUserId.id : null;
  } catch (e) {
    console.warn('[即梦切换器] detectCurrentAccount 直接校验失败:', e);
    return null;
  }
}

// 返回值：
//   unknown=true: 身份查询本身传输失败 → 上游不应覆盖任何现有状态
//   creditsUnknown/vipUnknown=true: 子请求传输失败 → 上游应保留旧 credits/vip 值
async function fetchStatusViaSession(session) {
  const result = {
    valid: false, credits: null, vip: null, user: null,
    unknown: false, creditsUnknown: false, vipUnknown: false,
  };
  const infoResp = await session.fetch(API_PATH.userInfo, {}, 'POST');
  if (isTransportFailure(infoResp)) {
    result.unknown = true;
    return result;
  }
  if (isAuthFailure(infoResp)) return result; // valid=false
  result.user = extractUserObj(infoResp?.data);
  result.valid = !!(result.user?.userId);
  if (!result.valid) return result;

  // credit 子请求：区分 transport failure（保留旧值）vs 正常返回
  try {
    const creditResp = await session.fetch(API_PATH.userCredit, {}, 'POST');
    if (isTransportFailure(creditResp)) {
      result.creditsUnknown = true;
    } else {
      const credits = extractCreditsObj(creditResp);
      if (credits) result.credits = credits;
      else result.creditsUnknown = true;
    }
  } catch {
    result.creditsUnknown = true; // 异常也当 transport 失败处理
  }

  try {
    const historyResp = await session.fetch(API_PATH.creditHistory, { count: 20, cursor: '0' }, 'POST');
    if (!isTransportFailure(historyResp)) {
      const history = extractCreditHistoryDetails(historyResp?.data || historyResp);
      if (history) {
        result.credits = {
          ...(result.credits || {}),
          total: history.totalCredit || result.credits?.total || null,
          detailTotal: history.totalCredit || result.credits?.detailTotal || null,
          panelTotal: history.totalCredit || result.credits?.panelTotal || null,
          dailyFreeAmount: history.dailyFreeAmount || result.credits?.dailyFreeAmount || null,
          lastDailyFreeAt: history.lastDailyFreeAt || 0,
          nextDailyFreeAt: result.credits?.nextDailyFreeAt || history.nextDailyFreeAt || 0,
          lastSubscriptionCreditAt: history.lastSubscriptionCreditAt || 0,
          nextSubscriptionCreditAt: result.credits?.nextSubscriptionCreditAt || history.nextSubscriptionCreditAt || 0,
          lastCreditClearAt: history.lastCreditClearAt || 0,
          history: history.history || [],
        };
        result.creditsUnknown = false;
      }
    }
  } catch {}

  try {
    const vipResp = await session.fetch(API_PATH.subscription, { aid: 513695, scene: 'vip', need_sign_info: true }, 'POST');
    if (isTransportFailure(vipResp)) {
      result.vipUnknown = true;
    } else {
      result.vip = extractVipObj(vipResp);
    }
  } catch {
    result.vipUnknown = true;
  }

  if (!result.credits || !result.vip || result.vip?.isVip === false) {
    try {
      const displayed = await readDisplayedAccountStatus(session.tabId);
      if (!result.credits && displayed?.credits) {
        result.credits = displayed.credits;
        result.creditsUnknown = false;
      }
      if ((!result.vip || result.vip?.isVip === false) && displayed?.vip?.isVip) {
        result.vip = displayed.vip;
        result.vipUnknown = false;
      }
    } catch {}
  }

  // 深度会员/积分状态：优先读取页面内部 app-service。它是“头像 → 会员管理 / 积分详情”
  // 面板背后的真实数据源，可避开即梦 user_credit 接口的 sign 限制并拿到精确余额。
  try {
    const detailed = await readAppServiceDetailedStatus(session.tabId);
    mergeDetailedStatusIntoResult(result, detailed);
  } catch (e) {
    console.warn('[即梦切换器] 读取页面会员/积分服务失败:', e);
  }

  // 兼容兜底：如果 app-service 不可用，再尝试真实打开会员/积分面板解析 DOM。
  if (!result.credits?.detailTotal || !result.vip?.expireTime) {
    try {
      const detailed = await readDetailedMemberPanelStatus(session.tabId);
      mergeDetailedStatusIntoResult(result, detailed);
    } catch (e) {
      console.warn('[即梦切换器] 读取会员/积分详情面板失败:', e);
    }
  }

  return result;
}

async function fetchStatusViaDirect() {
  const result = {
    valid: false, credits: null, vip: null, user: null,
    unknown: false, creditsUnknown: false, vipUnknown: false,
  };
  const infoResp = await fetchJimengApiDirect(API_PATH.userInfo, {}, 'POST');
  if (isTransportFailure(infoResp)) {
    result.unknown = true;
    return result;
  }
  if (isAuthFailure(infoResp)) return result; // valid=false
  result.user = extractUserObj(infoResp?.data);
  result.valid = !!(result.user?.userId);
  if (!result.valid) return result;

  try {
    const creditResp = await fetchJimengApiDirect(API_PATH.userCredit, {}, 'POST');
    if (isTransportFailure(creditResp)) {
      result.creditsUnknown = true;
    } else {
      const credits = extractCreditsObj(creditResp);
      if (credits) result.credits = credits;
      else result.creditsUnknown = true;
    }
  } catch {
    result.creditsUnknown = true;
  }

  try {
    const vipResp = await fetchJimengApiDirect(API_PATH.subscription, { aid: 513695, scene: 'vip', need_sign_info: true }, 'POST');
    if (isTransportFailure(vipResp)) {
      result.vipUnknown = true;
    } else {
      result.vip = extractVipObj(vipResp);
    }
  } catch {
    result.vipUnknown = true;
  }

  return result;
}

async function fetchStatusViaSessionWithRetry(session, { retries = 1, retryDelayMs = 500 } = {}) {
  let last = null;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    if (attempt > 0) {
      try { await session.reload(); } catch {}
      await new Promise(r => setTimeout(r, retryDelayMs));
    }
    last = await fetchStatusViaSession(session);
    if (!last?.unknown) return last;
  }
  return last || {
    valid: false, credits: null, vip: null, user: null,
    unknown: true, creditsUnknown: true, vipUnknown: true,
  };
}

async function fetchStatusViaDirectWithRetry({ retries = 1, retryDelayMs = 500 } = {}) {
  let last = null;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    if (attempt > 0) await new Promise(r => setTimeout(r, retryDelayMs));
    last = await fetchStatusViaDirect();
    if (!last?.unknown) return last;
  }
  return last || {
    valid: false, credits: null, vip: null, user: null,
    unknown: true, creditsUnknown: true, vipUnknown: true,
  };
}

function isJimengHost(host = '') {
  return typeof host === 'string' && host.includes('jianying.com');
}

function isAuthCookieName(name = '') {
  return AUTH_COOKIE_NAMES.has(name);
}

let autoSaveTimer = null;
let autoSaveInFlight = null;
let suppressAutoSaveUntil = 0;
let suppressLoginIsolationUntil = 0;
const autoLoginIsolationTimers = new Map();

function suppressAutomaticLoginWork(ms, reason = 'operation') {
  const until = Date.now() + ms;
  suppressAutoSaveUntil = Math.max(suppressAutoSaveUntil, until);
  suppressLoginIsolationUntil = Math.max(suppressLoginIsolationUntil, until);
  try {
    writeDiagnosticLog('auto-work:suppressed', { reason, ms, until });
  } catch {}
  return until;
}

function scheduleAutoLoginIsolation(tabId, reason = 'unknown', delayMs = 700) {
  if (tabId == null) return;
  if (Date.now() < suppressLoginIsolationUntil) return;
  clearTimeout(autoLoginIsolationTimers.get(tabId));
  autoLoginIsolationTimers.set(tabId, setTimeout(() => {
    autoLoginIsolationTimers.delete(tabId);
    maybeAutoPrepareLoggedOutLogin(tabId, reason).catch((e) => {
      console.warn(`[即梦切换器] 自动登录隔离异常 (${reason}):`, e);
    });
  }, delayMs));
}

async function maybeAutoPrepareLoggedOutLogin(tabId, reason = 'unknown') {
  return withCookieLock(() => prepareLoggedOutLoginInCurrentLock(tabId, reason));
}

async function prepareLoggedOutLoginInCurrentLock(tabId, reason = 'unknown', options = {}) {
  const force = options.force === true;
  if (Date.now() < suppressLoginIsolationUntil) {
    return { skipped: true, reason: 'suppressed-automatic-work', until: suppressLoginIsolationUntil };
  }
  const settings = await loadSettings();
  const lastIsolationAt = Number(settings.lastLoginIsolationAt || 0);
  if (Date.now() - lastIsolationAt < 10000) {
    return { skipped: true, reason: 'recently-isolated' };
  }

  const pending = (await extensionApi.storage.local.get(PENDING_RESTORE_KEY))[PENDING_RESTORE_KEY];
  if (pending?.cookies?.length && pending.stage !== 'committing') {
    return { skipped: true, reason: 'pending-restore-active' };
  }

  let tab;
  try {
    tab = await extensionApi.tabs.get(tabId);
  } catch {
    return { skipped: true, reason: 'tab-closed' };
  }
  if (!tab?.url || !isJimengHost(tab.url)) {
    return { skipped: true, reason: 'not-jimeng-tab' };
  }

  const cookies = await getAllDomainCookies();
  const sid = cookies.find(c => c.name === 'sessionid');
  if (sid?.value && !force) {
    return { skipped: true, reason: 'already-logged-in' };
  }

  const diagSessionId = crypto.randomUUID?.() || String(Date.now());
  await writeDiagnosticLog('login-isolation:auto-start', {
    diagSessionId,
    source: reason,
    tabId,
    force,
    cookieSummary: summarizeCookiesForDiagnostics(cookies),
  });

  await clearDomainCookies();
  const siteState = await clearJimengLoginIsolationState(tabId);
  suppressAutomaticLoginWork(15000, 'login-isolation');
  await saveSettings({
    lastLoginIsolationAt: Date.now(),
    lastLoginIsolationReason: reason,
  });
  await extensionApi.tabs.reload(tabId, { bypassCache: true });

  await writeDiagnosticLog('login-isolation:auto-success', {
    diagSessionId,
    source: reason,
    tabId,
    force,
    siteState,
    reason: LOGIN_ISOLATION_REASON,
  });

  return { success: true, tabId, force, siteState };
}

async function maybeAutoSaveCurrentAccount(reason = 'unknown') {
  const settings = await loadSettings();
  if (settings.autoSaveOnLogin === false) return { skipped: true, reason: 'disabled' };
  if (Date.now() < suppressAutoSaveUntil) {
    return { skipped: true, reason: 'suppressed-after-manual-save', until: suppressAutoSaveUntil };
  }

  if (autoSaveInFlight) return autoSaveInFlight;

  // 关键：自动保存的身份探测也必须进入 cookie 锁。
  //
  // onUpdated / cookies.onChanged 事件会在手动保存、批量刷新、账号切换过程中被我们自己的
  // cookie 写入和页面刷新触发。如果在锁外先跑 detectCurrentAccount()，它会读取全局
  // cookie store；此时 cookie 可能正处于“已清空/写了一半/待回滚”的中间态。
  // 结果就是：隐藏 tab 抢跑、真实账号 smoke 出现额外页、甚至把半切换状态误判为新账号。
  //
  // 所以这里把“是否已保存”的快速判断也放进 withCookieLock，保证它排在 switchAccount /
  // checkAllStatuses / 显式 saveCurrentAccount 后面，看到的是稳定的 cookie 状态。
  autoSaveInFlight = withCookieLock(() => withStorageLock(async () => {
    if (Date.now() < suppressAutoSaveUntil) {
      return { skipped: true, reason: 'suppressed-after-manual-save', until: suppressAutoSaveUntil };
    }
    const matchedId = await detectCurrentAccount();
    if (matchedId) return { skipped: true, reason: 'already-saved', accountId: matchedId };
    const result = await saveCurrentAccount(undefined, null, {
      source: `auto:${reason}`,
      allowCreateTab: false,
    });
    if (result?.success) {
      console.log(`[即梦切换器] 自动保存成功 (${reason}): ${result.account?.name || result.account?.userId || 'unknown'}`);
    } else if (result?.error && !/未检测到即梦登录状态|未找到 sessionid cookie|当前登录态无效/.test(result.error)) {
      console.warn(`[即梦切换器] 自动保存失败 (${reason}): ${result.error}`);
    }
    return result;
  })).finally(() => {
    autoSaveInFlight = null;
  });

  return autoSaveInFlight;
}

function scheduleAutoSaveCurrentAccount(reason = 'unknown', delayMs = 1200) {
  if (Date.now() < suppressAutoSaveUntil) return;
  clearTimeout(autoSaveTimer);
  autoSaveTimer = setTimeout(() => {
    maybeAutoSaveCurrentAccount(reason).catch((e) => {
      console.warn(`[即梦切换器] 自动保存异常 (${reason}):`, e);
    });
  }, delayMs);
}

async function saveCurrentAccount(customName, repairAccountId = null, options = {}) {
  const diagSessionId = crypto.randomUUID?.() || String(Date.now());
  const source = options.source || 'direct';
  const allowCreateTab = options.allowCreateTab !== false;
  const isAutoSource = String(source).startsWith('auto:');
  await writeDiagnosticLog('save:start', {
    diagSessionId,
    source,
    allowCreateTab,
    hasCustomName: !!(typeof customName === 'string' && customName.trim()),
    repairAccountId: repairAccountId || null,
  });

  // 恢复屏障：如果有未完成的 pending restore（上次异常终止），saveCurrentAccount 也必须拒绝。
  // 否则当前 cookie 可能是脏/半恢复状态，保存会把错误凭证固化进 storage。
  const existingPending = (await extensionApi.storage.local.get(PENDING_RESTORE_KEY))[PENDING_RESTORE_KEY];
  if (existingPending?.cookies?.length && existingPending.stage !== 'committing') {
    if (isStalePendingRestore(existingPending)) {
      console.warn('[即梦切换器] 保存账号前清理超时 pending restore');
      await writeDiagnosticLog('save:pending-stale-cleared', {
        diagSessionId,
        stage: existingPending.stage || '',
        ageMs: Date.now() - Number(existingPending.ts || 0),
        pendingCookieCount: Array.isArray(existingPending.cookies) ? existingPending.cookies.length : 0,
      });
      await clearPendingRestore();
    } else {
      await writeDiagnosticLog('save:blocked-by-pending', {
        diagSessionId,
        stage: existingPending.stage || '',
        ageMs: Date.now() - Number(existingPending.ts || 0),
        pendingCookieCount: Array.isArray(existingPending.cookies) ? existingPending.cookies.length : 0,
      });
      return {
        success: false,
        error: `检测到上次操作未完成（stage=${existingPending.stage}），请稍等片刻让自动恢复完成，或重启浏览器。`,
      };
    }
  }

  const initialCookies = await getAllDomainCookies();
  await writeDiagnosticLog('save:initial-cookies', {
    diagSessionId,
    ...summarizeCookiesForDiagnostics(initialCookies),
  });
  if (!initialCookies.length) {
    await writeDiagnosticLog('save:fail', { diagSessionId, reason: 'no-domain-cookies' });
    return { success: false, error: '未检测到即梦登录状态，请先在浏览器中登录即梦' };
  }
  const initialSid = initialCookies.find(c => c.name === 'sessionid');
  if (!initialSid?.value) {
    await writeDiagnosticLog('save:fail', { diagSessionId, reason: 'missing-sessionid', cookieSummary: summarizeCookiesForDiagnostics(initialCookies) });
    return { success: false, error: '未找到 sessionid cookie，请确认已登录即梦' };
  }

  const reusableTab = await findReusableJimengTab().catch(() => null);
  const session = reusableTab?.id != null
    ? new JimengTabSession({ forceInternal: false, allowCreate: false })
    : (allowCreateTab ? new JimengTabSession({ forceInternal: true }) : null);
  let status = { valid: false, credits: null, vip: null, user: null };
  let statusTabId = null;
  try {
    if (session) {
      await session.ensure();
      statusTabId = session.tabId;
      await writeDiagnosticLog('save:session-created', {
        diagSessionId,
        source,
        tabId: session.tabId,
        isInternal: session.isInternal,
        forceInternal: session.forceInternal,
        reusedExistingTab: session.isInternal === false,
      });
      status = await fetchStatusViaSessionWithRetry(session);
    } else {
      await writeDiagnosticLog('save:direct-status', {
        diagSessionId,
        source,
        reason: 'no-reusable-jimeng-tab-and-tab-creation-disabled',
      });
      status = await fetchStatusViaDirectWithRetry();
    }
    await writeDiagnosticLog('save:status', {
      diagSessionId,
      source,
      status: summarizeStatusForDiagnostics(status),
    });
  }
  catch (e) {
    console.warn('[即梦切换器] 查询状态失败:', e);
    await writeDiagnosticLog('save:status-exception', { diagSessionId, error: e?.message || String(e) });
  }
  finally { if (session) await session.cleanup(); }

  if (status?.unknown) {
    await writeDiagnosticLog('save:fail', { diagSessionId, reason: 'status-unknown', status: summarizeStatusForDiagnostics(status) });
    return {
      success: false,
      error: '当前账号状态校验失败（网络或页面响应异常），本次未保存。请稍后重试。',
    };
  }

  if (!status?.valid || !status?.user?.userId) {
    let isolation = null;
    if (isAutoSource && statusTabId != null && Date.now() >= suppressLoginIsolationUntil) {
      isolation = await prepareLoggedOutLoginInCurrentLock(statusTabId, 'auto-save-invalid-status', { force: true });
    }
    await writeDiagnosticLog('save:fail', { diagSessionId, reason: 'invalid-status-or-missing-userid', status: summarizeStatusForDiagnostics(status) });
    return {
      success: false,
      error: '当前登录态无效，本次未保存账号。请确认即梦页面已登录后重试。',
      loginIsolation: isolation,
    };
  }

  // 必须在身份校验成功后重新捕获 cookies。
  // 登录/切号时 cookie 会连续写入；旧实现先抓 cookies 再开页面校验，可能保存到“半登录”
  // 快照：校验时浏览器已经完整登录，但写入 storage 的仍是校验前的残缺 cookie，
  // 最终表现就是“保存成功，但之后切换回来立刻失效”。
  const cookies = await getStableDomainCookies();
  await writeDiagnosticLog('save:stable-cookies', {
    diagSessionId,
    ...summarizeCookiesForDiagnostics(cookies),
  });
  const sid = cookies.find(c => c.name === 'sessionid');
  if (!sid?.value) {
    await writeDiagnosticLog('save:fail', { diagSessionId, reason: 'stable-cookies-missing-sessionid', cookieSummary: summarizeCookiesForDiagnostics(cookies) });
    return {
      success: false,
      error: '登录态校验成功后未能稳定捕获 sessionid，本次未保存。请等待页面完全登录后重试。',
    };
  }

  const accounts = await loadAccounts();
  const user = status.user || {};
  const normalizedCustomName = typeof customName === 'string' ? customName.trim() : '';
  await writeDiagnosticLog('save:accounts-before-match', {
    diagSessionId,
    accounts: summarizeAccountsForDiagnostics(accounts),
    currentUserId: user.userId || '',
    repairAccountId: repairAccountId || null,
  });
  // 去重优先级：userId > sessionid
  // 同一账号重新登录 sessionid 会变，但 userId 不变——按 userId 能识别为同一账号自动更新
  let existIdx = -1;
  let matchBy = 'new';
  if (repairAccountId) {
    existIdx = accounts.findIndex(a => a.id === repairAccountId);
    if (existIdx >= 0) matchBy = 'repairAccountId';
  }
  if (existIdx < 0 && user.userId) {
    existIdx = accounts.findIndex(a => a.userId && a.userId === user.userId);
    if (existIdx >= 0) matchBy = 'userId';
  }
  if (existIdx < 0) {
    existIdx = accounts.findIndex(a => a.cookies?.find(c => c.name === 'sessionid')?.value === sid.value);
    if (existIdx >= 0) matchBy = 'sessionid';
  }

  if (repairAccountId && existIdx < 0) {
    await writeDiagnosticLog('save:fail', { diagSessionId, reason: 'repair-target-missing', repairAccountId });
    return { success: false, error: '目标账号不存在，请刷新插件后重试。' };
  }

  if (repairAccountId && user.userId) {
    const duplicateIdx = accounts.findIndex((a, idx) =>
      idx !== existIdx && a.userId && String(a.userId) === String(user.userId)
    );
    if (duplicateIdx >= 0) {
      await writeDiagnosticLog('save:fail', {
        diagSessionId,
        reason: 'repair-identity-duplicates-existing-account',
        duplicateIndex: duplicateIdx,
        duplicateAccount: summarizeAccountsForDiagnostics([accounts[duplicateIdx]])[0],
        targetIndex: existIdx,
      });
      return {
        success: false,
        error: `当前网页登录的是「${accounts[duplicateIdx].name || '另一个已保存账号'}」，不是目标账号。为避免覆盖错账号，本次没有保存。`,
      };
    }
  }

  const existing = existIdx >= 0 ? accounts[existIdx] : null;
  const detectedName = user.nickname || (existIdx >= 0 ? `账号 ${existIdx + 1}` : `账号 ${accounts.length + 1}`);
  const existingName = existing?.name || '';
  const existingNameLooksGeneric = !existingName || /^用户\d+$/.test(existingName) || /^账号\s*\d+$/.test(existingName);
  const identityChanged = !!(existing?.userId && user.userId && String(existing.userId) !== String(user.userId));
  const resolvedName = normalizedCustomName
    || ((existIdx >= 0 && existingName && !existingNameLooksGeneric && !identityChanged) ? existingName : detectedName);
  await writeDiagnosticLog('save:match-decision', {
    diagSessionId,
    existIdx,
    matchBy,
    identityChanged,
    existingName,
    existingNameLooksGeneric,
    detectedName,
    resolvedName,
    isRepair: !!repairAccountId,
  });

  const account = {
    id: existIdx >= 0 ? accounts[existIdx].id : crypto.randomUUID(),
    // 已存在的账号保留用户自定义 name，除非显式 customName；
    // 修复/身份变化/泛化昵称时，用 API 真实昵称修正，避免把旧账号名继续带到新 cookie。
    name: resolvedName,
    userId: user.userId || '', nickname: user.nickname || '', avatar: user.avatar || '',
    cookies: serializeCookies(cookies), savedAt: Date.now(),
    cachedCredits: status.credits, cachedVip: status.vip,
    sessionValid: status.valid, lastChecked: Date.now(),
  };
  const deviceIdentityCollisions = findDeviceIdentityCollisions(accounts, account);
  if (deviceIdentityCollisions.length) {
    const collisionIds = new Set(deviceIdentityCollisions.map(item => item.id).filter(Boolean));
    for (const savedAccount of accounts) {
      if (collisionIds.has(savedAccount.id)) {
        savedAccount.sessionValid = false;
        savedAccount.lastError = 'device-session-superseded';
        savedAccount.lastChecked = Date.now();
      }
    }
    await writeDiagnosticLog('save:device-identity-collision', {
      diagSessionId,
      source,
      currentUserId: account.userId || '',
      collisions: deviceIdentityCollisions,
      explanation: 'different accounts share browser device identity cookies; previous sessions are likely superseded server-side',
    });
  }
  if (existIdx >= 0) accounts[existIdx] = account; else accounts.push(account);
  const saved = await saveAccountsToStorage(accounts, repairAccountId ? 'repair-account' : 'save-current-account');
  if (!String(source).startsWith('auto:')) {
    suppressAutomaticLoginWork(15000, 'manual-save');
  }
  await writeDiagnosticLog('save:success', {
    diagSessionId,
    source,
    isUpdate: existIdx >= 0,
    matchBy,
    savedAccount: summarizeAccountsForDiagnostics([account])[0],
    savedAccountCount: saved.length,
  });
  return { success: true, account, isUpdate: existIdx >= 0, deviceIdentityCollisions };
}

async function clearJimengLocalStorage(tabId) {
  try {
    const results = await extensionApi.scripting.executeScript({
      target: { tabId },
      world: 'MAIN',
      func: async () => {
        const report = {
          localStorageKeys: 0,
          localStorageRemoved: [],
          sessionStorageKeys: 0,
          sessionStorageRemoved: [],
          indexedDbDeleted: [],
          indexedDbBlocked: [],
          cacheDeleted: [],
          preservedFingerprintState: true,
          errors: [],
        };

        const shouldPreserveKey = (key = '') => {
          const lower = String(key).toLowerCase();
          return lower.includes('web_id')
            || lower.includes('tea')
            || lower.includes('fpk')
            || lower.includes('finger')
            || lower.includes('device')
            || lower.includes('bd_ticket')
            || lower.includes('mstoken')
            || lower.includes('ms_token')
            || lower.includes('csrf');
        };

        const shouldRemoveAccountKey = (key = '') => {
          const lower = String(key).toLowerCase();
          if (shouldPreserveKey(lower)) return false;
          return lower.includes('user')
            || lower.includes('account')
            || lower.includes('passport')
            || lower.includes('login')
            || lower.includes('session')
            || lower.includes('auth')
            || lower.includes('token')
            || lower.includes('credit')
            || lower.includes('vip')
            || lower.includes('subscription')
            || lower.includes('benefit');
        };

        try {
          const keys = Array.from({ length: localStorage.length }, (_, idx) => localStorage.key(idx)).filter(Boolean);
          report.localStorageKeys = keys.length;
          for (const key of keys) {
            if (shouldRemoveAccountKey(key)) {
              localStorage.removeItem(key);
              report.localStorageRemoved.push(key);
            }
          }
        } catch (e) {
          report.errors.push(`localStorage:${e?.message || e}`);
        }

        try {
          const keys = Array.from({ length: sessionStorage.length }, (_, idx) => sessionStorage.key(idx)).filter(Boolean);
          report.sessionStorageKeys = keys.length;
          for (const key of keys) {
            if (shouldRemoveAccountKey(key)) {
              sessionStorage.removeItem(key);
              report.sessionStorageRemoved.push(key);
            }
          }
        } catch (e) {
          report.errors.push(`sessionStorage:${e?.message || e}`);
        }

        // 不再删除 IndexedDB / CacheStorage。
        // 即梦/剪映体系会把 web_id、设备指纹、风控状态散落在 cookie + localStorage + IDB 中。
        // 旧实现全清 IDB/Cache 会让“保存 cookie”与“页面设备指纹”失配，真实 Chrome 下反而导致
        // 切换后登录态被服务端拒绝；多标签页还会触发 indexedDB.onblocked，形成半清理状态。
        // 现在只做轻量账号缓存清理 + reload，让页面用目标 cookie 自然刷新账号态。

        return report;
      },
    });
    return results?.[0]?.result || null;
  } catch {
    return null;
  }
}

async function clearJimengLoginIsolationState(tabId) {
  try {
    const results = await extensionApi.scripting.executeScript({
      target: { tabId },
      world: 'MAIN',
      func: async () => {
        const report = {
          localStorageRemoved: 0,
          sessionStorageRemoved: 0,
          indexedDbDeleted: [],
          indexedDbBlocked: [],
          cacheDeleted: [],
          errors: [],
        };

        const clearStorage = (storage, field) => {
          try {
            const keys = Array.from({ length: storage.length }, (_, idx) => storage.key(idx)).filter(Boolean);
            for (const key of keys) {
              storage.removeItem(key);
              report[field] += 1;
            }
          } catch (e) {
            report.errors.push(`${field}:${e?.message || e}`);
          }
        };

        // 这是“登录新账号”前的一次性隔离，不是普通切换。
        // 普通切换保留指纹状态以避免页面和 cookie 失配；新登录前则必须清掉同源页面状态，
        // 让即梦重新生成一套浏览器设备身份，避免后登录账号把同设备链路下的旧账号挤下线。
        clearStorage(localStorage, 'localStorageRemoved');
        clearStorage(sessionStorage, 'sessionStorageRemoved');

        try {
          if (typeof caches !== 'undefined' && caches.keys) {
            const names = await caches.keys();
            for (const name of names) {
              try {
                if (await caches.delete(name)) report.cacheDeleted.push(name);
              } catch (e) {
                report.errors.push(`cache:${name}:${e?.message || e}`);
              }
            }
          }
        } catch (e) {
          report.errors.push(`caches:${e?.message || e}`);
        }

        try {
          if (indexedDB?.databases) {
            const dbs = await indexedDB.databases();
            for (const db of dbs) {
              if (!db?.name) continue;
              try {
                await new Promise((resolve) => {
                  const req = indexedDB.deleteDatabase(db.name);
                  req.onsuccess = () => { report.indexedDbDeleted.push(db.name); resolve(); };
                  req.onerror = () => { report.errors.push(`indexedDB:${db.name}:error`); resolve(); };
                  req.onblocked = () => { report.indexedDbBlocked.push(db.name); resolve(); };
                });
              } catch (e) {
                report.errors.push(`indexedDB:${db.name}:${e?.message || e}`);
              }
            }
          }
        } catch (e) {
          report.errors.push(`indexedDB:${e?.message || e}`);
        }

        return report;
      },
    });
    return results?.[0]?.result || null;
  } catch (e) {
    return { errors: [e?.message || String(e)] };
  }
}

async function waitForTabComplete(tabId, timeoutMs = TAB_LOAD_TIMEOUT_MS) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const tab = await extensionApi.tabs.get(tabId);
    if (tab?.status === 'complete') {
      await new Promise(r => setTimeout(r, TAB_INIT_GRACE_MS));
      return tab;
    }
    await new Promise(r => setTimeout(r, 300));
  }
  throw new Error(`Tab 加载超时 (${timeoutMs / 1000}s)`);
}

async function prepareIsolatedLogin() {
  const diagSessionId = crypto.randomUUID?.() || String(Date.now());
  const beforeCookies = await getAllDomainCookies();
  await writeDiagnosticLog('login-isolation:start', {
    diagSessionId,
    cookieSummary: summarizeCookiesForDiagnostics(beforeCookies),
  });

  await clearDomainCookies();
  const afterCookieClear = await getAllDomainCookies();

  let tab = await findReusableJimengTab().catch(() => null);
  let created = false;
  if (!tab?.id) {
    tab = await extensionApi.tabs.create({ url: JIMENG_HOME, active: true });
    created = true;
  } else {
    tab = await extensionApi.tabs.update(tab.id, { active: true });
  }

  await waitForTabComplete(tab.id);
  const siteState = await clearJimengLoginIsolationState(tab.id);
  await extensionApi.tabs.reload(tab.id, { bypassCache: true });
  await waitForTabComplete(tab.id);

  suppressAutomaticLoginWork(20000, 'manual-login-isolation');
  await saveSettings({
    lastLoginIsolationAt: Date.now(),
  });
  await writeDiagnosticLog('login-isolation:success', {
    diagSessionId,
    createdTab: created,
    tabId: tab.id,
    removedCookieCount: beforeCookies.length,
    remainingCookieCount: afterCookieClear.length,
    siteState,
    reason: LOGIN_ISOLATION_REASON,
  });

  return {
    success: true,
    tabId: tab.id,
    createdTab: created,
    removedCookieCount: beforeCookies.length,
    siteState,
    message: '已打开干净登录环境。请在即梦页面登录新账号，登录完成后点「保存当前账号」。',
  };
}

async function mergeVerifiedSwitchAccount(accountId, status, { repairIdentity = false, preserveMissingDetails = false } = {}) {
  return withStorageLock(async () => {
    const accounts = await loadAccounts();
    const target = accounts.find(a => a.id === accountId);
    if (!target) return null;

    if (status?.user?.userId) {
      const actualUserId = String(status.user.userId);
      const identityChanged = target.userId && String(target.userId) !== actualUserId;
      target.userId = actualUserId;
      target.nickname = status.user.nickname || target.nickname || '';
      target.avatar = status.user.avatar || target.avatar || '';
      delete target.importedUserId;

      // 如果保存的 userId 与 cookie 实际身份不一致，说明该卡片的显示元数据已经不可信。
      // 这正是截图里“三张卡都叫同一个用户、但头像/积分不同”的典型脏数据状态；
      // 直接用 API 真实昵称修正，避免用户每次点击都进入修复模式。
      if (repairIdentity || identityChanged || !target.name || /^用户\d+$/.test(target.name)) {
        target.name = status.user.nickname || target.name || `账号 ${accounts.indexOf(target) + 1}`;
      }
    }

    if (preserveMissingDetails) {
      // 切换流程现在只用后台 direct API 做身份验证，不再碰用户可见页面读取详情。
      // direct API 有时拿不到积分/VIP细节；这种情况下必须保留旧缓存，避免“切换一次详情消失”。
      if (!status?.creditsUnknown && status?.credits) target.cachedCredits = status.credits;
      if (!status?.vipUnknown && status?.vip) target.cachedVip = status.vip;
    } else {
      if (!status?.creditsUnknown) target.cachedCredits = status?.credits || null;
      if (!status?.vipUnknown) target.cachedVip = status?.vip || null;
    }
    target.sessionValid = !!status?.valid;
    target.lastChecked = Date.now();

    await saveAccountsToStorage(accounts, repairIdentity ? 'switch-account-repair-identity' : 'switch-account-verify');
    return target;
  });
}

async function markAccountInvalid(accountId, reason = 'invalid-session') {
  return withStorageLock(async () => {
    const accounts = await loadAccounts();
    const target = accounts.find(a => a.id === accountId);
    if (!target) return null;
    target.sessionValid = false;
    target.lastChecked = Date.now();
    target.lastError = reason;
    await saveAccountsToStorage(accounts, 'switch-account-invalid');
    return target;
  });
}

function buildSwitchFailureMessage(reason, rolledBack) {
  if (reason === 'identity-mismatch') {
    return rolledBack === 'full'
      ? '该账号卡保存的身份与恢复后的真实登录身份不一致，已回滚到原账号。为避免串号覆盖，请在即梦网页手动登录这个账号后点“保存当前账号”。'
      : '该账号卡保存的身份与恢复后的真实登录身份不一致，且回滚未完全成功。请手动检查即梦登录状态后重新保存。';
  }
  if (reason === 'invalid-session') {
    return rolledBack === 'full'
      ? '该账号保存的登录态已经失效，已回滚到原账号。请先在即梦网页手动登录这个账号，然后在插件里点“保存当前账号”。'
      : '该账号保存的登录态已经失效，且回滚未完全成功。请手动重新登录即梦后再点“保存当前账号”。';
  }
  if (reason === 'auth-cookie-write-failed') {
    return rolledBack === 'full'
      ? '关键登录 Cookie 写入失败，已回滚到原账号。请重新保存该账号。'
      : '关键登录 Cookie 写入失败，回滚也未完全成功，请手动重新登录即梦。';
  }
  if (reason === 'identity-unknown') {
    return rolledBack === 'full'
      ? '无法确认即梦账号身份（网络/API 返回不确定），已回滚到原账号。请稍后重试。'
      : '无法确认即梦账号身份，且回滚未完全成功，请手动检查即梦登录状态。';
  }
  return rolledBack === 'full'
    ? `切换失败（${reason}），已回滚到原账号。`
    : `切换失败（${reason}），回滚也未完全成功，请手动重新登录即梦。`;
}

async function switchAccount(accountId) {
  suppressAutomaticLoginWork(25000, 'switch-account-start');
  const accounts = await loadAccounts();
  const target = accounts.find(a => a.id === accountId);
  if (!target) return { success: false, error: '账号不存在' };
  if (target.sessionValid === false) {
    return {
      success: false,
      error: '该账号已过期，不能切换。请先在即梦网页重新登录这个账号，再点“保存当前账号”；如果已另存为新账号，可删除这张旧卡。',
      expired: true,
    };
  }

  const snapshot = serializeCookies(await getAllDomainCookies());
  try {
    await persistPendingRestore(snapshot, 'armed');
  } catch (e) {
    if (e instanceof PendingConflictError) {
      return { success: false, error: `${e.message}。请重启浏览器或等待自动恢复。` };
    }
    throw e;
  }

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
        if (hasCriticalRestoreFailure(restoreRes)) {
          // 关键登录 cookie 回滚失败：保留 pending（让下次启动再试），不清除
          console.error('[即梦切换器] 关键登录 cookie 回滚失败，保留 pending');
          return { rolledBack: 'partial', restoreFailures: restoreRes.failures };
        }
        if (!restoreRes.success) {
          console.warn('[即梦切换器] 回滚时部分非关键 cookie 写入失败，已忽略:', restoreRes.failures);
        }
      }
    } catch (e) {
      console.error('[即梦切换器] 回滚异常:', e);
      return { rolledBack: 'error' };
    }
    // 回滚成功，清 pending，并刷新现有即梦页，让用户看到的 UI 回到回滚后的真实账号。
    await clearPendingRestore();
    await reloadJimengTabsForSwitch('原账号').catch(() => {});
    return { rolledBack: 'full' };
  };

  try {
    await markPendingStage('business');
    let r = await tryRestore();
    let validation = r.authFailed
      ? { ok: false, reason: 'auth-cookie-write-failed', status: null }
      : await validateRestoredAccountForSwitch(target);

    // 第一次失败 → 重试一次
    if (r.authFailed || !validation.ok) {
      console.warn(`[即梦切换器] 首次切换失败（${validation.reason}），重试一次`);
      r = await tryRestore();
      validation = r.authFailed
        ? { ok: false, reason: 'auth-cookie-write-failed', status: null }
        : await validateRestoredAccountForSwitch(target);
    }

    // 两次都失败 → 回滚
    if (r.authFailed || !validation.ok) {
      await markAccountInvalid(target.id, validation.reason);
      const rb = await rollback(`两次尝试后 session 仍无效 (${validation.reason})`);
      return {
        success: false,
        error: buildSwitchFailureMessage(validation.reason, rb.rolledBack),
        rolledBack: rb.rolledBack,
      };
    }

    const verifiedTarget = await mergeVerifiedSwitchAccount(target.id, validation.status, {
      repairIdentity: validation.repaired === true,
      preserveMissingDetails: true,
    }) || target;
    suppressAutomaticLoginWork(25000, 'switch-account-verified');

    // validateRestoredAccountForSwitch 已经刷新过用于真实身份校验的用户可见 tab。
    // 最终广播刷新时跳过这些 tab，避免同一页面在一次切换里二次 reload。
    await reloadJimengTabsForSwitch(verifiedTarget.name, {
      skipTabIds: validation.reloadedTabIds || [],
    });

    // 提交：先标 committing 再清除 pending。
    // 即使崩在 markPendingStage 和 clearPendingRestore 之间，下次启动也不会误回滚。
    await markPendingStage('committing');
    await clearPendingRestore();
    suppressAutomaticLoginWork(25000, 'switch-account-success');
    return {
      success: true,
      account: verifiedTarget,
      identityRepaired: validation.repaired === true,
      previousUserId: validation.previousUserId || null,
    };
  } catch (e) {
    console.error('[即梦切换器] switchAccount 异常:', e);
    const rb = await rollback(`异常: ${e.message}`);
    return { success: false, error: `切换失败: ${e.message}`, rolledBack: rb.rolledBack };
  }
}

// 多窗口安全的 reload：每个窗口只 reload 该窗口的 active tab，其他 tab 注入非阻塞 toast
async function reloadJimengTabsForSwitch(accountName, options = {}) {
  const tabs = await extensionApi.tabs.query({ url: '*://*.jianying.com/*' });
  const skipTabIds = new Set((options.skipTabIds || [])
    .filter(tabId => tabId !== null && tabId !== undefined)
    .map(tabId => Number(tabId)));
  const result = { reloadedTabIds: [], skippedTabIds: [], notifiedTabIds: [] };
  if (tabs.length === 0) return result;

  // 真实 Chrome Profile 下，只刷新当前活动页会让其他已打开的即梦页继续显示旧账号，
  // 所以切换成功后对所有已存在的即梦/剪映页执行“轻量账号缓存清理 + reload”。
  // 注意：轻量清理不会删除 IndexedDB / CacheStorage / 设备指纹状态。
  // 注意：这里不再主动创建新页面；用户点一次“切换”不应该凭空开一个网页。
  for (const tab of tabs) {
    const tabId = Number(tab?.id);
    if (skipTabIds.has(tabId)) {
      result.skippedTabIds.push(tab.id);
      continue;
    }
    try {
      await clearJimengLocalStorage(tab.id);
      await extensionApi.tabs.reload(tab.id, { bypassCache: true });
      result.reloadedTabIds.push(tab.id);
    } catch {
      await notifyTabAccountSwitched(tab.id, accountName);
      result.notifiedTabIds.push(tab.id);
    }
  }
  return result;
}

// 非阻塞提示：向目标 tab 注入一条 Shadow DOM 隔离的浮动 toast
// 用 Shadow DOM 隔离避免被页面全局 CSS（特别是 reset.css 或 !important 规则）污染
async function notifyTabAccountSwitched(tabId, newAccountName) {
  try {
    await extensionApi.scripting.executeScript({
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
  await saveAccountsToStorage(accounts.filter(a => a.id !== accountId), 'delete-account');
  return { success: true };
}

async function renameAccount(accountId, newName) {
  const accounts = await loadAccounts();
  const target = accounts.find(a => a.id === accountId);
  if (!target) return { success: false, error: '账号不存在' };
  target.name = newName;
  await saveAccountsToStorage(accounts, 'rename-account');
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
  const duplicate = findDuplicateImportedIdentity(sanitized);
  if (duplicate) {
    return {
      success: false,
      error: `导入文件里存在重复账号（${duplicate.type}: 「${duplicate.a}」和「${duplicate.b}」），已拒绝导入，避免生成多张其实同一登录态的卡片。`,
    };
  }
  if (mode === 'replace') {
    await saveAccountsToStorage(sanitized, 'import-replace');
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
    // 匹配优先级：sessionid（强证据）→ importedUserId（弱线索，仅弱 merge）
    // 关键安全：importedUserId 是导入方自称的，不可信；只用它匹配时不允许覆盖 cookies
    // （否则恶意 JSON 伪造已知 userId 可替换该账号的登录凭证 = 账号劫持）。
    const importHint = a.importedUserId;
    const sid = getSid(a);

    let match = null;
    let matchBy = null; // 'sid' (强) | 'uid' (弱)
    if (sid && bySid.has(sid)) {
      match = bySid.get(sid);
      matchBy = 'sid';
    } else if (importHint && byUid.has(importHint)) {
      match = byUid.get(importHint);
      matchBy = 'uid';
    }

    if (match) {
      const preservedId = match.id;
      const preservedUserId = match.userId;
      if (matchBy === 'sid') {
        // 强匹配（同一 session cookie）→ 可以全量更新（但保护 id/userId）
        Object.assign(match, a, { id: preservedId, userId: preservedUserId });
      } else {
        // 弱匹配（仅 importedUserId 相同但 sessionid 不同）→ **不覆盖 cookies**，
        // 只更新非敏感显示字段（name 如果新的更好可以覆盖，其他保持）
        // 这样恶意 JSON 无法通过伪造 userId 替换用户的真实 cookies
        if (typeof a.name === 'string' && a.name && a.name !== '未命名') {
          match.name = a.name;
        }
        if (a.avatar) match.avatar = a.avatar;
        if (a.nickname) match.nickname = a.nickname;
        // cookies / cachedCredits / cachedVip / sessionValid 全部保留现有
      }
      updated++;
    } else {
      current.push(a);
      if (importHint) byUid.set(importHint, a);
      if (sid) bySid.set(sid, a);
      added++;
    }
  }
  await saveAccountsToStorage(current, 'import-merge');
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
  if (hasCriticalRestoreFailure(rr)) {
    throw new RestoreFailureError(rr.failures);
  }
  if (!rr.success) {
    console.warn('[即梦切换器] 部分非关键 cookie 写入失败，继续验证账号:', rr.failures);
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

    // 传输失败（网络抖动/5xx）：不覆盖现有状态，只更新 lastChecked
    if (status?.unknown) {
      target.lastChecked = Date.now();
      await saveAccountsToStorage(accounts, 'merge-account-status-unknown');
      return;
    }

    // 身份断言：状态里的 userId 必须匹配目标账号，避免 cookie 串号把 A 的状态写到 B
    if (!assertUserIdMatch(target, status)) {
      console.warn(`[即梦切换器] userId 不匹配，拒绝 merge 状态到账号 ${target.name}（${target.userId} vs ${status?.user?.userId}）`);
      target.sessionValid = false;
      target.lastChecked = Date.now();
      await saveAccountsToStorage(accounts, 'merge-account-status-mismatch');
      return;
    }
    // credits/vip 子请求 transport failure 时保留旧值（避免网络抖动抹掉最后已知好数据）
    if (!status.creditsUnknown) target.cachedCredits = status.credits;
    if (!status.vipUnknown) target.cachedVip = status.vip;
    target.sessionValid = status.valid;
    target.lastChecked = Date.now();
    // 首次拿到真实 userId 时回填，并清理导入残留的 importedUserId
    if (!target.userId && status.user?.userId) {
      target.userId = String(status.user.userId);
      delete target.importedUserId;
    }
    await saveAccountsToStorage(accounts, 'merge-account-status');
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

      // 传输失败：不覆盖现有状态
      if (status?.unknown) {
        acc.lastChecked = now;
        changed = true;
        continue;
      }

      if (!assertUserIdMatch(acc, status)) {
        console.warn(`[即梦切换器] 批量 merge: ${acc.name} userId 不匹配，跳过状态写入`);
        acc.sessionValid = false;
        acc.lastChecked = now;
        changed = true;
        continue;
      }
      if (!status.creditsUnknown) acc.cachedCredits = status.credits;
      if (!status.vipUnknown) acc.cachedVip = status.vip;
      acc.sessionValid = status.valid;
      acc.lastChecked = now;
      if (!acc.userId && status.user?.userId) {
        acc.userId = String(status.user.userId);
        delete acc.importedUserId;
      }
      changed = true;
    }
    if (changed) await saveAccountsToStorage(accounts, 'merge-multiple-account-statuses');
  });
}

async function checkAccountStatus(accountId) {
  const accountsSnapshot = await loadAccounts();
  const target = accountsSnapshot.find(a => a.id === accountId);
  if (!target) return { success: false, error: '账号不存在' };

  const originalCookies = serializeCookies(await getAllDomainCookies());
  try {
    await persistPendingRestore(originalCookies, 'armed');
  } catch (e) {
    if (e instanceof PendingConflictError) {
      return { success: false, error: `${e.message}。请重启浏览器或等待自动恢复。` };
    }
    throw e;
  }
  const session = new JimengTabSession({ forceInternal: true });
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
      if (hasCriticalRestoreFailure(rr)) restoreFailed = true;
      else if (!rr.success) console.warn('[即梦切换器] checkAccountStatus 恢复时部分非关键 cookie 失败，已忽略:', rr.failures);
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
  try {
    await persistPendingRestore(originalCookies, 'armed');
  } catch (e) {
    if (e instanceof PendingConflictError) {
      return { success: false, error: `${e.message}。请重启浏览器或等待自动恢复。` };
    }
    throw e;
  }
  const session = new JimengTabSession({ forceInternal: true });
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

      let status;
      try {
        status = await withAccountCookies(acc, session, () => fetchStatusViaSession(session));
      } catch (e) {
        console.warn(`[即梦切换器] 查询 ${acc.name} 失败:`, e);
        // 按异常类型区分：
        //   RestoreFailureError (cookie 写入失败) → 视为真正 session 失效（valid:false，会覆盖状态）
        //   其他（tab load timeout / reload 失败 / network）→ transport failure（不覆盖现有缓存）
        if (e instanceof RestoreFailureError) {
          status = { valid: false, credits: null, vip: null, user: null, unknown: false };
        } else {
          status = {
            valid: false, credits: null, vip: null, user: null,
            unknown: true, creditsUnknown: true, vipUnknown: true,
          };
        }
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
      if (hasCriticalRestoreFailure(rr)) restoreFailed = true;
      else if (!rr.success) console.warn('[即梦切换器] checkAllStatuses 恢复时部分非关键 cookie 失败，已忽略:', rr.failures);
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
  'saveCurrentAccount', 'switchAccount', 'prepareIsolatedLogin',
  'checkStatus', 'checkAllStatuses',
  'deleteAccount', 'renameAccount', 'importAccounts',
]);

extensionApi.runtime.onMessage.addListener((msg, sender, sendResponse) => {
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
        case 'getRuntimeDiagnostics': return await getRuntimeDiagnostics();
        case 'getDiagnosticLogs': return await getDiagnosticLogs();
        case 'clearDiagnosticLogs': return await clearDiagnosticLogs();
        case 'saveSettings':   await saveSettings(msg.patch || {}); return { success: true };
        case 'detectCurrent':  return await detectCurrentAccount();
        case 'saveCurrentAccount':
          return await withCookieLock(() => withStorageLock(() => saveCurrentAccount(msg.name, msg.repairAccountId, {
            source: 'manual',
            allowCreateTab: false,
          })));
        case 'prepareIsolatedLogin':
          return await withCookieLock(() => prepareIsolatedLogin());
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
  // 补 rejection handler：handler 虽然自己 try/catch，但边界脆弱，加一层兜底保证 popup 一定收到响应
  handler().then(
    sendResponse,
    (e) => {
      console.error('[即梦切换器] 消息路由未捕获异常:', e);
      try { sendResponse({ success: false, error: String(e?.message || e) }); } catch {}
    }
  );
  return true;
});
