// ============================================================
// worker.js (Cloudflare Worker)
// 全资产轻量化行情代理 —— A股/港股/美股/大宗商品/美元外汇/主权债券
// 主通道：
//   - A股/港股：腾讯 qt.gtimg.cn + web.ifzq.gtimg.cn（原逻辑完全保留）
//   - 美股/大宗商品/美元外汇/美债指数：Yahoo Finance v8/finance/chart（免Key、含拆股复权）
//   - 美股基本面补充：Nasdaq summary API + 腾讯快照合并
//   - 全球主权债券实时/历史：CNBC restQuote + 东方财富 RPTA_WEB_TREASURYYIELD
//   - 兜底回退：腾讯 / 新浪（带 Referer）
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
// GET 单只查询（保持原有参数与输出结构不变）
// ============================================================
async function handleSingleQuery(request, env, ctx) {
  const url = new URL(request.url);
  const code = url.searchParams.get("code");
  const type = url.searchParams.get("type");
  const date = url.searchParams.get("date");

  if (!code || !type) return errorResponse("Missing code or type", 400);

  const asset = resolveAsset(code);
  if (!asset) return errorResponse(`Unsupported code format: ${code}`, 400);

  const SUPPORTED_TYPES = new Set(["price", "intraday", "info", "movingaveragedata"]);
  if (!SUPPORTED_TYPES.has(type)) {
    return errorResponse(`${type} not supported in this version`, 501);
  }

  // 缓存查找（GET 原生支持）
  const cacheKey = new Request(url.toString(), { method: "GET" });
  const cache = caches.default;
  const cachedResponse = await cache.match(cacheKey);
  if (cachedResponse) return cachedResponse;

  let resultData = null;
  let ttl = 5;

  // ---------- price ----------
  if (type === "price") {
    if (asset.kind === "tencent") {
      const results = await fetchPriceBatch([{ orig: code, tencent: asset.tencent }], env);
      resultData = results[code];
    } else {
      resultData = await fetchGlobalPrice(asset, env);
    }
    if (!resultData) return errorResponse(`Price data not found for ${code}`, 404);
    ttl = computeTTLByActualDate(type, resultData);
  }

  // ---------- intraday ----------
  else if (type === "intraday") {
    if (asset.kind === "tencent") {
      const results = await fetchIntradayBatch([{ orig: code, tencent: asset.tencent }], date, env);
      resultData = results[code];
    } else {
      resultData = await fetchGlobalIntraday(asset, date, env);
    }
    if (!resultData) return errorResponse(`Intraday data not found for ${code}`, 404);
    ttl = computeTTLByActualDate(type, resultData);
  }

  // ---------- info ----------
  else if (type === "info") {
    const fields = url.searchParams.get("fields");
    if (asset.kind === "tencent") {
      resultData = await fetchInfoWithTencent(asset.tencent, code, env, fields);
    } else {
      resultData = await fetchGlobalInfo(asset, env, fields);
    }
    if (!resultData) return errorResponse(`Info data not found for ${code}`, 404);
    ttl = 5;
  }

  // ---------- movingaveragedata ----------
  else if (type === "movingaveragedata") {
    const period = (url.searchParams.get("period") || "day").toLowerCase();
    const adjust = (url.searchParams.get("adjust") || "qfq").toLowerCase();
    const limit = parseInt(url.searchParams.get("limit") || "252", 10);
    const maParam = url.searchParams.get("ma") || "5,10,20,30,60,120,250";

    if (asset.kind === "tencent") {
      resultData = await fetchMovingAverageData(asset.tencent, code, { period, adjust, limit, maParam }, env);
    } else {
      resultData = await fetchGlobalMovingAverageData(asset, { period, adjust, limit, maParam }, env);
    }

    if (!resultData || !Array.isArray(resultData.rows) || resultData.rows.length === 0) {
      return errorResponse(`Moving average data not found for ${code}`, 404);
    }
    ttl = 30;
  }

  const response = jsonResponse(resultData, 200, ttl);
  ctx.waitUntil(cache.put(cacheKey, response.clone()));
  return response;
}

// ============================================================
// POST 批量查询（≤50 只，仅支持 price / intraday）
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

  const resolvedList = [];
  for (const raw of codes) {
    const orig = String(raw);
    const asset = resolveAsset(orig);
    if (asset) resolvedList.push(asset);
  }
  if (resolvedList.length === 0) return errorResponse("No valid codes", 400);

  const sortedCodes = [...new Set(resolvedList.map((a) => a.orig))].sort().join(",");
  const fakeCacheUrl = new URL(request.url);
  fakeCacheUrl.searchParams.set("codes", sortedCodes);
  fakeCacheUrl.searchParams.set("type", type);
  if (date) fakeCacheUrl.searchParams.set("date", date);
  const cacheKey = new Request(fakeCacheUrl.toString(), { method: "GET" });
  const cache = caches.default;
  const cachedResponse = await cache.match(cacheKey);
  if (cachedResponse) return cachedResponse;

  const tencentItems = resolvedList.filter((a) => a.kind === "tencent").map((a) => ({ orig: a.orig, tencent: a.tencent }));
  const globalItems = resolvedList.filter((a) => a.kind !== "tencent");

  let results = {};

  if (type === "price") {
    // 1) A股/港股继续走原腾讯批量通道
    const tencentPromise = tencentItems.length > 0 ? fetchPriceBatch(tencentItems, env) : Promise.resolve({});

    // 2) CNBC 债券/部分符号合并成 1 次批量请求，减少子请求数
    const cnbcBondItems = globalItems.filter((a) => a.kind === "bond" && a.cnbc);
    const cnbcBatchPromise = cnbcBondItems.length > 0
      ? fetchCnbcBatch(cnbcBondItems.map((a) => a.cnbc))
      : Promise.resolve({});

    const [tencentRes, cnbcMap] = await Promise.all([tencentPromise, cnbcBatchPromise]);
    Object.assign(results, tencentRes);

    // 3) 其余全球资产并发获取（债券优先命中上面批量 CNBC）
    if (globalItems.length > 0) {
      let emBondCache = null;
      const emBondLoader = () => {
        if (!emBondCache) emBondCache = fetchEastmoneyTreasuryRows(30);
        return emBondCache;
      };

      const settled = await Promise.allSettled(
        globalItems.map(async (asset) => {
          if (asset.kind === "bond" && asset.cnbc && cnbcMap[asset.cnbc]) {
            return { orig: asset.orig, data: cnbcMap[asset.cnbc] };
          }
          const data = await fetchGlobalPrice(asset, env, emBondLoader);
          return { orig: asset.orig, data };
        })
      );
      for (const s of settled) {
        if (s.status === "fulfilled" && s.value.data) {
          results[s.value.orig] = s.value.data;
        }
      }
    }
  } else {
    // intraday 批量
    const tencentPromise = tencentItems.length > 0 ? fetchIntradayBatch(tencentItems, date, env) : Promise.resolve({});
    const globalPromises = globalItems.map(async (asset) => {
      const data = await fetchGlobalIntraday(asset, date, env);
      return { orig: asset.orig, data };
    });

    const [tencentRes, ...globalSettled] = await Promise.all([tencentPromise, ...globalPromises.map((p) => p.catch(() => null))]);
    Object.assign(results, tencentRes);
    for (const item of globalSettled) {
      if (item && item.data) results[item.orig] = item.data;
    }
  }

  const ttl = computeTTLByActualDate(type, results);
  const response = jsonResponse(results, 200, ttl);
  ctx.waitUntil(cache.put(cacheKey, response.clone()));
  return response;
}

