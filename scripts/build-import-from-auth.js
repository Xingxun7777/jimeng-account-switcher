const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { parseArgs } = require('./playwright-extension-utils');

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function toImportAccount(auth) {
  const now = Date.now();
  return {
    id: crypto.randomUUID(),
    name: auth.label || auth.user?.nickname || '未命名账号',
    userId: String(auth.user?.userId || ''),
    nickname: auth.user?.nickname || '',
    avatar: auth.user?.avatar || '',
    cookies: Array.isArray(auth.cookies) ? auth.cookies : [],
    savedAt: now,
    cachedCredits: auth.status?.credits || null,
    cachedVip: auth.status?.vip || null,
    sessionValid: auth.status?.valid === true,
    lastChecked: now,
  };
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const authList = String(args.authList || '')
    .split(',')
    .map(item => item.trim())
    .filter(Boolean);
  const output = args.output || path.resolve(process.cwd(), 'jimeng-accounts-import.json');

  if (authList.length === 0) {
    throw new Error('Usage: node scripts/build-import-from-auth.js --authList <file1,file2[,file3]> [--output <path>]');
  }

  const accounts = authList.map(readJson).map(toImportAccount);
  const payload = {
    version: 1,
    exportedAt: new Date().toISOString(),
    accounts,
  };

  fs.writeFileSync(output, JSON.stringify(payload, null, 2), 'utf8');
  console.log(JSON.stringify({
    ok: true,
    output,
    count: accounts.length,
    names: accounts.map(account => account.name),
  }, null, 2));
}

try {
  main();
} catch (error) {
  console.error(error && error.stack ? error.stack : String(error));
  process.exit(1);
}
