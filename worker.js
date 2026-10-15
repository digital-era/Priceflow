/**
 * QueryLocal Worker — 东财实时行情 / 分时（对齐原 QMT querylocal 接口）
 *
 * GET  /querylocal?code=600519&type=price
 * GET  /querylocal?code=600519&type=intraday
 * GET  /api/querylocal?...（同上）
 * POST /querylocal  body: { "codes": ["600519","000001"], "type": "price"|"intraday" }
 * POST /api/querylocal  同上
 * GET  /health
 *
 * 返回格式与原 Flask 版完全一致，仅数据源改为东财。
 * price 批量：使用 ulist.np 真正批量接口（每批 15 只 + 延迟）
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

// 批量价格：ulist.np 每批数量与间隔（参考资金流 Worker 的稳定参数）
const ULIST_BATCH_SIZE = 15;
const ULIST_BATCH_DELAY_MS = 400;

// 分时批量并发（分时接口本身是单只，只能并发控制）
const INTRADAY_CONCURRENCY = 4;
const INTRADAY_DELAY_MS = 200;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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
// 代码转换（对齐原 convert_code，支持港股 / A股 / 北交所）
// ==============================
function convertCode(code) {
  const codeUpper = String(code || "").toUpperCase().trim();
  if (!codeUpper) return null;

  // 港股 HK 前缀
  if (codeUpper.startsWith("HK")) {
    const pure = codeUpper.slice(2).replace(/^0+/, "") || "0";
    return {
      secid: `116.${pure}`,
      currency: "HKD",
      orig: code,
      pureCode: pure.padStart(5, "0"),
    };
  }

  // 纯数字港股（4~5位）
  if (/^\d{4,5}$/.test(codeUpper)) {
    return {
      secid: `116.${codeUpper.padStart(5, "0")}`,
      currency: "HKD",
      orig: code,
      pureCode: codeUpper.padStart(5, "0"),
    };
  }

  // A股 / 北交所
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
    // 北交所
    return {
      secid: `0.${codeUpper}`,
      currency: "CNY",
      orig: code,
      pureCode: codeUpper.padStart(6, "0"),
    };
  }

  return null;
}

async function fetchJson(url, retries = 2, baseDelay = 300) {
  for (let i = 0; i <= retries; i++) {
    try {
      const r = await fetch(url, { headers: EM_HEADERS, cf: { cacheTtl: 0 } });
      if (!r.ok) {
        console.log("http fail", r.status, url);
      } else {
        const text = await r.text();
        try {
          return JSON.parse(text);
        } catch {
          console.log("parse fail", url, text.slice(0, 200));
        }
      }
    } catch (e) {
      console.log("fetch error", e.message, url);
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

// ==============================
// 东财实时价格（单只，兼容旧逻辑）
// ==============================
async function fetchPriceWithEastmoney(code) {
  const info = convertCode(code);
  if (!info) return null;

  try {
    // 优先用 ulist.np 单只（与批量同一套字段）
    const url = new URL("https://push2.eastmoney.com/api/qt/ulist.np/get");
    url.searchParams.set("fltt", "2");
    url.searchParams.set("secids", info.secid);
    url.searchParams.set("fields", "f2,f3,f4,f12,f14,f18");
    url.searchParams.set("_", String(Date.now()));

    const json = await fetchJson(url.toString());
    const diff = json?.data?.diff;
    const row = Array.isArray(diff) ? diff[0] : diff?.[info.secid];
    if (!row) return null;

    const latestPrice = num(row.f2);
    const changePercent = num(row.f3);
    const changeAmount = num(row.f4);
    const prevClose = num(row.f18);

    if (latestPrice == null) return null;

    // 若接口没给涨跌额，用昨收自行计算
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
      name: row.f14 || code,
      latestPrice,
      changePercent: finalChangePercent,
      changeAmount: finalChangeAmount,
      source: "eastmoney",
      currency: info.currency,
      dailydata: null,
    };
  } catch (e) {
    console.log("Eastmoney price error:", e.message || e);
    return null;
  }
}

// ==============================
// 东财实时价格（真正批量：ulist.np）
// ==============================
async function fetchPriceBatchUlist(codes) {
  if (!codes.length) return {};

  const results = {};
  const codeInfos = [];

  for (const code of codes) {
    const info = convertCode(code);
    if (info) codeInfos.push({ code, ...info });
  }
  if (!codeInfos.length) return {};

  // 分批
  const batches = [];
  for (let i = 0; i < codeInfos.length; i += ULIST_BATCH_SIZE) {
    batches.push(codeInfos.slice(i, i + ULIST_BATCH_SIZE));
  }

  for (let bi = 0; bi < batches.length; bi++) {
    if (bi > 0) await sleep(ULIST_BATCH_DELAY_MS);

    const batch = batches[bi];
    const secids = batch.map((x) => x.secid).join(",");

    const url = new URL("https://push2.eastmoney.com/api/qt/ulist.np/get");
    url.searchParams.set("fltt", "2");
    url.searchParams.set("secids", secids);
    url.searchParams.set("fields", "f2,f3,f4,f12,f14,f18");
    url.searchParams.set("_", String(Date.now()));

    const data = await fetchJson(url.toString());
    const diff = data?.data?.diff;

    // 建立 secid / pureCode → 原始 code 的映射，方便回填
    const secidToOrig = {};
    const pureToOrig = {};
    for (const item of batch) {
      secidToOrig[item.secid] = item;
      pureToOrig[item.pureCode] = item;
      // 港股 pure 可能是 5 位，也兼容不带前导零
      pureToOrig[String(Number(item.pureCode))] = item;
    }

    let got = 0;
    const rows = Array.isArray(diff)
      ? diff
      : diff && typeof diff === "object"
      ? Object.values(diff)
      : [];

    for (const row of rows) {
      if (!row || row.f12 == null) continue;

      const pure = String(row.f12).padStart(
        String(row.f12).length <= 5 ? 5 : 6,
        "0"
      );
      const item =
        pureToOrig[pure] ||
        pureToOrig[String(row.f12)] ||
        pureToOrig[String(Number(row.f12))];

      if (!item) continue;

      const latestPrice = num(row.f2);
      if (latestPrice == null) continue;

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

      results[item.code] = {
        name: row.f14 || item.code,
        latestPrice,
        changePercent: finalChangePercent,
        changeAmount: finalChangeAmount,
        source: "eastmoney",
        currency: item.currency,
        dailydata: null,
      };
      got++;
    }

    console.log(
      `ulist price batch ${bi + 1}/${batches.length} req=${batch.length} got=${got}`
    );
  }

  return results;
}

// ==============================
// 东财分时（完全对齐原返回结构）
// ==============================
async function getEastmoneyIntraday(code) {
  const info = convertCode(code);
  if (!info) return null;

  try {
    const url = `https://push2his.eastmoney.com/api/qt/stock/trends2/get?secid=${info.secid}&fields1=f1,f2,f3,f4,f5,f6,f7,f8&fields2=f51,f52,f53,f54,f55,f56,f57,f58&ut=fa5fd1943c7b386f172d6893dbfba10b&ndays=1`;
    const json = await fetchJson(url);
    const trends = json?.data?.trends;
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
    console.log("Eastmoney intraday error:", e.message || e);
    return null;
  }
}

// ==============================
// 分时批量（仍为单只接口，用并发 + 延迟控制）
// ==============================
async function runWithConcurrency(items, concurrency, worker) {
  const queue = items.slice();
  const runners = Array.from(
    { length: Math.min(concurrency, queue.length) },
    async () => {
      while (queue.length) {
        const item = queue.shift();
        await worker(item);
        if (INTRADAY_DELAY_MS > 0) await sleep(INTRADAY_DELAY_MS);
      }
    }
  );
  await Promise.all(runners);
}

async function fetchIntradayBatch(codes) {
  const results = {};
  await runWithConcurrency(codes, INTRADAY_CONCURRENCY, async (code) => {
    const data = await getEastmoneyIntraday(code);
    if (data) results[code] = data;
  });
  return results;
}

// ==============================
// 路由处理
// ==============================
async function handleSingle(url) {
  const code = url.searchParams.get("code");
  const type = url.searchParams.get("type");

  if (!code || !type) {
    return json({ detail: "Missing code or type" }, 400);
  }

  if (!convertCode(code)) {
    return json({ detail: `Unsupported code format: ${code}` }, 400);
  }

  try {
    if (type === "price") {
      const result = await fetchPriceWithEastmoney(code);
      return result
        ? json(result)
        : json({ detail: `Price data not found for ${code}` }, 404);
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

async function handleBatch(request) {
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
  if (!validCodes.length) {
    return json({ detail: "No valid codes" }, 400);
  }

  try {
    if (type === "price") {
      // ★ 真正批量：ulist.np
      return json(await fetchPriceBatchUlist(validCodes));
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
          price_batch: "ulist.np",
        });
      }

      // 单只 GET
      if (
        (path === "/querylocal" || path === "/api/querylocal") &&
        request.method === "GET"
      ) {
        return handleSingle(url);
      }

      // 批量 POST
      if (
        (path === "/querylocal" || path === "/api/querylocal") &&
        request.method === "POST"
      ) {
        return handleBatch(request);
      }

      return json({ detail: "not found", path }, 404);
    } catch (e) {
      return json({ detail: e.message || String(e) }, 500);
    }
  },
};
