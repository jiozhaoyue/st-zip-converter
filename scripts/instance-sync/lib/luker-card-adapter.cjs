/**
 * Luker → ST 角色卡适配（**拆壳**）—— `import-st.cjs` 与诊断器共用的**唯一**实现
 *
 * 为什么单独成文件：这段映射是「跨宿主数据形态的必要转换」，此前**只存在于 `import-st.cjs`
 * 的内联块**里。诊断器若要解释「为什么这 56 张没进去」，就必须复刻同样的推导；
 * 复刻出来的第二份必然与第一份漂移（本仓 `P-4` / `P-17` 的同类形态：同一事实两处表述）。
 * ⇒ 抽成共享模块，改一处两边同步。
 *
 * 数据形态（2026-09-26 实测，源 = Real Luker `data/default-user/characters/<sha256>`）：
 *
 * ```
 * { "key":   "data\\default-user\\characters\\孤独摇滚.png-1771010065094.1455",
 *   "value": "{\"name\":\"孤独摇滚\",\"description\":\"…\"}" }   // ← value 本身是标准 TavernAI 卡片
 * ```
 *
 * `key` 尾段带**原始文件名**（`孤独摇滚.png-<时间戳>`），据此还原人类可读角色名 ——
 * 它同时是投递给 ST 的 `preserved_name`（ST 的 `getPreservedName` 取 `path.parse(...).name`），
 * 决定导入后落在 `characters/<名字>.png`。
 *
 * ⚠️ 已知约束：`preserved_name` 会被 ST **原样当文件名用**
 * （`characters.js:257` `path.join(directories.characters, `${outputFile}.png`)`），
 * 故本模块须负责给出**宿主可落盘**的名字 —— 见 `sanitizeHostName`。
 *
 * @module scripts/instance-sync/lib/luker-card-adapter
 */

/** PNG 魔数（`\x89PNG`）—— 决定 `file_type`，ST 按它选 `importFromPng` / `importFromJson` */
function isPngData(data) {
  return data[0] === 0x89 && data[1] === 0x50 && data[2] === 0x4e && data[3] === 0x47;
}

/**
 * Luker 的 KV 键 → `{ avatar, version }`。
 *
 * 键形如 `data\default-user\characters\孤独摇滚.png-1771010065094.1455`：
 * **末段 = 原始头像文件名 + `-<毫秒>.<微秒>` 版本戳**。注意 Luker 盘上**没有**这个文件名 ——
 * 盘上是被 sha256 命名的**版本化 blob**（同一角色每次改动留一份）⇒ 一个角色会有**多份**条目。
 *
 * ⚠️ 剥离顺序**必须先版本戳、后扩展名**。2026-09-26 实测踩过：先剥 `.png` 时该串以数字结尾、
 * 正则不命中，于是 `human` 留下 `孤独摇滚.png`，ST 落盘成 `孤独摇滚.png.png`（目标侧实测到
 * `1.png.png` 这类双扩展名文件即为证据），且**所有版本收敛到同一个错名**。
 *
 * @param {string} key
 * @returns {{avatar:string, version:number|null, raw:string}}
 */
function parseLukerKey(key) {
  const raw = String(key == null ? '' : key).split(/[\\/]/).pop() || '';
  const m = raw.match(/^(.*)-(\d+)(?:\.\d+)?$/);
  const stem = m ? m[1] : raw;
  const version = m ? Number(m[2]) : null;
  const avatar = stem.replace(/\.[A-Za-z0-9]{1,5}$/, '').trim();
  return { avatar, version, raw };
}

