// Runs on the bank's pages. Opened from the toolbar button: lists the
// statements Banking Aid is missing that this page shows, and "Fetch
// missing statements" opens each one, takes the file (from the viewer, or by pressing the page's
// own Download button, which the extension catches), sends it to Banking Aid,
// goes back and carries on through the pages.
(() => {
  if (window.__baFetcher) return;
  window.__baFetcher = true;

  // ── reading the page ────────────────────────────────────────────────────
  const MN = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };
  const pad = n => String(n).padStart(2, '0');
  // a real calendar date or nothing: a sort code (20-46-07) isn't the 20th of month 46
  const iso = (y, m, d) => {
    const yy = y < 100 ? 2000 + y : y;
    return m >= 1 && m <= 12 && new Date(Date.UTC(yy, m - 1, d)).getUTCDate() === d ? yy + '-' + pad(m) + '-' + pad(d) : null;
  };
  // dates as banks print them: 08/10/2026, 8/10/26, 05 Sep 26, 5th September 2026
  // — but not a sort code, which an account number follows ("20-46-07 12345678")
  const D_NUM = String.raw`\b\d{1,2}[\/.-]\d{1,2}[\/.-]\d{2,4}\b(?!\s*\d{6,})`;
  const D_TXT = String.raw`\b\d{1,2}(?:st|nd|rd|th)?\s+(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+(?:\d{4}|\d{2})\b`;
  const DATE = new RegExp(`${D_NUM}|${D_TXT}`, 'gi');
  // a statement's period, "05 Sep 26 - 06 Oct 26", is one date for row-finding
  const RANGE = new RegExp(`(${D_NUM}|${D_TXT})\\s*(?:-|–|—|to)\\s*(${D_NUM}|${D_TXT})`, 'gi');
  const parseDate = s => {
    let r = s.match(/(\d{1,2})[\/.-](\d{1,2})[\/.-](\d{2,4})/);
    if (r) return iso(+r[3], +r[2], +r[1]);
    r = s.match(/(\d{1,2})(?:st|nd|rd|th)?\s+(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+(\d{4}|\d{2})/i);
    return r ? iso(+r[3], MN[r[2].slice(0, 3).toLowerCase()], +r[1]) : null;
  };
  // a statement can't be dated in the future: a year read wrong ("Nov 26"
  // for Nov 25) takes the year before, or it's wanted again every run
  const notAhead = d => {
    if (!d) return d;
    const soon = new Date(Date.now() + 7 * 86400000).toISOString().slice(0, 10);
    if (d <= soon) return d;
    const back = (Number(d.slice(0, 4)) - 1) + d.slice(4);
    return back <= soon ? back : null;
  };
  const dateIn = t => { for (const m of String(t).match(DATE) || []) { const d = notAhead(parseDate(m)); if (d) return d; } return null; };
  const periodIn = t => {
    const r = new RegExp(RANGE.source, 'i').exec(t);
    const p = r && { a: parseDate(r[1]), b: notAhead(parseDate(r[2])) };
    if (p && p.a && p.b && p.a > p.b) p.a = (Number(p.a.slice(0, 4)) - 1) + p.a.slice(4);
    return p && p.a && p.b ? p : null;
  };
  const dateUnits = t => { const ranges = (t.match(RANGE) || []).length; return ranges + (t.replace(RANGE, ' ').match(DATE) || []).length; };
  const days = (a, b) => Math.abs(new Date(a) - new Date(b)) / 86400000;
  const addDays = (d, n) => { const x = new Date(d + 'T00:00:00Z'); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10); };
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
  let picked = null; // the account chosen on an account picker, while its statements are walked
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
        if (t.length > 300 || dateUnits(t) > 1) break;
        row = p;
      }
      rows.set(row, n.parentElement);
    });
    const rowDates = [...rows.keys()].map(r => { const t = textOf(r); const p = periodIn(t); return p ? p.b : dateIn(t); }).filter(Boolean).sort();
    seen = { dated, rows: rows.size, sample: rows.size ? textOf([...rows.keys()][0]).slice(0, 90) : '', newest: rowDates[rowDates.length - 1] || null };
    const hits = [];
    const sameDate = new Map();
    const whole = pageCard();
    for (const [row, leaf] of rows) {
      const text = textOf(row);
      // transaction statements only: not letters, notices, annual summaries or
      // statements of fees (no payments in them to import)
      if (!/statement/i.test(text) || /\b(annual|fees?|summary|interest rate)\b/i.test(text)) continue;
      // the period printed on the row, else the month before its date
      const printed = periodIn(text);
      const date = printed ? printed.b : dateIn(text);
      if (!date) continue;
      const period = printed || { a: addDays(date, -31), b: addDays(date, -1) };
      const have = stems(text);
      let card = null, best = 0;
      for (const c of CARDS) if (c.words.length && c.words.every(w => have.has(w)) && c.words.length > best) { card = c; best = c.words.length; }
      card = card || whole;
      // how the bank names the card on this row ("Saving - Main"): the text
      // left once the date and the document's title ("Account Statement") go
      // (a row's own buttons aren't its name; on a page reached through an
      // account picker, the account picked is)
      const cleaned = text.replace(DATE, ' ').replace(/^.*?\bstatement\b\s*/i, '').replace(/[›>»]\s*$/, '')
        .replace(/\b(download|view|save|open|pdf)\b/gi, ' ').replace(/[^\p{L}\p{N}&'’ .()-]/gu, ' ').replace(/\s+/g, ' ').trim().slice(0, 60);
      // a page about one account (its header prints sort code + number) is
      // named by that account — row text there carries screen-reader words
      const pageLabel = (picked && picked.name) || pageAccountName() || (/\p{L}{2}/u.test(cleaned) ? cleaned : '');
      if (!card) {
        // a card Banking Aid can't match yet: the statement is fetched anyway
        // and sent unsorted — Banking Aid files it by the account it prints,
        // learns this wording for that card, and skips it if it's a copy
        hits.push({ row, leaf, key: 'page:' + pageLabel + '|' + date, card: (pageLabel || 'Unrecognised card') + ' (new)', account: 'Unsorted', pageLabel, date, label: text.slice(0, 80) });
        continue;
      }
      // fetched if Banking Aid hasn't this period on file, however old
      if (onFile(card, period)) continue;
      // two rows on one date (a statement and the yearly statement of fees,
      // dated alike): told apart by their order, so trying one never counts
      // as trying the other
      const base = card.card + '|' + date;
      const nth = (sameDate.get(base) || 0) + 1;
      sameDate.set(base, nth);
      const label = text.slice(0, 80) + (nth > 1 ? ' #' + nth : '');
      // a row Banking Aid found wasn't a statement (a yearly statement of fees)
      if ((card.skip || []).some(s => s.date === date && (!s.rowLabel || s.rowLabel === label))) continue;
      hits.push({ row, leaf, key: base + (nth > 1 ? '#' + nth : ''), card: card.card, account: card.card, known: true, pageLabel, date, label });
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
      last4: c.last4 || null,
      ranges: c.ranges || [],
      skip: c.skip || [],
      // what Banking Aid is missing for this card: the periods with no statement
      gaps: (c.gaps || []).filter(g => g.from && g.to).map(g => ({ a: g.from, b: g.to }))
    })).filter(c => c.words.length || c.last4);
  };
  // the account a statements page is about, as its header names it: the words
  // before the first "sort code + number" ("Saver ISA (Closed) 20-46-07 …")
  const pageAccountName = () => {
    const text = (document.body.innerText || '').slice(0, 20000);
    // only a page about ONE account: one that lists several names none
    const numbers = new Set((text.match(/\b\d{2}-\d{2}-\d{2}\s+\d{8}\b/g) || []).map(x => x.replace(/\s+/g, ' ')));
    if (numbers.size !== 1) return '';
    const m = text.match(/([^\n]{2,60}?)\s*\n?\s*\b\d{2}-\d{2}-\d{2}\s+\d{8}\b/);
    return m ? m[1].replace(/^(your statements|statements)\s*/i, '').trim() : '';
  };
  // the card a whole page is about: banks that list one account's statements
  // print its number once at the top ("Joint Account 20-25-28 12345678")
  const pageCard = () => {
    const text = (document.body.innerText || '').slice(0, 20000);
    return CARDS.find(c => c.last4 && new RegExp(String.raw`(?:\d{4}|[…*•x]+\s*|ending\s+)${c.last4}\b`, 'i').test(text)) || null;
  };
  // is this statement's period already in Banking Aid? A statement dated D
  // (no period printed) covers the month before D. Half the period on file
  // is enough: statement edges differ by a day or two between banks and files.
  const onFile = (card, period) => card.ranges.some(r => {
    const overlap = (new Date(r.b < period.b ? r.b : period.b) - new Date(r.a > period.a ? r.a : period.a)) / 86400000;
    return overlap >= 0.5 * Math.max(1, days(period.a, period.b));
  });

  // ── what's missing: the only thing a run fetches ───────────────────────
  const missingOf = card => (card && card.gaps || []).filter(g => !onFile(card, g));
  const cardFor = last4 => CARDS.find(c => c.last4 && c.last4 === last4) || null;
  const monthOf = d => new Date(d + 'T00:00:00Z').toLocaleDateString('en-GB', { month: 'short', year: 'numeric', timeZone: 'UTC' });
  const missingSummary = () => CARDS.filter(c => missingOf(c).length).map(c => c.card + ': ' + missingOf(c).map(g => monthOf(g.b)).join(', ')).join(' · ');
  // the years worth opening on a year filter, for one card or every card here
  const yearsNeeded = card => new Set((card ? missingOf(card) : CARDS.flatMap(missingOf)).flatMap(g => {
    const out = []; for (let y = Number(g.a.slice(0, 4)); y <= Number(g.b.slice(0, 4)) + 1; y++) out.push(String(y)); return out;
  }));
  const oldestNeeded = card => (card ? missingOf(card) : CARDS.flatMap(missingOf)).map(g => g.a).sort()[0] || null;

  // ── ticks: what's been sent, kept by the extension across reloads ───────
  let state = {};
  const loadState = async () => { state = (await browser.storage.local.get('got')).got || {}; };
  const save = () => browser.storage.local.set({ got: state });

  // ── getting one statement's file ────────────────────────────────────────
  const shown = n => !!(n.offsetWidth || n.offsetHeight || n.getClientRects().length);
  // a message on screen saying the bank couldn't make the file
  const bankRefusal = () => {
    let hit = null;
    everything(document.body, n => {
      if (hit || n.nodeType !== 1 || inPanel(n) || !shown(n)) return;
      if (!(n.matches('[role=dialog], [role=alertdialog], dialog, [aria-modal=true]') || /modal|dialog|overlay/i.test(n.className || ''))) return;
      const t = textOf(n);
      if (/unable to download|error in downloading|couldn.?t (be )?download|can.?t download|not available to download/i.test(t)) hit = { code: (t.match(/\bcode\s*:?\s*(\w{3,10})/i) || [])[1] || null };
    });
    return hit;
  };
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
  // newer PDF viewers call it "Save" rather than "Download"
  const downloadButton = () => clickable(document.body, n => {
    const t = textOf(n) + ' ' + (n.getAttribute('aria-label') || '') + ' ' + (n.getAttribute('title') || '') + ' ' + (n.id || '');
    return /download|\bsave\b/i.test(t) && !/preference|setting|password|search/i.test(t);
  });
  const readUrl = async url => { try { const r = await fetch(url, { credentials: 'include' }); return await r.arrayBuffer(); } catch { return null; } };

  let caught = null; // set when the background cancels a download for us
  browser.runtime.onMessage.addListener(msg => {
    if (msg.type === 'download-caught' && caught) caught(msg);
    if (msg.type === 'toggle') toggle();
  });
  // open the statement, then take the file however it shows up: a download
  // the extension catches, a PDF frame on the page, or — after a moment —
  // pressing the viewer's Download button so it becomes a caught download
  const getFile = async (h, log, ms = 30000) => {
    const got = new Promise(resolve => { caught = resolve; });
    await call({ type: 'arm', ms: ms + 5000 });
    let why = 'no file appeared within ' + Math.round(ms / 1000) + 's';
    // a row with its own Download button (some banks list them so): press it, no viewer;
    // otherwise open the statement and take it from there (others show it in a viewer)
    const own = clickable(h.row, n => /download/i.test(textOf(n) + ' ' + (n.getAttribute('aria-label') || '') + ' ' + (n.getAttribute('title') || '')));
    let pressed = false, formatPicked = false;
    if (own) { own.scrollIntoView({ block: 'center' }); own.click(); pressed = true; } else open(h);
    const until = Date.now() + ms;
    try {
      while (Date.now() < until && !stop) {
        const dl = await Promise.race([got, sleep(800).then(() => null)]);
        if (dl) {
          // a blob: link is the page's own; anything else the extension fetches
          if (dl.url.startsWith('blob:') || dl.url.startsWith('data:')) { const b = await readUrl(dl.url); if (isPdf(b)) return { bytes: b, how: 'download button' }; why = 'the bank’s download wasn’t a PDF'; }
          else return { url: dl.url, how: 'download' };
        }
        const src = shownPdf();
        if (src) {
          if (/^blob:|^data:/.test(src)) { const b = await readUrl(src); if (isPdf(b)) return { bytes: b, how: 'viewer' }; }
          else { const b = await readUrl(src); if (isPdf(b)) return { bytes: b, how: 'viewer' }; }
        }
        if (!pressed && Date.now() > until - ms + 4000) {
          const btn = downloadButton();
          if (btn) { pressed = true; log('Pressing the page’s Download button…'); btn.click(); }
        }
        // the bank said it can't produce this one ("Unable to download
        // statement … quote code 65015"): close its message and move on
        const refusal = bankRefusal();
        if (refusal) {
          const ok = clickable(document.body, n => /^\s*(okay|ok|close|dismiss)\s*$/i.test(textOf(n)) && shown(n));
          if (ok) ok.click();
          self.dlog && dlog('bank refused', refusal);
          return { why: 'the bank couldn’t produce it' + (refusal.code ? ' (code ' + refusal.code + ')' : '') };
        }
        // a Download that opens a menu of formats (PDF / CSV / OFX …): the
        // PDF — it carries the statement's balances, which prove the rows
        if (pressed && !formatPicked) {
          const pdfOpt = clickable(document.body, n => /^\s*pdf\b/i.test(textOf(n)) && shown(n));
          if (pdfOpt) { formatPicked = true; self.dlog && dlog('picked format', textOf(pdfOpt).slice(0, 40)); pdfOpt.click(); }
        }
      }
      return { why: formatPicked ? why + ' after choosing PDF' : why };
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
        h.date.split('-').reverse().join('/') + ' - ' + h.label + (st === 'sent' ? '  (sent)' : st === 'failed' ? '  (couldn’t get it: ' + (state[h.key + '!'] || 'no reason recorded') + ')' : ''));
      box.onchange = () => { state[h.key] = box.checked ? 'got' : ''; save(); render(); };
      name.onclick = ev => { ev.preventDefault(); open(h); };
      line.appendChild(box); line.appendChild(name);
      list.appendChild(line);
    }
    const left = hits.filter(h => state[h.key] !== 'sent' && state[h.key] !== 'got').length;
    sendBtn.textContent = left ? 'Fetch ' + left + ' missing statement' + (left === 1 ? '' : 's') + ' (then older pages)' : accountChoices().length > 1 ? 'Fetch missing statements for every account' : 'Fetch missing statements';
    const wanted = missingSummary();
    status.textContent = !hits.length && !wanted
      ? 'Nothing missing for ' + (BANK || 'this bank') + ' — Banking Aid has every statement it expects.'
      : !hits.length
      ? 'Missing — ' + wanted + '. The button opens only those accounts and years.'
      : left ? left + ' statement' + (left === 1 ? '' : 's') + ' here for months Banking Aid hasn’t got. Statements it already has are left alone.' : 'All on this page done.';
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

  // every view the page's filter offers: banks list a year (or "last 12
  // months") at a time, so each year is picked in turn — with "all months"
  // where there's a month filter — and the page's own Filter button pressed
  const filterViews = () => {
    const sels = [];
    everything(document.body, n => { if (n.nodeType === 1 && n.tagName === 'SELECT' && !inPanel(n)) sels.push(n); });
    const years = sels.find(s => [...s.options].some(o => /\b(19|20)\d{2}\b|last \d+ months/i.test(o.text)));
    if (!years) return [null];
    const months = sels.find(s => s !== years && [...s.options].some(o => /^\s*all/i.test(o.text)));
    const set = (sel, opt) => { sel.value = opt.value; sel.dispatchEvent(new Event('input', { bubbles: true })); sel.dispatchEvent(new Event('change', { bubbles: true })); };
    return [...years.options].filter(o => !o.disabled && o.value !== '').map(o => Object.assign(async () => {
      if (months) set(months, [...months.options].find(m => /^\s*all/i.test(m.text)));
      set(years, o);
      const go = clickable(document.body, n => /^(filter|search|apply|show|go|update)$/i.test(textOf(n)));
      if (go) go.click();
      await sleep(3000);
      return o.text.trim();
    }, { label: o.text.trim() }));
  };

  // an account picker ("Select which account…"): each choice prints its sort
  // code and number; banks that list one account's statements at a time
  // need every account picked in turn
  const ACCT = /\b\d{2}-\d{2}-\d{2}\s+(\d{8})\b/;
  const accountChoices = () => {
    const out = [];
    everything(document.body, n => {
      if (n.nodeType !== 1 || inPanel(n) || !n.matches('input[type=radio], [role=radio]')) return;
      for (let p = n, i = 0; p && i < 8; p = up(p), i++) {
        const t = textOf(p);
        if (t.length > 300) break;
        const m = t.match(ACCT);
        if (m) { out.push({ el: n, last4: m[1].slice(-4), name: t.replace(ACCT, ' ').replace(/£\s*[\d,.]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 40) }); break; }
      }
    });
    return out;
  };
  const choose = async c => {
    c.el.scrollIntoView({ block: 'center' });
    c.el.click();
    await sleep(400);
    const go = clickable(document.body, n => /^(select|continue|next|view|view statements|go)$/i.test(textOf(n)) && !n.disabled && n.getAttribute('aria-disabled') !== 'true');
    if (go) go.click();
    // the picker goes first and the statements arrive a moment later: wait
    // for rows (or the page's year filter), not just for the picker to go
    for (let i = 0; i < 40 && !stop; i++) {
      await sleep(500);
      if (accountChoices().length) continue;
      findHits();
      if (seen.rows > 1 || filterViews()[0]) { await sleep(1000); self.dlog && dlog('account page ready', { rows: seen.rows, after: (i + 1) / 2 + 's' }); return true; }
    }
    self.dlog && dlog('account page: no statements appeared', { rows: seen.rows, sample: seen.sample });
    return !accountChoices().length;
  };
  // back to the picker: the browser's back, else the page's own way there
  const backToChoices = async () => {
    history.back();
    for (let i = 0; i < 12; i++) { await sleep(500); if (accountChoices().length > 1) return true; }
    const link = clickable(document.body, n => /change account|switch account|select (an?other |a different )?account|all accounts|choose account/i.test(textOf(n) + ' ' + (n.getAttribute('aria-label') || '')));
    if (link) { link.click(); for (let i = 0; i < 12; i++) { await sleep(500); if (accountChoices().length > 1) return true; } }
    return false;
  };
  // a run across accounts outlives a full page load: what's done is kept
  const saveRun = run => browser.storage.local.set({ run });

  const sendAll = async (resume = null) => {
    try { await runAll(resume); }
    catch (e) {
      self.dlog && dlog('run failed', e);
      say('Stopped: ' + e.message + '. Press the button to try again.');
      stopBtn.style.display = 'none'; sendBtn.style.display = '';
    }
  };
  const runAll = async (resume = null) => {
    stop = false; sendBtn.style.display = 'none'; stopBtn.style.display = '';
    let sent = 0, failed = 0, pages = 1, emptyPages = 0, accountsDone = 0;
    // what Banking Aid holds right now: a statement imported since the panel
    // opened is on file, not missing
    say('Asking Banking Aid what it already has…');
    try { await loadCards(); } catch (e) { say('Could not reach Banking Aid: ' + e.message); stopBtn.style.display = 'none'; sendBtn.style.display = ''; return; }
    // not the statements page (an account overview, a home page) but something
    // is missing: go to the bank's statements page and carry on there — on
    // this page if it's an in-page route, after the load if it reloads
    if (!(resume && resume.navigated) && !findHits().length && accountChoices().length < 2 && filterViews()[0] === null && seen.rows < 3 && missingSummary()) {
      const link = clickable(document.body, n => /^(statements?\s*(and|&)\s*documents|statements|view statements|e-?statements|documents)$/i.test(textOf(n)));
      if (link) {
        say('Opening the statements page…');
        const run = { at: Date.now(), done: [], navigated: true };
        await saveRun(run);
        self.dlog && dlog('going to the statements page', textOf(link));
        link.click();
        for (let i = 0; i < 30 && !stop; i++) { await sleep(500); if (accountChoices().length > 1 || findHits().length || filterViews()[0] !== null) break; }
        if (stop) return;
        return runAll(run);
      }
      say('This isn’t a statements page, and no link to one was found: open the bank’s statements page and press the button there.');
      stopBtn.style.display = 'none'; sendBtn.style.display = '';
      return;
    }
    let sinceRefresh = 0;
    // a recognised card's statement is wanted while Banking Aid hasn't it on
    // file — tried once per run (one lost in an import restart comes back
    // next run); a card it can't match yet goes by this browser's ticks
    const tried = new Set();
    // …and one sent in the last 12 hours is still in Banking Aid's import
    // queue, not missing: fetching it again only made copies
    const recentlySent = x => state[x.key + '@'] && Date.now() - state[x.key + '@'] < 12 * 3600000;
    const wanted = x => x.known ? !tried.has(x.key) && !recentlySent(x) : !state[x.key];
    const walk = async () => {
    const card = picked ? cardFor(picked.last4) : null;
    const years = yearsNeeded(card);
    const recent = (card ? missingOf(card) : CARDS.flatMap(missingOf)).some(g => g.b >= addDays(new Date().toISOString().slice(0, 10), -366));
    for (const view of filterViews().filter(v => !v || !v.label || (/last \d+ months/i.test(v.label) ? recent : [...years].some(y => v.label.includes(y))))) {
    if (stop) break;
    if (view) { const name = await view(); say('Looking at ' + name + '…'); self.dlog && dlog('filter view', name); emptyPages = 0; }
    pageLoop: while (!stop) {
      // one at a time, finding the row afresh each time: going back from a
      // statement re-draws the list, and an old row no longer opens anything
      for (;;) {
        if (stop) break pageLoop;
        hits = findHits(); render();
        const h = hits.find(wanted);
        if (!h) { self.dlog && dlog('nothing wanted here', { rows: seen.rows, dated: seen.dated, hits: hits.length, known: hits.filter(x => x.known).length, sample: seen.sample }); break; }
        tried.add(h.key);
        say('Getting ' + h.card + ' ' + h.date + '…');
        self.dlog && dlog('getting', h.key, location.href);
        const where = location.href;
        let file = await getFile(h, say);
        // one more go with longer to wait: big or old statements can take a
        // while to build on the bank's side
        if (file.why && !stop) {
          self.dlog && dlog('retrying', h.key, file.why);
          if (location.href !== where) { history.back(); await waitForList(); }
          const again = findHits().find(x => x.key === h.key);
          if (again) { say('Trying ' + h.card + ' ' + h.date + ' again, waiting longer…'); file = await getFile(again, say, 60000); }
        }
        self.dlog && dlog('file', h.key, file.why ? { why: file.why } : { how: file.how, bytes: file.bytes ? file.bytes.byteLength : null, url: file.url ? file.url.slice(0, 60) : null });
        if (stop) break pageLoop;
        if (file.why) { state[h.key] = 'failed'; state[h.key + '!'] = file.why; failed++; say('Couldn’t get ' + h.card + ' ' + h.date + ' (' + file.why + ').'); }
        else {
          say('Sending ' + h.card + ' ' + h.date + ' (' + file.how + ')…');
          const r = await call({ type: 'upload', cfg, card: h.account, pageLabel: h.pageLabel, rowLabel: h.label, name: h.date + ' ' + h.card + '.pdf', bytes: file.bytes || null, url: file.url || null });
          state[h.key] = r && r.ok ? 'sent' : 'failed';
          if (r && r.ok) { state[h.key + '@'] = Date.now(); delete state[h.key + '!']; } else state[h.key + '!'] = 'Banking Aid: ' + ((r && r.error) || 'upload failed');
          r && r.ok ? sent++ : failed++;
          if (!r || !r.ok) say(h.card + ' ' + h.date + ': ' + ((r && r.error) || 'upload failed'));
        }
        await save();
        if (location.href !== where) { history.back(); await waitForList(); }
        // statements sent a while ago have imported by now: take the fresh list
        if (++sinceRefresh >= 20) { sinceRefresh = 0; try { await loadCards(); } catch { /* keep the old list */ } }
        await sleep(500);
      }
      // pages run newest to oldest: past the oldest gap, nothing further is wanted
      const oldest = oldestNeeded(picked ? cardFor(picked.last4) : null);
      if (oldest && seen.newest && seen.newest < oldest) { self.dlog && dlog('past the oldest gap', oldest); break; }
      const next = nextControl();
      if (!next) break;
      next.scrollIntoView({ block: 'center' }); next.click(); pages++;
      await sleep(2500);
      // older pages can hold nothing missing for a while; a long run of them stops the walk
      emptyPages = findHits().some(wanted) ? 0 : emptyPages + 1;
      if (emptyPages >= 30 || pages >= 200) break;
    }
    }
    };
    // an account picker: every account in turn, the ones done kept so a
    // page reload carries on where it was
    let choices = accountChoices();
    if (choices.length > 1 && !findHits().length) {
      const run = resume || { at: Date.now(), done: [] };
      for (;;) {
        if (stop) break;
        choices = accountChoices();
        const c = choices.find(x => !run.done.includes(x.last4));
        if (!c) break;
        run.done.push(c.last4); run.at = Date.now(); await saveRun(run);
        // nothing missing for it (or not an account Banking Aid has): not opened
        if (!missingOf(cardFor(c.last4)).length) { self.dlog && dlog('skip account', c.last4); continue; }
        picked = c;
        accountsDone++;
        say('Opening ' + (c.name || 'account') + ' …' + c.last4 + '…');
        self.dlog && dlog('account', c.last4);
        emptyPages = 0;
        if (await choose(c)) await walk();
        if (stop) break;
        if (!await backToChoices()) { say('Couldn’t get back to the account list: open it again and press the button, it carries on with the next account.'); break; }
      }
      if (!stop && !accountChoices().some(x => !run.done.includes(x.last4))) await saveRun(null);
    } else await walk();
    if (stop) await saveRun(null);
    stopBtn.style.display = 'none'; sendBtn.style.display = '';
    hits = findHits(); render();
    // where things stand now, from Banking Aid itself: all done, or what the
    // bank doesn't have to give
    if (!stop) {
      // what was just sent is read first: wait for Banking Aid's queue (2 min at most)
      if (sent) {
        say('Waiting for Banking Aid to read what was sent…');
        for (let i = 0; i < 40 && !stop; i++) {
          await sleep(3000);
          try { const q = await call({ type: 'queue', cfg }); if (q && !q.active) break; } catch { break; }
        }
      }
      try { await loadCards(); } catch { /* keep the last list */ }
      hits = findHits(); render();
      const still = missingSummary();
      status.textContent = still
        ? 'Still missing — ' + still + '. ' + (BANK || 'The bank') + ' doesn’t list these as statements, so there’s nothing more to fetch here.'
        : 'Nothing missing for ' + (BANK || 'this bank') + ' — all done.';
      if (!still) { sendBtn.textContent = 'Nothing to fetch'; sendBtn.disabled = true; }
    }
    say((stop ? 'Stopped: ' : 'Done: ') + sent + ' statement' + (sent === 1 ? '' : 's') + ' sent to Banking Aid' + (failed ? ', ' + failed + ' couldn’t be fetched (marked red, with the reason)' : '') + ' across ' + (accountsDone ? accountsDone + ' account' + (accountsDone === 1 ? '' : 's') : pages + ' page' + (pages === 1 ? '' : 's')) + '. They import in the background — ');
    // where they went: Banking Aid's Import page lists them card by card
    const see = make('a', 'color:#7db7ff', 'see them in Banking Aid');
    see.href = (cfg && cfg.url ? cfg.url.replace(/\/$/, '') : '') + '/#import';
    see.target = '_blank';
    log.appendChild(see);
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
    sendBtn = make('button', btnCss, 'Fetch missing statements');
    sendBtn.title = 'Opens each statement Banking Aid hasn’t got, sends it there, and carries on through the older pages and years. Statements already in Banking Aid are skipped.';
    stopBtn = make('button', btnCss.replace('#2b6fd6', '#555'), 'Stop');
    stopBtn.style.display = 'none';
    const reset = make('button', btnCss.replace('#2b6fd6', '#333'), 'Clear ticks');
    reset.title = 'Forget which statements were sent, ticked or failed, to try them again';
    bar.appendChild(sendBtn); bar.appendChild(stopBtn); bar.appendChild(reset);
    panel.appendChild(bar);
    list = make('div'); panel.appendChild(list);
    log = make('div', 'color:#888;font-size:12px;margin-top:8px'); panel.appendChild(log);
    document.body.appendChild(panel);
    // Stop means now: the wait for a file ends, the run's leftovers go, and
    // the button comes back — whatever the run was doing
    stopBtn.onclick = () => {
      stop = true;
      if (caught) caught(null);
      call({ type: 'disarm' }).catch(() => {});
      saveRun(null);
      stopBtn.style.display = 'none'; sendBtn.style.display = '';
      say('Stopped.');
    };
    sendBtn.onclick = async () => {
      const { run } = await browser.storage.local.get('run');
      sendAll(run && Date.now() - run.at < 30 * 60000 ? run : null);
    };
    reset.onclick = () => { state = {}; save(); hits = findHits(); render(); };
    try { await loadCards(); await loadState(); if (BANK) title.textContent = 'Banking Aid - missing ' + BANK + ' statements'; }
    catch (e) { self.dlog && dlog('panel: loading cards failed', e); status.textContent = 'Could not reach Banking Aid: ' + e.message + '. Check the address and API token in the extension’s settings (toolbar button).'; return; }
    try { hits = findHits(); render(); self.dlog && dlog('page read', { rows: seen.rows, dated: seen.dated, hits: hits.length, sample: seen.sample }); }
    catch (e) { self.dlog && dlog('reading the page failed', e); status.textContent = 'Couldn’t read this page’s statements (' + e.message + ').'; }
  };
  // a run over a bank's accounts that a page load interrupted: open the panel
  // and carry on with the accounts not yet done
  (async () => {
    try {
      const { run } = await browser.storage.local.get('run');
      if (!run || Date.now() - run.at > 30 * 60000) return;
      await sleep(2000);
      // a run that went to the statements page: carry on there once it has
      // its account list or statements
      if (run.navigated) for (let i = 0; i < 20 && accountChoices().length < 2 && filterViews()[0] === null; i++) await sleep(500);
      if (panel || (accountChoices().length < 2 && !run.navigated)) return;
      await build();
      sendAll(run);
    } catch { /* nothing to resume */ }
  })();
  const toggle = () => {
    if (panel) { stop = true; for (const h of hits) h.row.style.outline = ''; panel.remove(); panel = null; return; }
    build();
  };
})();
