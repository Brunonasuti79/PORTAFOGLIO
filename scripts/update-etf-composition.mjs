/**
 * Portafoglio BIT — ETF Composition Fetcher v2
 * Usa Yahoo Finance quoteSummary per settori, geografie e holdings
 * Secrets: GIST_TOKEN, GIST_ID (opzionale)
 */
import https from 'https';

const GITHUB_TOKEN = process.env.GIST_TOKEN;
const GHDR = {
  'Authorization': `token ${GITHUB_TOKEN}`,
  'Accept': 'application/vnd.github+json',
  'User-Agent': 'PortafoglioBIT/2.0'
};

if (!GITHUB_TOKEN) { console.error('MANCA GIST_TOKEN'); process.exit(1); }

const delay = ms => new Promise(r => setTimeout(r, ms));

// ── HTTP helper ───────────────────────────────────────────────────
function httpsGet(url, headers = {}) {
  return new Promise((resolve, reject) => {
    try {
      const u = new URL(url);
      const req = https.request({
        hostname: u.hostname, path: u.pathname + u.search, method: 'GET',
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
          'Accept': 'application/json,*/*',
          ...headers
        }
      }, res => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          // Gestisci redirect relativi
          try {
            const loc = res.headers.location.startsWith('http')
              ? res.headers.location
              : new URL(res.headers.location, url).href;
            resolve(httpsGet(loc, headers));
          } catch(e) { resolve({ status: res.statusCode, body: null, raw: '' }); }
          return;
        }
        const chunks = [];
        res.on('data', c => chunks.push(c));
        res.on('end', () => {
          const raw = Buffer.concat(chunks).toString('utf8');
          try   { resolve({ status: res.statusCode, body: JSON.parse(raw), raw }); }
          catch { resolve({ status: res.statusCode, body: null, raw }); }
        });
      });
      req.on('error', reject);
      req.setTimeout(20000, () => { req.destroy(); reject(new Error('Timeout')); });
      req.end();
    } catch(e) { reject(e); }
  });
}

