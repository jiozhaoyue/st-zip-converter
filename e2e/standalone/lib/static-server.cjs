/**
 * 静态站点服务器 —— 只为「独立 Web 形态 / 云部署形态」的自动化验证用
 *
 * 为什么要自己写：`vite preview` 只能挂在根路径，而**云酒馆/静态托管的真实形态是子路径**
 * （GitHub Pages 项目页 = `https://<user>.github.io/<repo>/`）。构建产物用的是
 * `base: './'`（`vite.config.js`），子路径可用性正是需要被自动化证明的事，故这里支持
 * `--prefix` 把站点挂在任意前缀下。
 *
 * 纪律：
 *  - **只读**：只从 `dist/` 读文件，不写任何东西；
 *  - 端口显式登记（`L0-16`）：默认 `4173`（已登记为 Vite preview 段），`strictPort` 语义——
 *    被占用即**报错退出**，绝不自动换端口（换端口 = 换目标 = 读数不可解释）；
 *  - 不给 `dist/` 之外的文件任何访问路径（路径穿越防护）。
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

/**
 * 启动静态服务器。
 * @param {object} options
 * @param {string} options.root 站点根目录（绝对路径，通常是 `<repo>/dist`）
 * @param {string} [options.prefix='/'] 挂载前缀，形如 `/st-zip-converter/`；`/` 表示根路径
 * @param {number} [options.port]
 * @returns {Promise<{url: string, prefix: string, port: number, close: function(): Promise<void>, requests: Array<{url: string, status: number}>}>}
 */
function startStaticServer({ root, prefix = '/', port = DEFAULT_PORT } = {}) {
  const rootAbs = path.resolve(root);
  if (!fs.existsSync(path.join(rootAbs, 'index.html'))) {
    return Promise.reject(new Error(`站点根目录没有 index.html：${rootAbs}（先跑 npm run build）`));
  }
  // 归一前缀：必须以 / 开头、以 / 结尾
  let pre = prefix.startsWith('/') ? prefix : `/${prefix}`;
  if (!pre.endsWith('/')) pre += '/';

  /** 记录所有请求（供断言「有没有 404」用） */
  const requests = [];

  const server = http.createServer((req, res) => {
    const url = new URL(req.url, `http://127.0.0.1:${port}`);
    let pathname = decodeURIComponent(url.pathname);
    const record = (status) => requests.push({ url: req.url, status });

    if (!pathname.startsWith(pre)) {
      record(404);
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end(`不在挂载前缀 ${pre} 下`);
      return;
    }
    let rel = pathname.slice(pre.length);
    if (rel === '' || rel.endsWith('/')) rel += 'index.html';

    const target = path.join(rootAbs, rel);
    // 路径穿越防护：解析后仍须落在 rootAbs 内
    if (!path.resolve(target).startsWith(rootAbs)) {
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
        prefix: pre,
        url: `http://127.0.0.1:${port}${pre}`,
        requests,
        close: () => new Promise((done) => server.close(() => done())),
      });
    });
  });
}

module.exports = { startStaticServer, DEFAULT_PORT };
