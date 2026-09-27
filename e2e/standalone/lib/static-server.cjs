/**
 * 静态站点服务器 —— 只为「独立 Web 形态 / 云部署形态」的自动化验证用
 *
 * 为什么要自己写：`vite preview` 只能挂在根路径，而**云酒馆/静态托管的真实形态是子路径**
 * （GitHub Pages 项目页 = `https://<user>.github.io/<repo>/`）。构建产物用的是
 * `base: './'`（构建脚本标志），子路径可用性正是需要被自动化证明的事，故这里支持
 * 任意前缀挂载。
 *
 * **多挂载点**：一个服务器同时挂 `dist/`（构建产物）与**仓库源码树**（未打包的 ESM 模块）。
 * 后者让 spec 能在真实浏览器里 `import('/<prefix>/src/ui/….js')` 直接驱动**真实模块**
 * （真 Blob、真 Worker 路径）——不必为此把整个实例的 1.5 GB 数据拉一遍。
 *
 * 纪律：
 *  - **只读**：只从挂载根读文件；
 *  - **拒绝敏感路径**：路径段以 `.` 开头或为 `node_modules` 一律 404（源码树挂载会暴露仓目录，
 *    本机测试服务器也不该提供 `.git/`、`.env` 之类）；
 *  - 端口显式登记（`L0-16`）：默认 `4173`（已登记为 Vite preview 段），`strictPort` 语义——
 *    被占用即**报错退出**，绝不自动换端口（换端口 = 换目标 = 读数不可解释）。
 *
 * @module e2e/standalone/lib/static-server
 */

const http = require('http');
const fs = require('fs');
const path = require('path');

/** 已登记端口（L0-16：4173 = Vite preview）。禁止 8000/3000 段。 */
const DEFAULT_PORT = 4173;

const MIME = Object.freeze({
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.cjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.ico': 'image/x-icon',
  '.wasm': 'application/wasm',
  '.map': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
});

/** 归一前缀：以 `/` 开头、以 `/` 结尾 */
function normalizePrefix(prefix) {
  let pre = String(prefix || '/').startsWith('/') ? String(prefix) : `/${prefix}`;
  if (!pre.endsWith('/')) pre += '/';
  return pre;
}

/** 路径里是否有「不该被本机测试服务器提供」的段 */
function isDenied(rel) {
  return rel.split('/').some((seg) => seg.startsWith('.') || seg === 'node_modules');
}

/**
 * 启动静态服务器。
 * @param {object} options
 * @param {Array<{prefix: string, root: string}>} [options.mounts]
 *   挂载表；前缀最长者优先匹配。默认 `[{prefix:'/', root: cwd}]`
 * @param {string} [options.root] 单挂载点的简写（等价于 mounts = [{prefix: options.prefix, root}])
 * @param {string} [options.prefix='/']
 * @param {number} [options.port]
 * @returns {Promise<{url: string, prefix: string, port: number, mounts: Array<{prefix: string, root: string, url: string}>, requests: Array<{url: string, status: number}>, close: function(): Promise<void>}>}
 */
function startStaticServer({ mounts, root, prefix = '/', port = DEFAULT_PORT } = {}) {
  const list = (mounts || [{ prefix, root }]).map((m) => ({
    prefix: normalizePrefix(m.prefix),
    root: path.resolve(m.root),
  })).sort((a, b) => b.prefix.length - a.prefix.length); // 最长前缀优先

  for (const m of list) {
    if (!fs.existsSync(m.root)) {
      return Promise.reject(new Error(`挂载根不存在：${m.root}（前缀 ${m.prefix}）`));
    }
  }
  const primary = list[0];

  /** 记录所有请求（供断言「有没有 404 / 越界」用） */
  const requests = [];

  const server = http.createServer((req, res) => {
    const url = new URL(req.url, `http://127.0.0.1:${port}`);
    const pathname = decodeURIComponent(url.pathname);
    const record = (status) => requests.push({ url: req.url, status });

    const mount = list.find((m) => pathname.startsWith(m.prefix));
    if (!mount) {
      record(404);
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end(`不在任何挂载前缀下：${list.map((m) => m.prefix).join(' / ')}`);
      return;
    }

    let rel = pathname.slice(mount.prefix.length);
    if (rel === '' || rel.endsWith('/')) rel += 'index.html';
    if (isDenied(rel)) {
      record(404);
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end(`拒绝提供该路径：${rel}`);
      return;
    }

    const target = path.join(mount.root, rel);
    // 路径穿越防护：解析后仍须落在该挂载根内
    if (!path.resolve(target).startsWith(mount.root)) {
      record(403);
      res.writeHead(403);
      res.end('forbidden');
      return;
    }
    fs.readFile(target, (err, buf) => {
      if (err) {
        record(404);
        res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end(`not found: ${rel}`);
        return;
      }
      record(200);
      res.writeHead(200, {
        'Content-Type': MIME[path.extname(target).toLowerCase()] || 'application/octet-stream',
        'Cache-Control': 'no-store',
      });
      res.end(buf);
    });
  });

  return new Promise((resolve, reject) => {
    server.once('error', (err) => {
      if (err && err.code === 'EADDRINUSE') {
        reject(new Error(`端口 ${port} 已被占用（strictPort 语义：不自动换端口）。`
          + '请先停掉占用者，或显式传 --port 指定另一个已登记端口。'));
        return;
      }
      reject(err);
    });
    server.listen(port, '127.0.0.1', () => {
      resolve({
        port,
        prefix: primary.prefix,
        url: `http://127.0.0.1:${port}${primary.prefix}`,
        mounts: list.map((m) => ({ ...m, url: `http://127.0.0.1:${port}${m.prefix}` })),
        requests,
        close: () => new Promise((done) => server.close(() => done())),
      });
    });
  });
}

module.exports = { startStaticServer, DEFAULT_PORT };
