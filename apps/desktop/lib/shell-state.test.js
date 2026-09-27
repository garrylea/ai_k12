import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const { readStudentMode, writeStudentMode, STATE_FILE_NAME } = require('./shell-state.js');

let dir;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'k12-state-'));
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('readStudentMode', () => {
  it('无文件 → false', () => {
    expect(readStudentMode(dir)).toBe(false);
  });

  it('写入 true 后读回 true', () => {
    writeStudentMode(dir, true);
    expect(readStudentMode(dir)).toBe(true);
  });

  it('写入 false 后读回 false', () => {
    writeStudentMode(dir, true);
    writeStudentMode(dir, false);
    expect(readStudentMode(dir)).toBe(false);
  });

  it('JSON 损坏 → false（坏数据不该把家长锁在 kiosk 里）', () => {
    fs.writeFileSync(path.join(dir, STATE_FILE_NAME), '{oops', 'utf8');
    expect(readStudentMode(dir)).toBe(false);
  });

  it('顶层是数组 → false', () => {
    fs.writeFileSync(path.join(dir, STATE_FILE_NAME), '[true]', 'utf8');
    expect(readStudentMode(dir)).toBe(false);
  });

  it('顶层是 null → false', () => {
    fs.writeFileSync(path.join(dir, STATE_FILE_NAME), 'null', 'utf8');
    expect(readStudentMode(dir)).toBe(false);
  });

  it('studentMode 非布尔（如 "yes"）→ false', () => {
    fs.writeFileSync(
      path.join(dir, STATE_FILE_NAME),
      JSON.stringify({ studentMode: 'yes' }),
      'utf8',
    );
    expect(readStudentMode(dir)).toBe(false);
  });
});

describe('writeStudentMode', () => {
  it('目录不存在时自动建目录，不抛错，且能读回', () => {
    const missing = path.join(dir, 'nested', 'deep');
    expect(() => writeStudentMode(missing, true)).not.toThrow();
    expect(readStudentMode(missing)).toBe(true);
  });

  it('非布尔入参被强制成布尔：落盘的是布尔，不是原始值', () => {
    writeStudentMode(dir, 'yes');
    const raw = JSON.parse(fs.readFileSync(path.join(dir, STATE_FILE_NAME), 'utf8'));
    // Boolean('yes') === true —— 这里是**类型强制**，不是「把真值丢掉」。
    // 断言用 toBe（严格同一）才能同时钉住「值是 true」与「类型是 boolean」：
    // 若实现写成 JSON.stringify({ studentMode: on })，落盘会是字符串 'yes'，此断言即红。
    expect(raw.studentMode).toBe(true);
  });
});
