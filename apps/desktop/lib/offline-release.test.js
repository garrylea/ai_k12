import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { OFFLINE_RELEASE_FILE_NAME, markOfflineRelease, clearOfflineRelease } from './offline-release.js';

let dir;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'k12-offline-release-'));
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('offline-release', () => {
  it('写入带时间的标记文件（看护脚本只判存在，内容用于排障）', () => {
    expect(markOfflineRelease(dir, new Date('2026-11-12T01:02:03.000Z'))).toBe(true);
    const raw = fs.readFileSync(path.join(dir, OFFLINE_RELEASE_FILE_NAME), 'utf8');
    expect(JSON.parse(raw)).toEqual({ releasedAt: '2026-11-12T01:02:03.000Z' });
  });

  it('重复写不会抛（每次加载失败都可能再落一次）', () => {
    expect(markOfflineRelease(dir)).toBe(true);
    expect(markOfflineRelease(dir)).toBe(true);
  });

  it('目录不存在时自动创建', () => {
    const nested = path.join(dir, 'not', 'yet');
    expect(markOfflineRelease(nested)).toBe(true);
    expect(fs.existsSync(path.join(nested, OFFLINE_RELEASE_FILE_NAME))).toBe(true);
  });

  it('清标记：删掉文件；不存在时静默返回 false', () => {
    markOfflineRelease(dir);
    expect(clearOfflineRelease(dir)).toBe(true);
    expect(fs.existsSync(path.join(dir, OFFLINE_RELEASE_FILE_NAME))).toBe(false);
    expect(clearOfflineRelease(dir)).toBe(false);
  });

  it('写失败不抛（拿文件当目录），否则会阻断启动', () => {
    const fileAsDir = path.join(dir, 'occupied');
    fs.writeFileSync(fileAsDir, 'x');
    expect(() => markOfflineRelease(fileAsDir)).not.toThrow();
    expect(markOfflineRelease(fileAsDir)).toBe(false);
  });
});
