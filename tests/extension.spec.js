const { test, expect } = require('./extension.fixture');

function popupUrl(extensionId) {
  return `chrome-extension://${extensionId}/popup/popup.html`;
}

async function openPopup(context, extensionId) {
  const popup = await context.newPage();
  await popup.goto(popupUrl(extensionId), { waitUntil: 'domcontentloaded' });
  await expect(popup.getByText('即梦账号管理')).toBeVisible();
  await expect(popup.locator('#btn-save')).toBeVisible();
  await expect(popup.locator('#input-save-name')).toBeVisible();
  return popup;
}

test.beforeEach(async ({ serviceWorker }) => {
  await serviceWorker.evaluate(async () => {
    await chrome.storage.local.clear();
  });
});

test('loads extension and renders popup controls', async ({ context, extensionId, serviceWorker }) => {
  const popup = await openPopup(context, extensionId);

  const workerState = await serviceWorker.evaluate(() => ({
    hasJimengTabSession: typeof JimengTabSession,
    hasFindReusableJimengTab: typeof findReusableJimengTab,
  }));

  expect(workerState).toEqual({
    hasJimengTabSession: 'function',
    hasFindReusableJimengTab: 'function',
  });

  await popup.close();
});

test('persists save-name draft and restores it after popup reload', async ({ context, extensionId, serviceWorker }) => {
  const popup = await openPopup(context, extensionId);

  await popup.locator('#input-save-name').fill('测试备注A');

  await expect.poll(async () => {
    return await serviceWorker.evaluate(async () => {
      const settings = (await chrome.storage.local.get('jimeng_settings')).jimeng_settings || {};
      return settings.saveDraftName || '';
    });
  }).toBe('测试备注A');

  await popup.reload({ waitUntil: 'domcontentloaded' });
  await expect(popup.locator('#input-save-name')).toHaveValue('测试备注A');
  await popup.close();
});

test('shows an explicit banner when the current web login is not yet saved into the plugin', async ({ context, extensionId, serviceWorker }) => {
  await serviceWorker.evaluate(async () => {
    await chrome.storage.local.set({
      jimeng_accounts: [
        { id: 'acc-1', name: '已保存账号A', savedAt: Date.now(), cookies: [], sessionValid: true },
      ],
    });

    globalThis.__originalDetectCurrentAccount = detectCurrentAccount;
    detectCurrentAccount = async () => null;
  });

  const popup = await openPopup(context, extensionId);
  await expect(popup.locator('#unsaved-current-banner')).toBeVisible();
  await expect(popup.locator('#unsaved-current-text')).toContainText('当前网页登录的账号还没保存到插件');
  await expect(popup.locator('#unsaved-current-text')).toContainText('当前插件内仅保存 1 个账号');

  await serviceWorker.evaluate(() => {
    detectCurrentAccount = globalThis.__originalDetectCurrentAccount;
    delete globalThis.__originalDetectCurrentAccount;
  });

  await popup.close();
});

test('save flow forwards custom name and clears stored draft', async ({ context, extensionId, serviceWorker }) => {
  await serviceWorker.evaluate(() => {
    globalThis.__originalSaveCurrentAccount = saveCurrentAccount;
    globalThis.__saveCurrentAccountCalls = [];
    saveCurrentAccount = async (name) => {
      globalThis.__saveCurrentAccountCalls.push(name);
      return {
        success: true,
        account: { name: name || '默认账号' },
        isUpdate: false,
      };
    };
  });

  const popup = await openPopup(context, extensionId);
  await popup.locator('#input-save-name').fill('测试备注A');
  await popup.locator('#btn-save').click();

  await expect(popup.locator('#toast')).toContainText('已保存: 测试备注A（当前共 1 个账号）');
  await expect(popup.locator('#input-save-name')).toHaveValue('');

  await expect.poll(async () => {
    return await serviceWorker.evaluate(async () => {
      const settings = (await chrome.storage.local.get('jimeng_settings')).jimeng_settings || {};
      return settings.saveDraftName || '';
    });
  }).toBe('');

  const saveCalls = await serviceWorker.evaluate(() => globalThis.__saveCurrentAccountCalls.slice());
  expect(saveCalls).toEqual(['测试备注A']);

  await serviceWorker.evaluate(() => {
    saveCurrentAccount = globalThis.__originalSaveCurrentAccount;
    delete globalThis.__originalSaveCurrentAccount;
    delete globalThis.__saveCurrentAccountCalls;
  });

  await popup.close();
});

test('detectCurrentAccount falls back to matching the current userId when sessionid changed after relogin', async ({ serviceWorker }) => {
  const result = await serviceWorker.evaluate(async () => {
    const originalGetAllDomainCookies = getAllDomainCookies;
    const originalFetchStatusDirectWithRetry = fetchStatusViaDirectWithRetry;

    try {
      await chrome.storage.local.set({
        jimeng_accounts: [
          {
            id: 'acc-1',
            name: '账号A',
            userId: 'user-1',
            savedAt: Date.now(),
            cookies: [
              { name: 'sessionid', value: 'old-session', domain: '.jianying.com', path: '/' },
            ],
          },
        ],
      });

      getAllDomainCookies = async () => [
        { name: 'sessionid', value: 'new-session', domain: '.jianying.com', path: '/' },
      ];
      fetchStatusViaDirectWithRetry = async () => ({
        valid: true,
        unknown: false,
        credits: null,
        vip: null,
        user: { userId: 'user-1', nickname: '账号A', avatar: '' },
      });

      return await detectCurrentAccount();
    } finally {
      getAllDomainCookies = originalGetAllDomainCookies;
      fetchStatusViaDirectWithRetry = originalFetchStatusDirectWithRetry;
    }
  });

  expect(result).toBe('acc-1');
});

test('maybeAutoSaveCurrentAccount automatically persists a newly logged-in account when enabled', async ({ serviceWorker }) => {
  const result = await serviceWorker.evaluate(async () => {
    globalThis.__originalDetectCurrentAccount = detectCurrentAccount;
    globalThis.__originalSaveCurrentAccount = saveCurrentAccount;
    globalThis.__autoSaveCalls = 0;

    try {
      detectCurrentAccount = async () => null;
      saveCurrentAccount = async () => {
        globalThis.__autoSaveCalls += 1;
        return { success: true, account: { id: 'acc-auto', name: '自动保存账号' }, isUpdate: false };
      };

      const settings = await loadSettings();
      const response = await maybeAutoSaveCurrentAccount('test-auto-save');
      return { response, settings, callCount: globalThis.__autoSaveCalls };
    } finally {
      detectCurrentAccount = globalThis.__originalDetectCurrentAccount;
      saveCurrentAccount = globalThis.__originalSaveCurrentAccount;
      delete globalThis.__originalDetectCurrentAccount;
      delete globalThis.__originalSaveCurrentAccount;
      delete globalThis.__autoSaveCalls;
    }
  });

  expect(result.settings.autoSaveOnLogin).toBe(true);
  expect(result.callCount).toBe(1);
  expect(result.response).toMatchObject({
    success: true,
    account: { id: 'acc-auto', name: '自动保存账号' },
  });
});

test('maybeAutoSaveCurrentAccount waits for the cookie lock before detecting the current account', async ({ serviceWorker }) => {
  const result = await serviceWorker.evaluate(async () => {
    globalThis.__originalDetectCurrentAccount = detectCurrentAccount;
    globalThis.__originalSaveCurrentAccount = saveCurrentAccount;
    let releaseLock;
    let detectCalls = 0;
    let saveCalls = 0;

    try {
      detectCurrentAccount = async () => {
        detectCalls += 1;
        return 'acc-existing';
      };
      saveCurrentAccount = async () => {
        saveCalls += 1;
        return { success: true, account: { id: 'acc-auto' } };
      };

      const heldLock = withCookieLock(() => new Promise(resolve => { releaseLock = resolve; }));
      await new Promise(resolve => setTimeout(resolve, 0));

      const autoSave = maybeAutoSaveCurrentAccount('test-lock-gating');
      await new Promise(resolve => setTimeout(resolve, 50));
      const callsWhileLocked = detectCalls;

      releaseLock();
      await heldLock;
      const response = await autoSave;

      return { callsWhileLocked, detectCalls, saveCalls, response };
    } finally {
      detectCurrentAccount = globalThis.__originalDetectCurrentAccount;
      saveCurrentAccount = globalThis.__originalSaveCurrentAccount;
      delete globalThis.__originalDetectCurrentAccount;
      delete globalThis.__originalSaveCurrentAccount;
    }
  });

  expect(result.callsWhileLocked).toBe(0);
  expect(result.detectCalls).toBe(1);
  expect(result.saveCalls).toBe(0);
  expect(result.response).toEqual({ skipped: true, reason: 'already-saved', accountId: 'acc-existing' });
});

test('maybeAutoSaveCurrentAccount respects the auto-save setting when users disable it', async ({ serviceWorker }) => {
  const result = await serviceWorker.evaluate(async () => {
    globalThis.__originalDetectCurrentAccount = detectCurrentAccount;
    globalThis.__originalSaveCurrentAccount = saveCurrentAccount;
    globalThis.__autoSaveCalls = 0;

    try {
      await saveSettings({ autoSaveOnLogin: false });
      detectCurrentAccount = async () => null;
      saveCurrentAccount = async () => {
        globalThis.__autoSaveCalls += 1;
        return { success: true, account: { id: 'acc-auto', name: '自动保存账号' }, isUpdate: false };
      };

      const settings = await loadSettings();
      const response = await maybeAutoSaveCurrentAccount('test-disabled');
      return { response, settings, callCount: globalThis.__autoSaveCalls };
    } finally {
      detectCurrentAccount = globalThis.__originalDetectCurrentAccount;
      saveCurrentAccount = globalThis.__originalSaveCurrentAccount;
      delete globalThis.__originalDetectCurrentAccount;
      delete globalThis.__originalSaveCurrentAccount;
      delete globalThis.__autoSaveCalls;
    }
  });

  expect(result.settings.autoSaveOnLogin).toBe(false);
  expect(result.callCount).toBe(0);
  expect(result.response).toEqual({ skipped: true, reason: 'disabled' });
});

test('saveAccountsToStorage keeps a verifiable multi-account snapshot with backup and journal', async ({ serviceWorker }) => {
  const result = await serviceWorker.evaluate(async () => {
    const accounts = [
      { id: 'acc-1', name: '账号A', userId: 'user-1', cookies: [{ name: 'sessionid', value: 'sid-a' }], sessionValid: true },
      { id: 'acc-2', name: '账号B', userId: 'user-2', cookies: [{ name: 'sessionid', value: 'sid-b' }], sessionValid: true },
    ];
    await saveAccountsToStorage(accounts, 'test-multi-save');
    const stored = await chrome.storage.local.get(['jimeng_accounts', 'jimeng_accounts_backup', 'jimeng_accounts_journal']);
    return {
      primaryCount: stored.jimeng_accounts?.length || 0,
      backupCount: stored.jimeng_accounts_backup?.length || 0,
      journalCount: stored.jimeng_accounts_journal?.length || 0,
      lastReason: stored.jimeng_accounts_journal?.at(-1)?.reason || null,
    };
  });

  expect(result).toEqual({
    primaryCount: 2,
    backupCount: 2,
    journalCount: 1,
    lastReason: 'test-multi-save',
  });
});

