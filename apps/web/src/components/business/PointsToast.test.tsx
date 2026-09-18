import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen } from '@testing-library/react';
import { PointsToast } from './PointsToast';
import { usePointsStore } from '@/store/pointsStore';
import { useThemeStore } from '@/store/themeStore';

/**
 * 积分轻反馈（右下角浮出）。
 *
 * 三条契约要点在这里钉住：
 * 1. 2.5s 自动消失，且**按各自的计时**消失（多条排队不互相覆盖）；
 * 2. `points === 0` 是「已达上限」的中性文案，不是错误、不是负数；
 * 3. `z-index` 必须低于答题弹窗（`z-50`）——否则会盖住「提示 / 讨论 / 提交」。
 *
 * vitest globals:false 下 @testing-library/react 不会自动注册 afterEach(cleanup)，
 * 必须自己写，否则上个用例的 DOM 泄漏会让 getByText 命中多个元素。
 */
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  // store 是模块级单例，用例之间必须清空队列 + 还原动效偏好，否则互相串味
  usePointsStore.setState({ queue: [] });
  useThemeStore.setState({ motionEnabled: true });
});

beforeEach(() => {
  vi.useFakeTimers();
  usePointsStore.setState({ queue: [] });
  useThemeStore.setState({ motionEnabled: true });
});

/** push 会触发 zustand 更新 → 必须包在 act 里，否则 React 报 act 警告 */
function push(item: Parameters<ReturnType<typeof usePointsStore.getState>['push']>[0]) {
  act(() => {
    usePointsStore.getState().push(item);
  });
}

function advance(ms: number) {
  act(() => {
    vi.advanceTimersByTime(ms);
  });
}

describe('PointsToast', () => {
  it('push 后右下角浮出「+N 分」并带任务名', () => {
    render(<PointsToast />);

    push({ points: 2, title: '课堂练习' });

    expect(screen.getByText('+2 分')).toBeInTheDocument();
    expect(screen.getByText('课堂练习')).toBeInTheDocument();
  });

  it('2.5s 后自动消失', () => {
    render(<PointsToast />);
    push({ points: 10, title: '英语背单词 · 10 词' });
    expect(screen.getByText('+10 分')).toBeInTheDocument();

    advance(2500);

    expect(screen.queryByText('+10 分')).not.toBeInTheDocument();
  });

  it('points === 0 显示「已达上限」中性文案，不显示 +0 分、不显示负数、不用错误色', () => {
    render(<PointsToast />);

    push({ points: 0, title: '数学专项 · 5 题' });

    const limit = screen.getByText('今日该任务积分已达上限');
    expect(limit).toBeInTheDocument();
    expect(screen.queryByText('+0 分')).not.toBeInTheDocument();
    // 中性色（不是 error 红），也不出现 `+-N` 这种负数文案
    expect(limit.className).toContain('--text-secondary');
    expect(document.body.textContent).not.toMatch(/\+-/);
  });

  it('多条排队不互相覆盖，各自按自己的计时消失', () => {
    render(<PointsToast />);

    push({ points: 2, title: '第一轮' });
    advance(1000);
    push({ points: 5, title: '第二轮' });

    // 两条同时在，纵向排队（而非后一条顶掉前一条）
    expect(screen.getByText('+2 分')).toBeInTheDocument();
    expect(screen.getByText('+5 分')).toBeInTheDocument();

    // 第一条到点消失，第二条还没到（1000 + 1500 = 2500 才轮到它）
    advance(1500);
    expect(screen.queryByText('+2 分')).not.toBeInTheDocument();
    expect(screen.getByText('+5 分')).toBeInTheDocument();

    advance(1000);
    expect(screen.queryByText('+5 分')).not.toBeInTheDocument();
  });

  it('z-index 用 z-40，低于答题弹窗（z-50）', () => {
    const { container } = render(<PointsToast />);

    const host = container.firstElementChild as HTMLElement;
    expect(host).toHaveClass('z-40');
    expect(host).not.toHaveClass('z-50');
    expect(host).not.toHaveClass('z-[60]');
  });

  it('卡片不吞点击：外层 pointer-events-none，卡片自身没有 pointer-events-auto 也没有点击行为', () => {
    const { container } = render(<PointsToast />);

    push({ points: 3, title: '默写' });

    const host = container.firstElementChild as HTMLElement;
    expect(host).toHaveClass('pointer-events-none');

    const card = container.querySelector('[data-testid="points-toast"]') as HTMLElement;
    expect(card).toBeInTheDocument();
    // 卡片没有点击行为，却会盖在答题控件上 2.5s——恢复指针事件等于白白抢走点击
    expect(card.className).not.toContain('pointer-events-auto');
    expect(card.querySelector('button')).toBeNull();
    expect(card).not.toHaveAttribute('role');
  });

  it('开启动效时卡片带 opacity/transform 过渡（有动画，不是硬切换）', () => {
    const { container } = render(<PointsToast />);

    push({ points: 3, title: '默写' });

    const card = container.querySelector('[data-testid="points-toast"]') as HTMLElement;
    expect(card.style.transition).not.toBe('');
    expect(card.style.transition).toContain('opacity 200ms');
    expect(card.style.transition).toContain('transform 200ms');
  });

  it('关闭动效时不做过渡动画，但仍按时出现与消失', () => {
    useThemeStore.setState({ motionEnabled: false });
    const { container } = render(<PointsToast />);

    push({ points: 3, title: '默写' });

    const card = container.querySelector('[data-testid="points-toast"]') as HTMLElement;
    expect(card).toBeInTheDocument();
    expect(card.style.transition).toBe('');

    advance(2500);
    expect(screen.queryByText('+3 分')).not.toBeInTheDocument();
  });

  it('prefers-reduced-motion: reduce 时同上（系统级降级）', () => {
    // jsdom 未实现 matchMedia，这里 stub 出「系统已关动效」
    vi.stubGlobal('matchMedia', (query: string) => ({
      matches: query.includes('prefers-reduced-motion'),
      media: query,
      onchange: null,
      addEventListener: () => {},
      removeEventListener: () => {},
      addListener: () => {},
      removeListener: () => {},
      dispatchEvent: () => false,
    }));
    const { container } = render(<PointsToast />);

    push({ points: 1, title: '默写' });

    const card = container.querySelector('[data-testid="points-toast"]') as HTMLElement;
    expect(card.style.transition).toBe('');
    expect(screen.getByText('+1 分')).toBeInTheDocument();
  });

  it('levelUp 非空时也不在这里庆祝（晋升交给全屏 CelebrationOverlay）', () => {
    render(<PointsToast />);

    push({ points: 20, title: '数学专项 · 10 题', levelUp: { from: 'pichai', to: 'zhutie' } });

    // 只出轻反馈，不出现段位文案 / 图标，避免与全屏庆祝同时弹
    expect(screen.getByText('+20 分')).toBeInTheDocument();
    expect(screen.queryByText(/晋升|铸铁|zhutie/)).not.toBeInTheDocument();
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });
});
