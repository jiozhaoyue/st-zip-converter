import { describe, it, expect } from 'vitest';
import { escapeHtml, isSafeHttpUrl, trustedStaticMarkup } from '../src/ui/escape.js';

describe('escapeHtml', () => {
  it('转义 & (先于其他字符，避免二次转义)', () => {
    expect(escapeHtml('a & b')).toBe('a &amp; b');
    expect(escapeHtml('&amp;')).toBe('&amp;amp;');
  });

  it('转义 < 与 >', () => {
    expect(escapeHtml('<script>')).toBe('&lt;script&gt;');
  });

  it('转义双引号（属性上下文必需）', () => {
    expect(escapeHtml('title="x"')).toBe('title=&quot;x&quot;');
  });

  it('转义单引号（属性上下文必需）', () => {
    expect(escapeHtml("it's")).toBe('it&#39;s');
  });

  it('覆盖全部 5 个特殊字符', () => {
    expect(escapeHtml(`&<>"'`)).toBe('&amp;&lt;&gt;&quot;&#39;');
  });

  it('中和典型 XSS 载荷', () => {
    const payload = '"><img src=x onerror=alert(1)>';
    const out = escapeHtml(payload);
    expect(out).not.toContain('<');
    expect(out).not.toContain('>');
    expect(out).not.toContain('"');
  });

  it('null / undefined 视为空串', () => {
    expect(escapeHtml(null)).toBe('');
    expect(escapeHtml(undefined)).toBe('');
  });

  it('非字符串入参先做 String 转换', () => {
    expect(escapeHtml(42)).toBe('42');
    expect(escapeHtml(false)).toBe('false');
  });
});

describe('isSafeHttpUrl', () => {
  it('接受 http / https（大小写不敏感）', () => {
    expect(isSafeHttpUrl('https://github.com/a/b')).toBe(true);
    expect(isSafeHttpUrl('HTTP://example.com')).toBe(true);
  });

  it('拒绝可执行与内联协议', () => {
    expect(isSafeHttpUrl('javascript:alert(1)')).toBe(false);
    expect(isSafeHttpUrl('data:text/html,<script>alert(1)</script>')).toBe(false);
    expect(isSafeHttpUrl(' vbscript:msgbox(1)')).toBe(false);
  });

  it('拒绝非字符串与空值', () => {
    expect(isSafeHttpUrl(null)).toBe(false);
    expect(isSafeHttpUrl(undefined)).toBe(false);
    expect(isSafeHttpUrl(123)).toBe(false);
    expect(isSafeHttpUrl('')).toBe(false);
  });
});

describe('trustedStaticMarkup', () => {
  it('是恒等函数（原样返回，不改写内容）', () => {
    const markup = '<span class="a">文本</span>';
    expect(trustedStaticMarkup(markup)).toBe(markup);
  });

  it('不做任何转义（这是它的契约：入参必须是可信字面量）', () => {
    expect(trustedStaticMarkup('<b>x</b>')).toBe('<b>x</b>');
  });

  it('空串原样返回', () => {
    expect(trustedStaticMarkup('')).toBe('');
  });
});