test('loadAccounts automatically merges duplicate cards for the same real user', async ({ serviceWorker }) => {
  const result = await serviceWorker.evaluate(async () => {
    const now = Date.now();
    await chrome.storage.local.set({
      jimeng_accounts: [
        {
          id: 'dup-old',
          name: '用户1000000000001',
          userId: '1000000000000001',
          nickname: '用户1000000000001',
          cookies: [{ name: 'sessionid', value: 'sid-old', domain: '.jianying.com', path: '/' }],
          cachedCredits: { total: 10 },
          sessionValid: true,
          savedAt: now - 5000,
          lastChecked: now - 5000,
        },
        {
          id: 'other',
          name: '用户1000000000002',
          userId: '1000000000000002',
          nickname: '用户1000000000002',
          cookies: [{ name: 'sessionid', value: 'sid-other', domain: '.jianying.com', path: '/' }],
          cachedCredits: { total: 20 },
          sessionValid: true,
          savedAt: now - 4000,
          lastChecked: now - 4000,
        },
        {
          id: 'dup-custom',
          name: '测试会员账号A',
          userId: '1000000000000001',
          nickname: '用户1000000000001',
          cookies: [{ name: 'sessionid', value: 'sid-mid', domain: '.jianying.com', path: '/' }],
          cachedCredits: { total: 30 },
          sessionValid: true,
          savedAt: now - 3000,
          lastChecked: now - 3000,
        },
        {
          id: 'dup-new',
          name: '用户1000000000001',
          userId: '1000000000000001',
          nickname: '用户1000000000001',
          cookies: [
            { name: 'sessionid', value: 'sid-new', domain: '.jianying.com', path: '/' },
            { name: 'sid_tt', value: 'sid-new', domain: '.jianying.com', path: '/' },
          ],
          cachedCredits: { total: 12345 },
          sessionValid: true,
          savedAt: now - 1000,
          lastChecked: now - 1000,
        },
      ],
    });

    const loaded = await loadAccounts();
    const stored = (await chrome.storage.local.get(['jimeng_accounts', 'jimeng_accounts_journal'])).jimeng_accounts;
    const journal = (await chrome.storage.local.get('jimeng_accounts_journal')).jimeng_accounts_journal || [];
    const merged = loaded.find(a => a.userId === '1000000000000001');
    return {
      loadedCount: loaded.length,
      storedCount: stored.length,
      userIds: loaded.map(a => a.userId).sort(),
      mergedName: merged?.name,
      mergedId: merged?.id,
      mergedSession: merged?.cookies?.find(c => c.name === 'sessionid')?.value,
      mergedCredits: merged?.cachedCredits,
      lastReason: journal.at(-1)?.reason,
    };
  });

  expect(result).toEqual({
    loadedCount: 2,
    storedCount: 2,
    userIds: ['1000000000000001', '1000000000000002'],
    mergedName: '测试会员账号A',
    mergedId: 'dup-custom',
    mergedSession: 'sid-new',
    mergedCredits: { total: 12345 },
    lastReason: 'normalize-accounts',
  });
});

test('loadAccounts recovers from backup when the primary account key is missing', async ({ serviceWorker }) => {
  const result = await serviceWorker.evaluate(async () => {
    const backup = [
      { id: 'acc-1', name: '账号A', userId: 'user-1', cookies: [{ name: 'sessionid', value: 'sid-a' }] },
      { id: 'acc-2', name: '账号B', userId: 'user-2', cookies: [{ name: 'sessionid', value: 'sid-b' }] },
    ];
    await chrome.storage.local.set({
      jimeng_accounts: null,
      jimeng_accounts_backup: backup,
    });
    const recovered = await loadAccounts();
    const primary = (await chrome.storage.local.get('jimeng_accounts')).jimeng_accounts;
    return { recoveredCount: recovered.length, primaryCount: primary.length };
  });

  expect(result).toEqual({ recoveredCount: 2, primaryCount: 2 });
});

test('saveCurrentAccount keeps previously saved accounts when different users are saved sequentially', async ({ serviceWorker }) => {
  const result = await serviceWorker.evaluate(async () => {
    const originalGetAllDomainCookies = getAllDomainCookies;
    const originalGetStableDomainCookies = getStableDomainCookies;
    const originalFetchStatusWithRetry = fetchStatusViaSessionWithRetry;
    const originalEnsure = JimengTabSession.prototype.ensure;
    const originalCleanup = JimengTabSession.prototype.cleanup;
    const statuses = [
      { valid: true, unknown: false, credits: { total: 11 }, vip: { isVip: false, vipType: '', expireTime: 0 }, user: { userId: 'user-1', nickname: '账号A', avatar: '' } },
      { valid: true, unknown: false, credits: { total: 22 }, vip: { isVip: true, vipType: '高级会员', expireTime: 0 }, user: { userId: 'user-2', nickname: '账号B', avatar: '' } },
    ];
    const cookieSets = [
      [{ name: 'sessionid', value: 'sid-a', domain: '.jianying.com', path: '/', secure: false, httpOnly: true, hostOnly: false }],
      [{ name: 'sessionid', value: 'sid-b', domain: '.jianying.com', path: '/', secure: false, httpOnly: true, hostOnly: false }],
    ];
    let idx = 0;

    try {
      getAllDomainCookies = async () => cookieSets[idx];
      getStableDomainCookies = async () => cookieSets[Math.max(0, idx - 1)];
      fetchStatusViaSessionWithRetry = async () => statuses[idx++];
      JimengTabSession.prototype.ensure = async function ensure() { this.tabId = 1; };
      JimengTabSession.prototype.cleanup = async () => {};

      await saveCurrentAccount('账号A');
      await saveCurrentAccount('账号B');
      return await loadAccounts();
    } finally {
      getAllDomainCookies = originalGetAllDomainCookies;
      getStableDomainCookies = originalGetStableDomainCookies;
      fetchStatusViaSessionWithRetry = originalFetchStatusWithRetry;
      JimengTabSession.prototype.ensure = originalEnsure;
      JimengTabSession.prototype.cleanup = originalCleanup;
    }
  });

  expect(result).toHaveLength(2);
  expect(result.map(account => account.userId)).toEqual(['user-1', 'user-2']);
});
test('saveCurrentAccount warns when two different accounts share the same browser device identity', async ({ serviceWorker }) => {
  const result = await serviceWorker.evaluate(async () => {
    const originalGetAllDomainCookies = getAllDomainCookies;
    const originalGetStableDomainCookies = getStableDomainCookies;
    const originalFetchStatusWithRetry = fetchStatusViaSessionWithRetry;
    const originalEnsure = JimengTabSession.prototype.ensure;
    const originalCleanup = JimengTabSession.prototype.cleanup;
    const deviceCookies = [
      { name: 's_v_web_id', value: 'same-device', domain: 'jimeng.jianying.com', path: '/', secure: false, httpOnly: false, hostOnly: true },
      { name: 'passport_csrf_token', value: 'same-csrf', domain: '.jianying.com', path: '/', secure: true, httpOnly: false, hostOnly: false, sameSite: 'no_restriction' },
      { name: 'fpk1', value: 'same-fpk', domain: 'jimeng.jianying.com', path: '/', secure: false, httpOnly: false, hostOnly: true },
      { name: '_tea_web_id', value: 'same-tea', domain: 'jimeng.jianying.com', path: '/', secure: false, httpOnly: false, hostOnly: true },
    ];
    const statuses = [
      { valid: true, unknown: false, credits: { total: 10 }, vip: null, user: { userId: 'user-a', nickname: '账号A', avatar: '' } },
      { valid: true, unknown: false, credits: { total: 20 }, vip: null, user: { userId: 'user-b', nickname: '账号B', avatar: '' } },
    ];
    const cookieSets = [
      [{ name: 'sessionid', value: 'sid-a', domain: '.jianying.com', path: '/', secure: false, httpOnly: true, hostOnly: false }, ...deviceCookies],
      [{ name: 'sessionid', value: 'sid-b', domain: '.jianying.com', path: '/', secure: false, httpOnly: true, hostOnly: false }, ...deviceCookies],
    ];
    let idx = 0;
    try {
      getAllDomainCookies = async () => cookieSets[idx];
      getStableDomainCookies = async () => cookieSets[Math.max(0, idx - 1)];
      fetchStatusViaSessionWithRetry = async () => statuses[idx++];
      JimengTabSession.prototype.ensure = async function ensure() { this.tabId = 1; };
      JimengTabSession.prototype.cleanup = async () => {};
      const first = await saveCurrentAccount('账号A');
      const second = await saveCurrentAccount('账号B');
      return { first, second };
    } finally {
      getAllDomainCookies = originalGetAllDomainCookies;
      getStableDomainCookies = originalGetStableDomainCookies;
      fetchStatusViaSessionWithRetry = originalFetchStatusWithRetry;
      JimengTabSession.prototype.ensure = originalEnsure;
      JimengTabSession.prototype.cleanup = originalCleanup;
    }
  });

  expect(result.first.success).toBe(true);
  expect(result.first.deviceIdentityCollisions).toEqual([]);
  expect(result.second.success).toBe(true);
  expect(result.second.deviceIdentityCollisions).toEqual([
    expect.objectContaining({ name: '账号A', userId: 'user-a' }),
  ]);
});

test('saveCurrentAccount rejects invalid session instead of storing a broken account', async ({ serviceWorker }) => {
  const result = await serviceWorker.evaluate(async () => {
    const originalGetAllDomainCookies = getAllDomainCookies;
    const originalFetchStatusWithRetry = fetchStatusViaSessionWithRetry;
    const originalEnsure = JimengTabSession.prototype.ensure;
    const originalCleanup = JimengTabSession.prototype.cleanup;

    try {
      getAllDomainCookies = async () => [
        { name: 'sessionid', value: 'bad-session', domain: '.jianying.com', path: '/', secure: false, httpOnly: true, hostOnly: false },
      ];
      fetchStatusViaSessionWithRetry = async () => ({
        valid: false,
        unknown: false,
        credits: null,
        vip: null,
        user: { userId: '', nickname: 'account_info_error', avatar: '' },
      });
      JimengTabSession.prototype.ensure = async function ensure() { this.tabId = 1; };
      JimengTabSession.prototype.cleanup = async () => {};

      const response = await saveCurrentAccount('坏账号');
      const accounts = (await chrome.storage.local.get('jimeng_accounts')).jimeng_accounts || [];
      return { response, accounts };
    } finally {
      getAllDomainCookies = originalGetAllDomainCookies;
      fetchStatusViaSessionWithRetry = originalFetchStatusWithRetry;
      JimengTabSession.prototype.ensure = originalEnsure;
      JimengTabSession.prototype.cleanup = originalCleanup;
    }
  });

  expect(result.response).toMatchObject({
    success: false,
    error: '当前登录态无效，本次未保存账号。请确认即梦页面已登录后重试。',
  });
  expect(result.accounts).toEqual([]);
});

