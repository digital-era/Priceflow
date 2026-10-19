// ============================================================
// worker.js (Cloudflare Worker)
// 腾讯行情 API 代理 —— 兼容原 QMT / MCP 接口契约
// 数据源：qt.gtimg.cn（实时行情/基本面快照）
//         web.ifzq.gtimg.cn（分钟分时、历史K线）
// ============================================================

export default {
  async fetch(request, env, ctx) {
    // 1. CORS 预检
    if (request.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: {
          "Access-Control-Allow-Origin": request.headers.get("Origin") || "*",
          "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
          "Access-Control-Allow-Headers": "Content-Type",
        },
      });
    }

    const url = new URL(request.url);
    const path = url.pathname;

    // 2. 路由匹配（保留双路径兼容）
    if (path === "/querylocal" || path === "/api/querylocal") {
      try {
        if (request.method === "GET") {
          return await handleSingleQuery(request, env, ctx);
        } else if (request.method === "POST") {
          return await handleBatchQuery(request, env, ctx);
        } else {
          return errorResponse("Method Not Allowed", 405);
        }
      } catch (err) {
        console.error("Worker Error:", err);
        return errorResponse(err.message, 500);
      }
    }
    return errorResponse("Not found", 404);
  },
};

// ============================================================
// GET 单只查询
// ============================================================
async function handleSingleQuery(request, env, ctx) {
  const url = new URL(request.url);
  const code = url.searchParams.get("code");
  const type = url.searchParams.get("type");
  const date = url.searchParams.get("date");

  if (!code || !type) return errorResponse("Missing code or type", 400);

  const tencentCode = convertToTencentCode(code);
  if (!tencentCode) return errorResponse(`Unsupported code format: ${code}`, 400);

  // ✅ 扩展：info / movingaveragedata 纳入合法 type
  const SUPPORTED_TYPES = new Set(["price", "intraday", "info", "movingaveragedata"]);
  if (!SUPPORTED_TYPES.has(type)) {
    return errorResponse(`${type} not supported in this Tencent-backed version`, 501);
  }

  // 缓存查找（GET 原生支持）
  const cacheKey = new Request(url.toString(), { method: "GET" });
  const cache = caches.default;
  const cachedResponse = await cache.match(cacheKey);
  if (cachedResponse) return cachedResponse;

  let resultData;
  let ttl = 5;

  // ---------- 原有 price ----------
  if (type === "price") {
    const results = await fetchPriceBatch([{ orig: code, tencent: tencentCode }], env);
    resultData = results[code];
    if (!resultData) return errorResponse(`Price data not found for ${code}`, 404);
    ttl = computeTTLByActualDate(type, resultData);
  }

  // ---------- 原有 intraday ----------
  else if (type === "intraday") {
    const results = await fetchIntradayBatch(
      [{ orig: code, tencent: tencentCode }],
      date,
      env,
    );
    resultData = results[code];
    if (!resultData) return errorResponse(`Intraday data not found for ${code}`, 404);
    ttl = computeTTLByActualDate(type, resultData);
  }

  // ---------- 新增 info ----------
  else if (type === "info") {
    const fields = url.searchParams.get("fields"); // 可选：逗号分隔，缺省返回全部
    const info = await fetchInfoWithTencent(tencentCode, code, env, fields);
    if (!info) return errorResponse(`Info data not found for ${code}`, 404);
    resultData = info;
    ttl = 5; // ✅ 从 30 改为 5，与 price 对齐（因为含 latestPrice）
  }

  // ---------- 新增 movingaveragedata ----------
  else if (type === "movingaveragedata") {
    const period = (url.searchParams.get("period") || "day").toLowerCase();
    // ✅ 改动 1：默认复权类型 hfq → qfq
    const adjust = (url.searchParams.get("adjust") || "qfq").toLowerCase();
    const limit = parseInt(url.searchParams.get("limit") || "252", 10);
    const maParam = url.searchParams.get("ma") || "5,10,20,30,60,120,250";

    const maResult = await fetchMovingAverageData(
      tencentCode,
      code,
      { period, adjust, limit, maParam },
      env,
    );
    if (!maResult || maResult.rows.length === 0) {
      return errorResponse(`Moving average data not found for ${code}`, 404);
    }
    resultData = maResult;
    ttl = 30;
  }

  const response = jsonResponse(resultData, 200, ttl);
  ctx.waitUntil(cache.put(cacheKey, response.clone()));
  return response;
}

