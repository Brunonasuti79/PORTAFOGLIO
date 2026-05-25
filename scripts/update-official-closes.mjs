/**
 * Portafoglio BIT — Capture Closing Prices
 * Scrive su Gist (backward compat) + Supabase market_data
 * Secrets: GIST_TOKEN, GIST_ID (opt), FINNHUB_KEY (opt),
 *          SUPABASE_URL, SUPABASE_SERVICE_KEY, MARKET_OVERRIDE (opt)
 */
import https from 'https';

const GITHUB_TOKEN      = process.env.GIST_TOKEN;
const FINNHUB_KEY       = process.env.FINNHUB_KEY || '';
const MARKET_OVERRIDE   = (process.env.MARKET_OVERRIDE || '').toUpperCase();
const SUPABASE_URL      = process.env.SUPABASE_URL || 'https://tncyxfkuutnnwtrpbkfz.supabase.co';
const SUPABASE_KEY      = process.env.SUPABASE_SERVICE_KEY || '';

if (!GITHUB_TOKEN) { console.error('MANCA GIST_TOKEN'); process.exit(1); }
if (!SUPABASE_KEY) { console.warn('⚠ SUPABASE_SERVICE_KEY mancante — skip scrittura Supabase'); }

const GHDR = { 'Authorization': `token ${GITHUB_TOKEN}`, 'Accept': 'application/vnd.github+json' };

// ── HTTP helpers ──────────────────────────────────────────────────
function httpsRequest(url, method, payload, headers = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const body = payload ? JSON.stringify(payload) : null;
    const req = https.request({
      hostname: u.hostname, path: u.pathname + u.search, method,
      headers: {
        'User-Agent': 'PortafoglioBIT/4.0',
        ...(body ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) } : {}),
        ...headers
      }
    }, res => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        resolve(httpsRequest(res.headers.location, method, payload, headers)); return;
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
    req.setTimeout(18000, () => { req.destroy(); reject(new Error('Timeout: ' + url.slice(0, 60))); });
    if (body) req.write(body);
    req.end();
  });
}
const httpsGet   = (url, hdrs)     => httpsRequest(url, 'GET',   null,    hdrs);
const httpsPatch = (url, pay, hdrs) => httpsRequest(url, 'PATCH', pay,    hdrs);

const delay = ms => new Promise(r => setTimeout(r, ms));

// ── Date helpers ──────────────────────────────────────────────────
function localDate(tz) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: tz }).format(new Date());
}
function localMinutes(tz) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: tz, hour: '2-digit', minute: '2-digit', hour12: false
  }).formatToParts(new Date());
  const h = parseInt(parts.find(p => p.type === 'hour')?.value   || '0');
  const m = parseInt(parts.find(p => p.type === 'minute')?.value || '0');
  return h * 60 + m;
}

// ── Market detection ──────────────────────────────────────────────
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

// ── Price fetchers (invariati) ───────────────────────────────────
async function fetchStooq(ticker) {
  try {
    const { status, body } = await httpsGet(`https://stooq.com/q/d/l/?s=${encodeURIComponent(stooqSym(ticker))}&i=d`);
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
    const { status, body } = await httpsGet(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(ticker)}?interval=1d&range=5d`);
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
    const { status, body } = await httpsGet(`https://query1.finance.yahoo.com/v7/finance/quote?symbols=${encodeURIComponent(ticker)}&fields=regularMarketPrice,regularMarketPreviousClose`);
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
    const { status, body } = await httpsGet(`https://finnhub.io/api/v1/quote?symbol=${encodeURIComponent(sym)}&token=${encodeURIComponent(key)}`);
    if (status !== 200 || !body?.c || body.c <= 0) return null;
    return { price: body.c, prevClose: body.pc || null, source: 'Finnhub' };
  } catch { return null; }
}

// ── BTP / MOT fetcher (Borsa Italiana diretta — no CORS server-side) ──────
const BTP_ISIN_RE = /^IT\d{10}$/;

