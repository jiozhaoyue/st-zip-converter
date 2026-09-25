/**
 * 端口守卫 spec —— **负例优先**：先证明判定能抓到违规，再相信别处报 0
 *
 * I-4（红线）：E2E 只许连 Dev 白名单 {8001, 8003, 8899}；出现 Real 端口（8002 / 8004）
 * 必须**在启动时**显式失败。本仓 `P-11` 明确：本机 Dev/Real 的宿主版本号**完全一致**
 * （ST 1.19.0 / Luker 2.7.0），版本号无法区分实例 —— 连错即操作 GB 级真实聊天数据，**不可逆**。
 *
 * 本 spec 不启动浏览器，纯断言守卫本身；其中最后一条验证**守卫真的接进了自动化路径**
 * （`harness.openInstance` 对 Real 端口必须在启动浏览器之前就抛错）。
 */

const { assertDevTarget, isRealPort, DEV_PORTS, REAL_PORTS, FORBIDDEN_PORTS } = require('../lib/guard.cjs');
const { openInstance } = require('../lib/harness.cjs');
const { getInstance } = require('../lib/instances.cjs');

/** 期望某次调用抛错 */
function throws(t, label, fn, expectInMessage = '') {
  let err = null;
  try { fn(); } catch (e) { err = e; }
  if (!err) return t.ok(label, false, '预期抛错但没有');
  if (expectInMessage && !String(err.message).includes(expectInMessage)) {
    return t.ok(label, false, `错误信息未含「${expectInMessage}」：${err.message.slice(0, 80)}`);
  }
  return t.ok(label, true, err.message.slice(0, 64));
}

module.exports = {
  name: 'guard：端口守卫与 Real 拒绝（负例优先）',

  async run(t) {
    // —— 集合本身的一致性 ——
    t.ok('Dev 白名单 = {8001,8003,8899}',
      DEV_PORTS.size === 3 && ['8001', '8003', '8899'].every((p) => DEV_PORTS.has(p)),
      [...DEV_PORTS].join('/'));
    t.ok('白名单里**不含**任何 Real 端口',
      [...REAL_PORTS].every((p) => !DEV_PORTS.has(p)), [...REAL_PORTS].join('/'));
    t.ok('Real 端口 = {8002,8004}',
      REAL_PORTS.size === 2 && isRealPort('8002') && isRealPort('8004'));
    t.ok('8000 被列为禁止端口（L0-16）', FORBIDDEN_PORTS.has('8000'));

    // —— 负例：Real 端口必须被点名拒绝（先于「不在白名单」） ——
    throws(t, 'Real ST :8002 被拒且点名 Real',
      () => assertDevTarget('https://127.0.0.1:8002'), 'Real');
    throws(t, 'Real Luker :8004 被拒且点名 Real',
      () => assertDevTarget('https://127.0.0.1:8004'), 'Real');

    // —— 负例：无默认值（静默兜底就是误连入口） ——
    throws(t, '空字符串被拒', () => assertDevTarget(''));
    throws(t, 'undefined 被拒', () => assertDevTarget(undefined));
    throws(t, '纯空白被拒', () => assertDevTarget('   '));

    // —— 负例：其它不该放行的形态 ——
    throws(t, '未写端口的 URL 被拒', () => assertDevTarget('https://127.0.0.1/'), '未显式写端口');
    throws(t, '8000（出厂默认段）被拒', () => assertDevTarget('http://127.0.0.1:8000'), '8000');
    throws(t, '非白名单端口 5173 被拒', () => assertDevTarget('http://127.0.0.1:5173'), '白名单');
    throws(t, '不可解析的 URL 被拒', () => assertDevTarget('not a url at all'));

    // —— 正例：三个 Dev 目标放行且端口原样保留 ——
    for (const [url, port] of [['https://127.0.0.1:8001', '8001'],
      ['http://127.0.0.1:8003', '8003'], ['http://127.0.0.1:8899', '8899']]) {
      let parsed = null;
      let err = null;
      try { parsed = assertDevTarget(url); } catch (e) { err = e; }
      t.ok(`Dev ${port} 放行`, parsed !== null && parsed.port === port, err ? err.message : '');
    }

    // —— 集成：守卫**真的**接在自动化路径上（不是只写了个函数没人用） ——
    // 把实例登记的 URL 换成 Real 端口，openInstance 必须在**启动浏览器之前**抛错。
    const probe = { ...getInstance('dev-st'), url: 'https://127.0.0.1:8002' };
    let launched = false;
    let err = null;
    try {
      const h = await openInstance(probe);
      launched = true; // 若真启动了就立刻关掉，避免留下浏览器
      await h.close();
    } catch (e) { err = e; }
    t.ok('openInstance 对 Real 端口在启动浏览器前抛错',
      !launched && err !== null && String(err.message).includes('Real'),
      launched ? '竟启动了浏览器！' : (err ? err.message.slice(0, 64) : '未抛错'));
  },
};
