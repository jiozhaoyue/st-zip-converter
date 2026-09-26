/**
 * PT（PureTavern）数据计数装置 —— **两处共用**（`pt-automation.cjs` 探查 / `import-pt.cjs` 同步）
 *
 * ## 为什么需要它
 * PT 是**纯前端**宿主：用户数据落在浏览器 **IndexedDB**，磁盘上**没有数据目录**
 * （`e2e/lib/instances.cjs` 里 `pt-web.userDir` 按设计为 `null`）。
 * 因此「同步到底进去没有」这个判定，**唯一可程序化读到的真源就是 IndexedDB 的逐库计数** ——
 * 界面上的模块条目会被虚拟滚动截断，不能当判据。
 *
 * ## 实现约定
 * - 逐库 `open()` → 逐 store `count()`，拿的是**记录条数**，不是渲染项；
 * - `indexedDB.databases()` 在部分实现里可能**不返回尚未打开的库**，故同时兜住
 *   `open()` 失败的情形（返回 `'（打不开）'` 而非抛错）—— 计数装置不得拖垮导入流程；
 * - 本文件是**唯一实现**：`pt-automation.cjs` 与 `import-pt.cjs` 都从这里 require，
 *   避免两处各写一份导致口径漂移（同 F-4 抽 `lib/luker-card-adapter.cjs` 的做法）。
 *
 * @module scripts/instance-sync/lib/pt-count
 */

/**
 * 读 PT 当前的 IndexedDB 全库计数。
 * @param {import('playwright').Page} page 已打开的 PT 页面
 * @returns {Promise<Object<string, Object<string, number>>|Object<string,string>>}
 *          形如 `{ 库名: { store名: 条数 } }`；某库打不开时该库值为提示字符串
 */
async function countPtData(page) {
  return page.evaluate(async () => {
    const names = (await indexedDB.databases()).map((d) => d.name).filter(Boolean);
    const out = {};
    for (const name of names) {
      try {
        const db = await new Promise((resolve, reject) => {
          const req = indexedDB.open(name);
          req.onsuccess = () => resolve(req.result);
          req.onerror = () => reject(req.error);
        });
        const counts = {};
        for (const store of db.objectStoreNames) {
          counts[store] = await new Promise((resolve) => {
            try {
              const tx = db.transaction(store, 'readonly');
              const cr = tx.objectStore(store).count();
              cr.onsuccess = () => resolve(cr.result);
              cr.onerror = () => resolve(-1);
            } catch { resolve(-1); }
          });
        }
        out[name] = counts;
        db.close();
      } catch { out[name] = '（打不开）'; }
    }
    return out;
  });
}

/**
 * 把计数结果压平成一维：`"<库>.<store>" → 条数`，便于做**前后差值**对照。
 * 非数值项（打不开的库）被剔除。
 * @param {Object} counts `countPtData` 的返回
 * @returns {Object<string, number>}
 */
function flattenPtCounts(counts) {
  const flat = {};
  for (const [dbName, stores] of Object.entries(counts || {})) {
    if (!stores || typeof stores !== 'object') continue;
    for (const [store, n] of Object.entries(stores)) {
      if (typeof n === 'number') flat[`${dbName}.${store}`] = n;
    }
  }
  return flat;
}

/**
 * 比较两组计数，给出**增长**读数（导入前后对照用）。
 * @param {Object} before `countPtData` 的结果
 * @param {Object} after  `countPtData` 的结果
 * @returns {{grown: Array<{key:string, before:number, after:number, delta:number}>,
 *            shrank: Array<{key:string, before:number, after:number, delta:number}>,
 *            totalBefore:number, totalAfter:number}}
 */
function diffPtCounts(before, after) {
  const a = flattenPtCounts(before);
  const b = flattenPtCounts(after);
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  const grown = [];
  const shrank = [];
  let totalBefore = 0;
  let totalAfter = 0;
  for (const key of keys) {
    const bv = a[key] ?? 0;
    const av = b[key] ?? 0;
    totalBefore += bv;
    totalAfter += av;
    const delta = av - bv;
    if (delta > 0) grown.push({ key, before: bv, after: av, delta });
    else if (delta < 0) shrank.push({ key, before: bv, after: av, delta });
  }
  grown.sort((x, y) => y.delta - x.delta);
  shrank.sort((x, y) => x.delta - y.delta);
  return { grown, shrank, totalBefore, totalAfter };
}

module.exports = { countPtData, flattenPtCounts, diffPtCounts };