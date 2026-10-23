const $ = id => document.getElementById(id);
const msg = t => { $('msg').textContent = t; };
// "online.mybank.co.uk" → "mybank.co.uk": the bank's whole site, any subdomain
const siteOf = host => { const p = host.split('.'); return p.slice(/\.(co|com|org|gov|ac)\.[a-z]{2}$/.test(host) ? -3 : -2).join('.'); };
const patternsFor = sites => sites.flatMap(s => [`https://${s}/*`, `https://*.${s}/*`]);

let current = { url: '', token: '', sites: [] };
let activeTab = null; // looked up now: the button must ask Firefox before awaiting anything
(async () => {
  current = { ...current, ...(await browser.storage.local.get(['url', 'token', 'sites'])) };
  $('url').value = current.url;
  $('token').value = current.token;
  if (!current.url || !current.token) $('settings').open = true;
  if (!$('show')) return; // the Options page has the settings only
  [activeTab] = await browser.tabs.query({ active: true, currentWindow: true });
})();

// One button on any bank's page: the site comes from the page you're on —
// Firefox is asked for it straight from the click (an await before
// permissions.request and Firefox refuses without asking), it's remembered
// for next time, and the panel opens. Which bank it is, the panel works out
// from the site and the banks Banking Aid knows your cards by.
if ($('show')) $('show').onclick = async () => {
  if (!current.url || !current.token) { $('settings').open = true; msg('Fill in your Banking Aid address and API token first, then Save & test.'); return; }
  const tab = activeTab;
  if (!tab || !/^https:/.test(tab.url || '')) { msg('Open your bank’s statements page (signed in), then press this.'); return; }
  const site = siteOf(new URL(tab.url).hostname);
  if (!await browser.permissions.request({ origins: patternsFor([site]) }).catch(() => false)) { msg(`Firefox needs your OK to run on ${site}: press the button again and choose Allow.`); return; }
  current.sites = [...new Set([...current.sites, site])];
  await browser.storage.local.set({ sites: current.sites });
  try {
    // already on the page (remembered site) or put there now
    await browser.tabs.sendMessage(tab.id, { type: 'toggle' }).catch(async () => {
      await browser.tabs.executeScript(tab.id, { file: 'content.js' });
      await browser.tabs.sendMessage(tab.id, { type: 'toggle' });
    });
    window.close();
  } catch (e) { msg('Couldn’t open on this page: ' + e.message); }
};

$('save').onclick = async () => {
  const url = $('url').value.trim().replace(/\/$/, '');
  let host;
  // Firefox's address patterns can't carry a port: ask for the whole host
  // ("http://192.168.1.10/*"), which covers Banking Aid on any port
  try { const u = new URL(url); host = `${u.protocol}//${u.hostname}/*`; } catch { msg('That Banking Aid address isn’t a web address.'); return; }
  // asked straight from the click (an await first and Firefox refuses
  // silently); the settings are kept either way
  const asking = browser.permissions.request({ origins: [host] }).catch(() => false);
  current = { ...current, url, token: $('token').value.trim() };
  await browser.storage.local.set({ url: current.url, token: current.token });
  if (!await asking) { msg('Firefox needs your OK to reach Banking Aid: press Save & test again and choose Allow.'); return; }
  msg('Testing…');
  const r = await browser.runtime.sendMessage({ type: 'test', cfg: { url: current.url, token: current.token } }).catch(e => ({ ok: false, error: 'the add-on’s background didn’t answer (' + e.message + ')' }));
  msg(r.ok ? `✓ Connected: ${r.cards} card${r.cards === 1 ? '' : 's'} with missing statements.` : `✕ ${r.error}`);
};
