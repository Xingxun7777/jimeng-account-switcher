const {
  authFile,
  launchExtensionContext,
  parseArgs,
  writeJson,
} = require('./playwright-extension-utils');

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const label = args.label;
  const userDataDir = args.userDataDir;
  const accountName = args.accountName;
  const accountId = args.accountId;

  if (!label || !userDataDir || (!accountName && !accountId)) {
    throw new Error('Usage: node scripts/export-saved-account-auth.js --label <name> --userDataDir <path> [--accountName <name> | --accountId <id>]');
  }

  const { context, serviceWorker } = await launchExtensionContext({ userDataDir, headless: true });
  try {
    const payload = await serviceWorker.evaluate(async ({ label, accountName, accountId }) => {
      const accounts = (await chrome.storage.local.get('jimeng_accounts')).jimeng_accounts || [];
      const account = accounts.find((item) => item.id === accountId || item.name === accountName);
      if (!account) {
        throw new Error(`Saved account not found: ${accountName || accountId}`);
      }
      return {
        label,
        capturedAt: new Date().toISOString(),
        source: 'saved-account',
        cookies: account.cookies || [],
        user: {
          userId: account.userId || '',
          nickname: account.nickname || '',
          avatar: account.avatar || '',
        },
        savedAccount: {
          id: account.id,
          name: account.name,
          sessionValid: account.sessionValid,
        },
      };
    }, { label, accountName: accountName || null, accountId: accountId || null });

    const file = authFile(label);
    await writeJson(file, payload);
    console.log(JSON.stringify({ ok: true, file, label, cookieCount: payload.cookies.length, user: payload.user, savedAccount: payload.savedAccount }, null, 2));
  } finally {
    await context.close();
  }
}

main().catch((error) => {
  console.error(error && error.stack ? error.stack : String(error));
  process.exit(1);
});