test('auto save invalid logged-out state isolates the login page even when old session cookies remain', async ({ serviceWorker }) => {
  const result = await serviceWorker.evaluate(async () => {
    const originalGetAllDomainCookies = getAllDomainCookies;
    const originalFetchStatusWithRetry = fetchStatusViaSessionWithRetry;
    const originalFindReusableJimengTab = findReusableJimengTab;
    const originalEnsure = JimengTabSession.prototype.ensure;
    const originalCleanup = JimengTabSession.prototype.cleanup;
    const originalClearDomainCookies = clearDomainCookies;
    const originalClearIsolationState = clearJimengLoginIsolationState;
    const originalReload = chrome.tabs.reload;
    const originalGet = chrome.tabs.get;

    const calls = {
      clearCookies: 0,
      clearState: [],
      reload: [],
    };

    try {
      getAllDomainCookies = async () => [
        { name: 'sessionid', value: 'old-sid', domain: '.jianying.com', path: '/', secure: true, httpOnly: true, hostOnly: false },
        { name: 's_v_web_id', value: 'old-device', domain: 'jimeng.jianying.com', path: '/', secure: false, httpOnly: false, hostOnly: true },
      ];
      fetchStatusViaSessionWithRetry = async () => ({ valid: false, unknown: false, credits: null, vip: null, user: null });
      findReusableJimengTab = async () => ({ id: 44, status: 'complete', active: true, url: 'https://jimeng.jianying.com/ai-tool/home' });
      JimengTabSession.prototype.ensure = async function ensure() { this.tabId = 44; this.isInternal = false; };
      JimengTabSession.prototype.cleanup = async () => {};
      chrome.tabs.get = async (tabId) => ({ id: tabId, status: 'complete', url: 'https://jimeng.jianying.com/ai-tool/home' });
      clearDomainCookies = async () => { calls.clearCookies += 1; };
      clearJimengLoginIsolationState = async (tabId) => {
        calls.clearState.push(tabId);
        return { localStorageRemoved: 2, sessionStorageRemoved: 1, indexedDbDeleted: [], cacheDeleted: [], errors: [] };
      };
      chrome.tabs.reload = async (tabId, opts) => { calls.reload.push({ tabId, opts }); };

      const response = await saveCurrentAccount(undefined, null, { source: 'auto:tab-updated', allowCreateTab: false });
      const accounts = (await chrome.storage.local.get('jimeng_accounts')).jimeng_accounts || [];
      const settings = await loadSettings();
      return { response, accounts, settings, calls };
    } finally {
      getAllDomainCookies = originalGetAllDomainCookies;
      fetchStatusViaSessionWithRetry = originalFetchStatusWithRetry;
      findReusableJimengTab = originalFindReusableJimengTab;
      JimengTabSession.prototype.ensure = originalEnsure;
      JimengTabSession.prototype.cleanup = originalCleanup;
      clearDomainCookies = originalClearDomainCookies;
      clearJimengLoginIsolationState = originalClearIsolationState;
      chrome.tabs.reload = originalReload;
      chrome.tabs.get = originalGet;
    }
  });

  expect(result.response.success).toBe(false);
  expect(result.response.loginIsolation).toMatchObject({ success: true, tabId: 44, force: true });
  expect(result.accounts).toEqual([]);
  expect(result.calls.clearCookies).toBe(1);
  expect(result.calls.clearState).toEqual([44]);
  expect(result.calls.reload).toEqual([{ tabId: 44, opts: { bypassCache: true } }]);
  expect(result.settings.lastLoginIsolationReason).toBe('auto-save-invalid-status');
});

test('saveCurrentAccount rejects unknown transport status instead of persisting uncertain cookies', async ({ serviceWorker }) => {
  const result = await serviceWorker.evaluate(async () => {
    const originalGetAllDomainCookies = getAllDomainCookies;
    const originalFetchStatusWithRetry = fetchStatusViaSessionWithRetry;
    const originalEnsure = JimengTabSession.prototype.ensure;
    const originalCleanup = JimengTabSession.prototype.cleanup;

    try {
      getAllDomainCookies = async () => [
        { name: 'sessionid', value: 'maybe-session', domain: '.jianying.com', path: '/', secure: false, httpOnly: true, hostOnly: false },
      ];
      fetchStatusViaSessionWithRetry = async () => ({
        valid: false,
        unknown: true,
        credits: null,
        vip: null,
        user: null,
        creditsUnknown: true,
        vipUnknown: true,
      });
      JimengTabSession.prototype.ensure = async function ensure() { this.tabId = 1; };
      JimengTabSession.prototype.cleanup = async () => {};

      const response = await saveCurrentAccount('不确定账号');
      const accounts = (await chrome.storage.local.get('jimeng_accounts')).jimeng_accounts || [];
      return { response, accounts };
    } finally {
      getAllDomainCookies = originalGetAllDomainCookies;
      fetchStatusViaSessionWithRetry = originalFetchStatusWithRetry;
      JimengTabSession.prototype.ensure = originalEnsure;
      JimengTabSession.prototype.cleanup = originalCleanup;
    }
  });

  expect(result.response).toEqual({
    success: false,
    error: '当前账号状态校验失败（网络或页面响应异常），本次未保存。请稍后重试。',
  });
  expect(result.accounts).toEqual([]);
});

test('saveCurrentAccount persists fetched user, credits and vip info for a valid session', async ({ serviceWorker }) => {
  const result = await serviceWorker.evaluate(async () => {
    const originalGetAllDomainCookies = getAllDomainCookies;
    const originalFetchStatusWithRetry = fetchStatusViaSessionWithRetry;
    const originalEnsure = JimengTabSession.prototype.ensure;
    const originalCleanup = JimengTabSession.prototype.cleanup;

    try {
      getAllDomainCookies = async () => [
        { name: 'sessionid', value: 'good-session', domain: '.jianying.com', path: '/', secure: false, httpOnly: true, hostOnly: false },
        { name: 'sid_tt', value: 'good-session', domain: '.jianying.com', path: '/', secure: false, httpOnly: true, hostOnly: false },
      ];
      fetchStatusViaSessionWithRetry = async () => ({
        valid: true,
        unknown: false,
        credits: { total: 123, gift: 100, purchase: 20, vip: 3 },
        vip: { isVip: true, vipType: 'Pro', expireTime: 1234567890 },
        user: { userId: 'user-1', nickname: '昵称A', avatar: 'https://example.com/a.png' },
      });
      JimengTabSession.prototype.ensure = async function ensure() { this.tabId = 1; };
      JimengTabSession.prototype.cleanup = async () => {};

      const response = await saveCurrentAccount('测试账号A');
      const accounts = (await chrome.storage.local.get('jimeng_accounts')).jimeng_accounts || [];
      return { response, accounts };
    } finally {
      getAllDomainCookies = originalGetAllDomainCookies;
      fetchStatusViaSessionWithRetry = originalFetchStatusWithRetry;
      JimengTabSession.prototype.ensure = originalEnsure;
      JimengTabSession.prototype.cleanup = originalCleanup;
    }
  });

  expect(result.response.success).toBe(true);
  expect(result.response.account).toMatchObject({
    name: '测试账号A',
    userId: 'user-1',
    nickname: '昵称A',
    sessionValid: true,
    cachedCredits: { total: 123, gift: 100, purchase: 20, vip: 3 },
    cachedVip: { isVip: true, vipType: 'Pro', expireTime: 1234567890 },
  });
  expect(result.accounts).toHaveLength(1);
  expect(result.accounts[0]).toMatchObject({
    name: '测试账号A',
    userId: 'user-1',
    nickname: '昵称A',
    sessionValid: true,
    cachedCredits: { total: 123, gift: 100, purchase: 20, vip: 3 },
    cachedVip: { isVip: true, vipType: 'Pro', expireTime: 1234567890 },
  });
});

test('saveCurrentAccount can overwrite a chosen saved account in repair mode', async ({ serviceWorker }) => {
  const result = await serviceWorker.evaluate(async () => {
    const originalGetAllDomainCookies = getAllDomainCookies;
    const originalFetchStatusWithRetry = fetchStatusViaSessionWithRetry;
    const originalEnsure = JimengTabSession.prototype.ensure;
    const originalCleanup = JimengTabSession.prototype.cleanup;

    try {
      await chrome.storage.local.set({
        jimeng_accounts: [
          {
            id: 'repair-1',
            name: '旧账号A',
            userId: 'old-user',
            nickname: '旧昵称',
            cookies: [{ name: 'sessionid', value: 'old', domain: '.jianying.com', path: '/' }],
            savedAt: Date.now() - 1000,
            sessionValid: false,
          },
        ],
      });

      getAllDomainCookies = async () => [
        { name: 'sessionid', value: 'new-session', domain: '.jianying.com', path: '/', secure: false, httpOnly: true, hostOnly: false },
      ];
      fetchStatusViaSessionWithRetry = async () => ({
        valid: true,
        unknown: false,
        credits: { total: 50, gift: 50, purchase: 0, vip: 0 },
        vip: { isVip: false, vipType: '', expireTime: 0 },
        user: { userId: 'new-user', nickname: '新昵称', avatar: '' },
      });
      JimengTabSession.prototype.ensure = async function ensure() { this.tabId = 1; };
      JimengTabSession.prototype.cleanup = async () => {};

      const response = await saveCurrentAccount('', 'repair-1');
      const accounts = (await chrome.storage.local.get('jimeng_accounts')).jimeng_accounts || [];
      return { response, accounts };
    } finally {
      getAllDomainCookies = originalGetAllDomainCookies;
      fetchStatusViaSessionWithRetry = originalFetchStatusWithRetry;
      JimengTabSession.prototype.ensure = originalEnsure;
      JimengTabSession.prototype.cleanup = originalCleanup;
    }
  });

  expect(result.response.success).toBe(true);
  expect(result.response.isUpdate).toBe(true);
  expect(result.response.account).toMatchObject({
    id: 'repair-1',
    name: '新昵称',
    userId: 'new-user',
    nickname: '新昵称',
    sessionValid: true,
  });
  expect(result.accounts).toHaveLength(1);
  expect(result.accounts[0]).toMatchObject({
    id: 'repair-1',
    name: '新昵称',
    userId: 'new-user',
    nickname: '新昵称',
    sessionValid: true,
  });
});

test('saveCurrentAccount refuses to repair an account with another saved account identity', async ({ serviceWorker }) => {
  const result = await serviceWorker.evaluate(async () => {
    const originalGetAllDomainCookies = getAllDomainCookies;
    const originalFetchStatusWithRetry = fetchStatusViaSessionWithRetry;
    const originalEnsure = JimengTabSession.prototype.ensure;
    const originalCleanup = JimengTabSession.prototype.cleanup;

    try {
      await chrome.storage.local.set({
        jimeng_accounts: [
          {
            id: 'repair-target',
            name: '要修复的B',
            userId: 'user-b',
            cookies: [{ name: 'sessionid', value: 'old-b', domain: '.jianying.com', path: '/' }],
            savedAt: Date.now() - 1000,
            sessionValid: false,
          },
          {
            id: 'already-a',
            name: '已经保存的A',
            userId: 'user-a',
            cookies: [{ name: 'sessionid', value: 'old-a', domain: '.jianying.com', path: '/' }],
            savedAt: Date.now() - 1000,
            sessionValid: true,
          },
        ],
      });

      getAllDomainCookies = async () => [
        { name: 'sessionid', value: 'new-a-session', domain: '.jianying.com', path: '/', secure: false, httpOnly: true, hostOnly: false },
      ];
      fetchStatusViaSessionWithRetry = async () => ({
        valid: true,
        unknown: false,
        credits: { total: 100, gift: 100, purchase: 0, vip: 0 },
        vip: { isVip: true, vipType: '高级会员', expireTime: 0 },
        user: { userId: 'user-a', nickname: '已经保存的A', avatar: '' },
      });
      JimengTabSession.prototype.ensure = async function ensure() { this.tabId = 1; };
      JimengTabSession.prototype.cleanup = async () => {};

      const response = await saveCurrentAccount('', 'repair-target');
      const accounts = (await chrome.storage.local.get('jimeng_accounts')).jimeng_accounts || [];
      return { response, accounts };
    } finally {
      getAllDomainCookies = originalGetAllDomainCookies;
      fetchStatusViaSessionWithRetry = originalFetchStatusWithRetry;
      JimengTabSession.prototype.ensure = originalEnsure;
      JimengTabSession.prototype.cleanup = originalCleanup;
    }
  });

  expect(result.response.success).toBe(false);
  expect(result.response.error).toContain('不是目标账号');
  expect(result.accounts.find(a => a.id === 'repair-target')).toMatchObject({
    userId: 'user-b',
    cookies: [{ value: 'old-b' }],
    sessionValid: false,
  });
});



