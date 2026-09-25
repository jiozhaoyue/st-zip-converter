/**
 * 控件消费点守卫（2026-09-25）
 *
 * 背景：`#incremental-mode-check`（J 区「增量合并」）长期存在，但**其值从不被任何代码读取**——
 * 它有 `getElementById`、有 `addEventListener`、有折叠摘要文字，**看不出问题**；
 * 勾选它只让摘要多四个字，**行为零变化**。该控件已于 `09-25-transfer-pack-optimize` 移除。
 *
 * **为何不能靠「搜不到引用」来防**：那个死开关**确实被引用**（元素查找 / 事件绑定 / 摘要文字），
 * 弱判据抓不住它。可靠做法是**强制显式声明**：新增控件时作者必须写下「谁读它的值」，
 * 写不出来就说明控件没有存在理由。
 *
 * ⚠ **本守卫的局限（不要误读）**：它只强制「声明存在」，**不能验证声明为真**。
 * 声明表写错也能通过。它是「提醒有人必须想过这件事」的机制，不是「控件一定有消费点」的证明。
 *
 * 违规时退出码 1，输出 `文件:行号`（沿用 css-scope.js / dom-injection-guard.js 约定）。
 */
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

/** 视为「交互控件」的标签——只有这些需要用户操作，故必须有消费点 */
const CONTROL_TAGS = ['button', 'input', 'select', 'textarea'];

/**
 * 控件 → 消费点声明表。
 *
 * 键的三种形态：
 * - `<id>`：带 `id` 的控件（绝大多数）
 * - `name:<name>`：**无 id** 的单选组（按 name 分组读取，如 `input[name=…]:checked`）
 * - `group:.<class>`：**既无 id 也无 name** 的控件，靠类选择器批量绑定（如 `.btn-quick` 事件委托）
 *
 * `group:` 键只对「无 id 且无 name」的控件生效，**不能用来兜底有 id 的控件**——
 * 否则写一条 `group:.menu_button` 就能绕过整张表。
 */
export const CONTROL_CONSUMERS = Object.freeze({
  // ── 抽屉/模态态框架 ──
  'btn-close-converter-modal': 'index.js openConverterModal() — click 关闭模态工作台',
  'btn-storage-inspector': 'index.js setupStorageInspectorButton() — click 唤起宿主原生存储面板',

  // ── 源包与暂存区 ──
  'file-input': 'file-drop.js — change → .files 取上传文件',

  // ── 类目工具按钮 ──
  'btn-select-all': 'category-filter.js:84 — click 全选',
  'btn-deselect-all': 'category-filter.js:89 — click 全不选',
  'btn-invert-select': 'category-filter.js:94 — click 反选',
  'group:.btn-quick': 'category-filter.js:99 — 事件委托读 dataset.preset（仅角色卡/仅聊天记录/安全脱敏）',

  // ── 统一文件树确认条 ──
  'btn-host-tree-selectall': 'index.js:308 — click 全选（走 categorySelectAll）',
  'btn-host-tree-confirm': 'index.js:302 — click 确认文件树',
  'btn-host-tree-cancel': 'index.js:305 — click 取消文件树',

  // ── 输出三联（F 区）──
  'target-select': 'index.js:163/314 — .value 目标平台（st|l|tt|pt）',
  'compression-select': 'index.js:337 — .value 转 int → zip 压缩级别',
  'split-input': 'index.js:202 — .value → normalizeSplitMb() 分卷阈值',

  // ── 垃圾清理（H 区）──
  'include-backups-check': 'index.js — .checked 是否打包 backups/ 快照',
  'include-cache-check': 'index.js — .checked 是否打包派生缓存',
  'include-private-check': 'index.js — .checked 是否打包私有配置',
  'prune-builtin-check': 'index.js — .checked 是否剔除酒馆原生重复资产',

  // ── 扩展打包（I 区）──
  'name:extension-mode': 'index.js getExtensionMode() — querySelector(:checked).value 轻量清单/完整离线包',
  'name:git-mode': 'index.js getGitMode() — querySelector(:checked).value 转 transform 的 gitMode（keep|minimal|strip）；'
    + '同步函数 syncGitModeAvailability() 读 extension-mode 决定本组是否 disabled',
  'keep-dev-files-check': 'index.js getKeepDevFiles() — .checked 是否保留构建配置',
  'btn-export-ext-manifest': 'index.js:502 — click 导出只读扩展清单',

  // ── 增量与差量（J 区）──
  'host-incremental-export': 'index.js — .checked 差量补丁开关（控制基准 ZIP 区显隐 + 导出走 delta）',
  'host-base-zip-input': 'index.js — change → .files 取外部基准 ZIP',
  'btn-select-base-zip': 'index.js:761 — click 触发基准 ZIP 文件选择',
  'host-base-archive-select': 'index.js — .value 从暂存区选基准包',

  // ── 包名（K 区）──
  'filename-template-input': 'index.js — .value 包名模板（{target}_{user}_{part}_{date}）',

  // ── 动作按钮（E 区）──
  'btn-host-fetch': 'index.js — click 从宿主拉取数据包',
  'btn-convert': 'index.js — click 开始转换',

  // ── 任务控制 ──
  'tc-pause': 'task-controls.js:47 — click 暂停任务',
  'tc-abort': 'task-controls.js:48 — click 中止任务',
  'tc-resume': 'task-controls.js:49 — click 继续任务',
  'tc-discard': 'task-controls.js:50 — click 丢弃断点',

  // ── 恢复模态 ──
  'name:restore-mode': 'index.js — querySelector(:checked).value 合并写入/覆盖写入',
  'btn-cancel-restore': 'index.js:1167 — click 取消恢复',
  'btn-confirm-restore': 'index.js:1174 — click 确认恢复写入',
  'btn-restore-luker': 'index.js — click 恢复到当前用户（打开恢复模态）',
});

