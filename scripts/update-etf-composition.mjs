/**
 * Portafoglio BIT — ETF Composition Fetcher
 * Scarica allocazione settoriale, geografica e top holdings da:
 * iShares (BlackRock), Xtrackers (DWS), Amundi, Vanguard, SPDR
 *
 * Secrets richiesti: GIST_TOKEN, GIST_ID (opzionale)
 */
import https from 'https';

const GITHUB_TOKEN = process.env.GIST_TOKEN;
const GHDR = { 'Authorization': `token ${GITHUB_TOKEN}`, 'Accept': 'application/vnd.github+json', 'User-Agent': 'PortafoglioBIT/1.0' };

if (!GITHUB_TOKEN) { console.error('MANCA GIST_TOKEN'); process.exit(1); }

const delay = ms => new Promise(r => setTimeout(r, ms));

// ── HTTP helper ───────────────────────────────────────────────────
function httpsGet(url, headers = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const req = https.request({
      hostname: u.hostname, path: u.pathname + u.search, method: 'GET',
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; PortafoglioBIT)', 'Accept': 'application/json', ...headers }
    }, res => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        resolve(httpsGet(res.headers.location, headers)); return;
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
    req.setTimeout(20000, () => { req.destroy(); reject(new Error('Timeout: ' + url.slice(0, 80))); });
    req.end();
  });
}

function httpsPatch(url, payload, headers = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const body = JSON.stringify(payload);
    const req = https.request({
      hostname: u.hostname, path: u.pathname + u.search, method: 'PATCH',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body), 'User-Agent': 'PortafoglioBIT/1.0', ...headers }
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
  });
}

// ── Provider detection da ISIN ────────────────────────────────────
function detectProvider(isin = '', ticker = '') {
  if (!isin) return 'unknown';
  // iShares: ISIN inizia con IE00 o IE000 (domicilio Irlanda BlackRock)
  if (/^IE00B|^IE000/.test(isin)) return 'ishares';
  // Xtrackers: ISIN LU o IE con prefisso specifico
  if (/^LU/.test(isin) && /^X/.test(ticker.toUpperCase())) return 'xtrackers';
  // Amundi: FR o LU + ticker BNK, BNKD, CPR...
  if (/^FR/.test(isin)) return 'amundi';
  if (/^LU/.test(isin) && !/^X/.test(ticker.toUpperCase())) return 'amundi';
  // Vanguard: IE
  if (/^IE00B3/.test(isin)) return 'vanguard';
  return 'unknown';
}

// ── iShares fetcher ───────────────────────────────────────────────
async function fetchIShares(isin, ticker) {
  // iShares usa l'ISIN per trovare il productPageUrl, poi scarica holdings
  const searchUrl = `https://www.ishares.com/us/products/etf-investments.1.3.json?dcrPath=/templatedata/config/product-screener-v3/data/en/us-ishares/ishares-product-screener-backend-config&siteEntryPassthrough=true`;

  // Prova direttamente con URL noti per ETF europei iShares
  const europeBase = 'https://www.ishares.com/uk/individual/en/products';

  // Mappa ISIN → productId iShares (per ETF europei comuni)
  const ISHARES_MAP = {
    'IE00B4L5Y983': '251882', // iShares Core MSCI World UCITS ETF (SWDA)
    'IE00B4L5YC18': '264659', // iShares Core MSCI EM IMI
    'IE00B3F81R35': '264659', // iShares Core MSCI World
    'IE00B6R52259': '254091', // iShares MSCI ACWI
    'IE00B52MJY50': '264659', // iShares Core MSCI Pacific
    'IE00BKM4GZ66': '264659', // iShares Core MSCI EM
  };

  // Tenta download holdings CSV da iShares
  const pid = ISHARES_MAP[isin];
  if (pid) {
    try {
      const url = `https://www.ishares.com/uk/individual/en/products/${pid}/ishares-core-msci-world-ucits-etf/1478372549651.ajax?fileType=json&fileName=holdings&dataType=fund`;
      const { status, body } = await httpsGet(url);
      if (status === 200 && body?.data) {
        return parseISharesHoldings(body.data);
      }
    } catch(e) { console.log('  iShares pid fallback error:', e.message); }
  }

  // Tenta con slug dal ticker
  return await fetchISharesBySlug(ticker, isin);
}