// ============================================================
// 资产代码解析器：精准分流 A股/港股 vs 美股/商品/美元外汇/主权债券
// ============================================================
function resolveAsset(rawCode) {
  if (!rawCode) return null;
  const orig = String(rawCode);
  let text = orig.trim().toUpperCase();
  if (text.includes(":") && !/^\d{6}\.(SH|SZ|BJ)$/.test(text)) {
    text = text.split(":").pop().trim();
  }

  // ---------- ⭐ 0.5 仅 HK50/HSI 走腾讯 hkHSI（防止被下方 HK\d+ 劫持成 hk50） ----------
  if (text === "HK50" || text === "HSI") {
    return { kind: "tencent", orig, tencent: "hkHSI" };
  }

  // ---------- ⭐ 0.6 CHINA50 / XIN9 不走腾讯，走 Yahoo 海外 2823.HK（安硕富时A50） ----------
  if (text === "CHINA50" || text === "XIN9") {
    return {
      kind: "us",
      isIndex: true,
      orig,
      displayName: text === "CHINA50" ? "富时中国A50 (2823.HK)" : "富时中国A50指数 (2823.HK)",
      yahoo: "2823.HK",
      cnbc: null,
      tencent: null, // 明确置空，绝不走腾讯
      nasdaq: null,
      currency: "HKD",
    };
  }

  // ---------- 1. 显式 A股 / 港股 / 北交所 ----------
  if (/^(SH|SZ|HK|BJ)\d+$/.test(text)) {
    return { kind: "tencent", orig, tencent: text.toLowerCase() };
  }
  const qmtMatch = text.match(/^(\d{6})\.(SH|SZ|BJ)$/);
  if (qmtMatch) {
    return { kind: "tencent", orig, tencent: qmtMatch[2].toLowerCase() + qmtMatch[1] };
  }
  if (text.startsWith("HK") && /^\d+$/.test(text.slice(2))) {
    return { kind: "tencent", orig, tencent: "hk" + text.slice(2) };
  }
  if (/^\d+$/.test(text)) {
    const tc = convertToTencentCode(text);
    return tc ? { kind: "tencent", orig, tencent: tc } : null;
  }
  if (/^(HSI|HSCEI|HSCCI)$/.test(text)) {
    return { kind: "tencent", orig, tencent: "hk" + text };
  }

  // ---------- 2. 美元指数与全球外汇（必须在美股 1-5 字母前判断，避免 DXY 被当美股） ----------
  const DXY_ALIASES = new Set(["DXY", "USDX", "DX-Y.NYB", "DINIW", "UDI", ".DXY", "DX=F"]);
  if (DXY_ALIASES.has(text)) {
    return {
      kind: "fx",
      orig,
      displayName: "美元指数",
      yahoo: text === "DX=F" ? "DX=F" : "DX-Y.NYB",
      cnbc: ".DXY",
      sina: "DINIW",
      currency: "USD",
    };
  }

  // 新浪外汇格式：fx_susdcny / fx_susdcnh / fx_seurusd
  if (text.startsWith("FX_S")) {
    const pair = text.slice(4); // e.g. USDCNY
    if (/^[A-Z]{6}$/.test(pair)) {
      return buildFxAsset(orig, pair.slice(0, 3), pair.slice(3), text.toLowerCase());
    }
  }
  // 标准外汇对：USDCNY, USDCNH, EURUSD, USDJPY, USDCNY=X, CNY=X, USD/CNY, USD-CNY
  if (text === "CNY=X") {
    return buildFxAsset(orig, "USD", "CNY", "fx_susdcny", "CNY=X");
  }
  if (text === "CNH=X") {
    return buildFxAsset(orig, "USD", "CNH", "fx_susdcnh", ["USDCNH=X", "CNH=X"]);
  }
  const fxClean = text.replace(/=X$/, "").replace(/[\/\-]/g, "");
  if (/^(USD|EUR|GBP|JPY|CHF|AUD|NZD|CAD|CNY|CNH|HKD|SGD|KRW|INR|TWD)(USD|EUR|GBP|JPY|CHF|AUD|NZD|CAD|CNY|CNH|HKD|SGD|KRW|INR|TWD)$/.test(fxClean)) {
    const base = fxClean.slice(0, 3);
    const quote = fxClean.slice(3, 6);
    return buildFxAsset(orig, base, quote);
  }

  // ---------- 3. 国际大宗商品（兼容 hf_* / Yahoo =F / 常见别名） ----------
  const COMMODITY_MAP = {
    // 黄金
    "HF_GC":  { yahoo: "GC=F", name: "COMEX黄金", sina: "hf_GC",  cnbc: "@GC.1" },
    "HF_XAU": { yahoo: "XAUUSD=X", name: "伦敦金", sina: "hf_XAU", cnbc: "XAU=" },
    "GC=F":   { yahoo: "GC=F", name: "COMEX黄金", sina: "hf_GC",  cnbc: "@GC.1" },
    "XAUUSD": { yahoo: "GC=F", name: "黄金(COMEX连续)", sina: "hf_GC", cnbc: "@GC.1" },
    "XAUUSD=X": { yahoo: "XAUUSD=X", name: "伦敦金", sina: "hf_XAU", cnbc: "XAU=" },
    "XAU":    { yahoo: "GC=F", name: "黄金", sina: "hf_XAU", cnbc: "XAU=" },
    "GOLD":   { yahoo: "GC=F", name: "COMEX黄金", sina: "hf_GC", cnbc: "@GC.1" },
    "COMEXGOLD": { yahoo: "GC=F", name: "COMEX黄金", sina: "hf_GC", cnbc: "@GC.1" },
    // 白银
    "HF_SI":  { yahoo: "SI=F", name: "COMEX白银", sina: "hf_SI",  cnbc: "@SI.1" },
    "HF_XAG": { yahoo: "XAGUSD=X", name: "伦敦银", sina: "hf_XAG", cnbc: "XAG=" },
    "SI=F":   { yahoo: "SI=F", name: "COMEX白银", sina: "hf_SI",  cnbc: "@SI.1" },
    "XAGUSD": { yahoo: "SI=F", name: "白银", sina: "hf_XAG", cnbc: "XAG=" },
    "XAGUSD=X": { yahoo: "XAGUSD=X", name: "伦敦银", sina: "hf_XAG", cnbc: "XAG=" },
    "XAG":    { yahoo: "SI=F", name: "白银", sina: "hf_XAG", cnbc: "XAG=" },
    "SILVER": { yahoo: "SI=F", name: "COMEX白银", sina: "hf_SI", cnbc: "@SI.1" },
    // 原油
    "HF_CL":  { yahoo: "CL=F", name: "WTI原油", sina: "hf_CL", cnbc: "@CL.1" },
    "CL=F":   { yahoo: "CL=F", name: "WTI原油", sina: "hf_CL", cnbc: "@CL.1" },
    "WTI":    { yahoo: "CL=F", name: "WTI原油", sina: "hf_CL", cnbc: "@CL.1" },
    "USOIL":  { yahoo: "CL=F", name: "WTI原油", sina: "hf_CL", cnbc: "@CL.1" },
    "CRUDE":  { yahoo: "CL=F", name: "WTI原油", sina: "hf_CL", cnbc: "@CL.1" },
    "HF_OIL": { yahoo: "BZ=F", name: "布伦特原油", sina: "hf_OIL", cnbc: "@LCO.1" },
    "BZ=F":   { yahoo: "BZ=F", name: "布伦特原油", sina: "hf_OIL", cnbc: "@LCO.1" },
    "BRENT":  { yahoo: "BZ=F", name: "布伦特原油", sina: "hf_OIL", cnbc: "@LCO.1" },
    "UKOIL":  { yahoo: "BZ=F", name: "布伦特原油", sina: "hf_OIL", cnbc: "@LCO.1" },
    // 铜 / 天然气 / 铂 / 钯 / 农产品
    "HF_HG":  { yahoo: "HG=F", name: "COMEX铜", sina: "hf_HG", cnbc: "@HG.1" },
    "HF_CAD": { yahoo: "HG=F", name: "伦敦铜/COMEX铜", sina: "hf_CAD", cnbc: "@HG.1" },
    "HG=F":   { yahoo: "HG=F", name: "COMEX铜", sina: "hf_HG", cnbc: "@HG.1" },
    "COPPER": { yahoo: "HG=F", name: "COMEX铜", sina: "hf_HG", cnbc: "@HG.1" },
    "HF_NG":  { yahoo: "NG=F", name: "天然气", sina: "hf_NG", cnbc: "@NG.1" },
    "NG=F":   { yahoo: "NG=F", name: "天然气", sina: "hf_NG", cnbc: "@NG.1" },
    "NATGAS": { yahoo: "NG=F", name: "天然气", sina: "hf_NG", cnbc: "@NG.1" },
    "HF_PL":  { yahoo: "PL=F", name: "铂金", sina: "hf_PL", cnbc: "@PL.1" },
    "PL=F":   { yahoo: "PL=F", name: "铂金", sina: "hf_PL", cnbc: "@PL.1" },
    "HF_PA":  { yahoo: "PA=F", name: "钯金", sina: "hf_PA", cnbc: "@PA.1" },
    "PA=F":   { yahoo: "PA=F", name: "钯金", sina: "hf_PA", cnbc: "@PA.1" },
    "HF_ZC":  { yahoo: "ZC=F", name: "CBOT玉米", sina: "hf_C", cnbc: "@C.1" },
    "ZC=F":   { yahoo: "ZC=F", name: "CBOT玉米", sina: "hf_C", cnbc: "@C.1" },
    "HF_ZW":  { yahoo: "ZW=F", name: "CBOT小麦", sina: "hf_W", cnbc: "@W.1" },
    "ZW=F":   { yahoo: "ZW=F", name: "CBOT小麦", sina: "hf_W", cnbc: "@W.1" },
    "HF_ZS":  { yahoo: "ZS=F", name: "CBOT大豆", sina: "hf_S", cnbc: "@S.1" },
    "ZS=F":   { yahoo: "ZS=F", name: "CBOT大豆", sina: "hf_S", cnbc: "@S.1" },
  };
  if (COMMODITY_MAP[text]) {
    const m = COMMODITY_MAP[text];
    return {
      kind: "commodity",
      orig,
      displayName: m.name,
      yahoo: m.yahoo,
      cnbc: m.cnbc,
      sina: m.sina,
      currency: "USD",
    };
  }
  // 任意标准期货代码（如 ZB=F, ZN=F, ZF=F, ZT=F, RB=F, HO=F, SB=F, KC=F）
  if (/^[A-Z0-9]{1,5}=F$/.test(text)) {
    return {
      kind: "commodity",
      orig,
      displayName: text,
      yahoo: text,
      currency: "USD",
    };
  }


  // ---------- 3.5 全球股指连续性合约 & 亚太欧交易所现货指数 ----------
  const GLOBAL_CONTINUOUS_AND_INDEX_MAP = {
    // 美股 24H 期指连续流（对应 CME/CBOT 主力连续合约）
    "NSXUSD":  { kind: "commodity", yahoo: "NQ=F",    cnbc: "@NQ.1",  sina: "hf_NQ",        name: "纳斯达克100连续" },
    "NQ1!":    { kind: "commodity", yahoo: "NQ=F",    cnbc: "@NQ.1",  sina: "hf_NQ",        name: "纳斯达克100连续" },
    "SPXUSD":  { kind: "commodity", yahoo: "ES=F",    cnbc: "@ES.1",  sina: "hf_ES",        name: "标普500连续" },
    "ES1!":    { kind: "commodity", yahoo: "ES=F",    cnbc: "@ES.1",  sina: "hf_ES",        name: "标普500连续" },
    "YMUSD":   { kind: "commodity", yahoo: "YM=F",    cnbc: "@YM.1",  sina: "hf_YM",        name: "道琼斯30连续" },
    "YM1!":    { kind: "commodity", yahoo: "YM=F",    cnbc: "@YM.1",  sina: "hf_YM",        name: "道琼斯30连续" },

    // 亚太/欧洲连续流
    "CHINA50": { kind: "commodity", yahoo: "XIN9.FGI",cnbc: null,     sina: "hf_CHA50CFD",  name: "富时中国A50连续", preferSina: true },
    "HK50":    { kind: "us",        yahoo: "^HSI",    cnbc: ".HSI",   tencent: "hkHSI",     name: "恒生指数连续", isIndex: true },
    "JP225":   { kind: "commodity", yahoo: "NKD=F",   cnbc: null,     sina: null,           name: "日经225连续" },
    "GER40":   { kind: "us",        yahoo: "^GDAXI",  cnbc: ".GDAXI", tencent: null,        name: "德国DAX40连续", isIndex: true },

    // 亚太/欧洲交易所现货（非连续）指数
    "XIN9":    { kind: "us",        yahoo: "XIN9.FGI",cnbc: null,     sina: "hf_CHA50CFD",  name: "富时中国A50指数", isIndex: true },
    "NKY":     { kind: "us",        yahoo: "^N225",   cnbc: ".N225",  tencent: null,        name: "日经225指数", isIndex: true },
    "N225":    { kind: "us",        yahoo: "^N225",   cnbc: ".N225",  tencent: null,        name: "日经225指数", isIndex: true },
    "^N225":   { kind: "us",        yahoo: "^N225",   cnbc: ".N225",  tencent: null,        name: "日经225指数", isIndex: true },
    "DAX":     { kind: "us",        yahoo: "^GDAXI",  cnbc: ".GDAXI", tencent: null,        name: "德国DAX40指数", isIndex: true },
    "GDAXI":   { kind: "us",        yahoo: "^GDAXI",  cnbc: ".GDAXI", tencent: null,        name: "德国DAX40指数", isIndex: true },
    "^GDAXI":  { kind: "us",        yahoo: "^GDAXI",  cnbc: ".GDAXI", tencent: null,        name: "德国DAX40指数", isIndex: true },
    "KOSPI":   { kind: "us",        yahoo: "^KS11",   cnbc: ".KS11",  tencent: null,        name: "韩国KOSPI综合指数", isIndex: true },
    "KS11":    { kind: "us",        yahoo: "^KS11",   cnbc: ".KS11",  tencent: null,        name: "韩国KOSPI综合指数", isIndex: true },
    "^KS11":   { kind: "us",        yahoo: "^KS11",   cnbc: ".KS11",  tencent: null,        name: "韩国KOSPI综合指数", isIndex: true },
    "NIFTY":   { kind: "us",        yahoo: "^NSEI",   cnbc: ".NSEI",  tencent: null,        name: "印度NIFTY50指数", isIndex: true },
    "NSEI":    { kind: "us",        yahoo: "^NSEI",   cnbc: ".NSEI",  tencent: null,        name: "印度NIFTY50指数", isIndex: true },
    "^NSEI":   { kind: "us",        yahoo: "^NSEI",   cnbc: ".NSEI",  tencent: null,        name: "印度NIFTY50指数", isIndex: true },
  };
  if (GLOBAL_CONTINUOUS_AND_INDEX_MAP[text]) {
    const g = GLOBAL_CONTINUOUS_AND_INDEX_MAP[text];
    return {
      kind: g.kind,
      isIndex: !!g.isIndex,
      orig,
      displayName: g.name,
      yahoo: g.yahoo || null,
      cnbc: g.cnbc || null,
      sina: g.sina || null,
      tencent: g.tencent || null,
      nasdaq: null,
      preferSina: !!g.preferSina,
      currency: "USD",
    };
  }

  // ---------- 4. 主权债券收益率（美国/中国/德/日/英/法/意/澳/加等） ----------
  const bondAsset = resolveBondAsset(orig, text);
  if (bondAsset) return bondAsset;

  // ---------- 5. 美股指数与美股个股 / ETF ----------
  const US_INDEX_MAP = {
    "USDJI": { yahoo: "^DJI", cnbc: ".DJI", tencent: "usDJI", name: "道琼斯指数" },
    "^DJI":  { yahoo: "^DJI", cnbc: ".DJI", tencent: "usDJI", name: "道琼斯指数" },
    "DJI":   { yahoo: "^DJI", cnbc: ".DJI", tencent: "usDJI", name: "道琼斯指数" },
    ".DJI":  { yahoo: "^DJI", cnbc: ".DJI", tencent: "usDJI", name: "道琼斯指数" },
    "USIXIC":{ yahoo: "^IXIC", cnbc: ".IXIC", tencent: "usIXIC", name: "纳斯达克综合指数" },
    "^IXIC": { yahoo: "^IXIC", cnbc: ".IXIC", tencent: "usIXIC", name: "纳斯达克综合指数" },
    "IXIC":  { yahoo: "^IXIC", cnbc: ".IXIC", tencent: "usIXIC", name: "纳斯达克综合指数" },
    ".IXIC": { yahoo: "^IXIC", cnbc: ".IXIC", tencent: "usIXIC", name: "纳斯达克综合指数" },
    "USINX": { yahoo: "^GSPC", cnbc: ".SPX", tencent: "usINX", name: "标普500指数" },
    ".INX": { yahoo: "^GSPC", cnbc: ".SPX", tencent: "usINX", name: "标普500指数" },
    "^GSPC": { yahoo: "^GSPC", cnbc: ".SPX", tencent: "usINX", name: "标普500指数" },
    "SPX":   { yahoo: "^GSPC", cnbc: ".SPX", tencent: "usINX", name: "标普500指数" },
    "GSPC":  { yahoo: "^GSPC", cnbc: ".SPX", tencent: "usINX", name: "标普500指数" },
    ".SPX":  { yahoo: "^GSPC", cnbc: ".SPX", tencent: "usINX", name: "标普500指数" },
    "USNDX": { yahoo: "^NDX", cnbc: ".NDX", tencent: "usNDX", name: "纳斯达克100指数" },
    "^NDX":  { yahoo: "^NDX", cnbc: ".NDX", tencent: "usNDX", name: "纳斯达克100指数" },
    "NDX":   { yahoo: "^NDX", cnbc: ".NDX", tencent: "usNDX", name: "纳斯达克100指数" },
    ".NDX":   { yahoo: "^NDX", cnbc: ".NDX", tencent: "usNDX", name: "纳斯达克100指数" },
    "^VIX":  { yahoo: "^VIX", cnbc: ".VIX", tencent: null, name: "VIX恐慌指数" },
    "VIX":   { yahoo: "^VIX", cnbc: ".VIX", tencent: null, name: "VIX恐慌指数" },
    ".NBI":  { yahoo: "^NBI", cnbc: ".NBI", tencent: null, name: "纳斯达克生物技术指数"},
    "^NBI":  { yahoo: "^NBI", cnbc: ".NBI", tencent: null, name: "纳斯达克生物技术指数"},
    "SOX":   { yahoo: "^SOX", cnbc: ".SOX", tencent: null, name: "费城半导体指数"},
    ".SOX":  { yahoo: "^SOX", cnbc: ".SOX", tencent: null, name: "费城半导体指数"},
    "RUT":   { yahoo: "^RUT", cnbc: ".RUT", tencent: null, name: "罗素2000指数"},
    ".RUT":  { yahoo: "^RUT", cnbc: ".RUT", tencent: null, name: "罗素2000指数"},
  };
  if (US_INDEX_MAP[text]) {
    const idx = US_INDEX_MAP[text];
    return {
      kind: "us",
      isIndex: true,
      orig,
      displayName: idx.name,
      yahoo: idx.yahoo,
      cnbc: idx.cnbc,
      tencent: idx.tencent,
      nasdaq: null,
      currency: "USD",
    };
  }

    // ⭐ 通用兜底 1：点前缀指数（.NBI / .SOX / .RUT / .DJI / .HSI / .FTSE ...）
  //   Yahoo 用 ^XXX，CNBC 用 .XXX —— 通用转换，无需每个都定义
  if (/^\.[A-Z]{1,5}$/.test(text)) {
    const sym = text.substring(1);              // .NBI → NBI
    return {
      kind: "us",
      isIndex: true,
      orig,
      displayName: sym,                          // 无中文名，显示原始代码
      yahoo: "^" + sym,                          // .NBI → ^NBI
      cnbc: text,                                // .NBI → .NBI
      tencent: null,
      nasdaq: null,
      currency: "USD",
    };
  }

  // ⭐ 通用兜底 2：Yahoo 风格 ^ 前缀指数（用户直接粘贴 ^NBI）
  if (/^\^[A-Z]{1,5}$/.test(text)) {
    const sym = text.substring(1);              // ^NBI → NBI
    return {
      kind: "us",
      isIndex: true,
      orig,
      displayName: sym,
      yahoo: text,                               // ^NBI
      cnbc: "." + sym,                           // ^NBI → .NBI（CNBC 兜底）
      tencent: null,
      nasdaq: null,
      currency: "USD",
    };
  }


  // 美股个股 / ETF：AAPL, usAAPL, BRK.A, BRK-B, usBRK.B
  let usSym = text;
  if (usSym.startsWith("US") && usSym.length > 2) {
    const rest = usSym.slice(2);
    if (/^[A-Z]{1,5}([\.\-][A-Z]{1,2})?$/.test(rest)) {
      usSym = rest;
    }
  }
  if (/^[A-Z]{1,5}([\.\-][A-Z]{1,2})?$/.test(usSym)) {
    const yahooSym = usSym.replace(/\./g, "-");    // Yahoo 用 BRK-B
    const tencentSym = "us" + usSym.replace(/-/g, "."); // 腾讯用 usBRK.B
    return {
      kind: "us",
      isIndex: false,
      orig,
      yahoo: yahooSym,
      cnbc: yahooSym,
      tencent: tencentSym,
      nasdaq: yahooSym.replace(/-/g, "."),
      currency: "USD",
    };
  }

  return null;
}

