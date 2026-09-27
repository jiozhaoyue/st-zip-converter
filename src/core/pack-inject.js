import { isBackupChatOrSnapshot } from './inspect.js';

/**
 * 注入决策（纯逻辑，零 DOM、零 IO）—— 「把聊天库里的哪些聊天补进这个包」
 *
 * ## 为什么需要它
 *
 * 转换器的聊天记录来源**只有一条**：源包里的 `chats/**`（`inspect.js:58-62`）。
 * 当宿主处于**纯数据库模式**（ChatFilesys 等把聊天收进库的插件）时，磁盘上的 jsonl
 * 在存量入库后即被删除、只在导出时生成（见 `ST-chatfilesys-rebuild/docs/guide/import.md`），
 * 于是备份包里的 `chats/` 是空的 ⇒ **打包产物一条聊天都没有，且不报错**。
 *
 * 本模块只回答「该补哪些」，**不负责取数据**（取数在 `src/ui/chat-store-bridge.js`），
 * 故可 100% 单测。
 *
 * ## 判定口径（对照前先问「两个数字量的是同一件事吗」）
 *
 * 两侧一律比 **落盘名（basename）**：
 *  - 库侧：`ChatFilesysApi.listChats()` 返回的 `fileName`（宿主文件名，家族主键绑定的就是它）；
 *  - 源包侧：`chats/<角色名>/<文件名>.jsonl` 的 `<文件名>.jsonl`。
 *
 * **不得**拿「库里的聊天条数」去对「源包里 chats 目录的条目数」——前者按聊天计、
 * 后者按文件计，且源包里可能混着 `.luker-state.chat_sync.json` 这类**非聊天**伴生文件。
 *
 * @module core/pack-inject
 */

/** 聊天库插件自己的隐藏容器前缀（`chats/__cfsys__/...`）——绝不注入、也绝不当作已有条目 */
export const HIDDEN_LIBRARY_PREFIX = '__cfsys__';

/** 聊天在包内的两个落点目录（ST/L 的 hub 路径形态） */
export const CHATS_DIR = 'chats';
export const GROUP_CHATS_DIR = 'group chats';

/**
 * 落盘名归一（比较用）。
 *
 * 小写 + NFC：Windows 文件系统大小写不敏感，宿主不可能存在仅大小写不同的两个聊天文件；
 * macOS 的 NFD 分解形态会让同一个名字在两次读取里产生不同码点序列。
 * @param {string} name
 * @returns {string}
 */
export function normalizeChatFileName(name) {
  return String(name || '').normalize('NFC').trim().toLowerCase();
}

/**
 * 路径是否落在聊天目录下（`chats/` 或 `group chats/` 的**任意层级**）
 * @param {string} filePath
 * @returns {boolean}
 */
export function isChatLikePath(filePath) {
  if (!filePath || typeof filePath !== 'string') return false;
  const norm = filePath.replace(/\\/g, '/');
  return /(^|\/)(group chats|chats)\//.test(`${norm}/`);
}

/** 落盘名（路径最后一段；去查询串/锚点这类不可能出现在 zip 条目里的残渣） */
function baseNameOf(filePath) {
  const norm = String(filePath || '').replace(/\\/g, '/');
  return norm.slice(norm.lastIndexOf('/') + 1);
}

/**
 * 路径里**任意一段**是否落在隐藏容器前缀下。
 *
 * 实测形态（本机 Dev Luker）：目录与文件名**两处都带前缀** ——
 * `chats/__cfsys__/__cfsys__f___cb_e2e_-_2026-...jsonl`。
 * 只查 basename 会漏掉「文件不带前缀但在隐藏目录里」的形态，故逐段查。
 * @param {string} filePath
 * @returns {boolean}
 */
function isUnderHiddenContainer(filePath) {
  const norm = String(filePath || '').replace(/\\/g, '/');
  return norm.split('/').some((seg) => seg.startsWith(HIDDEN_LIBRARY_PREFIX));
}

/**
 * 从源包的全部条目名里，收集**已经存在的聊天落盘名**。
 *
 * 排除两类，理由各自不同：
 *  - **备份特征文件**（`isBackupChatOrSnapshot`，含 `backups/**` 与 `*_backup.jsonl`）：
 *    它们是历史快照，拿它当「这个聊天已经在包里了」会让真正的当前版本被跳过；
 *  - **隐藏容器**（`__cfsys__` 前缀）：那是插件自己的库存储伴生文件，不是聊天。
 *
 * @param {Iterable<string>} entryNames 源包条目名（任意层级形态）
 * @returns {Set<string>} 归一后的落盘名集合
 */
