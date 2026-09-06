import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { detectHost, verifyHostPlatform, hostLayoutCode } from '../src/ui/host-bridge.js';

// 模拟浏览器全局环境的可写快照
const g = globalThis;

function installWindow(props = {}) {
  g.window = {
    SillyTavern: props.windowSillyTavern,
    luker: undefined,
  };
  if (props.windowSillyTavern === undefined) delete g.window.SillyTavern;
  if (props.extensionsMenu) {
    g.document = {
      querySelector: (sel) => (sel === '#extensionsMenu' ? { id: 'extensionsMenu' } : null),
    };
  } else {
    g.document = { querySelector: () => null };
  }
}

function setGlobal(key, value) {
  if (value === undefined) {
    delete g[key];
  } else {
    g[key] = value;
  }
}

describe('detectHost 判定矩阵', () => {
  beforeEach(() => {
    setGlobal('SillyTavern', undefined);
    setGlobal('lukerContext', undefined);
  });

  afterEach(() => {
    delete g.window;
    delete g.document;
    setGlobal('SillyTavern', undefined);
    setGlobal('lukerContext', undefined);
  });

  it('Luker: 仅 lukerContext 存在 → luker', () => {
    setGlobal('lukerContext', { chat: [] });
    installWindow();
    const host = detectHost();
    expect(host.platform).toBe('luker');
    expect(host.isPlugin).toBe(true);
    expect(host.confidence).toBe('frontend');
  });

  it('Luker: lukerContext + SillyTavern 同时存在 → luker（顺序不可颠倒）', () => {
    setGlobal('lukerContext', { chat: [] });
    setGlobal('SillyTavern', { libs: {}, getContext: () => ({}) });
    installWindow();
    expect(detectHost().platform).toBe('luker');
  });

  it('ST: 仅 SillyTavern 存在 → st', () => {
    setGlobal('SillyTavern', { libs: {}, getContext: () => ({}) });
    installWindow();
    const host = detectHost();
    expect(host.platform).toBe('st');
    expect(host.isPlugin).toBe(true);
  });

  it('ST: 无全局对象但 #extensionsMenu 存在 → st', () => {
    installWindow({ extensionsMenu: true });
    expect(detectHost().platform).toBe('st');
  });

  it('standalone: 无任何宿主信号 → standalone', () => {
    installWindow();
    const host = detectHost();
    expect(host.platform).toBe('standalone');
    expect(host.isPlugin).toBe(false);
    expect(host.confidence).toBe('none');
  });

  it('lukerContext 惰性 getter 抛错时回退 SillyTavern → st', () => {
    Object.defineProperty(g, 'lukerContext', {
      configurable: true,
      get() {
        throw new Error("Cannot access 'chat' before initialization");
      },
    });
    setGlobal('SillyTavern', { libs: {}, getContext: () => ({}) });
    installWindow();
    const host = detectHost();
    expect(host.platform).toBe('st');

    // 清理 getter
    delete g.lukerContext;
    setGlobal('lukerContext', undefined);
  });
});

describe('verifyHostPlatform 服务端校验', () => {
  beforeEach(() => {
    setGlobal('lukerContext', undefined);
    setGlobal('SillyTavern', undefined);
  });

  afterEach(() => {
    setGlobal('lukerContext', undefined);
    setGlobal('SillyTavern', undefined);
  });

  function mockFetch(payload, status = 200) {
    g.fetch = async () => ({
      ok: status >= 200 && status < 300,
      status,
      json: async () => payload,
    });
  }

  it('Luker /version 形状 (agent=Luker:...) → luker', async () => {
    mockFetch({
      agent: 'Luker:2.7.0:Cohee#1207',
      compatAgent: 'Luker:1.18.0:Cohee#1207',
      stCompatVersion: '1.18.0',
      pkgVersion: '2.7.0',
    });
    const result = await verifyHostPlatform('st'); // 前端误判为 st
    expect(result.platform).toBe('luker');
    expect(result.verified).toBe(true);
  });

  it('stCompatVersion 字段存在即 Luker（ST 永远不会有）', async () => {
    mockFetch({ pkgVersion: '2.9.0', stCompatVersion: '1.19.0' });
    const result = await verifyHostPlatform('luker');
    expect(result.platform).toBe('luker');
  });

  it('ST 老形状 ({version} 单字段) → st', async () => {
    mockFetch({ version: '1.18.0' });
    const result = await verifyHostPlatform('st');
    expect(result.platform).toBe('st');
    expect(result.version).toBe('1.18.0');
  });

  it('agent=SillyTavern:... → st', async () => {
    mockFetch({ agent: 'SillyTavern:1.18.0:Cohee#1207', version: '1.18.0' });
    const result = await verifyHostPlatform('st');
    expect(result.platform).toBe('st');
  });

  it('端点不可达 → 保留前端判定，verified=false', async () => {
    g.fetch = async () => {
      throw new TypeError('Failed to fetch');
    };
    const result = await verifyHostPlatform('luker');
    expect(result.platform).toBe('luker');
    expect(result.verified).toBe(false);
  });

  it('端点 404 → 保留前端判定', async () => {
    mockFetch({ error: 'Not Found' }, 404);
    const result = await verifyHostPlatform('st');
    expect(result.platform).toBe('st');
    expect(result.verified).toBe(false);
  });

  it('前端与端点不一致时以服务端为准（st 判定被纠正为 luker）', async () => {
    mockFetch({ agent: 'Luker:2.7.0:Cohee#1207', stCompatVersion: '1.18.0', pkgVersion: '2.7.0' });
    const result = await verifyHostPlatform('st');
    expect(result.platform).toBe('luker');
  });
});

describe('hostLayoutCode 宿主平台→转换器布局代码映射', () => {
  it('luker → l (Luker 清单布局代码)', () => {
    expect(hostLayoutCode('luker')).toBe('l');
  });

  it('st → st (ST 摊平布局代码，同名直通)', () => {
    expect(hostLayoutCode('st')).toBe('st');
  });

  it('standalone 原样透传 (调用方负责兜底)', () => {
    expect(hostLayoutCode('standalone')).toBe('standalone');
  });

  it('未知值原样透传 (不抛错，纯映射)', () => {
    expect(hostLayoutCode('tt')).toBe('tt');
    expect(hostLayoutCode('pt')).toBe('pt');
    expect(hostLayoutCode('')).toBe('');
  });
});