function buildFxAsset(orig, base, quote, sinaOverride = null, yahooOverride = null) {
  const pair = base + quote;
    // ⭐ 离岸人民币：优先标准 USDCNH=X，若该节点无数据自动切 CNH=X（纯 Yahoo）
  const yahoo = yahooOverride || (pair === "USDCNH" ? ["USDCNH=X", "CNH=X"] : `${pair}=X`);
  const currency = quote === "CNH" ? "CNY" : quote;
  const cnbcMap = {
    USDCNY: "CNY=",
    USDCNH: "CNH=",
    EURUSD: "EUR=",
    USDJPY: "JPY=",
    GBPUSD: "GBP=",
    USDHKD: "HKD=",
    AUDUSD: "AUD=",
    USDCAD: "CAD=",
    USDCHF: "CHF=",
  };
  return {
    kind: "fx",
    orig,
    displayName: `${base}/${quote}`,
    yahoo,
    cnbc: cnbcMap[pair] || null,
    sina: sinaOverride || `fx_s${pair.toLowerCase()}`,
    currency,
  };
}

function resolveBondAsset(orig, text) {
  const YAHOO_US_BOND = {
    "^IRX":  { yahoo: "^IRX",  cnbc: "US3M",  emField: null,          name: "美债3个月收益率" },
    "US3M":  { yahoo: "^IRX",  cnbc: "US3M",  emField: null,          name: "美债3个月收益率" },
    "US13W": { yahoo: "^IRX",  cnbc: "US3M",  emField: null,          name: "美债13周收益率" },
    "^FVX":  { yahoo: "^FVX",  cnbc: "US5Y",  emField: "EMG00001308", name: "美债5年收益率" },
    "US5Y":  { yahoo: "^FVX",  cnbc: "US5Y",  emField: "EMG00001308", name: "美债5年收益率" },
    "^TNX":  { yahoo: "^TNX",  cnbc: "US10Y", emField: "EMG00001310", name: "美债10年收益率" },
    "US10Y": { yahoo: "^TNX",  cnbc: "US10Y", emField: "EMG00001310", name: "美债10年收益率" },
    "^TYX":  { yahoo: "^TYX",  cnbc: "US30Y", emField: "EMG00001312", name: "美债30年收益率" },
    "US30Y": { yahoo: "^TYX",  cnbc: "US30Y", emField: "EMG00001312", name: "美债30年收益率" },
    "US2Y":  { yahoo: null,    cnbc: "US2Y",  emField: "EMG00001306", name: "美债2年收益率" },
    "US1M":  { yahoo: null,    cnbc: "US1M",  emField: null,          name: "美债1个月收益率" },
    "US6M":  { yahoo: null,    cnbc: "US6M",  emField: null,          name: "美债6个月收益率" },
    "US1Y":  { yahoo: null,    cnbc: "US1Y",  emField: null,          name: "美债1年收益率" },
    "US3Y":  { yahoo: null,    cnbc: "US3Y",  emField: null,          name: "美债3年收益率" },
    "US7Y":  { yahoo: null,    cnbc: "US7Y",  emField: null,          name: "美债7年收益率" },
    "US20Y": { yahoo: null,    cnbc: "US20Y", emField: null,          name: "美债20年收益率" },
  };
  if (YAHOO_US_BOND[text]) {
    const b = YAHOO_US_BOND[text];
    return { kind: "bond", orig, displayName: b.name, yahoo: b.yahoo, cnbc: b.cnbc, emField: b.emField, currency: "USD" };
  }

  const CN_BOND = {
    "CN2Y":  { cnbc: "CN2Y-CN",  emField: "EMM00588704", name: "中国2年期国债收益率" },
    "CN5Y":  { cnbc: "CN5Y-CN",  emField: "EMM00166462", name: "中国5年期国债收益率" },
    "CN10Y": { cnbc: "CN10Y-CN", emField: "EMM00166466", name: "中国10年期国债收益率" },
    "CN30Y": { cnbc: "CN30Y-CN", emField: "EMM00166469", name: "中国30年期国债收益率" },
    "CN1Y":  { cnbc: "CN1Y-CN",  emField: null,          name: "中国1年期国债收益率" },
    "CN3Y":  { cnbc: "CN3Y-CN",  emField: null,          name: "中国3年期国债收益率" },
    "CN7Y":  { cnbc: "CN7Y-CN",  emField: null,          name: "中国7年期国债收益率" },
  };
  if (CN_BOND[text]) {
    const b = CN_BOND[text];
    return { kind: "bond", orig, displayName: b.name, yahoo: null, cnbc: b.cnbc, emField: b.emField, currency: "CNY" };
  }

  // 其他主权债券：DE10Y, JP10Y, UK10Y, GB10Y, FR10Y, IT10Y, AU10Y, CA10Y, CN10Y-CN 等
  const cnbcExplicit = text.match(/^([A-Z]{2}\d{1,2}[YM])\-([A-Z]{2})$/);
  if (cnbcExplicit) {
    const country = cnbcExplicit[2];
    return { kind: "bond", orig, displayName: text, yahoo: null, cnbc: text, emField: null, currency: getBondCurrency(country) };
  }

  const globalBondMatch = text.match(/^(DE|JP|UK|GB|FR|IT|ES|AU|CA|CH|KR|IN|NZ)(\d{1,2}[YM])$/);
  if (globalBondMatch) {
    let country = globalBondMatch[1];
    const tenor = globalBondMatch[2];
    const cnbcPrefix = country === "GB" ? "UK" : country;
    const cnbcCountry = country === "UK" ? "GB" : country;
    return {
      kind: "bond",
      orig,
      displayName: `${country}${tenor}国债收益率`,
      yahoo: null,
      cnbc: `${cnbcPrefix}${tenor}-${cnbcCountry}`,
      emField: null,
      currency: getBondCurrency(cnbcCountry),
    };
  }

  return null;
}

