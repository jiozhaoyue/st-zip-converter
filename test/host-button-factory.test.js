import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mountNativeBackupButton, mountLukerBackupManagerButton } from '../src/ui/host-bridge.js';

/**
 * 宿主注入按钮工厂契约（R7.3）。
 *
 * 项目不引入 jsdom（依赖自包含 L1-MR-11 / 不擅自装包 G6），故用最小 DOM 桩
 * 驱动两处挂载函数，锁定注入按钮的结构契约：宿主原生类、`stZipInjected`
 * 幂等标记、图标在前文案在后（且文案走 textContent）、click 包裹
 * preventDefault/stopPropagation 后再回调 onClick。
 */

const g = globalThis;

/** click 时注入给监听器的受控事件对象所记录的效果 */
let clickEffects = { prevented: 0, stopped: 0 };
const preventDefault = () => { clickEffects.prevented += 1; };
const stopPropagation = () => { clickEffects.stopped += 1; };

function makeEl(tag = 'div') {
  const listeners = {};
  return {
    tagName: tag.toUpperCase(),
    id: '',
    className: '',
    title: '',
    style: {},
    dataset: {},
    textContent: '',
    children: [],
    parentElement: null,
    nextSibling: null,
    nextElementSibling: null,
    firstChild: null,
    inserted: [],
    appendChild(child) {
      this.children.push(child);
      child.parentElement = this;
      if (!this.firstChild) this.firstChild = child;
      return child;
    },
    insertBefore(node, ref) {
      this.inserted.push({ node, ref });
      this.children.push(node);
      node.parentElement = this;
      if (!this.firstChild) this.firstChild = node;
      return node;
    },
    addEventListener(type, fn) {
      (listeners[type] = listeners[type] || []).push(fn);
    },
    click() {
      (listeners.click || []).forEach((fn) => fn({ preventDefault, stopPropagation }));
    },
    querySelector(sel) {
      if (sel === 'span') return this.children.find((c) => c.tagName === 'SPAN') || null;
      return null;
    },
    querySelectorAll() {
      return [];
    },
  };
}

/** 安装最小 DOM：anchors = .userBackupButton 锚点；row = Luker 备份管理器动作行 */
function installDom({ anchors = [], row = null } = {}) {
  const created = [];
  g.document = {
    readyState: 'complete',
    body: makeEl('body'),
    createElement(tag) {
      const el = makeEl(tag);
      created.push(el);
      return el;
    },
    // 载入宿主设置抽屉锚点：桩环境下一律缺失，使 openConverterDrawer 安全早退
    getElementById: () => null,
    querySelector: (sel) => (sel === '.userBackupManager .backupActionRow' ? row : null),
    querySelectorAll: (sel) => (sel === '.userBackupButton' ? anchors : []),
    addEventListener: () => {},
  };
  g.MutationObserver = class {
    observe() {}
    disconnect() {}
  };
  return created;
}

const byId = (created, id) => created.find((el) => el.id === id) || null;

describe('makeHostButton 契约（经 mountNativeBackupButton 注入）', () => {
  let anchor;

  beforeEach(() => {
    anchor = makeEl('div');
    anchor.parentElement = makeEl('div');
    anchor.appendChild(makeEl('span')); // 账号弹层锚点含文案 span
  });

  afterEach(() => {
    delete g.document;
    delete g.MutationObserver;
  });

  it('带宿主原生类、幂等标记与功能名 title', () => {
    const created = installDom({ anchors: [anchor] });

    mountNativeBackupButton(() => {});

    const btn = byId(created, 'st-zip-converter-native-btn');
    expect(btn).not.toBeNull();
    expect(btn.className).toBe('menu_button menu_button_icon');
    expect(btn.dataset.stZipInjected).toBe('1');
    expect(btn.title).toBe('打开酒馆数据包互转工坊（在扩展设置中）');
  });

  it('结构为「图标在前、文案在后」，文案走 textContent 而非 innerHTML', () => {
    const created = installDom({ anchors: [anchor] });

    mountNativeBackupButton(() => {});

    const btn = byId(created, 'st-zip-converter-native-btn');
    expect(btn.children.map((c) => c.tagName)).toEqual(['I', 'SPAN']);
    expect(btn.children[0].className).toBe('fa-fw fa-solid fa-right-left');
    expect(btn.children[1].textContent).toBe('数据包互转');
  });

  it('click 先 preventDefault + stopPropagation，再回调 onClick', () => {
    const created = installDom({ anchors: [anchor] });
    let opened = 0;

    mountNativeBackupButton(() => { opened += 1; });
    clickEffects = { prevented: 0, stopped: 0 };
    byId(created, 'st-zip-converter-native-btn').click();

    expect(clickEffects.prevented).toBe(1);
    expect(clickEffects.stopped).toBe(1);
    expect(opened).toBe(1);
  });

  it('仅在提供 onQuickFetch 时额外注入「一键拉取」', () => {
    const withFn = installDom({ anchors: [anchor] });
    mountNativeBackupButton(() => {}, { onQuickFetch: () => {} });
    expect(byId(withFn, 'st-zip-converter-native-btn-quick-fetch')).not.toBeNull();

    delete g.document;
    const withoutFn = installDom({ anchors: [anchor] });
    mountNativeBackupButton(() => {});
    expect(byId(withoutFn, 'st-zip-converter-native-btn-quick-fetch')).toBeNull();
  });
});

describe('makeHostButton 契约（经 mountLukerBackupManagerButton 注入）', () => {
  afterEach(() => {
    delete g.document;
    delete g.MutationObserver;
  });

  it('与 ST 侧完全同构（同一工厂），并插到动作行最前', () => {
    const row = makeEl('div');
    const nativeZipBtn = makeEl('button'); // 模拟 Luker 原生 ZIP 下载按钮
    row.appendChild(nativeZipBtn);
    const created = installDom({ row });

    mountLukerBackupManagerButton(() => {});

    const btn = byId(created, 'st-zip-converter-luker-manager-btn');
    expect(btn).not.toBeNull();
    expect(btn.className).toBe('menu_button menu_button_icon');
    expect(btn.dataset.stZipInjected).toBe('1');
    expect(btn.children.map((c) => c.tagName)).toEqual(['I', 'SPAN']);
    expect(btn.children[1].textContent).toBe('数据包互转');

    // 插到动作行最前：原生 ZIP 下载按钮之前
    expect(row.inserted.length).toBe(1);
    expect(row.inserted[0].node).toBe(btn);
    expect(row.inserted[0].ref).toBe(nativeZipBtn);
  });

  it('锚点不存在时静默不注入（其余宿主自然无操作）', () => {
    const created = installDom({ row: null });

    expect(() => mountLukerBackupManagerButton(() => {})).not.toThrow();
    expect(created.length).toBe(0);
  });
});