async function fetchISharesBySlug(ticker, isin) {
  // Mappa ticker → slug pagina iShares Europa
  const slugMap = {
    'SWDA': 'ishares-core-msci-world-ucits-etf',
    'IWDA': 'ishares-core-msci-world-ucits-etf',
    'XGLE': 'ishares-msci-world-esg-screened-ucits-etf',
    'XGDU': 'ishares-global-clean-energy-ucits-etf',
    'IEAA': 'ishares-core-global-aggregate-bond-ucits-etf',
    'CSPX': 'ishares-core-sp-500-ucits-etf',
  };
  const tk = ticker.replace(/\.(MI|DE|PA|AS|L)$/i, '').toUpperCase();
  const slug = slugMap[tk];
  if (!slug) return null;

  try {
    const url = `https://www.ishares.com/uk/individual/en/products/${slug}/1478372549651.ajax?fileType=json&dataType=fund`;
    const { status, body } = await httpsGet(url);
    if (status === 200 && body) return parseISharesHoldings(body);
  } catch(e) {}
  return null;
}

function parseISharesHoldings(data) {
  if (!data || !Array.isArray(data)) return null;
  const sectors = {}, geos = {}, holdings = [];
  for (const row of data) {
    if (!row || row[0] === 'Ticker') continue;
    const name   = row[0] || '';
    const weight = parseFloat(row[6]) || 0;
    const sector = row[7] || row[5] || '';
    const country= row[8] || '';
    if (weight <= 0 || name === 'Cash and/or Derivatives') continue;
    if (sector) sectors[sector] = (sectors[sector] || 0) + weight;
    if (country) geos[country]  = (geos[country]  || 0) + weight;
    if (holdings.length < 10) holdings.push({ name, weight: +weight.toFixed(2) });
  }
  return Object.keys(sectors).length ? { sectors, geos, holdings } : null;
}

// ── Xtrackers fetcher ─────────────────────────────────────────────
async function fetchXtrackers(isin, ticker) {
  // Xtrackers API pubblica per ETF europei
  const tk = ticker.replace(/\.(MI|DE|PA|AS|L)$/i, '').toUpperCase();

  const xtMap = {
    'XMME': 'LU0292107645',
    'XEON': 'LU0290358497',
    'XRS2': 'IE00BJQRDN15',
    'XGLE': 'IE00BGHQ0G80',
    'XGDU': 'IE00BKT09032',
    'EHF1': 'LU0378818131',
  };

  const productIsin = xtMap[tk] || isin;

  try {
    // Xtrackers product page con holdings JSON
    const url = `https://etf.dws.com/api/funds/v2/en-gb/etfs/${productIsin}/holdings?page=1&size=50`;
    const { status, body } = await httpsGet(url, {
      'Accept': 'application/json',
      'Referer': 'https://etf.dws.com/'
    });
    if (status === 200 && body?.data) {
      return parseXtrackersHoldings(body.data);
    }
  } catch(e) { console.log('  Xtrackers error:', e.message); }

  // Fallback: prova API alternativa
  try {
    const url = `https://etf.dws.com/api/funds/v1/en-gb/etfs/search?isin=${productIsin}`;
    const { status, body } = await httpsGet(url, { 'Referer': 'https://etf.dws.com/' });
    if (status === 200 && body?.results?.[0]) {
      const fundId = body.results[0].id;
      const holdUrl = `https://etf.dws.com/api/funds/v2/en-gb/etfs/${fundId}/holdings?page=1&size=50`;
      const { status: s2, body: b2 } = await httpsGet(holdUrl, { 'Referer': 'https://etf.dws.com/' });
      if (s2 === 200 && b2?.data) return parseXtrackersHoldings(b2.data);
    }
  } catch(e) {}

  return null;
}

