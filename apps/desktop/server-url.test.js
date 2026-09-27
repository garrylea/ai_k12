import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';

// lib 与这些配置文件是 CJS，用 createRequire 引入（Vite 不转换项目内的 CJS 源文件）
const require = createRequire(import.meta.url);
const { SERVER_URL } = require('./server-url.js');

describe('server-url.js：构建时写死点', () => {
  it('是非空字符串', () => {
    expect(typeof SERVER_URL).toBe('string');
    expect(SERVER_URL.trim()).not.toBe('');
  });

  it('以 http(s):// 开头（防止被改成空值后静默退化成相对地址）', () => {
    expect(SERVER_URL).toMatch(/^https?:\/\//);
  });
});
