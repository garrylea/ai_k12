import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { markRunning, wasAbnormalExit, markCleanExit } = require('./exit-audit.js');

let dir;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'k12-exit-audit-'));
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('exit-audit', () => {
  it('第一次启动没有标记 → 不算异常结束', () => {
    expect(wasAbnormalExit(dir)).toBe(false);
  });

  it('正常运行中标记存在 → 重新启动即判定上次异常结束', () => {
    markRunning(dir);
    expect(fs.existsSync(path.join(dir, 'running.flag'))).toBe(true);
    expect(wasAbnormalExit(dir)).toBe(true);
  });

  it('正常退出会清标记', () => {
    markRunning(dir);
    markCleanExit(dir);
    expect(wasAbnormalExit(dir)).toBe(false);
  });

  it('目录不可写也不抛（写入永不阻断启动）', () => {
    expect(() => markRunning(path.join(dir, 'missing', 'deeper'))).not.toThrow();
    expect(wasAbnormalExit(path.join(dir, 'missing'))).toBe(false);
    expect(() => markCleanExit(path.join(dir, 'missing'))).not.toThrow();
  });
});
