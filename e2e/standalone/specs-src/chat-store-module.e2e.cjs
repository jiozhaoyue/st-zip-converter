/**
 * 聊天库适配 · **真实模块在真实浏览器里跑一遍**（桩供给方）
 *
 * ## 为什么放在 `specs-src/`（挂源码树）而不是 `specs/`（挂构建产物）
 *
 * 构建产物是**单包**，模块边界被打散 ⇒ 无法在页内 `import` 单个模块。源码树里每个模块是独立
 * 文件，于是可以在真实浏览器环境（真 `Blob`、真 `Worker`、真 `zip.js`）里直接驱动
 * `chat-store-inject.js` 与 `worker-client.js`，跑完整链路：
 *
 *     建源包 → 探测/列出库索引 → 与源包比对 → 只导出缺失项 → 注入 → **真实转换** → 解包核对
 *
 * 为什么不放到实例侧：宿主拉取路径才是接线点，而拉一遍 Dev 实例的 1.5 GB 数据
 * 只为验这段逻辑，代价过高（那份验证登记为残留）。本 spec 覆盖的是**模块与链路**，
 * 不含 `btn-host-fetch` 那段按钮接线 —— 这点在断言命名里如实写明，不冒充分。
 *
 * ## 判据
 * 源包优先（同名不得被顶替）· 补齐（缺失项必须在产物里且内容相符）·
 * 隐藏容器过滤 · **判别力对照**（不注入桩 ⇒ 补齐必须消失）。
 */

const { openSite, waitForReady } = require('../lib/harness.cjs');

/** 桩供给方（注入页面；装作纯库模式的聊天库插件） */
const STUB = ({ chats }) => {
  globalThis.__stubCalls = { list: 0, export: [], import: [] };
  globalThis.ChatFilesysApi = Object.freeze({
    apiVersion: 1,
    capabilities: Object.freeze({ list: true, export: true, import: true }),
    mode: () => 'pure',
    listChats: async () => { globalThis.__stubCalls.list += 1; return chats; },
    exportChat: async ({ fileName }) => {
      globalThis.__stubCalls.export.push(fileName);
      return `${JSON.stringify({ name: 'You', is_user: true, mes: `from-library:${fileName}` })}\n`;
    },
    importChat: async ({ fileName }) => { globalThis.__stubCalls.import.push(fileName); return { ok: true }; },
  });
};

/** 库索引：同名一条（源包优先）· 缺失一条（补齐）· 隐藏容器一条（过滤） */
const LIBRARY_CHATS = [
  { fileName: '2026-09-01.jsonl', chatName: 'fixture-chat' },
  { fileName: 'Fixture Character/库里独有.jsonl', chatName: 'only-in-library' },
  { fileName: '__cfsys__内部探针.jsonl', chatName: 'hidden' },
];

const ON_DISK_PATH = 'chats/Fixture Character/2026-09-01.jsonl';
const INJECTED_PATH = 'chats/Fixture Character/库里独有.jsonl';
const ORIGINAL_TEXT = `${JSON.stringify({ name: 'You', is_user: true, mes: 'on-disk-original' })}\n`;

/**
 * 在页面里跑完整链路。
 * @param {{srcBase: string}} arg
 * @returns {Promise<object>} 读数（全部可序列化）
 */
async function runPipelineInPage({ srcBase }) {
  const zipIo = (await import(`${srcBase}src/core/zip-io.js`)).zipIo;
  const { injectLibraryChatsIntoSource } = await import(`${srcBase}src/ui/chat-store-inject.js`);
  const { runConversionTask } = await import(`${srcBase}src/core/worker-client.js`);

  const sourceText = JSON.stringify({ name: 'You', is_user: true, mes: 'on-disk-original' }) + '\n';
  const writer = await zipIo.createWriter(undefined, { level: 1 });
  await writer.add('chats/Fixture Character/2026-09-01.jsonl', sourceText);
  await writer.add('settings.json', '{"theme":"dark"}');
  const blobWriter = await writer.close();
  const sourceBlob = await blobWriter.getData();

  const probeBefore = globalThis.__stZipConverterDebug?.getChatStoreProbe?.() || null;

  const injected = await injectLibraryChatsIntoSource(sourceBlob, { compressionLevel: 1 });

  const { resultBlob } = await runConversionTask({
    source: injected.source,
    target: 'st',
    options: { compressionLevel: 1 },
  });

  const names = [];
  const contents = {};
  const reader = await zipIo.openReader(resultBlob);
  try {
    for await (const entry of reader.entries()) {
      names.push(entry.fileName);
      contents[entry.fileName] = new TextDecoder('utf-8').decode(await entry.read());
    }
  } finally {
    await reader.close();
  }

  return {
    probeBefore,
    probeAfter: globalThis.__stZipConverterDebug?.getChatStoreProbe?.() || null,
    injectedCount: injected.injected,
    attempted: injected.attempted,
    failed: injected.failed,
    skippedReason: injected.skippedReason,
    sourceIsOriginal: injected.source === sourceBlob,
    productNames: names,
    productTexts: contents,
    sourceText,
    stubCalls: globalThis.__stubCalls,
  };
}

