const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  AUTH_DIR,
  launchExtensionContext,
  parseArgs,
  writeJson,
} = require('./playwright-extension-utils');

const JIMENG_HOME = 'https://jimeng.jianying.com/ai-tool/home';

function sanitizeProfileName(name) {
  return String(name || 'account')
    .trim()
    .replace(/[^a-zA-Z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    || 'account';
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const profileName = sanitizeProfileName(args.profileName || args.label || 'account');
  const userDataDir = args.userDataDir || fs.mkdtempSync(path.join(os.tmpdir(), `jimeng-login-${profileName}-`));

  fs.mkdirSync(AUTH_DIR, { recursive: true });

  const { context, extensionId } = await launchExtensionContext({
    userDataDir,
    headless: false,
  });

  const metadataFile = path.join(AUTH_DIR, `login-session-${profileName}.json`);
  await writeJson(metadataFile, {
    profileName,
    userDataDir,
    extensionId,
    openedAt: new Date().toISOString(),
  });

  const page = context.pages()[0] || await context.newPage();
  await page.goto(JIMENG_HOME, { waitUntil: 'domcontentloaded' });

  const popup = await context.newPage();
  await popup.goto(`chrome-extension://${extensionId}/popup/popup.html`, { waitUntil: 'domcontentloaded' });

  console.log(JSON.stringify({
    ok: true,
    profileName,
    userDataDir,
    extensionId,
    metadataFile,
    message: 'Login window is ready. Keep this process running until login is complete.',
  }, null, 2));

  const shutdown = async () => {
    try { await context.close(); } catch {}
    process.exit(0);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
  await new Promise(() => {});
}

main().catch((error) => {
  console.error(error && error.stack ? error.stack : String(error));
  process.exit(1);
});
