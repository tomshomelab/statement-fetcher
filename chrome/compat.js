// Chrome and Opera: the same add-on on their extension API. Firefox's
// `browser` is Chrome's `chrome` (its calls return promises in Manifest V3),
// plus the few calls Chrome names differently. Loaded first, everywhere.
(() => {
  // (Edge and newer Chromium name it `browser` too, without these calls)
  const b = globalThis.browser ||= globalThis.chrome;
  if (b.__compat) return;
  b.__compat = true;

  // tabs.executeScript(tab, { file }) → scripting.executeScript, with this
  // file first so the injected script finds `browser`
  if (b.scripting && b.tabs) b.tabs.executeScript = (tabId, { file }) => b.scripting.executeScript({ target: { tabId }, files: ['compat.js', file] });

  // contentScripts.register → a content script registered for the bank
  // sites, kept across browser restarts
  if (b.scripting) b.contentScripts = {
    register: async ({ matches, js, runAt }) => {
      const id = 'bank-sites';
      await b.scripting.unregisterContentScripts({ ids: [id] }).catch(() => {});
      await b.scripting.registerContentScripts([{
        id, matches, js: ['compat.js', ...js.map(x => x.file)],
        runAt: String(runAt || 'document_idle').replace('-', '_'), persistAcrossSessions: true
      }]);
      return { unregister: () => b.scripting.unregisterContentScripts({ ids: [id] }).catch(() => {}) };
    }
  };

  // a message listener answering with a promise (as Firefox allows) →
  // Chrome's sendResponse
  const ev = b.runtime.onMessage;
  const add = ev.addListener.bind(ev);
  ev.addListener = fn => add((msg, sender, sendResponse) => {
    const r = fn(msg, sender);
    if (r && typeof r.then === 'function') { r.then(sendResponse, e => sendResponse({ error: e?.message || String(e) })); return true; }
    return false;
  });
})();
