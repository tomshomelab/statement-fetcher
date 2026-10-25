// Debug logging to a receiver on this machine (127.0.0.1:8777, see
// tools/logserver.mjs). Nothing listening = nothing happens; it never leaves
// the computer and never carries the API token.
(() => {
  if (self.dlog) return;
  const where = typeof document === 'undefined' ? 'worker' : /-extension:$/.test(location.protocol) ? location.pathname.replace(/^\//, '').replace('.html', '') : 'page';
  const clean = v => {
    if (v instanceof Error) return { error: v.name, message: v.message, stack: String(v.stack || '').split('\n').slice(0, 4).join(' | ') };
    if (v && typeof v === 'object') { const o = { ...v }; if (o.cfg) o.cfg = { url: o.cfg.url, token: o.cfg.token ? '(set)' : '(none)' }; if ('token' in o) o.token = o.token ? '(set)' : '(none)'; if (o.bytes) o.bytes = `(${o.bytes.byteLength ?? o.bytes} bytes)`; return o; }
    return v;
  };
  self.dlog = (...args) => {
    let line;
    try { line = JSON.stringify({ v: browser.runtime.getManifest().version, where, args: args.map(clean) }); } catch (e) { line = JSON.stringify({ where, args: args.map(String) }); }
    // a bank page may not reach a local http address itself: its lines go
    // through the add-on's background
    if (where === 'page' && self.call) { self.call({ type: 'log', line }, 5000).catch(() => {}); return; }
    fetch('http://127.0.0.1:8777/log', { method: 'POST', body: line }).catch(() => {});
  };
  self.addEventListener('error', e => self.dlog('uncaught', e.message, e.filename + ':' + e.lineno));
  self.addEventListener('unhandledrejection', e => self.dlog('unhandled rejection', e.reason));
  self.dlog('loaded', where === 'page' ? location.hostname : '');
})();