function getBondCurrency(country) {
  const map = { CN: "CNY", US: "USD", JP: "JPY", GB: "GBP", UK: "GBP", DE: "EUR", FR: "EUR", IT: "EUR", ES: "EUR", AU: "AUD", CA: "CAD", CH: "CHF", KR: "KRW", IN: "INR", NZ: "NZD" };
  return map[country] || "USD";
}

// ============================================================
// 全球资产统一入口：price / intraday / info / movingaveragedata
// ============================================================
async function fetchGlobalPrice(asset, env, emBondLoader = null) {
  // 0) 标记 preferSina 的连续合约（如 CHINA50），优先取新浪 20H 实时期货报价
  if (asset.preferSina && asset.sina) {
    const sp = await fetchSinaPrice(asset);
    if (sp) return sp;
  }
  // 1) 优先 Yahoo Finance（美股/大宗商品/美元外汇/部分美债指数）
  if (asset.yahoo) {
    const yp = await fetchYahooPrice(asset);
    if (yp) return yp;
  }

  // 2) 主权债券 / Yahoo 失败时走 CNBC 实时报价
  if (asset.cnbc) {
    const cp = await fetchCnbcPrice(asset);
    if (cp) return cp;
  }

  // 3) 中国/美国国债走东方财富收益率数据中心兜底
  if (asset.emField) {
    const rows = emBondLoader ? await emBondLoader() : await fetchEastmoneyTreasuryRows(30);
    const ep = extractBondPriceFromEmRows(asset, rows);
    if (ep) return ep;
  }

  // 4) 新浪兜底（hf_GC / fx_susdcny / DINIW）
  if (asset.sina) {
    const sp = await fetchSinaPrice(asset);
    if (sp) return sp;
  }

  // 5) 最终回落到原腾讯接口（仅限有 tencent 映射的美股/指数）
  if (asset.tencent) {
    const res = await fetchPriceBatch([{ orig: asset.orig, tencent: asset.tencent }], env);
    if (res && res[asset.orig]) return res[asset.orig];
  }

  return null;
}

