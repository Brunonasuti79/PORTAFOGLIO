/**
 * Portafoglio BIT — Capture Closing Prices
 * Secrets richiesti:  GIST_TOKEN
 * Secrets opzionali:  GIST_ID, FINNHUB_KEY, MARKET_OVERRIDE
 */
import https from 'https';

const GITHUB_TOKEN    = process.env.GIST_TOKEN;
const FINNHUB_KEY     = process.env.FINNHUB_KEY || '';
const MARKET_OVERRIDE = (process.env.MARKET_OVERRIDE || '').toUpperCase();

if (!GITHUB_TOKEN) { console.error('MANCA GIST_TOKEN'); process.exit(1); }

const GHDR = { 'Authorization': `token ${GITHUB_TOKEN}`, 'Accept': 'application/vnd.github+json' };

// ── HTTP helpers ──────────────────────────────────────────────────
function httpsGet(url, headers = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const req = https.request({
      hostname: u.hostname, path: u.pathname + u.search, method: 'GET',
      headers: { 'User-Agent': 'PortafoglioBIT/3.0', ...headers }
    }, res => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        resolve(httpsGet(res.headers.location, headers)); return;
      }
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        try   { resolve({ status: res.statusCode, body: JSON.parse(raw) }); }
        catch { resolve({ status: res.statusCode, body: raw }); }
      });
    });
    req.on('error', reject);
    req.setTimeout(14000, () => { req.destroy(); reject(new Error('Timeout: ' + url.slice(0, 60))); });
    req.end();
  });
}

function httpsPatch(url, payload, headers = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const body = JSON.stringify(payload);
    const req = https.request({
      hostname: u.hostname, path: u.pathname + u.search, method: 'PATCH',
      headers: {
        'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body),
        'User-Agent': 'PortafoglioBIT/3.0', ...headers
      }
    }, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        try   { resolve({ status: res.statusCode, body: JSON.parse(raw) }); }
        catch { resolve({ status: res.statusCode, body: raw }); }
      });
    });
    req.on('error', reject);
    req.setTimeout(18000, () => { req.destroy(); reject(new Error('Timeout PATCH')); });
    req.write(body); req.end();
  });
}

const delay = ms => new Promise(r => setTimeout(r, ms));

// ── Date helpers ──────────────────────────────────────────────────
function localDate(tz) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: tz }).format(new Date());
}

// ── Market detection — timezone-aware ────────────────────────────
function localMinutes(tz) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: tz, hour: '2-digit', minute: '2-digit', hour12: false
  }).formatToParts(new Date());
  const h = parseInt(parts.find(p => p.type === 'hour')?.value   || '0');
  const m = parseInt(parts.find(p => p.type === 'minute')?.value || '0');
  return h * 60 + m;
}

function detectMarket() {
  if (['EU', 'US', 'BOTH'].includes(MARKET_OVERRIDE)) return MARKET_OVERRIDE;
  const now = new Date();
  if (now.getUTCDay() === 0 || now.getUTCDay() === 6) return 'SKIP';
  const romeMin = localMinutes('Europe/Rome');
  const nyMin   = localMinutes('America/New_York');
  const euClosed = romeMin >= 17 * 60 + 40;
  const usClosed = nyMin   >= 16 * 60 + 10;
  if (usClosed)  return 'US';
  if (euClosed)  return 'EU';
  return 'SKIP';
}

const EU_RE = /\.(MI|MOT|DE|PA|L|SW|AS|F|ST|CO|HE|OL|BR|VX)$/i;
const isEU  = tk => EU_RE.test(tk);

const SFX = { MI:'it', MOT:'it', DE:'de', PA:'fr', L:'uk', SW:'ch',
              AS:'nl', F:'de', ST:'se', CO:'dk', HE:'fi', OL:'no', BR:'be', VX:'ch' };
function stooqSym(t) {
  const m = t.match(/^([^.]+)\.([A-Z]+)$/i);
  if (!m) return t.toLowerCase();
  const s = SFX[m[2].toUpperCase()];
  return s ? `${m[1].toLowerCase()}.${s}` : m[1].toLowerCase();
}

// ── Price fetchers ────────────────────────────────────────────────
async function fetchStooq(ticker) {
  try {
    const { status, body } = await httpsGet(
      `https://stooq.com/q/d/l/?s=${encodeURIComponent(stooqSym(ticker))}&i=d`
    );
    if (status !== 200 || typeof body !== 'string' || /no data/i.test(body)) return null;
    const lines = body.trim().split(/\r?\n/).filter(Boolean);
    if (lines.length < 2) return null;
    const last = lines[lines.length - 1].split(',');
    const prev = lines.length >= 3 ? lines[lines.length - 2].split(',') : null;
    const price = parseFloat(last[4]);
    if (!price || price <= 0) return null;
    return { price, prevClose: prev ? parseFloat(prev[4]) : null, date: last[0], source: 'Stooq' };
  } catch { return null; }
}