test('tryRecoverPendingRestore clears stale pending without restoring cookies', async ({ serviceWorker }) => {
  const result = await serviceWorker.evaluate(async () => {
    const originalClearDomainCookies = clearDomainCookies;
    const originalRestoreCookies = restoreCookies;
    let restoreCalled = false;
    let clearCalled = false;
    try {
      recoveryPromise = null;
      clearDomainCookies = async () => { clearCalled = true; };
      restoreCookies = async () => { restoreCalled = true; return { success: true, failures: [], authFailed: false }; };
      await chrome.storage.local.set({
        __pending_cookie_restore: {
          cookies: [{ name: 'sessionid', value: 'old', domain: '.jianying.com', path: '/' }],
          stage: 'armed',
          ts: Date.now() - 10 * 60 * 1000,
          attempts: 0,
        },
      });
      await tryRecoverPendingRestore();
      const pending = (await chrome.storage.local.get('__pending_cookie_restore')).__pending_cookie_restore || null;
      return { restoreCalled, clearCalled, pending };
    } finally {
      clearDomainCookies = originalClearDomainCookies;
      restoreCookies = originalRestoreCookies;
      recoveryPromise = null;
      await chrome.storage.local.remove('__pending_cookie_restore');
    }
  });

  expect(result.restoreCalled).toBe(false);
  expect(result.clearCalled).toBe(false);
  expect(result.pending).toBeNull();
});

test('isStalePendingRestore clears only stale pending restore records', async ({ serviceWorker }) => {
  const result = await serviceWorker.evaluate(() => ({
    fresh: isStalePendingRestore({ cookies: [{ name: 'sessionid', value: 'x' }], ts: Date.now(), stage: 'armed' }),
    stale: isStalePendingRestore({ cookies: [{ name: 'sessionid', value: 'x' }], ts: Date.now() - 10 * 60 * 1000, stage: 'armed' }),
    empty: isStalePendingRestore({ cookies: [], ts: Date.now() - 10 * 60 * 1000, stage: 'armed' }),
  }));
  expect(result).toEqual({ fresh: false, stale: true, empty: false });
});

test('extractCreditsObj parses commerce response payload string', async ({ serviceWorker }) => {
  const result = await serviceWorker.evaluate(() => extractCreditsObj({
    data: {
      ret: '0',
      errmsg: 'success',
      response: JSON.stringify({
        credit: {
          gift_credit: 88,
          purchase_credit: 0,
          vip_credit: 27,
        },
      }),
    },
  }));

  expect(result).toMatchObject({
    gift: 88,
    purchase: 0,
    vip: 27,
    total: 115,
    detailTotal: 115,
  });
});

test('fetchStatusViaSession falls back to displayed credits and vip when commerce APIs are unusable', async ({ serviceWorker }) => {
  const result = await serviceWorker.evaluate(async () => {
    const originalFetch = JimengTabSession.prototype.fetch;
    const originalReadDisplayedAccountStatus = readDisplayedAccountStatus;
    const originalReadAppServiceDetailedStatus = readAppServiceDetailedStatus;

    try {
      JimengTabSession.prototype.fetch = async function fetch(path) {
        if (path === API_PATH.userInfo) {
          return {
            status: 200,
            data: {
              data: {
                user_id: 'user-1',
                name: '昵称A',
                avatar_url: 'https://example.com/a.png',
              },
            },
          };
        }
        if (path === API_PATH.userCredit) {
          return {
            status: 200,
            data: { ret: '1014', errmsg: 'system busy' },
          };
        }
        if (path === API_PATH.subscription) {
          return {
            status: 200,
            data: { ret: '34010105', errmsg: 'login error', data: { is_vip: false } },
          };
        }
        return { status: 404, data: null };
      };
      readDisplayedAccountStatus = async () => ({
        credits: { total: 115, gift: 88, purchase: 0, vip: 27 },
        vip: { isVip: true, vipType: '高级会员', expireTime: 0 },
      });
      readAppServiceDetailedStatus = async () => ({ credits: null, vip: null });

      const session = new JimengTabSession();
      session.tabId = 1;
      return await fetchStatusViaSession(session);
    } finally {
      JimengTabSession.prototype.fetch = originalFetch;
      readDisplayedAccountStatus = originalReadDisplayedAccountStatus;
      readAppServiceDetailedStatus = originalReadAppServiceDetailedStatus;
    }
  });

  expect(result).toMatchObject({
    valid: true,
    user: {
      userId: 'user-1',
      nickname: '昵称A',
    },
    credits: { total: 115, gift: 88, purchase: 0, vip: 27 },
    vip: { isVip: true, vipType: '高级会员', expireTime: 0 },
  });
});

test('parseCompactDisplayedNumber parses compact Chinese credit units like 1.4万', async ({ serviceWorker }) => {
  const result = await serviceWorker.evaluate(() => ([
    parseCompactDisplayedNumber('1.4万'),
    parseCompactDisplayedNumber('2.3k'),
    parseCompactDisplayedNumber('8,888'),
    parseCompactDisplayedNumber('12'),
  ]));

  expect(result).toEqual([14000, 2300, 8888, 12]);
});


test('parseAppServiceSnapshot extracts exact app service credits, expiry and history', async ({ serviceWorker }) => {
  const result = await serviceWorker.evaluate(() => parseAppServiceSnapshot({
    available: true,
    localCredit: 12080,
    creditInfo: { vipCredit: 12000, giftCredit: 80, purchaseCredit: 0 },
    creditsDetail: {
      vipCredits: [{ vipLevel: 'maestro', residualCredits: 12000, creditsLifeEnd: 1779660572 }],
      giftCredits: [{ residualCredits: 80, creditsLifeEnd: 1777219199 }],
    },
    expiringCreditInfoList: [{ creditAmount: 80, expireTime: 1777219199 }],
    creditHistoryList: [
      { title: '每日免费积分', amount: 80, createTime: 1777179933, tradeSource: 'FREEMIUM_RECEIVE', historyType: 1 },
      { title: '订阅积分', amount: 12000, createTime: 1777068572, tradeSource: 'VIP_GIFT', historyType: 1 },
      { title: '订阅积分到期清零', amount: 27, createTime: 1777068572, tradeSource: 'VIP_GIFT', historyType: 2 },
    ],
    currentVipLevel: 'maestro',
    isVip: true,
    isVipReady: true,
    vipInfo: {
      flag: true,
      curVipLevel: 'maestro',
      subscribeType: 'auto',
      subscribeCycle: 12,
      cycleUnit: 'MONTH',
      endTime: 1805913553,
      nextRenewalTime: 1805827153,
    },
  }));

  expect(result.credits).toMatchObject({
    total: 12080,
    detailTotal: 12080,
    gift: 80,
    purchase: 0,
    vip: 12000,
    monthlyQuota: 15000,
    monthlyQuotaText: '15,000积分/月',
    dailyFreeAmount: 80,
    lastDailyFreeAt: 1777179933,
    lastSubscriptionCreditAt: 1777068572,
    nextSubscriptionCreditAt: 1779660572,
  });
  expect(result.credits.nextDailyFreeAt).toBe(1777219199);
  expect(result.vip).toMatchObject({
    isVip: true,
    vipType: '高级会员',
    billingCycle: '连续包年',
    expireTime: 1805913553,
    nextRenewalTime: 1805827153,
    monthlyQuota: 15000,
    source: 'app-service',
  });
});

test('parseMemberPanelSnapshot extracts exact credits, membership expiry and refresh hints', async ({ serviceWorker }) => {
  const result = await serviceWorker.evaluate(() => parseMemberPanelSnapshot({
    modalText: `用户1000000000002
高级会员
连续包年
2027.03.24 02:39
积分详情
12080
购买积分
订阅管理
会员兑换
订阅计划
连续包年
高级会员
12,000积分每月`,
    historyPayload: {
      data: {
        credits_history_list: [
          { title: '每日免费积分', amount: 80, create_time: 1777179933, trade_source: 'FREEMIUM_RECEIVE' },
          { title: '订阅积分', amount: 12000, create_time: 1777068572, trade_source: 'VIP_GIFT' },
          { title: '积分到期清零', amount: 88, create_time: 1776959999, trade_source: 'FREEMIUM_RECEIVE' },
        ],
        total_credit: 12080,
      },
    },
  }));

  expect(result.credits).toMatchObject({
    total: 12080,
    detailTotal: 12080,
    monthlyQuota: 12000,
    monthlyQuotaText: '12,000积分/月',
    dailyFreeAmount: 80,
    lastDailyFreeAt: 1777179933,
    lastSubscriptionCreditAt: 1777068572,
    nextSubscriptionCreditAt: expect.any(Number),
    lastCreditClearAt: 1776959999,
  });
  expect(result.credits.nextDailyFreeAt).toBeGreaterThan(0);
  expect(result.vip).toMatchObject({
    isVip: true,
    vipType: '高级会员',
    billingCycle: '连续包年',
    expireText: '2027.03.24 02:39',
    monthlyQuota: 12000,
  });
  expect(result.vip.expireTime).toBeGreaterThan(0);
});

test('popup switch button dispatches target account without opening settings hacks', async ({ context, extensionId, serviceWorker }) => {
  await serviceWorker.evaluate(async () => {
    await chrome.storage.local.set({
      jimeng_accounts: [
        { id: 'acc-1', name: '账号A', savedAt: Date.now(), cookies: [] },
        { id: 'acc-2', name: '账号B', savedAt: Date.now(), cookies: [] },
      ],
      jimeng_settings: { repairAccountId: 'acc-2', autoSaveOnLogin: true, saveDraftName: '' },
    });

    globalThis.__originalDetectCurrentAccount = detectCurrentAccount;
    globalThis.__originalSwitchAccount = switchAccount;
    globalThis.__switchAccountCalls = [];

    detectCurrentAccount = async () => 'acc-1';
    switchAccount = async (accountId) => {
      globalThis.__switchAccountCalls.push(accountId);
      return {
        success: true,
        account: { id: accountId, name: '账号B' },
      };
    };
  });

  const popup = await openPopup(context, extensionId);
  await expect(popup.locator('.account-name', { hasText: '账号A' })).toBeVisible();
  await expect(popup.locator('.account-name', { hasText: '账号B' })).toBeVisible();

  await popup.locator('[data-action="switch"][data-id="acc-2"]').click();

  await expect(popup.locator('#toast')).toContainText('已切换到 账号B');

  const switchCalls = await serviceWorker.evaluate(() => globalThis.__switchAccountCalls.slice());
  expect(switchCalls).toEqual(['acc-2']);
  const settingsAfterSwitch = await serviceWorker.evaluate(async () => await loadSettings());
  expect(settingsAfterSwitch.repairAccountId).toBeNull();

  await serviceWorker.evaluate(() => {
    detectCurrentAccount = globalThis.__originalDetectCurrentAccount;
    switchAccount = globalThis.__originalSwitchAccount;
    delete globalThis.__originalDetectCurrentAccount;
    delete globalThis.__originalSwitchAccount;
    delete globalThis.__switchAccountCalls;
  });

  await popup.close();
});

