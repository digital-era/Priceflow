/**
 * QueryLocal Worker — 东财实时行情 / 分时（抗限流版）
 *
 * 策略：
 *  - price 批量：ulist.np，15/批，串行，批间隔 ~1.2s + 抖动
 *  - 空批：长退避后同批仅重试 1 次，不拆批、不单只补全
 *  - 成功结果写入 caches.default（15s 新鲜），重复请求优先命中
 *  - 全程不并发打东财价格接口
 */

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

const EM_HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36",
  Referer: "https://quote.eastmoney.com/",
  Accept: "*/*",
};

// ---------- 抗限流参数 ----------
const ULIST_BATCH_SIZE = 15;
const ULIST_BATCH_DELAY_MS = 1200;   // 批间隔基准
const ULIST_EMPTY_BACKOFF_MS = 2500; // 空批退避
const CACHE_FRESH_SECONDS = 15;      // 新鲜缓存
const CACHE_STALE_SECONDS = 60;      // 过期仍可回退

// 分时仍需单只，低速串行
const INTRADAY_DELAY_MS = 400;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const jitter = (base, ratio = 0.2) => {
  const d = base * ratio;
  return Math.round(base - d + Math.random() * d * 2);
};

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "max-age=5, stale-while-revalidate=10",
      ...CORS,
    },
  });
}

// ==============================
// 代码转换
// ==============================
function convertCode(code) {
  const codeUpper = String(code || "").toUpperCase().trim();
  if (!codeUpper) return null;

  if (codeUpper.startsWith("HK")) {
    const pure = codeUpper.slice(2).replace(/^0+/, "") || "0";
    return {
      secid: `116.${pure}`,
      currency: "HKD",
      orig: code,
      pureCode: pure.padStart(5, "0"),
    };
  }
  if (/^\d{4,5}$/.test(codeUpper)) {
    return {
      secid: `116.${codeUpper.padStart(5, "0")}`,
      currency: "HKD",
      orig: code,
      pureCode: codeUpper.padStart(5, "0"),
    };
  }
  if (/^(60|68|51|56|58|55|900)/.test(codeUpper)) {
    return {
      secid: `1.${codeUpper}`,
      currency: "CNY",
      orig: code,
      pureCode: codeUpper.padStart(6, "0"),
    };
  }
  if (/^(00|30|15|200)/.test(codeUpper)) {
    return {
      secid: `0.${codeUpper}`,
      currency: "CNY",
      orig: code,
      pureCode: codeUpper.padStart(6, "0"),
    };
  }
  if (/^[48]/.test(codeUpper)) {
    return {
      secid: `0.${codeUpper}`,
      currency: "CNY",
      orig: code,
      pureCode: codeUpper.padStart(6, "0"),
    };
  }
  return null;
}

async function fetchJson(url, retries = 1, baseDelay = 400) {
  for (let i = 0; i <= retries; i++) {
    try {
      const r = await fetch(url, { headers: EM_HEADERS, cf: { cacheTtl: 0 } });
      if (!r.ok) {
        console.log("http fail", r.status, url.slice(0, 120));
      } else {
        const text = await r.text();
        try {
          return JSON.parse(text);
        } catch {
          console.log("parse fail", text.slice(0, 160));
        }
      }
    } catch (e) {
      console.log("fetch error", e.message);
    }
    if (i < retries) await sleep(baseDelay * (i + 1));
  }
  return null;
}