async function fetchGlobalIntraday(asset, tradeDate, env) {
  // 1) Yahoo 1m 分时（支持美股/ETF/指数/商品/FX/美债指数）
  if (asset.yahoo) {
    const yi = await fetchYahooIntraday(asset);
    if (yi && yi.length > 0) return yi;
  }

  // 2) 仅美股个股回落腾讯 UsMinute/query
  if (asset.kind === "us" && asset.tencent && !isGlobalIndex(asset.tencent)) {
    const res = await fetchIntradayBatch([{ orig: asset.orig, tencent: asset.tencent }], tradeDate, env);
    if (res && res[asset.orig]) return res[asset.orig];
  }

  return null;
}

async function fetchGlobalInfo(asset, env, fieldsParam) {
  // 并发获取多个轻量源并智能融合，不阻塞、不丢字段
  const tasks = [
    asset.yahoo ? fetchYahooChartRaw(asset.yahoo, "1d", "5d") : Promise.resolve(null),
    (asset.kind === "us" && asset.tencent) ? fetchInfoWithTencent(asset.tencent, asset.orig, env, null) : Promise.resolve(null),
    (asset.kind === "us" && !asset.isIndex && asset.nasdaq) ? fetchNasdaqSummary(asset.nasdaq) : Promise.resolve(null),
    (!asset.yahoo && asset.cnbc) ? fetchCnbcRaw(asset.cnbc) : Promise.resolve(null),
  ];

  const [yahooChart, tencentInfo, nasdaqData, cnbcQuote] = await Promise.all(
    tasks.map((p) => p.catch(() => null))
  );

  // 先构建基础行情字段（保证 name / latestPrice / changePercent / changeAmount / currency）
  let base = null;
  if (yahooChart) {
    base = parseYahooChartToPrice(asset, yahooChart);
  }
  if (!base && cnbcQuote) {
    base = parseCnbcQuoteToPrice(asset, cnbcQuote);
  }
  if (!base && asset.emField) {
    const emRows = await fetchEastmoneyTreasuryRows(30);
    base = extractBondPriceFromEmRows(asset, emRows);
  }
  if (!base && tencentInfo) {
    base = {
      name: tencentInfo.name,
      latestPrice: tencentInfo.latestPrice,
      changePercent: tencentInfo.changePercent,
      changeAmount: tencentInfo.changeAmount,
      source: tencentInfo.source,
      currency: tencentInfo.currency,
      dailydata: null,
    };
  }
  if (!base) {
    base = await fetchGlobalPrice(asset, env);
  }
  if (!base) return null;

  // 提取 Yahoo meta 里的振幅与成交额
  let yAmplitude = null;
  let yAmount = null;
  if (yahooChart && yahooChart.meta) {
    const m = yahooChart.meta;
    const high = numOrNull(m.regularMarketDayHigh);
    const low = numOrNull(m.regularMarketDayLow);
    if (high != null && low != null && base.latestPrice > 0) {
      const prev = base.latestPrice - base.changeAmount;
      const denom = prev > 0 ? prev : base.latestPrice;
      yAmplitude = Number((((high - low) / denom) * 100).toFixed(2));
    }
    const vol = numOrNull(m.regularMarketVolume);
    if (vol != null && vol > 0 && base.latestPrice > 0) {
      yAmount = Number(((vol * base.latestPrice) / 1e8).toFixed(2)); // 亿元/亿美元
    }
  } else if (cnbcQuote) {
    const high = parseNumLoose(cnbcQuote.high);
    const low = parseNumLoose(cnbcQuote.low);
    const prev = parseNumLoose(cnbcQuote.previous_day_closing);
    if (high != null && low != null && prev > 0) {
      yAmplitude = Number((((high - low) / prev) * 100).toFixed(2));
    }
  }

  // 合并基本面字段（保持与 fetchInfoWithTencent 完全一致的 24 个字段）
  const pe = nasdaqData?.pe ?? tencentInfo?.pe ?? null;
  const pb = tencentInfo?.pb ?? null;
  const totalMarketCap = nasdaqData?.marketCapYi ?? tencentInfo?.totalMarketCap ?? null;
  const floatMarketCap = tencentInfo?.floatMarketCap ?? totalMarketCap ?? null;
  const dividendYield = nasdaqData?.dividendYield ?? tencentInfo?.dividendYield ?? null;

  let roe = tencentInfo?.roe ?? null;
  if (roe == null && pb != null && pe != null && pe !== 0) {
    roe = Number(((pb / pe) * 100).toFixed(2));
  }

  let totalShare = tencentInfo?.totalShare ?? null;
  if (totalShare == null && totalMarketCap != null && base.latestPrice > 0) {
    totalShare = Number((totalMarketCap / base.latestPrice).toFixed(3));
  }
  let floatShare = tencentInfo?.floatShare ?? null;
  if (floatShare == null && floatMarketCap != null && base.latestPrice > 0) {
    floatShare = Number((floatMarketCap / base.latestPrice).toFixed(3));
  }

  const info = {
    name: tencentInfo?.name || base.name || asset.displayName || asset.orig,
    latestPrice: base.latestPrice,
    changePercent: base.changePercent,
    changeAmount: base.changeAmount,
    source: base.source,
    currency: base.currency || asset.currency,
    dailydata: null,
    pe,
    pb,
    turnoverRate: tencentInfo?.turnoverRate ?? null,
    amplitude: tencentInfo?.amplitude ?? yAmplitude,
    floatMarketCap,
    totalMarketCap,
    limitUp: null,
    limitDown: null,
    roe,
    dividendYield,
    pg: null,
    rg: null,
    yc: null,
    north: null,
    totalShare,
    floatShare,
    amount: tencentInfo?.amount ?? yAmount,
  };

  if (fieldsParam) {
    const wanted = fieldsParam.split(",").map((s) => s.trim()).filter(Boolean);
    const filtered = { source: info.source, currency: info.currency };
    for (const key of Object.keys(info)) {
      if (key === "source" || key === "currency") continue;
      if (wanted.includes(key)) filtered[key] = info[key];
    }
    return filtered;
  }

  return info;
}

async function fetchGlobalMovingAverageData(asset, opts, env) {
  const { period, adjust, limit } = opts;
  const p = ({ day: "day", week: "week", month: "month" })[period] || "day";
  const adj = ({ qfq: "qfq", hfq: "hfq", none: "" })[adjust] ?? "qfq";

  // 1) Yahoo Finance 历史 K 线（支持美股拆股复权、商品、外汇、美债指数）
  if (asset.yahoo) {
    const yk = await fetchYahooKline(asset, p, limit, adj);
    if (yk && yk.rows && yk.rows.length > 0) return yk;
  }

  // 2) 中美国债收益率走东方财富历史接口（支持 day / week / month 聚合）
  if (asset.emField) {
    const ek = await fetchEastmoneyBondKline(asset, p, limit);
    if (ek && ek.rows && ek.rows.length > 0) return ek;
  }

  // 3) 仅美股最终回落腾讯 fqkline（额外补充 .AM 支持 ETF）
  if (asset.kind === "us" && asset.tencent) {
    const tk = await fetchMovingAverageData(asset.tencent, asset.orig, opts, env);
    if (tk && tk.rows && tk.rows.length > 0) return tk;
  }

  return null;
}

// ============================================================
// Yahoo Finance v8/finance/chart 实现（query1 / query2 双端点容灾）
// ============================================================
async function fetchYahooChartRaw(yahooSymbol, interval = "1d", range = "5d") {
  const symbols = Array.isArray(yahooSymbol) ? yahooSymbol : [yahooSymbol];
  const hosts = ["query1.finance.yahoo.com", "query2.finance.yahoo.com"];

  for (const sym of symbols) {
    if (!sym) continue;
    const encoded = encodeURIComponent(sym);
    const path = `/v8/finance/chart/${encoded}?interval=${interval}&range=${range}&includePrePost=false`;

    for (let i = 0; i < hosts.length; i++) {
      const url = `https://${hosts[i]}${path}`;
      try {
        const res = await fetchExternal(url, {
          headers: {
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36",
            "Accept": "application/json",
          },
        }, 6500);
        if (!res.ok) continue;
        const json = await res.json();
        const result = json?.chart?.result?.[0];
        const hasPrice = result?.meta && numOrNull(result.meta.regularMarketPrice) != null;
        const hasBars = Array.isArray(result?.timestamp) && result.timestamp.length > 0;
        if (result && result.meta && (hasPrice || hasBars)) {
          return result;
        }
      } catch (e) {}
    }
  }
  return null;
}

