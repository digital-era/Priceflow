// ============================================================
// worker.js (Cloudflare Worker)
// 腾讯行情 API 代理 —— 兼容原 QMT / MCP 接口契约
// 数据源：qt.gtimg.cn（实时行情）、web.ifzq.gtimg.cn（分钟分时）
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

  // ✅ 方案 B：严格对齐原 MCP 行为 —— 任何非 price/intraday 一律 501
  if (type !== "price" && type !== "intraday") {
    return errorResponse(`${type} not supported in this Tencent-backed version`, 501);
  }

  // 缓存查找（GET 原生支持）
  const cacheKey = new Request(url.toString(), { method: "GET" });
  const cache = caches.default;
  const cachedResponse = await cache.match(cacheKey);
  if (cachedResponse) return cachedResponse;

  let resultData;

  if (type === "price") {
    const results = await fetchPriceBatch([{ orig: code, tencent: tencentCode }], env);
    resultData = results[code];
    if (!resultData) return errorResponse(`Price data not found for ${code}`, 404);
  } else {
    // ✅ 传入 date 仅作提示；腾讯免费接口只提供最近交易日数据，
    //    日期不匹配时静默返回最新交易日数据（见 fetchIntradayBatch）
    const results = await fetchIntradayBatch(
      [{ orig: code, tencent: tencentCode }],
      date,
      env,
    );
    resultData = results[code];
    if (!resultData) return errorResponse(`Intraday data not found for ${code}`, 404);
  }

  // ✅ 问题 1 修复：TTL 按实际返回数据日期计算，而非请求 date
  const ttl = computeTTLByActualDate(type, resultData);
  const response = jsonResponse(resultData, 200, ttl);
  ctx.waitUntil(cache.put(cacheKey, response.clone()));
  return response;
}

// ============================================================
// POST 批量查询（≤50 只）
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

  // 虚拟 GET 缓存 Key（POST 无法直接使用 Cache API）
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
    // ✅ 同 GET：date 只作提示，腾讯静默返回最新交易日数据
    results = await fetchIntradayBatch(codesInfo, date, env);
  }

  // ✅ 问题 1 修复：批量结果的 TTL 也按实际返回日期计算
  const ttl = computeTTLByActualDate(type, results);
  const response = jsonResponse(results, 200, ttl);
  ctx.waitUntil(cache.put(cacheKey, response.clone()));
  return response;
}

// ============================================================
// ✅ 问题 1 修复：TTL 按实际返回数据日期计算
// - price: 固定 5 秒
// - intraday: 若实际数据日期 < 今天 → 1 天；否则 30 秒
// result 既支持单只（数组），也支持批量（对象 of 数组）
// ============================================================
function computeTTLByActualDate(type, result) {
  if (type === "price") return 5;

  // 提取实际返回的第一条分时数据，取其 date 字段
  let actualDateCompact = "";
  if (Array.isArray(result)) {
    // 单只：result 是分钟数组
    if (result.length > 0 && result[0] && result[0].date) {
      actualDateCompact = String(result[0].date).replace(/-/g, "");
    }
  } else if (result && typeof result === "object") {
    // 批量：result 是 { origCode: [分钟数组] }
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
// 实时行情：腾讯 qt.gtimg.cn
// ============================================================
async function fetchPriceBatch(codesInfo, env) {
  const tencentCodes = deduplicateTencent(codesInfo.map((c) => c.tencent));
  if (!tencentCodes.length) return {};

  const url = `https://qt.gtimg.cn/q=${tencentCodes.join(",")}`;
  const res = await fetchWithRetry(url, env);
  if (!res.ok) return {};

  // 腾讯返回 GBK 编码的纯文本
  const buffer = await res.arrayBuffer();
  const text = new TextDecoder("gbk").decode(buffer);

  const results = {};
  const mapping = {};
  for (const c of codesInfo) {
    if (!mapping[c.tencent]) mapping[c.tencent] = c.orig;
  }

  // 逐条解析 v_sh600519="...";
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

    // ✅ 精度修复（与原逻辑一致）
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
      dailydata: null, // ✅ 与原结构一致
    };
  }

  return results;
}

