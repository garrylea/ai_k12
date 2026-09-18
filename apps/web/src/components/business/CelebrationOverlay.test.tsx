import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { CelebrationOverlay } from './CelebrationOverlay';
import { useThemeStore } from '@/store/themeStore';

/**
 * 全屏庆祝层（主线完成 / 段位晋升共用）。
 *
 * 契约要点：`role="dialog"` + `aria-modal`、焦点落在主按钮、两个 variant 各自的视觉主体、
 * `autoCloseSeconds` 到点自动触发 `onPrimary`（替代主线原先的内联倒计时）。
 */

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

/** jsdom 没有 canvas 实现：stub 掉 2D context，避免 not-implemented 噪音并让烟花能挂载。 */
function stubCanvasContext() {
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({
    clearRect: vi.fn(),
    beginPath: vi.fn(),
    arc: vi.fn(),
    fill: vi.fn(),
    setTransform: vi.fn(),
    globalAlpha: 1,
    fillStyle: '',
  } as unknown as CanvasRenderingContext2D);
}

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  useThemeStore.setState({ motionEnabled: true });
});

describe('CelebrationOverlay', () => {
  it('open=false 不渲染任何内容', () => {
    const { container } = render(
      <CelebrationOverlay
        open={false}
        variant="task"
        title="本节学习完成！"
        primaryLabel="开始新课"
        onPrimary={() => {}}
      />,
    );

    expect(container).toBeEmptyDOMElement();
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('variant=task 渲染标题/副标题/主按钮，点击主按钮触发 onPrimary', () => {
    stubReducedMotion(true);
    const onPrimary = vi.fn();
    render(
      <CelebrationOverlay
        open
        variant="task"
        title="本节学习完成！"
        subtitle="继续下一课，保持节奏"
        pointsAwarded={10}
        primaryLabel="开始新课"
        onPrimary={onPrimary}
      />,
    );

    expect(screen.getByRole('dialog')).toHaveAttribute('aria-modal', 'true');
    expect(screen.getByRole('heading', { name: '本节学习完成！' })).toBeInTheDocument();
    expect(screen.getByText('继续下一课，保持节奏')).toBeInTheDocument();
    expect(screen.getByText('+10 分')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: '开始新课' }));
    expect(onPrimary).toHaveBeenCalledTimes(1);
  });

  it('task 对勾圆的底色用 --success（不是夜间几乎透明的 --brand-100）', () => {
    stubReducedMotion(true);
    render(
      <CelebrationOverlay
        open
        variant="task"
        title="本节学习完成！"
        primaryLabel="继续"
        onPrimary={() => {}}
      />,
    );

    const icon = screen.getByTestId('celebration-task-icon');
    // 夜间 --brand-100 = rgba(201,213,229,.2)，铺在白色卡片上等于没有底色，
    // 绿环会变成孤立圆环；改用同语义族的实心 --success + 白勾，两个主题都读得出来。
    expect(icon.style.background).toBe('var(--success)');
    expect(icon.style.background).not.toContain('--brand-100');
    expect(icon.style.color).toBe('var(--text-on-brand)');
  });

  it('variant=levelup 渲染大段位图标与段位名', () => {
    stubReducedMotion(true);
    render(
      <CelebrationOverlay
        open
        variant="levelup"
        title="晋升 铸铁！"
        level={{ code: 'zhutie', name: '铸铁' }}
        primaryLabel="继续"
        onPrimary={() => {}}
      />,
    );

    expect(screen.getByTestId('celebration-level-icon').querySelector('svg')).toHaveAttribute(
      'width',
      '96',
    );
    expect(screen.getByText('铸铁')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '继续' })).toBeInTheDocument();
  });

  it('levelup 但段位名缺失时不渲染段位名，也不崩', () => {
    stubReducedMotion(true);
    render(
      <CelebrationOverlay
        open
        variant="levelup"
        title="晋升新段位！"
        level={{ code: 'zhutie', name: '' }}
        primaryLabel="继续"
        onPrimary={() => {}}
      />,
    );

    expect(screen.getByRole('heading', { name: '晋升新段位！' })).toBeInTheDocument();
    expect(
      screen.getByTestId('celebration-level-icon').querySelector('svg'),
    ).toHaveAttribute('width', '96');
  });

  it('autoCloseSeconds 到点自动触发 onPrimary（并显示倒计时文案）', () => {
    stubReducedMotion(true);
    vi.useFakeTimers();
    const onPrimary = vi.fn();

    render(
      <CelebrationOverlay
        open
        variant="task"
        title="本节学习完成！"
        primaryLabel="开始新课"
        onPrimary={onPrimary}
        autoCloseSeconds={10}
      />,
    );

    expect(screen.getByText('10 秒后自动继续')).toBeInTheDocument();

    act(() => {
      vi.advanceTimersByTime(5000);
    });
    expect(screen.getByText('5 秒后自动继续')).toBeInTheDocument();
    expect(onPrimary).not.toHaveBeenCalled();

    act(() => {
      vi.advanceTimersByTime(5000);
    });
    expect(onPrimary).toHaveBeenCalledTimes(1);

    // 到点后不再重复触发
    act(() => {
      vi.advanceTimersByTime(5000);
    });
    expect(onPrimary).toHaveBeenCalledTimes(1);
  });

  it('焦点落在主按钮上', () => {
    stubReducedMotion(true);
    render(
      <CelebrationOverlay
        open
        variant="task"
        title="本节学习完成！"
        primaryLabel="开始新课"
        onPrimary={() => {}}
      />,
    );

    expect(screen.getByRole('button', { name: '开始新课' })).toHaveFocus();
  });

  it('动效关闭时不出烟花 canvas，改用静态光晕', () => {
    useThemeStore.setState({ motionEnabled: false });
    const { container } = render(
      <CelebrationOverlay
        open
        variant="task"
        title="本节学习完成！"
        primaryLabel="开始新课"
        onPrimary={() => {}}
      />,
    );

    expect(container.querySelector('canvas')).toBeNull();
    expect(screen.getByTestId('celebration-glow')).toBeInTheDocument();
  });

  it('动效开启时 task 变体挂载烟花 canvas，强度为 soft（比 levelup 更淡）', () => {
    stubCanvasContext();
    render(
      <CelebrationOverlay
        open
        variant="task"
        title="本节学习完成！"
        primaryLabel="开始新课"
        onPrimary={() => {}}
      />,
    );

    expect(screen.getByTestId('fireworks-canvas')).toHaveAttribute('data-intensity', 'soft');
  });

  it('动效开启时 levelup 变体烟花强度为 full', () => {
    stubCanvasContext();
    render(
      <CelebrationOverlay
        open
        variant="levelup"
        title="晋升 铸铁！"
        level={{ code: 'zhutie', name: '铸铁' }}
        primaryLabel="继续"
        onPrimary={() => {}}
      />,
    );

    expect(screen.getByTestId('fireworks-canvas')).toHaveAttribute('data-intensity', 'full');
  });
});
