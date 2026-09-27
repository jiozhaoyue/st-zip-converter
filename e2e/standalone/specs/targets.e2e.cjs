/**
 * 目标平台兼容矩阵（**同一份源包连转四目标**）+ 包选择预设（精简 / 默认 / 完整）
 *
 * 为什么要有这条：实例侧的矩阵（`e2e/specs/matrix.e2e.cjs`）要开实例、跑在宿主里；
 * 而「转换到某个目标平台的**落位形态**对不对」是**纯转换逻辑**，独立形态就能验，
 * 且能便宜地把 **4 目标 × 包选择** 的组合矩阵跑一遍（不需要实例、不需要实例数据）。
 *
 * 落位规则取自仓内权威文档 `.trellis/spec/guides/tavern-datapack-formats.md`
 * 「包布局速查」（该文档标注了证据分级，本 spec 只断言其中的**〔仓内〕**条）：
 *  - **ST**：zip 根摊平 ST 用户目录（`characters/`、`settings.json`）；
 *  - **L**：同 ST 摊平 **+ 根 `manifest.json`**（带 `schemaVersion`）；
 *  - **TT**：`data/` 根，用户数据在 `data/default-user/`；第三方扩展在
 *    `data/extensions/third-party/<name>/`；
 *  - **PT**：与 TT 同布局（`data/default-user/`），用户级扩展被迁移为 third-party 布局
 *    **并合成来源记录**（`data/_tauritavern/extension-sources/…`）。
 *
 * ⚠️ 判定纪律：每条断言都先要一个**非空读数**（产物条目数 > 0），
 * 否则「不含某个前缀」这类否命题在空包上恒真。
 */

const common = require('../lib/common.cjs');

/** 目标 → 该目标的落位判据（每条都是「必须有 / 必须没有」的具体路径谓词） */
const TARGET_RULES = {
  st: {
    label: 'SillyTavern',
    mustHave: ['characters/', 'chats/', 'settings.json'],
    mustNotHavePrefix: ['data/'],
  },
  l: {
    label: 'Luker',
    mustHave: ['manifest.json', 'characters/', 'chats/', 'settings.json'],
    mustNotHavePrefix: ['data/'],
  },
  tt: {
    label: 'TauriTavern',
    mustHave: ['data/default-user/characters/', 'data/default-user/chats/', 'data/extensions/third-party/'],
    mustNotHavePrefix: [],
  },
  pt: {
    label: 'PureTavern',
    mustHave: ['data/default-user/characters/', 'data/default-user/chats/', 'data/extensions/third-party/'],
    mustNotHavePrefix: [],
  },
};

const hasPrefix = (names, p) => names.some((n) => n.startsWith(p));