async function fetchYahooChart(ticker) {
  try {
    const { status, body } = await httpsGet(
      `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(ticker)}?interval=1d&range=5d`
    );
    if (status !== 200) return null;
    const r = body?.chart?.result?.[0], meta = r?.meta || {};
    const closes = (r?.indicators?.quote?.[0]?.close || []).filter(c => c != null && c > 0);
    const timestamps = r?.timestamp || [];
    const price = meta.regularMarketPrice;
    if (!price || price <= 0) return null;
    let date = null;
    if (timestamps.length > 0)
      date = new Date(timestamps[timestamps.length - 1] * 1000).toISOString().slice(0, 10);
    return { price, prevClose: meta.chartPreviousClose || closes[closes.length - 2] || null, date, source: 'Yahoo-chart' };
  } catch { return null; }
}

async function fetchYahooQuote(ticker) {
  try {
    const { status, body } = await httpsGet(
      `https://query1.finance.yahoo.com/v7/finance/quote?symbols=${encodeURIComponent(ticker)}&fields=regularMarketPrice,regularMarketPreviousClose`
    );
    if (status !== 200) return null;
    const q = body?.quoteResponse?.result?.[0];
    if (!q?.regularMarketPrice) return null;
    return { price: q.regularMarketPrice, prevClose: q.regularMarketPreviousClose || null, source: 'Yahoo-quote' };
  } catch { return null; }
}

async function fetchFinnhub(ticker, key) {
  if (!key) return null;
  try {
    const FH = { MI:'MIL', MOT:'MIL', DE:'XETRA', PA:'EPA', L:'LSE', AS:'AMS', SW:'SWX', F:'FRA' };
    const m = ticker.match(/^([^.]+)\.([A-Z]+)$/i);
    const sym = m ? `${FH[m[2].toUpperCase()] || m[2]}:${m[1]}` : ticker;
    const { status, body } = await httpsGet(
      `https://finnhub.io/api/v1/quote?symbol=${encodeURIComponent(sym)}&token=${encodeURIComponent(key)}`
    );
    if (status !== 200 || !body?.c || body.c <= 0) return null;
    return { price: body.c, prevClose: body.pc || null, source: 'Finnhub' };
  } catch { return null; }
}

async function fetchPrice(ticker) {
  const eu = isEU(ticker);
  const fns = eu
    ? [() => fetchStooq(ticker), () => fetchYahooChart(ticker), () => fetchYahooQuote(ticker)]
    : [() => fetchYahooQuote(ticker), () => fetchYahooChart(ticker), () => fetchFinnhub(ticker, FINNHUB_KEY), () => fetchStooq(ticker)];
  for (const fn of fns) {
    try { const r = await fn(); if (r?.price > 0) return r; } catch {}
    await delay(300);
  }
  return null;
}
// ── Storico ultimi 5 giorni (per backfill) ────────────────────────
// Restituisce { 'YYYY-MM-DD': { close, source } } per gli ultimi giorni disponibili.
async function fetchHistoricalCloses(ticker) {
  const eu = isEU(ticker);
  const result = {};

  // Stooq: restituisce CSV con tutte le righe giornaliere
  if (eu) {
    try {
      const { status, body } = await httpsGet(
        `https://stooq.com/q/d/l/?s=${encodeURIComponent(stooqSym(ticker))}&i=d`
      );
      if (status === 200 && typeof body === 'string' && !/no data/i.test(body)) {
        const lines = body.trim().split(/\r?\n/).filter(Boolean).slice(1); // salta header
        for (const line of lines.slice(-10)) { // ultimi 10 giorni
          const p = line.split(',');
          const date = p[0], close = parseFloat(p[4]);
          if (date && close > 0) result[date] = { close, source: 'Stooq' };
        }
        if (Object.keys(result).length) return result;
      }
    } catch {}
  }

  // Yahoo chart: range=10d, interval=1d → ultimi 10 giorni con timestamp reali
  try {
    const { status, body } = await httpsGet(
      `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(ticker)}?interval=1d&range=10d`
    );
    if (status === 200) {
      const r = body?.chart?.result?.[0];
      const closes    = r?.indicators?.quote?.[0]?.close || [];
      const timestamps = r?.timestamp || [];
      for (let i = 0; i < timestamps.length; i++) {
        const close = closes[i];
        if (!close || close <= 0) continue;
        const date = new Date(timestamps[i] * 1000).toISOString().slice(0, 10);
        result[date] = { close, source: 'Yahoo-chart' };
      }
    }
  } catch {}

  return result;
}

