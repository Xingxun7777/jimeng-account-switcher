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

  if (!label || !userDataDir) {
    throw new Error('Usage: node scripts/export-current-auth.js --label <name> --userDataDir <path>');
  }

  const { context, serviceWorker } = await launchExtensionContext({ userDataDir, headless: true });
  try {
    const payload = await serviceWorker.evaluate(async ({ label }) => {
      const cookies = await getAllDomainCookies();
      const session = new JimengTabSession();
      let status = null;
      try {
        await session.ensure();
        status = await fetchStatusViaSession(session);
      } finally {
        await session.cleanup();
      }

      return {
        label,
        capturedAt: new Date().toISOString(),
        cookies,
        user: status?.user || null,
        status: {
          valid: !!status?.valid,
          credits: status?.credits || null,
          vip: status?.vip || null,
        },
      };
    }, { label });

    const file = authFile(label);
    await writeJson(file, payload);
    console.log(JSON.stringify({ ok: true, file, label, cookieCount: payload.cookies.length, user: payload.user }, null, 2));
  } finally {
    await context.close();
  }
}

main().catch((error) => {
  console.error(error && error.stack ? error.stack : String(error));
  process.exit(1);
});