test('switchAccount rejects identity-mismatched saved cookies instead of rewriting the account card', async ({ serviceWorker }) => {
  const result = await serviceWorker.evaluate(async () => {
    const originalGetAllDomainCookies = getAllDomainCookies;
    const originalClearDomainCookies = clearDomainCookies;
    const originalRestoreCookies = restoreCookies;
    const originalCookiesGet = chrome.cookies.get;
    const originalFindReusableJimengTab = findReusableJimengTab;
    const originalFetchStatusDirectWithRetry = fetchStatusViaDirectWithRetry;
    const originalReloadTabs = reloadJimengTabsForSwitch;
    const reloadNames = [];

    try {
      await chrome.storage.local.set({
        jimeng_accounts: [{
          id: 'dirty-1',
          name: '用户1000000000002',
          userId: '1000000000000002',
          nickname: '用户1000000000002',
          avatar: '',
          cookies: [{ name: 'sessionid', value: 'sid-a', domain: '.jianying.com', path: '/', secure: false, httpOnly: true }],
          cachedCredits: { total: 115, gift: 115, purchase: 0, vip: 0 },
          cachedVip: null,
          sessionValid: true,
          savedAt: Date.now(),
        }],
      });

      getAllDomainCookies = async () => [{ name: 'sessionid', value: 'original', domain: '.jianying.com', path: '/', secure: false, httpOnly: true }];
      clearDomainCookies = async () => {};
      restoreCookies = async () => ({ success: true, failures: [], authFailed: false });
      chrome.cookies.get = async () => ({ name: 'sessionid', value: 'sid-a' });
      findReusableJimengTab = async () => null;
      fetchStatusViaDirectWithRetry = async () => ({
        valid: true,
        credits: { total: 14000, gift: 14000, purchase: 0, vip: 0 },
        vip: { isVip: true, vipType: '高级会员', expireTime: 0 },
        user: { userId: '1000000000000003', nickname: '测试账号C', avatar: 'https://example.com/avatar.png' },
        unknown: false,
        creditsUnknown: false,
        vipUnknown: false,
      });
      reloadJimengTabsForSwitch = async (accountName) => { reloadNames.push(accountName); };

      const response = await switchAccount('dirty-1');
      const stored = (await chrome.storage.local.get('jimeng_accounts')).jimeng_accounts[0];
      const pending = (await chrome.storage.local.get('__pending_cookie_restore')).__pending_cookie_restore || null;
      return { response, stored, reloadNames, pending };
    } finally {
      getAllDomainCookies = originalGetAllDomainCookies;
      clearDomainCookies = originalClearDomainCookies;
      restoreCookies = originalRestoreCookies;
      chrome.cookies.get = originalCookiesGet;
      findReusableJimengTab = originalFindReusableJimengTab;
      fetchStatusViaDirectWithRetry = originalFetchStatusDirectWithRetry;
      reloadJimengTabsForSwitch = originalReloadTabs;
    }
  });

  expect(result.response).toMatchObject({
    success: false,
    rolledBack: 'full',
  });
  expect(result.response.error).toContain('身份与恢复后的真实登录身份不一致');
  expect(result.stored).toMatchObject({
    id: 'dirty-1',
    name: '用户1000000000002',
    userId: '1000000000000002',
    nickname: '用户1000000000002',
    cachedCredits: { total: 115 },
    sessionValid: false,
    lastError: 'identity-mismatch',
  });
  expect(result.reloadNames).toEqual(['原账号']);
  expect(result.pending).toBeNull();
});

test('switchAccount validates directly and does not create a tab when no Jimeng page exists', async ({ serviceWorker }) => {
  const result = await serviceWorker.evaluate(async () => {
    const originalGetAllDomainCookies = getAllDomainCookies;
    const originalClearDomainCookies = clearDomainCookies;
    const originalRestoreCookies = restoreCookies;
    const originalCookiesGet = chrome.cookies.get;
    const originalFindReusableJimengTab = findReusableJimengTab;
    const originalFetchStatusDirectWithRetry = fetchStatusViaDirectWithRetry;
    const originalReloadTabs = reloadJimengTabsForSwitch;
    const originalCreate = chrome.tabs.create;
    const createdTabs = [];

    try {
      await chrome.storage.local.set({
        jimeng_accounts: [{
          id: 'acc-b',
          name: '账号B',
          userId: 'target-user',
          nickname: '账号B',
          avatar: '',
          cookies: [{ name: 'sessionid', value: 'sid-b', domain: '.jianying.com', path: '/', secure: false, httpOnly: true }],
          cachedCredits: { total: 1, gift: 1, purchase: 0, vip: 0 },
          cachedVip: null,
          sessionValid: true,
          savedAt: Date.now(),
        }],
      });

      getAllDomainCookies = async () => [{ name: 'sessionid', value: 'original', domain: '.jianying.com', path: '/', secure: false, httpOnly: true }];
      clearDomainCookies = async () => {};
      restoreCookies = async () => ({ success: true, failures: [], authFailed: false });
      chrome.cookies.get = async () => ({ name: 'sessionid', value: 'sid-b' });
      findReusableJimengTab = async () => null;
      fetchStatusViaDirectWithRetry = async () => ({
        valid: true,
        credits: { total: 15000, gift: 15000, purchase: 0, vip: 0 },
        vip: { isVip: true, vipType: '高级会员', expireTime: 0 },
        user: { userId: 'target-user', nickname: '账号B', avatar: '' },
        unknown: false,
        creditsUnknown: false,
        vipUnknown: false,
      });
      chrome.tabs.create = async (opts) => {
        createdTabs.push(opts);
        return { id: 99, ...opts };
      };
      reloadJimengTabsForSwitch = async () => {};

      const response = await switchAccount('acc-b');
      const stored = (await chrome.storage.local.get('jimeng_accounts')).jimeng_accounts[0];
      return { response, stored, createdTabs };
    } finally {
      getAllDomainCookies = originalGetAllDomainCookies;
      clearDomainCookies = originalClearDomainCookies;
      restoreCookies = originalRestoreCookies;
      chrome.cookies.get = originalCookiesGet;
      findReusableJimengTab = originalFindReusableJimengTab;
      fetchStatusViaDirectWithRetry = originalFetchStatusDirectWithRetry;
      reloadJimengTabsForSwitch = originalReloadTabs;
      chrome.tabs.create = originalCreate;
    }
  });

  expect(result.response).toMatchObject({
    success: true,
    account: {
      id: 'acc-b',
      userId: 'target-user',
      cachedCredits: { total: 15000 },
    },
  });
  expect(result.stored).toMatchObject({
    id: 'acc-b',
    userId: 'target-user',
    cachedCredits: { total: 15000 },
    sessionValid: true,
  });
  expect(result.createdTabs).toEqual([]);
});

test('switchAccount does not use the visible Jimeng page while validating target identity', async ({ serviceWorker }) => {
  const result = await serviceWorker.evaluate(async () => {
    const originalGetAllDomainCookies = getAllDomainCookies;
    const originalClearDomainCookies = clearDomainCookies;
    const originalRestoreCookies = restoreCookies;
    const originalCookiesGet = chrome.cookies.get;
    const originalFindReusableJimengTab = findReusableJimengTab;
    const originalFetchStatusDirectWithRetry = fetchStatusViaDirectWithRetry;
    const originalReloadTabs = reloadJimengTabsForSwitch;
    const originalExecuteScript = chrome.scripting.executeScript;

    const calls = { executeScript: 0, reloadTabs: [] };

    try {
      await chrome.storage.local.set({
        jimeng_accounts: [{
          id: 'acc-visible-direct',
          name: '账号C',
          userId: 'target-user-c',
          nickname: '账号C',
          avatar: '',
          cookies: [{ name: 'sessionid', value: 'sid-c', domain: '.jianying.com', path: '/', secure: false, httpOnly: true }],
          cachedCredits: { total: 9 },
          cachedVip: { isVip: true, vipType: '高级会员', expireTime: 1800000000 },
          sessionValid: true,
          savedAt: Date.now(),
        }],
      });

      getAllDomainCookies = async () => [{ name: 'sessionid', value: 'original', domain: '.jianying.com', path: '/', secure: false, httpOnly: true }];
      clearDomainCookies = async () => {};
      restoreCookies = async () => ({ success: true, failures: [], authFailed: false });
      chrome.cookies.get = async () => ({ name: 'sessionid', value: 'sid-c' });
      findReusableJimengTab = async () => ({ id: 66, active: true, status: 'complete', url: 'https://jimeng.jianying.com/ai-tool/home' });
      fetchStatusViaDirectWithRetry = async () => ({
        valid: true,
        credits: null,
        vip: null,
        user: { userId: 'target-user-c', nickname: '账号C', avatar: '' },
        unknown: false,
        creditsUnknown: true,
        vipUnknown: false,
      });
      chrome.scripting.executeScript = async () => {
        calls.executeScript += 1;
        throw new Error('visible page should not be used during switch validation');
      };
      reloadJimengTabsForSwitch = async (accountName, options) => {
        calls.reloadTabs.push({ accountName, options });
        return { reloadedTabIds: [], skippedTabIds: [], notifiedTabIds: [] };
      };

      const response = await switchAccount('acc-visible-direct');
      const stored = (await chrome.storage.local.get('jimeng_accounts')).jimeng_accounts[0];
      return { response, stored, calls };
    } finally {
      getAllDomainCookies = originalGetAllDomainCookies;
      clearDomainCookies = originalClearDomainCookies;
      restoreCookies = originalRestoreCookies;
      chrome.cookies.get = originalCookiesGet;
      findReusableJimengTab = originalFindReusableJimengTab;
      fetchStatusViaDirectWithRetry = originalFetchStatusDirectWithRetry;
      reloadJimengTabsForSwitch = originalReloadTabs;
      chrome.scripting.executeScript = originalExecuteScript;
    }
  });

  expect(result.response).toMatchObject({ success: true });
  expect(result.stored).toMatchObject({
    id: 'acc-visible-direct',
    userId: 'target-user-c',
    sessionValid: true,
    cachedCredits: { total: 9 },
    cachedVip: { isVip: true, vipType: '高级会员', expireTime: 1800000000 },
  });
  expect(result.calls.executeScript).toBe(0);
  expect(result.calls.reloadTabs).toEqual([{ accountName: '账号C', options: { skipTabIds: [] } }]);
});

