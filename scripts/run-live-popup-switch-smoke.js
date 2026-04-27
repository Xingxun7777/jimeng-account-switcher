const fs = require('fs');
const path = require('path');
const {
  launchExtensionContext,
  normalizeCookieForPlaywright,
  parseArgs,
} = require('./playwright-extension-utils');

function readFixture(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function fixtureArgsToList(args) {
  if (args.authList) {
    return String(args.authList)
      .split(',')
      .map(item => item.trim())
      .filter(Boolean);
  }
  return [args.authA, args.authB].filter(Boolean);
}

function popupUrl(extensionId) {
  return `chrome-extension://${extensionId}/popup/popup.html`;
}

async function openPopup(context, extensionId) {
  const popup = await context.newPage();
  await popup.goto(popupUrl(extensionId), { waitUntil: 'domcontentloaded' });
  await popup.locator('text=即梦账号管理').waitFor({ timeout: 15000 });
  await popup.locator('#btn-save').waitFor({ timeout: 15000 });
  return popup;
}

function toImportAccount(auth, index) {
  const user = auth.user || auth.status?.user || {};
  const label = auth.label || user.nickname || `account-${index + 1}`;
  return {
    id: `live-popup-${label}-${index}`,
    name: label,
    userId: user.userId ? String(user.userId) : '',
    nickname: user.nickname || label,
    avatar: user.avatar || '',
    cookies: Array.isArray(auth.cookies) ? auth.cookies : [],
    savedAt: Date.now(),
    cachedCredits: auth.status?.credits || null,
    cachedVip: auth.status?.vip || null,
    sessionValid: true,
    lastChecked: Date.now(),
  };
}

async function getJimengTabs(serviceWorker) {
  return await serviceWorker.evaluate(async () => {
    const tabs = await chrome.tabs.query({});
    return tabs
      .filter(tab => typeof tab.url === 'string' && tab.url.includes('jianying.com'))
      .map(tab => ({
        id: tab.id,
        url: tab.url,
        status: tab.status,
        active: tab.active,
        windowId: tab.windowId,
      }))
      .sort((a, b) => a.id - b.id);
  });
}

async function waitForPageUser(page, expectedUserId, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  let last = null;

  while (Date.now() < deadline) {
    try {
      await page.waitForLoadState('domcontentloaded', { timeout: 3000 }).catch(() => {});
      last = await page.evaluate(async () => {
        const extractUser = (json) => {
          const candidates = [
            json?.data?.data,
            json?.data,
            json?.response?.data,
            json?.response,
            json,
          ].filter(Boolean);
          for (const item of candidates) {
            const userId = item.user_id_str || item.user_id || item.userId;
            if (userId) {
              return {
                userId: String(userId),
                nickname: item.screen_name || item.name || item.nickname || '',
              };
            }
          }
          return null;
        };

        let apiUser = null;
        try {
          const resp = await fetch('/passport/account/info/v2?account_sdk_source=web', {
            method: 'POST',
            credentials: 'include',
            headers: {
              'Content-Type': 'application/json',
              Accept: 'application/json, text/plain, */*',
            },
            body: '{}',
          });
          apiUser = extractUser(await resp.json());
        } catch (e) {
          apiUser = { error: String(e?.message || e) };
        }

        let localUser = null;
        try {
          const raw = localStorage.getItem('__lvweb_user_status');
          if (raw) {
            const parsed = JSON.parse(raw);
            if (parsed?.uid) localUser = { userId: String(parsed.uid) };
          }
        } catch {}

        const bodyText = document.body?.innerText?.slice(0, 500) || '';
        return {
          url: location.href,
          title: document.title,
          apiUser,
          localUser,
          bodyText,
        };
      });

      const actual = last?.apiUser?.userId || last?.localUser?.userId || '';
      if (String(actual) === String(expectedUserId)) return { success: true, actual, snapshot: last };
    } catch (e) {
      last = { error: String(e?.message || e) };
    }

    await new Promise(resolve => setTimeout(resolve, 750));
  }

  return {
    success: false,
    actual: last?.apiUser?.userId || last?.localUser?.userId || '',
    snapshot: last,
  };
}

async function importAccountsViaPopup({ context, extensionId, importFile }) {
  const popup = await openPopup(context, extensionId);
  try {
    await popup.locator('#btn-toggle-settings').click();
    await popup.locator('#settings-panel:not(.hidden)').waitFor({ timeout: 5000 });
    await popup.locator('#file-import').setInputFiles(importFile);
    await popup.locator('.modal-overlay [data-mode="replace"]').waitFor({ timeout: 10000 });
    await popup.locator('.modal-overlay [data-mode="replace"]').click();
    await popup.locator('.account-card').first().waitFor({ timeout: 15000 });
    const names = await popup.locator('.account-name').evaluateAll(nodes => nodes.map(node => node.textContent.trim()));
    return names;
  } finally {
    await popup.close().catch(() => {});
  }
}

async function seedDirtyStoredAccounts(serviceWorker, authAccounts) {
  const polluted = authAccounts[1] || authAccounts[0];
  const pollutedName = polluted.nickname || polluted.name || '污染账号名';
  const pollutedUserId = polluted.userId || '';
  const accounts = authAccounts.map((account, index) => ({
    ...account,
    id: `dirty-stored-${index}`,
    expectedUserId: account.userId,
    expectedName: account.name,
    seededCreditsTotal: 900001 + index,
    name: pollutedName,
    nickname: pollutedName,
    userId: pollutedUserId,
    importedUserId: '',
    sessionValid: true,
    cachedCredits: { total: 900001 + index, gift: 900001 + index, purchase: 0, vip: 0 },
    cachedVip: account.cachedVip || { isVip: true, vipType: '高级会员', expireTime: 0 },
    lastChecked: Date.now(),
  }));

  await serviceWorker.evaluate(async ({ accounts }) => {
    await chrome.storage.local.set({
      jimeng_accounts: accounts,
      jimeng_accounts_backup: accounts,
      jimeng_accounts_journal: [{
        ts: Date.now(),
        reason: 'dirty-stored-metadata-smoke-seed',
        count: accounts.length,
        accounts,
      }],
      jimeng_settings: { saveDraftName: '', repairAccountId: accounts[1]?.id || null, autoSaveOnLogin: true },
    });
  }, { accounts });

  return accounts;
}

async function calibrateNewTabDetector(context) {
  const created = [];
  const onPage = page => created.push(page);
  context.on('page', onPage);
  const calibrationPage = await context.newPage();
  await calibrationPage.goto('https://jimeng.jianying.com/ai-tool/home?__jimeng_switcher_probe=1', {
    waitUntil: 'domcontentloaded',
    timeout: 30000,
  }).catch(() => {});
  await new Promise(resolve => setTimeout(resolve, 500));
  context.off('page', onPage);
  await calibrationPage.close().catch(() => {});

  const sawJimeng = created.some(page => page.url().includes('jianying.com'));
  if (!sawJimeng) {
    throw new Error('Calibration failed: new-tab detector did not observe a deliberately opened Jimeng tab');
  }
}

async function clickSwitchViaPopup({ context, extensionId, page, serviceWorker, target }) {
  const beforeTabs = await getJimengTabs(serviceWorker);
  const created = [];
  const onPage = newPage => created.push(newPage);
  context.on('page', onPage);

  const popup = await openPopup(context, extensionId);
  try {
    const card = popup.locator(`.account-card[data-id="${target.id}"]`).first();
    await card.waitFor({ timeout: 15000 });
    const button = card.locator('button[data-action="switch"]');
    const isDisabled = await button.isDisabled();
    if (isDisabled) {
      throw new Error(`Target account ${target.name} is already current; switch button is disabled`);
    }

    await button.click();
    // The UI must mark the exact clicked card current. Do not accept "some"
    // current card here; otherwise a stale active card can hide a broken switch.
    await popup.locator(`.account-card.active[data-id="${target.id}"]`).first().waitFor({ timeout: 45000 });
    const expectedUserId = target.expectedUserId || target.userId;
    const identity = await waitForPageUser(page, expectedUserId, 45000);
    await new Promise(resolve => setTimeout(resolve, 2500));

    const afterTabs = await getJimengTabs(serviceWorker);
    const activeCard = await popup.locator('.account-card.active').first().evaluate((node) => ({
      id: node.getAttribute('data-id'),
      name: node.querySelector('.account-name')?.textContent?.trim() || '',
      creditsText: node.querySelector('.credits-num')?.textContent?.trim() || '',
      text: node.textContent?.replace(/\s+/g, ' ').trim() || '',
    })).catch(() => null);
    const storedAfter = await serviceWorker.evaluate(async ({ id }) => {
      const accounts = (await chrome.storage.local.get('jimeng_accounts')).jimeng_accounts || [];
      const account = accounts.find(item => item.id === id);
      if (!account) return null;
      return {
        id: account.id,
        name: account.name,
        userId: account.userId,
        nickname: account.nickname,
        creditsTotal: account.cachedCredits?.total ?? null,
        sessionValid: account.sessionValid,
        lastChecked: account.lastChecked || null,
      };
    }, { id: target.id });
    context.off('page', onPage);
    const createdUrls = created.map(createdPage => createdPage.url()).filter(url => url.includes('jianying.com'));

    return {
      target: target.name,
      expectedUserId,
      actualUserId: identity.actual,
      identityOk: identity.success,
      beforeTabs,
      afterTabs,
      createdJimengTabsDuringSwitch: createdUrls,
      noExtraFinalJimengTab: afterTabs.length <= beforeTabs.length,
      activeCard,
      storedAfter,
      seededCreditsTotal: target.seededCreditsTotal ?? null,
      snapshot: identity.snapshot,
    };
  } finally {
    context.off('page', onPage);
    await popup.close().catch(() => {});
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const fixturePaths = fixtureArgsToList(args);
  if (fixturePaths.length < 2) {
    throw new Error('Usage: node scripts/run-live-popup-switch-smoke.js --authList <file1,file2[,file3]> [--headed]');
  }

  const fixtures = fixturePaths.map(readFixture);
  const importAccounts = fixtures.map(toImportAccount);
  const importPayload = { version: 1, exportedAt: new Date().toISOString(), accounts: importAccounts };

  const tmpDir = path.join(__dirname, '..', '.agent');
  fs.mkdirSync(tmpDir, { recursive: true });
  const importFile = path.join(tmpDir, `tmp-live-popup-import-${Date.now()}.json`);
  fs.writeFileSync(importFile, JSON.stringify(importPayload, null, 2), 'utf8');

  const { context, serviceWorker, extensionId } = await launchExtensionContext({ headless: !args.headed });
  try {
    await context.addCookies(fixtures[0].cookies.map(normalizeCookieForPlaywright));
    const page = context.pages()[0] || await context.newPage();
    await page.goto('https://jimeng.jianying.com/ai-tool/home', { waitUntil: 'domcontentloaded', timeout: 30000 });
    const initialIdentity = await waitForPageUser(page, importAccounts[0].userId, 45000);
    if (!initialIdentity.success) {
      throw new Error(`Initial login did not match ${importAccounts[0].name}: expected ${importAccounts[0].userId}, got ${initialIdentity.actual || '<empty>'}`);
    }

    const storedAccountsForSwitch = args.dirtyStoredMetadata
      ? await seedDirtyStoredAccounts(serviceWorker, importAccounts)
      : await importAccountsViaPopup({ context, extensionId, importFile });
    const importedNames = storedAccountsForSwitch.map(account => typeof account === 'string' ? account : account.name);
    await calibrateNewTabDetector(context);
    const settingsAfterImport = await serviceWorker.evaluate(async () => await loadSettings());
    await new Promise(resolve => setTimeout(resolve, 2000));

    const targetAccounts = args.dirtyStoredMetadata ? storedAccountsForSwitch : importAccounts;
    const targets = [...targetAccounts.slice(1), targetAccounts[0]];
    const switchResults = [];
    for (const target of targets) {
      switchResults.push(await clickSwitchViaPopup({
        context,
        extensionId,
        page,
        serviceWorker,
        target,
      }));
    }

    const finalTabs = await getJimengTabs(serviceWorker);
    const output = {
      mode: args.headed ? 'headed' : 'headless',
      scenario: args.dirtyStoredMetadata ? 'dirty-stored-metadata' : 'popup-import-clean',
      calibration: {
        newJimengTabDetector: 'passed',
      },
      settings: {
        autoSaveOnLogin: settingsAfterImport.autoSaveOnLogin !== false,
      },
      importedNames,
      initialIdentity: {
        expectedUserId: importAccounts[0].userId,
        actualUserId: initialIdentity.actual,
      },
      switchResults: switchResults.map(result => ({
        target: result.target,
        expectedUserId: result.expectedUserId,
        actualUserId: result.actualUserId,
        identityOk: result.identityOk,
        beforeJimengTabCount: result.beforeTabs.length,
        afterJimengTabCount: result.afterTabs.length,
        noExtraFinalJimengTab: result.noExtraFinalJimengTab,
        createdJimengTabsDuringSwitch: result.createdJimengTabsDuringSwitch,
        activeCard: result.activeCard,
        storedAfter: result.storedAfter,
        seededCreditsTotal: result.seededCreditsTotal,
      })),
      finalJimengTabs: finalTabs,
    };

    const failures = [];
    for (const result of switchResults) {
      if (!result.identityOk) {
        failures.push(`identity mismatch after switching to ${result.target}: expected ${result.expectedUserId}, got ${result.actualUserId || '<empty>'}`);
      }
      if (!result.noExtraFinalJimengTab) {
        failures.push(`final Jimeng tab count increased after switching to ${result.target}: ${result.beforeTabs.length} -> ${result.afterTabs.length}`);
      }
      if (result.createdJimengTabsDuringSwitch.length) {
        failures.push(`new Jimeng tab was created while switching to ${result.target}: ${result.createdJimengTabsDuringSwitch.join(', ')}`);
      }
      if (result.storedAfter?.userId && String(result.storedAfter.userId) !== String(result.expectedUserId)) {
        failures.push(`stored account userId mismatch after switching to ${result.target}: expected ${result.expectedUserId}, got ${result.storedAfter.userId}`);
      }
      if (!result.activeCard?.creditsText) {
        failures.push(`active popup card did not display credits after switching to ${result.target}`);
      }
      if (result.seededCreditsTotal != null && result.storedAfter?.creditsTotal === result.seededCreditsTotal) {
        failures.push(`stored credits remained at seeded bogus value after switching to ${result.target}: ${result.seededCreditsTotal}`);
      }
    }
    output.failures = failures;
    console.log(JSON.stringify(output, null, 2));

    if (failures.length) {
      throw new Error(`Live popup switch smoke failed (${failures.length}): ${failures.join(' | ')}`);
    }
  } finally {
    await context.close().catch(() => {});
    fs.rmSync(importFile, { force: true });
  }
}

main().catch(error => {
  console.error(error && error.stack ? error.stack : String(error));
  process.exit(1);
});
