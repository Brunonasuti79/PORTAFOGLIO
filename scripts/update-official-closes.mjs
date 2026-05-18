/**
 * update-official-closes.mjs
 *
 * Legge il Gist dell'app Portafoglio BIT, recupera le chiusure ufficiali
 * per i ticker aperti e salva:
 *
 * backup.officialCloses[ticker][YYYY-MM-DD] = {
 *   close,
 *   market,
 *   source,
 *   sourceDate,
 *   savedAt
 * }
 *
 * Variabili richieste:
 * - GIST_ID
 * - GIST_TOKEN
 *
 * Variabili opzionali:
 * - FINNHUB_API_KEY
 * - MARKET = ALL | EU | US
 * - FORCE = true | false
 */

const GIST_ID = process.env.GIST_ID || "";
const GIST_TOKEN = process.env.GIST_TOKEN || "";
const FINNHUB_API_KEY = process.env.FINNHUB_API_KEY || "";
const MARKET = String(process.env.MARKET || "ALL").toUpperCase();
const FORCE = String(process.env.FORCE || "false").toLowerCase() === "true";

const GIST_FILENAME = "portafoglio-bit.json";

if (!GIST_ID || !GIST_TOKEN) {
  console.error("Missing required env vars: GIST_ID and/or GIST_TOKEN.");
  process.exit(1);
}

function fc(v) {
  return String(v || "").trim().toUpperCase().replace(/\s+/g, "");
}

function baseTicker(v) {
  return fc(v).replace(/\.[A-Z0-9]+$/, "");
}

function marketFromSymbol(sym) {
  const m = fc(sym).match(/\.([A-Z0-9]+)$/);
  return m ? m[1] : "";
}

function stooqSuffix(code) {
  const map = {
    MI: ".it",
    MOT: ".it",
    DE: ".de",
    PA: ".fr",
    L: ".uk",
    SW: ".ch",
    AS: ".nl",
    F: ".de"
  };
  return map[code] || "";
}

function getDateKey(timeZone, date = new Date()) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).format(date);
}

function isEUHolding(h) {
  const mkt = fc(h.market || marketFromSymbol(h.ticker));
  const tk = fc(h.ticker);
  return (
    ["MI", "MOT", "DE", "PA", "L", "SW", "AS", "F", "ST", "CO", "HE", "OL", "BR", "VX", "AMS"].includes(mkt) ||
    /\.(MI|DE|PA|L|SW|AS|F|ST|CO|HE|OL|BR|VX)$/i.test(tk)
  );
}

function isUSHolding(h) {
  return !isEUHolding(h);
}

function normalizeOp(op) {
  const displayTicker = fc(op.displayTicker || op.ticker || "");
  const quoteTicker = fc(op.quoteTicker || op.priceSymbol || op.ticker || displayTicker);
  const market = op.market || marketFromSymbol(quoteTicker);
  return {
    ...op,
    displayTicker,
    ticker: quoteTicker,
    quoteTicker,
    market
  };
}

function calcOpenHoldings(portfolio) {
  const map = new Map();
  const ops = [...(portfolio.ops || [])]
    .map(normalizeOp)
    .filter(op => op.quoteTicker || op.ticker)
    .sort((a, b) => String(a.date || "").localeCompare(String(b.date || "")));

  for (const op of ops) {
    const key = fc(op.quoteTicker || op.ticker);
    if (!key) continue;

    if (!map.has(key)) {
      map.set(key, {
        ticker: key,
        displayTicker: fc(op.displayTicker || baseTicker(key)),
        market: op.market || marketFromSymbol(key),
        name: op.name || fc(op.displayTicker || baseTicker(key)),
        qty: 0
      });
    }

    const h = map.get(key);
    const qty = Number(String(op.qty ?? "0").replace(",", ".")) || 0;

    if (op.type === "sell") h.qty -= qty;
    else h.qty += qty;

    if (op.market) h.market = op.market;
    if (op.name) h.name = op.name;
    if (op.displayTicker) h.displayTicker = op.displayTicker;
  }

  return [...map.values()].filter(h => h.qty > 0.00001);
}

function collectHoldings(backup) {
  const all = [];
  for (const pf of backup.portfolios || []) {
    all.push(...calcOpenHoldings(pf));
  }

  const byTicker = new Map();
  for (const h of all) {
    if (!byTicker.has(h.ticker)) byTicker.set(h.ticker, h);
  }

  return [...byTicker.values()];
}

