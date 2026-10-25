#!/usr/bin/env node
/* The Chrome / Opera build: the Firefox add-on's own scripts, a Manifest V3
   manifest, PNG icons and chrome/compat.js (Firefox's `browser` calls on
   Chrome's API). Writes dist/chrome (load it unpacked: chrome://extensions or
   opera://extensions → Developer mode → Load unpacked) and
   dist/statement-fetcher-chrome-<version>.zip (for the Chrome Web Store).

   Usage:  node build-chrome.mjs

   Guard:  the same private-terms check as publish.mjs, when the terms file
           is on this machine — nothing personal goes into a build. */
import { readFileSync, writeFileSync, mkdirSync, rmSync, readdirSync, copyFileSync, existsSync } from 'node:fs';
import { execSync } from 'node:child_process';
import path from 'node:path';

const root = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
const ext = path.join(root, 'extension');
const out = path.join(root, 'dist', 'chrome');
const termsPath = 'C:/Claude_Storage/Authentication/private-terms.txt';
const ff = JSON.parse(readFileSync(path.join(ext, 'manifest.json'), 'utf8'));

rmSync(out, { recursive: true, force: true });
mkdirSync(path.join(out, 'icons'), { recursive: true });
for (const f of readdirSync(ext)) if (/\.(js|html)$/.test(f)) copyFileSync(path.join(ext, f), path.join(out, f));
for (const f of ['compat.js', 'sw.js']) copyFileSync(path.join(root, 'chrome', f), path.join(out, f));
for (const f of readdirSync(path.join(root, 'chrome', 'icons'))) copyFileSync(path.join(root, 'chrome', 'icons', f), path.join(out, 'icons', f));

// the add-on's own pages load the compatibility layer before anything else
for (const f of readdirSync(out).filter(f => f.endsWith('.html'))) {
  const p = path.join(out, f);
  const html = readFileSync(p, 'utf8');
  if (!html.includes('compat.js')) writeFileSync(p, html.replace(/<script\b/, '<script src="compat.js"></script>\n  <script'));
}

const icons = { 16: 'icons/icon16.png', 32: 'icons/icon32.png', 48: 'icons/icon48.png', 128: 'icons/icon128.png' };
const manifest = {
  manifest_version: 3,
  name: ff.name,
  version: ff.version,
  description: ff.description,
  minimum_chrome_version: '110',
  icons,
  // contentSettings: a bank site may download several statements in a row
  permissions: ['storage', 'downloads', 'tabs', 'scripting', 'contentSettings'],
  // asked for one site at a time: Banking Aid's address, then each bank
  optional_host_permissions: ['http://*/*', 'https://*/*'],
  background: { service_worker: 'sw.js' },
  action: { default_title: ff.browser_action?.default_title || ff.name, default_popup: 'popup.html', default_icon: icons },
  options_ui: { page: 'options.html', open_in_tab: true }
};
writeFileSync(path.join(out, 'manifest.json'), JSON.stringify(manifest, null, 2));

if (existsSync(termsPath)) {
  const terms = readFileSync(termsPath, 'utf8').split(/\r?\n/).map(l => l.trim()).filter(l => l && !l.startsWith('#')).map(l => new RegExp(l, 'i'));
  for (const f of readdirSync(out).filter(f => /\.(js|html|json)$/.test(f))) {
    const text = readFileSync(path.join(out, f), 'utf8');
    const i = terms.findIndex(re => re.test(text));
    if (i >= 0) { console.error(`  ${f}: matches a private term (line ${i + 1} of private-terms.txt) — not built`); rmSync(out, { recursive: true, force: true }); process.exit(1); }
  }
}

const zip = path.join(root, 'dist', `statement-fetcher-chrome-${ff.version}.zip`);
rmSync(zip, { force: true });
execSync(`powershell -NoProfile -Command "Compress-Archive -Path '${out}\\*' -DestinationPath '${zip}'"`, { stdio: 'inherit' });
console.log(`Built ${ff.version} for Chrome / Opera:\n  unpacked: ${out}\n  zip:      ${zip}`);