async function fetchBTPDirect(ticker) {
  // Estrae ISIN dal ticker (es. IT0005530032.MI → IT0005530032)
  const isin = ticker.replace(/\.(MI|MOT)$/i, '').trim();
  if (!BTP_ISIN_RE.test(isin)) return null;

  const urls = [
    `https://www.borsaitaliana.it/borsa/obbligazioni/mot/btp/scheda/${isin}-MOTX.html`,
    `https://www.borsaitaliana.it/borsa/obbligazioni/mot/btp/scheda/${isin}.html`,
    `https://live.euronext.com/en/pd/data/product?isin=${isin}&mic=XMOT`,
  ];

  const rxPrice = [
    /"(?:last|price|lastPrice|currentPrice)":\s*([\d.]+)/i,
    /data-(?:value|price|last)="([\d.,]+)"/i,
    /<strong[^>]*>\s*(\d{2,3}[,.]\d{1,4})\s*<\/strong>/i,
    /(?:Ultimo|Last|Prezzo)[^0-9]{0,30}(\d{2,3}[,.]\d{1,4})/i,
    /(?<![.\d])((?:8\d|9\d|10\d|11[0-4])[,.]\d{1,4})(?![.\d])/,
  ];
  const rxPrev = /(?:Prezzo ufficiale|prevClose|previousClose|Precedente)[^0-9]{0,30}(\d{2,3}[,.]\d{1,4})/i;
  const rxDate = /data-date="(\d{4}-\d{2}-\d{2})"|(?:Rif\.|Aggiornato)[^0-9]{0,20}(\d{1,2}[./]\d{1,2}[./]\d{2,4})/i;

  for (const url of urls) {
    try {
      const { status, raw } = await httpsGet(url, {
        'Accept': 'text/html,application/xhtml+xml',
        'Accept-Language': 'it-IT,it;q=0.9',
        'Referer': 'https://www.borsaitaliana.it/'
      });
      if (status !== 200 || !raw || raw.length < 200) continue;
      const clean = raw.replace(/\s+/g, ' ');

      let price = null, prevClose = null;
      for (const rx of rxPrice) {
        const m = clean.match(rx);
        if (m) {
          const v = parseFloat(m[1].replace(',', '.'));
          if (v > 70 && v < 125) { price = v; break; }
        }
      }
      const pm = clean.match(rxPrev);
      if (pm) {
        const v = parseFloat(pm[1].replace(',', '.'));
        if (v > 70 && v < 125) prevClose = v;
      }
      if (!price && prevClose) price = prevClose;
      if (price && price > 70 && price < 125) {
        console.log(`  BTP ${isin}: prezzo=${price}${prevClose?', prevClose='+prevClose:''} [Borsa Italiana]`);
        return { price, prevClose: prevClose||null, source:'BorsaItaliana' };
      }
    } catch(e) { console.log(`  BTP fetch error (${url.slice(0,50)}): ${e.message}`); }
  }
  return null;
}