module.exports = {
  name: '目标平台兼容矩阵 + 包选择预设（四目标连转 · 独立形态）',
  async run(t, h, ctx) {
    const { page, rec } = h;

    t.ok('T1 工作台就绪', Boolean(await ctx.waitForReady(page)));

    const fixtures = await common.ensureFixtures(ctx.fixtureDir);
    const sourcePath = fixtures['fixture-st.zip'];
    await page.setInputFiles('#file-input', sourcePath);
    t.ok('T2 上传源包后计划预览就绪', await common.waitForPlan(page));

    // 前置门：源包真的被解析出内容（否则后面所有「不含…」的断言都是恒真）
    const full = {
      chars: await common.readCategory(page, 'characters'),
      chats: await common.readCategory(page, 'chats'),
      lorebooks: await common.readCategory(page, 'lorebooks'),
      secrets: await common.readCategory(page, 'secrets'),
    };
    t.ge('T3 前置门：源包解析出角色卡', full.chars.count, 1, JSON.stringify(full.chars));
    t.ge('T4 前置门：源包解析出聊天记录', full.chats.count, 1, JSON.stringify(full.chats));

    // ============ ① 默认 = 「轻量清单」模式（扩展实体**不打包**）============
    // ⚠️ 首版这里断言「扩展在 third-party 下」⇒ 三条假红。查证：UI 的扩展模式 radio
    //    **默认选中 `manifest`**（`workbench-template.js:176` 的 `checked`），而该模式按设计
    //    「不打包扩展实体代码，但合成索引与安装脚本」。断言少了这个前提 ⇒ 预期本身是错的。
    const defaultMode = await page.$eval('input[name="extension-mode"]:checked', (el) => el.value);
    t.eq('T5 默认扩展模式 = 轻量清单（后续断言的**前提**，必须显式记录）', defaultMode, 'manifest');

    await page.selectOption('#target-select', 'st');
    await page.click('#btn-convert');
    const liteNames = await common.waitForQueue(page, 1);
    t.ok('T6 轻量清单模式转换完成', Array.isArray(liteNames) && liteNames.length >= 1,
      JSON.stringify(liteNames));
    const lite = await common.readZip(
      await common.downloadNthRow(page, 0, ctx.fixtureDir, 'extmode-manifest.zip'),
    );
    t.ge('T7 轻量清单产物非空（前置门）', lite.names.length, 1, `entries=${lite.names.length}`);
    t.ok('T8 轻量清单**不打包扩展实体代码**（与默认模式语义一致）',
      !lite.names.some((n) => n.startsWith('extensions/test-extension/')),
      JSON.stringify(lite.names.filter((n) => n.includes('test-extension'))));
    t.ok('T9 轻量清单仍**合成安装物料与索引**（不是「什么都不做」）',
      lite.names.includes('_convert/INSTALL.md') && lite.names.includes('extensions-index.json'),
      JSON.stringify(lite.names.filter((n) => n.startsWith('_convert/') || n.endsWith('.json'))));
    let rowIndex = 1;

    // ============ ② 切到「完整」模式后跑四目标兼容矩阵 ============
    // 扩展模式的 radio 在**折叠区**里 ⇒ 可见性门会超时（实测：`check()` 30s、`check({force})`
    // 也点不动 —— 元素本身没被渲染到可点位置）。故走 DOM 事件路径，
    // 随后由 T10 **回读**确认真的切过去了（回读才是判据，动作方式不是）。
    await page.evaluate(() => {
      const el = document.querySelector('input[name="extension-mode"][value="full"]');
      if (!el) return;
      el.checked = true;
      el.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await page.waitForTimeout(150);
    t.eq('T10 扩展模式已切到「完整」（可打包扩展实体代码）',
      await page.$eval('input[name="extension-mode"]:checked', (el) => el.value), 'full');

    for (const target of ['st', 'l', 'tt', 'pt']) {
      const rule = TARGET_RULES[target];
      await page.selectOption('#target-select', target);
      await page.waitForTimeout(150);
      await page.click('#btn-convert');
      const names = await common.waitForQueue(page, rowIndex + 1);
      if (!t.ok(`T-${target}.1 转换完成并出现在待导出区`, Array.isArray(names) && names.length >= rowIndex + 1,
        JSON.stringify(names))) {
        break;
      }

      const out = await common.downloadNthRow(page, rowIndex, ctx.fixtureDir, `target-${target}.zip`);
      rowIndex += 1;
      const product = await common.readZip(out);

      t.ge(`T-${target}.2 产物是合法 zip 且条目数 > 0（前置门）`, product.names.length, 1,
        `entries=${product.names.length}`);
      for (const path of rule.mustHave) {
        t.ok(`T-${target}.3 落位含 ${path}（${rule.label}）`, hasPrefix(product.names, path),
          JSON.stringify(product.names.slice(0, 8)));
      }
      for (const prefix of rule.mustNotHavePrefix) {
        t.ok(`T-${target}.4 落位**不含** ${prefix} 前缀（${rule.label}）`,
          !hasPrefix(product.names, prefix),
          JSON.stringify(product.names.filter((n) => n.startsWith(prefix)).slice(0, 4)));
      }
      // 聊天内容必须跟着走（跨目标搬运的核心目的）
      t.ok(`T-${target}.5 聊天条目确实在产物里（不是只剩合成物）`,
        product.names.some((n) => n.includes('/chats/') || n.startsWith('chats/')),
        JSON.stringify(product.names.filter((n) => n.includes('chats')).slice(0, 4)));
    }

    // PT 目标特有：用户级扩展被迁移为 third-party 且**必须合成来源记录**
    // 〔仓内〕tavern-datapack-formats.md 第 3 条：没有来源记录 PT 会丢弃该扩展。
    const ptProduct = await common.readZip(`${ctx.fixtureDir}/target-pt.zip`).catch(() => null);
    if (ptProduct) {
      t.ok('T-pt.6 用户级扩展被迁移进 data/extensions/third-party/',
        hasPrefix(ptProduct.names, 'data/extensions/third-party/'),
        JSON.stringify(ptProduct.names.filter((n) => n.includes('third-party')).slice(0, 4)));
      t.ok('T-pt.7 合成了扩展来源记录（否则 PT 会丢弃该扩展）',
        ptProduct.names.some((n) => n.startsWith('data/_tauritavern/extension-sources/')),
        JSON.stringify(ptProduct.names.filter((n) => n.includes('extension-sources')).slice(0, 4)));
    }

    // ============ ② 包选择预设：「精简」 vs 「完整」 ============
    // 「仅聊天记录」= 联动恒开 ⇒ chats + characters + assets（见 category-filter.js 的既有裁决）
    await page.click('[data-preset="chats"]');
    await page.waitForTimeout(200);
    await page.selectOption('#target-select', 'st');
    await page.click('#btn-convert');
    const slimNames = await common.waitForQueue(page, rowIndex + 1);
    t.ok('T-slim.1 精简包转换完成', Array.isArray(slimNames) && slimNames.length >= rowIndex + 1,
      JSON.stringify(slimNames));
    const slim = await common.readZip(
      await common.downloadNthRow(page, rowIndex, ctx.fixtureDir, 'preset-slim.zip'),
    );
    rowIndex += 1;
    t.ge('T-slim.2 精简包非空（前置门）', slim.names.length, 1, `entries=${slim.names.length}`);
    t.ok('T-slim.3 精简包保留聊天记录',
      slim.names.some((n) => n.startsWith('chats/')), JSON.stringify(slim.names.slice(0, 6)));
    t.ok('T-slim.4 精简包**丢掉世界书**（收窄真的生效）',
      !slim.names.some((n) => n.startsWith('worlds/')),
      JSON.stringify(slim.names.filter((n) => n.startsWith('worlds/'))));
    t.ok('T-slim.5 精简包**丢掉系统设置与密钥**（收窄真的生效）',
      !slim.names.includes('settings.json') && !slim.names.includes('secrets.json'),
      JSON.stringify(slim.names.filter((n) => /^(settings|secrets)\.json$/.test(n))));

    // 完整包 = 全选
    await page.click('#btn-select-all');
    await page.waitForTimeout(200);
    await page.click('#btn-convert');
    const fullNames = await common.waitForQueue(page, rowIndex + 1);
    t.ok('T-full.1 完整包转换完成', Array.isArray(fullNames) && fullNames.length >= rowIndex + 1,
      JSON.stringify(fullNames));
    const whole = await common.readZip(
      await common.downloadNthRow(page, rowIndex, ctx.fixtureDir, 'preset-full.zip'),
    );
    t.ge('T-full.2 完整包非空（前置门）', whole.names.length, 1, `entries=${whole.names.length}`);
    t.ok('T-full.3 完整包含世界书',
      whole.names.some((n) => n.startsWith('worlds/')), JSON.stringify(whole.names.slice(0, 8)));
    t.ok('T-full.4 完整包含系统设置',
      whole.names.includes('settings.json'), JSON.stringify(whole.names.slice(0, 8)));
    t.ok('T-full.5 完整包条目数 ≥ 精简包（「完整」名副其实）',
      whole.names.length >= slim.names.length,
      `完整=${whole.names.length} 精简=${slim.names.length}`);
    t.ok('T-full.6 完整包含密钥（secrets 任何方向不剥离 —— 既有硬性约定）',
      whole.names.includes('secrets.json'), JSON.stringify(whole.names.slice(0, 10)));

    // ============ ②b 预设「安全脱敏」（隐私向）：**产物里真的没有密钥与聊天** ============
    await page.click('[data-preset="safe"]');
    await page.waitForTimeout(250);
    await page.selectOption('#target-select', 'st');
    // **前置门**：先回读勾选态 —— 必须看到 chats / secrets 已**取消勾选**，否则后面的
    // "产物里没有它们"就不是在验预设，而是在验别的（首版没有这一步，红得无法定性）
    const preSel = await page.evaluate(() => {
      const out = {};
      for (const c of document.querySelectorAll('.category-card')) {
        const box = c.querySelector('input[type="checkbox"]');
        if (box && !box.disabled) out[c.dataset.category] = box.checked;
      }
      return out;
    });
    t.eq('T-safe.0 【前置门】预设「安全脱敏」已把 chats 取消勾选', preSel.chats, false,
      JSON.stringify(preSel));
    t.eq('T-safe.0b 【前置门】预设「安全脱敏」已把 secrets 取消勾选', preSel.secrets, false,
      JSON.stringify(preSel));
    const rowsBeforeSafe = await page.$$eval('.eq-name', (els) => els.length);
    await page.click('#btn-convert');
    const safeNames = await common.waitForQueue(page, rowsBeforeSafe + 1);
    t.eq('T-safe.0c 新产物确实追加在队尾（不是把旧行当成新产物）',
      (safeNames || []).length, rowsBeforeSafe + 1, JSON.stringify(safeNames));
    t.ok('T-safe.1 安全脱敏预设转换完成', Array.isArray(safeNames) && safeNames.length >= rowIndex + 1,
      JSON.stringify(safeNames));
    const safeOut = await common.downloadNthRow(page, rowsBeforeSafe, ctx.fixtureDir, 'preset-safe.zip');
    const safe = await common.readZip(safeOut);
    t.log(`  · 安全脱敏产物：${JSON.stringify(safe.names)}`);
    rowIndex += 1;
    t.ge('T-safe.2 产物非空（前置门）', safe.names.length, 1, `entries=${safe.names.length}`);
    t.ok('T-safe.3 安全脱敏**不含密钥**（secrets.json 不在产物里 —— 这是该预设的全部意义）',
      !safe.names.includes('secrets.json'),
      JSON.stringify(safe.names.filter((n) => n.includes('secret'))));
    t.ok('T-safe.4 安全脱敏**不含聊天记录**（chats/ 不在产物里 —— 隐私向）',
      !safe.names.some((n) => n.startsWith('chats/') || n.includes('/chats/')),
      JSON.stringify(safe.names.filter((n) => n.includes('chats'))));
    t.ok('T-safe.5 角色卡与系统设置照常在场（"脱敏"不是"清空"）',
      safe.names.some((n) => n.startsWith('characters/')) && safe.names.includes('settings.json'),
      JSON.stringify(safe.names.slice(0, 8)));

    t.eq('Z1 全流程零未捕获页面异常', rec.pageErrors.length, 0, JSON.stringify(rec.pageErrors.slice(0, 2)));
  },
};
