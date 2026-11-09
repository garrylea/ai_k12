import { describe, it, expect, afterEach } from 'vitest';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

/**
 * 原生键盘钩子的加载测试（2026-11-09）。
 *
 * **只在 Windows 上跑**，且依赖 CI 在 npm test 之前先执行 `npm run build:keyhook`
 * （产物 `native/keyhook.node`，不入库）。mac/linux 上整个 describe 被跳过 ——
 * 本机 `npm test` 不应该因为缺一个 Windows 动态库而红。
 *
 * 这里只验证 ABI 与线程生命周期；真实拦截效果必须在真机手测（见 spec）。
 * CI runner 不一定有交互式桌面，`SetWindowsHookEx` 可能失败 —— 失败只记录，不让发布流水线假红。
 */

const require = createRequire(import.meta.url);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const MODULE = path.resolve(HERE, '..', 'keyhook.node');

describe.skipIf(process.platform !== 'win32')('keyhook 原生模块（仅 Windows）', () => {
  afterEach(() => {
    try {
      require(MODULE).stop();
    } catch {
      /* 没加载成功就没什么可停的 */
    }
  });

  it('产物存在', () => {
    expect(existsSync(MODULE)).toBe(true);
  });

  it('能加载、ping 正常', () => {
    const mod = require(MODULE);
    expect(typeof mod.start).toBe('function');
    expect(typeof mod.stop).toBe('function');
    expect(typeof mod.isActive).toBe('function');
    const ping = mod.ping();
    expect(ping.ok).toBe(true);
    expect(ping.active).toBe(false);
  });

  it('start/stop 生命周期（非交互式桌面允许 start 失败）', () => {
    const mod = require(MODULE);
    const started = mod.start();
    if (started) {
      expect(mod.isActive()).toBe(true);
    } else {
      console.warn(`[keyhook] start() 返回 false（lastError=${mod.lastError()}），可能是 CI runner 非交互式桌面`);
    }
    mod.stop();
    expect(mod.isActive()).toBe(false);
  });
});
