import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as tracker from './tracker';

function makeTransport() {
  return {
    start: vi.fn().mockResolvedValue(undefined),
    heartbeat: vi.fn().mockResolvedValue(undefined),
    end: vi.fn().mockResolvedValue(undefined),
  };
}

const STUDY = { module: 'training_targeted', scene: 'targeted_run', isStudyScene: true } as const;
const NOT_STUDY = { module: null, scene: 'profile', isStudyScene: false } as const;

let transport: ReturnType<typeof makeTransport>;

beforeEach(() => {
  vi.useFakeTimers();
  tracker.__resetForTests();
  transport = makeTransport();
  tracker.setTransport(transport);
  tracker.setSubjectIdProvider(() => 7);
  // jsdom 没有 matchMedia；单指触屏 → touch
  vi.stubGlobal('matchMedia', (q: string) => ({ matches: q.includes('pointer: coarse)') }));
  tracker.setEnabled(true);
});

afterEach(() => {
  tracker.__resetForTests();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('tracker 会话生命周期', () => {
  it('进入学习场景 → start，设备信息**一次性**带上', async () => {
    tracker.onRouteChange(STUDY);
    await vi.advanceTimersByTimeAsync(0);

    expect(transport.start).toHaveBeenCalledTimes(1);
    const body = transport.start.mock.calls[0][0];
    expect(body.module).toBe('training_targeted');
    expect(body.scene).toBe('targeted_run');
    expect(body.subjectId).toBe(7);
    expect(body.screenClass).toBeTruthy();
    expect(body.inputType).toBe('touch');
    expect(body.appShell).toBe('web');
    expect(body.sessionUid).toMatch(/[0-9a-f-]{8,}/i);
  });

  it('30s 心跳只发 state，**不重复带设备字段**', async () => {
    tracker.onRouteChange(STUDY);
    await vi.advanceTimersByTimeAsync(30_000);

    expect(transport.heartbeat).toHaveBeenCalledWith(expect.any(String), 'visible');
    const args = transport.heartbeat.mock.calls[0];
    expect(args).toHaveLength(2); // (uid, state) —— 没有第三个「设备」参数
  });

  it('同一学习场景重复调用不重开会话（query 变化不该算新会话）', async () => {
    tracker.onRouteChange(STUDY);
    tracker.onRouteChange(STUDY);
    await vi.advanceTimersByTimeAsync(0);
    expect(transport.start).toHaveBeenCalledTimes(1);
  });

  it('学习场景 A → B：先 end(route_change) 再 start', async () => {
    tracker.onRouteChange(STUDY);
    tracker.onRouteChange({ module: 'en_vocabulary', scene: 'vocabulary_run', isStudyScene: true });
    await vi.advanceTimersByTimeAsync(0);

    expect(transport.end).toHaveBeenCalledWith(expect.any(String), 'route_change');
    expect(transport.start).toHaveBeenCalledTimes(2);
  });

  it('hidden 状态下切学习场景：仍必须先 end 再 start', async () => {
    // 顺序钉子：状态机的 `hidden + ROUTE_ENTER` 是**死格**（状态不变、不 start）。
    // 若 onRouteChange 不先发 ROUTE_LEAVE，切场景时会静默**开不出新会话**，
    // 而且因为各入口都以 sessionUid 为闸门，之后整个 SPA 生命周期都不会再有会话。
    tracker.onRouteChange(STUDY);
    await vi.advanceTimersByTimeAsync(125_000); // 空闲 → hidden
    const firstUid = transport.start.mock.calls[0][0].sessionUid;

    tracker.onRouteChange({ module: 'en_vocabulary', scene: 'vocabulary_run', isStudyScene: true });
    await vi.advanceTimersByTimeAsync(0);

    expect(transport.end).toHaveBeenCalledWith(firstUid, 'route_change');
    expect(transport.start).toHaveBeenCalledTimes(2);
    expect(transport.start.mock.calls[1][0].module).toBe('en_vocabulary');
  });

  it('离开到非学习场景 → end(route_change)，不再 start', async () => {
    tracker.onRouteChange(STUDY);
    tracker.onRouteChange(NOT_STUDY);
    await vi.advanceTimersByTimeAsync(0);
    expect(transport.end).toHaveBeenCalledWith(expect.any(String), 'route_change');
    expect(transport.start).toHaveBeenCalledTimes(1);
  });

  it('120s 无输入 → 发 hidden 心跳（暂停计时但不断会话）', async () => {
    tracker.onRouteChange(STUDY);
    await vi.advanceTimersByTimeAsync(120_000 + 5_000);

    expect(transport.heartbeat).toHaveBeenCalledWith(expect.any(String), 'hidden');
    expect(transport.end).not.toHaveBeenCalled();
  });

  it('hidden 后用户有输入 → 发 visible 心跳恢复计时', async () => {
    tracker.onRouteChange(STUDY);
    await vi.advanceTimersByTimeAsync(125_000);
    tracker.notifyInput();
    await vi.advanceTimersByTimeAsync(0);
    expect(transport.heartbeat).toHaveBeenLastCalledWith(expect.any(String), 'visible');
  });

  it('页面隐藏 → hidden 心跳；恢复可见 → visible 心跳', async () => {
    tracker.onRouteChange(STUDY);
    tracker.setVisibility(false);
    expect(transport.heartbeat).toHaveBeenLastCalledWith(expect.any(String), 'hidden');
    tracker.setVisibility(true);
    expect(transport.heartbeat).toHaveBeenLastCalledWith(expect.any(String), 'visible');
  });

  it('pagehide → end(pagehide)', async () => {
    tracker.onRouteChange(STUDY);
    tracker.onPageHide();
    await vi.advanceTimersByTimeAsync(0);
    expect(transport.end).toHaveBeenCalledWith(expect.any(String), 'pagehide');
  });

  it('未启用（非学生角色）时不发任何请求', async () => {
    tracker.setEnabled(false);
    tracker.onRouteChange(STUDY);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(transport.start).not.toHaveBeenCalled();
    expect(transport.heartbeat).not.toHaveBeenCalled();
  });

  it('传输失败不冒泡（埋点绝不打断学习）', async () => {
    transport.start.mockRejectedValue(new Error('offline'));
    expect(() => tracker.onRouteChange(STUDY)).not.toThrow();
    // 修正（brief 缺陷）：vitest 的 `advanceTimersByTimeAsync` 签名是 `Promise<VitestUtils>`，
    // 不是 `Promise<void>`，故原 `.resolves.toBeUndefined()` 永远失败。这里只断言「推进定时器不会 reject」。
    await expect(vi.advanceTimersByTimeAsync(0)).resolves.toBeDefined();
  });
});

describe('tracker 设备分档', () => {
  it('屏幕档对齐 iPad 横屏主断点', () => {
    expect(tracker.collectScreenClass(1366, 1024)).toBe('desktop');
    expect(tracker.collectScreenClass(1024, 768)).toBe('ipad_landscape');
    expect(tracker.collectScreenClass(768, 1024)).toBe('tablet_portrait');
    expect(tracker.collectScreenClass(390, 844)).toBe('mobile');
  });

  it('输入类型：粗+细 → hybrid，只粗 → touch，其余 → mouse', () => {
    expect(tracker.collectInputType((q) => q.includes('coarse') || q.includes('fine'))).toBe('hybrid');
    expect(tracker.collectInputType((q) => q.includes('coarse'))).toBe('touch');
    expect(tracker.collectInputType(() => false)).toBe('mouse');
  });

  it('Electron 壳识别', () => {
    expect(tracker.collectAppShell('Mozilla/5.0 ... Electron/31.0.0')).toBe('electron');
    expect(tracker.collectAppShell('Mozilla/5.0 ... Chrome/126.0.0.0')).toBe('web');
  });
});