function parseYahooChartToPrice(asset, result) {
  const meta = result.meta || {};
  const q = result.indicators?.quote?.[0] || {};
  const timestamps = result.timestamp || [];
  const closes = q.close || [];

  // 取最新有效价格
  let latestPrice = numOrNull(meta.regularMarketPrice);
  const validBars = [];
  for (let i = 0; i < timestamps.length; i++) {
    const c = numOrNull(closes[i]);
    if (c != null) validBars.push({ ts: timestamps[i], close: c });
  }
  if (latestPrice == null && validBars.length > 0) {
    latestPrice = validBars[validBars.length - 1].close;
  }
  if (latestPrice == null) return null;

  // 准确计算昨收：优先 meta.previousClose，其次按交易所日期取前一交易日收盘
  let prevClose = numOrNull(meta.previousClose);
  if (prevClose == null && validBars.length >= 2) {
    const tz = meta.exchangeTimezoneName || "America/New_York";
    const lastBarDate = formatTsInTz(validBars[validBars.length - 1].ts, tz).date;
    const marketTs = numOrNull(meta.regularMarketTime) || validBars[validBars.length - 1].ts;
    const marketDate = formatTsInTz(marketTs, tz).date;

    prevClose = (lastBarDate === marketDate)
      ? validBars[validBars.length - 2].close
      : validBars[validBars.length - 1].close;
  }
  if (prevClose == null) {
    prevClose = numOrNull(meta.chartPreviousClose) ?? latestPrice;
  }

  const changeAmount = Number((latestPrice - prevClose).toFixed(6));
  const changePercent = prevClose ? Number(((changeAmount / prevClose) * 100).toFixed(6)) : 0;

  return {
    name: asset.displayName || meta.shortName || meta.longName || asset.orig,
    latestPrice: Number(latestPrice),
    changePercent,
    changeAmount,
    source: "yahoo",
    currency: meta.currency || asset.currency || "USD",
    dailydata: null,
  };
}

async function fetchYahooPrice(asset) {
  const raw = await fetchYahooChartRaw(asset.yahoo, "1d", "5d");
  if (!raw) return null;
  return parseYahooChartToPrice(asset, raw);
}

function getNyFxSessionKey(ts) {
  const { date, time } = formatTsInTz(ts, "America/New_York");
  if (time >= "17:00:00") {
    const d = new Date(`${date}T00:00:00Z`);
    d.setUTCDate(d.getUTCDate() + 1);
    return d.toISOString().slice(0, 10);
  }
  return date;
}

async function fetchYahooIntraday(asset) {
  const isFuturesSession = asset.kind === "commodity" || asset.orig === "DXY" || asset.yahoo === "DX-Y.NYB";
  const isFxSession = asset.kind === "fx" && !isFuturesSession;
  const range = (isFuturesSession || isFxSession) ? "2d" : "1d";

  const raw = await fetchYahooChartRaw(asset.yahoo, "1m", range);
  if (!raw) return null;

  const meta = raw.meta || {};
  const tz = meta.exchangeTimezoneName || "America/New_York";
  // ⭐ 如希望连续品种弹窗分时也像首页卡片一样显示北京时间，把下面这行改为: const displayTz = (isFuturesSession || isFxSession) ? "Asia/Shanghai" : tz;
  const displayTz = tz;

  const timestamps = raw.timestamp || [];
  const q = raw.indicators?.quote?.[0] || {};
  const closes = q.close || [];
  const opens = q.open || [];
  const volumes = q.volume || [];

  const validPts = [];
  for (let i = 0; i < timestamps.length; i++) {
    const price = numOrNull(closes[i]) ?? numOrNull(opens[i]);
    if (price == null) continue;
    const vol = Math.max(0, numOrNull(volumes[i]) ?? 0);
    validPts.push({ ts: timestamps[i], price, vol });
  }
  if (validPts.length === 0) return null;

  // ⭐ 根据资产类型确定当前交易 Session 起点
  let sessionPts = [];
  if (isFuturesSession) {
    // 寻找最近一次 >= 45分钟(2700秒) 的休市跳空（精准命中 17:00-18:00 ET / 周末 / 伦敦休市）
    let startIdx = 0;
    for (let i = validPts.length - 1; i >= 1; i--) {
      if (validPts[i].ts - validPts[i - 1].ts >= 2700) {
        startIdx = i;
        break;
      }
    }
    sessionPts = validPts.slice(startIdx);
  } else if (isFxSession) {
    // 24H 外汇按纽约 17:00 ET 换日
    const targetSessionKey = getNyFxSessionKey(validPts[validPts.length - 1].ts);
    sessionPts = validPts.filter(p => getNyFxSessionKey(p.ts) === targetSessionKey);
  } else {
    // 日盘现货/ETF 沿用单日过滤
    const targetDate = formatTsInTz(validPts[validPts.length - 1].ts, displayTz).date;
    sessionPts = validPts.filter(p => formatTsInTz(p.ts, displayTz).date === targetDate);
  }

  let cumVol = 0;
  let cumAmt = 0;
  let sumPrice = 0;
  let countPrice = 0;
  const rows = [];

  for (const pt of sessionPts) {
    const { date, time } = formatTsInTz(pt.ts, displayTz);
    cumVol += pt.vol;
    cumAmt += pt.price * pt.vol;
    sumPrice += pt.price;
    countPrice++;

    const avgPrice = cumVol > 0
      ? Number((cumAmt / cumVol).toFixed(6))
      : Number((sumPrice / countPrice).toFixed(6));

    rows.push({
      date,
      time: (isFuturesSession || isFxSession) ? `${date.slice(5)} ${time.slice(0, 5)}` : time,
      price: pt.price,
      avg_price: avgPrice,
      volume: pt.vol,
    });
  }

  return rows.length > 0 ? rows : null;
}

async function fetchYahooKline(asset, period, limit, adj) {
  const intervalMap = { day: "1d", week: "1wk", month: "1mo" };
  const interval = intervalMap[period] || "1d";

  let range = "1y";
  if (period === "day") {
    if (limit > 1000) range = "10y";
    else if (limit > 400) range = "5y";
    else if (limit > 180) range = "2y";
    else range = "1y";
  } else if (period === "week") {
    if (limit > 450) range = "max";
    else if (limit > 220) range = "10y";
    else if (limit > 90) range = "5y";
    else range = "2y";
  } else if (period === "month") {
    range = limit > 120 ? "max" : "10y";
  }

  const raw = await fetchYahooChartRaw(asset.yahoo, interval, range);
  if (!raw) return null;

  const meta = raw.meta || {};
  const tz = meta.exchangeTimezoneName || "America/New_York";
  const timestamps = raw.timestamp || [];
  const q = raw.indicators?.quote?.[0] || {};
  const opens = q.open || [];
  const highs = q.high || [];
  const lows = q.low || [];
  const closes = q.close || [];
  const volumes = q.volume || [];
  const adjCloses = raw.indicators?.adjclose?.[0]?.adjclose || [];

  const barMap = new Map();
  for (let i = 0; i < timestamps.length; i++) {
    const rawClose = numOrNull(closes[i]);
    if (rawClose == null) continue;

    let open = numOrNull(opens[i]) ?? rawClose;
    let high = numOrNull(highs[i]) ?? Math.max(open, rawClose);
    let low = numOrNull(lows[i]) ?? Math.min(open, rawClose);
    let close = rawClose;

    // 若用户显式传 hfq，用 adjclose 比例近似缩放（默认 qfq 保留 Yahoo 原生拆股复权）
    if (adj === "hfq") {
      const ac = numOrNull(adjCloses[i]);
      if (ac != null && rawClose > 0) {
        const ratio = ac / rawClose;
        open = Number((open * ratio).toFixed(4));
        high = Number((high * ratio).toFixed(4));
        low = Number((low * ratio).toFixed(4));
        close = Number(ac.toFixed(4));
      }
    }

    const { date } = formatTsInTz(timestamps[i], tz);
    const vol = Math.max(0, numOrNull(volumes[i]) ?? 0);

    barMap.set(date, {
      date,
      open,
      close,
      high,
      low,
      volume: vol,
      amount: null,
    });
  }

  const bars = Array.from(barMap.values()).sort((a, b) => a.date.localeCompare(b.date));
  if (bars.length === 0) return null;

  return {
    code: asset.orig,
    period,
    adjust: adj || "none",
    rows: bars.slice(-limit),
    source: "yahoo_chart",
  };
}