async function fetchPrice(ticker) {
  // BTP: usa Borsa Italiana direttamente
  const cleanTk = ticker.replace(/\.(MI|MOT)$/i,'');
  if (BTP_ISIN_RE.test(cleanTk)) {
    const r = await fetchBTPDirect(ticker);
    if (r?.price > 0) return r;
    // Fallback: Yahoo con ISIN diretto
    const r2 = await fetchYahooChart(cleanTk);
    if (r2?.price > 0) return r2;
    return null;
  }
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

async function fetchHistoricalCloses(ticker) {
  // BTP: Borsa Italiana per storico
  const cleanTk = ticker.replace(/\.(MI|MOT)$/i,'');
  if (BTP_ISIN_RE.test(cleanTk)) {
    const r = await fetchBTPDirect(ticker);
    if (r?.price > 0) {
      const today = localDate('Europe/Rome');
      return { [today]: { close: r.price, source: 'BorsaItaliana' } };
    }
    return {};
  }
  const eu = isEU(ticker);
  const result = {};
  if (eu) {
    try {
      const { status, body } = await httpsGet(`https://stooq.com/q/d/l/?s=${encodeURIComponent(stooqSym(ticker))}&i=d`);
      if (status === 200 && typeof body === 'string' && !/no data/i.test(body)) {
        const lines = body.trim().split(/\r?\n/).filter(Boolean).slice(1);
        for (const line of lines.slice(-10)) {
          const p = line.split(',');
          const date = p[0], close = parseFloat(p[4]);
          if (date && close > 0) result[date] = { close, source: 'Stooq' };
        }
        if (Object.keys(result).length) return result;
      }
    } catch {}
  }
  try {
    const { status, body } = await httpsGet(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(ticker)}?interval=1d&range=10d`);
    if (status === 200) {
      const r = body?.chart?.result?.[0];
      const closes = r?.indicators?.quote?.[0]?.close || [];
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

async function backfillMissingDates(tickers, backup) {
  const recentDays = lastBusinessDays(5);
  let backfilled = 0;
  console.log(`\n── Backfill (${recentDays.join(', ')}) ──`);
  for (const ticker of tickers) {
    const existing = Object.keys(backup.officialCloses?.[ticker] || {});
    const missing  = recentDays.filter(d => !existing.includes(d));
    if (!missing.length) { process.stdout.write('.'); continue; }
    console.log(`\n  ${ticker}: mancano [${missing.join(', ')}]`);
    const hist = await fetchHistoricalCloses(ticker);
    for (const date of missing) {
      if (!hist[date]) continue;
      if (!backup.officialCloses[ticker])     backup.officialCloses[ticker]     = {};
      if (!backup.officialClosesMeta[ticker]) backup.officialClosesMeta[ticker] = {};
      backup.officialCloses[ticker][date] = { close: hist[date].close, capturedAt: new Date().toISOString(), runDate: today, source: `${hist[date].source}-backfill`, market: isEU(ticker) ? 'EU' : 'US' };
      backup.officialClosesMeta[ticker][date] = { source: `${hist[date].source}-backfill`, market: isEU(ticker) ? 'EU' : 'US' };
      console.log(`    OK  ${date} = ${hist[date].close}`);
      backfilled++;
    }
    await delay(400);
  }
  console.log(`\nBackfill: ${backfilled} date`);
  return backfilled;
}

// ── Gist I/O (invariato) ─────────────────────────────────────────
async function findGistId() {
  if (process.env.GIST_ID) { console.log(`Gist ID: ${process.env.GIST_ID}`); return process.env.GIST_ID; }
  let page = 1;
  while (page <= 5) {
    const { status, body } = await httpsGet(`https://api.github.com/gists?per_page=100&page=${page}`, GHDR);
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
  if (status !== 200) throw new Error(`Gist API: HTTP ${status}`);
  const content = body.files?.['portafoglio-bit.json']?.content;
  if (!content) throw new Error('File portafoglio-bit.json non trovato nel Gist');
  const backup = JSON.parse(content);
  console.log(`Portafogli: ${backup.portfolios?.length || 0} | officialCloses: ${Object.keys(backup.officialCloses || {}).length} ticker`);
  return backup;
}

async function writeGist(gistId, backup) {
  const { status, body } = await httpsPatch(
    `https://api.github.com/gists/${gistId}`,
    { files: { 'portafoglio-bit.json': { content: JSON.stringify(backup) } } },
    GHDR
  );
  if (status !== 200) throw new Error(`Scrittura Gist: HTTP ${status}`);
}

// ── Supabase I/O ─────────────────────────────────────────────────
const SB_HDR = {
  'apikey': SUPABASE_KEY,
  'Authorization': `Bearer ${SUPABASE_KEY}`,
  'Content-Type': 'application/json',
  'Prefer': 'resolution=merge-duplicates'
};

async function readTickersFromSupabase() {
  if (!SUPABASE_KEY) return [];
  try {
    const { status, body } = await httpsGet(
      `${SUPABASE_URL}/rest/v1/user_data?select=data`,
      SB_HDR
    );
    if (status !== 200 || !Array.isArray(body)) {
      console.warn(`Supabase read: HTTP ${status}`);
      return [];
    }
    const qty = {};
    for (const row of body) {
      const d = row.data || {};
      (d.portfolios || []).forEach(pf => {
        (pf.ops || []).forEach(op => {
          const tk = op.quoteTicker || op.ticker;
          if (!tk || tk === '__CASH__') return;
          qty[tk] = (qty[tk] || 0) + (op.type === 'buy' ? 1 : -1) * (op.qty || 0);
        });
      });
    }
    return Object.entries(qty).filter(([, q]) => q > 0.0001).map(([tk]) => tk);
  } catch(e) {
    console.warn('Supabase readTickers error:', e.message);
    return [];
  }
}

async function writeClosesToSupabase(officialCloses, officialClosesMeta) {
  if (!SUPABASE_KEY) { console.log('Skip Supabase write (no key)'); return; }
  try {
    // Upsert su market_data — una riga per ticker
    const rows = Object.entries(officialCloses).map(([ticker, closes]) => ({
      ticker,
      closes,
      closes_meta: officialClosesMeta[ticker] || {},
      updated_at: new Date().toISOString()
    }));
    if (!rows.length) return;

    const { status, body } = await httpsRequest(
      `${SUPABASE_URL}/rest/v1/market_data`,
      'POST',
      rows,
      { ...SB_HDR, 'Prefer': 'resolution=merge-duplicates' }
    );
    if (status >= 200 && status < 300) {
      console.log(`✓ Supabase: ${rows.length} ticker aggiornati in market_data`);
    } else {
      console.warn(`Supabase write: HTTP ${status} — ${JSON.stringify(body).slice(0, 200)}`);
    }
  } catch(e) {
    console.warn('Supabase writeCloses error:', e.message);
  }
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
const marketDate = market === 'US' ? localDate('America/New_York') : today;

console.log('=== Portafoglio BIT v4 — Official Closes ===');
console.log(`UTC: ${new Date().toISOString()} | Rome: ${today} | Market: ${market}`);
console.log(`Finnhub: ${FINNHUB_KEY ? 'sì' : 'no'} | Supabase: ${SUPABASE_KEY ? 'sì' : 'no'}`);

if (market === 'SKIP') { console.log('Fuori finestra — exit'); process.exit(0); }

// Leggi dati da Gist (primary) + Supabase (secondary per ticker aggiuntivi)
const gistId = await findGistId();
if (!gistId) { console.error('Nessun Gist trovato'); process.exit(1); }

const backup = await readGist(gistId);
if (!backup.officialCloses)     backup.officialCloses     = {};
if (!backup.officialClosesMeta) backup.officialClosesMeta = {};

// Merge ticker dal Gist e da Supabase
const gistTickers = extractTickers(backup);
const sbTickers   = await readTickersFromSupabase();
const allSet      = new Set([...gistTickers, ...sbTickers]);
const allTickers  = [...allSet];

console.log(`\nTicker totali: ${allTickers.length} (Gist: ${gistTickers.length}, Supabase extra: ${sbTickers.filter(t => !gistTickers.includes(t)).length})`);

if (!allTickers.length) { console.log('Nessun ticker — exit'); process.exit(0); }

const tickers = allTickers.filter(tk => {
  if (market === 'EU') return  isEU(tk);
  if (market === 'US') return !isEU(tk);
  return true;
});

if (!tickers.length) { console.log(`Nessun ticker per mercato ${market}`); process.exit(0); }

// Backfill + fetch
const backfilled = await backfillMissingDates(allTickers, backup);

console.log(`\nFetching ${tickers.length} prezzi (${market})...`);
const results = {};
for (const ticker of tickers) {
  const r = await fetchPrice(ticker);
  if (r) {
    results[ticker] = r;
    console.log(`  OK  ${ticker.padEnd(18)} ${String(r.price).padEnd(10)}  [${r.source}]`);
  } else {
    console.log(`  NO  ${ticker}`);
  }
  await delay(400);
}

if (!Object.keys(results).length) { console.log('Nessun prezzo — exit'); process.exit(0); }

// Salva chiusure nel backup
let saved = 0;
for (const [ticker, data] of Object.entries(results)) {
  if (!backup.officialCloses[ticker])     backup.officialCloses[ticker]     = {};
  if (!backup.officialClosesMeta[ticker]) backup.officialClosesMeta[ticker] = {};
  const saveDate = data.date || marketDate;
  backup.officialCloses[ticker][saveDate] = {
    close: data.price, prevClose: data.prevClose || null,
    capturedAt: new Date().toISOString(), runDate: today,
    source: `${data.source}-auto`, market
  };
  backup.officialClosesMeta[ticker][saveDate] = {
    source: data.source, capturedAt: new Date().toISOString(), market, runDate: today
  };
  saved++;
}

backup.officialClosesMeta['__lastRun'] = {
  at: new Date().toISOString(), market, saved, runDate: today, marketDate
};

// Scrivi su Gist (invariato) + Supabase market_data (nuovo)
console.log(`\nSalvataggio: Gist + Supabase...`);
await Promise.all([
  writeGist(gistId, backup),
  writeClosesToSupabase(backup.officialCloses, backup.officialClosesMeta)
]);

console.log(`DONE — saved:${saved}  backfilled:${backfilled}  market:${market}`);