async function fetchJson(url, options = {}) {
  const res = await fetch(url, {
    ...options,
    headers: {
      "User-Agent": "PortafoglioBIT/1.0",
      "Accept": "application/json",
      ...(options.headers || {})
    }
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`HTTP ${res.status} ${res.statusText}: ${text.slice(0, 200)}`);
  }

  return await res.json();
}

async function fetchText(url, options = {}) {
  const res = await fetch(url, {
    ...options,
    headers: {
      "User-Agent": "PortafoglioBIT/1.0",
      "Accept": "text/plain,*/*",
      ...(options.headers || {})
    }
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`HTTP ${res.status} ${res.statusText}: ${text.slice(0, 200)}`);
  }

  return await res.text();
}

async function readGist() {
  const data = await fetchJson(`https://api.github.com/gists/${GIST_ID}`, {
    headers: {
      Authorization: `Bearer ${GIST_TOKEN}`,
      Accept: "application/vnd.github+json"
    }
  });

  const raw = data.files?.[GIST_FILENAME]?.content;
  if (!raw) throw new Error(`File ${GIST_FILENAME} not found inside Gist ${GIST_ID}`);

  return JSON.parse(raw);
}

async function writeGist(backup) {
  const content = JSON.stringify(backup, null, 2);

  await fetchJson(`https://api.github.com/gists/${GIST_ID}`, {
    method: "PATCH",
    headers: {
      Authorization: `Bearer ${GIST_TOKEN}`,
      Accept: "application/vnd.github+json",
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      files: {
        [GIST_FILENAME]: { content }
      }
    })
  });
}

async function fetchStooqCloseForMarketDate(holding, marketDate) {
  const mkt = holding.market || marketFromSymbol(holding.ticker);
  const base = baseTicker(holding.ticker).toLowerCase();
  const sfx = stooqSuffix(mkt);
  const stooqSym = sfx ? base + sfx : holding.ticker.toLowerCase();

  const url = `https://stooq.com/q/d/l/?s=${encodeURIComponent(stooqSym)}&i=d`;
  const csv = await fetchText(url);

  const rows = csv
    .trim()
    .split(/\r?\n/)
    .filter(Boolean)
    .slice(1)
    .map(line => line.split(","))
    .filter(r => r.length >= 5 && r[0] && r[4]);

  if (!rows.length) return null;

  const validRows = rows
    .map(r => ({
      date: r[0],
      close: Number(String(r[4]).replace(",", "."))
    }))
    .filter(r => r.date <= marketDate && Number.isFinite(r.close) && r.close > 0)
    .sort((a, b) => a.date.localeCompare(b.date));

  const last = validRows[validRows.length - 1];
  if (!last) return null;

  // Se oggi è festivo e Stooq dà l'ultima riga precedente, NON salviamo un close finto per oggi.
  if (last.date !== marketDate) {
    return {
      skipped: true,
      reason: `No Stooq row for market date ${marketDate}; latest row is ${last.date}`,
      latestDate: last.date,
      latestClose: last.close
    };
  }

  return {
    close: last.close,
    source: "stooq",
    sourceDate: last.date
  };
}

async function fetchYahooDailyCloseForMarketDate(symbol, marketDate) {
  const url =
    `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}` +
    `?interval=1d&range=10d`;

  const data = await fetchJson(url);
  const result = data?.chart?.result?.[0];
  if (!result) return null;

  const timestamps = result.timestamp || [];
  const quote = result.indicators?.quote?.[0] || {};
  const closes = quote.close || [];

  const rows = timestamps
    .map((t, i) => {
      const d = getDateKey("America/New_York", new Date(t * 1000));
      const close = Number(closes[i]);
      return { date: d, close };
    })
    .filter(r => r.date <= marketDate && Number.isFinite(r.close) && r.close > 0)
    .sort((a, b) => a.date.localeCompare(b.date));

  const last = rows[rows.length - 1];
  if (!last) return null;

  // Se oggi è festivo o Yahoo non ha ancora la candela del giorno, non salviamo un close finto.
  if (last.date !== marketDate) {
    return {
      skipped: true,
      reason: `No Yahoo daily candle for market date ${marketDate}; latest candle is ${last.date}`,
      latestDate: last.date,
      latestClose: last.close
    };
  }

  return {
    close: last.close,
    source: "yahoo-chart",
    sourceDate: last.date
  };
}