// ============================================================
// CNBC RestQuote 实现（支持全球主权债券实时报价、支持批量）
// ============================================================
async function fetchCnbcBatch(symbols) {
  const unique = [...new Set(symbols.filter(Boolean))];
  if (!unique.length) return {};

  const url =
    `https://quote.cnbc.com/quote-html-webservice/restQuote/symbolType/symbol` +
    `?symbols=${encodeURIComponent(unique.join("|"))}` +
    `&requestMethod=itv&noform=1&partnerId=2&fund=1&exthrs=1&output=json`;

  const out = {};
  try {
    const res = await fetchExternal(url, {
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
        "Accept": "application/json",
      },
    }, 5500);
    if (!res.ok) return out;
    const json = await res.json();
    const list = json?.FormattedQuoteResult?.FormattedQuote;
    if (!Array.isArray(list)) return out;

    for (const q of list) {
      if (!q || !q.symbol || String(q.code) !== "0") continue;
      const parsed = parseCnbcQuoteToPrice({ orig: q.symbol, displayName: q.shortName || q.name, currency: q.currencyCode }, q);
      if (parsed) out[q.symbol] = parsed;
    }
  } catch (e) {
    // 静默回退下一数据源
  }
  return out;
}

async function fetchCnbcRaw(symbol) {
  const url =
    `https://quote.cnbc.com/quote-html-webservice/restQuote/symbolType/symbol` +
    `?symbols=${encodeURIComponent(symbol)}` +
    `&requestMethod=itv&noform=1&partnerId=2&fund=1&exthrs=1&output=json`;
  try {
    const res = await fetchExternal(url, {
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
        "Accept": "application/json",
      },
    }, 5000);
    if (!res.ok) return null;
    const json = await res.json();
    const q = json?.FormattedQuoteResult?.FormattedQuote?.[0];
    if (!q || String(q.code) !== "0") return null;
    return q;
  } catch (e) {
    return null;
  }
}

async function fetchCnbcPrice(asset) {
  const q = await fetchCnbcRaw(asset.cnbc);
  if (!q) return null;
  return parseCnbcQuoteToPrice(asset, q);
}

function parseCnbcQuoteToPrice(asset, q) {
  const latestPrice = parseNumLoose(q.last);
  if (latestPrice == null) return null;

  let prevClose = parseNumLoose(q.previous_day_closing);
  let changeAmount = parseNumLoose(q.change);
  if (prevClose == null && changeAmount != null) {
    prevClose = latestPrice - changeAmount;
  }
  if (changeAmount == null && prevClose != null) {
    changeAmount = latestPrice - prevClose;
  }
  if (prevClose == null) prevClose = latestPrice;
  if (changeAmount == null) changeAmount = 0;

  let changePercent = parseNumLoose(q.change_pct);
  if (changePercent == null) {
    changePercent = prevClose ? Number(((changeAmount / prevClose) * 100).toFixed(6)) : 0;
  }

  return {
    name: asset.displayName || q.shortName || q.name || asset.orig,
    latestPrice,
    changePercent: Number(changePercent.toFixed(6)),
    changeAmount: Number(changeAmount.toFixed(6)),
    source: "cnbc",
    currency: asset.currency || q.currencyCode || "USD",
    dailydata: null,
  };
}

// ============================================================
// 东方财富中美国债收益率数据中心（RPTA_WEB_TREASURYYIELD）
// 支持 CN2Y/CN5Y/CN10Y/CN30Y 与 US2Y/US5Y/US10Y/US30Y 历史与最新值
// ============================================================
async function fetchEastmoneyTreasuryRows(pageSize = 300) {
  const url =
    `https://datacenter.eastmoney.com/api/data/get` +
    `?type=RPTA_WEB_TREASURYYIELD&sty=ALL&st=SOLAR_DATE&sr=-1&p=1&ps=${pageSize}&token=894050c76af8597a853f5b408b759f5d`;

  try {
    const res = await fetchExternal(url, {
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
        "Referer": "https://data.eastmoney.com/",
      },
    }, 6000);
    if (!res.ok) return null;
    const json = await res.json();
    const list = json?.result?.data;
    return Array.isArray(list) ? list : null;
  } catch (e) {
    return null;
  }
}

function extractBondPriceFromEmRows(asset, rows) {
  if (!Array.isArray(rows) || !asset.emField) return null;
  const valid = [];
  for (const r of rows) {
    const val = numOrNull(r[asset.emField]);
    if (val != null && r.SOLAR_DATE) {
      valid.push({ date: String(r.SOLAR_DATE).slice(0, 10), val });
    }
    if (valid.length >= 2) break;
  }
  if (valid.length === 0) return null;

  const latestPrice = valid[0].val;
  const prevClose = valid.length >= 2 ? valid[1].val : latestPrice;
  const changeAmount = Number((latestPrice - prevClose).toFixed(6));
  const changePercent = prevClose ? Number(((changeAmount / prevClose) * 100).toFixed(6)) : 0;

  return {
    name: asset.displayName || asset.orig,
    latestPrice,
    changePercent,
    changeAmount,
    source: "eastmoney_bond",
    currency: asset.currency || "CNY",
    dailydata: null,
  };
}

async function fetchEastmoneyBondKline(asset, period, limit) {
  let ps = Math.min(2000, limit + 40);
  if (period === "week") ps = Math.min(3000, limit * 5 + 60);
  if (period === "month") ps = Math.min(5000, limit * 22 + 120);

  const rows = await fetchEastmoneyTreasuryRows(ps);
  if (!rows || rows.length === 0) return null;

  const daily = [];
  for (const r of rows) {
    const val = numOrNull(r[asset.emField]);
    const date = String(r.SOLAR_DATE || "").slice(0, 10);
    if (val != null && date) daily.push({ date, val });
  }
  if (daily.length === 0) return null;
  daily.sort((a, b) => a.date.localeCompare(b.date));

  let bars = [];
  if (period === "day") {
    for (let i = 0; i < daily.length; i++) {
      const cur = daily[i].val;
      const prev = i > 0 ? daily[i - 1].val : cur;
      bars.push({
        date: daily[i].date,
        open: prev,
        close: cur,
        high: Math.max(prev, cur),
        low: Math.min(prev, cur),
        volume: 0,
        amount: null,
      });
    }
  } else {
    const grouped = new Map();
    for (const d of daily) {
      const key = period === "month" ? d.date.slice(0, 7) : getISOWeekKey(d.date);
      if (!grouped.has(key)) {
        grouped.set(key, {
          date: d.date,
          open: d.val,
          close: d.val,
          high: d.val,
          low: d.val,
          volume: 0,
          amount: null,
        });
      } else {
        const g = grouped.get(key);
        g.date = d.date;
        g.close = d.val;
        if (d.val > g.high) g.high = d.val;
        if (d.val < g.low) g.low = d.val;
      }
    }
    bars = Array.from(grouped.values()).sort((a, b) => a.date.localeCompare(b.date));
  }

  return {
    code: asset.orig,
    period,
    adjust: "none",
    rows: bars.slice(-limit),
    source: "eastmoney_bond",
  };
}

// ============================================================
// Nasdaq Quote Summary（补充美股 PE / 股息率 / 总市值）
// ============================================================
async function fetchNasdaqSummary(symbol) {
  const tryAssetClass = async (assetClass) => {
    const url = `https://api.nasdaq.com/api/quote/${encodeURIComponent(symbol)}/summary?assetclass=${assetClass}`;
    const res = await fetchExternal(url, {
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36",
        "Accept": "application/json, text/plain, */*",
      },
    }, 3500);
    if (!res.ok) return null;
    const json = await res.json();
    return json?.data?.summaryData || null;
  };

  try {
    let summary = await tryAssetClass("stocks");
    if (!summary) summary = await tryAssetClass("etf");
    if (!summary) return null;

    const rawMC = parseNumLoose(summary.MarketCap?.value);
    const pe = parseNumLoose(summary.PERatio?.value);
    const yieldPct = parseNumLoose(summary.Yield?.value);

    return {
      marketCapYi: rawMC != null ? Number((rawMC / 1e8).toFixed(2)) : null,
      pe,
      dividendYield: yieldPct,
    };
  } catch (e) {
    return null;
  }
}

// ============================================================
// 新浪兜底（大宗商品 hf_* / 美元指数 DINIW / 外汇 fx_s*）
// ============================================================
async function fetchSinaPrice(asset) {
  if (!asset.sina) return null;
  const url = `https://hq.sinajs.cn/list=${encodeURIComponent(asset.sina)}`;
  try {
    const res = await fetchExternal(url, {
      headers: {
        "Referer": "https://finance.sina.com.cn",
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
      },
    }, 4500);
    if (!res.ok) return null;

    const buffer = await res.arrayBuffer();
    const text = new TextDecoder("gbk").decode(buffer);
    const match = text.match(/hq_str_[^=]+="([^"]*)"/);
    if (!match || !match[1]) return null;

    const f = match[1].split(",");
    let latestPrice = null;
    let prevClose = null;
    let name = asset.displayName || asset.orig;

    if (asset.sina.startsWith("hf_")) {
      // hf_GC: [0]=现价, [7]=昨结算, [13]=名称
      latestPrice = numOrNull(f[0]);
      prevClose = numOrNull(f[7]) ?? numOrNull(f[8]);
      if (f[13]) name = f[13];
    } else if (asset.sina === "DINIW" || asset.sina.startsWith("fx_s")) {
      // 外汇/DINIW: [0]=时间, [1]=买价/现价, [2]=卖价, [3]=昨收, [8]=名称
      latestPrice = numOrNull(f[1]) ?? numOrNull(f[8]);
      prevClose = numOrNull(f[3]) ?? numOrNull(f[5]);
      if (f[9]) name = f[9];
    }

    if (latestPrice == null) return null;
    if (prevClose == null || prevClose === 0) prevClose = latestPrice;

    const changeAmount = Number((latestPrice - prevClose).toFixed(6));
    const changePercent = prevClose ? Number(((changeAmount / prevClose) * 100).toFixed(6)) : 0;

    return {
      name,
      latestPrice,
      changePercent,
      changeAmount,
      source: "sina",
      currency: asset.currency || "USD",
      dailydata: null,
    };
  } catch (e) {
    return null;
  }
}