// ============================================================
// 分钟分时：腾讯 web.ifzq.gtimg.cn/appstock/app/minute/query
// ✅ 不因 targetDate !== today 提前返回空，直接请求腾讯接口，
//    返回其当前可提供的最新交易日数据。返回值 date 字段来自
//    腾讯实际返回的日期（node.data.date），客户端可据此判断。
// ============================================================
async function fetchIntradayBatch(codesInfo, tradeDate, env) {
  const results = {};

  // tradeDate 仅保留在签名中作提示，不再用于阻断请求。
  // 腾讯分钟分时接口只提供"当前交易日"数据，传入历史日期时静默返回最新交易日。
  // （保留参数以避免改动调用方签名）

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

      const dateRaw = node.data.date; // ✅ 腾讯实际返回的交易日 YYYYMMDD
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

        // ✅ 累计成交量差分 → 单分钟成交量
        const minuteVolume = Math.max(0, cumVolume - prevCumVolume);

        const safeCumAmount = isNaN(cumAmount) ? prevCumAmount : cumAmount;

        // ✅ 均价用累计额/累计量
        const avgPrice =
          cumVolume > 0
            ? Number((safeCumAmount / cumVolume).toFixed(6))
            : price;

        const hh = timeRaw.slice(0, 2);
        const mm = timeRaw.slice(2, 4);

        result.push({
          date: dateStr,          // ✅ 腾讯实际返回日期
          time: `${hh}:${mm}:00`,
          price,
          avg_price: avgPrice,
          volume: minuteVolume,   // ✅ 单位：手
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
// 腾讯代码转换：用户输入 → sh600519 / sz000001 / hk00700 / usAAPL
// ============================================================
function convertToTencentCode(code) {
  if (!code) return null;
  const text = String(code).trim().toUpperCase();

  // 已带腾讯前缀 + 数字，直接透传（统一小写）
  if (/^(SH|SZ|HK|BJ)\d+/.test(text)) {
    return text.toLowerCase();
  }

  // ✅ 问题 2 修复：美股前缀 usAAPL / USAAPL → usAAPL
  if (text.startsWith("US") && text.length > 2) {
    const rest = text.substring(2);
    if (/^[A-Z]{1,5}$/.test(rest)) return "us" + rest;
  }

  // QMT 后缀格式：600519.SH / 000001.SZ / 920982.BJ
  const qmtMatch = text.match(/^(\d{6})\.(SH|SZ|BJ)$/);
  if (qmtMatch) {
    return qmtMatch[2].toLowerCase() + qmtMatch[1];
  }

  // HK 前缀：HK00700 → hk00700
  if (text.startsWith("HK")) {
    const pure = text.substring(2);
    if (/^\d+$/.test(pure)) return "hk" + pure;
  }

  // 纯数字 6 位：A 股
  if (/^\d{6}$/.test(text)) {
    if (/^(60|68|90)/.test(text)) return "sh" + text;
    if (/^(00|30)/.test(text)) return "sz" + text;
    if (/^92/.test(text)) return "bj" + text;
    return null;
  }

  // 纯数字 5 位：港股（00700 → hk00700）
  if (/^\d{5}$/.test(text)) {
    return "hk" + text;
  }

  // 纯字母 1-5 位：美股（AAPL → usAAPL）
  if (/^[A-Z]{1,5}$/.test(text)) {
    return "us" + text;
  }

  return null;
}

// ============================================================
// 辅助函数
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
  return fmt.format(new Date()).replace(/-/g, ""); // YYYYMMDD
}

// ============================================================
// 带超时与指数退避重试的 fetch
// ============================================================
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
        return res; // 4xx 不重试
      }
      return res;
    } catch (e) {
      clearTimeout(timer);
      lastError = e;
      if (attempt < retries) {
        await sleep(Math.pow(2, attempt) * 500); // 500ms, 1s, 2s
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