test('switchAccount skips the tab already reloaded during visible validation', async ({ serviceWorker }) => {
  const result = await serviceWorker.evaluate(async () => {
    const originalGetAllDomainCookies = getAllDomainCookies;
    const originalClearDomainCookies = clearDomainCookies;
    const originalRestoreCookies = restoreCookies;
    const originalValidateRestoredAccountForSwitch = validateRestoredAccountForSwitch;
    const originalReloadTabs = reloadJimengTabsForSwitch;
    const reloadCalls = [];

    try {
      await chrome.storage.local.set({
        jimeng_accounts: [{
          id: 'acc-visible',
          name: '账号B',
          userId: 'target-user',
          nickname: '账号B',
          avatar: '',
          cookies: [{ name: 'sessionid', value: 'sid-b', domain: '.jianying.com', path: '/', secure: false, httpOnly: true }],
          cachedCredits: { total: 1, gift: 1, purchase: 0, vip: 0 },
          cachedVip: null,
          sessionValid: true,
          savedAt: Date.now(),
        }],
      });

      getAllDomainCookies = async () => [{ name: 'sessionid', value: 'original', domain: '.jianying.com', path: '/', secure: false, httpOnly: true }];
      clearDomainCookies = async () => {};
      restoreCookies = async () => ({ success: true, failures: [], authFailed: false });
      validateRestoredAccountForSwitch = async () => ({
        ok: true,
        reason: 'matched',
        status: {
          valid: true,
          credits: { total: 15000, gift: 15000, purchase: 0, vip: 0 },
          vip: { isVip: true, vipType: '高级会员', expireTime: 0 },
          user: { userId: 'target-user', nickname: '账号B', avatar: '' },
          unknown: false,
          creditsUnknown: false,
          vipUnknown: false,
        },
        actualUserId: 'target-user',
        repaired: false,
        reloadedTabIds: [99],
      });
      reloadJimengTabsForSwitch = async (accountName, options) => {
        reloadCalls.push({ accountName, options });
        return { reloadedTabIds: [], skippedTabIds: options?.skipTabIds || [], notifiedTabIds: [] };
      };

      const response = await switchAccount('acc-visible');
      return { response, reloadCalls };
    } finally {
      getAllDomainCookies = originalGetAllDomainCookies;
      clearDomainCookies = originalClearDomainCookies;
      restoreCookies = originalRestoreCookies;
      validateRestoredAccountForSwitch = originalValidateRestoredAccountForSwitch;
      reloadJimengTabsForSwitch = originalReloadTabs;
    }
  });

  expect(result.response).toMatchObject({ success: true });
  expect(result.reloadCalls).toEqual([{
    accountName: '账号B',
    options: { skipTabIds: [99] },
  }]);
});

test('switchAccount suppresses auto-save and auto-isolation triggered by its own reloads', async ({ serviceWorker }) => {
  const result = await serviceWorker.evaluate(async () => {
    const originalGetAllDomainCookies = getAllDomainCookies;
    const originalClearDomainCookies = clearDomainCookies;
    const originalRestoreCookies = restoreCookies;
    const originalValidateRestoredAccountForSwitch = validateRestoredAccountForSwitch;
    const originalReloadTabs = reloadJimengTabsForSwitch;
    const originalDetectCurrentAccount = detectCurrentAccount;
    const originalClearIsolationState = clearJimengLoginIsolationState;
    const originalReload = chrome.tabs.reload;
    const originalGet = chrome.tabs.get;

    const calls = {
      clearCookies: 0,
      restore: 0,
      isolationClearState: [],
      tabReload: [],
      reloadTabs: [],
    };

    try {
      await chrome.storage.local.set({
        jimeng_accounts: [{
          id: 'acc-switch',
          name: '目标账号',
          userId: 'target-user',
          nickname: '目标账号',
          avatar: '',
          cookies: [{ name: 'sessionid', value: 'sid-target', domain: '.jianying.com', path: '/', secure: false, httpOnly: true }],
          cachedCredits: { total: 1 },
          cachedVip: null,
          sessionValid: true,
          savedAt: Date.now(),
        }],
      });

      getAllDomainCookies = async () => [
        { name: 'sessionid', value: 'sid-target', domain: '.jianying.com', path: '/', secure: true, httpOnly: true, hostOnly: false },
        { name: 's_v_web_id', value: 'device-target', domain: 'jimeng.jianying.com', path: '/', secure: false, httpOnly: false, hostOnly: true },
      ];
      clearDomainCookies = async () => { calls.clearCookies += 1; };
      restoreCookies = async () => { calls.restore += 1; return { success: true, failures: [], authFailed: false }; };
      validateRestoredAccountForSwitch = async () => ({
        ok: true,
        reason: 'matched',
        status: {
          valid: true,
          credits: { total: 100 },
          vip: { isVip: false },
          user: { userId: 'target-user', nickname: '目标账号', avatar: '' },
          unknown: false,
          creditsUnknown: false,
          vipUnknown: false,
        },
        actualUserId: 'target-user',
        repaired: false,
        reloadedTabIds: [77],
      });
      reloadJimengTabsForSwitch = async (accountName, options) => {
        calls.reloadTabs.push({ accountName, options });
        // 模拟切换成功后的页面 reload 事件会排队自动保存/隔离。
        scheduleAutoSaveCurrentAccount('tab-updated', 0);
        scheduleAutoLoginIsolation(77, 'tab-updated', 0);
        return { reloadedTabIds: [], skippedTabIds: options?.skipTabIds || [], notifiedTabIds: [] };
      };
      detectCurrentAccount = async () => null;
      chrome.tabs.get = async (tabId) => ({ id: tabId, status: 'complete', url: 'https://jimeng.jianying.com/ai-tool/home' });
      clearJimengLoginIsolationState = async (tabId) => { calls.isolationClearState.push(tabId); return {}; };
      chrome.tabs.reload = async (tabId, opts) => { calls.tabReload.push({ tabId, opts }); };

      const response = await switchAccount('acc-switch');
      await new Promise(resolve => setTimeout(resolve, 80));
      return {
        response,
        calls,
        suppressAutoSaveUntil,
        suppressLoginIsolationUntil,
        now: Date.now(),
      };
    } finally {
      getAllDomainCookies = originalGetAllDomainCookies;
      clearDomainCookies = originalClearDomainCookies;
      restoreCookies = originalRestoreCookies;
      validateRestoredAccountForSwitch = originalValidateRestoredAccountForSwitch;
      reloadJimengTabsForSwitch = originalReloadTabs;
      detectCurrentAccount = originalDetectCurrentAccount;
      clearJimengLoginIsolationState = originalClearIsolationState;
      chrome.tabs.reload = originalReload;
      chrome.tabs.get = originalGet;
    }
  });

  expect(result.response).toMatchObject({ success: true });
  expect(result.calls.reloadTabs).toHaveLength(1);
  expect(result.calls.isolationClearState).toEqual([]);
  expect(result.calls.tabReload).toEqual([]);
  expect(result.suppressAutoSaveUntil).toBeGreaterThan(result.now);
  expect(result.suppressLoginIsolationUntil).toBeGreaterThan(result.now);
});

test('popup hides repair mode and normal save ignores stale repair settings', async ({ context, extensionId, serviceWorker }) => {
  await serviceWorker.evaluate(async () => {
    await chrome.storage.local.set({
      jimeng_accounts: [
        { id: 'acc-1', name: '账号A', savedAt: Date.now(), cookies: [], sessionValid: false },
      ],
      jimeng_settings: {
        repairAccountId: 'acc-1',
        saveDraftName: '',
      },
    });

    globalThis.__originalDetectCurrentAccount = detectCurrentAccount;
    globalThis.__originalSaveCurrentAccount = saveCurrentAccount;
    globalThis.__saveCalls = [];

    detectCurrentAccount = async () => null;
    saveCurrentAccount = async (name, repairAccountId) => {
      globalThis.__saveCalls.push({ name, repairAccountId });
      return {
        success: true,
        account: { id: 'acc-1', name: '账号A' },
        isUpdate: true,
      };
    };
  });

  const popup = await openPopup(context, extensionId);
  await expect(popup.locator('[data-action="repair"]')).toHaveCount(0);
  await expect(popup.locator('#repair-banner')).toHaveCount(0);
  await expect(popup.locator('#expired-banner')).toBeVisible();
  await expect(popup.locator('#expired-text')).toContainText('已禁止切换');
  await expect(popup.locator('[data-action="switch"][data-id="acc-1"]')).toBeDisabled();
  await expect(popup.locator('[data-action="switch"][data-id="acc-1"]')).toContainText('已过期');
  await expect(popup.locator('#btn-save')).toContainText('保存当前账号');

  await popup.locator('#btn-save').click();

  const result = await serviceWorker.evaluate(async () => ({
    saveCalls: globalThis.__saveCalls.slice(),
    settings: await loadSettings(),
  }));
  expect(result.saveCalls).toEqual([{ name: undefined, repairAccountId: undefined }]);
  expect(result.settings.repairAccountId).toBeNull();

  await serviceWorker.evaluate(() => {
    detectCurrentAccount = globalThis.__originalDetectCurrentAccount;
    saveCurrentAccount = globalThis.__originalSaveCurrentAccount;
    delete globalThis.__originalDetectCurrentAccount;
    delete globalThis.__originalSaveCurrentAccount;
    delete globalThis.__saveCalls;
  });

  await popup.close();
});

test('popup rename and delete actions dispatch expected account operations', async ({ context, extensionId, serviceWorker }) => {
  await serviceWorker.evaluate(async () => {
    await chrome.storage.local.set({
      jimeng_accounts: [
        { id: 'acc-1', name: '旧名字', savedAt: Date.now(), cookies: [] },
      ],
    });

    globalThis.__originalDetectCurrentAccount = detectCurrentAccount;
    globalThis.__originalRenameAccount = renameAccount;
    globalThis.__originalDeleteAccount = deleteAccount;
    globalThis.__renameCalls = [];
    globalThis.__deleteCalls = [];

    detectCurrentAccount = async () => null;
    renameAccount = async (accountId, name) => {
      globalThis.__renameCalls.push({ accountId, name });
      return { success: true };
    };
    deleteAccount = async (accountId) => {
      globalThis.__deleteCalls.push(accountId);
      return { success: true };
    };
  });

  const popup = await openPopup(context, extensionId);

  await popup.locator('[data-action="rename"][data-id="acc-1"]').click();
  await popup.locator('.rename-input').fill('新名字');
  await popup.locator('.rename-input').press('Enter');

  const renameCalls = await serviceWorker.evaluate(() => globalThis.__renameCalls.slice());
  expect(renameCalls).toEqual([{ accountId: 'acc-1', name: '新名字' }]);

  await popup.evaluate(() => { window.confirm = () => true; });
  await popup.locator('[data-action="delete"][data-id="acc-1"]').click();

  const deleteCalls = await serviceWorker.evaluate(() => globalThis.__deleteCalls.slice());
  expect(deleteCalls).toEqual(['acc-1']);

  await serviceWorker.evaluate(() => {
    detectCurrentAccount = globalThis.__originalDetectCurrentAccount;
    renameAccount = globalThis.__originalRenameAccount;
    deleteAccount = globalThis.__originalDeleteAccount;
    delete globalThis.__originalDetectCurrentAccount;
    delete globalThis.__originalRenameAccount;
    delete globalThis.__originalDeleteAccount;
    delete globalThis.__renameCalls;
    delete globalThis.__deleteCalls;
  });

  await popup.close();
});

