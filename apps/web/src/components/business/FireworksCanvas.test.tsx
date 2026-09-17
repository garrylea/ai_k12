import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen } from '@testing-library/react';
import { FireworksCanvas } from './FireworksCanvas';
import { useThemeStore } from '@/store/themeStore';

/**
 * Canvas 烟花（纯代码粒子）。
 *
 * 三条契约要点在这里钉住：
 * 1. `active=false` 不渲染 canvas；
 * 2. `prefers-reduced-motion` / 动效关闭 → **不跑 RAF**，直接 `onDone()`（父组件改静态光晕）；
 * 3. 卸载必须 `cancelAnimationFrame`，不留后台 RAF。
 *
 * jsdom 没有 canvas 实现（`getContext` 返回 null 且打 not-implemented 日志），
 * 所以这里统一 stub 一个 2D context 桩，只记录调用不做绘制。
 */

/** 2D context 桩：只提供组件用得到的方法/属性。 */
function stubContext() {
  const ctx = {
    clearRect: vi.fn(),
    beginPath: vi.fn(),
    arc: vi.fn(),
    fill: vi.fn(),
    setTransform: vi.fn(),
    globalAlpha: 1,
    fillStyle: '',
  };
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(
    ctx as unknown as CanvasRenderingContext2D,
  );
  return ctx;
}

/** jsdom 未实现 matchMedia，按需 stub 系统动效偏好。 */
function stubReducedMotion(reduce: boolean) {
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches: reduce && query.includes('prefers-reduced-motion'),
    media: query,
    onchange: null,
    addEventListener: () => {},
    removeEventListener: () => {},
    addListener: () => {},
    removeListener: () => {},
    dispatchEvent: () => false,
  }));
}

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  useThemeStore.setState({ motionEnabled: true });
});

describe('FireworksCanvas', () => {
  it('active=false 不渲染 canvas、不跑请求动画帧', () => {
    const rafSpy = vi.spyOn(window, 'requestAnimationFrame');
    const { container } = render(<FireworksCanvas active={false} />);

    expect(container.querySelector('canvas')).toBeNull();
    expect(screen.queryByTestId('fireworks-canvas')).not.toBeInTheDocument();
    expect(rafSpy).not.toHaveBeenCalled();
  });

  it('active=true 正常渲染 canvas', () => {
    stubContext();
    render(<FireworksCanvas active onDone={() => {}} />);

    expect(screen.getByTestId('fireworks-canvas')).toBeInTheDocument();
  });

  it('prefers-reduced-motion: reduce → 不调 requestAnimationFrame，直接 onDone', () => {
    stubReducedMotion(true);
    const rafSpy = vi.spyOn(window, 'requestAnimationFrame');
    const onDone = vi.fn();

    const { container } = render(<FireworksCanvas active onDone={onDone} />);

    expect(rafSpy).not.toHaveBeenCalled();
    expect(onDone).toHaveBeenCalledTimes(1);
    // 降级后不渲染动画层，由父组件画静态光晕
    expect(container.querySelector('canvas')).toBeNull();
  });

  it('themeStore.motionEnabled=false → 同样不跑动画、直接 onDone', () => {
    useThemeStore.setState({ motionEnabled: false });
    const rafSpy = vi.spyOn(window, 'requestAnimationFrame');
    const onDone = vi.fn();

    render(<FireworksCanvas active onDone={onDone} />);

    expect(rafSpy).not.toHaveBeenCalled();
    expect(onDone).toHaveBeenCalledTimes(1);
  });

  it('约 3 秒后自动结束并回调 onDone（只回调一次）', () => {
    stubContext();
    vi.useFakeTimers();
    const onDone = vi.fn();

    render(<FireworksCanvas active onDone={onDone} />);
    expect(onDone).not.toHaveBeenCalled();

    act(() => {
      vi.advanceTimersByTime(3200);
    });

    expect(onDone).toHaveBeenCalledTimes(1);
  });

  it('卸载时 cancelAnimationFrame，不留后台 RAF', () => {
    stubContext();
    let seq = 0;
    // 用桩替代真帧：可确定地断言「最后一次安排的帧被取消」
    const rafSpy = vi
      .spyOn(window, 'requestAnimationFrame')
      .mockImplementation(() => {
        seq += 1;
        return seq;
      });
    const cancelSpy = vi.spyOn(window, 'cancelAnimationFrame').mockImplementation(() => {});

    const { unmount } = render(<FireworksCanvas active onDone={() => {}} />);
    expect(rafSpy).toHaveBeenCalled();

    const lastId = rafSpy.mock.results[rafSpy.mock.results.length - 1].value as number;
    unmount();

    expect(cancelSpy).toHaveBeenCalledWith(lastId);
  });
});