// Calcola gli ultimi N giorni lavorativi (no weekend) in UTC
function lastBusinessDays(n) {
  const days = [];
  const d = new Date();
  while (days.length < n) {
    d.setUTCDate(d.getUTCDate() - 1);
    if (d.getUTCDay() !== 0 && d.getUTCDay() !== 6)
      days.push(d.toISOString().slice(0, 10));
  }
  return days;
}

// Controlla le date mancanti negli ultimi 5 giorni e le recupera
async function backfillMissingDates(tickers, backup) {
  const recentDays = lastBusinessDays(5);
  let backfilled = 0, checked = 0;

  console.log(`
── Backfill (ultimi 5 giorni lavorativi: ${recentDays.join(', ')}) ──`);

  for (const ticker of tickers) {
    const existing = Object.keys(backup.officialCloses?.[ticker] || {});
    const missing  = recentDays.filter(d => !existing.includes(d));
    checked++;
    if (!missing.length) { process.stdout.write('.'); continue; }

    console.log(`
  ${ticker}: mancano [${missing.join(', ')}]`);
    const hist = await fetchHistoricalCloses(ticker);

    for (const date of missing) {
      if (!hist[date]) { console.log(`    NO  ${date} — non disponibile`); continue; }
      if (!backup.officialCloses[ticker])     backup.officialCloses[ticker]     = {};
      if (!backup.officialClosesMeta[ticker]) backup.officialClosesMeta[ticker] = {};
      backup.officialCloses[ticker][date] = {
        close:      hist[date].close,
        capturedAt: new Date().toISOString(),
        runDate:    today,
        source:     `${hist[date].source}-backfill`,
        market:     isEU(ticker) ? 'EU' : 'US'
      };
      backup.officialClosesMeta[ticker][date] = {
        source: `${hist[date].source}-backfill`, market: isEU(ticker) ? 'EU' : 'US'
      };
      console.log(`    OK  ${date} = ${hist[date].close}  [${hist[date].source}]`);
      backfilled++;
    }
    await delay(400);
  }

  if (checked > 0) console.log('');
  console.log(`Backfill: ${backfilled} date recuperate su ${tickers.length} ticker`);
  return backfilled;
}

// ── Gist I/O — token-only (GIST_ID opzionale) ────────────────────
async function findGistId() {
  if (process.env.GIST_ID) {
    console.log(`Gist ID da secret: ${process.env.GIST_ID}`);
    return process.env.GIST_ID;
  }
  console.log('GIST_ID non impostato — ricerca automatica...');
  let page = 1;
  while (page <= 5) {
    const { status, body } = await httpsGet(
      `https://api.github.com/gists?per_page=100&page=${page}`, GHDR
    );
    if (status !== 200 || !Array.isArray(body) || !body.length) break;
    const found = body.find(g => 'portafoglio-bit.json' in (g.files || {}));
    if (found) { console.log(`Gist trovato: ${found.id}`); return found.id; }
    if (body.length < 100) break;
    page++;
  }
  return null;
}

async function readGist(gistId) {
  const { status, body } = await httpsGet(`https://api.github.com/gists/${gistId}`, GHDR);
  if (status === 404) throw new Error('Gist non trovato (404)');
  if (status === 401) throw new Error('Token non autorizzato (401) — verifica GIST_TOKEN e scope "gist"');
  if (status !== 200) throw new Error(`Gist API: HTTP ${status}`);
  const files = body.files || {};
  console.log(`Files nel Gist: ${Object.keys(files).join(', ') || '(nessuno)'}`);
  const content = files['portafoglio-bit.json']?.content;
  if (!content) throw new Error(
    'File "portafoglio-bit.json" non trovato.\n→ Apri l\'app → Backup → "Salva su Gist" almeno una volta.'
  );
  const backup = JSON.parse(content);
  console.log(`Portafogli: ${backup.portfolios?.length || 0}`);
  (backup.portfolios || []).forEach((pf, i) => {
    const qty = {};
    (pf.ops || []).forEach(op => {
      const tk = op.quoteTicker || op.ticker;
      if (!tk || tk === '__CASH__') return;
      qty[tk] = (qty[tk] || 0) + (op.type === 'buy' ? 1 : -1) * (op.qty || 0);
    });
    const active = Object.entries(qty).filter(([, q]) => q > 0.001).map(([tk]) => tk);
    console.log(`  [${i}] "${pf.name || '?'}" — ${pf.ops?.length || 0} ops — attivi: ${active.join(', ') || '(nessuno)'}`);
  });
  console.log(`officialCloses: ${Object.keys(backup.officialCloses || {}).length} ticker`);
  return backup;
}

