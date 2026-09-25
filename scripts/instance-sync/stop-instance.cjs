/**
 * 实例停止器 —— **只关本次启动的实例**（AC-11 / 不变量 I-6）
 *
 * 为什么「只关本次启动的」：本机取证时 `8003`（Dev Luker）与 `8004`（Real Luker）
 * **本来就在运行**（是用户环境），收尾时**必须保持原样**。
 * 故本脚本以 `start-instance.cjs` 落下的 **pidfile 存在与否**作判据：
 * 没有 pidfile 就说明不是本次启动的，**拒绝停止**。
 *
 * 用法：
 *   node scripts/instance-sync/stop-instance.cjs --id dev-st
 *   node scripts/instance-sync/stop-instance.cjs --id dev-st --force   # 端口仍占用时强杀
 */

const fs = require('fs');
const net = require('net');
const path = require('path');
const { execFileSync } = require('child_process');

const { REPO_ROOT, getInstance } = require('../../e2e/lib/instances.cjs');

const LOG_DIR = path.join(REPO_ROOT, 'test-results', 'instance-logs');

function parseArgs(argv) {
  const out = { id: '', force: false };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--id') out.id = argv[++i] || '';
    else if (argv[i] === '--force') out.force = true;
  }
  return out;
}

function probeTcp(port, timeoutMs = 1500) {
  return new Promise((resolve) => {
    const sock = net.connect({ port, host: '127.0.0.1' });
    const done = (ok) => { sock.destroy(); resolve(ok); };
    sock.setTimeout(timeoutMs);
    sock.once('connect', () => done(true));
    sock.once('timeout', () => done(false));
    sock.once('error', () => done(false));
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * 查某端口当前的监听进程 PID（无监听则返回 null）。
 * 只用于「停止」，**不参与「连哪个实例」的判定** —— 目标一律由端口登记值决定（P-11）。
 */
function findListenerPid(port) {
  try {
    if (process.platform === 'win32') {
      const out = execFileSync('netstat', ['-ano'], { encoding: 'utf8' });
      const pids = new Set();
      for (const line of out.split('\n')) {
        const cols = line.trim().split(/\s+/);
        // 列序：Proto 本地地址 外部地址 状态 PID —— 必须先匹配端口再判 LISTENING（顺序写反会永远匹配不到）
        if (cols.length < 5) continue;
        if (!cols[1].endsWith(`:${port}`)) continue;
        if (cols[3] !== 'LISTENING') continue;
        pids.add(Number(cols[4]));
      }
      const first = [...pids].filter((n) => Number.isInteger(n) && n > 0)[0];
      return first || null;
    }
    const out = execFileSync('sh', ['-c', `lsof -ti tcp:${port} -sTCP:LISTEN`], { encoding: 'utf8' });
    const first = Number(String(out).trim().split('\n')[0]);
    return Number.isInteger(first) && first > 0 ? first : null;
  } catch {
    return null;
  }
}

(async () => {
  const { id, force } = parseArgs(process.argv.slice(2));
  if (!id) {
    console.error('用法：node scripts/instance-sync/stop-instance.cjs --id <instance>');
    process.exit(2);
  }
  const inst = getInstance(id);
  const pidFile = path.join(LOG_DIR, `${id}.pid`);

  if (!fs.existsSync(pidFile)) {
    console.error(`[${id}] 拒绝停止：没有本次启动的 pidfile（${pidFile}）。`);
    console.error('        该实例不是本次会话启动的 ⇒ 视为用户既有环境，收尾时必须保持原样。');
    process.exit(1);
  }

  const recordedPid = Number(fs.readFileSync(pidFile, 'utf8').trim());

  /**
   * 真正要杀的是**端口当前的监听进程**，不是 pidfile 里那个 pid。
   *
   * 实测教训（2026-09-26）：`start-instance.cjs` 在 Windows 上经 `shell: true` 启动，
   * pidfile 记下的是 **shell 包装进程**的 pid（实测 60880），真正监听的是它的子进程
   * `node server.js`（实测 76828）—— 直接 `taskkill /PID <包装进程>` 报「进程可能已退出」
   * 而**端口仍在监听**。故：**pidfile 只作「本次启动」的归属凭证，杀谁由端口决定**。
   */
  const listenerPid = findListenerPid(inst.port);
  if (!listenerPid) {
    console.log(`[${inst.id}] 端口 ${inst.port} 已无监听进程（pidfile 记录的 ${recordedPid}）；`
      + '清理 pidfile 后收工');
    fs.rmSync(pidFile, { force: true });
    return;
  }

  // Windows 下 node 经 shell 启动，实际监听进程可能是子进程 ⇒ 用 taskkill /T 杀整棵树
  try {
    if (process.platform === 'win32') execFileSync('taskkill', ['/PID', String(listenerPid), '/T', '/F'], { stdio: 'ignore' });
    else process.kill(-listenerPid);
    console.log(`[${inst.id}] 已发送停止信号（监听 pid=${listenerPid}，pidfile 记录 ${recordedPid}，含子树）`);
  } catch (e) {
    console.warn(`[${inst.id}] 停止命令返回非零（进程可能已退出）：${e.message}`);
  }

  for (let i = 0; i < 15; i += 1) {
    if (!(await probeTcp(inst.port))) break;
    await sleep(1000);
  }

  const stillUp = await probeTcp(inst.port);
  if (stillUp) {
    console.error(`[${id}] 端口 ${inst.port} 仍在监听 —— 未确认停止${force ? '（--force 已给出，但本实现不做更强手段，请人工处理）' : ''}`);
    process.exit(1);
  }

  fs.rmSync(pidFile, { force: true });
  console.log(`[${id}] 已停止，端口 ${inst.port} 已释放`);
})().catch((e) => {
  console.error('停止失败：', e);
  process.exit(1);
});