// ============================================================
// POST 批量查询（≤50 只）
// 批量仅支持 price / intraday（保持不变）
// ============================================================
async function handleBatchQuery(request, env, ctx) {
  const body = await request.json().catch(() => null);
  if (!body) return errorResponse("Missing JSON body", 400);

  const { codes, type, date } = body;
  if (!codes || !type || !Array.isArray(codes)) {
    return errorResponse("Missing codes array or type", 400);
  }
  if (codes.length > 50) return errorResponse("Too many codes, max 50", 400);
  if (type !== "price" && type !== "intraday") {
    return errorResponse("Batch only supports 'price' or 'intraday'", 400);
  }

  const codesInfo = [];
  for (const code of codes) {
    const tencent = convertToTencentCode(String(code));
    if (tencent) codesInfo.push({ orig: String(code), tencent });
  }
  if (codesInfo.length === 0) return errorResponse("No valid codes", 400);

  const sortedCodes = [...new Set(codesInfo.map((c) => c.orig))].sort().join(",");
  const fakeCacheUrl = new URL(request.url);
  fakeCacheUrl.searchParams.set("codes", sortedCodes);
  fakeCacheUrl.searchParams.set("type", type);
  if (date) fakeCacheUrl.searchParams.set("date", date);
  const cacheKey = new Request(fakeCacheUrl.toString(), { method: "GET" });
  const cache = caches.default;
  const cachedResponse = await cache.match(cacheKey);
  if (cachedResponse) return cachedResponse;

  let results = {};
  if (type === "price") {
    results = await fetchPriceBatch(codesInfo, env);
  } else {
    results = await fetchIntradayBatch(codesInfo, date, env);
  }

  const ttl = computeTTLByActualDate(type, results);
  const response = jsonResponse(results, 200, ttl);
  ctx.waitUntil(cache.put(cacheKey, response.clone()));
  return response;
}

// ============================================================
// TTL 按实际返回数据日期计算（保持不变）
// ============================================================
function computeTTLByActualDate(type, result) {
  if (type === "price") return 5;

  let actualDateCompact = "";
  if (Array.isArray(result)) {
    if (result.length > 0 && result[0] && result[0].date) {
      actualDateCompact = String(result[0].date).replace(/-/g, "");
    }
  } else if (result && typeof result === "object") {
    const firstKey = Object.keys(result)[0];
    if (firstKey) {
      const arr = result[firstKey];
      if (Array.isArray(arr) && arr.length > 0 && arr[0] && arr[0].date) {
        actualDateCompact = String(arr[0].date).replace(/-/g, "");
      }
    }
  }

  const today = getBeijingToday();
  if (actualDateCompact && actualDateCompact < today) return 86400;
  return 30;
}

