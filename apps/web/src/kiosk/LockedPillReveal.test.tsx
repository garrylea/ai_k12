import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { LockedPillReveal } from './LockedPillReveal';
import { LearningLockContext } from './learningLockContext';

afterEach(() => cleanup());
beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

function renderReveal(lock: { locked: boolean; remainingMs: number } | null) {
  return render(
    <LearningLockContext.Provider value={lock}>
      <LockedPillReveal />
    </LearningLockContext.Provider>,
  );
}

describe('LockedPillReveal', () => {
  it('进入页面即显示，3 秒后收起', () => {
    renderReveal({ locked: true, remainingMs: 42 * 60_000 });
    expect(screen.getByTestId('locked-pill')).toHaveAttribute('data-visible', 'true');

    act(() => { vi.advanceTimersByTime(3000); });
    expect(screen.getByTestId('locked-pill')).toHaveAttribute('data-visible', 'false');
  });

  it('悬停顶部识别区显示，移开 200ms 后收起（悬停期间到点也不收起）', () => {
    renderReveal({ locked: true, remainingMs: 42 * 60_000 });
    act(() => { vi.advanceTimersByTime(3000); }); // 先让自动显示结束

    const zone = screen.getByTestId('pill-reveal-zone');
    fireEvent.mouseEnter(zone);
    act(() => { vi.advanceTimersByTime(10_000); });
    expect(screen.getByTestId('locked-pill')).toHaveAttribute('data-visible', 'true');

    fireEvent.mouseLeave(zone);
    act(() => { vi.advanceTimersByTime(199); });
    expect(screen.getByTestId('locked-pill')).toHaveAttribute('data-visible', 'true');
    act(() => { vi.advanceTimersByTime(1); });
    expect(screen.getByTestId('locked-pill')).toHaveAttribute('data-visible', 'false');
  });

  it('点击识别区显示 5 秒后收起（触屏没有 hover 的等价路径）', () => {
    renderReveal({ locked: true, remainingMs: 42 * 60_000 });
    act(() => { vi.advanceTimersByTime(3000); });

    fireEvent.click(screen.getByTestId('pill-reveal-zone'));
    act(() => { vi.advanceTimersByTime(4999); });
    expect(screen.getByTestId('locked-pill')).toHaveAttribute('data-visible', 'true');
    act(() => { vi.advanceTimersByTime(1); });
    expect(screen.getByTestId('locked-pill')).toHaveAttribute('data-visible', 'false');
  });

  it('未锁定时识别区与胶囊都不渲染', () => {
    renderReveal(null);
    expect(screen.queryByTestId('pill-reveal-zone')).not.toBeInTheDocument();
    expect(screen.queryByTestId('locked-pill')).not.toBeInTheDocument();
  });

  it('锁定解除时立即收起', () => {
    const { rerender } = renderReveal({ locked: true, remainingMs: 42 * 60_000 });
    expect(screen.getByTestId('locked-pill')).toHaveAttribute('data-visible', 'true');

    rerender(
      <LearningLockContext.Provider value={null}>
        <LockedPillReveal />
      </LearningLockContext.Provider>,
    );
    expect(screen.queryByTestId('locked-pill')).not.toBeInTheDocument();
  });
});
