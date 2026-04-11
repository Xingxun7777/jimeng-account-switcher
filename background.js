// ================================================================
// 即梦账号切换器 - Background Service Worker
// 核心功能: Cookie 管理 / API 签名 / 账号切换 / 积分领取
// ================================================================

// ======================== MD5 实现 ========================
// 用于即梦 API 请求签名 (基于 Joseph Myers 的实现, public domain)
const md5 = (() => {
  const hex_chr = '0123456789abcdef';
  function rhex(n) {
    let s = '';
    for (let j = 0; j < 4; j++)
      s += hex_chr.charAt((n >> (j * 8 + 4)) & 0x0f) + hex_chr.charAt((n >> (j * 8)) & 0x0f);
    return s;
  }

  function add32(a, b) { return (a + b) & 0xffffffff; }

  function cmn(q, a, b, x, s, t) {
    a = add32(add32(a, q), add32(x, t));
    return add32((a << s) | (a >>> (32 - s)), b);
  }
  function ff(a, b, c, d, x, s, t) { return cmn((b & c) | (~b & d), a, b, x, s, t); }
  function gg(a, b, c, d, x, s, t) { return cmn((b & d) | (c & ~d), a, b, x, s, t); }
  function hh(a, b, c, d, x, s, t) { return cmn(b ^ c ^ d, a, b, x, s, t); }
  function ii(a, b, c, d, x, s, t) { return cmn(c ^ (b | ~d), a, b, x, s, t); }

  function cycle(x, k) {
    let a = x[0], b = x[1], c = x[2], d = x[3];
    a = ff(a, b, c, d, k[0], 7, -680876936);   d = ff(d, a, b, c, k[1], 12, -389564586);
    c = ff(c, d, a, b, k[2], 17, 606105819);    b = ff(b, c, d, a, k[3], 22, -1044525330);
    a = ff(a, b, c, d, k[4], 7, -176418897);    d = ff(d, a, b, c, k[5], 12, 1200080426);
    c = ff(c, d, a, b, k[6], 17, -1473231341);  b = ff(b, c, d, a, k[7], 22, -45705983);
    a = ff(a, b, c, d, k[8], 7, 1770035416);    d = ff(d, a, b, c, k[9], 12, -1958414417);
    c = ff(c, d, a, b, k[10], 17, -42063);      b = ff(b, c, d, a, k[11], 22, -1990404162);
    a = ff(a, b, c, d, k[12], 7, 1804603682);   d = ff(d, a, b, c, k[13], 12, -40341101);
    c = ff(c, d, a, b, k[14], 17, -1502002290); b = ff(b, c, d, a, k[15], 22, 1236535329);

    a = gg(a, b, c, d, k[1], 5, -165796510);    d = gg(d, a, b, c, k[6], 9, -1069501632);
    c = gg(c, d, a, b, k[11], 14, 643717713);   b = gg(b, c, d, a, k[0], 20, -373897302);
    a = gg(a, b, c, d, k[5], 5, -701558691);    d = gg(d, a, b, c, k[10], 9, 38016083);
    c = gg(c, d, a, b, k[15], 14, -660478335);  b = gg(b, c, d, a, k[4], 20, -405537848);
    a = gg(a, b, c, d, k[9], 5, 568446438);     d = gg(d, a, b, c, k[14], 9, -1019803690);
    c = gg(c, d, a, b, k[3], 14, -187363961);   b = gg(b, c, d, a, k[8], 20, 1163531501);
    a = gg(a, b, c, d, k[13], 5, -1444681467);  d = gg(d, a, b, c, k[2], 9, -51403784);
    c = gg(c, d, a, b, k[7], 14, 1735328473);   b = gg(b, c, d, a, k[12], 20, -1926607734);

    a = hh(a, b, c, d, k[5], 4, -378558);       d = hh(d, a, b, c, k[8], 11, -2022574463);
    c = hh(c, d, a, b, k[11], 16, 1839030562);  b = hh(b, c, d, a, k[14], 23, -35309556);
    a = hh(a, b, c, d, k[1], 4, -1530992060);   d = hh(d, a, b, c, k[4], 11, 1272893353);
    c = hh(c, d, a, b, k[7], 16, -155497632);   b = hh(b, c, d, a, k[10], 23, -1094730640);
    a = hh(a, b, c, d, k[13], 4, 681279174);    d = hh(d, a, b, c, k[0], 11, -358537222);
    c = hh(c, d, a, b, k[3], 16, -722521979);   b = hh(b, c, d, a, k[6], 23, 76029189);
    a = hh(a, b, c, d, k[9], 4, -640364487);    d = hh(d, a, b, c, k[12], 11, -421815835);
    c = hh(c, d, a, b, k[15], 16, 530742520);   b = hh(b, c, d, a, k[2], 23, -995338651);

    a = ii(a, b, c, d, k[0], 6, -198630844);    d = ii(d, a, b, c, k[7], 10, 1126891415);
    c = ii(c, d, a, b, k[14], 15, -1416354905); b = ii(b, c, d, a, k[5], 21, -57434055);
    a = ii(a, b, c, d, k[12], 6, 1700485571);   d = ii(d, a, b, c, k[3], 10, -1894986606);
    c = ii(c, d, a, b, k[10], 15, -1051523);    b = ii(b, c, d, a, k[1], 21, -2054922799);
    a = ii(a, b, c, d, k[8], 6, 1873313359);    d = ii(d, a, b, c, k[15], 10, -30611744);
    c = ii(c, d, a, b, k[6], 15, -1560198380);  b = ii(b, c, d, a, k[13], 21, 1309151649);
    a = ii(a, b, c, d, k[4], 6, -145523070);    d = ii(d, a, b, c, k[11], 10, -1120210379);
    c = ii(c, d, a, b, k[2], 15, 718787259);    b = ii(b, c, d, a, k[9], 21, -343485551);

    x[0] = add32(a, x[0]); x[1] = add32(b, x[1]);
    x[2] = add32(c, x[2]); x[3] = add32(d, x[3]);
  }

  function blks(s) {
    const n = s.length;
    const nblk = ((n + 8) >> 6) + 1;
    const blks = new Array(nblk * 16).fill(0);
    for (let i = 0; i < n; i++)
      blks[i >> 2] |= s.charCodeAt(i) << ((i % 4) * 8);
    blks[n >> 2] |= 0x80 << ((n % 4) * 8);
    blks[nblk * 16 - 2] = n * 8;
    return blks;
  }

  return function (s) {
    const k = blks(s);
    const state = [1732584193, -271733879, -1732584194, 271733878];
    for (let i = 0; i < k.length; i += 16)
      cycle(state, k.slice(i, i + 16));
    return state.map(rhex).join('');
  };
})();