// ============================================================
// 实时行情：腾讯 qt.gtimg.cn（保持不变）
// ============================================================
async function fetchPriceBatch(codesInfo, env) {
  const tencentCodes = deduplicateTencent(codesInfo.map((c) => c.tencent));
  if (!tencentCodes.length) return {};

  const url = `https://qt.gtimg.cn/q=${tencentCodes.join(",")}`;
  const res = await fetchWithRetry(url, env);
  if (!res.ok) return {};

  const buffer = await res.arrayBuffer();
  const text = new TextDecoder("gbk").decode(buffer);

  const results = {};
  const mapping = {};
  for (const c of codesInfo) {
    if (!mapping[c.tencent]) mapping[c.tencent] = c.orig;
  }

  const lines = text.split(";").filter((l) => l.trim());
  for (const line of lines) {
    const match = line.match(/v_(\w+)="([^"]+)"/);
    if (!match) continue;

    const tencentCode = match[1];
    const origCode = mapping[tencentCode];
    if (!origCode) continue;

    const fields = match[2].split("~");
    if (fields.length < 33) continue;

    const name = fields[1] || origCode;
    const latestRaw = parseFloat(fields[3]);
    const prevRaw = parseFloat(fields[4]);

    if (isNaN(latestRaw) || isNaN(prevRaw) || prevRaw === 0) continue;

    const latestPrice = latestRaw;
    const prevClose = prevRaw;
    const changeAmount = latestPrice - prevClose;

    const changePercent = prevClose
      ? Number(((changeAmount / prevClose) * 100).toFixed(6))
      : 0;

    const currency = tencentCode.startsWith("hk")
      ? "HKD"
      : tencentCode.startsWith("us")
        ? "USD"
        : "CNY";

    results[origCode] = {
      name,
      latestPrice,
      changePercent,
      changeAmount,
      source: "tencent",
      currency,
      dailydata: null,
    };
  }

  return results;
}

// ============================================================
// 分钟分时：腾讯 minute/query（保持不变）
// ============================================================
async function fetchIntradayBatch(codesInfo, tradeDate, env) {
  const results = {};

  for (const c of codesInfo) {
    const url =
      `https://web.ifzq.gtimg.cn/appstock/app/minute/query` +
      `?code=${c.tencent}`;

    try {
      const res = await fetchWithRetry(url, env);
      if (!res.ok) continue;

      const json = await res.json();
      const node = json?.data?.[c.tencent];
      if (!node || !node.data) continue;

      const dateRaw = node.data.date;
      if (!dateRaw || dateRaw.length !== 8) continue;

      const dateStr =
        `${dateRaw.slice(0, 4)}-${dateRaw.slice(4, 6)}-${dateRaw.slice(6, 8)}`;

      const rows = node.data.data;
      if (!Array.isArray(rows) || rows.length === 0) continue;

      let prevCumVolume = 0;
      let prevCumAmount = 0;
      const result = [];

      for (const line of rows) {
        const parts = line.trim().split(/\s+/);
        if (parts.length < 4) continue;

        const [timeRaw, priceStr, cumVolumeStr, cumAmountStr] = parts;
        const price = parseFloat(priceStr);
        const cumVolume = parseFloat(cumVolumeStr);
        const cumAmount = parseFloat(cumAmountStr);

        if (!timeRaw || timeRaw.length !== 4 || isNaN(price) || isNaN(cumVolume)) {
          continue;
        }

        const minuteVolume = Math.max(0, cumVolume - prevCumVolume);
        const safeCumAmount = isNaN(cumAmount) ? prevCumAmount : cumAmount;

        const avgPrice =
          cumVolume > 0
            ? Number((safeCumAmount / cumVolume).toFixed(6))
            : price;

        const hh = timeRaw.slice(0, 2);
        const mm = timeRaw.slice(2, 4);

        result.push({
          date: dateStr,
          time: `${hh}:${mm}:00`,
          price,
          avg_price: avgPrice,
          volume: minuteVolume,
        });

        prevCumVolume = cumVolume;
        prevCumAmount = safeCumAmount;
      }

      if (result.length > 0) results[c.orig] = result;
    } catch (e) {
      console.log(`Tencent intraday error for ${c.orig}:`, e);
    }
  }

  return results;
}