async function writeGist(gistId, backup) {
  const { status, body } = await httpsPatch(
    `https://api.github.com/gists/${gistId}`,
    { files: { 'portafoglio-bit.json': { content: JSON.stringify(backup) } } },
    GHDR
  );
  if (status !== 200) throw new Error(`Scrittura Gist: HTTP ${status} — ${JSON.stringify(body).slice(0, 200)}`);
}

function extractTickers(backup) {
  const qty = {};
  (backup.portfolios || []).forEach(pf => {
    (pf.ops || []).forEach(op => {
      const tk = op.quoteTicker || op.ticker;
      if (!tk || tk === '__CASH__') return;
      qty[tk] = (qty[tk] || 0) + (op.type === 'buy' ? 1 : -1) * (op.qty || 0);
    });
  });
  return Object.entries(qty).filter(([, q]) => q > 0.0001).map(([tk]) => tk);
}

// ── Main ──────────────────────────────────────────────────────────
const market     = detectMarket();
const today      = localDate('Europe/Rome');
// Per US usa la data di New York: evita sfasamenti dopo mezzanotte italiana
const marketDate = market === 'US' ? localDate('America/New_York') : today;

console.log('=== Portafoglio BIT — Official Closes ===');
console.log(`UTC: ${new Date().toISOString()} | Rome: ${today} | MarketDate: ${marketDate}`);
console.log(`Finnhub: ${FINNHUB_KEY ? 'presente' : 'assente'} | Market: ${market}`);

if (market === 'SKIP') {
  console.log('Fuori dalla finestra di cattura — exit');
  process.exit(0);
}

const gistId = await findGistId();
if (!gistId) {
  console.error('Nessun Gist con portafoglio-bit.json trovato.\n→ Apri l\'app → Backup → "Salva su Gist" almeno una volta.');
  process.exit(1);
}

const backup = await readGist(gistId);
const allTickers = extractTickers(backup);
console.log(`\nTicker attivi: ${allTickers.join(', ') || '(nessuno)'}`);

if (!allTickers.length) {
  console.log('\nNESSUN TICKER — Fai "Salva su Gist" dall\'app prima di lanciare questo script.');
  process.exit(0);
}

const tickers = allTickers.filter(tk => {
  if (market === 'EU') return  isEU(tk);
  if (market === 'US') return !isEU(tk);
  return true;
});

if (!tickers.length) {
  console.log(`Nessun ticker per mercato ${market}`);
  process.exit(0);
}

// ── Backfill date mancanti (ultimi 5 giorni lavorativi) ───────────
if (!backup.officialCloses)     backup.officialCloses     = {};
if (!backup.officialClosesMeta) backup.officialClosesMeta = {};
// Backfill su TUTTI i ticker, non solo il mercato corrente
// Così se il cron EU salta, il cron US recupera anche le chiusure EU
const backfilled = await backfillMissingDates(allTickers, backup);

console.log(`\nFetching ${tickers.length} prezzi correnti (${market})...`);
const results = {};
for (const ticker of tickers) {
  const r = await fetchPrice(ticker);
  if (r) {
    results[ticker] = r;
    console.log(`  OK  ${ticker.padEnd(18)} ${String(r.price).padEnd(10)}  [${r.source}]${r.date ? '  date:' + r.date : ''}`);
  } else {
    console.log(`  NO  ${ticker}`);
  }
  await delay(400);
}

if (!Object.keys(results).length) {
  console.log('Nessun prezzo ottenuto — Gist invariato');
  process.exit(0);
}

// ── Salva chiusure correnti nel Gist ─────────────────────────────
let saved = 0;
for (const [ticker, data] of Object.entries(results)) {
  if (!backup.officialCloses[ticker])     backup.officialCloses[ticker]     = {};
  if (!backup.officialClosesMeta[ticker]) backup.officialClosesMeta[ticker] = {};

  // Priorità: data reale dall'API → data del mercato (NY per US, Roma per EU)
  const saveDate = data.date || marketDate;

  backup.officialCloses[ticker][saveDate] = {
    close:      data.price,
    prevClose:  data.prevClose || null,
    capturedAt: new Date().toISOString(),
    runDate:    today,
    source:     `${data.source}-auto`,
    market
  };
  backup.officialClosesMeta[ticker][saveDate] = {
    source: data.source, capturedAt: new Date().toISOString(), market, runDate: today
  };

  // Nessun limite storico — i dati si accumulano per sempre

  saved++;
}

backup.officialClosesMeta['__lastRun'] = {
  at: new Date().toISOString(), market, saved, runDate: today, marketDate
};

console.log(`\nSalvataggio ${saved} chiusure nel Gist...`);
await writeGist(gistId, backup);
console.log(`DONE — saved:${saved}  backfilled:${backfilled}  marketDate:${marketDate}  market:${market}`);
