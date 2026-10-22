// Talks to Banking Aid for the content script (an extension may reach a
// plain-http server from an https bank page; the page itself may not) and
// catches the bank's own downloads while a statement is being fetched: the
// download is cancelled and its file is sent to Banking Aid instead.
//
// Nothing about the user lives in this code: the Banking Aid address, its
// API token and the bank sites to run on are settings, kept in the browser.

const settings = async () => ({ url: '', token: '', sites: [], ...(await browser.storage.local.get(['url', 'token', 'sites'])) });

async function ba(path, init = {}) {
  const { url, token } = await settings();
  if (!url) throw new Error('Set your Banking Aid address in the extension’s settings');
  // without Firefox's permission for the host the request is blocked outright
  // ("NetworkError"); say what to do instead
  const u = new URL(url);
  if (!await browser.permissions.contains({ origins: [`${u.protocol}//${u.hostname}/*`] })) {
    throw new Error(`Firefox hasn’t given the add-on access to ${u.hostname} yet: open Settings, press Save & test and allow it`);
  }
  const headers = { ...(init.headers || {}) };
  if (token) headers.authorization = 'Bearer ' + token;
  const r = await fetch(url.replace(/\/$/, '') + path, { ...init, headers, credentials: 'include' });
  const body = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(body.error || `Banking Aid answered ${r.status}`);
  return body;
}

async function upload({ card, name, bytes }) {
  const form = new FormData();
  form.append('account', card || 'Unsorted');
  form.append('files', new File([bytes], name.replace(/[^\w .()-]/g, '_'), { type: 'application/pdf' }));
  await ba('/api/import?async=1', { method: 'POST', body: form });
  return { ok: true };
}

const isPdf = bytes => bytes && bytes.byteLength > 500 && String.fromCharCode(...new Uint8Array(bytes.slice(0, 5))) === '%PDF-';

// ── which bank sites the page script runs on ──────────────────────────────
// registered from the settings, so no bank is named in the add-on itself
const patternsFor = sites => sites.flatMap(s => [`https://${s}/*`, `https://*.${s}/*`]);
let registered = null;
async function registerSites() {
  if (registered) { await registered.unregister(); registered = null; }
  const { sites } = await settings();
  if (!sites.length) return;
  registered = await browser.contentScripts.register({ matches: patternsFor(sites), js: [{ file: 'content.js' }], runAt: 'document_idle' });
}
registerSites();
browser.storage.onChanged.addListener(changes => { if (changes.sites) registerSites(); });

// ── catching the bank's download ──────────────────────────────────────────
// armed: the tab waiting for a statement. A download that starts while armed
// never reaches the Downloads folder.
let armed = null; // { tabId, until }
browser.downloads.onCreated.addListener(async item => {
  if (!armed || Date.now() > armed.until) return;
  const { tabId } = armed;
  armed = null;
  try { await browser.downloads.cancel(item.id); } catch { /* already done */ }
  try { await browser.downloads.erase({ id: item.id }); } catch { /* not listed */ }
  // a blob: URL belongs to the page — only the tab can read it
  browser.tabs.sendMessage(tabId, { type: 'download-caught', url: item.url });
});

browser.runtime.onMessage.addListener(async (msg, sender) => {
  switch (msg.type) {
    case 'gaps': return ba('/api/statements/gaps');
    case 'arm': armed = { tabId: sender.tab.id, until: Date.now() + (msg.ms || 30000) }; return { ok: true };
    case 'disarm': if (armed && armed.tabId === sender.tab.id) armed = null; return { ok: true };
    // a statement's file, read by the tab or fetched here from an https link
    case 'upload': {
      let bytes = msg.bytes;
      if (!bytes && msg.url) {
        const r = await fetch(msg.url, { credentials: 'include' });
        bytes = await r.arrayBuffer();
      }
      if (!isPdf(bytes)) return { ok: false, error: 'not a PDF' };
      try { return await upload({ card: msg.card, name: msg.name, bytes }); }
      catch (e) { return { ok: false, error: e.message }; }
    }
    case 'test': {
      try { const g = await ba('/api/statements/gaps'); return { ok: true, cards: g.cards.length }; }
      catch (e) { return { ok: false, error: e.message }; }
    }
  }
});
