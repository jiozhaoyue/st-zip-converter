/**
 * 端口守卫 —— **E2E 只许连 Dev** 的唯一实现点（不变量 I-4）
 *
 * 事实依据（`P-11`）：本机 `8001` Dev ST / `8002` Real ST / `8003` Dev Luker / `8004` Real Luker，
 * 且 **Dev 与 Real 的宿主版本号完全一致**（ST 1.19.0 / Luker 2.7.0），**版本号无法用于区分**。
 * 故「连错实例」是当前环境的最大风险，且后果不可逆（Real 侧是 GB 级真实聊天数据）。
 *
 * 三条配套约束（`tavern-browser-automation` skill 明列，缺一不可）：
 *  1. **启动时断言**，失败即抛错、非零退出（不是运行到一半才发现）；
 *  2. **环境变量不给默认值** —— 严禁 `?? 'http://127.0.0.1:8001'` 这类静默兜底，兜底值就是误连入口；
 *  3. **禁止自动改写目标** —— 不得因「端口被占用」回退到其它端口（改端口 = 换实例 = 换数据区）。
 *
 * @module e2e/lib/guard
 */

/** Dev 白名单：Dev ST / Dev Luker / PT web(dev) */
const DEV_PORTS = Object.freeze(new Set(['8001', '8003', '8899']));

/** Real 端口：出现即拒绝，并给出与「不在白名单」不同的、明确的误连告警 */
const REAL_PORTS = Object.freeze(new Set(['8002', '8004']));

/** L0-16：出厂默认段，任何脚本都不得绑定或请求 */
const FORBIDDEN_PORTS = Object.freeze(new Set(['8000']));

/**
 * 断言目标是允许自动化的 Dev 实例。
 * @param {string} rawUrl 目标基址；**必须显式提供**，空值即失败
 * @returns {URL}
 * @throws {Error} 未提供 / Real 端口 / 出厂默认端口 / 不在白名单
 */
function assertDevTarget(rawUrl) {
  if (rawUrl === undefined || rawUrl === null || String(rawUrl).trim() === '') {
    throw new Error('目标 URL 未提供：拒绝静默兜底（tavern-browser-automation + L1-MF-10）。'
      + '请显式传 --url / 设置环境变量，不要依赖默认值。');
  }

  let u;
  try {
    u = new URL(String(rawUrl));
  } catch {
    throw new Error(`目标 URL 无法解析：${rawUrl}`);
  }

  if (!u.port) {
    throw new Error(`目标 URL 未显式写端口（${rawUrl}）：`
      + '默认端口会按协议落到 80/443，等于目标不明 —— 拒绝启动。');
  }
  if (FORBIDDEN_PORTS.has(u.port)) {
    throw new Error(`拒绝启动：端口 ${u.port} 属酒馆出厂默认段，禁止绑定或请求（L0-16）。`);
  }
  if (REAL_PORTS.has(u.port)) {
    throw new Error(`拒绝启动：端口 ${u.port} 是 **Real 实例** 端口，疑似误连真实数据。`
      + '自动化只允许连 Dev（L1-MF-10 红线，误连不可逆）。');
  }
  if (!DEV_PORTS.has(u.port)) {
    throw new Error(`拒绝启动：端口 ${u.port} 不在 Dev 白名单 `
      + `${[...DEV_PORTS].join(' / ')}（tavern-browser-automation）。`
      + '若确需新增目标，请显式修改白名单并说明理由，不要绕过本守卫。');
  }
  return u;
}

/** 该端口是否属于 Real 实例（供报告/断言使用，不参与放行判断） */
function isRealPort(port) {
  return REAL_PORTS.has(String(port));
}

module.exports = { assertDevTarget, isRealPort, DEV_PORTS, REAL_PORTS, FORBIDDEN_PORTS };