/**
 * 从 PNG 卡片的 `tEXt` 块里取出卡片名（ST/酒馆通用的 `chara` / `ccv3` 约定）。
 *
 * 用途：Luker 盘上**有一部分 blob 是裸 PNG 头像**（没有 KV 外壳 ⇒ 拿不到 `key`），
 * 若不还原名字就只能拿 sha256 当文件名（实测目标侧留下 `<32位十六进制>.png` 这类无名卡片）。
 *
 * 解析规则（PNG 规范）：8 字节签名后逐块 `<len:4><type:4><data><crc:4>`；
 * `tEXt` 的 data 是 `keyword\0text`，`chara` 的 text 为 **base64(卡片 JSON)**。
 *
 * @param {Buffer} data
 * @returns {string} 卡片名；取不到则空串（**不抛** —— 解析失败不该阻断导入）
 */
function extractPngCardName(data) {
  try {
    let off = 8;
    while (off + 12 <= data.length) {
      const len = data.readUInt32BE(off);
      const type = data.toString('latin1', off + 4, off + 8);
      const body = data.subarray(off + 8, off + 8 + len);
      if (type === 'tEXt') {
        const z = body.indexOf(0);
        if (z > 0) {
          const kw = body.toString('latin1', 0, z);
          if (kw === 'chara' || kw === 'ccv3') {
            const txt = body.toString('latin1', z + 1);
            const json = /^\s*[{[]/.test(txt) ? txt : Buffer.from(txt, 'base64').toString('utf8');
            const card = JSON.parse(json);
            const name = card?.data?.name || card?.name;
            if (name) return String(name).trim();
          }
        }
      }
      if (type === 'IEND') break;
      off += 12 + len;
    }
  } catch { /* 非标准 PNG / 块损坏：按无名处理 */ }
  return '';
}

/**
 * Windows **文件名字符集**里非法的字符 —— ST 侧最终要 `path.join(characters, name + '.png')`
 * 再 `writeFileAtomicSync`，命中非法字符即抛错 ⇒ `writeCharacterData` 返回 false ⇒ **HTTP 400**
 * （`characters.js:260` `return true` / `:263` `return false`；`/import` 对 falsy 走 `sendStatus(400)`）。
 *
 * ⚠️ 这条路径是本模块**唯一**认定为「宿主可落盘性」负责的地方；Linux/macOS 上只有 `/` 非法，
 * 但本仓的 E2E 目标就是 Windows 实例，且**放宽**只会在换机器时炸 ⇒ 一律按最严处理。
 */
const HOST_ILLEGAL = /[<>:"/\\|?*\u0000-\u001f]/g;

/** Windows 保留设备名（不区分大小写、且**带扩展名也仍然保留**：`CON.png` 一样非法） */
const HOST_RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;

/** 单段文件名上限：NTFS 255 个 UTF-16 码元；留出 `.png` 与原子写临时后缀的余量 */
const HOST_NAME_LIMIT = 200;

/**
 * 把任意人类可读名字收敛成**宿主可落盘**的文件名（不含扩展名）。
 *
 * 语义：**保内容、只改不可落盘的部分**——替换非法字符为 `_`、去首尾点与空白（Windows 尾点会被吞）、
 * 命中保留设备名则加前缀、超长则截断并附 8 位短哈希（保证不同长名不会截成同一个）。
 *
 * @param {string} name
 * @returns {string} 可直接当文件名用的名字；空则返回 `'card'`
 */
function sanitizeHostName(name) {
  let s = String(name == null ? '' : name)
    .replace(HOST_ILLEGAL, '_')
    // 首尾的空白与点：Windows 会静默吞掉尾部点，导致「写进去的名字」与「读到的名字」不一致
    .replace(/^[\s.]+|[\s.]+$/g, '')
    .trim();
  if (HOST_RESERVED.test(s)) s = `_${s}`;
  if (!s) s = 'card';
  if (s.length > HOST_NAME_LIMIT) {
    // 截断必须带短哈希：否则 `…（长名 A）` 与 `…（长名 B）` 会截成同一个文件、互相覆盖
    const hash = require('crypto').createHash('sha1').update(name, 'utf8').digest('hex').slice(0, 8);
    s = `${s.slice(0, HOST_NAME_LIMIT - 9)}-${hash}`;
  }
  return s;
}

/**
 * 由包内条目推导 ST 可接受的**上传形态**。
 *
 * @param {Buffer} data 包内条目字节
 * @param {string} base 条目基名（`characters/<base>`），PNG 卡片与无外壳卡片都靠它兜底
 * @returns {{isPng:boolean, payload:Buffer, fileName:string, preservedName:string,
 *            human:string, avatar:string, version:number|null}}
 *   - `fileName`：multipart 的 `filename` 与 `preserved_name` 用的名字（含扩展名）
 *   - `preservedName`：ST 落盘用的名字（**已 sanitize，无扩展名**）
 *   - `avatar`：角色身份（**版本选择的键**：同一 `avatar` 的多个条目是同一角色的历史版本）
 *   - `version`：Luker 版本戳（毫秒）；`null` 表示无版本信息
 */
function deriveStCharacterUpload(data, base) {
  const isPng = isPngData(data);
  let payload = data;
  let human = '';
  let version = null;

  if (isPng) {
    // 裸 PNG 头像：名字只在 PNG 的 `chara` 块里（没有 KV 外壳可读）
    human = extractPngCardName(data) || String(base);
  } else {
    human = String(base);
    try {
      const outer = JSON.parse(data.toString('utf8'));
      if (outer && typeof outer.value === 'string' && outer.key) {
        const card = JSON.parse(outer.value); // 内层即标准卡片
        /**
         * 名字可能在两处：**V2 卡**在 `card.name`，**V3 卡**（`spec: 'chara_card_v3'`）
         * 在 `card.data.name`。2026-09-26 实测：只认 `card.name` 会把 38 张 V3 卡
         * 打回 sha256 兜底名，落盘成 `<64位十六进制>.png` 的无名卡片。
         */
        const cardName = card && typeof card === 'object'
          ? (card.name || (card.data && card.data.name))
          : null;
        if (cardName) {
          payload = Buffer.from(JSON.stringify(card), 'utf8');
          const parsed = parseLukerKey(outer.key);
          /**
           * **键尾的名字只在 `characters/` 下才可信**。Luker 还有一处 `data/_uploads/`
           * （上传暂存区），那里键尾是**上传号 sha**，取它只会得到 `<sha>.png` 无名卡片
           * （实测 11 条）。⇒ 仅当键尾像「角色名」时才用它，否则退回**卡片自己的名字**。
           */
          const keyPath = String(outer.key).replace(/\\/g, '/');
          const stemIsId = /^[0-9a-f]{16,}$/i.test(parsed.avatar);
          human = (keyPath.includes('/characters/') && !stemIsId && parsed.avatar)
            ? parsed.avatar
            : String(cardName).trim();
          version = parsed.version;
        }
      }
    } catch { /* 不是 KV 外壳：按原样投递，别把正常卡片也弄坏 */ }
  }

  const preservedName = sanitizeHostName(human);
  const ext = isPng ? '.png' : '.json';
  return {
    isPng,
    payload,
    fileName: `${preservedName}${ext}`,
    preservedName,
    human,
    avatar: preservedName,
    version,
  };
}

/**
 * 角色卡**子目录**条目（`characters/<角色名>/<精灵图>.png`）—— **不是卡片**。
 *
 * 判据要落在「`characters/` 之后还有没有第二层」：这类条目走 `characters/import` 会得到
 * `{"error":true}`（不是卡片），它们的原生落点是**同路径裸落盘**（ST 本来就按这个形态存精灵图）。
 * 导入器与归因器共用本判据，避免两边对「什么算卡片」出现分歧。
 *
 * @param {string} n 归一化后的包内路径
 */
function isCharacterSubpath(n) {
  return n.startsWith('characters/') && n.slice('characters/'.length).includes('/');
}

module.exports = {
  isPngData,
  sanitizeHostName,
  parseLukerKey,
  extractPngCardName,
  deriveStCharacterUpload,
  isCharacterSubpath,
  HOST_ILLEGAL,
  HOST_NAME_LIMIT,
};
