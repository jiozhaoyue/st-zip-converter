# 供给侧实现指引（`ChatFilesysApi` v1）—— **待落，本仓不代改**

> 目的：把契约落成实现时，**不必重新取证**。本文只给「改哪里、怎么改、怎么验」，
> 不含已提交的代码（供给侧仓 `My-repo/ST-chatfilesys-rebuild` 在本轮**正被另一会话通宵开发**，
> 近 1 小时内仍在改 `index.js` / `core/errors.js` / `e2e`，故**本轮完全不碰它**）。
> 契约正文见 `.trellis/spec/frontend/chat-store-seam.md` §2。

## 1 落点（供给侧仓内，均为新增/极小改动）

| 动作 | 位置 | 说明 |
| --- | --- | --- |
| 新增 | `public/scripts/extensions/third-party/chatfilesys/core/plugin-api.js` | 纯装配：把已有能力包成一个**冻结**对象，不新增业务逻辑 |
| 接线 | `index.js` 的初始化路径 | 在 `storageState` 建好（`enablePureDb()` 之后）与模式变更处**重挂**；`dispose` 时删除 |
| 复用（**不要新写**） | `core/mode.js` 的 `normMode/isPureLike`；`core/importer.js` 的 `runImport`；`core/seam.js` 的 `native(...)`；`core/branches.js` 的家族读取 | 契约要求的是「暴露已有能力」，不是新造一套读库路径 |

## 2 依赖注入式装配（写在 `plugin-api.js` 里，**不耦合具体实现文件**）

```js
/**
 * @param {object} deps 由 index.js 注入（这样单测可直传假实现，无需起浏览器）
 * @param {() => 'off'|'pure'|'mirror'} deps.mode
 * @param {() => object|null} deps.storageState      当前库状态（未启用纯库时为 null）
 * @param {(raw) => object} deps.normalizeChatKey     与接缝同一套 key 归一
 * @param {(key) => Promise<Array>} deps.listFamilies 家族/分支索引（不含正文）
 * @param {(key, branchId) => Promise<string>} deps.exportBranchStandardJsonl
 * @param {(file) => Promise<object>} deps.importJsonlMerge  # runImport 的「只合并」子集
 */
export function createPluginApi(deps) {
  const api = {
    apiVersion: 1,
    capabilities: Object.freeze({ list: true, export: true, import: true }),
    mode: () => (deps.storageState() ? deps.mode() : 'off'),
    listChats: async () => deps.listFamilies(),
    exportChat: async ({ avatarUrl, fileName }) => deps.exportBranchStandardJsonl(
      deps.normalizeChatKey({ avatarUrl, fileName }),
    ),
    importChat: async ({ avatarUrl, fileName, jsonl, sourceLabel }) => deps.importJsonlMerge({
      key: deps.normalizeChatKey({ avatarUrl, fileName }), jsonl, sourceLabel,
    }),
  };
  return Object.freeze(api);
}
```

## 3 三条硬约束（违反即为契约缺陷，见契约 S-1…S-6）

1. **`importChat` 只合并、绝不删源**：**不要**直接调 `runImport`（它按导入旅程语义会
   「移回收站 → 删源」）。必须调用它的**只合并子集**（指纹去重 + LCP 分叉），
   或给 `runImport` 增加一个显式的 `{ keepSource: true }` 分支并只对 `plugin-api` 使用。
2. **幂等**：同一份 `jsonl` 重复导入不产生重复楼层（内容指纹去重的既有语义天然满足，
   但**要有单测锁住**）。
3. **`fileName` 是宿主落盘名**（家族主键绑定的就是它），可以是**带角色子目录的相对路径**
   （如 `Fixture Character/2026-09-01.jsonl`）；消费侧会**原样落到 `chats/` 下**，
   故：库侧返回什么，落盘就是什么 —— 不要在这里做「扁平化」。

## 4 验收（供给侧自己就能跑，不必等本仓）

```bash
# 供给侧单测（node:test，直接 import 扩展源码）
node --test tests/branches/plugin-api.test.mjs      # 新写：三态能力位 / 幂等 / 失败可判 / 冻结
python tests/e2e/test_pure_db_*.py                  # 既有纯库 e2e 串行跑，确认未被影响
```

三条必须有的负例（本仓消费侧正是按这三条设计的降级）：
- `storageState === null`（未启用纯库）⇒ `mode()` 返回 `'off'`、`capabilities` 仍为真值但
  消费侧的 `present` 判定不依赖它 ⇒ 消费侧**必须**能在这种情形下不注入；
- `importJsonlMerge` 抛错 ⇒ `importChat` **reject 或返回 `{ok:false, reason}`**（不得静默吞）；
- 重复导入同一份 `jsonl` ⇒ 楼层数**不变**（幂等）。

## 5 落地后本仓要跟着做的两件事

1. 把消费侧的**真机验证**补上（本仓任务 `09-27-chatfilesys-pure-db-adapter` 的 AC-7/AC-8/AC-9）：
   直接改用例 `npm run e2e:web -- --only chat-store-module`——把桩换成真插件即可
   （用例只依赖 `globalThis.ChatFilesysApi` 的形状）；
2. 删掉契约里的「供给侧尚未实现」注记，并把 §5「未做到」里的第 1 条划掉。
