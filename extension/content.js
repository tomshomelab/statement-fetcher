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
  const isPdfViewer = d => !!(d && (d.contentType === 'application/pdf' || d.querySelector('#viewerContainer, .pdfViewer, .textLayer, #scaleSelect, embed[type="application/pdf"]')));
  const everything = (root, visit) => {
    if (!root) return;
    // a PDF viewer built into the page: its printed dates and page arrows are
    // the statement on screen, not a list of statements — skipped whole
    const walk = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT, {
      acceptNode: n => n.nodeType === 1 && n.matches && n.matches('#viewerContainer, .pdfViewer, .textLayer, #toolbarContainer, #scaleSelect')
        ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT
    });
    for (let n = walk.currentNode; n; n = walk.nextNode()) {
      visit(n);
      if (n.nodeType === 1) {
        if (n.shadowRoot) everything(n.shadowRoot, visit);
        // a statement open in a PDF viewer is a document, not a list of
        // statements: its printed dates and its page arrows are left alone
        if (n.tagName === 'IFRAME') { try { const d = n.contentDocument; if (d && !isPdfViewer(d)) everything(d.body, visit); } catch { /* other origin */ } }
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
    seen = { dated, rows: rows.size, sample: rows.size ? textOf([...rows.keys()][0]).slice(0, 90) : '', newest: rowDates[rowDates.length - 1] || null, oldest: rowDates[0] || null };
    const hits = [];
    const sameDate = new Map();
    const whole = pageCard();
    for (const [row, leaf] of rows) {
      const text = textOf(row);
      // transaction statements only: not letters, notices, annual summaries or
      // statements of fees (no payments in them to import)
      // (a yearly savings statement is a statement: some accounts only get those)
      if (!/statement/i.test(text) || /\b(fees?|summary|interest rate)\b/i.test(text)) continue;
      // the period printed on the row, else the month before its date
      const printed = periodIn(text);
      const date = printed ? printed.b : dateIn(text);
      if (!date) continue;
      const period = printed || { a: addDays(date, -31), b: addDays(date, -1) };
      const have = stems(text);
      let card = null, best = 0;
      for (const c of CARDS) for (const ws of c.wordSets) if (ws.every(w => have.has(w)) && ws.length > best) { card = c; best = ws.length; }
      card = card || whole;
      // how the bank names the card on this row ("Saving - Main"): the text
      // left once the date and the document's title ("Account Statement") go
      // (a row's own buttons aren't its name; on a page reached through an
      // account picker, the account picked is)
      const cleaned = text.replace(RANGE, ' ').replace(DATE, ' ').replace(/^.*?\bstatement\b\s*/i, '').replace(/[›>»]\s*$/, '')
        .replace(/\b(download|view|save|open|pdf)\b/gi, ' ').replace(/[^\p{L}\p{N}&'’ .()-]/gu, ' ').replace(/\s+/g, ' ').trim().slice(0, 60);
      // a page about one account (its header prints sort code + number) is
      // named by that account — row text there carries screen-reader words
      const pageLabel = (picked && picked.name) || pageAccountName() || (/\p{L}{2}/u.test(cleaned) ? cleaned : '');
      // an account Banking Aid doesn't have yet, opened from the bank's list:
      // every statement it lists is taken — Banking Aid makes the card from
      // the first and files the rest; once the card exists, what it has is left
      if (newMode && picked) {
        const mine = cardFor(picked.last4);
        if (mine && onFile(mine, period)) continue;
        const base = 'new|' + picked.last4 + '|' + date;
        const nth = (sameDate.get(base) || 0) + 1;
        sameDate.set(base, nth);
        const label = text.slice(0, 80) + (nth > 1 ? ' #' + nth : '');
        if (mine && (mine.skip || []).some(s => s.date === date && (!s.rowLabel || s.rowLabel === label))) continue;
        hits.push({ row, leaf, key: base + (nth > 1 ? '#' + nth : ''), card: mine ? mine.card : newName(picked), account: mine ? mine.card : 'Unsorted', known: true, pageLabel, date, label, gap: 'new|' + picked.last4 });
        continue;
      }
      // an account Banking Aid doesn't have: nothing on its list
      if (!card) continue;
      // the bank lists this period: whether a wanted gap was offered is told
      // from these once the account's list has been walked
      sightings(card).set(period.a + '|' + period.b, { ...period, label: text.slice(0, 70) });
      if (onFile(card, period)) continue;
      // older than the earliest statement Banking Aid has: not wanted
      if (card.from && period.b < card.from) continue;
      // two rows on one date (a statement and the yearly statement of fees,
      // dated alike): told apart by their order, so trying one never counts
      // as trying the other
      const base = card.card + '|' + date;
      const nth = (sameDate.get(base) || 0) + 1;
      sameDate.set(base, nth);
      const label = text.slice(0, 80) + (nth > 1 ? ' #' + nth : '');
      // a row Banking Aid found wasn't a statement (a yearly statement of fees)
      if ((card.skip || []).some(s => s.date === date && (!s.rowLabel || s.rowLabel === label))) continue;
      // wanted only for a statement on Banking Aid's list (one once thought
      // not offered counts, now it's listed)
      const gap = [...missingOf(card), ...card.notOffered].find(g => covers(g, period));
      if (!gap) continue;
      hits.push({ row, leaf, key: base + (nth > 1 ? '#' + nth : ''), card: card.card, account: card.card, known: true, pageLabel, date, label, gap: itemKey(card.card, gap) });
    }
    return hits.sort((a, b) => a.card.localeCompare(b.card) || a.date.localeCompare(b.date));
  };
  // which bank this page belongs to: the bank name Banking Aid has for a card,
  // found in this site's address ("mybank" in online.mybank.co.uk). Only that
  // bank's cards are looked for; if none matches, every card is.
  let BANK = null;
  let cfg = null; // Banking Aid address + token, sent with every request
  const squash = s => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  // Banking Aid's fetch plan for this bank: its accounts, every name the
  // bank uses for each, and exactly which statements are wanted. Nothing
  // else is fetched by a run.
  const loadCards = async () => {
    cfg = await browser.storage.local.get(['url', 'token']);
    const plan = await call({ type: 'plan', cfg, host: location.hostname });
    if (plan && plan.error) throw new Error(plan.error);
    BANK = plan.bank || null;
    // a card is found by the words of its names — not its bank's name, which
    // the bank's own page doesn't repeat on every line
    const STOP = ['card', 'account', 'statement', 'the', 'isa', 'and'];
    const words = s => String(s || '').toLowerCase().split(/[^a-z0-9]+/).filter(w => w.length >= 3);
    const bankWords = words(BANK);
    const period = g => ({ a: g.from, b: g.to });
    CARDS = (plan.accounts || []).map(c => ({
      card: c.card,
      // every name the bank has used for it ("Everyday Saver", now "Saving - Main")
      wordSets: (c.names || []).map(l => [...new Set(words(l).filter(w => !STOP.includes(w) && !bankWords.includes(w)).map(w => w.slice(0, 5)))]).filter(ws => ws.length),
      last4: c.last4 || null,
      // the earliest statement on file: nothing older is wanted
      from: c.from || null,
      ranges: c.have || [],
      skip: c.never || [],
      gaps: (c.want || []).filter(g => g.status === 'wanted').map(g => ({ ...period(g), n: g.statements || 1 })),
      notOffered: (c.want || []).filter(g => g.status === 'not-offered').map(period)
    })).filter(c => c.wordSets.length || c.last4);
    // the panel's list: every statement wanted since the panel opened,
    // ticked off once Banking Aid has it
    for (const c of CARDS) for (const [g, st] of [...missingOf(c).map(g => [g, 'wanted']), ...c.notOffered.map(g => [g, 'not-offered'])]) {
      const k = itemKey(c.card, g);
      if (!items.has(k)) items.set(k, { key: k, card: c.card, a: g.a, b: g.b, n: g.n || 1, status: st });
    }
    for (const it of items.values()) {
      if (it.isNew) continue; // a new account's status is the walk's
      const c = CARDS.find(x => x.card === it.card);
      const same = g => g.a === it.a && g.b === it.b;
      if (c && c.notOffered.some(same)) it.status = 'not-offered';
      else if (!c || !missingOf(c).some(same)) it.status = 'got';
      else if (it.status !== 'fetching' && it.status !== 'failed') it.status = 'wanted';
    }
  };
  const items = new Map();
  // accounts on the bank's own list that Banking Aid doesn't have: all their
  // statements are wanted (a household member's own accounts, say)
  let newMode = false;
  const newName = c => (c.name || 'Account') + ' …' + c.last4;
  const noteNewAccounts = () => {
    for (const c of accountChoices()) {
      if (cardFor(c.last4) || items.has('new|' + c.last4)) continue;
      items.set('new|' + c.last4, { key: 'new|' + c.last4, card: newName(c), isNew: true, n: 0, sent: 0, status: 'wanted' });
    }
  };
  // accounts on an overview page Banking Aid hasn't got (no balances sent: that's a run's)
  const noteTiles = () => { for (const t of accountTiles()) if (!cardFor(t.last4) && !items.has('new|' + t.last4)) items.set('new|' + t.last4, { key: 'new|' + t.last4, card: newName(t), isNew: true, n: 0, sent: 0, status: 'wanted' }); };
  const newLeft = () => [...items.values()].some(it => it.isNew && it.status !== 'got');
  const report = r => call({ type: 'report', cfg, report: r }).catch(() => {});
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
  // a statement is for a gap when it covers a real part of it (half the gap,
  // or a week): the statement before it, touching it by a day, isn't
  const covers = (g, p) => {
    // a yearly summary listed alongside (an "April Statement" covering a
    // whole year) isn't the month a monthly gap wants
    if (days(p.a, p.b) > 100 && days(g.a, g.b) < 100) return false;
    const o = (new Date(p.b < g.b ? p.b : g.b) - new Date(p.a > g.a ? p.a : g.a)) / 86400000 + 1;
    return o >= Math.min(7, Math.max(1, (days(g.a, g.b) + 1) / 2));
  };
  const itemKey = (card, g) => card + '|' + g.a + '|' + g.b;
  const cardFor = last4 => CARDS.find(c => c.last4 && c.last4 === last4) || null;
  const monthOf = d => new Date(d + 'T00:00:00Z').toLocaleDateString('en-GB', { month: 'short', year: 'numeric', timeZone: 'UTC' });
  // "May–Aug 2021 (3)": a gap's whole span, and the statements in it
  const spanOf = g => {
    const a = monthOf(g.a), b = monthOf(g.b);
    const span = a === b ? b : a.slice(-4) === b.slice(-4) ? a.slice(0, -5) + '–' + b : a + ' – ' + b;
    return span + ' (' + (g.n || 1) + ')';
  };
  const missingSummary = () => CARDS.filter(c => missingOf(c).length).map(c => c.card + ': ' + missingOf(c).map(spanOf).join(', ')).join(' · ');
  // the years worth opening on a year filter, for one card or every card here
  const yearsNeeded = card => new Set((card ? missingOf(card) : CARDS.flatMap(missingOf)).flatMap(g => {
    const out = []; for (let y = Number(g.a.slice(0, 4)); y <= Number(g.b.slice(0, 4)) + 1; y++) out.push(String(y)); return out;
  }));
  const oldestNeeded = card => (card ? missingOf(card) : CARDS.flatMap(missingOf)).map(g => g.a).sort()[0] || null;
  const notOfferedSummary = () => CARDS.filter(c => c.notOffered.length).map(c => c.card + ': ' + c.notOffered.map(g => monthOf(g.b)).join(', ')).join(' · ');
  const count = (n, what) => n + ' ' + what + (n === 1 ? '' : 's');

  // ── what the bank offers: told back to Banking Aid ──────────────────────
  // every statement period the bank's list showed, per account, this run
  let seenPeriods = new Map();
  const sightings = card => { if (!seenPeriods.has(card.card)) seenPeriods.set(card.card, new Map()); return seenPeriods.get(card.card); };
  // a wanted gap the bank's list runs right across (statements before and
  // after it) without one for the gap: the bank doesn't offer it. A list that
  // didn't reach that far says nothing.
  const reportNotOffered = async cards => {
    let n = 0;
    for (const c of cards) {
      const ps = [...(seenPeriods.get(c.card) || new Map()).values()];
      if (!ps.length) continue;
      const oldest = ps.map(p => p.a).sort()[0], newest = ps.map(p => p.b).sort().pop();
      for (const g of missingOf(c)) {
        // the bank's own statement for it is one Banking Aid already has,
        // filed under a narrower period (its rows' dates): nothing to fetch
        const held = ps.find(p => covers(g, p) && onFile(c, p));
        if (held) {
          self.dlog && dlog('already on file', c.card, g, held.label);
          await report({ card: c.card, outcome: 'on-file', from: g.a, to: g.b, detail: held.a + '→' + held.b + ' ' + held.label });
          continue;
        }
        // what the bank listed around each wanted statement, for the log: why
        // it was fetched, left, or found not offered
        self.dlog && dlog('gap check', c.card, g.a + '→' + g.b, {
          covering: ps.filter(p => covers(g, p)).map(p => p.a + '→' + p.b + ' ' + p.label),
          near: ps.filter(p => days(p.b, g.a) <= 45 || days(p.a, g.b) <= 45).map(p => p.a + '→' + p.b + ' ' + p.label),
          listReaches: oldest + '→' + newest
        });
        if (ps.some(p => covers(g, p)) || oldest > g.a || newest < g.b) continue;
        self.dlog && dlog('not offered', c.card, g);
        await report({ card: c.card, outcome: 'not-offered', from: g.a, to: g.b });
        n++;
      }
    }
    return n;
  };

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
    // the bank's rows that are wanted get an outline on the page; the panel
    // lists only what Banking Aid wants, each ticked off once it has it
    for (const h of hits) mark(h, state[h.key]);
    list.textContent = '';
    let group = null;
    const all = [...items.values()].sort((x, y) => x.card.localeCompare(y.card) || (x.a || '').localeCompare(y.a || ''));
    for (const it of all) {
      if (it.card !== group) { group = it.card; list.appendChild(make('div', 'margin-top:10px;color:#7db7ff;font-weight:600', it.card)); }
      const line = make('label', 'display:flex;gap:8px;align-items:flex-start;padding:5px 0;border-top:1px solid #333');
      const box = make('input'); box.type = 'checkbox'; box.disabled = true; box.checked = it.status === 'got';
      const tag = { got: '', wanted: '', fetching: ' — fetching…', failed: ' — couldn’t get it: ' + (it.why || 'no reason'), 'not-offered': ' — ' + (BANK || 'the bank') + ' doesn’t offer it' }[it.status];
      const name = make('span', it.status === 'got' ? 'text-decoration:line-through;color:#888' : it.status === 'failed' ? 'color:#ff8a8a' : it.status === 'not-offered' ? 'color:#888' : '',
        (it.isNew ? 'new to Banking Aid — all statements' + (it.sent ? ` · ${it.sent} sent` : '') : spanOf(it)) + tag);
      // one click: this one, if it's on this page
      if (!it.isNew && (it.status === 'wanted' || it.status === 'failed')) {
        name.style.cursor = 'pointer';
        name.title = 'Fetch this statement';
        name.onclick = ev => {
          ev.preventDefault();
          const h = findHits().find(x => x.gap === it.key);
          if (h) fetchOne(h); else say('Not on this page: Fetch all missing finds it.');
        };
      }
      line.appendChild(box); line.appendChild(name);
      list.appendChild(line);
    }
    sendBtn.textContent = 'Fetch all missing';
    status.textContent = statusLine();
  };
  // where this bank stands: wanted, got (since the panel opened), and what the
  // bank was found not to offer — counted in statements
  const statusLine = () => {
    const fresh = [...items.values()].filter(it => it.isNew && it.status !== 'got').length;
    if (!BANK) return fresh ? `New to Banking Aid: ${count(fresh, 'account')} — every statement will be fetched` : 'Banking Aid has no accounts at this bank.';
    const sum = st => [...items.values()].filter(it => !it.isNew && st.includes(it.status)).reduce((n, it) => n + it.n, 0);
    const want = sum(['wanted', 'fetching', 'failed']), got = sum(['got']), no = sum(['not-offered']);
    return [want ? 'Wanted ' + want : fresh ? '' : 'Nothing missing for ' + BANK, fresh && 'New accounts ' + fresh, got && 'Got ' + got, no && 'Not offered ' + no].filter(Boolean).join(' · ');
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
  // a list that hides some accounts behind "Show all accounts": opened first
  const showAllAccounts = async () => {
    const more = clickable(document.body, n => /\b(show|view|see) all (my )?accounts\b/i.test(textOf(n) + ' ' + (n.getAttribute('aria-label') || '')) && shown(n));
    if (!more) return false;
    more.click();
    await sleep(1500);
    self.dlog && dlog('showed all accounts');
    return true;
  };
  // the bank's account list (an overview, or the statements page's picker):
  // each account's number and the balance the page shows for it
  const accountTiles = () => {
    const out = new Map();
    everything(document.body, n => {
      if (n.nodeType !== 3 || !n.parentElement || inPanel(n.parentElement) || !/\b\d{8}\b/.test(n.nodeValue || '')) return;
      for (let p = n.parentElement, i = 0; p && i < 8; p = up(p), i++) {
        const t = textOf(p);
        if (t.length > 400) break;
        const m = t.match(ACCT), money = t.match(/([-−])?\s*£\s?([-−])?\s?([\d,]+\.\d{2})/);
        if (!m || !money) continue;
        // a box holding two accounts isn't one account's
        if ((t.match(new RegExp(ACCT.source, 'g')) || []).length > 1) break;
        const last4 = m[1].slice(-4);
        if (!out.has(last4)) out.set(last4, {
          last4, number: m[1], sortCode: (t.match(/\b(\d{2}-\d{2}-\d{2})\s+\d{8}\b/) || [])[1] || null,
          name: t.replace(ACCT, ' ').replace(/[-−]?£\s?[-−]?[\d,]+\.\d{2}/g, ' ').replace(/\b(available balance|balance|recent transactions|view transactions)\b/gi, ' ').replace(/[›>»]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 40),
          balance: (money[1] || money[2] ? -1 : 1) * Number(money[3].replace(/,/g, ''))
        });
        break;
      }
    });
    return [...out.values()];
  };
  // each account's balance on the bank's page, as Banking Aid's balance for
  // it today (an account it hasn't got keeps it until its card is made)
  const sendSiteBalances = async () => {
    await showAllAccounts();
    const tiles = accountTiles();
    let n = 0;
    for (const t of tiles) {
      const r = await call({ type: 'balance', cfg, balance: { number: t.number, sortCode: t.sortCode, name: t.name, balance: t.balance } }).catch(() => null);
      if (r && !r.error) n++;
    }
    self.dlog && dlog('site balances', tiles.map(t => ({ last4: t.last4, balance: t.balance })), n + ' saved');
    for (const t of tiles) if (!cardFor(t.last4) && !items.has('new|' + t.last4)) items.set('new|' + t.last4, { key: 'new|' + t.last4, card: newName(t), isNew: true, n: 0, sent: 0, status: 'wanted' });
    return n;
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

  // after a statement is sent: wait for Banking Aid to read it (a minute at
  // most) and take its list afresh — a statement is ticked off only once
  // Banking Aid has it, and a copy of one it has is never fetched
  const settle = async () => {
    for (let i = 0; i < 30 && !stop; i++) {
      await sleep(2000);
      try { const q = await call({ type: 'queue', cfg }); if (q && !q.active) break; } catch { break; }
    }
    try { await loadCards(); } catch { /* keep the last list */ }
  };
  // one statement: its file from the bank, into Banking Aid → 'sent' or
  // 'failed'. backToList: going back from a statement can land the list on
  // another page, so the walk puts it back
  const take = async (h, { retry = false, backToList = async () => {} } = {}) => {
    const it = h.gap ? items.get(h.gap) : null;
    if (it) { it.status = 'fetching'; render(); }
    say('Getting ' + h.card + ' ' + h.date + '…');
    self.dlog && dlog('getting', h.key, location.href);
    const where = location.href;
    const back = async () => { if (location.href !== where) { history.back(); await waitForList(); } await backToList(); };
    let file = await getFile(h, say);
    // one more go with longer to wait: big or old statements can take a
    // while to build on the bank's side
    if (file.why && retry && !stop) {
      self.dlog && dlog('retrying', h.key, file.why);
      await back();
      const again = findHits().find(x => x.key === h.key);
      if (again) { say('Trying ' + h.card + ' ' + h.date + ' again, waiting longer…'); file = await getFile(again, say, 60000); }
    }
    self.dlog && dlog('file', h.key, file.why ? { why: file.why } : { how: file.how, bytes: file.bytes ? file.bytes.byteLength : null, url: file.url ? file.url.slice(0, 60) : null });
    let ok = false;
    if (file.why) {
      if (it) { it.status = 'failed'; it.why = file.why; }
      say('Couldn’t get ' + h.card + ' ' + h.date + ' (' + file.why + ').');
      report({ card: h.card, outcome: 'download-failed', date: h.date, rowLabel: h.label, detail: file.why });
    } else if (!stop) {
      say('Sending ' + h.card + ' ' + h.date + '…');
      const r = await call({ type: 'upload', cfg, card: h.account, pageLabel: h.pageLabel, rowLabel: h.label, name: h.date + ' ' + h.card + '.pdf', bytes: file.bytes || null, url: file.url || null });
      ok = !!(r && r.ok);
      if (!ok) {
        const why = 'Banking Aid: ' + ((r && r.error) || 'upload failed');
        if (it) { it.status = 'failed'; it.why = why; }
        say(h.card + ' ' + h.date + ': ' + why);
      }
    }
    state[h.key] = ok ? 'sent' : 'failed';
    await save();
    await back();
    if (ok && it?.isNew) it.sent++;
    if (ok) { say('Banking Aid is reading ' + h.card + ' ' + h.date + '…'); await settle(); }
    // still on the list after Banking Aid read it (it wasn't the statement): wanted again
    if (it && it.status === 'fetching') it.status = 'wanted';
    hits = findHits(); render();
    return ok ? 'sent' : 'failed';
  };
  // one statement from the list, straight into Banking Aid
  let busyOne = false;
  const fetchOne = async h => {
    if (busyOne) return;
    busyOne = true; stop = false;
    try { await take(h); } finally { busyOne = false; }
  };
  const prevControl = () => clickable(document.body, n => {
    const t = (textOf(n) + ' ' + (n.getAttribute('aria-label') || '') + ' ' + (n.getAttribute('title') || '')).toLowerCase();
    if (!/\b(prev(ious)?( page)?|newer)\b|^\s*[‹<«]\s*$/.test(t)) return false;
    return !(n.disabled || n.getAttribute('aria-disabled') === 'true' || /disabled/.test(n.className || ''));
  });
  const turn = async ctl => { ctl.scrollIntoView({ block: 'center' }); ctl.click(); await sleep(2500); findHits(); };
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
    for (const it of (resume && resume.fresh) || []) if (!items.has(it.key)) items.set(it.key, { ...it, isNew: true, n: 0, sent: 0, status: 'wanted' });
    let sent = 0, failed = 0;
    say('Asking Banking Aid what it wants…');
    try { await loadCards(); render(); } catch (e) { say('Could not reach Banking Aid: ' + e.message); stopBtn.style.display = 'none'; sendBtn.style.display = ''; return; }
    // nothing missing and no account here Banking Aid hasn't got: nothing to
    // do (a bank's account list is only seen on its statements page)
    // the balances the bank's page shows, once a run (before leaving an overview)
    if (!(resume && resume.navigated)) { const b = await sendSiteBalances(); if (b) say(`${b} account balance${b === 1 ? '' : 's'} from the bank's page saved`); }
    else await showAllAccounts();
    noteNewAccounts(); render();
    const onList = accountChoices().length > 1 || findHits().length || filterViews()[0] !== null;
    if (!missingSummary() && !newLeft() && (onList || (resume && resume.navigated))) { say('Nothing to fetch.'); stopBtn.style.display = 'none'; sendBtn.style.display = ''; return; }
    // a statement open in the bank's PDF viewer: back to the list first (once)
    const viewerOpen = isPdfViewer(document) || [...document.querySelectorAll('iframe, embed, object')].some(f => {
      if (/pdf/i.test(f.getAttribute('type') || '')) return true;
      try { return isPdfViewer(f.contentDocument); } catch { return false; }
    });
    if (viewerOpen && !(resume && resume.leftViewer)) {
      say('Closing the open statement and going back to the list…');
      self.dlog && dlog('leaving the PDF viewer');
      history.back();
      await waitForList();
      return runAll({ ...(resume || { at: Date.now(), done: [] }), leftViewer: true });
    }
    // not the statements page (an account overview, a home page): go to the
    // bank's statements page and carry on there — on this page if it's an
    // in-page route, after the load if it reloads
    const overview = accountChoices().length < 2 && accountTiles().length > 0;
    if (!(resume && resume.navigated) && !findHits().length && accountChoices().length < 2 && filterViews()[0] === null && (seen.rows < 3 || overview)) {
      const link = clickable(document.body, n => /^(statements?\s*(and|&)\s*documents|statements|view statements|e-?statements|documents)$/i.test(textOf(n)));
      if (link) {
        say('Opening the statements page…');
        const run = { at: Date.now(), done: [], navigated: true, fresh: [...items.values()].filter(it => it.isNew).map(it => ({ key: it.key, card: it.card })) };
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
    // each row tried once per run; only rows for a statement on the list
    const tried = new Set();
    const wanted = x => x.known && x.gap && !tried.has(x.key);
    seenPeriods = new Map();
    let unoffered = 0;
    const walk = async () => {
      const card = picked ? cardFor(picked.last4) : null;
      const gapsHere = () => card ? missingOf(card) : CARDS.flatMap(missingOf);
      const years = yearsNeeded(card);
      const recent = gapsHere().some(g => g.b >= addDays(new Date().toISOString().slice(0, 10), -366));
      // an account new to Banking Aid: every view, every page
      const views = newMode ? filterViews() : filterViews().filter(v => !v || !v.label || (/last \d+ months/i.test(v.label) ? recent : [...years].some(y => v.label.includes(y))));
      for (const view of views) {
        if (stop || (!newMode && !gapsHere().length)) break;
        if (view) { const name = await view(); say('Looking at ' + name + '…'); self.dlog && dlog('filter view', name); }
        // a list (newest first) left on an older page than anything wanted —
        // where the last run ended: back to newer pages first
        findHits();
        for (let i = 0; i < 60 && !stop && !newMode; i++) {
          const newestWanted = gapsHere().map(g => g.b).sort().pop();
          const p = newestWanted && seen.newest && seen.newest < newestWanted ? prevControl() : null;
          if (!p) break;
          self.dlog && dlog('back a page', seen.newest);
          await turn(p);
        }
        for (let pages = 1; !stop && pages < 200; pages++) {
          const pageNewest = seen.newest;
          // going back from a statement can show the list's first page again:
          // on to the page it was on, without reading the ones between
          const backToList = async () => {
            findHits();
            for (let i = 0; i < 60 && !stop && pageNewest && seen.newest && seen.newest > pageNewest; i++) { const n = nextControl(); if (!n) break; await turn(n); }
          };
          for (;;) {
            if (stop) break;
            hits = findHits(); render();
            const h = hits.find(wanted);
            if (!h) { self.dlog && dlog('nothing wanted here', { rows: seen.rows, hits: hits.length, sample: seen.sample }); break; }
            tried.add(h.key);
            (await take(h, { retry: true, backToList })) === 'sent' ? sent++ : failed++;
          }
          if (stop) break;
          // nothing left wanted, or this page already older than the oldest
          // gap (newest first: every page after it is older still)
          const oldest = gapsHere().map(g => g.a).sort()[0];
          if (!newMode && !oldest) { self.dlog && dlog('nothing left wanted'); break; }
          if (!newMode && seen.oldest && seen.oldest < oldest) { self.dlog && dlog('past the oldest gap', oldest); break; }
          const next = nextControl();
          if (!next) break;
          const was = seen.rows + '|' + seen.sample + '|' + seen.newest;
          say((newMode ? 'Taking every statement for ' + newName(picked) : 'Looking for ' + missingSummary()) + ' — page ' + (pages + 1) + '…');
          await turn(next);
          // "next" that leaves the same rows isn't another page: there are no more
          if (seen.rows + '|' + seen.sample + '|' + seen.newest === was) { self.dlog && dlog('next went nowhere — last page'); break; }
        }
      }
    };
    // an account picker: each account with something wanted, in turn — the
    // ones done kept so a page reload carries on where it was
    let choices = accountChoices();
    if (choices.length > 1 && !findHits().length) {
      const run = resume || { at: Date.now(), done: [] };
      for (;;) {
        if (stop) break;
        choices = accountChoices();
        const c = choices.find(x => !run.done.includes(x.last4));
        if (!c) break;
        run.done.push(c.last4); run.at = Date.now(); await saveRun(run);
        const fresh = !cardFor(c.last4);
        if (!fresh && !missingOf(cardFor(c.last4)).length) { self.dlog && dlog('skip account', c.last4); continue; }
        picked = c;
        newMode = fresh;
        const item = items.get('new|' + c.last4);
        if (fresh && item) { item.status = 'fetching'; render(); }
        say('Opening ' + (c.name || 'account') + ' …' + c.last4 + '…');
        self.dlog && dlog('account', c.last4);
        if (await choose(c)) await walk();
        newMode = false;
        if (fresh && item && !stop) { item.status = 'got'; render(); }
        if (stop) break;
        unoffered += await reportNotOffered([cardFor(c.last4)].filter(Boolean));
        if (!missingSummary() && !newLeft()) break;
        if (!await backToChoices()) { say('Couldn’t get back to the account list: open it again and press the button, it carries on with the next account.'); break; }
      }
      await saveRun(null);
    } else {
      await walk();
      if (!stop) unoffered += await reportNotOffered(CARDS);
    }
    if (stop) await saveRun(null);
    stopBtn.style.display = 'none'; sendBtn.style.display = '';
    if (!stop) { try { await loadCards(); } catch { /* keep the last list */ } }
    hits = findHits(); render();
    if (!missingSummary()) { sendBtn.textContent = 'Nothing to fetch'; sendBtn.disabled = true; }
    say((stop ? 'Stopped: ' : 'Done: ') + 'sent ' + sent + (failed ? ', ' + failed + ' couldn’t be fetched' : '') + (unoffered ? ', ' + unoffered + ' not offered by ' + (BANK || 'the bank') : '') + ' — ');
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
    // every statement on the list, wherever the bank keeps it (one alone:
    // click it in the list)
    sendBtn = make('button', btnCss, 'Fetch all missing');
    sendBtn.title = 'Finds and fetches every statement on the list';
    stopBtn = make('button', btnCss.replace('#2b6fd6', '#555'), 'Stop');
    stopBtn.style.display = 'none';
    bar.appendChild(sendBtn); bar.appendChild(stopBtn);
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
    try { await loadCards(); await loadState(); noteNewAccounts(); noteTiles(); if (BANK) title.textContent = 'Banking Aid - missing ' + BANK + ' statements'; }
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
