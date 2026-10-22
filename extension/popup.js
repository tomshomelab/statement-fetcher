const $ = id => document.getElementById(id);
const msg = t => { $('msg').textContent = t; };
// "online.mybank.co.uk" → "mybank.co.uk": the bank's whole site, any subdomain
const siteOf = host => { const p = host.split('.'); return p.slice(/\.(co|com|org|gov|ac)\.[a-z]{2}$/.test(host) ? -3 : -2).join('.'); };
const patternsFor = sites => sites.flatMap(s => [`https://${s}/*`, `https://*.${s}/*`]);

let current = { url: '', token: '', sites: [] };
(async () => {
  current = { ...current, ...(await browser.storage.local.get(['url', 'token', 'sites'])) };
  $('url').value = current.url;
  $('token').value = current.token;
  $('sites').value = current.sites.join(', ');
  if (!current.url || !current.token) $('settings').open = true;
  const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
  try {
    const host = new URL(tab.url).hostname;
    if (/^https:/.test(tab.url) && !current.sites.includes(siteOf(host))) { $('add').hidden = false; $('add').textContent = `Use on ${siteOf(host)}`; }
  } catch { /* not a web page */ }
})();

$('show').onclick = async () => {
  const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
  try {
    await browser.tabs.sendMessage(tab.id, { type: 'toggle' });
    window.close();
  } catch {
    msg('Open your bank’s statements page, add the site (button above or Settings), reload it, then press this again.');
  }
};

// add the open tab's site: ask Firefox for it, remember it, run on it now
$('add').onclick = async () => {
  const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
  const site = siteOf(new URL(tab.url).hostname);
  if (!await browser.permissions.request({ origins: patternsFor([site]) }).catch(() => false)) { msg('Firefox needs permission to run on that site.'); return; }
  current.sites = [...new Set([...current.sites, site])];
  await browser.storage.local.set({ sites: current.sites });
  $('sites').value = current.sites.join(', ');
  await browser.tabs.executeScript(tab.id, { file: 'content.js' });
  await browser.tabs.sendMessage(tab.id, { type: 'toggle' });
  window.close();
};

$('save').onclick = async () => {
  const url = $('url').value.trim().replace(/\/$/, '');
  const sites = $('sites').value.split(',').map(s => s.trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/.*$/, '')).filter(Boolean);
  let origin;
  try { origin = new URL(url).origin; } catch { msg('That Banking Aid address isn’t a web address.'); return; }
  // Firefox's say-so to reach Banking Aid and to run on the bank sites
  const ok = await browser.permissions.request({ origins: [origin + '/*', ...patternsFor(sites)] }).catch(() => false);
  if (!ok) { msg('Firefox needs permission for those addresses.'); return; }
  await browser.storage.local.set({ url, token: $('token').value.trim(), sites });
  msg('Testing…');
  const r = await browser.runtime.sendMessage({ type: 'test' });
  msg(r.ok ? `✓ Connected: ${r.cards} card${r.cards === 1 ? '' : 's'} with missing statements.` : `✕ ${r.error}`);
};
