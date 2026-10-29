// ============================================================
// worker.js (Cloudflare Worker)
// 腾讯行情 API 代理 —— 支持 A股/港股/美股/商品期货/全球指数
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

  // ---------- price ----------
  if (type === "price") {
    const results = await fetchPriceBatch([{ orig: code, tencent: tencentCode }], env);
    resultData = results[code];
    if (!resultData) return errorResponse(`Price data not found for ${code}`, 404);
    ttl = computeTTLByActualDate(type, resultData);
  }

  // ---------- intraday ----------
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

  // ---------- info ----------
  else if (type === "info") {
    const fields = url.searchParams.get("fields");
    const info = await fetchInfoWithTencent(tencentCode, code, env, fields);
    if (!info) return errorResponse(`Info data not found for ${code}`, 404);
    resultData = info;
    ttl = 5;
  }

  // ---------- movingaveragedata ----------
  else if (type === "movingaveragedata") {
    const period = (url.searchParams.get("period") || "day").toLowerCase();
    const adjust = (url.searchParams.get("adjust") || "qfq").toLowerCase();
    const limit = parseInt(url.searchParams.get("limit") || "252", 10);
    const maParam = url.searchParams.get("ma") || "5,10,20,30,60,120,250";

    const maResult = await fetchMovingAverageData(
      tencentCode,
      code,
      { period, adjust, limit, maParam },
      env,
    );
    if (!maResult || !Array.isArray(maResult.rows) || maResult.rows.length === 0) {
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
// 批量仅支持 price / intraday
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
// TTL 按实际返回数据日期计算
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
// 实时行情：腾讯 qt.gtimg.cn
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

    const currency = getCurrencyByCode(tencentCode);

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
// 分钟分时：腾讯 minute/query（A股/港股） / UsMinute/query（美股）
// ============================================================
async function fetchIntradayBatch(codesInfo, tradeDate, env) {
  const results = {};

  for (const c of codesInfo) {
    // 商品期货和外盘指数不支持分钟分时，直接跳过
    if (c.tencent.startsWith("hf_") || isGlobalIndex(c.tencent)) {
      continue;
    }

    // 美股使用专用的 UsMinute/query 接口
    const isUS = c.tencent.startsWith("us") && !isGlobalIndex(c.tencent);
    const apiPath = isUS ? "UsMinute" : "minute";
    const url =
      `https://web.ifzq.gtimg.cn/appstock/app/${apiPath}/query` +
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

      // 防御：美股分时接口有时只返回 1 个点，视为无效数据
      if (isUS && rows.length <= 1) {
        console.log(`US intraday insufficient data for ${c.orig}: ${rows.length} rows`);
        continue;
      }

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
// info：price 的超集
// 前 15 个字段与 price 一致，后 9 个为 Colab 合并字段
// 港股：pb=f[58]、turnoverRate=f[59]、股本=f[69]/f[70]
// 美股：沿用港股下标；无涨跌停/换手率，填 null
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
  if (f.length < 33) return null;

  const num = (v) => {
    const n = parseFloat(v);
    return Number.isFinite(n) ? n : null;
  };

  const isHK = tencentCode.startsWith("hk");
  const isUS = tencentCode.startsWith("us") && !isGlobalIndex(tencentCode);

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

  const currency = getCurrencyByCode(tencentCode);

  const info = {
    name,
    latestPrice,
    changePercent,
    changeAmount,
    source: "tencent",
    currency,
    dailydata: null,
  };

  let pe = null, pb = null, turnoverRate = null, amplitude = null;
  let floatMV = null, totalMV = null, limitUp = null, limitDown = null;

  if (isHK) {
    if (f.length >= 60) {
      pe = num(f[39]);
      pb = num(f[58]);
      turnoverRate = num(f[59]);
      amplitude = num(f[43]);
      floatMV = num(f[44]);
      totalMV = num(f[45]);
      limitUp = null;
      limitDown = null;
    }
  } else if (isUS) {
    if (f.length >= 60) {
      pe = num(f[39]);
      pb = num(f[58]);
      turnoverRate = null;
      amplitude = num(f[43]);
      floatMV = num(f[44]);
      totalMV = num(f[45]);
      limitUp = null;
      limitDown = null;
    }
  } else {
    if (f.length >= 49) {
      pe = num(f[39]);
      pb = num(f[46]);
      turnoverRate = num(f[38]);
      amplitude = num(f[43]);
      floatMV = num(f[44]);
      totalMV = num(f[45]);
      limitUp = num(f[47]);
      limitDown = num(f[48]);
    }
  }

  info.pe = pe;
  info.pb = pb;
  info.turnoverRate = turnoverRate;
  info.amplitude = amplitude;
  info.floatMarketCap = floatMV;
  info.totalMarketCap = totalMV;
  info.limitUp = limitUp;
  info.limitDown = limitDown;

  const roe = (pb != null && pe != null && pe !== 0)
    ? Number(((pb / pe) * 100).toFixed(2))
    : null;

  const dividendYield = null;
  const pg = null;
  const rg = null;
  const yc = null;
  const north = null;

  let totalShare = null;
  let floatShare = null;

  if (isHK && f.length >= 71) {
    const ts = num(f[69]);
    const fsRaw = num(f[70]);
    if (ts != null) totalShare = Number((ts / 1e8).toFixed(3));
    if (fsRaw != null) floatShare = Number((fsRaw / 1e8).toFixed(3));
  }
  if (totalShare == null && totalMV != null && latestPrice > 0) {
    totalShare = Number((totalMV / latestPrice).toFixed(3));
  }
  if (floatShare == null && floatMV != null && latestPrice > 0) {
    floatShare = Number((floatMV / latestPrice).toFixed(3));
  }

  const amountRaw = num(f[37]);
  let amount = null;
  if (amountRaw != null) {
    if (isHK || isUS) {
      amount = Number((amountRaw / 1e8).toFixed(2));
    } else {
      amount = Number((amountRaw / 1e4).toFixed(2));
    }
  }

  info.roe = roe;
  info.dividendYield = dividendYield;
  info.pg = pg;
  info.rg = rg;
  info.yc = yc;
  info.north = north;
  info.totalShare = totalShare;
  info.floatShare = floatShare;
  info.amount = amount;

  if (fieldsParam) {
    const wanted = fieldsParam.split(",").map((s) => s.trim()).filter(Boolean);
    const filtered = { source: "tencent", currency: currency };
    for (const key of Object.keys(info)) {
      if (key === "source" || key === "currency") continue;
      if (wanted.includes(key)) filtered[key] = info[key];
    }
    return filtered;
  }

  return info;
}

// ============================================================
// movingaveragedata：腾讯 fqkline 历史 K 线
// 美股需要补全交易所后缀（如 .OQ）
// ============================================================
async function fetchMovingAverageData(tencentCode, origCode, opts, env) {
  const { period, adjust, limit } = opts;

  const periodMap = { day: "day", week: "week", month: "month" };
  const p = periodMap[period] || "day";
  const adjustMap = { qfq: "qfq", hfq: "hfq", none: "" };
  const adj = adjustMap[adjust] !== undefined ? adjustMap[adjust] : "qfq";

  const isUS = tencentCode.startsWith("us") && !isGlobalIndex(tencentCode);

  // 美股 K线需要带交易所后缀，默认补 .OQ（纳斯达克），失败时尝试 .N（纽交所）
  let candidates = [tencentCode];
  if (isUS && !tencentCode.includes(".")) {
    candidates = [tencentCode + ".OQ", tencentCode + ".N"];
  }

  for (const candidate of candidates) {
    const fetchCount = Math.min(640, limit + 60);
    const url =
      `https://web.ifzq.gtimg.cn/appstock/app/fqkline/get` +
      `?param=${candidate},${p},,,${fetchCount},${adj}`;

    let res;
    try {
      res = await fetchWithRetry(url, env);
    } catch (e) {
      continue;
    }
    if (!res.ok) continue;

    const json = await res.json();
    const node = json?.data?.[candidate];
    if (!node) continue;

    let rows =
      node[p] ||
      node[`${adj}${p}`] ||
      node[`qfq${p}`] ||
      node[`hfq${p}`] ||
      null;

    if (!rows || !Array.isArray(rows) || rows.length === 0) continue;

    // 防御：美股 K线有时只返回首尾两根，视为数据不完整
    if (isUS && rows.length <= 2 && limit > 2) {
      console.log(`US kline insufficient for ${origCode} (${candidate}): ${rows.length} rows`);
      continue;
    }

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
      const amount = r[6] ? parseFloat(r[6]) : null;

      bars.push({ date, open, close, high, low, volume: isNaN(volume) ? 0 : volume, amount });
    }

    if (bars.length === 0) continue;
    bars.sort((a, b) => a.date.localeCompare(b.date));

    return {
      code: origCode,
      period: p,
      adjust: adj || "none",
      rows: bars.slice(-limit),
      source: "tencent_fqkline",
    };
  }

  return null;
}

// ============================================================
// 腾讯代码转换
// A股 / ETF / 可转债 / B股 / 北交所 / 港股 / 美股 / 商品期货 / 全球指数
// ============================================================
function convertToTencentCode(code) {
  if (!code) return null;
  const text = String(code).trim().toUpperCase();

  // 已带腾讯前缀直接透传
  if (/^(SH|SZ|HK|BJ)\d+/.test(text)) return text.toLowerCase();
  if (/^HF_[A-Z]{2}$/.test(text)) return text.toLowerCase();
  if (/^US(DJI|IXIC|INX|NDX)$/.test(text)) return text.toLowerCase();

  // 美股前缀 usAAPL / USAAPL
  if (text.startsWith("US") && text.length > 2) {
    const rest = text.substring(2);
    if (/^[A-Z]{1,5}$/.test(rest)) return "us" + rest;
  }

  // QMT 后缀：600519.SH / 000001.SZ / 920982.BJ
  const qmtMatch = text.match(/^(\d{6})\.(SH|SZ|BJ)$/);
  if (qmtMatch) {
    return qmtMatch[2].toLowerCase() + qmtMatch[1];
  }

  // HK 前缀：HK00700 -> hk00700
  if (text.startsWith("HK")) {
    const pure = text.substring(2);
    if (/^\d+$/.test(pure)) return "hk" + pure;
  }

  // 纯数字
  if (/^\d+$/.test(text)) {
    if (text.length === 5) return "hk" + text;

    if (text.length === 6) {
      // ✅ 修复后：移除 |000，000xxx 全部走深市；上证指数需显式 sh 前缀
      if (/^(60|68|50|51|52|55|56|58|11|900)/.test(text)) {
        return "sh" + text;
      }
      if (/^(00|30|15|16|18|12|200|399)/.test(text)) {
        return "sz" + text;
      }
      if (/^(92|83|87|88|43)/.test(text)) {
        return "bj" + text;
      }
      return null;
    }
    return null;
  }

  // 纯字母 1-5 位 -> 美股
  if (/^[A-Z]{1,5}$/.test(text)) {
    return "us" + text;
  }

  // 港股指数
  if (/^(HSI|HSCEI|HSCCI)$/.test(text)) {
    return "hk" + text;
  }

  return null;
}

// ============================================================
// 辅助函数
// ============================================================
function deduplicateTencent(codes) {
  return [...new Set(codes.filter(Boolean))];
}

function getCurrencyByCode(tencentCode) {
  if (tencentCode.startsWith("hk")) return "HKD";
  if (tencentCode.startsWith("us")) return "USD";
  if (tencentCode.startsWith("hf_")) return "USD";
  return "CNY";
}

function isGlobalIndex(tencentCode) {
  return /^us(DJI|IXIC|INX|NDX)$/.test(tencentCode) ||
         /^hk(HSI|HSCEI|HSCCI)$/.test(tencentCode);
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
