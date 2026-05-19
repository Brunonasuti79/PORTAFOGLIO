// Save official daily market closes into the Portafoglio BIT GitHub Gist.
// Token-only version: it finds the Gist by filename "portafoglio-bit.json".
// Node 24. No npm dependencies.

let GIST_ID = String(process.env.GIST_ID || "").trim();
const GIST_TOKEN = String(process.env.GIST_TOKEN || "").trim();
const FINNHUB_API_KEY = String(process.env.FINNHUB_API_KEY || "").trim();
const MARKET_FILTER = String(process.env.MARKET || "ALL").toUpperCase();
const FORCE = String(process.env.FORCE || "false").toLowerCase() === "true";

const GIST_FILE = "portafoglio-bit.json";
const LOGIC_VERSION = "official-close-actions-v1-2026-05-18";

if (!GIST_TOKEN) {
  throw new Error("Missing required secret: PORTFOLIO_GIST_TOKEN");
}

const EU_MARKETS = new Set([
  "MI", "MOT", "DE", "PA", "L", "SW", "AS", "F",
  "ST", "CO", "HE", "OL", "BR", "VX", "AMS"
]);

const STOOQ_SUFFIX = {
  MI: ".it",
  MOT: ".it",
  DE: ".de",
  PA: ".fr",
  L: ".uk",
  SW: ".ch",
  AS: ".nl",
  F: ".de",
  ST: ".se",
  CO: ".dk",
  HE: ".fi",
  OL: ".no",
  BR: ".be",
  VX: ".ch",
  AMS: ".nl"
};

const YAHOO_SUFFIX_TO_MARKET = {
  ".MI": "MI",
  ".DE": "DE",
  ".PA": "PA",
  ".L": "L",
  ".SW": "SW",
  ".AS": "AS",
  ".F": "F",
  ".ST": "ST",
  ".CO": "CO",
  ".HE": "HE",
  ".OL": "OL",
  ".BR": "BR",
  ".VX": "VX"
};

function fc(v) {
  return String(v || "").trim().toUpperCase().replace(/\s+/g, "");
}

function baseTicker(v) {
  return fc(v).replace(/\.[A-Z0-9]+$/, "");
}

function marketFromSymbol(sym) {
  const s = fc(sym);
  for (const [suffix, market] of Object.entries(YAHOO_SUFFIX_TO_MARKET)) {
    if (s.endsWith(suffix)) return market;
  }
  return "";
}

function isEUQuote(sym, market = "") {
  const m = fc(market || marketFromSymbol(sym));
  return EU_MARKETS.has(m);
}

function isUSQuote(sym, market = "") {
  const m = fc(market);
  const s = fc(sym);

  if (m === "NYSE" || m === "NASDAQ" || m === "US") return true;

  // Se non ha suffisso europeo, lo trattiamo come USA.
  return !!s && !s.includes(".") && !isEUQuote(s, m);
}

function localDate(tz, d = new Date()) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).format(d);
}

function nowParts(tz) {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: tz,
    hour12: false,
    weekday: "short",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit"
  }).formatToParts(new Date()).reduce((acc, part) => {
    acc[part.type] = part.value;
    return acc;
  }, {});

  return {
    weekday: parts.weekday,
    hour: Number(parts.hour),
    minute: Number(parts.minute),
    date: `${parts.year}-${parts.month}-${parts.day}`
  };
}

function isWeekday(tz) {
  const w = nowParts(tz).weekday;
  return !["Sat", "Sun"].includes(w);
}

function isAfterEuCloseWindow() {
  const p = nowParts("Europe/Rome");
  return isWeekday("Europe/Rome") && (p.hour > 17 || (p.hour === 17 && p.minute >= 40));
}

function isAfterUsCloseWindow() {
  const p = nowParts("America/New_York");
  return isWeekday("America/New_York") && (p.hour > 16 || (p.hour === 16 && p.minute >= 10));
}

function shouldRunMarket(region) {
  if (MARKET_FILTER !== "ALL" && MARKET_FILTER !== region) return false;
  if (FORCE) return true;
  if (region === "EU") return isAfterEuCloseWindow();
  if (region === "US") return isAfterUsCloseWindow();
  return false;
}