export function collectSourceChatFileNames(entryNames) {
  const present = new Set();
  for (const raw of entryNames || []) {
    if (!raw || typeof raw !== 'string') continue;
    const norm = raw.replace(/\\/g, '/');
    if (!isChatLikePath(norm)) continue;
    // 只认 .jsonl：库侧索引项必然是 .jsonl（`validateLibraryChat` 同判据），
    // 而聊天目录下还混着 `.luker-state.chat_sync.json` 这类伴生文件 ——
    // 把它们的基名混进来只会制造与库条目永不相同的噪音条目。
    if (!/\.jsonl$/i.test(norm)) continue;
    if (isBackupChatOrSnapshot(norm)) continue;
    if (isUnderHiddenContainer(norm)) continue;
    const base = baseNameOf(norm);
    if (!base) continue;
    present.add(normalizeChatFileName(base));
  }
  return present;
}

/**
 * 库侧索引项是否可用作注入源。
 * @param {object} chat
 * @returns {{ok: true, fileName: string} | {ok: false, reason: string}}
 */
function validateLibraryChat(chat) {
  if (!chat || typeof chat !== 'object') return { ok: false, reason: 'invalid' };
  const fileName = chat.fileName ?? chat.file_name ?? chat.name;
  if (typeof fileName !== 'string' || !fileName.trim()) return { ok: false, reason: 'invalid' };
  if (!/\.jsonl$/i.test(fileName.trim())) return { ok: false, reason: 'invalid' };
  if (isUnderHiddenContainer(fileName)) return { ok: false, reason: 'hidden' };
  return { ok: true, fileName: fileName.trim() };
}

/**
 * 计划一次注入。
 *
 * 取舍：**源包优先**。同一个落盘名两边都有时一律跳过（不覆盖源包内容）——
 * 「转换」的语义是搬运既有数据，任何情况下都不该被一个副作用式的补丁改写。
 *
 * @param {object} input
 * @param {Array<object>} [input.libraryChats] 库索引（`ChatFilesysApi.listChats()` 的返回）
 * @param {Set<string>|Iterable<string>} [input.sourceChatNames] 源包已有聊天落盘名
 *   （用 `collectSourceChatFileNames()` 得到；也接受原始条目名，内部会自动归一）
 * @param {Record<string, boolean>|null} [input.selection] 类目选择；`selection.chats === false` ⇒ 空计划
 * @param {boolean} [input.includeBackups=false] 是否把备份特征文件也纳入
 * @returns {{
 *   inject: Array<{hubPath: string, ref: object, fileName: string}>,
 *   skipped: {categoryOff: number, hidden: number, backup: number, alreadyPresent: number, invalid: number},
 *   libraryCount: number, sourceCount: number
 * }}
 */
export function planInjection({
  libraryChats = [],
  sourceChatNames = [],
  selection = null,
  includeBackups = false,
} = {}) {
  const skipped = { categoryOff: 0, hidden: 0, backup: 0, alreadyPresent: 0, invalid: 0 };
  const chats = Array.isArray(libraryChats) ? libraryChats : [];
  const sourceCount = sourceChatNames instanceof Set
    ? sourceChatNames.size
    : (sourceChatNames ? new Set(sourceChatNames).size : 0);

  const result = {
    inject: [],
    skipped,
    libraryCount: chats.length,
    sourceCount,
  };

  // 类目关掉 ⇒ 一条都不注入（用户明确说了不要聊天，补进去就是违背选择）
  if (selection && typeof selection === 'object' && selection.chats === false) {
    skipped.categoryOff = chats.length;
    return result;
  }

  const present = sourceChatNames instanceof Set
    ? sourceChatNames
    : collectSourceChatFileNames(sourceChatNames);

  const planned = new Set();
  for (const chat of chats) {
    const valid = validateLibraryChat(chat);
    if (!valid.ok) {
      skipped[valid.reason] = (skipped[valid.reason] || 0) + 1;
      continue;
    }
    const { fileName } = valid;
    const norm = normalizeChatFileName(fileName);

    if (planned.has(norm)) {
      // 库索引自己给了重名（家族/分支同名的极端情形）：只注第一条，避免包内重名
      skipped.alreadyPresent += 1;
      continue;
    }
    if (present.has(norm)) {
      skipped.alreadyPresent += 1;
      continue;
    }
    const isGroup = chat.isGroup === true || chat.is_group === true;
    const hubPath = `${isGroup ? GROUP_CHATS_DIR : CHATS_DIR}/${fileName}`;
    if (!includeBackups && isBackupChatOrSnapshot(hubPath)) {
      skipped.backup += 1;
      continue;
    }
    planned.add(norm);
    result.inject.push({ hubPath, ref: chat, fileName });
  }

  return result;
}

/**
 * 计划的可读摘要（日志用；**不**包含任何路径或正文）
 * @param {ReturnType<typeof planInjection>} plan
 * @returns {string}
 */
export function describePlan(plan) {
  const s = plan.skipped;
  return `库中 ${plan.libraryCount} 条 · 源包已有 ${plan.sourceCount} 条 · 待补 ${plan.inject.length} 条`
    + `（跳过：已有 ${s.alreadyPresent} / 备份 ${s.backup} / 隐藏 ${s.hidden} / 无效 ${s.invalid}）`;
}