module.exports = {
  name: '聊天库适配：真实模块 + 真 Blob + 真转换（桩供给方）',
  async run(t, h, ctx) {
    const page = h.page;

    // ============ ① 有桩 ============
    await page.addInitScript(STUB, { chats: LIBRARY_CHATS });
    await page.goto(ctx.baseUrl, { waitUntil: 'domcontentloaded' });
    t.ok('M1 页面就绪（源码树形态）', Boolean(await waitForReady(page)));

    const run1 = await page.evaluate(runPipelineInPage, { srcBase: ctx.srcUrl });

    t.ok('M2 只读探针读到桩供给方（present / mode=pure）',
      Boolean(run1.probeBefore) && run1.probeBefore.present === true && run1.probeBefore.mode === 'pure',
      JSON.stringify(run1.probeBefore));
    t.ge('M3 桩的 listChats 被真实调用', run1.stubCalls.list, 1, JSON.stringify(run1.stubCalls));
    t.ok('M4 只导出**源包缺的那条**；同名条目与隐藏容器都不导出',
      run1.stubCalls.export.length === 1 && run1.stubCalls.export[0] === 'Fixture Character/库里独有.jsonl',
      JSON.stringify(run1.stubCalls.export));
    t.eq('M5 注入计数 = 1（不多不少）', run1.injectedCount, 1, JSON.stringify({
      injected: run1.injectedCount, failed: run1.failed, skipped: run1.skippedReason,
    }));

    t.ok('M6 产物里出现补齐的那条（保留角色子目录）',
      run1.productNames.includes(INJECTED_PATH),
      JSON.stringify(run1.productNames.filter((n) => n.startsWith('chats/'))));
    t.ok('M7 补齐条目内容 = 桩返回的内容（不是空壳）',
      (run1.productTexts[INJECTED_PATH] || '').includes('from-library:Fixture Character/库里独有.jsonl'),
      JSON.stringify((run1.productTexts[INJECTED_PATH] || '').slice(0, 80)));
    t.ok('M8 同名条目**逐字等于源包原文**（没有被库内容顶替）',
      run1.productTexts[ON_DISK_PATH] === ORIGINAL_TEXT,
      JSON.stringify((run1.productTexts[ON_DISK_PATH] || '').slice(0, 80)));
    t.ok('M9 隐藏容器条目没有进产物',
      !run1.productNames.some((n) => n.includes('__cfsys__')),
      JSON.stringify(run1.productNames.filter((n) => n.includes('__cfsys__'))));
    t.eq('M10 产物里非聊天条目照常在场（转换本身没被破坏）',
      run1.productNames.includes('settings.json'), true, JSON.stringify(run1.productNames));
    t.ok('M11 探针记下了「实际导出/失败」读数（可诊断）',
      Boolean(run1.probeAfter) && run1.probeAfter.lastExportOk === 1 && run1.probeAfter.lastListCount === 3,
      JSON.stringify(run1.probeAfter));

    // ============ ② 判别力对照：不注入桩 ============
    const h2 = await openSite(ctx.baseUrl);
    try {
      await h2.goto();
      t.ok('M12 对照组页面就绪（无桩）', Boolean(await waitForReady(h2.page)));
      const run2 = await h2.page.evaluate(runPipelineInPage, { srcBase: ctx.srcUrl });

      t.eq('M13 无桩时探针判为「未检测到聊天库」', run2.probeBefore ? run2.probeBefore.present : null,
        false, JSON.stringify(run2.probeBefore));
      t.eq('M14 【判别力】无桩 ⇒ 注入 0 条', run2.injectedCount, 0, JSON.stringify({
        injected: run2.injectedCount, skipped: run2.skippedReason,
      }));
      t.ok('M15 【判别力】无桩 ⇒ 源包缺的那条**不在产物里**（证明 M6 真的依赖接缝）',
        !run2.productNames.some((n) => n.includes('库里独有')),
        JSON.stringify(run2.productNames.filter((n) => n.startsWith('chats/'))));
      t.ok('M16 对照组里源包原有条目照常在场（对照组本身有效，不是空跑）',
        run2.productNames.includes(ON_DISK_PATH), JSON.stringify(run2.productNames));
    } finally {
      await h2.close();
    }

    t.eq('M17 全流程零未捕获页面异常', h.rec.pageErrors.length, 0,
      JSON.stringify(h.rec.pageErrors.slice(0, 2)));
  },
};
