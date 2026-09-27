import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { resolveServerUrl } = require('./resolve-server-url.js');

const FALLBACK = 'http://10.0.0.1:5173';

describe('resolveServerUrl：三层优先级', () => {
  it('env 与文件同时有值 → env 胜', () => {
    expect(resolveServerUrl('http://env:1', 'http://file:2', FALLBACK)).toBe('http://env:1');
  });

  it('env 为空串 → 取文件值', () => {
    expect(resolveServerUrl('', 'http://file:2', FALLBACK)).toBe('http://file:2');
  });

  it('env 只有空白 → 视为未提供，取文件值', () => {
    expect(resolveServerUrl('   ', 'http://file:2', FALLBACK)).toBe('http://file:2');
  });

  it('env 未定义 → 取文件值', () => {
    expect(resolveServerUrl(undefined, 'http://file:2', FALLBACK)).toBe('http://file:2');
  });

  it('文件为 null（缺失/非法）→ 取 fallback', () => {
    expect(resolveServerUrl(undefined, null, FALLBACK)).toBe(FALLBACK);
  });

  it('两侧有空白 → 取 trim 后的值', () => {
    expect(resolveServerUrl('  http://env:1  ', null, FALLBACK)).toBe('http://env:1');
  });

  it('env 与文件都为空 → 返回 fallback', () => {
    expect(resolveServerUrl('', null, FALLBACK)).toBe(FALLBACK);
  });
});
