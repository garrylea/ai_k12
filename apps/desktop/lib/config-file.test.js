import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const { readServerUrlFromFile, CONFIG_FILE_NAME } = require('./config-file.js');

let dir;

beforeEach(() => {
  // 用真实临时目录写真实文件来测，不 mock fs（spec §5）
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'k12-config-'));
  // 非法情形都会 warn，静音以免刷屏；用例仍然断言返回值
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(dir, { recursive: true, force: true });
});

const write = (content) =>
  fs.writeFileSync(path.join(dir, CONFIG_FILE_NAME), content, 'utf8');

describe('readServerUrlFromFile', () => {
  it('文件不存在 → null（正常路径，不是异常）', () => {
    expect(readServerUrlFromFile(dir)).toBeNull();
  });

  it('非 JSON → null', () => {
    write('这不是 json');
    expect(readServerUrlFromFile(dir)).toBeNull();
  });

  it('JSON 但顶层是数组 → null', () => {
    write('[]');
    expect(readServerUrlFromFile(dir)).toBeNull();
  });

  it('JSON 但顶层是字符串 → null', () => {
    write('"x"');
    expect(readServerUrlFromFile(dir)).toBeNull();
  });

  it('JSON 但顶层是 null → null', () => {
    write('null');
    expect(readServerUrlFromFile(dir)).toBeNull();
  });

  it('serverUrl 缺失 → null', () => {
    write('{}');
    expect(readServerUrlFromFile(dir)).toBeNull();
  });

  it('serverUrl 非字符串 → null', () => {
    write(JSON.stringify({ serverUrl: 123 }));
    expect(readServerUrlFromFile(dir)).toBeNull();
  });

  it('serverUrl 是空白串 → null', () => {
    write(JSON.stringify({ serverUrl: '   ' }));
    expect(readServerUrlFromFile(dir)).toBeNull();
  });

  it('serverUrl 不是 http(s) → null', () => {
    write(JSON.stringify({ serverUrl: 'ftp://example.com/a' }));
    expect(readServerUrlFromFile(dir)).toBeNull();
  });

  it('serverUrl 不可解析 → null', () => {
    write(JSON.stringify({ serverUrl: 'not a url' }));
    expect(readServerUrlFromFile(dir)).toBeNull();
  });

  it('合法 http 值 → 返回 trim 后的值', () => {
    write(JSON.stringify({ serverUrl: '  http://192.168.1.5:5173  ' }));
    expect(readServerUrlFromFile(dir)).toBe('http://192.168.1.5:5173');
  });

  it('合法 https 值也接受', () => {
    write(JSON.stringify({ serverUrl: 'https://learn.example.com' }));
    expect(readServerUrlFromFile(dir)).toBe('https://learn.example.com');
  });

  it('忽略其它无关字段', () => {
    write(JSON.stringify({ 别的: 1, serverUrl: 'http://a:1' }));
    expect(readServerUrlFromFile(dir)).toBe('http://a:1');
  });
});
