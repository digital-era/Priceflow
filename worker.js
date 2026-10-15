async function fetchOneUlistBatch(batch) {
  // ... 与上一版相同：请求 ulist.np，解析 diff，返回 { [code]: priceObj }
}

/**
 * 处理一批：
 *  1) 正常请求
 *  2) 若 got==0 → 等一会再整批重试
 *  3) 若仍为空或明显偏少 → 拆成更小批再试
 *  4) 最后把本批结果 merge 进 results
 */
async function processUlistBatch(batch, results, batchIndex, totalBatches) {
  let gotMap = await fetchOneUlistBatch(batch);
  let got = Object.keys(gotMap).length;

  // —— 情况 A：整批为空 → 重试一次
  if (got === 0 && batch.length > 0) {
    console.log(
      `ulist batch ${batchIndex + 1}/${totalBatches} empty, retry after ${ULIST_RETRY_DELAY_MS}ms`
    );
    await sleep(ULIST_RETRY_DELAY_MS);
    gotMap = await fetchOneUlistBatch(batch);
    got = Object.keys(gotMap).length;
  }

  Object.assign(results, gotMap);

  // —— 情况 B：重试后仍为空，或成功率过低 → 拆成更小批再打
  const stillMissing = batch.filter((x) => !results[x.code]);
  if (stillMissing.length > 0 && (got === 0 || stillMissing.length >= Math.ceil(batch.length * 0.5))) {
    console.log(
      `ulist batch ${batchIndex + 1} still missing ${stillMissing.length}, split to ${ULIST_RETRY_SPLIT}`
    );

    for (let i = 0; i < stillMissing.length; i += ULIST_RETRY_SPLIT) {
      if (i > 0) await sleep(ULIST_BATCH_DELAY_MS);
      const sub = stillMissing.slice(i, i + ULIST_RETRY_SPLIT);
      const subMap = await fetchOneUlistBatch(sub);
      Object.assign(results, subMap);
      console.log(
        `  split sub-batch got=${Object.keys(subMap).length}/${sub.length}`
      );
    }
  }

  const finalGot = batch.filter((x) => results[x.code]).length;
  console.log(
    `ulist price batch ${batchIndex + 1}/${totalBatches} req=${batch.length} finalGot=${finalGot}`
  );
}

async function fetchPriceBatchUlist(codes) {
  if (!codes.length) return {};

  const results = {};
  const codeInfos = [];
  for (const code of codes) {
    const info = convertCode(code);
    if (info) codeInfos.push({ code, ...info });
  }
  if (!codeInfos.length) return {};

  // 1) 按 15 只分批
  const batches = [];
  for (let i = 0; i < codeInfos.length; i += ULIST_BATCH_SIZE) {
    batches.push(codeInfos.slice(i, i + ULIST_BATCH_SIZE));
  }

  for (let bi = 0; bi < batches.length; bi++) {
    if (bi > 0) await sleep(ULIST_BATCH_DELAY_MS);
    await processUlistBatch(batches[bi], results, bi, batches.length);
  }

  // 2) 仍缺失 → 单只兜底（最后一道）
  const missing = codeInfos.map((x) => x.code).filter((c) => !results[c]);
  if (missing.length) {
    console.log(`fallback single for ${missing.length} codes`);
    await runWithConcurrency(
      missing,
      FALLBACK_CONCURRENCY,
      FALLBACK_DELAY_MS,
      async (code) => {
        const data = await fetchPriceWithEastmoney(code);
        if (data) results[code] = data;
      }
    );
  }

  return results;
}
