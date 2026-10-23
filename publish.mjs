#!/usr/bin/env node
/* One-command release: privacy check -> bump version -> sign with Mozilla
   (unlisted: self-distributed, nothing is listed on AMO) -> releases/*.xpi +
   updates.json -> git push. Firefox then updates itself from updates.json
   (the manifest's update_url).

   Usage:  node publish.mjs            (bumps the patch version)
           node publish.mjs 1.1.0      (sets an explicit version)
           node publish.mjs --no-push  (everything except git push)

   Needs:  C:\Claude_Storage\Authentication\amo_api.json  ->  { "issuer": "user:…", "secret": "…" }
   Guard:  C:\Claude_Storage\Authentication\private-terms.txt — one regex per
           line (names, account numbers, addresses, private hosts). Kept OUTSIDE
           this public repo; any match in what would be published stops the release. */
import { readFileSync, writeFileSync, mkdirSync, readdirSync, copyFileSync, existsSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { execSync } from 'node:child_process';
import path from 'node:path';

const root = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
const ext = path.join(root, 'extension');
const manifestPath = path.join(ext, 'manifest.json');
const keysPath = 'C:/Claude_Storage/Authentication/amo_api.json';
const termsPath = 'C:/Claude_Storage/Authentication/private-terms.txt';
const RAW_BASE = 'https://raw.githubusercontent.com/tomshomelab/statement-fetcher/main';

const args = process.argv.slice(2);
const noPush = args.includes('--no-push');
const explicit = args.find((a) => /^\d+\.\d+\.\d+$/.test(a));
const run = (cmd, opts = {}) => { console.log(`> ${cmd.replace(/--api-(key|secret) "[^"]*"/g, '--api-$1 ***')}`); return execSync(cmd, { cwd: root, stdio: 'inherit', ...opts }); };

// 0. preflight: keys, and nothing personal in anything that would go public
for (const p of [keysPath, termsPath]) if (!existsSync(p)) { console.error(`Missing ${p}`); process.exit(1); }
const keys = JSON.parse(readFileSync(keysPath, 'utf8'));
const terms = readFileSync(termsPath, 'utf8').split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !l.startsWith('#')).map((l) => new RegExp(l, 'i'));
const tracked = execSync('git ls-files --cached --others --exclude-standard', { cwd: root, encoding: 'utf8' }).split('\n').filter(Boolean);
const hits = [];
for (const f of tracked) {
  if (/\.(xpi|png|jpg)$/i.test(f)) continue;
  const text = readFileSync(path.join(root, f), 'utf8');
  for (const re of terms) if (re.test(text)) hits.push(`${f}: matches a private term (line ${terms.indexOf(re) + 1} of private-terms.txt)`);
}
const ident = execSync('git config user.email', { cwd: root, encoding: 'utf8' }).trim();
if (!/noreply\.github\.com$/.test(ident)) hits.push(`git user.email is ${ident ? 'not a GitHub no-reply address' : 'unset'}`);
if (hits.length) { console.error('Privacy check failed — nothing published:\n  ' + hits.join('\n  ')); process.exit(1); }
console.log(`Privacy check passed (${tracked.length} files, ${terms.length} terms)`);

const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
const addonId = manifest.browser_specific_settings.gecko.id;

// 1. bump version
const [maj, min, pat] = manifest.version.split('.').map(Number);
const version = explicit || `${maj}.${min}.${pat + 1}`;
manifest.version = version;
writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n');
console.log(`Version ${version}`);

// 2. lint + sign
run('npx --yes web-ext lint --source-dir extension --self-hosted');
const signedDir = path.join(root, 'dist', 'signed');
mkdirSync(signedDir, { recursive: true });
// keys go in through the environment, never the command line: a failed
// command's error message prints its whole command line
run(`npx --yes web-ext sign --source-dir extension --artifacts-dir "${signedDir}" --channel unlisted`, { env: { ...process.env, WEB_EXT_API_KEY: keys.issuer, WEB_EXT_API_SECRET: keys.secret } });

// 3. the freshly signed xpi
const xpi = readdirSync(signedDir).filter((f) => f.endsWith('.xpi') && f.includes(version))
  .map((f) => path.join(signedDir, f)).sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs)[0];
if (!xpi) { console.error('No signed xpi found'); process.exit(1); }

// 4. releases/ + updates.json
const relDir = path.join(root, 'releases');
mkdirSync(relDir, { recursive: true });
const outName = `statement_fetcher-${version}.xpi`;
copyFileSync(xpi, path.join(relDir, outName));
copyFileSync(xpi, path.join(relDir, 'latest.xpi')); // a link that always installs the newest
const hash = createHash('sha256').update(readFileSync(xpi)).digest('hex');
const updatesPath = path.join(root, 'updates.json');
const updates = existsSync(updatesPath) ? JSON.parse(readFileSync(updatesPath, 'utf8')) : { addons: {} };
const entry = updates.addons[addonId] || (updates.addons[addonId] = { updates: [] });
entry.updates = entry.updates.filter((u) => u.version !== version);
entry.updates.push({ version, update_link: `${RAW_BASE}/releases/${outName}`, update_hash: `sha256:${hash}` });
entry.updates = entry.updates.slice(-5);
writeFileSync(updatesPath, JSON.stringify(updates, null, 2) + '\n');
console.log(`releases/${outName} + updates.json written`);

// 5. commit + push
run('git add -A');
run(`git commit -m "Release ${version}" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"`);
if (!noPush) run('git push');
console.log(`\nDone. Firefox with ${addonId} picks up ${version} on its next update check.`);
