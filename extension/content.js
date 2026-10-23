// Runs on the bank's pages. Opened from the toolbar button: lists the
// statements Banking Aid is missing that this page shows, and "Send all"
// opens each one, takes the file (from the viewer, or by pressing the page's
// own Download button, which the extension catches), sends it to Banking Aid,
// goes back and carries on through the pages.
(() => {
  if (window.__baFetcher) return;
  window.__baFetcher = true;

  // ── reading the page ────────────────────────────────────────────────────
  const MN = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };
  const pad = n => String(n).padStart(2, '0');
  const iso = (y, m, d) => (y < 100 ? 2000 + y : y) + '-' + pad(m) + '-' + pad(d);
  const DATE = /\b\d{1,2}[\/.-]\d{1,2}[\/.-]\d{2,4}\b|\b\d{1,2}(?:st|nd|rd|th)?\s+(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+\d{4}\b/gi;
  const dateIn = t => {
    let r = t.match(/\b(\d{1,2})[\/.-](\d{1,2})[\/.-](\d{2,4})\b/);
    if (r) return iso(+r[3], +r[2], +r[1]);
    r = t.match(/\b(\d{1,2})(?:st|nd|rd|th)?\s+(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+(\d{4})\b/i);
    return r ? iso(+r[3], MN[r[2].slice(0, 3).toLowerCase()], +r[1]) : null;
  };
  const days = (a, b) => Math.abs(new Date(a) - new Date(b)) / 86400000;
  const stems = t => new Set(t.toLowerCase().split(/[^a-z0-9]+/).filter(w => w.length >= 3).map(w => w.slice(0, 5)));
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  // a component's innerText leaves out its shadow content: read the composed text
  const textOf = el => {
    let out = '';
    const walk = n => {
      if (out.length > 600) return;
      if (n.nodeType === 3) { out += n.nodeValue + ' '; return; }
      if (n.nodeType !== 1 && n.nodeType !== 11) return;
      if (n.nodeName === 'STYLE' || n.nodeName === 'SCRIPT') return;
      if (n.shadowRoot) walk(n.shadowRoot);
      for (const c of n.childNodes) walk(c);
    };
    walk(el);
    return out.replace(/\s+/g, ' ').trim();
  };
  const up = el => el.parentElement || (el.getRootNode && el.getRootNode().host) || null;
  const inPanel = el => { for (let n = el; n; n = up(n)) if (n.id === 'ba-fetch-panel') return true; return false; };
  // every node of the page, through shadow roots and same-origin frames
  const everything = (root, visit) => {
    if (!root) return;
    const walk = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT);
    for (let n = walk.currentNode; n; n = walk.nextNode()) {
      visit(n);
      if (n.nodeType === 1) {
        if (n.shadowRoot) everything(n.shadowRoot, visit);
        if (n.tagName === 'IFRAME') { try { if (n.contentDocument) everything(n.contentDocument.body, visit); } catch { /* other origin */ } }
      }
    }
  };

  let CARDS = [];
  let seen = { dated: 0, rows: 0, sample: '' };
  const findHits = () => {
    const rows = new Map(); // row -> its date's element
    let dated = 0;
    everything(document.body, n => {
      if (n.nodeType !== 3 || !n.parentElement || !dateIn(n.nodeValue || '') || inPanel(n.parentElement)) return;
      dated++;
      // a row is the largest box holding just this one date
      let row = n.parentElement;
      for (let p = up(row); p && p !== document.body && p.nodeName !== 'HTML'; p = up(p)) {
        const t = textOf(p);
        if (t.length > 300 || (t.match(DATE) || []).length > 1) break;
        row = p;
      }
      rows.set(row, n.parentElement);
    });
    seen = { dated, rows: rows.size, sample: rows.size ? textOf([...rows.keys()][0]).slice(0, 90) : '' };
    const hits = [];
    for (const [row, leaf] of rows) {
      const text = textOf(row);
      // transaction statements only: not letters, notices, annual summaries or
      // statements of fees (no payments in them to import)
      if (!/statement/i.test(text) || /\b(annual|fees?|summary|interest rate)\b/i.test(text)) continue;
      const date = dateIn(text);
      const have = stems(text);
      let card = null, best = 0;
      for (const c of CARDS) if (c.words.every(w => have.has(w)) && c.words.length > best) { card = c; best = c.words.length; }
      // how the bank names the card on this row ("Saving - Main"): the text
      // left once the date and the document's title ("Account Statement") go
      const pageLabel = text.replace(DATE, ' ').replace(/^.*?\bstatement\b\s*/i, '').replace(/[›>»]\s*$/, '').replace(/\s+/g, ' ').trim().slice(0, 60);
      if (!card) {
        // a card Banking Aid can't match yet: the statement is fetched anyway
        // and sent unsorted — Banking Aid files it by the account it prints,
        // learns this wording for that card, and skips it if it's a copy
        hits.push({ row, leaf, key: 'page:' + pageLabel + '|' + date, card: (pageLabel || 'Unrecognised card') + ' (new)', account: 'Unsorted', pageLabel, date, label: text.slice(0, 80) });
        continue;
      }
      // within a few days of an expected date; a card with nothing on file wants every one
      if (!card.all && !card.statements.some(d => days(d, date) <= 6)) continue;
      hits.push({ row, leaf, key: card.card + '|' + date, card: card.card, account: card.card, pageLabel, date, label: text.slice(0, 80) });
    }
    return hits.sort((a, b) => a.card.localeCompare(b.card) || a.date.localeCompare(b.date));
  };
  // which bank this page belongs to: the bank name Banking Aid has for a card,
  // found in this site's address ("mybank" in online.mybank.co.uk). Only that
  // bank's cards are looked for; if none matches, every card is.
  let BANK = null;
  let cfg = null; // Banking Aid address + token, sent with every request
  const squash = s => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  const loadCards = async () => {
    cfg = await browser.storage.local.get(['url', 'token']);
    let res = await call({ type: 'gaps', cfg });
    if (res && res.error) throw new Error(res.error);
    const host = squash(location.hostname);
    const mine = (res.cards || []).filter(c => squash(c.bank).length >= 3 && host.includes(squash(c.bank)));
    BANK = mine.length ? mine[0].bank : null;
    if (mine.length) res = { ...res, cards: mine };
    // a card is found by the words of its name or label — not its bank's
    // name, which the bank's own page doesn't repeat on every line
    const STOP = ['card', 'account', 'statement', 'the', 'isa', 'and'];
    const words = s => String(s || '').toLowerCase().split(/[^a-z0-9]+/).filter(w => w.length >= 3);
    CARDS = (res.cards || []).map(c => ({
      card: c.card,
      words: [...new Set(words(c.label || c.card).filter(w => !STOP.includes(w) && !words(c.bank).includes(w)).map(w => w.slice(0, 5)))],
      all: c.gaps.some(g => !g.statements.length),
      statements: c.gaps.flatMap(g => g.statements)
    })).filter(c => c.words.length);
  };

  // ── ticks: what's been sent, kept by the extension across reloads ───────
  let state = {};
  const loadState = async () => { state = (await browser.storage.local.get('got')).got || {}; };
  const save = () => browser.storage.local.set({ got: state });

  // ── getting one statement's file ────────────────────────────────────────
  const isPdf = buf => buf && buf.byteLength > 500 && String.fromCharCode(...new Uint8Array(buf.slice(0, 5))) === '%PDF-';
  const clickable = (root, test) => {
    let found = null;
    everything(root, n => {
      if (found || n.nodeType !== 1 || inPanel(n)) return;
      if (!n.matches('a[href], button, [role=button], [role=link], [onclick]')) return;
      if (test(n)) found = n;
    });
    return found;
  };
  // what to click to open a row: its own link or button, else its date — a
  // click there bubbles up through the component to whatever listens
  const open = h => {
    h.row.scrollIntoView({ block: 'center' });
    (clickable(h.row, () => true) || h.leaf || h.row).click();
  };
  // a PDF the page is showing: an iframe/embed/object pointing at one
  const shownPdf = () => {
    let src = null;
    everything(document.body, n => {
      if (src || n.nodeType !== 1 || !/^(IFRAME|EMBED|OBJECT)$/.test(n.tagName)) return;
      const u = n.getAttribute('src') || n.getAttribute('data') || n.src || n.data || '';
      if (/^blob:|^data:application\/pdf|pdf/i.test(u)) src = new URL(u, location.href).href;
    });
    return src;
  };
  // the viewer's own Download button
  const downloadButton = () => clickable(document.body, n => /download|save( a)? copy/i.test(textOf(n) + ' ' + (n.getAttribute('aria-label') || '') + ' ' + (n.getAttribute('title') || '') + ' ' + (n.id || '')));
  const readUrl = async url => { try { const r = await fetch(url, { credentials: 'include' }); return await r.arrayBuffer(); } catch { return null; } };

  let caught = null; // set when the background cancels a download for us
  browser.runtime.onMessage.addListener(msg => {
    if (msg.type === 'download-caught' && caught) caught(msg);
    if (msg.type === 'toggle') toggle();
  });
  // open the statement, then take the file however it shows up: a download
  // the extension catches, a PDF frame on the page, or — after a moment —
  // pressing the viewer's Download button so it becomes a caught download
  const getFile = async (h, log) => {
    const got = new Promise(resolve => { caught = resolve; });
    await call({ type: 'arm', ms: 35000 });
    open(h);
    let pressed = false;
    const until = Date.now() + 30000;
    try {
      while (Date.now() < until) {
        const dl = await Promise.race([got, sleep(800).then(() => null)]);
        if (dl) {
          // a blob: link is the page's own; anything else the extension fetches
          if (dl.url.startsWith('blob:') || dl.url.startsWith('data:')) { const b = await readUrl(dl.url); if (isPdf(b)) return { bytes: b, how: 'download button' }; }
          else return { url: dl.url, how: 'download' };
        }
        const src = shownPdf();
        if (src) {
          if (/^blob:|^data:/.test(src)) { const b = await readUrl(src); if (isPdf(b)) return { bytes: b, how: 'viewer' }; }
          else { const b = await readUrl(src); if (isPdf(b)) return { bytes: b, how: 'viewer' }; }
        }
        if (!pressed && Date.now() > until - 26000) {
          const btn = downloadButton();
          if (btn) { pressed = true; log('Pressing the page’s Download button…'); btn.click(); }
        }
      }
      return null;
    } finally {
      caught = null;
      call({ type: 'disarm' });
    }
  };

  // ── the panel ───────────────────────────────────────────────────────────
  const make = (tag, css, text) => { const e = document.createElement(tag); if (css) e.style.cssText = css; if (text != null) e.textContent = text; return e; };
  let panel = null, list, status, log, sendBtn, stopBtn, hits = [], stop = false;
  const say = t => { if (log) log.textContent = t; };
  const mark = (h, st) => { h.row.style.outline = st === 'sent' || st === 'got' ? '2px solid #0ca30c' : st === 'failed' ? '2px solid #d03b3b' : '2px solid #e8a33d'; };
  const render = () => {
    list.textContent = '';
    let group = null;
    for (const h of hits) {
      if (h.card !== group) { group = h.card; list.appendChild(make('div', 'margin-top:10px;color:#7db7ff;font-weight:600', h.card)); }
      const st = state[h.key];
      mark(h, st);
      const line = make('label', 'display:flex;gap:8px;align-items:flex-start;padding:5px 0;border-top:1px solid #333;cursor:pointer');
      const box = make('input'); box.type = 'checkbox'; box.checked = st === 'sent' || st === 'got';
      const name = make('span', box.checked ? 'text-decoration:line-through;color:#888' : st === 'failed' ? 'color:#ff8a8a' : '',
        h.date.split('-').reverse().join('/') + ' - ' + h.label + (st === 'sent' ? '  (sent)' : st === 'failed' ? '  (could not get it)' : ''));
      box.onchange = () => { state[h.key] = box.checked ? 'got' : ''; save(); render(); };
      name.onclick = ev => { ev.preventDefault(); open(h); };
      line.appendChild(box); line.appendChild(name);
      list.appendChild(line);
    }
    const left = hits.filter(h => state[h.key] !== 'sent' && state[h.key] !== 'got').length;
    status.textContent = !hits.length
      ? 'No missing statement on this page. Press Send all to go through every page.'
      : left ? left + ' missing on this page. Send all fetches them into Banking Aid and moves through the pages.' : 'All on this page done.';
    if (!hits.length) say('Looking for: ' + CARDS.map(c => c.card).join(', ') + '. Seen: ' + seen.dated + ' dates in ' + seen.rows + ' rows' + (seen.sample ? ', e.g. "' + seen.sample + '"' : '') + '.');
  };
  // the list again, after the page re-drew it (going back from a viewer)
  const waitForList = async () => {
    for (let i = 0; i < 20; i++) { await sleep(500); if (findHits().length || seen.rows > 1) return; }
  };
  const nextControl = () => clickable(document.body, n => {
    const t = (textOf(n) + ' ' + (n.getAttribute('aria-label') || '') + ' ' + (n.getAttribute('title') || '')).toLowerCase();
    if (!/\b(next( page)?|show more|load more|more documents|older)\b|^\s*[›>»]\s*$/.test(t)) return false;
    return !(n.disabled || n.getAttribute('aria-disabled') === 'true' || /disabled/.test(n.className || ''));
  });

  const sendAll = async () => {
    stop = false; sendBtn.style.display = 'none'; stopBtn.style.display = '';
    let sent = 0, failed = 0, pages = 1, emptyPages = 0;
    pageLoop: while (!stop) {
      // one at a time, finding the row afresh each time: going back from a
      // statement re-draws the list, and an old row no longer opens anything
      for (;;) {
        if (stop) break pageLoop;
        hits = findHits(); render();
        const h = hits.find(x => !state[x.key]);
        if (!h) break;
        say('Getting ' + h.card + ' ' + h.date + '…');
        self.dlog && dlog('getting', h.key, location.href);
        const where = location.href;
        const file = await getFile(h, say);
        self.dlog && dlog('file', h.key, file ? { how: file.how, bytes: file.bytes ? file.bytes.byteLength : null, url: file.url ? file.url.slice(0, 60) : null } : 'NONE');
        if (!file) { state[h.key] = 'failed'; failed++; say('Could not get ' + h.card + ' ' + h.date + ' — open it yourself and drop it on Banking Aid’s Import tab.'); }
        else {
          say('Sending ' + h.card + ' ' + h.date + ' (' + file.how + ')…');
          const r = await call({ type: 'upload', cfg, card: h.account, pageLabel: h.pageLabel, name: h.date + ' ' + h.card + '.pdf', bytes: file.bytes || null, url: file.url || null });
          state[h.key] = r && r.ok ? 'sent' : 'failed';
          r && r.ok ? sent++ : failed++;
          if (!r || !r.ok) say(h.card + ' ' + h.date + ': ' + ((r && r.error) || 'upload failed'));
        }
        await save();
        if (location.href !== where) { history.back(); await waitForList(); }
        await sleep(500);
      }
      const next = nextControl();
      if (!next) break;
      next.scrollIntoView({ block: 'center' }); next.click(); pages++;
      await sleep(2500);
      // older pages can hold nothing missing for a while; a long run of them stops the walk
      emptyPages = findHits().some(x => !state[x.key]) ? 0 : emptyPages + 1;
      if (emptyPages >= 30 || pages >= 200) break;
    }
    stopBtn.style.display = 'none'; sendBtn.style.display = '';
    hits = findHits(); render();
    say('Done: ' + sent + ' sent to Banking Aid' + (failed ? ', ' + failed + ' to get yourself (marked red)' : '') + ' across ' + pages + ' page' + (pages === 1 ? '' : 's') + '. They import in the background.');
  };

  const build = async () => {
    panel = make('div', 'position:fixed;top:12px;right:12px;z-index:2147483647;width:400px;max-height:82vh;overflow:auto;background:#1a1a19;color:#fff;border:1px solid #555;border-radius:12px;padding:14px;font:13px/1.5 system-ui,sans-serif;box-shadow:0 8px 30px rgba(0,0,0,.5)');
    panel.id = 'ba-fetch-panel';
    const head = make('div', 'display:flex;gap:8px;align-items:center');
    const title = make('strong', 'flex:1', 'Banking Aid - missing statements');
    head.appendChild(title);
    const x = make('button', 'background:none;border:none;color:#aaa;cursor:pointer;font-size:15px', 'x');
    x.onclick = () => toggle();
    head.appendChild(x);
    panel.appendChild(head);
    status = make('p', 'color:#c3c2b7;margin:6px 0', 'Asking Banking Aid what’s missing…');
    panel.appendChild(status);
    const btnCss = 'background:#2b6fd6;color:#fff;border:0;border-radius:8px;padding:7px 12px;cursor:pointer;font:inherit;font-weight:600';
    const bar = make('div', 'display:flex;gap:8px;flex-wrap:wrap;margin:4px 0 8px');
    sendBtn = make('button', btnCss, 'Send all to Banking Aid');
    stopBtn = make('button', btnCss.replace('#2b6fd6', '#555'), 'Stop');
    stopBtn.style.display = 'none';
    const reset = make('button', btnCss.replace('#2b6fd6', '#333'), 'Clear ticks');
    reset.title = 'Forget which statements were sent or ticked, to look again';
    bar.appendChild(sendBtn); bar.appendChild(stopBtn); bar.appendChild(reset);
    panel.appendChild(bar);
    list = make('div'); panel.appendChild(list);
    log = make('div', 'color:#888;font-size:12px;margin-top:8px'); panel.appendChild(log);
    document.body.appendChild(panel);
    stopBtn.onclick = () => { stop = true; say('Stopping after this one…'); };
    sendBtn.onclick = sendAll;
    reset.onclick = () => { state = {}; save(); hits = findHits(); render(); };
    try { await loadCards(); await loadState(); if (BANK) title.textContent = 'Banking Aid - missing ' + BANK + ' statements'; }
    catch (e) { self.dlog && dlog('panel: loading cards failed', e); status.textContent = 'Could not reach Banking Aid: ' + e.message + '. Check the address and API token in the extension’s settings (toolbar button).'; return; }
    hits = findHits(); render();
  };
  const toggle = () => {
    if (panel) { stop = true; for (const h of hits) h.row.style.outline = ''; panel.remove(); panel = null; return; }
    build();
  };
})();