async function fetchFinnhubCloseForUS(holding, marketDate) {
  if (!FINNHUB_API_KEY) return null;

  const symbol = baseTicker(holding.ticker) || holding.ticker;
  const url =
    `https://finnhub.io/api/v1/quote?symbol=${encodeURIComponent(symbol)}` +
    `&token=${encodeURIComponent(FINNHUB_API_KEY)}`;

  const data = await fetchJson(url);
  const close = Number(data?.c);

  if (!Number.isFinite(close) || close <= 0) return null;

  // Finnhub quote non porta una data di candela qui.
  // Lo usiamo solo come fallback dopo la chiusura schedulata.
  return {
    close,
    source: "finnhub-quote",
    sourceDate: marketDate
  };
}

async function fetchOfficialClose(holding, region, marketDate) {
  if (region === "EU") {
    return await fetchStooqCloseForMarketDate(holding, marketDate);
  }

  // USA: Yahoo daily candle prima, Finnhub solo fallback.
  const yahoo = await fetchYahooDailyCloseForMarketDate(holding.ticker, marketDate).catch(err => ({
    error: err.message
  }));

  if (yahoo && !yahoo.error) return yahoo;

  const fh = await fetchFinnhubCloseForUS(holding, marketDate).catch(err => ({
    error: err.message
  }));

  if (fh && !fh.error) return fh;

  if (yahoo?.error) throw new Error(`Yahoo failed: ${yahoo.error}`);
  if (fh?.error) throw new Error(`Finnhub failed: ${fh.error}`);

  return null;
}

function shouldProcessRegion(region) {
  if (MARKET === "ALL") return true;
  return MARKET === region;
}

function ensureContainers(backup) {
  if (!backup.officialCloses) backup.officialCloses = {};
  if (!backup.officialClosesMeta) backup.officialClosesMeta = {};
  backup.officialClosesMeta.lastWorkflowRunAt = new Date().toISOString();
  backup.officialClosesMeta.lastWorkflowMarket = MARKET;
  backup.officialClosesMeta.version = "github-actions-official-closes-v1";
}

async function main() {
  console.log(`Starting official close update. MARKET=${MARKET} FORCE=${FORCE}`);

  const backup = await readGist();
  ensureContainers(backup);

  const holdings = collectHoldings(backup);
  if (!holdings.length) {
    console.log("No open holdings found in Gist backup. Nothing to update.");
    await writeGist(backup);
    return;
  }

  const euDate = getDateKey("Europe/Rome");
  const usDate = getDateKey("America/New_York");

  let saved = 0;
  let skipped = 0;
  let failed = 0;

  for (const h of holdings) {
    const region = isEUHolding(h) ? "EU" : "US";
    if (!shouldProcessRegion(region)) continue;

    const marketDate = region === "EU" ? euDate : usDate;
    const ticker = fc(h.ticker);

    if (!ticker) continue;

    if (!backup.officialCloses[ticker]) backup.officialCloses[ticker] = {};

    if (backup.officialCloses[ticker][marketDate] && !FORCE) {
      console.log(`SKIP ${ticker} ${region} ${marketDate}: already exists`);
      skipped++;
      continue;
    }

    try {
      const closeData = await fetchOfficialClose(h, region, marketDate);

      if (!closeData) {
        console.log(`SKIP ${ticker} ${region}: no close data`);
        skipped++;
        continue;
      }

      if (closeData.skipped) {
        console.log(`SKIP ${ticker} ${region}: ${closeData.reason}`);
        skipped++;
        continue;
      }

      backup.officialCloses[ticker][marketDate] = {
        close: Number(closeData.close),
        market: region,
        source: closeData.source,
        sourceDate: closeData.sourceDate,
        savedAt: new Date().toISOString()
      };

      console.log(
        `SAVE ${ticker} ${region} ${marketDate}: close=${closeData.close} source=${closeData.source}`
      );
      saved++;
    } catch (err) {
      console.log(`FAIL ${ticker} ${region}: ${err.message || err}`);
      failed++;
    }
  }

  backup.officialClosesMeta.lastResult = {
    saved,
    skipped,
    failed,
    runAt: new Date().toISOString(),
    market: MARKET
  };

  await writeGist(backup);

  console.log(`Done. saved=${saved}, skipped=${skipped}, failed=${failed}`);
}

main().catch(err => {
  console.error("Fatal error:", err);
  process.exit(1);
});