/** 从模板源码提取全部交互控件 */
export function extractControls(template) {
  const re = new RegExp(`<(${CONTROL_TAGS.join('|')})\\b([^>]*)>`, 'g');
  const controls = [];
  let match;
  while ((match = re.exec(template)) !== null) {
    const attrs = match[2];
    const id = (attrs.match(/id="([^"]+)"/) || [])[1] || null;
    const name = (attrs.match(/name="([^"]+)"/) || [])[1] || null;
    const classAttr = (attrs.match(/class="([^"]+)"/) || [])[1] || '';
    controls.push({
      line: template.slice(0, match.index).split('\n').length,
      tag: match[1],
      id,
      name,
      classes: classAttr.split(/\s+/).filter(Boolean),
    });
  }
  return controls;
}

/**
 * 校验控件消费点声明
 * @param {{template: string, templateFile?: string, consumers?: Record<string,string|null>}} input
 * @returns {Array<{file: string, line: number, control: string, message: string}>}
 */
export function checkControlConsumers({
  template,
  templateFile = 'src/ui/workbench-template.js',
  consumers = CONTROL_CONSUMERS,
}) {
  const violations = [];
  const controls = extractControls(template);
  const used = new Set();

  // group: 键（仅对无 id 且无 name 的控件生效）
  const groupKeys = Object.entries(consumers)
    .filter(([key]) => key.startsWith('group:.'))
    .map(([key]) => ({ key, cls: key.slice('group:.'.length) }));

  for (const c of controls) {
    const label = c.id || (c.name ? `name=${c.name}` : `<${c.tag} class="${c.classes.join(' ')}">`);

    if (c.id) {
      if (!Object.prototype.hasOwnProperty.call(consumers, c.id)) {
        violations.push({
          file: templateFile,
          line: c.line,
          control: c.id,
          message: `控件 id="${c.id}" 未在 CONTROL_CONSUMERS 中声明消费点——`
            + '请写明「谁读它的值」；写不出来说明该控件没有存在理由（历史事故：死控件 #incremental-mode-check）',
        });
      } else {
        used.add(c.id);
      }
      continue;
    }

    if (c.name) {
      const key = `name:${c.name}`;
      if (!Object.prototype.hasOwnProperty.call(consumers, key)) {
        violations.push({
          file: templateFile,
          line: c.line,
          control: key,
          message: `单选组 name="${c.name}" 未声明消费点（键名应为 "${key}"）`,
        });
      } else {
        used.add(key);
      }
      continue;
    }

    // 既无 id 也无 name：必须由**恰好一个** group: 键覆盖
    const matched = groupKeys.filter((g) => c.classes.includes(g.cls));
    // 匹配到即算「该键非僵尸」——即使因为歧义而报了违规，它也确有对应控件
    for (const g of matched) used.add(g.key);

    if (matched.length === 0) {
      violations.push({
        file: templateFile,
        line: c.line,
        control: label,
        message: '控件既无 id 也无 name，且没有被任何 group:. 声明覆盖——'
          + '请给它 id，或声明绑定它的类选择器（如 group:.btn-quick）',
      });
    } else if (matched.length > 1) {
      violations.push({
        file: templateFile,
        line: c.line,
        control: label,
        message: `控件被多个 group: 声明覆盖（${matched.map((g) => g.key).join(', ')}）——请只保留一个`,
      });
    }
  }

  // 僵尸条目：声明了但模板中已无对应控件
  for (const key of Object.keys(consumers)) {
    if (consumers[key] === null) continue; // null 为占位说明，不参与
    if (!used.has(key)) {
      violations.push({
        file: templateFile,
        line: 1,
        control: key,
        message: `CONTROL_CONSUMERS 中的 "${key}" 在模板里已无对应控件——`
          + '僵尸条目请删除（声明表腐烂比不写更误导）',
      });
    }
  }

  return violations;
}

async function main() {
  const root = fileURLToPath(new URL('..', import.meta.url));
  const templateFile = 'src/ui/workbench-template.js';
  const template = await readFile(`${root}${templateFile}`, 'utf8');

  const violations = checkControlConsumers({ template, templateFile });

  if (violations.length) {
    for (const item of violations) {
      console.error(`${item.file}:${item.line}: [${item.control}] ${item.message}`);
    }
    console.error(`\n控件消费点守卫未通过：${violations.length} 处违规`);
    process.exitCode = 1;
    return;
  }

  const declared = Object.values(CONTROL_CONSUMERS).filter((v) => v !== null).length;
  const total = extractControls(template).length;
  console.log(
    `控件消费点守卫通过：${total} 个交互控件全部有消费点声明（${templateFile}）`,
  );
  console.log('  注：本守卫只强制「声明存在」，不验证声明为真。');
  console.log(`  声明条目：${declared}`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  await main();
}
