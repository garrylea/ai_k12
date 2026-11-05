import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { createKioskGuard } = require('./kiosk-guard.js');

/**
 * 假窗口：状态可读可改，动作只记录调用，方便断言「该调什么、不该调什么」。
 */
function makeWindow(initial = {}) {
  const state = {
    visible: true,
    focused: true,
    kiosk: true,
    fullscreen: true,
    destroyed: false,
    ...initial,
  };
  const calls = [];
  const win = {
    isDestroyed: () => state.destroyed,
    isVisible: () => state.visible,
    isFocused: () => state.focused,
    isKiosk: () => state.kiosk,
    isFullScreen: () => state.fullscreen,
    show: () => {
      calls.push('show');
      state.visible = true;
    },
    focus: () => {
      calls.push('focus');
      state.focused = true;
    },
    moveTop: () => calls.push('moveTop'),
    setKiosk: (on) => {
      calls.push(`setKiosk:${on}`);
      state.kiosk = on;
      if (on) state.fullscreen = true;
    },
    setFullScreen: (on) => {
      calls.push(`setFullScreen:${on}`);
      state.fullscreen = on;
    },
    setClosable: (on) => calls.push(`setClosable:${on}`),
    setMinimizable: (on) => calls.push(`setMinimizable:${on}`),
  };
  return { win, state, calls };
}