// ============================================================
// info：腾讯实时快照基本面字段（保持不变）
// ============================================================
// ============================================================
// info：price 的超集
// 前 7 个字段与 price 完全一致，后 8 个为基本面扩展
// ============================================================
async function fetchInfoWithTencent(tencentCode, origCode, env, fieldsParam) {
  const url = `https://qt.gtimg.cn/q=${tencentCode}`;
  const res = await fetchWithRetry(url, env);
  if (!res.ok) return null;

  const buffer = await res.arrayBuffer();
  const text = new TextDecoder("gbk").decode(buffer);

  const match = text.match(/v_\w+="([^"]+)"/);
  if (!match) return null;

  const f = match[1].split("~");
  // ✅ 放宽：只要够 33 个字段就能拿到 price 的基础信息
  //    A 股通常 ≥ 50，港股/美股可能更短，扩展字段会置 null
  if (f.length < 33) return null;

  const num = (v) => {
    const n = parseFloat(v);
    return Number.isFinite(n) ? n : null;
  };

  // ---------- 前 7 个字段：与 price 逐字一致 ----------
  const name = f[1] || origCode;
  const latestRaw = parseFloat(f[3]);
  const prevRaw = parseFloat(f[4]);

  if (isNaN(latestRaw) || isNaN(prevRaw) || prevRaw === 0) return null;

  const latestPrice = latestRaw;
  const prevClose = prevRaw;
  const changeAmount = latestPrice - prevClose;
  const changePercent = prevClose
    ? Number(((changeAmount / prevClose) * 100).toFixed(6))
    : 0;

  const currency = tencentCode.startsWith("hk")
    ? "HKD"
    : tencentCode.startsWith("us")
      ? "USD"
      : "CNY";

  const info = {
    name,
    latestPrice,
    changePercent,
    changeAmount,
    source: "tencent",   // ✅ 与 price 一致
    currency,
    dailydata: null,     // ✅ 与 price 一致
  };

  // ---------- 后 8 个字段：基本面扩展 ----------
  // A 股快照 ≥ 49，扩展字段有值；港股/美股可能不足，全部置 null
  if (f.length >= 49) {
    info.pe = num(f[39]);
    info.pb = num(f[46]);
    info.turnoverRate = num(f[38]);
    info.amplitude = num(f[43]);
    info.floatMarketCap = num(f[44]);
    info.totalMarketCap = num(f[45]);
    info.limitUp = num(f[47]);
    info.limitDown = num(f[48]);
  } else {
    info.pe = null;
    info.pb = null;
    info.turnoverRate = null;
    info.amplitude = null;
    info.floatMarketCap = null;
    info.totalMarketCap = null;
    info.limitUp = null;
    info.limitDown = null;
  }

  // ---------- fields 过滤（覆盖全部 15 个字段） ----------
  if (fieldsParam) {
    const wanted = fieldsParam.split(",").map((s) => s.trim()).filter(Boolean);
    const filtered = {
      source: "tencent",
      currency: currency,
    };
    // 按 info 的原始顺序填充，保证"前 7 后 8"的顺序
    for (const key of Object.keys(info)) {
      if (key === "source" || key === "currency") continue;
      if (wanted.includes(key)) filtered[key] = info[key];
    }
    return filtered;
  }

  return info;
}