function parseXtrackersHoldings(data) {
  if (!Array.isArray(data)) return null;
  const sectors = {}, geos = {}, holdings = [];
  for (const item of data) {
    const weight  = parseFloat(item.weight || item.weightage || 0);
    const name    = item.name || item.securityName || '';
    const sector  = item.sector || item.sectorName || '';
    const country = item.country || item.countryName || '';
    if (weight <= 0) continue;
    if (sector)  sectors[sector] = (sectors[sector] || 0) + weight;
    if (country) geos[country]   = (geos[country]   || 0) + weight;
    if (holdings.length < 10) holdings.push({ name, weight: +weight.toFixed(2) });
  }
  return Object.keys(sectors).length ? { sectors, geos, holdings } : null;
}

// ── Amundi fetcher ────────────────────────────────────────────────
async function fetchAmundi(isin, ticker) {
  const tk = ticker.replace(/\.(MI|DE|PA|AS|L)$/i, '').toUpperCase();

  try {
    // Amundi ETF API
    const searchUrl = `https://www.amundietf.com/api/en/search?query=${encodeURIComponent(tk)}&type=fund`;
    const { status, body } = await httpsGet(searchUrl, {
      'Referer': 'https://www.amundietf.com/',
      'Accept': 'application/json'
    });
    if (status === 200 && body?.results?.length) {
      const fund = body.results.find(f =>
        (f.isin || '').toUpperCase() === isin.toUpperCase() ||
        (f.ticker || '').toUpperCase().includes(tk)
      ) || body.results[0];

      if (fund?.id) {
        const holdUrl = `https://www.amundietf.com/api/en/fund/${fund.id}/holdings`;
        const { status: s2, body: b2 } = await httpsGet(holdUrl, { 'Referer': 'https://www.amundietf.com/' });
        if (s2 === 200 && b2) return parseAmundiHoldings(b2);
      }
    }
  } catch(e) { console.log('  Amundi error:', e.message); }

  // Fallback: API ETF Amundi Europa
  try {
    const url = `https://www.amundietf.com/en/professional/product/view/${isin}/portfolio`;
    const { status, raw } = await httpsGet(url, { 'Referer': 'https://www.amundietf.com/' });
    if (status === 200 && raw) {
      const jsonMatch = raw.match(/"holdings"\s*:\s*(\[[\s\S]+?\])/);
      if (jsonMatch) {
        const arr = JSON.parse(jsonMatch[1]);
        return parseAmundiHoldings({ holdings: arr });
      }
    }
  } catch(e) {}

  return null;
}

function parseAmundiHoldings(data) {
  const items = data?.holdings || data?.data || data;
  if (!Array.isArray(items) || !items.length) return null;
  const sectors = {}, geos = {}, holdings = [];
  for (const item of items) {
    const weight  = parseFloat(item.weight || item.percentage || item.pct || 0);
    const name    = item.name || item.assetName || item.secName || '';
    const sector  = item.sector || item.gics || item.sectorName || '';
    const country = item.country || item.countryName || item.geo || '';
    if (weight <= 0) continue;
    if (sector)  sectors[sector] = (sectors[sector] || 0) + weight;
    if (country) geos[country]   = (geos[country]   || 0) + weight;
    if (holdings.length < 10) holdings.push({ name, weight: +weight.toFixed(2) });
  }
  return Object.keys(sectors).length ? { sectors, geos, holdings } : null;
}

// ── JustETF fallback (per tutti i provider) ───────────────────────
async function fetchJustETF(isin) {
  try {
    // JustETF ha una pagina pubblica con dati di composizione
    const url = `https://www.justetf.com/api/etfs/${isin}/profile?locale=it&valuta=EUR`;
    const { status, body } = await httpsGet(url, {
      'Referer': 'https://www.justetf.com/',
      'Accept': 'application/json'
    });
    if (status === 200 && body) {
      return parseJustETF(body);
    }
  } catch(e) { console.log('  JustETF error:', e.message); }

  // Fallback: pagina HTML con dati embedded
  try {
    const url = `https://www.justetf.com/en/etf-profile.html?isin=${isin}`;
    const { status, raw } = await httpsGet(url, {
      'Referer': 'https://www.justetf.com/',
      'Accept': 'text/html'
    });
    if (status === 200 && raw) {
      return parseJustETFHtml(raw, isin);
    }
  } catch(e) {}

  return null;
}

