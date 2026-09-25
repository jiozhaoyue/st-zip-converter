/**
 * 实例登记表 —— 端口、目录、会话档案的**唯一定义点**
 *
 * 纪律（违反即本仓红线）：
 *  1. **端口写死登记值**（L0-16）。Dev/Real 只能靠端口区分——两个宿主的版本号完全一致
 *     （ST 1.19.0 / Luker 2.7.0 在 Dev 与 Real 上相同），`P-11` 明确「风险不是端口冲突而是误连」。
 *  2. **协议按宿主各自 `config.yaml` 的 `ssl.enabled` 决定，不靠猜**（2026-09-26 实测）：
 *     - **ST（Dev/Real）`ssl.enabled: false` ⇒ 明文 `http://`**（首版登记表误写 https，
 *       被 `start-instance.cjs` 的就绪探针以 `TCP 已开但 HTTP EPROTO` 抓出——探针只信 `inst.url`）；
 *     - **Luker（Dev/Real）`ssl.enabled: true` ⇒ `https://`**（自签证书，故需 `ignoreHTTPSErrors`）；
 *     - **PT `apps/web` 是 vite dev ⇒ `http://`**。
 *  3. **目录按标准仓群布局相对解析**，不写本机绝对路径（`P-17` / `L1-MR-14`：
 *     绝对路径进公开仓等于把本机目录结构交出去，换机器必然失效）。
 *     可用环境变量 `TAVERN_INSTANCES_ROOT` 覆盖，便于他机复用。
 *  4. **禁止 8000**：任何启动都不得绑定或请求 8000（L0-16 出厂默认段）。
 *  5. 本文件**不含任何凭据**；登录态一律由 Playwright 持久化档案承载（`.pw-profile*`，已 gitignore）。
 *
 * @module e2e/lib/instances
 */

const path = require('path');

/** 本仓根（`<repo>/e2e/lib` 上两级） */
const REPO_ROOT = path.resolve(__dirname, '..', '..');

/**
 * 实例根目录。标准仓群布局：
 * `<Tavern-repo>/My-repo/ST-zip-converter` ← 本仓；`<Tavern-repo>/Instance` ← 实例根。
 * 故从本仓根上两级即 `<Tavern-repo>`。
 */
const INSTANCES_ROOT = process.env.TAVERN_INSTANCES_ROOT
  ? path.resolve(process.env.TAVERN_INSTANCES_ROOT)
  : path.resolve(REPO_ROOT, '..', '..', 'Instance');

/** 会话档案（相对本仓根，已被 `.gitignore` 的 `.pw-profile` 通配规则覆盖） */
const PROFILES = Object.freeze({
  dev: path.join(REPO_ROOT, '.pw-profile-dev'),
  real: path.join(REPO_ROOT, '.pw-profile'),
});

/**
 * @typedef {Object} Instance
 * @property {string} id            稳定标识
 * @property {'dev'|'real'} side    Dev / Real 侧（只作标注，判定一律用端口）
 * @property {string} host          宿主形态：st | luker | pt
 * @property {number} port          登记端口（唯一判据）
 * @property {string} url           基址
 * @property {string} dir           实例仓目录（绝对，运行时解析）
 * @property {string} profile       Playwright 持久化档案
 * @property {string|null} userDir  用户数据目录（PT 无磁盘目录 → null）
 * @property {string[]} startCmd    启动命令 argv（cwd = dir）
 * @property {string} startCwd      启动命令的 cwd
 */

/** @type {Readonly<Record<string, Instance>>} */
const INSTANCES = Object.freeze({
  'dev-st': Object.freeze({
    id: 'dev-st', side: 'dev', host: 'st', port: 8001,
    // ST `config.yaml` 的 `ssl.enabled: false` ⇒ 明文 HTTP（实测 http=200 / https=EPROTO）
    url: 'http://127.0.0.1:8001',
    dir: path.join(INSTANCES_ROOT, 'Dev', 'SillyTavern'),
    profile: PROFILES.dev,
    userDir: 'data/default-user',
    startCmd: ['node', 'server.js'],
    startCwd: path.join(INSTANCES_ROOT, 'Dev', 'SillyTavern'),
  }),
  'real-st': Object.freeze({
    id: 'real-st', side: 'real', host: 'st', port: 8002,
    // 同 Dev ST：`ssl.enabled: false` ⇒ HTTP
    url: 'http://127.0.0.1:8002',
    dir: path.join(INSTANCES_ROOT, 'Real', 'SillyTavern'),
    profile: PROFILES.real,
    userDir: 'data/default-user',
    startCmd: ['node', 'server.js'],
    startCwd: path.join(INSTANCES_ROOT, 'Real', 'SillyTavern'),
  }),
  'dev-luker': Object.freeze({
    id: 'dev-luker', side: 'dev', host: 'luker', port: 8003,
    url: 'https://127.0.0.1:8003',
    dir: path.join(INSTANCES_ROOT, 'Dev', 'Luker'),
    profile: PROFILES.dev,
    userDir: 'data/default-user',
    startCmd: ['node', 'server.js'],
    startCwd: path.join(INSTANCES_ROOT, 'Dev', 'Luker'),
  }),
  'real-luker': Object.freeze({
    id: 'real-luker', side: 'real', host: 'luker', port: 8004,
    url: 'https://127.0.0.1:8004',
    dir: path.join(INSTANCES_ROOT, 'Real', 'Luker'),
    profile: PROFILES.real,
    userDir: 'data/default-user',
    startCmd: ['node', 'server.js'],
    startCwd: path.join(INSTANCES_ROOT, 'Real', 'Luker'),
  }),
  'pt-web': Object.freeze({
    id: 'pt-web', side: 'dev', host: 'pt', port: 8899,
    url: 'http://127.0.0.1:8899',
    dir: path.join(INSTANCES_ROOT, 'Dev', 'PureTavern', 'apps', 'web'),
    profile: PROFILES.dev,
    // PT 是纯前端：用户数据在浏览器 Profile（IndexedDB），**没有磁盘数据目录**
    userDir: null,
    startCmd: ['pnpm', 'dev'],
    startCwd: path.join(INSTANCES_ROOT, 'Dev', 'PureTavern', 'apps', 'web'),
  }),
});

/** @param {string} id @returns {Instance} */
function getInstance(id) {
  const inst = INSTANCES[id];
  if (!inst) {
    throw new Error(`未知实例 id: ${id}（可用：${Object.keys(INSTANCES).join(', ')}）`);
  }
  return inst;
}

/** 用户数据目录的绝对路径；PT 无磁盘目录时抛错（调用方须显式处理） */
function userDirOf(id) {
  const inst = getInstance(id);
  if (!inst.userDir) {
    throw new Error(`实例 ${id} 没有磁盘用户数据目录（纯前端 Profile 存储）`);
  }
  return path.join(inst.dir, inst.userDir);
}

module.exports = { REPO_ROOT, INSTANCES_ROOT, PROFILES, INSTANCES, getInstance, userDirOf };
