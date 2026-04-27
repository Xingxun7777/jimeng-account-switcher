const fs = require('fs');
const path = require('path');
const { chromium } = require('@playwright/test');

const REPO_ROOT = path.resolve(__dirname, '..');
const AUTH_DIR = path.join(REPO_ROOT, '.auth');

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    const item = argv[i];
    if (!item.startsWith('--')) continue;
    const key = item.slice(2);
    const next = argv[i + 1];
    if (!next || next.startsWith('--')) out[key] = true;
    else {
      out[key] = next;
      i += 1;
    }
  }
  return out;
}

function ensureAuthDir() {
  fs.mkdirSync(AUTH_DIR, { recursive: true });
}

function authFile(label) {
  ensureAuthDir();
  return path.join(AUTH_DIR, `${label}.json`);
}

async function launchExtensionContext({ userDataDir, headless = true } = {}) {
  const context = await chromium.launchPersistentContext(userDataDir || '', {
    channel: 'chromium',
    headless,
    args: [
      `--disable-extensions-except=${REPO_ROOT}`,
      `--load-extension=${REPO_ROOT}`,
    ],
  });
  let [serviceWorker] = context.serviceWorkers();
  if (!serviceWorker) {
    serviceWorker = await context.waitForEvent('serviceworker', { timeout: 15000 });
  }
  const extensionId = serviceWorker.url().split('/')[2];
  return { context, serviceWorker, extensionId };
}

async function writeJson(filePath, data) {
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf8');
}

function normalizeCookieForPlaywright(cookie) {
  const sameSiteMap = {
    no_restriction: 'None',
    lax: 'Lax',
    strict: 'Strict',
    unspecified: undefined,
  };

  const normalized = {
    name: cookie.name,
    value: cookie.value,
    domain: cookie.domain,
    path: cookie.path || '/',
    secure: !!cookie.secure,
    httpOnly: !!cookie.httpOnly,
  };

  const sameSite = sameSiteMap[cookie.sameSite] || cookie.sameSite;
  if (sameSite === 'None' || sameSite === 'Lax' || sameSite === 'Strict') {
    normalized.sameSite = sameSite;
  }

  if (typeof cookie.expirationDate === 'number') {
    normalized.expires = cookie.expirationDate;
  } else if (typeof cookie.expires === 'number') {
    normalized.expires = cookie.expires;
  }

  return normalized;
}

module.exports = {
  AUTH_DIR,
  REPO_ROOT,
  authFile,
  ensureAuthDir,
  launchExtensionContext,
  normalizeCookieForPlaywright,
  parseArgs,
  writeJson,
};