test('reloadJimengTabsForSwitch refreshes existing Jimeng tabs without creating a new tab', async ({ serviceWorker }) => {
  const result = await serviceWorker.evaluate(async () => {
    const originalQuery = chrome.tabs.query;
    const originalReload = chrome.tabs.reload;
    const originalCreate = chrome.tabs.create;
    const originalClearJimengLocalStorage = clearJimengLocalStorage;
    const originalNotify = notifyTabAccountSwitched;

    const calls = {
      reload: [],
      create: [],
      cleared: [],
      notified: [],
    };

    try {
      chrome.tabs.query = async () => [
        { id: 11, windowId: 1, active: true },
        { id: 12, windowId: 1, active: false },
        { id: 21, windowId: 2, active: true },
      ];
      chrome.tabs.reload = async (tabId, opts) => { calls.reload.push({ tabId, opts }); };
      chrome.tabs.create = async (opts) => { calls.create.push(opts); };
      clearJimengLocalStorage = async (tabId) => { calls.cleared.push(tabId); };
      notifyTabAccountSwitched = async (tabId, name) => { calls.notified.push({ tabId, name }); };

      await reloadJimengTabsForSwitch('账号B');
      return calls;
    } finally {
      chrome.tabs.query = originalQuery;
      chrome.tabs.reload = originalReload;
      chrome.tabs.create = originalCreate;
      clearJimengLocalStorage = originalClearJimengLocalStorage;
      notifyTabAccountSwitched = originalNotify;
    }
  });

  expect(result.create).toEqual([]);
  expect(result.cleared).toEqual([11, 12, 21]);
  expect(result.reload).toEqual([
    { tabId: 11, opts: { bypassCache: true } },
    { tabId: 12, opts: { bypassCache: true } },
    { tabId: 21, opts: { bypassCache: true } },
  ]);
  expect(result.notified).toEqual([]);
});

test('reloadJimengTabsForSwitch does not reload tabs already refreshed by validation', async ({ serviceWorker }) => {
  const result = await serviceWorker.evaluate(async () => {
    const originalQuery = chrome.tabs.query;
    const originalReload = chrome.tabs.reload;
    const originalCreate = chrome.tabs.create;
    const originalClearJimengLocalStorage = clearJimengLocalStorage;
    const originalNotify = notifyTabAccountSwitched;

    const calls = {
      reload: [],
      create: [],
      cleared: [],
      notified: [],
      reloadResult: null,
    };

    try {
      chrome.tabs.query = async () => [
        { id: 11, windowId: 1, active: true },
        { id: 12, windowId: 1, active: false },
        { id: 21, windowId: 2, active: true },
      ];
      chrome.tabs.reload = async (tabId, opts) => { calls.reload.push({ tabId, opts }); };
      chrome.tabs.create = async (opts) => { calls.create.push(opts); };
      clearJimengLocalStorage = async (tabId) => { calls.cleared.push(tabId); };
      notifyTabAccountSwitched = async (tabId, name) => { calls.notified.push({ tabId, name }); };

      calls.reloadResult = await reloadJimengTabsForSwitch('账号B', { skipTabIds: [11] });
      return calls;
    } finally {
      chrome.tabs.query = originalQuery;
      chrome.tabs.reload = originalReload;
      chrome.tabs.create = originalCreate;
      clearJimengLocalStorage = originalClearJimengLocalStorage;
      notifyTabAccountSwitched = originalNotify;
    }
  });

  expect(result.create).toEqual([]);
  expect(result.cleared).toEqual([12, 21]);
  expect(result.reload).toEqual([
    { tabId: 12, opts: { bypassCache: true } },
    { tabId: 21, opts: { bypassCache: true } },
  ]);
  expect(result.notified).toEqual([]);
  expect(result.reloadResult).toEqual({
    reloadedTabIds: [12, 21],
    skippedTabIds: [11],
    notifiedTabIds: [],
  });
});

test('prepareIsolatedLogin clears shared browser identity before opening the login tab', async ({ serviceWorker }) => {
  const result = await serviceWorker.evaluate(async () => {
    const originalGetAllDomainCookies = getAllDomainCookies;
    const originalClearDomainCookies = clearDomainCookies;
    const originalFindReusableJimengTab = findReusableJimengTab;
    const originalClearIsolationState = clearJimengLoginIsolationState;
    const originalWaitForTabComplete = waitForTabComplete;
    const originalUpdate = chrome.tabs.update;
    const originalCreate = chrome.tabs.create;
    const originalReload = chrome.tabs.reload;

    const calls = {
      clearCookies: 0,
      update: [],
      create: [],
      reload: [],
      clearState: [],
      wait: [],
    };
    let getCookieCalls = 0;

    try {
      getAllDomainCookies = async () => {
        getCookieCalls += 1;
        if (getCookieCalls === 1) {
          return [
            { name: 'sessionid', value: 'sid-old', domain: '.jianying.com', path: '/', secure: true, httpOnly: true, hostOnly: false },
            { name: 's_v_web_id', value: 'device-old', domain: 'jimeng.jianying.com', path: '/', secure: false, httpOnly: false, hostOnly: true },
          ];
        }
        return [];
      };
      clearDomainCookies = async () => { calls.clearCookies += 1; };
      findReusableJimengTab = async () => ({ id: 88, active: true, status: 'complete', url: 'https://jimeng.jianying.com/ai-tool/home' });
      clearJimengLoginIsolationState = async (tabId) => {
        calls.clearState.push(tabId);
        return { localStorageRemoved: 3, sessionStorageRemoved: 1, indexedDbDeleted: ['db-a'], cacheDeleted: ['cache-a'], errors: [] };
      };
      waitForTabComplete = async (tabId) => { calls.wait.push(tabId); return { id: tabId, status: 'complete' }; };
      chrome.tabs.update = async (tabId, opts) => {
        calls.update.push({ tabId, opts });
        return { id: tabId, status: 'complete', url: opts.url };
      };
      chrome.tabs.create = async (opts) => {
        calls.create.push(opts);
        return { id: 99, status: 'complete', url: opts.url };
      };
      chrome.tabs.reload = async (tabId, opts) => { calls.reload.push({ tabId, opts }); };

      const response = await prepareIsolatedLogin();
      const settings = await loadSettings();
      return { response, calls, settings };
    } finally {
      getAllDomainCookies = originalGetAllDomainCookies;
      clearDomainCookies = originalClearDomainCookies;
      findReusableJimengTab = originalFindReusableJimengTab;
      clearJimengLoginIsolationState = originalClearIsolationState;
      waitForTabComplete = originalWaitForTabComplete;
      chrome.tabs.update = originalUpdate;
      chrome.tabs.create = originalCreate;
      chrome.tabs.reload = originalReload;
    }
  });

  expect(result.response).toMatchObject({
    success: true,
    tabId: 88,
    createdTab: false,
    removedCookieCount: 2,
  });
  expect(result.calls.clearCookies).toBe(1);
  expect(result.calls.create).toEqual([]);
  expect(result.calls.update).toEqual([{ tabId: 88, opts: { active: true } }]);
  expect(result.calls.clearState).toEqual([88]);
  expect(result.calls.reload).toEqual([{ tabId: 88, opts: { bypassCache: true } }]);
  expect(result.calls.wait).toEqual([88, 88]);
  expect(result.settings.lastLoginIsolationAt).toBeGreaterThan(0);
});

test('logged-out Jimeng page is auto-isolated once without user-facing extra button', async ({ context, extensionId, serviceWorker }) => {
  const popup = await openPopup(context, extensionId);
  await expect(popup.locator('#btn-new-login')).toHaveCount(0);
  await popup.close();

  const result = await serviceWorker.evaluate(async () => {
    const originalGetAllDomainCookies = getAllDomainCookies;
    const originalClearDomainCookies = clearDomainCookies;
    const originalClearIsolationState = clearJimengLoginIsolationState;
    const originalReload = chrome.tabs.reload;
    const originalGet = chrome.tabs.get;

    const calls = {
      clearCookies: 0,
      clearState: [],
      reload: [],
    };

    try {
      getAllDomainCookies = async () => [
        { name: 's_v_web_id', value: 'old-device', domain: 'jimeng.jianying.com', path: '/', secure: false, httpOnly: false, hostOnly: true },
      ];
      clearDomainCookies = async () => { calls.clearCookies += 1; };
      clearJimengLoginIsolationState = async (tabId) => {
        calls.clearState.push(tabId);
        return { localStorageRemoved: 1, sessionStorageRemoved: 1, indexedDbDeleted: [], cacheDeleted: [], errors: [] };
      };
      chrome.tabs.get = async (tabId) => ({ id: tabId, status: 'complete', url: 'https://jimeng.jianying.com/ai-tool/home' });
      chrome.tabs.reload = async (tabId, opts) => { calls.reload.push({ tabId, opts }); };

      const response = await maybeAutoPrepareLoggedOutLogin(123, 'test-logged-out');
      const second = await maybeAutoPrepareLoggedOutLogin(123, 'test-logged-out');
      return { response, second, calls, settings: await loadSettings() };
    } finally {
      getAllDomainCookies = originalGetAllDomainCookies;
      clearDomainCookies = originalClearDomainCookies;
      clearJimengLoginIsolationState = originalClearIsolationState;
      chrome.tabs.reload = originalReload;
      chrome.tabs.get = originalGet;
    }
  });

  expect(result.response).toMatchObject({ success: true, tabId: 123 });
  expect(result.second).toMatchObject({ skipped: true, reason: 'suppressed-automatic-work' });
  expect(result.calls.clearCookies).toBe(1);
  expect(result.calls.clearState).toEqual([123]);
  expect(result.calls.reload).toEqual([{ tabId: 123, opts: { bypassCache: true } }]);
  expect(result.settings.lastLoginIsolationReason).toBe('test-logged-out');
});