function num(v) {
  if (v == null || v === "-" || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function rowToPrice(row, item) {
  const latestPrice = num(row.f2);
  if (latestPrice == null) return null;

  const changePercent = num(row.f3);
  const changeAmount = num(row.f4);
  const prevClose = num(row.f18);

  const finalChangeAmount =
    changeAmount != null
      ? changeAmount
      : prevClose != null
      ? latestPrice - prevClose
      : 0;

  const finalChangePercent =
    changePercent != null
      ? Number(changePercent.toFixed(6))
      : prevClose
      ? Number((((latestPrice - prevClose) / prevClose) * 100).toFixed(6))
      : 0;

  return {
    name: row.f14 || item.code,
    latestPrice,
    changePercent: finalChangePercent,
    changeAmount: finalChangeAmount,
    source: "eastmoney",
    currency: item.currency,
    dailydata: null,
  };
}

function matchRowToItem(row, pureToOrig) {
  if (!row || row.f12 == null) return null;
  const raw = String(row.f12);
  return (
    pureToOrig[raw.padStart(6, "0")] ||
    pureToOrig[raw.padStart(5, "0")] ||
    pureToOrig[raw] ||
    pureToOrig[String(Number(raw))] ||
    null
  );
}

// ==============================
// 价格缓存（Worker Cache API）
// ==============================
function priceCacheKey(code) {
  const key = String(code).trim();
  return {
    key,
    request: new Request(`https://cache.internal/querylocal/price/${key}`, {
      method: "GET",
    }),
  };
}

async function readPriceCache(code) {
  try {
    const { request } = priceCacheKey(code);
    const hit = await caches.default.match(request);
    if (!hit) return { fresh: null, stale: null };
    const obj = await hit.json();
    if (!obj || obj.latestPrice == null) return { fresh: null, stale: null };
    const age = (Date.now() - (obj.cached_at || 0)) / 1000;
    if (age <= CACHE_FRESH_SECONDS) return { fresh: obj, stale: null };
    if (age <= CACHE_STALE_SECONDS) return { fresh: null, stale: obj };
    return { fresh: null, stale: null };
  } catch {
    return { fresh: null, stale: null };
  }
}

async function writePriceCache(code, price, ctx) {
  if (!price || price.latestPrice == null) return;
  try {
    const { request } = priceCacheKey(code);
    const body = JSON.stringify({ ...price, cached_at: Date.now() });
    const resp = new Response(body, {
      headers: {
        "Content-Type": "application/json",
        "Cache-Control": `max-age=${CACHE_STALE_SECONDS}`,
      },
    });
    if (ctx && ctx.waitUntil) ctx.waitUntil(caches.default.put(request, resp.clone()));
    else await caches.default.put(request, resp.clone());
  } catch (e) {
    console.log("writePriceCache fail", e.message);
  }
}

// ==============================
// ulist 单批（不拆、不并发）
// ==============================
function pickPushHost() {
  // 轻微轮换，降低单 host 被盯死的概率（不保证）
  const n = 1 + Math.floor(Math.random() * 10);
  return `https://${n}.push2.eastmoney.com`;
}

async function fetchOneUlistBatch(batch) {
  if (!batch.length) return {};

  const secids = batch.map((x) => x.secid).join(",");
  const host = pickPushHost();
  const url = new URL(`${host}/api/qt/ulist.np/get`);
  url.searchParams.set("fltt", "2");
  url.searchParams.set("secids", secids);
  url.searchParams.set("fields", "f2,f3,f4,f12,f14,f18");
  url.searchParams.set("_", String(Date.now()));

  const data = await fetchJson(url.toString(), 1, 500);
  const diff = data?.data?.diff;

  const pureToOrig = {};
  for (const item of batch) {
    pureToOrig[item.pureCode] = item;
    pureToOrig[String(Number(item.pureCode))] = item;
  }

  const out = {};
  const rows = Array.isArray(diff)
    ? diff
    : diff && typeof diff === "object"
    ? Object.values(diff)
    : [];

  for (const row of rows) {
    const item = matchRowToItem(row, pureToOrig);
    if (!item) continue;
    const price = rowToPrice(row, item);
    if (price) out[item.code] = price;
  }
  return out;
}

async function fetchPriceWithEastmoney(code) {
  const info = convertCode(code);
  if (!info) return null;
  const map = await fetchOneUlistBatch([info]);
  return map[code] || map[info.orig] || null;
}

/**
 * 批量价格（抗限流核心）
 *  - 先读缓存
 *  - 仅对缺失代码串行 ulist 分批
 *  - 空批：长退避后同批只重试 1 次，然后放弃（不拆、不单只）
 */
async function fetchPriceBatchUlist(codes, ctx) {
  if (!codes.length) return {};

  const results = {};
  const needFetch = [];

  // 1) 缓存优先
  await Promise.all(
    codes.map(async (code) => {
      const info = convertCode(code);
      if (!info) return;
      const { fresh, stale } = await readPriceCache(code);
      if (fresh) {
        const { cached_at, ...rest } = fresh;
        results[code] = rest;
      } else {
        if (stale) {
          // 先占位，后面若拉到新数据会覆盖
          results[code] = { ...stale, _stale: true };
        }
        needFetch.push({ code, ...info });
      }
    })
  );

  if (!needFetch.length) {
    // 去掉内部标记
    for (const k of Object.keys(results)) {
      if (results[k]._stale) {
        const { _stale, cached_at, ...rest } = results[k];
        results[k] = rest;
      }
    }
    return results;
  }

  // 2) 串行分批
  const batches = [];
  for (let i = 0; i < needFetch.length; i += ULIST_BATCH_SIZE) {
    batches.push(needFetch.slice(i, i + ULIST_BATCH_SIZE));
  }

  for (let bi = 0; bi < batches.length; bi++) {
    if (bi > 0) await sleep(jitter(ULIST_BATCH_DELAY_MS));

    const batch = batches[bi];
    let gotMap = await fetchOneUlistBatch(batch);
    let got = Object.keys(gotMap).length;

    if (got === 0) {
      console.log(
        `ulist batch ${bi + 1}/${batches.length} empty, backoff ${ULIST_EMPTY_BACKOFF_MS}ms`
      );
      await sleep(jitter(ULIST_EMPTY_BACKOFF_MS));
      gotMap = await fetchOneUlistBatch(batch);
      got = Object.keys(gotMap).length;
    }

    for (const [code, price] of Object.entries(gotMap)) {
      results[code] = price;
      await writePriceCache(code, price, ctx);
    }

    console.log(
      `ulist price batch ${bi + 1}/${batches.length} req=${batch.length} got=${got}`
    );

    // 若连续空批，额外多歇一会，避免整段被封
    if (got === 0) {
      await sleep(jitter(ULIST_EMPTY_BACKOFF_MS));
    }
  }

  // 3) 清理 stale 标记：有新数据用新的，没有则保留 stale（有总比没有强）
  for (const k of Object.keys(results)) {
    if (results[k] && results[k]._stale) {
      const { _stale, cached_at, ...rest } = results[k];
      results[k] = rest;
    }
  }

  return results;
}

// ==============================
// 分时（串行，低速）
// ==============================
async function getEastmoneyIntraday(code) {
  const info = convertCode(code);
  if (!info) return null;

  try {
    const url = `https://push2his.eastmoney.com/api/qt/stock/trends2/get?secid=${info.secid}&fields1=f1,f2,f3,f4,f5,f6,f7,f8&fields2=f51,f52,f53,f54,f55,f56,f57,f58&ut=fa5fd1943c7b386f172d6893dbfba10b&ndays=1`;
    const data = await fetchJson(url);
    const trends = data?.data?.trends;
    if (!trends || !trends.length) return null;

    let cumulativeAmount = 0;
    let cumulativeVolume = 0;
    const result = [];

    for (const item of trends) {
      const parts = item.split(",");
      const dt = parts[0];
      const price = parseFloat(parts[2]);
      const volume = parseFloat(parts[5]) || 0;
      const amount = parseFloat(parts[6]) || 0;

      cumulativeAmount += amount;
      cumulativeVolume += volume > 0 ? volume : 0;

      const avgPrice = cumulativeVolume
        ? Number((cumulativeAmount / cumulativeVolume).toFixed(6))
        : price;

      const [dateStr, timeStrRaw] = dt.split(" ");
      const timeStr =
        timeStrRaw && timeStrRaw.length === 8
          ? timeStrRaw
          : (timeStrRaw || "00:00") + ":00";

      result.push({
        date: dateStr,
        time: timeStr,
        price,
        avg_price: avgPrice,
        volume: Number(volume),
      });
    }
    return result.length ? result : null;
  } catch (e) {
    console.log("intraday error:", e.message || e);
    return null;
  }
}

async function fetchIntradayBatch(codes) {
  const results = {};
  for (let i = 0; i < codes.length; i++) {
    if (i > 0) await sleep(jitter(INTRADAY_DELAY_MS));
    const data = await getEastmoneyIntraday(codes[i]);
    if (data) results[codes[i]] = data;
  }
  return results;
}

// ==============================
// 路由
// ==============================
async function handleSingle(url, ctx) {
  const code = url.searchParams.get("code");
  const type = url.searchParams.get("type");

  if (!code || !type) return json({ detail: "Missing code or type" }, 400);
  if (!convertCode(code)) {
    return json({ detail: `Unsupported code format: ${code}` }, 400);
  }

  try {
    if (type === "price") {
      const { fresh, stale } = await readPriceCache(code);
      if (fresh) {
        const { cached_at, ...rest } = fresh;
        return json(rest);
      }
      const result = await fetchPriceWithEastmoney(code);
      if (result) {
        await writePriceCache(code, result, ctx);
        return json(result);
      }
      if (stale) {
        const { cached_at, ...rest } = stale;
        return json(rest);
      }
      return json({ detail: `Price data not found for ${code}` }, 404);
    }
    if (type === "intraday") {
      const result = await getEastmoneyIntraday(code);
      return result
        ? json(result)
        : json({ detail: `Intraday data not found for ${code}` }, 404);
    }
    if (type === "info" || type === "movingaveragedata") {
      return json(
        { detail: `${type} not supported in Cloudflare Workers` },
        501
      );
    }
    return json(
      {
        detail:
          "Invalid 'type' parameter. Use 'price', 'info', 'movingaveragedata', or 'intraday'.",
      },
      400
    );
  } catch (err) {
    return json({ detail: err.message || String(err) }, 500);
  }
}

async function handleBatch(request, ctx) {
  let body;
  try {
    body = await request.json();
  } catch {
    return json({ detail: "Missing JSON body" }, 400);
  }

  const codes = body.codes || [];
  const type = body.type;

  if (!codes.length || !type) {
    return json({ detail: "Missing codes or type" }, 400);
  }
  if (codes.length > 50) {
    return json({ detail: "Too many codes, max 50" }, 400);
  }

  const validCodes = codes.filter((c) => convertCode(c));
  if (!validCodes.length) return json({ detail: "No valid codes" }, 400);

  try {
    if (type === "price") {
      return json(await fetchPriceBatchUlist(validCodes, ctx));
    }
    if (type === "intraday") {
      return json(await fetchIntradayBatch(validCodes));
    }
    return json(
      { detail: "Batch only supports 'price' or 'intraday'" },
      400
    );
  } catch (err) {
    return json({ detail: err.message || String(err) }, 500);
  }
}

export default {
  async fetch(request, env, ctx) {
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: CORS });
    }

    const url = new URL(request.url);
    const path = url.pathname.replace(/\/$/, "") || "/";

    try {
      if (path === "/health") {
        return json({
          status: "healthy",
          service: "eastmoney_querylocal_worker",
          timestamp: new Date().toISOString(),
          source: "eastmoney",
          price_batch: "ulist.np serial + cache + backoff",
          batch_size: ULIST_BATCH_SIZE,
          batch_delay_ms: ULIST_BATCH_DELAY_MS,
          cache_fresh_s: CACHE_FRESH_SECONDS,
        });
      }

      if (
        (path === "/querylocal" || path === "/api/querylocal") &&
        request.method === "GET"
      ) {
        return handleSingle(url, ctx);
      }

      if (
        (path === "/querylocal" || path === "/api/querylocal") &&
        request.method === "POST"
      ) {
        return handleBatch(request, ctx);
      }

      return json({ detail: "not found", path }, 404);
    } catch (e) {
      return json({ detail: e.message || String(e) }, 500);
    }
  },
};
