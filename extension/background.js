// Talks to Banking Aid for the content script (an extension may reach a
// plain-http server from an https bank page; the page itself may not) and
// catches the bank's own downloads while a statement is being fetched: the
// download is cancelled and its file is sent to Banking Aid instead.
//
// Nothing about the user lives in this code: the Banking Aid address, its
// API token and the bank sites to run on are settings, kept in the browser.

const settings = async () => ({ url: '', token: '', sites: [], ...(await browser.storage.local.get(['url', 'token', 'sites'])) });

// cfg: the address and token, sent along by the menu or the page panel —
// reading storage here failed in some Firefox profiles ("An unexpected error
// occurred"), so the background only falls back to it
async function ba(path, init = {}, cfg = null) {
  let url, token;
  try { ({ url, token } = cfg && cfg.url ? cfg : await settings()); }
  catch (e) { throw new Error('reading the add-on’s settings failed (' + e.message + ')'); }
  if (!url) throw new Error('Set your Banking Aid address in the extension’s settings');
  const headers = { ...(init.headers || {}) };
  if (token) headers.authorization = 'Bearer ' + token;
  let r;
  try { r = await fetch(url.replace(/\/$/, '') + path, { ...init, headers, credentials: 'include' }); }
  catch (e) {
    // blocked before it left the browser: usually Firefox's permission for the
    // host is missing ("NetworkError"); say what to do instead
    const host = new URL(url).hostname;
    throw new Error(`Couldn’t reach Banking Aid at ${host} (${e.message}). If Firefox hasn’t been allowed access to ${host}, open Settings, press Save & test and choose Allow; otherwise check Banking Aid is running`);
  }
  const body = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(r.status === 401 ? 'Banking Aid didn’t accept the API token: copy it again from Banking Aid → Settings' : (body.error || `Banking Aid answered ${r.status}`));
  return body;
}

async function upload({ card, name, bytes }, cfg) {
  const form = new FormData();
  form.append('account', card || 'Unsorted');
  form.append('files', new File([bytes], name.replace(/[^\w .()-]/g, '_'), { type: 'application/pdf' }));
  await ba('/api/import?async=1', { method: 'POST', body: form }, cfg);
  return { ok: true };
}

const isPdf = bytes => bytes && bytes.byteLength > 500 && String.fromCharCode(...new Uint8Array(bytes.slice(0, 5))) === '%PDF-';

// ── which bank sites the page script runs on ──────────────────────────────
// registered from the settings, so no bank is named in the add-on itself
const patternsFor = sites => sites.flatMap(s => [`https://${s}/*`, `https://*.${s}/*`]);
let registered = null;
// only sites Firefox has actually allowed: registering one it hasn't throws
async function registerSites() {
  try {
    if (registered) { await registered.unregister(); registered = null; }
    const { sites } = await settings();
    const allowed = [];
    for (const s of sites) if (await browser.permissions.contains({ origins: patternsFor([s]) }).catch(() => false)) allowed.push(s);
    if (allowed.length) registered = await browser.contentScripts.register({ matches: patternsFor(allowed), js: [{ file: 'log.js' }, { file: 'rpc.js' }, { file: 'content.js' }], runAt: 'document_idle' });
  } catch (e) { console.warn('statement fetcher: could not register sites', e); }
}
registerSites();
browser.storage.onChanged.addListener(changes => { if (changes.sites) registerSites(); });
browser.permissions.onAdded.addListener(registerSites);
browser.permissions.onRemoved.addListener(registerSites);

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

// every message logged with how it ended (debug receiver, if running)
browser.runtime.onMessage.addListener((msg, sender) => {
  dlog('message in', msg, sender.tab ? 'from tab ' + sender.tab.id : 'from ' + (sender.url || '').split('/').pop());
  return handle(msg, sender).then(
    r => { dlog('message out', msg.type, r && typeof r === 'object' ? { ok: r.ok, error: r.error, keys: Object.keys(r) } : r); return r; },
    e => { dlog('message FAILED', msg.type, e); return Promise.reject(e); });
});
// the same requests over a port (rpc.js): replies travel as messages, which
// arrive even where sendMessage's replies don't
browser.runtime.onConnect.addListener(port => {
  if (port.name !== 'rpc') return;
  port.onMessage.addListener(async ({ id, msg }) => {
    dlog('rpc in', msg);
    try {
      const r = await handle(msg, port.sender);
      dlog('rpc out', msg.type, r && typeof r === 'object' ? { ok: r.ok, error: r.error, keys: Object.keys(r) } : r);
      port.postMessage({ id, r });
    } catch (e) { dlog('rpc FAILED', msg.type, e); port.postMessage({ id, error: e.message }); }
  });
});
async function handle(msg, sender) {
  switch (msg.type) {
    case 'ping': return { pong: true, version: browser.runtime.getManifest().version };
    case 'gaps': return ba('/api/statements/gaps', {}, msg.cfg);
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
      try { return await upload({ card: msg.card, name: msg.name, bytes }, msg.cfg); }
      catch (e) { return { ok: false, error: e.message }; }
    }
    case 'test': {
      try { const g = await ba('/api/statements/gaps', {}, msg.cfg); return { ok: true, cards: (g.cards || []).length }; }
      catch (e) { return { ok: false, error: e.message + (e.stack ? ' [at ' + String(e.stack).split('\n')[0].slice(0, 80) + ']' : '') }; }
    }
  }
}
