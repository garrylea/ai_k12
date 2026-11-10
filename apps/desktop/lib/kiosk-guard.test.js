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
      // 真实 Electron：setKiosk(false) 是**异步**退出全屏（约 100ms 后才变 false），
      // 所以这里刻意不动 fullscreen —— 测试用 state.finishExit() 手动结束动画。
      if (on) state.fullscreen = true;
    },
    setFullScreen: (on) => {
      calls.push(`setFullScreen:${on}`);
      state.fullscreen = on;
    },
    setClosable: (on) => calls.push(`setClosable:${on}`),
    setMinimizable: (on) => calls.push(`setMinimizable:${on}`),
  };
  return {
    win,
    state,
    calls,
    /** 模拟「退出全屏动画结束」。 */
    finishExit: () => {
      state.fullscreen = false;
    },
  };
}

function createHarness({ initial = {}, platform = 'darwin', enabled = true } = {}) {
  const { win, state, calls, finishExit } = makeWindow(initial);
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
  return { guard, win, state, calls, finishExit, focusAppCalls, logs, mode };
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
    vi.advanceTimersByTime(300); // 调度延迟

    // 关键：isKiosk() 仍为 true 时 setKiosk(true) 是空操作，必须先 false 复位。
    expect(calls).toContain('setKiosk:false');
    expect(calls).not.toContain('setKiosk:true'); // 退出动画还没结束，不能急着进

    vi.advanceTimersByTime(100); // 轮询到「已退出全屏」→ 才 setKiosk(true)
    expect(calls.indexOf('setKiosk:false')).toBeLessThan(calls.indexOf('setKiosk:true'));

    vi.advanceTimersByTime(1200); // 进入动画结束 → 钉窗口能力
    expect(calls).toContain('setClosable:false');
    expect(calls).toContain('setMinimizable:false');
    expect(state.fullscreen).toBe(true);
    expect(state.kiosk).toBe(true);
  });

  it('重进必须等退出全屏动画结束：全屏还没退干净就不许 setKiosk(true)', () => {
    // 2026-11-09 实测：back-to-back 调用时 Electron 的 SetFullScreen 会直接 return，
    // presentation options（Cmd+Tab 封锁）永远不会被重新设置 —— 看着全屏、其实能切走。
    const { guard, calls, state, finishExit } = createHarness();
    guard.scheduleReassert('did-become-active');
    vi.advanceTimersByTime(300);

    expect(calls).toContain('setKiosk:false');
    vi.advanceTimersByTime(500); // 全屏仍是 true（假窗口模拟动画没结束）
    expect(calls).not.toContain('setKiosk:true');

    finishExit();
    vi.advanceTimersByTime(100);
    expect(calls).toContain('setKiosk:true');
    expect(state.kiosk).toBe(true);
  });

  it('scheduleReassert：四项状态全"健康"也要重进 kiosk（Siri 之后 Cmd+Tab 能切走的根因）', () => {
    // 失活会收回 app 级 presentation options，但 isVisible/isFocused/isKiosk/isFullScreen
    // 全是 true —— healthy() 看不出来，必须无条件重进。
    const { guard, calls, state, finishExit, focusAppCalls } = createHarness();
    guard.scheduleReassert('did-become-active');
    vi.advanceTimersByTime(300);

    expect(focusAppCalls).toContain('focusApp'); // 先把 App 激活，选项才会生效
    expect(calls).toContain('setKiosk:false');
    finishExit();
    vi.advanceTimersByTime(100);
    expect(calls).toContain('setKiosk:true');
    expect(state.kiosk).toBe(true);
  });

  it('scheduleReassert 受冷却约束：紧接着再来一次不会重复闪全屏', () => {
    const { guard, calls, finishExit } = createHarness();
    guard.scheduleReassert('first');
    vi.advanceTimersByTime(300);
    finishExit();
    vi.advanceTimersByTime(100);
    const before = calls.filter((c) => c === 'setKiosk:false').length;

    guard.scheduleReassert('second');
    vi.advanceTimersByTime(300);
    expect(calls.filter((c) => c === 'setKiosk:false')).toHaveLength(before);
  });

  it('全屏还在但 kiosk 标志掉了：只补一次 setKiosk(true)，不做完整重进', () => {
    const { guard, calls } = createHarness({ initial: { kiosk: false } });
    guard.schedule('blur');
    vi.advanceTimersByTime(300);
    expect(calls.filter((c) => c === 'setKiosk:true')).toHaveLength(1);
    expect(calls).not.toContain('setKiosk:false');
    expect(calls).not.toContain('setFullScreen:true');
  });

  it('只是失焦（kiosk + 全屏都还在）：抢回焦点后仍要完整重进 kiosk', () => {
    // 2026-11-09 修正：旧版这条断言「失焦不重进」，结果 Siri 之后 Cmd+Tab 永久可用 ——
    // presentation options 是 app 级的，失活即被收回，抢回焦点不会自动恢复。
    const { guard, calls, finishExit, focusAppCalls, state } = createHarness();
    state.focused = false;

    guard.schedule('blur');
    expect(calls).toEqual([]); // 事件只调度，不立即动作（避开全屏动画）
    vi.advanceTimersByTime(300);

    expect(focusAppCalls).toEqual(['focusApp']);
    expect(calls).toContain('focus');
    expect(calls).toContain('moveTop');
    expect(state.focused).toBe(true);
    expect(calls).not.toContain('setKiosk:false'); // 先等焦点生效，再重进

    vi.advanceTimersByTime(300);
    expect(calls).toContain('setKiosk:false'); // 完整重进，而不是只补焦点
    finishExit();
    vi.advanceTimersByTime(100);
    expect(calls).toContain('setKiosk:true');
  });

  it('非 macOS 不调用 app.focus，只聚焦窗口', () => {
    const { guard, calls, focusAppCalls, state } = createHarness({ platform: 'win32' });
    state.focused = false;
    guard.schedule('blur');
    vi.advanceTimersByTime(300);
    expect(focusAppCalls).toEqual([]);
    expect(calls).toContain('focus');
  });

  it('Windows 失焦但不缺全屏：只聚焦，不重进 kiosk（避免每次切回来闪一下）', () => {
    const { guard, calls, state } = createHarness({ platform: 'win32' });
    state.focused = false;
    guard.schedule('blur');
    vi.advanceTimersByTime(600);
    expect(calls).toContain('focus');
    expect(calls).not.toContain('setKiosk:false');
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
    vi.advanceTimersByTime(400); // 300 调度 + 100 轮询
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
    vi.advanceTimersByTime(1400); // 1000ms 触发 → 再等 300ms 延迟 + 100ms 轮询
    expect(calls).toContain('setKiosk:false');
    expect(calls).toContain('setKiosk:true');
    expect(state.kiosk).toBe(true);
    guard.stop();
  });

  it('冷却期内不重复恢复，避免全屏动画抖动', () => {
    const { guard, calls, state } = createHarness({ initial: { kiosk: false, fullscreen: false } });

    guard.restore('manual-1');
    vi.advanceTimersByTime(100); // 轮询到已退出全屏 → setKiosk(true)
    expect(calls.filter((c) => c === 'setKiosk:true')).toHaveLength(1);

    state.kiosk = false; // 模拟恢复还没生效又掉了
    state.fullscreen = false;
    guard.restore('manual-2');
    expect(calls.filter((c) => c === 'setKiosk:true')).toHaveLength(1); // 冷却期内被挡

    vi.advanceTimersByTime(2000); // 等第一次重进彻底结束 + 过冷却
    state.kiosk = false;
    state.fullscreen = false;
    guard.restore('manual-3');
    vi.advanceTimersByTime(100);
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

  it('stop 会中止进行中的重进（家长登录后不能被继续按在 kiosk 里）', () => {
    const { guard, calls, mode, finishExit } = createHarness();
    guard.scheduleReassert('did-become-active');
    vi.advanceTimersByTime(300); // 重进已开始（setKiosk(false) 已调用）
    expect(calls).toContain('setKiosk:false');

    mode.enabled = false; // 学生登出 / 家长登录
    guard.stop();
    finishExit();
    vi.advanceTimersByTime(5000);

    expect(calls.filter((c) => c === 'setKiosk:true')).toHaveLength(0);
    expect(calls).not.toContain('setClosable:false');
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

    expect(() => {
      guard.restore('boom');
      vi.advanceTimersByTime(300); // 失焦时先等焦点生效，再重进 → 这里才真正调 setKiosk(false)
    }).not.toThrow();
    expect(calls).toEqual(['setKiosk']);
    expect(logs.some((line) => line.includes('reenter-error reason=boom'))).toBe(true);
    expect(logs.some((line) => line.includes('native window gone'))).toBe(true);
  });

  // 2026-11-10：锁屏 / 显示器休眠时被看护拉起，AppKit 的全屏过渡永远完不成。
  // 旧行为是每秒重排一次恢复，窗口永远停在过渡态（页面加载了但全白）。
  it('连续抢不到全屏 → 退出卡住的过渡、退避，不再每秒重试', () => {
    const { guard, calls, state, logs, win } = createHarness({ initial: { fullscreen: false } });
    // 模拟「无论怎么调，窗口都进不了全屏」（锁屏时的真实表现）。
    win.setKiosk = (on) => {
      calls.push(`setKiosk:${on}`);
      state.kiosk = on;
    };
    win.setFullScreen = (on) => {
      calls.push(`setFullScreen:${on}`);
      state.fullscreen = false;
    };

    for (let i = 0; i < 3; i += 1) {
      guard.schedule('watchdog');
      vi.advanceTimersByTime(2000); // 调度 300 + 轮询 100 + 进入动画 1200
    }

    expect(logs.some((line) => line.includes('fullscreen-unavailable'))).toBe(true);
    // 退避动作：保证窗口处在「能显示」的普通窗口（抬到最前；不可见时补 show）
    expect(calls).toContain('moveTop');

    const before = calls.length;
    guard.schedule('watchdog');
    guard.scheduleReassert('did-become-active');
    guard.restore('blur');
    vi.advanceTimersByTime(5000);
    expect(calls.length).toBe(before); // 退避期内不再动窗口
  });

  it('解锁 → notifyUnlocked 立刻清掉退避并重进', () => {
    const { guard, calls, state, win } = createHarness({ initial: { fullscreen: false } });
    win.setKiosk = (on) => {
      calls.push(`setKiosk:${on}`);
      state.kiosk = on;
    };
    win.setFullScreen = (on) => {
      calls.push(`setFullScreen:${on}`);
      state.fullscreen = false;
    };

    for (let i = 0; i < 3; i += 1) {
      guard.schedule('watchdog');
      vi.advanceTimersByTime(2000);
    }
    const beforeRetry = calls.length;
    guard.notifyUnlocked('unlock-screen');

    // 环境变了：解锁后必须立即可用（不能等 30 秒退避到期）
    vi.advanceTimersByTime(3000);
    expect(calls.length).toBeGreaterThan(beforeRetry);
    expect(calls.slice(beforeRetry).some((c) => c.startsWith('setKiosk'))).toBe(true);
  });
});
