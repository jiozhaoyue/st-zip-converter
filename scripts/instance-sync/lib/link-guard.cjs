/**
 * 链接子树守卫 —— 防止同步**穿透 junction / 符号链接**写进别人的工作区
 *
 * 为什么需要（2026-09-26 实测）：`Instance/Dev/Luker/data/default-user/extensions/ST-BgLoader`
 * 是指向 `My-repo/ST-BgLoader` 的 **junction**。本次 Luker restore 的 1090 条 `extensions/ST-BgLoader/**`
 * 因此**穿透**写进了那个仓的工作区 —— 该仓当时正被另一个会话改动。
 * 后果不是"看得到的报错"，而是**跨仓工作区互相污染**（本仓群 `P-18` 的同族形态），
 * 且与 `C-5「不改其他仓」`、`L0-1` 的立场正面冲突。
 *
 * 守卫策略（用户 2026-09-26 裁决「默认跳过链接子树」）：
 *   - **能逐条跳过的**（裸落盘类目）：落在链接子树下的目标路径**直接跳过**并计数登记；
 *   - **一次成型的**（宿主原生 restore，服务端一把写完）：**前置门禁**——发现链接即在写入前拒绝，
 *     除非显式传 `--allow-links`（此时由使用者承担"写进外部仓"的后果）。
 *
 * 不做的事：不试图在服务端拦截（那是宿主内部行为，我们改不了宿主）；本模块只管**客户端启不启动这次写**。
 *
 * @module scripts/instance-sync/lib/link-guard
 */

const fs = require('fs');
const path = require('path');

/**
 * 找出 `rootDir` 下所有**指向目录**的链接（junction / symlink），返回**归一化相对路径**。
 *
 * 判定细节：Windows junction 的 `dirent.isDirectory()` 为 false、`isSymbolicLink()` 为 true，
 * 故判据是「`isSymbolicLink()` 且**跟随之后**的 `stat` 说它是目录」。
 * 用 `realpath` 去重防环（junction 指回上层会无限递归）。
 *
 * @param {string} rootDir
 * @returns {Promise<{rel:string, abs:string, target:string}[]>}
 */
async function findLinkedRoots(rootDir) {
  const out = [];
  const visited = new Set();
  async function rec(dir, rel) {
    let real;
    try { real = await fs.promises.realpath(dir); } catch { return; }
    if (visited.has(real)) return;
    visited.add(real);
    let entries;
    try { entries = await fs.promises.readdir(dir, { withFileTypes: true }); } catch { return; }
    for (const ent of entries) {
      const abs = path.join(dir, ent.name);
      const relPath = rel ? `${rel}/${ent.name}` : ent.name;
      let st;
      try { st = await fs.promises.stat(abs); } catch { continue; }
      if (!st.isDirectory()) continue;
      if (ent.isSymbolicLink()) {
        let target = '';
        try { target = await fs.promises.realpath(abs); } catch { /* 断链：仍登记 */ }
        out.push({ rel: relPath, abs, target });
        continue; // 不再深入链接子树：它的内容是别人的，不是本次同步的对象
      }
      await rec(abs, relPath);
    }
  }
  await rec(rootDir, '');
  return out;
}

/**
 * 该相对路径是否落在任一链接根之下（**前缀必须带斜杠**，`extensions/ST-BgLoaderX` 不算）。
 * @param {string} relPath
 * @param {{rel:string}[]} linkedRoots
 */
function isUnderLink(relPath, linkedRoots) {
  const n = String(relPath).replace(/\\/g, '/');
  return linkedRoots.some((l) => n === l.rel || n.startsWith(`${l.rel}/`));
}

/**
 * 前置门禁：写入前检查目标目录里有没有链接子树；有且未显式放行 ⇒ **抛错拒绝**。
 *
 * @param {object} p
 * @param {string} p.rootDir  将被写入的根（如实例的用户数据目录）
 * @param {boolean} p.allowLinks 显式放行（`--allow-links`）
 * @param {string} p.label    用于报错的场景名（如 `dev-luker restore`）
 * @returns {Promise<{rel:string, abs:string, target:string}[]>} 即便放行也把链接清单交回调用方登记
 */
async function assertNoLinksUnder({ rootDir, allowLinks, label }) {
  const links = await findLinkedRoots(rootDir);
  if (!links.length) return links;
  const lines = links.map((l) => `  - ${l.rel} → ${l.target || '(断链)'}`);
  if (allowLinks) {
    console.log(`⚠️ [${label}] 检测到 ${links.length} 个链接子树，已按 --allow-links 放行：\n${lines.join('\n')}`);
    console.log('   ⇒ 本次写入会**穿透**落到上面这些外部目录，后果由使用者承担（与 C-5 的偏离须如实登记）。');
    return links;
  }
  throw new Error(
    `[${label}] 目标目录下有 ${links.length} 个**链接子树**，写入会穿透到外部工作区：\n${lines.join('\n')}\n`
    + '⇒ 已拒绝启动本次写入（默认跳过链接子树；用户裁决 2026-09-26）。\n'
    + '   若确实要写进去，显式加 `--allow-links`，并把这次偏离登记到任务残留里。',
  );
}

module.exports = { findLinkedRoots, isUnderLink, assertNoLinksUnder };
