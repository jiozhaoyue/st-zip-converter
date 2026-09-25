/**
 * 实例启动器 —— 按登记端口启动酒馆/类酒馆实例，并**有界等待**就绪
 *
 * 用法：
 *   node scripts/instance-sync/start-instance.cjs --id real-luker
 *   node scripts/instance-sync/start-instance.cjs --id pt-web --timeout 300
 *
 * 纪律：
 *  - 端口一律取自 `e2e/lib/instances.cjs` 的登记值；**禁止 8000**（L0-16）。
 *  - 就绪判定是**有界等待**（L1-MR-7）：超过 `--timeout` 即杀进程并非零退出，绝不已 pending 收场。
 *  - 端口已经是活的 → 直接报「已在运行」，不重复拉起（幂等）。
 *  - 日志落 `test-results/instance-logs/<id>.log`（**不入库**，且**严禁**写进 `Instance/**`）。
 */

const { spawn } = require('child_process');
const fs = require('fs');
const net = require('net');
const https = require('https');
const path = require('path');

const { INSTANCES, REPO_ROOT, getInstance } = require('../../e2e/lib/instances.cjs');

const LOG_DIR = path.join(REPO_ROOT, 'test-results', 'instance-logs');
const FORBIDDEN_PORT = 8000; // L0-16：出厂默认段，禁止绑定或请求

function parseArgs(argv) {
  const out = { id: '', timeout: 180 };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--id') out.id = argv[++i] || '';
    else if (argv[i] === '--timeout') out.timeout = Number(argv[++i]) || 180;
  }
  return out;
}

/** TCP 层是否有人监听（不区分协议） */
function probeTcp(port, host = '127.0.0.1', timeoutMs = 1500) {
  return new Promise((resolve) => {
    const sock = net.connect({ port, host });
    const done = (ok) => { sock.destroy(); resolve(ok); };
    sock.setTimeout(timeoutMs);
    sock.once('connect', () => done(true));
    sock.once('timeout', () => done(false));
    sock.once('error', () => done(false));
  });
}

/** HTTP(S) 层是否已在服务（任何状态码都算「在服务」） */
function probeHttp(url, timeoutMs = 3000) {
  return new Promise((resolve) => {
    const u = new URL(url);
    const mod = u.protocol === 'https:' ? https : require('http');
    const req = mod.request(
      { protocol: u.protocol, hostname: u.hostname, port: u.port, path: '/', method: 'GET',
        rejectUnauthorized: false, timeout: timeoutMs },
      (res) => { res.resume(); resolve({ ok: true, status: res.statusCode }); },
    );
    req.on('timeout', () => { req.destroy(); resolve({ ok: false, reason: 'timeout' }); });
    req.on('error', (e) => resolve({ ok: false, reason: e.code || e.message }));
    req.end();
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const { id, timeout } = parseArgs(process.argv.slice(2));
  if (!id) {
    console.error('用法：node scripts/instance-sync/start-instance.cjs --id <'
      + Object.keys(INSTANCES).join('|') + '>');
    process.exit(2);
  }
  const inst = getInstance(id);
  if (inst.port === FORBIDDEN_PORT) {
    console.error(`拒绝启动：端口 ${FORBIDDEN_PORT} 是出厂默认段，禁止使用（L0-16）`);
    process.exit(2);
  }

  // 幂等：已经在跑就不重复拉起
  if (await probeTcp(inst.port)) {
    const http = await probeHttp(inst.url);
    console.log(`[${id}] 端口 ${inst.port} 已在监听（HTTP ${http.status ?? http.reason}）—— 不重复启动`);
    process.exit(0);
  }

  fs.mkdirSync(LOG_DIR, { recursive: true });
  const logPath = path.join(LOG_DIR, `${id}.log`);
  const logFd = fs.openSync(logPath, 'a');
  fs.writeSync(logFd, `\n===== start ${new Date().toISOString()} :: ${inst.startCmd.join(' ')} =====\n`);

  console.log(`[${id}] 启动：${inst.startCmd.join(' ')}（cwd=${inst.startCwd}，端口 ${inst.port}）`);
  const child = spawn(inst.startCmd[0], inst.startCmd.slice(1), {
    cwd: inst.startCwd,
    stdio: ['ignore', logFd, logFd],
    detached: true,
    windowsHide: true,
    shell: process.platform === 'win32', // pnpm / node 在 Windows 上经 shell 解析
  });
  child.unref();

  const pidFile = path.join(LOG_DIR, `${id}.pid`);
  fs.writeFileSync(pidFile, String(child.pid || ''), 'utf8');

  const deadline = Date.now() + timeout * 1000;
  let last = '未响应';
  while (Date.now() < deadline) {
    if (await probeTcp(inst.port)) {
      const http = await probeHttp(inst.url);
      if (http.ok) {
        console.log(`[${id}] 就绪：HTTP ${http.status} @ ${inst.url}（pid=${child.pid}，日志 ${logPath}）`);
        fs.writeSync(logFd, `----- ready ${new Date().toISOString()} -----\n`);
        fs.closeSync(logFd);
        process.exit(0);
      }
      last = `TCP 已开但 HTTP ${http.reason}`;
    }
    await sleep(1000);
  }

  fs.writeSync(logFd, `----- TIMEOUT after ${timeout}s -----\n`);
  fs.closeSync(logFd);
  console.error(`[${id}] 启动超时（${timeout}s，最后状态：${last}）。日志：${logPath}`);
  try { process.kill(-child.pid); } catch { try { process.kill(child.pid); } catch { /* 已退出 */ } }
  process.exit(1);
})();
