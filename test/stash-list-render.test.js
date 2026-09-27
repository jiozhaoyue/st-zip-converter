import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import { renderStashList } from '../src/ui/stash-list.js';

/**
 * 暂存区**渲染路径**的回归守护。
 *
 * 事故（2026-09-27 实测，由 E2E 矩阵 M-10 抓出）：
 * `f9c7cfe`「按钮契约解耦」把行级按钮工厂 `mkBtn` 搬进了 `refreshBatchBar`
 * （那是**批量条**的 4 参签名），却漏删了行级的 `btns` 与 `mkBtn` 两处声明，
 * 而调用点仍在引用它们 ⇒ `renderStashList` 在**第一个非当前源条目**上抛
 * `ReferenceError: btns is not defined` ⇒ 容器在函数末尾 `containerEl.appendChild(list)`
 * **之前**中断 ⇒ **暂存区恒为空**（连空态占位都没有），且 `index.js` 的
 * `updateWorkspaceUI` 中同一处 try/catch 会连带跳过配额条与待导出区的刷新。
 *
 * 为什么此前无人发现：单测只覆盖 `filterStashFiles` / `stashBatchCapability`
 * 两个**纯函数**，渲染路径没有任何用例 ⇒ 缺陷潜伏两个提交，只在浏览器里表现为
 * 一行 `[warning] 刷新工作区 UI 失败: ReferenceError: btns is not defined`。
 * 本文件补上这条路：**渲染必须不抛错**，且产出的 DOM 契约（E2E 与 CSS 都依赖）
 * 必须成立。
 *
 * 项目不引入 jsdom（依赖自包含 L1-MR-11 / 不擅自装包 G6），沿用
 * `test/host-button-factory.test.js` 的最小 DOM 桩范式。
 */

const h = vi.hoisted(() => ({ records: [] }));

vi.mock('../src/storage/db.js', () => ({
  listStoredFiles: async () => h.records,
  getFile: async (id) => h.records.find((r) => r.id === id) || null,
  deleteFile: async () => {},
}));

const g = globalThis;

function makeEl(tag = 'div') {
  const listeners = {};
  const el = {
    tagName: tag.toUpperCase(),
    id: '',
    className: '',
    title: '',
    type: '',
    hidden: false,
    disabled: false,
    style: {},
    dataset: {},
    textContent: '',
    children: [],
    parentElement: null,
    set innerHTML(v) {
      this._html = v;
      // 真实 DOM 的 `innerHTML = ''` 会清空子节点；`renderStashList` 依赖这一语义
      if (v === '') this.children = [];
    },
    get innerHTML() {
      return this._html === undefined ? '' : this._html;
    },
    appendChild(child) {
      this.children.push(child);
      child.parentElement = this;
      return child;
    },
    get lastElementChild() {
      return this.children.length ? this.children[this.children.length - 1] : null;
    },
    addEventListener(type, fn) {
      (listeners[type] = listeners[type] || []).push(fn);
    },
    fire(type, event = {}) {
      (listeners[type] || []).forEach((fn) => fn(event));
    },
    remove() {},
    contains: () => false,
    closest: () => null,
    querySelector: () => null,
    querySelectorAll: () => [],
  };
  return el;
}

function installDom() {
  g.document = {
    readyState: 'complete',
    body: makeEl('body'),
    createElement: (tag) => makeEl(tag),
    getElementById: () => null,
    querySelector: () => null,
    querySelectorAll: () => [],
    addEventListener: () => {},
  };
}

/** 桩记录：origin ∈ STASH_ORIGINS 才会进暂存区 */
const rec = (id, name) => ({
  id, name, origin: 'upload', layout: 'st', size: 1024, blob: { size: 1024 },
});

const activeFileId = 'f-active';
const setup = async ({ isHostAvailable = true, onBatchConvert } = {}) => {
  h.records = [rec(activeFileId, 'current.zip'), rec('f-other', 'other.zip')];
  const containerEl = makeEl('div');
  const batchBarEl = makeEl('div');
  const loaded = [];
  await renderStashList({
    containerEl,
    batchBarEl,
    activeFileId,
    isHostAvailable,
    onLoadFile: (f) => loaded.push(f),
    onListChanged: () => {},
    onRestoreToHost: () => {},
    onBatchConvert,
  });
  return { containerEl, batchBarEl, loaded };
};