// ============================================================
// movingaveragedata：腾讯 fqkline 历史 K 线 + 本地计算均线
// ============================================================
// ============================================================
// 修改：movingaveragedata -> 只返回原始 K 线，不计算均线
// ============================================================
async function fetchMovingAverageData(tencentCode, origCode, opts, env) {
  const { period, adjust, limit } = opts;

  const periodMap = { day: "day", week: "week", month: "month" };
  const p = periodMap[period] || "day";
  const adjustMap = { qfq: "qfq", hfq: "hfq", none: "" };
  const adj = adjustMap[adjust] !== undefined ? adjustMap[adjust] : "qfq";

  // 多拉取 60 天用于前端计算 MA60 等长周期指标
  const fetchCount = Math.min(640, limit + 60);

  const url =
    `https://web.ifzq.gtimg.cn/appstock/app/fqkline/get` +
    `?param=${tencentCode},${p},,,${fetchCount},${adj}`;

  let res;
  try {
    res = await fetchWithRetry(url, env);
  } catch (e) {
    return null;
  }
  if (!res.ok) return null;

  const json = await res.json();
  const node = json?.data?.[tencentCode];
  if (!node) return null;

  let rows = node[p] || node[`${adj}${p}`] || node[`qfq${p}`] || node[`hfq${p}`] || null;
  if (!rows || !Array.isArray(rows) || rows.length === 0) return null;

  const bars = [];
  for (const r of rows) {
    if (!Array.isArray(r) || r.length < 6) continue;
    const date = String(r[0] || "").slice(0, 10);
    const open = parseFloat(r[1]);
    const close = parseFloat(r[2]);
    const high = parseFloat(r[3]);
    const low = parseFloat(r[4]);
    const volume = parseFloat(r[5]);
    if (!date || isNaN(close)) continue;
    // 注意：腾讯的日K第7个字段有时候是成交额，但如果不稳定，前端可用 close*volume 估算，这里先存 null 或解析它。
    const amount = r[6] ? parseFloat(r[6]) : null; 
    
    bars.push({ date, open, close, high, low, volume: isNaN(volume) ? 0 : volume, amount });
  }

  if (bars.length === 0) return null;
  bars.sort((a, b) => a.date.localeCompare(b.date));

  // 直接返回基础 K 线，切片在最后
  return {
    code: origCode,
    period: p,
    adjust: adj || "none",
    rows: bars.slice(-limit), 
    source: "tencent_fqkline",
  };
}

// ============================================================
// 腾讯代码转换（保持不变）
// ============================================================
function convertToTencentCode(code) {
  if (!code) return null;
  const text = String(code).trim().toUpperCase();

  if (/^(SH|SZ|HK|BJ)\d+/.test(text)) {
    return text.toLowerCase();
  }

  if (text.startsWith("US") && text.length > 2) {
    const rest = text.substring(2);
    if (/^[A-Z]{1,5}$/.test(rest)) return "us" + rest;
  }

  const qmtMatch = text.match(/^(\d{6})\.(SH|SZ|BJ)$/);
  if (qmtMatch) {
    return qmtMatch[2].toLowerCase() + qmtMatch[1];
  }

  if (text.startsWith("HK")) {
    const pure = text.substring(2);
    if (/^\d+$/.test(pure)) return "hk" + pure;
  }

  if (/^\d{6}$/.test(text)) {
    if (/^(60|68|90)/.test(text)) return "sh" + text;
    if (/^(00|30)/.test(text)) return "sz" + text;
    if (/^92/.test(text)) return "bj" + text;
    return null;
  }

  if (/^\d{5}$/.test(text)) {
    return "hk" + text;
  }

  if (/^[A-Z]{1,5}$/.test(text)) {
    return "us" + text;
  }

  return null;
}

// ============================================================
// 辅助函数（保持不变）
// ============================================================
function deduplicateTencent(codes) {
  return [...new Set(codes.filter(Boolean))];
}

function getBeijingToday() {
  const fmt = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  return fmt.format(new Date()).replace(/-/g, "");
}

async function fetchWithRetry(url, env, retries = 3) {
  const timeoutMs = 8000;
  let lastError;

  for (let attempt = 0; attempt <= retries; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const res = await fetch(url, {
        signal: controller.signal,
        headers: {
          "User-Agent":
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
        },
      });
      clearTimeout(timer);
      if (!res.ok) {
        if (res.status >= 500) throw new Error(`HTTP ${res.status}`);
        return res;
      }
      return res;
    } catch (e) {
      clearTimeout(timer);
      lastError = e;
      if (attempt < retries) {
        await sleep(Math.pow(2, attempt) * 500);
      }
    }
  }
  throw lastError;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function jsonResponse(data, status = 200, ttl = 0) {
  const headers = {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "*",
  };
  if (ttl > 0) headers["Cache-Control"] = `public, max-age=${ttl}`;
  return new Response(JSON.stringify(data), { status, headers });
}

function errorResponse(detail, status = 400) {
  return jsonResponse({ detail }, status);
}