async function fetchJson(url, opts = {}) {
  const res = await fetch(url, {
    ...opts,
    headers: {
      "User-Agent": "PortafoglioBIT-CloseBot/1.0",
      ...(opts.headers || {})
    }
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`HTTP ${res.status} for ${url} — ${text.slice(0, 300)}`);
  }

  return await res.json();
}

async function fetchText(url, opts = {}) {
  const res = await fetch(url, {
    ...opts,
    headers: {
      "User-Agent": "PortafoglioBIT-CloseBot/1.0",
      ...(opts.headers || {})
    }
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`HTTP ${res.status} for ${url} — ${text.slice(0, 300)}`);
  }

  return await res.text();
}

async function findPortfolioGistId() {
  if (GIST_ID) return GIST_ID;

  for (let page = 1; page <= 5; page++) {
    const list = await fetchJson(`https://api.github.com/gists?per_page=100&page=${page}`, {
      headers: {
        Authorization: `Bearer ${GIST_TOKEN}`,
        Accept: "application/vnd.github+json"
      }
    });

    if (!Array.isArray(list) || !list.length) break;

    const found = list.find(gist => gist.files && gist.files[GIST_FILE]);
    if (found?.id) {
      GIST_ID = found.id;
      console.log(`Using Gist ${GIST_ID} found by filename ${GIST_FILE}`);
      return GIST_ID;
    }
  }

  throw new Error(
    `No Gist containing ${GIST_FILE} found. ` +
    `Open the app once, insert the token, and press Save now so the app can create it.`
  );
}

async function getGistBackup() {
  const gistId = await findPortfolioGistId();

  const data = await fetchJson(`https://api.github.com/gists/${gistId}`, {
    headers: {
      Authorization: `Bearer ${GIST_TOKEN}`,
      Accept: "application/vnd.github+json"
    }
  });

  const content = data.files?.[GIST_FILE]?.content;
  if (!content) throw new Error(`Gist file ${GIST_FILE} not found`);

  return JSON.parse(content);
}