// ======================== 常量 ========================
const JIMENG_DOMAIN = '.jianying.com';
const JIMENG_URL = 'https://jimeng.jianying.com';
const STORAGE_KEY = 'jimeng_accounts';

// ======================== Cookie 操作 ========================

async function getAllDomainCookies() {
  // 同时查 .jianying.com 和 jimeng.jianying.com，确保不遗漏
  const [a, b] = await Promise.all([
    chrome.cookies.getAll({ domain: JIMENG_DOMAIN }),
    chrome.cookies.getAll({ domain: 'jimeng.jianying.com' }),
  ]);
  // 去重（按 name+domain+path）
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
  // 用 https 统一删除，避免 protocol 不匹配导致漏删
  await Promise.all(cookies.map(cookie => {
    const domain = cookie.domain.startsWith('.') ? cookie.domain.slice(1) : cookie.domain;
    return chrome.cookies.remove({
      url: `https://${domain}${cookie.path}`,
      name: cookie.name,
    });
  }));
  // 二次确认：再查一遍，有残留就逐个删
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
  // 先设置非关键 cookie，最后设置 auth cookie，确保顺序正确
  const authNames = new Set(['sessionid', 'sessionid_ss', 'sid_tt', 'sid_guard', 'uid_tt', 'uid_tt_ss']);
  const normal = savedCookies.filter(c => !authNames.has(c.name));
  const auth = savedCookies.filter(c => authNames.has(c.name));

  for (const cookie of [...normal, ...auth]) {
    const domain = cookie.domain.startsWith('.') ? cookie.domain.slice(1) : cookie.domain;
    const details = {
      url: `https://${domain}${cookie.path}`,
      name: cookie.name,
      value: cookie.value,
      domain: cookie.domain,
      path: cookie.path,
      secure: cookie.secure,
      httpOnly: cookie.httpOnly,
    };

    // sameSite=no_restriction 要求 secure=true
    if (cookie.sameSite && cookie.sameSite !== 'unspecified') {
      details.sameSite = cookie.sameSite;
      if (cookie.sameSite === 'no_restriction') details.secure = true;
    }

    if (cookie.expirationDate) {
      details.expirationDate = cookie.expirationDate;
    }

    try {
      const result = await chrome.cookies.set(details);
      if (!result && authNames.has(cookie.name)) {
        // 关键 cookie 设置失败，用 http 重试
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

// 验证 sessionid 是否成功恢复
async function verifySession() {
  const sid = await chrome.cookies.get({ url: 'https://jimeng.jianying.com/', name: 'sessionid' });
  return !!(sid && sid.value);
}

function serializeCookies(cookies) {
  return cookies.map(c => ({
    name: c.name,
    value: c.value,
    domain: c.domain,
    path: c.path,
    secure: c.secure,
    httpOnly: c.httpOnly,
    sameSite: c.sameSite,
    expirationDate: c.expirationDate,
    hostOnly: c.hostOnly,
  }));
}

// ======================== API 请求 ========================

function generateSign(uri) {
  const timestamp = Math.floor(Date.now() / 1000);
  const uriSuffix = uri.length >= 7 ? uri.slice(-7) : uri;
  const raw = `9e2c|${uriSuffix}|7|5.8.0|${timestamp}||11ac`;
  return { sign: md5(raw), timestamp };
}

async function apiRequest(path, body = null) {
  const { sign, timestamp } = generateSign(path);
  const url = `${JIMENG_URL}${path}`;

  const headers = {
    'Accept': 'application/json, text/plain, */*',
    'Content-Type': 'application/json',
    'Referer': `${JIMENG_URL}/ai-tool/home`,
    'Origin': JIMENG_URL,
    'Device-Time': String(timestamp),
    'Sign': sign,
    'Sign-Ver': '1',
    'Appid': '513695',
    'Appvr': '5.8.0',
    'Pf': '7',
  };

  const options = {
    method: 'POST',
    credentials: 'include',
    headers,
  };

  if (body !== null) {
    options.body = JSON.stringify(body);
  }

  const resp = await fetch(url, options);
  if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
  return resp.json();
}

async function getUserInfo() {
  return apiRequest('/passport/account/info/v2?account_sdk_source=web', {});
}

async function claimCredits() {
  return apiRequest('/commerce/v1/benefits/credit_receive', {});
}

async function getCredits() {
  return apiRequest('/commerce/v1/benefits/user_credit', {});
}

async function getVipInfo() {
  return apiRequest('/commerce/v1/subscription/user_info', {});
}

// ======================== 账号管理 ========================

async function loadAccounts() {
  const result = await chrome.storage.local.get(STORAGE_KEY);
  return result[STORAGE_KEY] || [];
}

async function saveAccountsToStorage(accounts) {
  await chrome.storage.local.set({ [STORAGE_KEY]: accounts });
}

// 检测当前登录的是哪个已保存账号
async function detectCurrentAccount() {
  const cookies = await getAllDomainCookies();
  const sid = cookies.find(c => c.name === 'sessionid');
  if (!sid || !sid.value) return null;

  const accounts = await loadAccounts();
  const match = accounts.find(a =>
    a.cookies?.find(c => c.name === 'sessionid')?.value === sid.value
  );
  return match ? match.id : null;
}

// 保存当前浏览器中的即梦登录状态
async function saveCurrentAccount(customName) {
  const cookies = await getAllDomainCookies();
  if (!cookies.length) {
    return { success: false, error: '未检测到即梦登录状态，请先在浏览器中登录即梦' };
  }

  const sid = cookies.find(c => c.name === 'sessionid');
  if (!sid || !sid.value) {
    return { success: false, error: '未找到 sessionid cookie，请确认已登录即梦' };
  }

  // 尝试获取用户信息（昵称、头像）
  let userInfo = {};
  try {
    const resp = await getUserInfo();
    // 即梦 API 可能返回 { data: { user_id, name, screen_name, avatar_url } }
    // 也可能是 { data: { data: { ... } } }
    const d = resp?.data?.user_id ? resp.data : resp?.data?.data;
    if (d) {
      userInfo = {
        userId: String(d.user_id || d.uid || ''),
        nickname: d.name || d.screen_name || d.nickname || '',
        avatar: d.avatar_url || d.avatar_large || '',
      };
    }
  } catch (e) {
    console.warn('[即梦切换器] 获取用户信息失败，将使用自定义名称', e);
  }

  const accounts = await loadAccounts();

  // 仅按 sessionid 去重（不用 userId，避免 API 返回错误数据导致覆盖别的账号）
  const existIdx = accounts.findIndex(a =>
    a.cookies?.find(c => c.name === 'sessionid')?.value === sid.value
  );

  // 保存时顺便查询积分和VIP状态
  const status = await fetchCurrentStatus();

  const account = {
    id: existIdx >= 0 ? accounts[existIdx].id : crypto.randomUUID(),
    name: customName || userInfo.nickname || `账号 ${accounts.length + 1}`,
    userId: userInfo.userId || '',
    nickname: userInfo.nickname || '',
    avatar: userInfo.avatar || '',
    cookies: serializeCookies(cookies),
    savedAt: Date.now(),
    lastClaim: existIdx >= 0 ? accounts[existIdx].lastClaim : null,
    cachedCredits: status.credits,
    cachedVip: status.vip,
    sessionValid: status.valid,
    lastChecked: Date.now(),
  };

  if (existIdx >= 0) {
    accounts[existIdx] = account;
  } else {
    accounts.push(account);
  }

  await saveAccountsToStorage(accounts);
  return { success: true, account, isUpdate: existIdx >= 0 };
}

// 清理即梦页面的 localStorage 缓存（账号相关）
async function clearJimengLocalStorage(tabId) {
  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      func: () => {
        // 清除账号相关的 localStorage 缓存，强制页面重新从 cookie 读取
        const keysToRemove = [];
        for (let i = 0; i < localStorage.length; i++) {
          const key = localStorage.key(i);
          if (
            key.includes('passport') || key.includes('token') ||
            key.includes('user_status') || key.includes('receive_credits') ||
            key.includes('dialog_manager_daily') || key.includes('intro_dialog_has_showed') ||
            key.includes('bind_capcut_dialog') || key.includes('__tea_cache_tokens')
          ) {
            keysToRemove.push(key);
          }
        }
        keysToRemove.forEach(k => localStorage.removeItem(k));
        // 同时清 sessionStorage
        sessionStorage.clear();
      },
    });
  } catch (e) {
    console.warn('[即梦切换器] 清理 localStorage 失败:', e);
  }
}

// 切换到指定账号
async function switchAccount(accountId) {
  const accounts = await loadAccounts();
  const target = accounts.find(a => a.id === accountId);
  if (!target) return { success: false, error: '账号不存在' };

  // 第1步：彻底清除旧 cookie
  await clearDomainCookies();
  await new Promise(r => setTimeout(r, 100));

  // 第2步：写入目标账号的 cookie
  await restoreCookies(target.cookies);
  await new Promise(r => setTimeout(r, 100));

  // 第3步：验证关键 cookie 是否恢复成功
  const verified = await verifySession();
  if (!verified) {
    // 重试一次
    console.warn('[即梦切换器] sessionid 验证失败，重试中...');
    await clearDomainCookies();
    await new Promise(r => setTimeout(r, 200));
    await restoreCookies(target.cookies);
    await new Promise(r => setTimeout(r, 200));
    const retryOk = await verifySession();
    if (!retryOk) {
      return { success: false, error: 'Cookie 恢复失败，请重新保存该账号' };
    }
  }

  // 第4步：清理即梦标签页的 localStorage 缓存，然后强制刷新
  const tabs = await chrome.tabs.query({ url: '*://*.jianying.com/*' });
  if (tabs.length > 0) {
    for (const tab of tabs) {
      await clearJimengLocalStorage(tab.id);
      chrome.tabs.reload(tab.id, { bypassCache: true });
    }
  } else {
    chrome.tabs.create({ url: `${JIMENG_URL}/ai-tool/home` });
  }

  return { success: true, account: target };
}

// 删除账号
async function deleteAccount(accountId) {
  const accounts = await loadAccounts();
  const filtered = accounts.filter(a => a.id !== accountId);
  await saveAccountsToStorage(filtered);
  return { success: true };
}

// 为单个账号领取积分
async function claimForSingleAccount(account) {
  await clearDomainCookies();
  await restoreCookies(account.cookies);

  // 短暂等待 cookie 写入生效
  await new Promise(r => setTimeout(r, 300));

  const result = { accountId: account.id, accountName: account.name, success: false };

  try {
    const claimResp = await claimCredits();
    result.claimResponse = claimResp;
    result.success = true;
  } catch (e) {
    result.error = `领取失败: ${e.message}`;
  }

  try {
    const creditResp = await getCredits();
    result.credits = creditResp?.data;
  } catch (e) {
    // 积分查询失败不影响主流程
  }

  return result;
}

// 一键领取所有账号积分
async function claimAllCredits(sendProgress) {
  const accounts = await loadAccounts();
  if (!accounts.length) {
    return { success: false, error: '没有保存的账号' };
  }

  // 备份当前 cookie，结束后恢复
  const originalCookies = await getAllDomainCookies();
  const serializedOriginal = serializeCookies(originalCookies);
  const results = [];

  for (let i = 0; i < accounts.length; i++) {
    // 通知进度
    if (sendProgress) {
      sendProgress({ current: i + 1, total: accounts.length, name: accounts[i].name });
    }

    // 账号间间隔 2 秒，防止频控
    if (i > 0) {
      await new Promise(r => setTimeout(r, 2000));
    }

    const result = await claimForSingleAccount(accounts[i]);
    results.push(result);

    // 更新 lastClaim
    if (result.success) {
      accounts[i].lastClaim = new Date().toISOString().split('T')[0];
      // 同时更新存储的 cookie（服务端可能刷新了 session）
      const freshCookies = await getAllDomainCookies();
      if (freshCookies.length > 0) {
        accounts[i].cookies = serializeCookies(freshCookies);
      }
    }
  }

  await saveAccountsToStorage(accounts);

  // 恢复原始 session
  await clearDomainCookies();
  if (serializedOriginal.length > 0) {
    await restoreCookies(serializedOriginal);
  }

  // 刷新即梦标签页
  const tabs = await chrome.tabs.query({ url: '*://*.jianying.com/*' });
  for (const tab of tabs) {
    chrome.tabs.reload(tab.id);
  }

  return { success: true, results };
}

// 更新账号名称
async function renameAccount(accountId, newName) {
  const accounts = await loadAccounts();
  const target = accounts.find(a => a.id === accountId);
  if (!target) return { success: false, error: '账号不存在' };
  target.name = newName;
  await saveAccountsToStorage(accounts);
  return { success: true };
}

// 查询当前 cookie 对应的账号状态（积分+VIP+session有效性）
async function fetchCurrentStatus() {
  const result = { valid: false, credits: null, vip: null };
  try {
    const infoResp = await getUserInfo();
    const d = infoResp?.data?.user_id ? infoResp.data : infoResp?.data?.data;
    result.valid = !!(d && (d.user_id || d.uid));
  } catch (e) {
    return result;
  }

  try {
    const creditResp = await getCredits();
    const c = creditResp?.data?.credit;
    if (c) {
      result.credits = {
        gift: c.gift_credit || 0,
        purchase: c.purchase_credit || 0,
        vip: c.vip_credit || 0,
        total: (c.gift_credit || 0) + (c.purchase_credit || 0) + (c.vip_credit || 0),
      };
    }
  } catch (e) { /* ignore */ }

  try {
    const vipResp = await getVipInfo();
    const v = vipResp?.data || vipResp?.response;
    if (v) {
      result.vip = {
        isVip: !!(v.is_vip || v.vip_type),
        vipType: v.vip_type_name || v.vip_type || '',
        expireTime: v.expire_time || v.vip_expire_time || 0,
      };
    }
  } catch (e) { /* ignore */ }

  return result;
}

// 查询指定账号的状态（临时切换 cookie → 查询 → 恢复）
async function checkAccountStatus(accountId) {
  const accounts = await loadAccounts();
  const target = accounts.find(a => a.id === accountId);
  if (!target) return { error: '账号不存在' };

  const originalCookies = serializeCookies(await getAllDomainCookies());

  await clearDomainCookies();
  await restoreCookies(target.cookies);
  await new Promise(r => setTimeout(r, 200));

  const status = await fetchCurrentStatus();

  // 更新账号存储的状态缓存
  target.cachedCredits = status.credits;
  target.cachedVip = status.vip;
  target.sessionValid = status.valid;
  target.lastChecked = Date.now();
  await saveAccountsToStorage(accounts);

  // 恢复原 cookie
  await clearDomainCookies();
  if (originalCookies.length > 0) await restoreCookies(originalCookies);

  return { success: true, status, accountId };
}

// 查询所有账号状态
async function checkAllStatuses() {
  const accounts = await loadAccounts();
  if (!accounts.length) return { success: false, error: '没有保存的账号' };

  const originalCookies = serializeCookies(await getAllDomainCookies());
  const results = [];

  for (let i = 0; i < accounts.length; i++) {
    if (i > 0) await new Promise(r => setTimeout(r, 1000));

    await clearDomainCookies();
    await restoreCookies(accounts[i].cookies);
    await new Promise(r => setTimeout(r, 200));

    const status = await fetchCurrentStatus();
    accounts[i].cachedCredits = status.credits;
    accounts[i].cachedVip = status.vip;
    accounts[i].sessionValid = status.valid;
    accounts[i].lastChecked = Date.now();
    results.push({ accountId: accounts[i].id, name: accounts[i].name, ...status });
  }

  await saveAccountsToStorage(accounts);

  await clearDomainCookies();
  if (originalCookies.length > 0) await restoreCookies(originalCookies);

  return { success: true, results };
}

// 为指定单个账号领取积分
async function claimOne(accountId) {
  const accounts = await loadAccounts();
  const target = accounts.find(a => a.id === accountId);
  if (!target) return { success: false, error: '账号不存在' };

  const originalCookies = serializeCookies(await getAllDomainCookies());

  const result = await claimForSingleAccount(target);

  if (result.success) {
    target.lastClaim = new Date().toISOString().split('T')[0];
    const freshCookies = await getAllDomainCookies();
    if (freshCookies.length > 0) target.cookies = serializeCookies(freshCookies);
    if (result.credits) {
      const c = result.credits.credit || result.credits;
      target.cachedCredits = {
        gift: c.gift_credit || 0, purchase: c.purchase_credit || 0,
        vip: c.vip_credit || 0,
        total: (c.gift_credit || 0) + (c.purchase_credit || 0) + (c.vip_credit || 0),
      };
    }
    target.lastChecked = Date.now();
    await saveAccountsToStorage(accounts);
  }

  // 恢复原 cookie
  await clearDomainCookies();
  if (originalCookies.length > 0) await restoreCookies(originalCookies);

  return result;
}

// ======================== 消息路由 ========================

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  const handler = async () => {
    try {
      switch (msg.action) {
        case 'getAccounts':
          return await loadAccounts();
        case 'detectCurrent':
          return await detectCurrentAccount();
        case 'saveCurrentAccount':
          return await saveCurrentAccount(msg.name);
        case 'switchAccount':
          return await switchAccount(msg.accountId);
        case 'deleteAccount':
          return await deleteAccount(msg.accountId);
        case 'renameAccount':
          return await renameAccount(msg.accountId, msg.name);
        case 'claimAll':
          return await claimAllCredits();
        case 'claimOne':
          return await claimOne(msg.accountId);
        case 'checkStatus':
          return await checkAccountStatus(msg.accountId);
        case 'checkAllStatuses':
          return await checkAllStatuses();
        default:
          return { error: `未知操作: ${msg.action}` };
      }
    } catch (e) {
      console.error('[即梦切换器] 错误:', e);
      return { success: false, error: e.message };
    }
  };

  handler().then(sendResponse);
  return true; // 保持消息通道开放，等待异步响应
});
