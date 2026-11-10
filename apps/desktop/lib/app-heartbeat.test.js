import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { HEARTBEAT_FILE_NAME, markAlive, clearAlive } = require('./app-heartbeat.js');

let dir;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'k12-heartbeat-'));
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('app-heartbeat', () => {
  it('写的是当前进程 pid（看护用 kill -0 判活）', () => {
    markAlive(dir);
    const file = path.join(dir, HEARTBEAT_FILE_NAME);
    expect(fs.existsSync(file)).toBe(true);
    expect(fs.readFileSync(file, 'utf8')).toBe(String(process.pid));
  });

  it('正常退出会清掉心跳', () => {
    markAlive(dir);
    clearAlive(dir);
    expect(fs.existsSync(path.join(dir, HEARTBEAT_FILE_NAME))).toBe(false);
  });

  it('重复写是幂等的（覆盖同一个文件）', () => {
    markAlive(dir);
    markAlive(dir);
    expect(fs.readdirSync(dir)).toEqual([HEARTBEAT_FILE_NAME]);
  });

  it('目录不可写也不抛（心跳缺失好过启动失败）', () => {
    const bad = path.join(dir, 'missing', 'deeper');
    expect(() => markAlive(bad)).not.toThrow();
    expect(() => clearAlive(bad)).not.toThrow();
  });
});
