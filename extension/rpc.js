// call(msg) → the background's answer, over a connected port rather than
// runtime.sendMessage: in some Firefox profiles sendMessage's replies never
// arrive (the background answers, the caller gets nothing — "An unexpected
// error occurred"). A port carries the reply as an ordinary message.
(() => {
  if (self.call) return;
  let port = null, next = 0;
  const waiting = new Map();
  const connect = () => {
    port = browser.runtime.connect({ name: 'rpc' });
    port.onMessage.addListener(({ id, r, error }) => {
      const w = waiting.get(id);
      if (!w) return;
      waiting.delete(id);
      error ? w.reject(new Error(error)) : w.resolve(r);
    });
    port.onDisconnect.addListener(() => {
      port = null;
      for (const w of waiting.values()) w.reject(new Error('the add-on’s background went away'));
      waiting.clear();
    });
  };
  self.call = (msg, ms = 120000) => new Promise((resolve, reject) => {
    if (!port) connect();
    const id = ++next;
    waiting.set(id, { resolve, reject });
    setTimeout(() => { if (waiting.delete(id)) reject(new Error('the add-on’s background didn’t answer in time')); }, ms);
    port.postMessage({ id, msg });
  });
})();