const cardsOf = (containerEl) => {
  // containerEl → 唯一的子节点即 `list`（`.archive-item-list.stash-list`）
  expect(containerEl.children.length).toBe(1);
  const list = containerEl.children[0];
  expect(list.className).toContain('stash-list');
  return list.children;
};

describe('renderStashList 渲染路径（回归守护：缺失声明 ⇒ 整块暂存区恒空）', () => {
  beforeEach(() => installDom());
  afterEach(() => { delete g.document; });

  it('渲染**不抛错**且真的把列表挂进了容器', async () => {
    const { containerEl } = await setup();
    const cards = cardsOf(containerEl);
    // 两条记录 ⇒ 两张卡片（若在循环里抛错，这里会是 0 —— 正是事故形态）
    expect(cards.length).toBe(2);
    expect(containerEl.children[0].innerHTML).not.toContain('archive-empty');
  });

  it('每张卡片都产出 E2E 依赖的 `.archive-name` 与 `.stash-select-box[data-id]` 标记', async () => {
    const { containerEl } = await setup();
    const cards = cardsOf(containerEl);
    const html = cards.map((c) => c.children[0].innerHTML).join('\n');
    expect(html).toContain('class="archive-name"');
    expect(html).toContain('>current.zip<');
    expect(html).toContain('>other.zip<');
    expect(html).toContain(`class="stash-select-box" data-id="${activeFileId}"`);
    expect(html).toContain('class="stash-select-box" data-id="f-other"');
  });

  it('每张卡片都有自己的按钮容器 `.archive-buttons`（事故点：该容器与工厂都不存在）', async () => {
    const { containerEl } = await setup();
    const cards = cardsOf(containerEl);
    for (const card of cards) {
      const btns = card.children.find((c) => c.className === 'archive-buttons');
      expect(btns, '卡片缺少 .archive-buttons 容器').toBeTruthy();
      expect(btns.children.length).toBeGreaterThan(0);
      for (const b of btns.children) {
        expect(b.className).toMatch(/^btn-archive-action\s/); // CSS 依赖的类前缀
        expect(b.type).toBe('button');
      }
    }
  });

  it('「载入」只给非当前源条目；「更多」人人都有', async () => {
    const { containerEl } = await setup();
    const [current, other] = cardsOf(containerEl);
    const cls = (card) => card.children
      .find((c) => c.className === 'archive-buttons').children.map((b) => b.className);

    expect(cls(current)).toEqual(['btn-archive-action more']);
    expect(cls(other)).toEqual(['btn-archive-action load', 'btn-archive-action more']);
  });

  it('点「载入」把该条目回传给 onLoadFile', async () => {
    const { containerEl, loaded } = await setup();
    const other = cardsOf(containerEl)[1];
    const loadBtn = other.children
      .find((c) => c.className === 'archive-buttons').children
      .find((b) => b.className.includes('load'));
    loadBtn.fire('click', {});
    await vi.waitFor(() => expect(loaded.length).toBe(1));
    expect(loaded[0].id).toBe('f-other');
  });

  it('勾选后批量条出现「批量转换」入口（U-7；注入 onBatchConvert 时才渲染）', async () => {
    const { containerEl, batchBarEl } = await setup({ onBatchConvert: () => {} });
    const list = containerEl.children[0];
    // 模拟勾选第一条：`change` 委托处理器读 dataset.id
    list.fire('change', {
      target: { closest: () => ({ checked: true, dataset: { id: activeFileId } }) },
    });
    expect(batchBarEl.hidden).toBe(false);
    const labels = batchBarEl.children.map((c) => c.innerHTML || c.textContent || '');
    expect(labels.join('|')).toContain('批量转换');
  });

  it('未注入 onBatchConvert ⇒ 不渲染「批量转换」（可选接缝不破）', async () => {
    const { containerEl, batchBarEl } = await setup();
    const list = containerEl.children[0];
    list.fire('change', {
      target: { closest: () => ({ checked: true, dataset: { id: activeFileId } }) },
    });
    const labels = batchBarEl.children.map((c) => c.innerHTML || c.textContent || '');
    expect(labels.join('|')).not.toContain('批量转换');
    expect(labels.join('|')).toContain('载入为源');
  });
});