async function patchGistBackup(backup) {
  const gistId = await findPortfolioGistId();

  const body = JSON.stringify({
    files: {
      [GIST_FILE]: {
        content: JSON.stringify(backup, null, 2)
      }
    }
  });

  const res = await fetch(`https://api.github.com/gists/${gistId}`, {
    method: "PATCH",
    headers: {
      Authorization: `Bearer ${GIST_TOKEN}`,
      Accept: "application/vnd.github+json",
      "Content-Type": "application/json"
    },
    body
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Gist PATCH failed: HTTP ${res.status} ${text}`);
  }

  return await res.json();
}

function extractHoldings(backup) {
  const out = new Map();
  const portfolios = Array.isArray(backup.portfolios) ? backup.portfolios : [];

  for (const pf of portfolios) {
    for (const op of (pf.ops || [])) {
      const quoteTicker = fc(op.quoteTicker || op.priceSymbol || op.ticker || op.displayTicker || "");
      if (!quoteTicker || quoteTicker === "__CASH__") continue;

      const market = fc(op.market || marketFromSymbol(quoteTicker));
      const key = quoteTicker;

      if (!out.has(key)) {
        const region = isEUQuote(quoteTicker, market)
          ? "EU"
          : (isUSQuote(quoteTicker, market) ? "US" : "OTHER");

        out.set(key, {
          quoteTicker,
          market,
          region,
          name: op.name || op.displayTicker || quoteTicker
        });
      }
    }
  }

  return [...out.values()].filter(x => x.region === "EU" || x.region === "US");
}

function stooqSymbol(sym, market) {
  const m = fc(market || marketFromSymbol(sym));
  const suffix = STOOQ_SUFFIX[m] || "";
  return baseTicker(sym).toLowerCase() + suffix;
}

async function fetchStooqDailyClose(sym, market, marketDate) {
  const stooqSym = stooqSymbol(sym, market);
  const url = `https://stooq.com/q/d/l/?s=${encodeURIComponent(stooqSym)}&i=d`;
  const csv = await fetchText(url);

  const rows = csv
    .trim()
    .split(/\r?\n/)
    .slice(1)
    .map(line => line.split(","))
    .filter(row => row.length >= 5);

  const matches = rows
    .filter(row => row[0] <= marketDate && Number(row[4]) > 0);

  if (!matches.length) return null;

  const last = matches[matches.length - 1];

  // Se oggi è festivo e Stooq ha solo l'ultima riga precedente,
  // non salviamo una chiusura falsa per la data odierna.
  if (last[0] !== marketDate) {
    return {
      skipped: true,
      reason: `no close for ${marketDate}; latest Stooq row is ${last[0]}`,
      sourceDate: last[0]
    };
  }

  return {
    close: Number(last[4]),
    sourceDate: last[0],
    source: "stooq",
    symbol: stooqSym
  };
}

async function fetchYahooDailyClose(sym, marketDate, tz) {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(sym)}?interval=1d&range=10d`;
  const data = await fetchJson(url);

  const result = data?.chart?.result?.[0];
  if (!result) return null;

  const timestamps = result.timestamp || [];
  const quote = result.indicators?.quote?.[0] || {};
  const closes = quote.close || [];

  const rows = timestamps
    .map((t, index) => ({
      date: localDate(tz, new Date(t * 1000)),
      close: Number(closes[index])
    }))
    .filter(row => row.date <= marketDate && Number.isFinite(row.close) && row.close > 0);

  if (!rows.length) return null;

  const last = rows[rows.length - 1];

  if (last.date !== marketDate) {
    return {
      skipped: true,
      reason: `no Yahoo close for ${marketDate}; latest row is ${last.date}`,
      sourceDate: last.date
    };
  }

  return {
    close: last.close,
    sourceDate: last.date,
    source: "yahoo-chart",
    symbol: sym
  };
}

async function fetchYahooQuoteClose(sym, marketDate) {
  const url =
    `https://query1.finance.yahoo.com/v7/finance/quote?symbols=${encodeURIComponent(sym)}` +
    `&fields=regularMarketPrice,regularMarketTime,regularMarketPreviousClose,regularMarketChangePercent,marketState`;

  const data = await fetchJson(url);
  const quote = data?.quoteResponse?.result?.[0];
  const price = Number(quote?.regularMarketPrice);

  if (!Number.isFinite(price) || price <= 0) return null;

  // Dopo chiusura, regularMarketPrice è di solito il close o molto vicino.
  // Yahoo daily chart resta comunque la fonte preferita.
  return {
    close: price,
    sourceDate: marketDate,
    source: "yahoo-quote",
    symbol: sym,
    marketState: quote?.marketState || ""
  };
}

async function fetchFinnhubClose(sym, marketDate) {
  if (!FINNHUB_API_KEY) return null;

  const url =
    `https://finnhub.io/api/v1/quote?symbol=${encodeURIComponent(sym)}` +
    `&token=${encodeURIComponent(FINNHUB_API_KEY)}`;

  const data = await fetchJson(url);
  const price = Number(data?.c);

  if (!Number.isFinite(price) || price <= 0) return null;

  return {
    close: price,
    sourceDate: marketDate,
    source: "finnhub",
    symbol: sym
  };
}

async function fetchOfficialClose(holding, marketDate) {
  if (holding.region === "EU") {
    // Europa/ETF: Stooq daily close è la fonte principale.
    try {
      const stooq = await fetchStooqDailyClose(holding.quoteTicker, holding.market, marketDate);
      if (stooq) return stooq;
    } catch (err) {
      console.log(`[EU] ${holding.quoteTicker} Stooq failed: ${err.message}`);
    }

    // Fallback solo se Stooq fallisce completamente.
    try {
      const yahoo = await fetchYahooDailyClose(holding.quoteTicker, marketDate, "Europe/Rome");
      if (yahoo) return yahoo;
    } catch (err) {
      console.log(`[EU] ${holding.quoteTicker} Yahoo chart failed: ${err.message}`);
    }

    return null;
  }

  if (holding.region === "US") {
    // USA: Yahoo daily chart preferito dopo chiusura ufficiale.
    try {
      const yahoo = await fetchYahooDailyClose(holding.quoteTicker, marketDate, "America/New_York");
      if (yahoo) return yahoo;
    } catch (err) {
      console.log(`[US] ${holding.quoteTicker} Yahoo chart failed: ${err.message}`);
    }

    try {
      const quote = await fetchYahooQuoteClose(holding.quoteTicker, marketDate);
      if (quote) return quote;
    } catch (err) {
      console.log(`[US] ${holding.quoteTicker} Yahoo quote failed: ${err.message}`);
    }

    try {
      const finnhub = await fetchFinnhubClose(holding.quoteTicker, marketDate);
      if (finnhub) return finnhub;
    } catch (err) {
      console.log(`[US] ${holding.quoteTicker} Finnhub failed: ${err.message}`);
    }

    return null;
  }

  return null;
}

function ensureOfficialCloses(backup) {
  if (!backup.officialCloses || typeof backup.officialCloses !== "object") {
    backup.officialCloses = {};
  }

  if (!backup.officialClosesMeta || typeof backup.officialClosesMeta !== "object") {
    backup.officialClosesMeta = {};
  }
}

async function main() {
  console.log(`Starting close saver. MARKET=${MARKET_FILTER} FORCE=${FORCE}`);
  console.log(`Rome now: ${JSON.stringify(nowParts("Europe/Rome"))}`);
  console.log(`NY now:   ${JSON.stringify(nowParts("America/New_York"))}`);

  const backup = await getGistBackup();
  ensureOfficialCloses(backup);

  const holdings = extractHoldings(backup);
  console.log(
    `Found ${holdings.length} eligible tickers: ` +
    holdings.map(h => `${h.quoteTicker}/${h.region}`).join(", ")
  );

  const datesByRegion = {
    EU: localDate("Europe/Rome"),
    US: localDate("America/New_York")
  };

  let changed = 0;
  let skipped = 0;
  let failed = 0;

  for (const holding of holdings) {
    if (!shouldRunMarket(holding.region)) {
      skipped++;
      continue;
    }

    const marketDate = datesByRegion[holding.region];

    backup.officialCloses[holding.quoteTicker] ||= {};

    const existing = backup.officialCloses[holding.quoteTicker][marketDate];

    if (existing && !FORCE) {
      console.log(
        `[SKIP] ${holding.quoteTicker} ${marketDate}: ` +
        `already has close ${existing.close} (${existing.source})`
      );
      skipped++;
      continue;
    }

    const closeData = await fetchOfficialClose(holding, marketDate);

    if (!closeData || closeData.skipped || !Number.isFinite(Number(closeData.close))) {
      console.log(
        `[MISS] ${holding.quoteTicker} ${marketDate}: ` +
        `${closeData?.reason || "no valid close"}`
      );
      failed++;
      continue;
    }

    backup.officialCloses[holding.quoteTicker][marketDate] = {
      close: Number(closeData.close),
      market: holding.region,
      marketDate,
      sourceDate: closeData.sourceDate,
      source: closeData.source,
      symbol: closeData.symbol,
      savedAt: new Date().toISOString(),
      overwrite: !!existing,
      logicVersion: LOGIC_VERSION
    };

    console.log(
      `[SAVE] ${holding.quoteTicker} ${marketDate}: ` +
      `${closeData.close} via ${closeData.source}`
    );

    changed++;
  }

  backup.officialClosesMeta.lastRunAt = new Date().toISOString();
  backup.officialClosesMeta.lastRunMarket = MARKET_FILTER;
  backup.officialClosesMeta.logicVersion = LOGIC_VERSION;
  backup.officialClosesMeta.lastResult = {
    saved: changed,
    skipped,
    failed,
    runAt: new Date().toISOString(),
    market: MARKET_FILTER
  };

  backup.updatedBy = "github-actions-close-prices";

  if (changed > 0) {
    await patchGistBackup(backup);
    console.log(`Done. Saved ${changed}, skipped ${skipped}, failed ${failed}.`);
  } else {
    // Aggiorna comunque la meta, così sai che il workflow è girato.
    await patchGistBackup(backup);
    console.log(`Done. No close saved. Saved ${changed}, skipped ${skipped}, failed ${failed}.`);
  }
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