// ============================================================
// TTL 按实际返回数据日期计算（原逻辑保留）
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
// 实时行情：腾讯 qt.gtimg.cn（原逻辑完整保留）
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
// 分钟分时：腾讯 minute/query（A股/港股） / UsMinute/query（美股兜底）
// ============================================================
async function fetchIntradayBatch(codesInfo, tradeDate, env) {
  const results = {};

  for (const c of codesInfo) {
    // ⭐ 放行 hkHSI，让 HK50 走腾讯拿到实时分时
    if (c.tencent.startsWith("hf_") || (isGlobalIndex(c.tencent) && c.tencent !== "hkHSI")) {
      continue;
    }

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
// info：腾讯接口（原逻辑完整保留）
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
// movingaveragedata：腾讯 fqkline 历史 K 线（A股/港股及美股兜底）
// ============================================================
async function fetchMovingAverageData(tencentCode, origCode, opts, env) {
  const { period, adjust, limit } = opts;

  const periodMap = { day: "day", week: "week", month: "month" };
  const p = periodMap[period] || "day";
  const adjustMap = { qfq: "qfq", hfq: "hfq", none: "" };
  const adj = adjustMap[adjust] !== undefined ? adjustMap[adjust] : "qfq";

  const isUS = tencentCode.startsWith("us") && !isGlobalIndex(tencentCode);

  let candidates = [tencentCode];
  if (isUS && !tencentCode.includes(".")) {
    candidates = [tencentCode + ".OQ", tencentCode + ".N", tencentCode + ".AM"];
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
      (adj ? node[`${adj}${p}`] : null) ||
      node[p] ||
      node[`qfq${p}`] ||
      node[`hfq${p}`] ||
      null;

    if (!rows || !Array.isArray(rows) || rows.length === 0) continue;

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
// 腾讯代码转换（保留供 A股/港股 及 兜底使用）
// ============================================================
function convertToTencentCode(code) {
  if (!code) return null;
  const text = String(code).trim().toUpperCase();

  if (/^(SH|SZ|HK|BJ)\d+/.test(text)) return text.toLowerCase();
  if (/^HF_[A-Z]{2}$/.test(text)) return text.toLowerCase();
  if (/^US(DJI|IXIC|INX|NDX)$/.test(text)) return text.toLowerCase();

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

  if (/^\d+$/.test(text)) {
    if (text.length === 5) return "hk" + text;

    if (text.length === 6) {
      if (/^(60|68|50|51|52|55|56|58|11|900)/.test(text)) return "sh" + text;
      if (/^(00|30|15|16|18|12|200|399)/.test(text)) return "sz" + text;
      if (/^(92|83|87|88|43)/.test(text)) return "bj" + text;
      return null;
    }
    return null;
  }

  if (/^[A-Z]{1,5}$/.test(text)) return "us" + text;
  if (/^[A-Z]{1,5}[\.\-][A-Z]{1,2}$/.test(text)) return "us" + text;
  if (/^(HSI|HSCEI|HSCCI)$/.test(text)) return "hk" + text;

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

function numOrNull(v) {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function parseNumLoose(v) {
  if (v === null || v === undefined) return null;
  const cleaned = String(v).replace(/[,%$\s]/g, "").replace(/^\+/, "");
  if (!cleaned || cleaned === "--" || cleaned === "N/A" || cleaned === "NA") return null;
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : null;
}

function formatTsInTz(epochSeconds, timeZone) {
  const d = new Date(epochSeconds * 1000);
  try {
    const fmt = new Intl.DateTimeFormat("en-CA", {
      timeZone: timeZone || "America/New_York",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hour12: false,
    });
    const parts = {};
    for (const p of fmt.formatToParts(d)) {
      parts[p.type] = p.value;
    }
    const hh = parts.hour === "24" ? "00" : parts.hour;
    return {
      date: `${parts.year}-${parts.month}-${parts.day}`,
      time: `${hh}:${parts.minute}:00`,
    };
  } catch (e) {
    const iso = d.toISOString();
    return { date: iso.slice(0, 10), time: iso.slice(11, 16) + ":00" };
  }
}

function getISOWeekKey(dateStr) {
  const d = new Date(`${dateStr}T00:00:00Z`);
  const dayNum = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  const weekNo = Math.ceil(((d - yearStart) / 86400000 + 1) / 7);
  return `${d.getUTCFullYear()}-W${String(weekNo).padStart(2, "0")}`;
}

async function fetchExternal(url, init = {}, timeoutMs = 6000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

// ============================================================
// 腾讯多端点轮换 fetchWithRetry（原逻辑完整保留）
// ============================================================
const TENCENT_ENDPOINTS = {
  price: [
    { host: "qt.gtimg.cn", pathPrefix: "" },
    { host: "web.sqt.gtimg.cn", pathPrefix: "" },
    { host: "sqt.gtimg.cn", pathPrefix: "/utf8" },
  ],
  kline: [
    { host: "web.ifzq.gtimg.cn", pathPrefix: "" },
    { host: "ifzq.gtimg.cn", pathPrefix: "" },
    { host: "proxy.finance.qq.com", pathPrefix: "/ifzqgtimg", replaceFqkline: true },
  ],
  minute: [
    { host: "web.ifzq.gtimg.cn", pathPrefix: "" },
    { host: "ifzq.gtimg.cn", pathPrefix: "" },
    { host: "proxy.finance.qq.com", pathPrefix: "/ifzqgtimg" },
  ],
};

async function fetchWithRetry(url, env, retries = 3) {
  const timeoutMs = 8000;
  let lastError;
  let rotationIndex = 0;

  const { pathAndQuery, type } = parseTencentUrl(url);
  const endpoints = TENCENT_ENDPOINTS[type] || [{ host: new URL(url).hostname, pathPrefix: "" }];

  for (let attempt = 0; attempt <= retries; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const endpoint = endpoints[rotationIndex % endpoints.length];
      const targetUrl = buildTencentUrl(endpoint, pathAndQuery, type);

      const res = await fetch(targetUrl, {
        signal: controller.signal,
        headers: {
          "User-Agent":
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
        },
      });
      clearTimeout(timer);

      if (res.ok) return res;

      if (res.status >= 500) {
        lastError = new Error(`HTTP ${res.status} from ${endpoint.host}`);
        if (attempt < retries) {
          await sleep(withJitter(Math.pow(2, attempt) * 500));
          rotationIndex++;
          continue;
        }
        throw lastError;
      }

      if (res.status === 429) {
        const retryAfter = parseInt(res.headers.get("Retry-After") || "0", 10);
        lastError = new Error(`HTTP 429 from ${endpoint.host}`);
        if (attempt < retries) {
          const waitMs = retryAfter > 0 ? retryAfter * 1000 : Math.pow(2, attempt) * 1000;
          await sleep(withJitter(waitMs));
          rotationIndex++;
          continue;
        }
        return res;
      }

      if (res.status === 404) {
        const clonedRes = res.clone();
        const text = await clonedRes.text();
        if (text.trim() === "") {
          lastError = new Error(`HTTP 404 (empty body, possible overload) from ${endpoint.host}`);
          if (attempt < 2) {
            await sleep(withJitter(1000 * (attempt + 1)));
            rotationIndex++;
            continue;
          }
        }
        return res;
      }

      return res;
    } catch (e) {
      clearTimeout(timer);
      lastError = e;
      if (attempt < retries) {
        await sleep(withJitter(Math.pow(2, attempt) * 500));
        rotationIndex++;
        continue;
      }
    }
  }

  throw lastError;
}

function parseTencentUrl(url) {
  const u = new URL(url);
  const host = u.hostname;
  const pathAndQuery = u.pathname + u.search;

  if (host.includes("qt.gtimg.cn")) {
    return { pathAndQuery, type: "price" };
  }
  if (pathAndQuery.includes("fqkline")) {
    return { pathAndQuery, type: "kline" };
  }
  if (/minute/i.test(pathAndQuery)) {
    return { pathAndQuery, type: "minute" };
  }
  return { pathAndQuery, type: "kline" };
}

function buildTencentUrl(endpoint, pathAndQuery, type) {
  let path = pathAndQuery;
  if (type === "price") {
    if (endpoint.pathPrefix === "/utf8") {
      path = "/utf8" + path;
    }
  } else {
    if (endpoint.pathPrefix) {
      path = endpoint.pathPrefix + path;
    }
    if (endpoint.replaceFqkline && type === "kline") {
      path = path.replace("fqkline", "newfqkline");
    }
  }
  return `https://${endpoint.host}${path}`;
}

function withJitter(ms) {
  return ms + Math.random() * 300;
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