function httpsPatch(url, payload, headers = {}) {
  return new Promise((resolve, reject) => {
    try {
      const u = new URL(url);
      const body = JSON.stringify(payload);
      const req = https.request({
        hostname: u.hostname, path: u.pathname + u.search, method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(body),
          'User-Agent': 'PortafoglioBIT/2.0',
          ...headers
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
      req.setTimeout(20000, () => { req.destroy(); reject(new Error('Timeout PATCH')); });
      req.write(body); req.end();
    } catch(e) { reject(e); }
  });
}

// ── Yahoo Finance quoteSummary ────────────────────────────────────
// Genera i candidati ticker Yahoo per un ETF europeo
function yahooTickers(ticker) {
  const base = ticker.replace(/\.(MI|DE|PA|AS|L)$/i, '');
  const sfx = (ticker.match(/\.([A-Z]+)$/i)||[])[1]?.toUpperCase();
  const candidates = [ticker];
  // Prova prima il ticker con suffisso .L (Londra) per dati ETF più completi
  if (sfx !== 'L')  candidates.push(base + '.L');
  if (sfx !== 'DE') candidates.push(base + '.DE');
  if (sfx !== 'MI') candidates.push(base + '.MI');
  candidates.push(base); // senza suffisso come ultima risorsa
  return [...new Set(candidates)];
}

async function fetchYahooSummary(ticker) {
  const modules = 'topHoldings,fundProfile,assetProfile';
  for (const yt of yahooTickers(ticker)) {
    for (const base of ['https://query1.finance.yahoo.com', 'https://query2.finance.yahoo.com']) {
      try {
        const url = `${base}/v10/finance/quoteSummary/${encodeURIComponent(yt)}?modules=${modules}`;
        const { status, body } = await httpsGet(url);
        if (status === 200 && body?.quoteSummary?.result?.[0]) {
          const r = body.quoteSummary.result[0];
          const data = parseYahooSummary(r);
          if (data) {
            console.log(`  ✅ Yahoo (${yt}) — settori: ${Object.keys(data.sectors).length}, holdings: ${data.holdings.length}`);
            return { ...data, source: `Yahoo/${yt}` };
          }
        }
        await delay(200);
      } catch(e) { /* prova prossimo */ }
    }
    await delay(300);
  }
  return null;
}

function parseYahooSummary(result) {
  const th = result?.topHoldings;
  const ap = result?.assetProfile;
  if (!th) return null;

  // Settori
  const sectors = {};
  (th.sectorWeightings || []).forEach(sw => {
    Object.entries(sw).forEach(([key, val]) => {
      if (key !== 'realestate') {
        // Converti camelCase in nome leggibile
        const name = key
          .replace(/([A-Z])/g, ' $1')
          .replace(/^./, s => s.toUpperCase())
          .trim();
        const pct = typeof val === 'object' ? (val.raw || 0) : (val || 0);
        if (pct > 0) sectors[name] = +(pct * 100).toFixed(2);
      } else {
        const pct = typeof val === 'object' ? (val.raw || 0) : (val || 0);
        if (pct > 0) sectors['Real Estate'] = +(pct * 100).toFixed(2);
      }
    });
  });

  // Holdings top 10
  const holdings = (th.holdings || []).slice(0, 10).map(h => ({
    name:   h.holdingName || '',
    weight: +((typeof h.holdingPercent === 'object' ? h.holdingPercent.raw : h.holdingPercent) * 100).toFixed(2)
  })).filter(h => h.name && h.weight > 0);

  // Geografie — Yahoo non le fornisce direttamente per ETF EU
  // Le stimiamo dal paese dell'ETF e dalle sue posizioni note
  const geos = {};
  const country = ap?.country || '';
  if (country) geos[country] = 100;

  // Equity holdings per stima geo (solo se disponibili)
  if (th.equityHoldings?.priceToBook) {
    // Non c'è breakdown geo — usiamo placeholder
  }

  return {
    sectors,
    geos,
    holdings,
    equityHoldings: th.equityHoldings || null,
    bondHoldings:   th.bondHoldings || null
  };
}

// ── Fetch geo da JustETF (server-side, no CORS) ──────────────────
async function fetchJustETFGeo(isin) {
  // JustETF ha una API pubblica per country breakdown
  const urls = [
    `https://www.justetf.com/api/etfs/${isin}/countryWeight?locale=en`,
    `https://www.justetf.com/api/etfs?isin=${isin}&locale=en`
  ];
  for (const url of urls) {
    try {
      const { status, body } = await httpsGet(url, { 'Referer': 'https://www.justetf.com/' });
      if (status === 200 && (Array.isArray(body) || body?.countries)) {
        const arr = Array.isArray(body) ? body : body.countries;
        const geos = {};
        arr.forEach(c => {
          const name = c.country || c.name || '';
          const pct  = c.weight || c.percentage || c.pct || 0;
          if (name && pct > 0) geos[name] = +pct.toFixed(2);
        });
        if (Object.keys(geos).length) return geos;
      }
    } catch(e) {}
    await delay(300);
  }
  return null;
}

// ── Fallback: dati geografici statici per ETF noti ────────────────
// Per ETF obbligazionari/monetari dove Yahoo non ha settori
const STATIC_GEO = {
  // Eurozone Gov Bond (XGLE)
  'LU0290355717': { 'Italy':22,'France':20,'Germany':17,'Spain':13,'Netherlands':8,'Belgium':5,'Austria':4,'Finland':3,'Portugal':3,'Other':5 },
  // EUR Overnight (XEON)
  'LU0290358497': { 'Eurozone':100 },
  // EUR High Yield Corp Bond (EHYA)
  'IE00BJK55C48': { 'France':17,'Germany':15,'United Kingdom':14,'Italy':10,'Netherlands':9,'Luxembourg':8,'Spain':7,'Other':20 },
  // EUR Corp Bond (IEAA)
  'IE00BF11F565': { 'France':20,'Germany':18,'Netherlands':12,'United Kingdom':11,'Italy':9,'Spain':8,'United States':7,'Other':15 },
  // EUR High Div (EHF1)
  'LU1681041973': { 'United Kingdom':22,'Germany':15,'France':14,'Switzerland':12,'Netherlands':9,'Italy':7,'Spain':6,'Other':15 },
};

const STATIC_SECTORS = {
  // EUR Overnight Rate Swap — monetario puro
  'LU0290358497': { 'Money Market':100 },
  // Eurozone Gov Bond — obbligazionario
  'LU0290355717': { 'Government Bonds':100 },
  // EUR High Yield Corp Bond
  'IE00BJK55C48': { 'High Yield Corporate':60, 'Investment Grade Corporate':25, 'Other':15 },
  // EUR Corp Bond
  'IE00BF11F565': { 'Investment Grade Corporate':85, 'Financial':10, 'Other':5 },
  // EUR High Div Factor
  'LU1681041973': { 'Financials':22, 'Industrials':16, 'Consumer Staples':14, 'Healthcare':11, 'Energy':10, 'Utilities':9, 'Materials':8, 'Technology':7, 'Other':3 },
  // Amundi MSCI Europe Banks
  'LU1834983477': { 'Financials':100 },
};

// ── Dispatcher principale ─────────────────────────────────────────
async function fetchETFComposition(ticker, isin) {
  console.log(`  ISIN: ${isin}`);

  // 1. Yahoo Finance quoteSummary (principale — funziona per ETF azionari)
  let result = await fetchYahooSummary(ticker);

  // 2. Integra geo da JustETF se Yahoo non le ha
  if (result && Object.keys(result.geos || {}).length < 3) {
    const geos = await fetchJustETFGeo(isin);
    if (geos) result.geos = geos;
  }

  // 3. Dati statici per ETF obbligazionari/monetari (Yahoo non li ha)
  if (!result || Object.keys(result.sectors || {}).length === 0) {
    const staticSec = STATIC_SECTORS[isin];
    const staticGeo = STATIC_GEO[isin];
    if (staticSec || staticGeo) {
      console.log(`  → usando dati statici per ETF obbligazionario/monetario`);
      result = {
        sectors:  staticSec || result?.sectors  || {},
        geos:     staticGeo || result?.geos     || {},
        holdings: result?.holdings || [],
        source:   'static'
      };
    }
  }

  return result;
}

// ── Gist I/O ──────────────────────────────────────────────────────
async function findGistId() {
  if (process.env.GIST_ID) return process.env.GIST_ID;
  let page = 1;
  while (page <= 5) {
    const { status, body } = await httpsGet(`https://api.github.com/gists?per_page=100&page=${page}`, GHDR);
    if (status !== 200 || !Array.isArray(body) || !body.length) break;
    const found = body.find(g => 'portafoglio-bit.json' in (g.files || {}));
    if (found) return found.id;
    if (body.length < 100) break;
    page++;
  }
  return null;
}

async function readGist(gistId) {
  const { status, body } = await httpsGet(`https://api.github.com/gists/${gistId}`, GHDR);
  if (status !== 200) throw new Error(`Gist: HTTP ${status}`);
  return body;
}

async function writeGistFile(gistId, filename, content) {
  const { status } = await httpsPatch(
    `https://api.github.com/gists/${gistId}`,
    { files: { [filename]: { content: JSON.stringify(content, null, 2) } } },
    GHDR
  );
  if (status !== 200) throw new Error(`Scrittura Gist: HTTP ${status}`);
}

// ── Estrai ETF dal portafoglio ────────────────────────────────────
function extractETFs(portfolioData) {
  const ETF_ISIN = /^(IE|LU|FR)/;
  const EXCLUDE  = /^(IT\d|XS\d)/; // BTP e bond governativi senza allocazione ETF
  const STOCKS   = new Set(['SMCI','BURU','KURA','NMRA','ADBE','AIP','META','MSFT',
                             'NKE','SLNH','MSTR','OKYO','ADS']);

  // Log categorie per debug
  const cats = new Set();
  (portfolioData.portfolios||[]).forEach(pf=>(pf.ops||[]).forEach(op=>{if(op.category)cats.add(op.category);}));
  console.log('Categorie nel portafoglio:', [...cats].join(', ')||'(nessuna)');

  const etfs = new Map();
  (portfolioData.portfolios || []).forEach(pf => {
    (pf.ops || []).forEach(op => {
      const ticker = op.quoteTicker || op.ticker;
      const isin   = (op.isin || '').trim();
      if (!ticker || ticker === '__CASH__') return;
      if (!isin || EXCLUDE.test(isin)) return;
      if (!ETF_ISIN.test(isin)) return;
      const base = ticker.replace(/\.(MI|DE|PA|AS|L)$/i,'').toUpperCase();
      if (STOCKS.has(base)) return;
      const qty = (op.type==='buy'?1:-1)*(op.qty||0);
      if (!etfs.has(ticker)) {
        etfs.set(ticker, { ticker, isin, name: op.name||ticker, qty });
      } else {
        etfs.get(ticker).qty += qty;
      }
    });
  });

  // Deduplication per ISIN (es. XMME.DE e XMME.MI hanno stesso ISIN)
  const byIsin = new Map();
  [...etfs.values()].filter(e=>e.qty>0.001).forEach(e=>{
    if (!byIsin.has(e.isin)) byIsin.set(e.isin, e);
    else byIsin.get(e.isin).tickers = [...(byIsin.get(e.isin).tickers||[byIsin.get(e.isin).ticker]), e.ticker];
  });

  return [...byIsin.values()];
}

// ── Main ──────────────────────────────────────────────────────────
console.log('=== Portafoglio BIT — ETF Composition Fetcher v2 ===');
console.log(`UTC: ${new Date().toISOString()}`);

const gistId = await findGistId();
if (!gistId) { console.error('Gist non trovato'); process.exit(1); }
console.log(`Gist: ${gistId}`);

const gist = await readGist(gistId);
const portfolioContent = gist.files?.['portafoglio-bit.json']?.content;
if (!portfolioContent) { console.error('portafoglio-bit.json non trovato'); process.exit(1); }
const portfolioData = JSON.parse(portfolioContent);

const existingContent = gist.files?.['etf-composition.json']?.content;
const existing = existingContent ? JSON.parse(existingContent) : {};

const etfs = extractETFs(portfolioData);
// Usa il ticker principale per ogni ISIN
const uniqueEtfs = etfs;

console.log(`\nETF da aggiornare: ${uniqueEtfs.length}`);
uniqueEtfs.forEach(e => console.log(`  ${e.ticker.padEnd(12)} ${e.isin}  "${e.name}"`));

if (!uniqueEtfs.length) {
  console.log('Nessun ETF trovato');
  process.exit(0);
}

const results = {};
const report  = { updated: [], failed: [], static: [] };

for (const etf of uniqueEtfs) {
  console.log(`\n[${etf.ticker}] "${etf.name}"`);
  try {
    const data = await fetchETFComposition(etf.ticker, etf.isin);
    if (data) {
      const entry = {
        ticker:    etf.ticker,
        isin:      etf.isin,
        name:      etf.name,
        tickers:   etf.tickers || [etf.ticker],
        sectors:   data.sectors  || {},
        geos:      data.geos     || {},
        holdings:  data.holdings || [],
        source:    data.source   || 'auto',
        updatedAt: new Date().toISOString()
      };
      // Salva per tutti i ticker con lo stesso ISIN
      const allTickers = etf.tickers ? [etf.ticker, ...etf.tickers] : [etf.ticker];
      allTickers.forEach(tk => { results[tk] = { ...entry, ticker: tk }; });

      if (data.source === 'static') {
        report.static.push(etf.ticker);
        console.log(`  📋 Dati statici (ETF obbligazionario/monetario)`);
      } else {
        report.updated.push(etf.ticker);
      }
    } else {
      if (existing[etf.ticker]) {
        results[etf.ticker] = existing[etf.ticker];
        console.log(`  ⚠️  No data — mantengo dati del ${existing[etf.ticker].updatedAt?.slice(0,10)}`);
      }
      report.failed.push({ ticker: etf.ticker, oldDate: existing[etf.ticker]?.updatedAt?.slice(0,10)||null });
    }
  } catch(e) {
    console.error(`  ❌ Errore: ${e.message}`);
    if (existing[etf.ticker]) results[etf.ticker] = existing[etf.ticker];
    report.failed.push({ ticker: etf.ticker, oldDate: null });
  }
  await delay(600);
}

const output = {
  ...results,
  __meta: {
    updatedAt:   new Date().toISOString(),
    totalETFs:   uniqueEtfs.length,
    updated:     [...report.updated, ...report.static],
    staticData:  report.static,
    failed:      report.failed.map(f=>f.ticker),
    failedDates: Object.fromEntries(report.failed.map(f=>[f.ticker,f.oldDate]))
  }
};

console.log('\nSalvataggio etf-composition.json nel Gist...');
await writeGistFile(gistId, 'etf-composition.json', output);

const ok  = report.updated.length + report.static.length;
const nok = report.failed.filter(f=>!f.oldDate).length;
const old = report.failed.filter(f=>f.oldDate).length;

console.log(`\n${'═'.repeat(50)}`);
console.log(`✅ Aggiornati live (${report.updated.length}): ${report.updated.join(', ')||'—'}`);
console.log(`📋 Dati statici  (${report.static.length}): ${report.static.join(', ')||'—'}`);
console.log(`⚠️  Dati vecchi  (${old}): ${report.failed.filter(f=>f.oldDate).map(f=>`${f.ticker}(${f.oldDate})`).join(', ')||'—'}`);
console.log(`❌ Non trovati  (${nok}): ${report.failed.filter(f=>!f.oldDate).map(f=>f.ticker).join(', ')||'—'}`);
console.log(`DONE — ${ok}/${uniqueEtfs.length} ETF con dati`);
