#!/usr/bin/env node
/* Finishes a release whose signing outlived web-ext's wait: asks Mozilla's
   API for the version, and once its file is signed downloads it and does
   publish.mjs's last steps (releases/, latest.xpi, updates.json, push).
   Usage: node fetch-signed.mjs 1.0.10 [--no-push]
   Keys from C:\Claude_Storage\Authentication\amo_api.json; never printed. */
import { readFileSync, writeFileSync, mkdirSync, copyFileSync, existsSync } from 'node:fs';
import { createHmac, createHash, randomUUID } from 'node:crypto';
import { execSync } from 'node:child_process';
import path from 'node:path';

const root = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
const version = process.argv[2];
const noPush = process.argv.includes('--no-push');
if (!/^\d+\.\d+\.\d+$/.test(version || '')) { console.error('Usage: node fetch-signed.mjs <version>'); process.exit(1); }
const keys = JSON.parse(readFileSync('C:/Claude_Storage/Authentication/amo_api.json', 'utf8'));
const manifest = JSON.parse(readFileSync(path.join(root, 'extension', 'manifest.json'), 'utf8'));
const addonId = manifest.browser_specific_settings.gecko.id;
const RAW_BASE = 'https://raw.githubusercontent.com/tomshomelab/statement-fetcher/main';

// AMO's JWT: HS256 over {iss, jti, iat, exp}
const b64 = o => Buffer.from(JSON.stringify(o)).toString('base64url');
const jwt = () => {
  const now = Math.floor(Date.now() / 1000);
  const body = `${b64({ alg: 'HS256', typ: 'JWT' })}.${b64({ iss: keys.issuer, jti: randomUUID(), iat: now, exp: now + 60 })}`;
  return `${body}.${createHmac('sha256', keys.secret).update(body).digest('base64url')}`;
};
const api = async url => {
  const r = await fetch(url, { headers: { authorization: `JWT ${jwt()}` } });
  if (!r.ok) throw new Error(`AMO answered ${r.status}`);
  return r;
};

const v = await (await api(`https://addons.mozilla.org/api/v5/addons/addon/${encodeURIComponent(addonId)}/versions/v${version}/`)).json();
const file = v.file || {};
console.log(`Version ${version}: file status ${file.status || 'unknown'}`);
if (file.status !== 'public' || !file.url) { console.log('Not signed yet; run this again in a few minutes.'); process.exit(2); }

const bytes = Buffer.from(await (await api(file.url)).arrayBuffer());
const relDir = path.join(root, 'releases');
mkdirSync(relDir, { recursive: true });
const outName = `statement_fetcher-${version}.xpi`;
writeFileSync(path.join(relDir, outName), bytes);
copyFileSync(path.join(relDir, outName), path.join(relDir, 'latest.xpi'));
const hash = createHash('sha256').update(bytes).digest('hex');
const updatesPath = path.join(root, 'updates.json');
const updates = existsSync(updatesPath) ? JSON.parse(readFileSync(updatesPath, 'utf8')) : { addons: {} };
const entry = updates.addons[addonId] || (updates.addons[addonId] = { updates: [] });
entry.updates = entry.updates.filter(u => u.version !== version);
entry.updates.push({ version, update_link: `${RAW_BASE}/releases/${outName}`, update_hash: `sha256:${hash}` });
entry.updates = entry.updates.slice(-5);
writeFileSync(updatesPath, JSON.stringify(updates, null, 2) + '\n');
console.log(`releases/${outName} + latest.xpi + updates.json written`);
execSync('git add -A', { cwd: root, stdio: 'inherit' });
execSync(`git commit -m "Release ${version}" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"`, { cwd: root, stdio: 'inherit' });
if (!noPush) execSync('git push', { cwd: root, stdio: 'inherit' });
console.log('Done.');