function parseJustETF(data) {
  if (!data) return null;
  const sectors = {}, geos = {}, holdings = [];

  // Settori
  if (Array.isArray(data.sectors)) {
    data.sectors.forEach(s => {
      if (s.name && s.weight > 0) sectors[s.name] = s.weight;
    });
  }
  // Geografie
  if (Array.isArray(data.countries)) {
    data.countries.forEach(c => {
      if (c.name && c.weight > 0) geos[c.name] = c.weight;
    });
  }
  // Holdings
  if (Array.isArray(data.holdings)) {
    data.holdings.slice(0, 10).forEach(h => {
      if (h.name && h.weight > 0) holdings.push({ name: h.name, weight: h.weight });
    });
  }

  return Object.keys(sectors).length || Object.keys(geos).length
    ? { sectors, geos, holdings }
    : null;
}

function parseJustETFHtml(html, isin) {
  // Estrai dati embedded come JSON nella pagina
  const match = html.match(/window\.__INITIAL_STATE__\s*=\s*({[\s\S]+?});\s*<\/script>/);
  if (!match) return null;
  try {
    const state = JSON.parse(match[1]);
    const etfData = state?.etf || state?.product;
    if (etfData) return parseJustETF(etfData);
  } catch(e) {}
  return null;
}

// ── Dispatcher principale per ETF ─────────────────────────────────
async function fetchETFComposition(ticker, isin) {
  const provider = detectProvider(isin, ticker);
  console.log(`  Provider: ${provider} | ISIN: ${isin}`);

  let result = null;

  // 1. Prova il provider nativo
  if (provider === 'ishares')   result = await fetchIShares(isin, ticker);
  if (provider === 'xtrackers') result = await fetchXtrackers(isin, ticker);
  if (provider === 'amundi')    result = await fetchAmundi(isin, ticker);
  if (provider === 'vanguard')  result = await fetchIShares(isin, ticker); // stessa struttura

  // 2. Fallback universale: JustETF
  if (!result) {
    console.log(`  → fallback JustETF`);
    result = await fetchJustETF(isin);
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
  if (status !== 200) throw new Error(`Gist API: HTTP ${status}`);
  return body;
}

async function writeGistFile(gistId, filename, content) {
  const { status, body } = await httpsPatch(
    `https://api.github.com/gists/${gistId}`,
    { files: { [filename]: { content: JSON.stringify(content, null, 2) } } },
    GHDR
  );
  if (status !== 200) throw new Error(`Scrittura Gist: HTTP ${status}`);
  return body;
}

// ── Estrai ETF dal portafoglio ────────────────────────────────────
function extractETFs(portfolioData) {
  const ETF_CATEGORIES = ['ETF Azionario', 'ETF Monetario', 'ETF Monetario / Fondo Monetario',
                          'ETF Obbligazionario', 'ETF Materie Prime', 'ETF'];

  const etfs = new Map(); // ticker → { ticker, isin, name, category }

  (portfolioData.portfolios || []).forEach(pf => {
    (pf.ops || []).forEach(op => {
      if (!ETF_CATEGORIES.some(c => (op.category || '').includes(c))) return;
      if (!op.isin) return; // ISIN obbligatorio per fetch

      const ticker = op.quoteTicker || op.ticker;
      if (!ticker || ticker === '__CASH__') return;

      const qty = (op.type === 'buy' ? 1 : -1) * (op.qty || 0);
      if (!etfs.has(ticker)) {
        etfs.set(ticker, { ticker, isin: op.isin, name: op.name || ticker, qty });
      } else {
        etfs.get(ticker).qty += qty;
      }
    });
  });

  // Tieni solo ETF con posizione aperta
  return [...etfs.values()].filter(e => e.qty > 0.001);
}

// ── Main ──────────────────────────────────────────────────────────
console.log('=== Portafoglio BIT — ETF Composition Fetcher ===');
console.log(`UTC: ${new Date().toISOString()}`);

const gistId = await findGistId();
if (!gistId) { console.error('Gist non trovato'); process.exit(1); }
console.log(`Gist: ${gistId}`);

// Leggi portafoglio
const gist = await readGist(gistId);
const portfolioContent = gist.files?.['portafoglio-bit.json']?.content;
if (!portfolioContent) { console.error('portafoglio-bit.json non trovato'); process.exit(1); }
const portfolioData = JSON.parse(portfolioContent);

// Leggi composizioni esistenti (se ci sono)
const existingContent = gist.files?.['etf-composition.json']?.content;
const existing = existingContent ? JSON.parse(existingContent) : {};

// Estrai ETF attivi
const etfs = extractETFs(portfolioData);
console.log(`\nETF trovati: ${etfs.length}`);
etfs.forEach(e => console.log(`  ${e.ticker.padEnd(15)} ISIN: ${e.isin}  "${e.name}"`));

if (!etfs.length) {
  console.log('Nessun ETF con ISIN trovato — assicurati che le operazioni abbiano il campo ISIN');
  process.exit(0);
}

// Fetch composizione per ogni ETF
const results = {};
const report = { updated: [], failed: [], unchanged: [] };

for (const etf of etfs) {
  console.log(`\n[${etf.ticker}] "${etf.name}"`);
  try {
    const data = await fetchETFComposition(etf.ticker, etf.isin);
    if (data && (Object.keys(data.sectors || {}).length || Object.keys(data.geos || {}).length)) {
      results[etf.ticker] = {
        ticker:    etf.ticker,
        isin:      etf.isin,
        name:      etf.name,
        sectors:   data.sectors  || {},
        geos:      data.geos     || {},
        holdings:  data.holdings || [],
        updatedAt: new Date().toISOString(),
        source:    data.source   || 'auto'
      };
      console.log(`  ✅ OK — settori: ${Object.keys(data.sectors||{}).length}, geo: ${Object.keys(data.geos||{}).length}, holdings: ${(data.holdings||[]).length}`);
      report.updated.push(etf.ticker);
    } else {
      // Mantieni dati vecchi se disponibili
      if (existing[etf.ticker]) {
        results[etf.ticker] = existing[etf.ticker];
        console.log(`  ⚠️  Nessun dato nuovo — mantengo dati del ${existing[etf.ticker].updatedAt?.slice(0,10)}`);
        report.failed.push({ ticker: etf.ticker, oldDate: existing[etf.ticker].updatedAt?.slice(0,10) });
      } else {
        console.log(`  ❌ Nessun dato trovato`);
        report.failed.push({ ticker: etf.ticker, oldDate: null });
      }
    }
  } catch(e) {
    console.error(`  ❌ Errore: ${e.message}`);
    if (existing[etf.ticker]) results[etf.ticker] = existing[etf.ticker];
    report.failed.push({ ticker: etf.ticker, oldDate: existing[etf.ticker]?.updatedAt?.slice(0,10) || null });
  }
  await delay(800); // rate limiting educato
}

// Costruisci output finale
const output = {
  ...results,
  __meta: {
    updatedAt:   new Date().toISOString(),
    totalETFs:   etfs.length,
    updated:     report.updated,
    failed:      report.failed.map(f => f.ticker),
    failedDates: Object.fromEntries(report.failed.map(f => [f.ticker, f.oldDate]))
  }
};

// Salva nel Gist
console.log(`\nSalvataggio etf-composition.json nel Gist...`);
await writeGistFile(gistId, 'etf-composition.json', output);

console.log(`\n${'═'.repeat(50)}`);
console.log(`✅ Aggiornati (${report.updated.length}): ${report.updated.join(', ') || '—'}`);
console.log(`⚠️  Dati vecchi (${report.failed.filter(f=>f.oldDate).length}): ${report.failed.filter(f=>f.oldDate).map(f=>`${f.ticker} (${f.oldDate})`).join(', ') || '—'}`);
console.log(`❌ Non trovati (${report.failed.filter(f=>!f.oldDate).length}): ${report.failed.filter(f=>!f.oldDate).map(f=>f.ticker).join(', ') || '—'}`);
console.log(`DONE`);