function createHarness({ initial = {}, platform = 'darwin', enabled = true } = {}) {
  const { win, state, calls } = makeWindow(initial);
  const focusAppCalls = [];
  const logs = [];
  const mode = { enabled };
  const guard = createKioskGuard({
    isEnabled: () => mode.enabled,
    getWindow: () => win,
    platform,
    focusApp: () => focusAppCalls.push('focusApp'),
    diagnostics: () => ({ appActive: true, win: '1440x900@0,0', display: '1728x1117' }),
    log: (message) => logs.push(message),
    restoreDelayMs: 300,
    watchdogMs: 1000,
    cooldownMs: 1500,
  });
  return { guard, win, state, calls, focusAppCalls, logs, mode };
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('createKioskGuard', () => {
  it('窗口健康时，事件调度不产生任何窗口动作', () => {
    const { guard, calls } = createHarness();
    guard.schedule('blur');
    vi.advanceTimersByTime(1000);
    expect(calls).toEqual([]);
  });

  it('学生模式关闭时，看门狗与调度都不动窗口', () => {
    const { guard, calls, mode } = createHarness({ enabled: false });
    mode.enabled = false;
    guard.start();
    guard.schedule('blur');
    vi.advanceTimersByTime(5000);
    expect(calls).toEqual([]);
    guard.stop();
  });

  it('被踢出全屏（kiosk 标志还在）：必须 false→true 完整重进 kiosk，而不是只补全屏', () => {
    const { guard, calls, state } = createHarness({ initial: { fullscreen: false } });
    guard.schedule('leave-full-screen');
    vi.advanceTimersByTime(300);

    // 关键：isKiosk() 仍为 true 时 setKiosk(true) 是空操作，必须先 false 复位。
    expect(calls).toContain('setKiosk:false');
    expect(calls).toContain('setKiosk:true');
    expect(calls.indexOf('setKiosk:false')).toBeLessThan(calls.indexOf('setKiosk:true'));
    expect(calls).toContain('setFullScreen:true'); // 兜底
    expect(calls).toContain('setClosable:false');
    expect(calls).toContain('setMinimizable:false');
    expect(state.fullscreen).toBe(true);
  });

  it('全屏还在但 kiosk 标志掉了：只补一次 setKiosk(true)，不做完整重进', () => {
    const { guard, calls } = createHarness({ initial: { kiosk: false } });
    guard.schedule('blur');
    vi.advanceTimersByTime(300);
    expect(calls.filter((c) => c === 'setKiosk:true')).toHaveLength(1);
    expect(calls).not.toContain('setKiosk:false');
    expect(calls).not.toContain('setFullScreen:true');
  });

  it('只是失焦（kiosk + 全屏都还在）：不重进 kiosk，避免每次通知都闪一次全屏', () => {
    const { guard, calls, focusAppCalls, state } = createHarness();
    state.focused = false;

    guard.schedule('blur');
    expect(calls).toEqual([]); // 事件只调度，不立即动作（避开全屏动画）
    vi.advanceTimersByTime(300);

    expect(focusAppCalls).toEqual(['focusApp']);
    expect(calls).toContain('focus');
    expect(calls).toContain('moveTop');
    expect(calls).not.toContain('setKiosk:true');
    expect(calls).not.toContain('setKiosk:false');
    expect(state.focused).toBe(true);
  });

  it('非 macOS 不调用 app.focus，只聚焦窗口', () => {
    const { guard, calls, focusAppCalls, state } = createHarness({ platform: 'win32' });
    state.focused = false;
    guard.schedule('blur');
    vi.advanceTimersByTime(300);
    expect(focusAppCalls).toEqual([]);
    expect(calls).toContain('focus');
  });

  it('现场诊断写进日志（真机复现 Siri 时用来判读窗口/显示器状态）', () => {
    const { guard, logs, state } = createHarness();
    state.fullscreen = false;
    guard.schedule('did-become-active');
    expect(logs[0]).toContain('appActive=true');
    expect(logs[0]).toContain('win=1440x900@0,0');
  });

  it('kiosk 掉了：setKiosk(true) 一并恢复全屏', () => {
    const { guard, calls, state } = createHarness({ initial: { kiosk: false, fullscreen: false } });
    guard.schedule('leave-full-screen');
    vi.advanceTimersByTime(300);
    expect(calls).toContain('setKiosk:true');
    expect(state.kiosk).toBe(true);
    expect(state.fullscreen).toBe(true);
  });

  it('窗口被隐藏：先 show 再恢复', () => {
    const { guard, calls, state } = createHarness({ initial: { visible: false, focused: false } });
    guard.schedule('hide');
    vi.advanceTimersByTime(300);
    expect(calls[0]).toBe('show');
    expect(state.visible).toBe(true);
  });

  it('看门狗：没有事件、状态悄悄掉了也会恢复', () => {
    const { guard, state, calls } = createHarness();
    guard.start();
    state.fullscreen = false;
    vi.advanceTimersByTime(1300); // 1000ms 触发 → 再等 300ms 延迟
    expect(calls).toContain('setFullScreen:true');
    guard.stop();
  });

  it('冷却期内不重复恢复，避免全屏动画抖动', () => {
    const { guard, calls, state } = createHarness();
    state.kiosk = false;
    state.fullscreen = false;

    guard.restore('manual-1');
    expect(calls.filter((c) => c === 'setKiosk:true')).toHaveLength(1);

    state.kiosk = false; // 模拟恢复还没生效又掉了
    state.fullscreen = false;
    guard.restore('manual-2');
    expect(calls.filter((c) => c === 'setKiosk:true')).toHaveLength(1); // 冷却期内被挡

    vi.advanceTimersByTime(1500);
    guard.restore('manual-3');
    expect(calls.filter((c) => c === 'setKiosk:true')).toHaveLength(2);
  });

  it('stop 会清掉已排队的恢复', () => {
    const { guard, calls, state } = createHarness();
    state.focused = false;
    guard.schedule('blur');
    guard.stop();
    vi.advanceTimersByTime(300);
    expect(calls).toEqual([]);
  });

  it('窗口已销毁：不抛错、不动作', () => {
    const { guard, calls, state } = createHarness();
    state.destroyed = true;
    expect(() => {
      guard.schedule('blur');
      vi.advanceTimersByTime(300);
      guard.tick();
    }).not.toThrow();
    expect(calls).toEqual([]);
  });

  it('窗口方法抛错：吞掉并记录，不打断后续看门狗', () => {
    const calls = [];
    const logs = [];
    const throwingWin = {
      isDestroyed: () => false,
      isVisible: () => true,
      isFocused: () => false,
      isKiosk: () => false,
      isFullScreen: () => false,
      show: () => {},
      focus: () => {},
      moveTop: () => {},
      setKiosk: () => {
        calls.push('setKiosk');
        throw new Error('native window gone');
      },
      setFullScreen: () => {},
    };
    const guard = createKioskGuard({
      isEnabled: () => true,
      getWindow: () => throwingWin,
      platform: 'darwin',
      focusApp: () => {},
      log: (message) => logs.push(message),
    });

    expect(() => guard.restore('boom')).not.toThrow();
    expect(calls).toEqual(['setKiosk']);
    expect(logs.some((line) => line.includes('restore-error reason=boom'))).toBe(true);
    expect(logs.some((line) => line.includes('native window gone'))).toBe(true);
  });
});
