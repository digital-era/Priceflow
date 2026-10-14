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
      scale: 1000,
      orig: code,
    };
  }

  // 纯数字港股（4~5位）
  if (/^\d{4,5}$/.test(codeUpper)) {
    return {
      secid: `116.${codeUpper.padStart(5, "0")}`,
      currency: "HKD",
      scale: 1000,
      orig: code,
    };
  }

  // A股 / 北交所
  if (/^(60|68|51|56|58|55|900)/.test(codeUpper)) {
    return { secid: `1.${codeUpper}`, currency: "CNY", scale: 100, orig: code };
  }
  if (/^(00|30|15|200)/.test(codeUpper)) {
    return { secid: `0.${codeUpper}`, currency: "CNY", scale: 100, orig: code };
  }
  if (/^[48]/.test(codeUpper)) {
    // 北交所：东财通常用 0. 前缀（与深圳同一套）
    return { secid: `0.${codeUpper}`, currency: "CNY", scale: 100, orig: code };
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

// ==============================
// 东财实时价格（完全对齐原返回结构）
// ==============================
async function fetchPriceWithEastmoney(code) {
  const info = convertCode(code);
  if (!info) return null;

  try {
    const url = `https://push2.eastmoney.com/api/qt/stock/get?secid=${info.secid}&fields=f43,f58,f60&ut=fa5fd1943c7b386f172d6893dbfba10b`;
    const json = await fetchJson(url);
    const data = json?.data;
    if (!data) return null;

    const latestRaw = data.f43;
    const prevRaw = data.f60;
    if (latestRaw == null || prevRaw == null) return null;

    const latestPrice = latestRaw / info.scale;
    const prevClose = prevRaw / info.scale;
    const changeAmount = latestPrice - prevClose;
    const changePercent = prevClose
      ? Number(((changeAmount / prevClose) * 100).toFixed(6))
      : 0;

    return {
      name: data.f58 || code,
      latestPrice,
      changePercent,
      changeAmount,
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
// 批量并发（限制并发数，避免瞬时打爆）
// ==============================
const BATCH_CONCURRENCY = 8;

async function runWithConcurrency(items, concurrency, worker) {
  const queue = items.slice();
  const runners = Array.from(
    { length: Math.min(concurrency, queue.length) },
    async () => {
      while (queue.length) {
        const item = queue.shift();
        await worker(item);
      }
    }
  );
  await Promise.all(runners);
}

async function fetchPriceBatch(codes) {
  const results = {};
  await runWithConcurrency(codes, BATCH_CONCURRENCY, async (code) => {
    const data = await fetchPriceWithEastmoney(code);
    if (data) results[code] = data;
  });
  return results;
}

async function fetchIntradayBatch(codes) {
  const results = {};
  await runWithConcurrency(codes, BATCH_CONCURRENCY, async (code) => {
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

    // 保持原接口语义（Cloudflare 端不支持这些类型）
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
      return json(await fetchPriceBatch(validCodes));
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
    // 去掉末尾斜杠，兼容 /querylocal/ 与 /api/querylocal/
    const path = url.pathname.replace(/\/$/, "") || "/";

    try {
      if (path === "/health") {
        return json({
          status: "healthy",
          service: "eastmoney_querylocal_worker",
          timestamp: new Date().toISOString(),
          source: "eastmoney",
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
