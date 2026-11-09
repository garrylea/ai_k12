import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { createKeyboardHook } = require('./keyboard-hook.js');

/** 假原生模块：只记录调用，行为可配。 */
function makeModule({ startResult = true, active = false, throwOnStart = false } = {}) {
  const state = { active, starts: 0, stops: 0 };
  return {
    state,
    start: () => {
      state.starts += 1;
      if (throwOnStart) throw new Error('native boom');
      if (startResult) state.active = true;
      return startResult;
    },
    stop: () => {
      state.stops += 1;
      state.active = false;
    },
    isActive: () => state.active,
    lastError: () => 5,
  };
}

function createHarness({ platform = 'win32', moduleOptions = {}, module, loadError = null } = {}) {
  const logs = [];
  const loads = [];
  const target = module === undefined ? makeModule(moduleOptions) : module;
  const hook = createKeyboardHook({
    platform,
    load: () => {
      loads.push(1);
      if (loadError) throw loadError;
      return target;
    },
    log: (message) => logs.push(message),
    healthMs: 5000,
  });
  return { hook, module: target, logs, loads };
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('createKeyboardHook', () => {
  it('非 win32：不加载原生模块、不动窗口、无日志', () => {
    const { hook, loads, logs, module } = createHarness({ platform: 'darwin' });
    hook.setEnabled(true);
    vi.advanceTimersByTime(20_000);
    expect(loads).toEqual([]);
    expect(module.state.starts).toBe(0);
    expect(logs).toEqual([]);
    expect(hook.isRunning()).toBe(false);
  });

  it('win32 + 学生模式：装钩子；重复 enable 不重复装', () => {
    const { hook, module, logs } = createHarness();
    hook.setEnabled(true);
    expect(module.state.starts).toBe(1);
    expect(hook.isRunning()).toBe(true);
    expect(logs).toContain('[hook] enabled');

    hook.setEnabled(true);
    expect(module.state.starts).toBe(1);
  });

  it('退出学生模式：摘钩子', () => {
    const { hook, module, logs } = createHarness();
    hook.setEnabled(true);
    hook.setEnabled(false);
    expect(module.state.stops).toBe(1);
    expect(hook.isRunning()).toBe(false);
    expect(logs).toContain('[hook] disabled');
  });

  it('缺 .node / ABI 不兼容：只记一次日志，不抛、不再重试', () => {
    const { hook, logs, loads } = createHarness({ loadError: new Error('Cannot find module') });
    expect(() => hook.setEnabled(true)).not.toThrow();
    expect(logs.some((line) => line.includes('load-failed'))).toBe(true);

    hook.setEnabled(false);
    hook.setEnabled(true);
    expect(loads).toHaveLength(1); // 失败后不再重试
  });

  it('SetWindowsHookEx 失败：记一次 start-failed，继续跑', () => {
    const { hook, logs, module } = createHarness({ moduleOptions: { startResult: false } });
    hook.setEnabled(true);
    expect(module.state.starts).toBe(1);
    expect(logs.filter((line) => line.includes('start-failed'))).toHaveLength(1);

    hook.setEnabled(false);
    hook.setEnabled(true);
    expect(logs.filter((line) => line.includes('start-failed'))).toHaveLength(1); // 不刷屏
  });

  it('钩子线程死了：健康检查自动重装', () => {
    const { hook, module, logs } = createHarness();
    hook.setEnabled(true);

    module.state.active = false; // 模拟线程异常退出
    vi.advanceTimersByTime(5000);
    expect(module.state.starts).toBe(2);
    expect(logs.some((line) => line.includes('health'))).toBe(true);
    expect(hook.isRunning()).toBe(true);
  });

  it('钩子正常时不重复安装', () => {
    const { hook, module } = createHarness();
    hook.setEnabled(true);
    vi.advanceTimersByTime(30_000);
    expect(module.state.starts).toBe(1);
  });

  it('reassert：关掉后不会偷偷装回来', () => {
    const { hook, module } = createHarness();
    hook.reassert();
    expect(module.state.starts).toBe(0);

    hook.setEnabled(true);
    module.state.active = false;
    hook.reassert();
    expect(module.state.starts).toBe(2);
  });
});
