const {
  launchExtensionContext,
  normalizeCookieForPlaywright,
  parseArgs,
} = require('./playwright-extension-utils');
const fs = require('fs');

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

function summarizeSaveResult(result) {
  if (!result) return null;
  if (!result.success) {
    return {
      success: false,
      error: result.error || 'unknown error',
    };
  }
  return {
    success: true,
    isUpdate: !!result.isUpdate,
    account: result.account ? {
      id: result.account.id,
      name: result.account.name,
      userId: result.account.userId,
      nickname: result.account.nickname,
      sessionValid: result.account.sessionValid,
      cookieCount: Array.isArray(result.account.cookies) ? result.account.cookies.length : 0,
    } : null,
  };
}

function summarizeSwitchResult(result) {
  if (!result) return null;
  if (!result.success) {
    return {
      success: false,
      error: result.error || 'unknown error',
      rolledBack: result.rolledBack || null,
    };
  }
  return {
    success: true,
    account: result.account ? {
      id: result.account.id,
      name: result.account.name,
      userId: result.account.userId,
      nickname: result.account.nickname,
      sessionValid: result.account.sessionValid,
    } : null,
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const fixturePaths = fixtureArgsToList(args);

  if (fixturePaths.length < 2) {
    throw new Error('Usage: node scripts/run-live-auth-switch-smoke.js --authList <file1,file2[,file3]>');
  }

  const fixtures = fixturePaths.map(readFixture);

  const { context, serviceWorker } = await launchExtensionContext({ headless: true });
  try {
    const page = context.pages()[0] || await context.newPage();
    await page.goto('https://jimeng.jianying.com/ai-tool/home', { waitUntil: 'domcontentloaded' });
    // The smoke test seeds saved accounts by directly invoking service-worker
    // functions instead of going through the popup message router. Disable the
    // optional auto-save listener so tab/cookie events from the fixture setup do
    // not race the direct calls and make the tab-count assertion flaky.
    await serviceWorker.evaluate(async () => {
      await chrome.storage.local.set({
        jimeng_settings: { saveDraftName: '', repairAccountId: null, autoSaveOnLogin: false },
      });
    });

    const saveResults = [];
    for (let i = 0; i < fixtures.length; i += 1) {
      const fixture = fixtures[i];
      if (i > 0) {
        await serviceWorker.evaluate(async () => { await clearDomainCookies(); });
      }
      await context.addCookies(fixture.cookies.map(normalizeCookieForPlaywright));
      const saveResult = await serviceWorker.evaluate(async ({ label }) => await saveCurrentAccount(label), { label: fixture.label });
      saveResults.push(saveResult);
    }

    const accounts = await serviceWorker.evaluate(async () => (await chrome.storage.local.get('jimeng_accounts')).jimeng_accounts || []);
    const accountsByLabel = new Map(fixtures.map(fixture => [fixture.label, accounts.find((item) => item.name === fixture.label) || null]));

    const captureStatus = async () => await serviceWorker.evaluate(async () => {
      const session = new JimengTabSession();
      try {
        await session.ensure();
        return await fetchStatusViaSession(session);
      } finally {
        await session.cleanup();
      }
    });

    const beforePages = context.pages().filter((p) => p.url().startsWith('https://jimeng.jianying.com/')).length;
    const switchResults = [];
    const statusAfterSwitch = [];
    for (const fixture of fixtures) {
      const targetAccount = accountsByLabel.get(fixture.label);
      const switchResult = targetAccount
        ? await serviceWorker.evaluate(async ({ id }) => await switchAccount(id), { id: targetAccount.id })
        : null;
      switchResults.push({ label: fixture.label, result: switchResult });
      statusAfterSwitch.push({ label: fixture.label, status: await captureStatus() });
    }
    const afterPages = context.pages().filter((p) => p.url().startsWith('https://jimeng.jianying.com/')).length;

    const output = {
      saveResults: fixtures.map((fixture, index) => ({
        label: fixture.label,
        result: summarizeSaveResult(saveResults[index]),
      })),
      storedAccounts: accounts.map((item) => ({
        name: item.name,
        userId: item.userId,
        nickname: item.nickname,
        sessionValid: item.sessionValid,
      })),
      switchResults: switchResults.map((item, index) => ({
        label: item.label,
        result: summarizeSwitchResult(item.result),
        statusAfter: {
          valid: statusAfterSwitch[index].status.valid,
          userId: statusAfterSwitch[index].status.user?.userId || '',
          nickname: statusAfterSwitch[index].status.user?.nickname || '',
        },
      })),
      noNewTabOnSwitch: beforePages === afterPages,
    };

    const failures = [];
    for (let i = 0; i < fixtures.length; i += 1) {
      const fixture = fixtures[i];
      const saveResult = saveResults[i];
      const account = accountsByLabel.get(fixture.label);
      const switchResult = switchResults[i]?.result;
      const switchStatus = statusAfterSwitch[i]?.status;

      if (!saveResult?.success) failures.push(`save ${fixture.label} failed: ${saveResult?.error || 'unknown error'}`);
      if (!account) failures.push(`${fixture.label} was not persisted to storage`);
      if (saveResult?.success && (!saveResult.account?.sessionValid || !saveResult.account?.userId)) {
        failures.push(`save ${fixture.label} produced an invalid or unidentified account`);
      }
      if (account && !switchResult?.success) failures.push(`switch ${fixture.label} failed: ${switchResult?.error || 'unknown error'}`);
      if (account && switchStatus?.user?.userId !== account.userId) {
        failures.push(`status after switching to ${fixture.label} mismatched: expected ${account.userId || '<empty>'}, got ${switchStatus?.user?.userId || '<empty>'}`);
      }
    }
    if (!output.noNewTabOnSwitch) failures.push('switch flow opened an unexpected new Jimeng tab');

    output.failures = failures;
    console.log(JSON.stringify(output, null, 2));

    if (failures.length) {
      throw new Error(`Live auth smoke failed (${failures.length}): ${failures.join(' | ')}`);
    }
  } finally {
    await context.close();
  }
}

main().catch((error) => {
  console.error(error && error.stack ? error.stack : String(error));
  process.exit(1);
});