test('checkAllStatuses refreshes all accounts credits and vip data in one pass', async ({ serviceWorker }) => {
  const result = await serviceWorker.evaluate(async () => {
    const originalGetAllDomainCookies = getAllDomainCookies;
    const originalPersistPendingRestore = persistPendingRestore;
    const originalMarkPendingStage = markPendingStage;
    const originalClearPendingRestore = clearPendingRestore;
    const originalClearDomainCookies = clearDomainCookies;
    const originalRestoreCookies = restoreCookies;
    const originalBroadcastProgress = broadcastProgress;
    const originalWithAccountCookies = withAccountCookies;
    const originalEnsure = JimengTabSession.prototype.ensure;
    const originalCleanup = JimengTabSession.prototype.cleanup;

    const progress = [];
    const restoreCalls = [];

    try {
      await chrome.storage.local.set({
        jimeng_accounts: [
          {
            id: 'acc-1',
            name: '账号A',
            userId: 'user-1',
            nickname: '旧A',
            cookies: [{ name: 'sessionid', value: 'a', domain: '.jianying.com', path: '/' }],
            cachedCredits: { total: 1 },
            cachedVip: null,
            sessionValid: null,
            savedAt: Date.now(),
          },
          {
            id: 'acc-2',
            name: '账号B',
            userId: 'user-2',
            nickname: '旧B',
            cookies: [{ name: 'sessionid', value: 'b', domain: '.jianying.com', path: '/' }],
            cachedCredits: { total: 2 },
            cachedVip: null,
            sessionValid: null,
            savedAt: Date.now(),
          },
        ],
      });

      getAllDomainCookies = async () => [{ name: 'sessionid', value: 'origin', domain: '.jianying.com', path: '/' }];
      persistPendingRestore = async () => {};
      markPendingStage = async () => {};
      clearPendingRestore = async () => {};
      clearDomainCookies = async () => {};
      restoreCookies = async (cookies) => {
        restoreCalls.push(cookies.map((cookie) => cookie.name));
        return { success: true, failures: [], authFailed: false };
      };
      broadcastProgress = async (payload) => { progress.push(payload); };
      withAccountCookies = async (account) => {
        if (account.id === 'acc-1') {
          return {
            valid: true,
            unknown: false,
            credits: { total: 88, gift: 80, purchase: 8, vip: 0 },
            vip: { isVip: false, vipType: '', expireTime: 0 },
            user: { userId: 'user-1', nickname: '账号A新', avatar: '' },
          };
        }
        return {
          valid: true,
          unknown: false,
          credits: { total: 66, gift: 60, purchase: 6, vip: 0 },
          vip: { isVip: true, vipType: 'VIP', expireTime: 2222222222 },
          user: { userId: 'user-2', nickname: '账号B新', avatar: '' },
        };
      };
      JimengTabSession.prototype.ensure = async function ensure() { this.tabId = 1; };
      JimengTabSession.prototype.cleanup = async () => {};

      const response = await checkAllStatuses();
      const accounts = (await chrome.storage.local.get('jimeng_accounts')).jimeng_accounts || [];
      return { response, accounts, progress, restoreCalls };
    } finally {
      getAllDomainCookies = originalGetAllDomainCookies;
      persistPendingRestore = originalPersistPendingRestore;
      markPendingStage = originalMarkPendingStage;
      clearPendingRestore = originalClearPendingRestore;
      clearDomainCookies = originalClearDomainCookies;
      restoreCookies = originalRestoreCookies;
      broadcastProgress = originalBroadcastProgress;
      withAccountCookies = originalWithAccountCookies;
      JimengTabSession.prototype.ensure = originalEnsure;
      JimengTabSession.prototype.cleanup = originalCleanup;
    }
  });

  expect(result.response.success).toBe(true);
  expect(result.response.results).toHaveLength(2);
  expect(result.accounts).toEqual([
    expect.objectContaining({
      id: 'acc-1',
      sessionValid: true,
      cachedCredits: { total: 88, gift: 80, purchase: 8, vip: 0 },
      cachedVip: { isVip: false, vipType: '', expireTime: 0 },
    }),
    expect.objectContaining({
      id: 'acc-2',
      sessionValid: true,
      cachedCredits: { total: 66, gift: 60, purchase: 6, vip: 0 },
      cachedVip: { isVip: true, vipType: 'VIP', expireTime: 2222222222 },
    }),
  ]);
  expect(result.progress.map((item) => item.phase)).toEqual(['init', 'check', 'check', 'restore', 'done']);
  expect(result.restoreCalls).toEqual([['sessionid']]);
});

test('popup refresh-status button triggers batch refresh flow and updates summary', async ({ context, extensionId, serviceWorker }) => {
  await serviceWorker.evaluate(async () => {
    await chrome.storage.local.set({
      jimeng_accounts: [
        {
          id: 'acc-1',
          name: '账号A',
          savedAt: Date.now(),
          cookies: [],
          cachedCredits: { total: 10 },
          sessionValid: true,
        },
      ],
    });

    globalThis.__originalDetectCurrentAccount = detectCurrentAccount;
    globalThis.__originalCheckAllStatuses = checkAllStatuses;
    globalThis.__checkAllStatusesCalls = 0;

    detectCurrentAccount = async () => 'acc-1';
    checkAllStatuses = async () => {
      globalThis.__checkAllStatusesCalls += 1;
      await chrome.storage.local.set({
        jimeng_accounts: [
          {
            id: 'acc-1',
            name: '账号A',
            savedAt: Date.now(),
            cookies: [],
            cachedCredits: { total: 42 },
            sessionValid: true,
          },
        ],
      });
      return { success: true };
    };
  });

  const popup = await openPopup(context, extensionId);
  await expect(popup.locator('#summary-credits')).toHaveText('10');
  await popup.evaluate(() => { window.confirm = () => true; });
  await popup.locator('#btn-check-all').click();

  await expect(popup.locator('#toast')).toContainText('状态已刷新');
  await expect(popup.locator('#summary-credits')).toHaveText('42');

  const refreshCalls = await serviceWorker.evaluate(() => globalThis.__checkAllStatusesCalls);
  expect(refreshCalls).toBe(1);

  await serviceWorker.evaluate(() => {
    detectCurrentAccount = globalThis.__originalDetectCurrentAccount;
    checkAllStatuses = globalThis.__originalCheckAllStatuses;
    delete globalThis.__originalDetectCurrentAccount;
    delete globalThis.__originalCheckAllStatuses;
    delete globalThis.__checkAllStatusesCalls;
  });

  await popup.close();
});

test('getAllDomainCookies merges supplemental auth cookies missing from cookies.getAll', async ({ serviceWorker }) => {
  const result = await serviceWorker.evaluate(async () => {
    const originalGetAll = chrome.cookies.getAll;
    const originalGet = chrome.cookies.get;

    try {
      chrome.cookies.getAll = async (query) => {
        if (query?.domain === '.jianying.com') {
          return [
            { name: 'passport_csrf_token', domain: '.jianying.com', path: '/' },
          ];
        }
        if (query?.domain === 'jimeng.jianying.com') {
          return [
            { name: 'uifid', domain: 'jimeng.jianying.com', path: '/' },
          ];
        }
        return [];
      };

      chrome.cookies.get = async ({ name }) => {
        if (name === 'sessionid') {
          return { name: 'sessionid', domain: '.jianying.com', path: '/', value: 'sid' };
        }
        if (name === 'sid_tt') {
          return { name: 'sid_tt', domain: '.jianying.com', path: '/', value: 'sidtt' };
        }
        return null;
      };

      const cookies = await getAllDomainCookies();
      return cookies.map(c => `${c.name}@${c.domain}`).sort();
    } finally {
      chrome.cookies.getAll = originalGetAll;
      chrome.cookies.get = originalGet;
    }
  });

  expect(result).toEqual([
    'passport_csrf_token@.jianying.com',
    'sessionid@.jianying.com',
    'sid_tt@.jianying.com',
    'uifid@jimeng.jianying.com',
  ]);
});

test('verifySession can reuse an existing Jimeng tab when switch flow forbids opening a new one', async ({ serviceWorker }) => {
  const result = await serviceWorker.evaluate(async () => {
    const originalTabsCreate = chrome.tabs.create;
    const originalTabsGet = chrome.tabs.get;
    const originalTabsRemove = chrome.tabs.remove;
    const originalExecuteScript = chrome.scripting.executeScript;
    const originalQuery = chrome.tabs.query;
    const originalCookiesGet = chrome.cookies.get;
    const created = [];

    try {
      chrome.cookies.get = async () => ({ name: 'sessionid', value: 'sid-a' });
      chrome.tabs.query = async () => ([{ id: 99, active: true, status: 'complete', url: 'https://jimeng.jianying.com/ai-tool/home' }]);
      chrome.tabs.create = async (details) => { created.push(details); return { id: 200, status: 'complete' }; };
      chrome.tabs.get = async (tabId) => ({ id: tabId, status: 'complete' });
      chrome.tabs.remove = async () => {};
      chrome.scripting.executeScript = async () => [{ result: { ok: true, status: 200, data: { data: { user_id: 'user-1', name: '账号A', avatar_url: '' } } } }];

      const ok = await verifySession({ userId: 'user-1' }, { forceInternal: false });
      return { ok, createdCount: created.length };
    } finally {
      chrome.tabs.create = originalTabsCreate;
      chrome.tabs.get = originalTabsGet;
      chrome.tabs.remove = originalTabsRemove;
      chrome.scripting.executeScript = originalExecuteScript;
      chrome.tabs.query = originalQuery;
      chrome.cookies.get = originalCookiesGet;
    }
  });

  expect(result).toEqual({ ok: true, createdCount: 0 });
});

test('verifySession uses an internal Jimeng tab for deep verification so user tabs do not affect switching', async ({ serviceWorker }) => {
  const result = await serviceWorker.evaluate(async () => {
    const originalTabsCreate = chrome.tabs.create;
    const originalTabsGet = chrome.tabs.get;
    const originalTabsRemove = chrome.tabs.remove;
    const originalExecuteScript = chrome.scripting.executeScript;
    const originalQuery = chrome.tabs.query;
    const originalCookiesGet = chrome.cookies.get;
    const created = [];

    try {
      chrome.cookies.get = async () => ({ name: 'sessionid', value: 'sid-a' });
      chrome.tabs.query = async () => ([{ id: 99, active: true, status: 'complete', url: 'https://jimeng.jianying.com/ai-tool/home' }]);
      chrome.tabs.create = async (details) => { created.push(details); return { id: 200, status: 'complete' }; };
      chrome.tabs.get = async (tabId) => ({ id: tabId, status: 'complete' });
      chrome.tabs.remove = async () => {};
      chrome.scripting.executeScript = async ({ target, args }) => [{ result: { ok: true, status: 200, data: { data: { user_id: 'user-1', name: '账号A', avatar_url: '' } } } }];

      const ok = await verifySession({ userId: 'user-1' }, { forceInternal: true });
      return { ok, createdCount: created.length, createdActive: created[0]?.active ?? null };
    } finally {
      chrome.tabs.create = originalTabsCreate;
      chrome.tabs.get = originalTabsGet;
      chrome.tabs.remove = originalTabsRemove;
      chrome.scripting.executeScript = originalExecuteScript;
      chrome.tabs.query = originalQuery;
      chrome.cookies.get = originalCookiesGet;
    }
  });

  expect(result).toEqual({ ok: true, createdCount: 1, createdActive: false });
});

test('JimengTabSession reuses an existing Jimeng tab instead of opening a new one', async ({ serviceWorker }) => {
  const result = await serviceWorker.evaluate(async () => {
    const originalQuery = chrome.tabs.query;
    const originalGet = chrome.tabs.get;
    const originalCreate = chrome.tabs.create;
    let createCalled = 0;

    try {
      chrome.tabs.query = async () => [{ id: 321, active: true, status: 'complete' }];
      chrome.tabs.get = async (id) => ({ id, status: 'complete' });
      chrome.tabs.create = async () => {
        createCalled += 1;
        return { id: 999, status: 'complete' };
      };

      const session = new JimengTabSession();
      await session.ensure();

      return {
        tabId: session.tabId,
        isInternal: session.isInternal,
        createCalled,
      };
    } finally {
      chrome.tabs.query = originalQuery;
      chrome.tabs.get = originalGet;
      chrome.tabs.create = originalCreate;
    }
  });

  expect(result).toEqual({
    tabId: 321,
    isInternal: false,
    createCalled: 0,
  });
});

test('JimengTabSession falls back to a temporary tab when no Jimeng tab exists', async ({ serviceWorker }) => {
  const result = await serviceWorker.evaluate(async () => {
    const originalQuery = chrome.tabs.query;
    const originalGet = chrome.tabs.get;
    const originalCreate = chrome.tabs.create;

    try {
      chrome.tabs.query = async () => [];
      chrome.tabs.get = async (id) => ({ id, status: 'complete' });
      chrome.tabs.create = async () => ({ id: 777, status: 'complete' });

      const session = new JimengTabSession();
      await session.ensure();

      return {
        tabId: session.tabId,
        isInternal: session.isInternal,
      };
    } finally {
      chrome.tabs.query = originalQuery;
      chrome.tabs.get = originalGet;
      chrome.tabs.create = originalCreate;
    }
  });

  expect(result).toEqual({
    tabId: 777,
    isInternal: true,
  });
});
