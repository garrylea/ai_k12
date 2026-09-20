import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import ParentControlsPage from './ParentControlsPage';
import { toast } from '@/components/base';
import {
  ApiError,
  getParentControls,
  getParentPointsSettings,
  putParentControls,
  type ParentControls,
  type PointsSettings,
} from '@/services/api';
import { useParentStudentStore } from '@/store/parentStudentStore';

/**
 * 家长端「行为管控」P6.6（spec §5.3 / plan Task 8）。
 *
 * 契约要点（每条都对应一个真实会坏的行为）：
 * 1. **无改动 → 保存禁用**（P6.5 踩过「点了没反应」）；有改动才 enabled。
 * 2. **只发改动过的字段** —— 后端语义是「未提供即不动」，多带没变的字段等于把过期草稿写回库。
 * 3. 两个阈值只允许 1–180 整数；`0` / `181` / 空串 → 行内报错 + 保存禁用 + **不发请求**。
 * 4. 预设档是**纯前端常量**：点一下只填输入框（仍要保存才生效）；手动改数字 → 高亮消失。
 * 5. 保存成功 `toast` **回显服务端返回值** + 用响应体刷新本地（服务端可能归一）。
 * 6. 兑换状态是**独立数据源**，它失败只影响那张卡，不能拖垮灵敏度表单。
 * 7. **派生状态带 `studentId` 归属**：切孩子时旧值不许画到新孩子头上（顶栏切孩子不重挂载本页）。
 */

const CONTROLS: ParentControls = { alertAwayMinutes: 5, alertIdleMinutes: 15 };
const POINTS: PointsSettings = { pointsPerYuan: 20, rewardRedemptionEnabled: true };

vi.mock('@/components/base', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/components/base')>();
  // 只替换 toast：Input/Card/Button 必须是真的（本页要断言基座 Input 的 error 行内文案）。
  return { ...actual, toast: vi.fn() };
});

vi.mock('@/services/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/services/api')>();
  return {
    ...actual,
    getParentControls: vi.fn(),
    putParentControls: vi.fn(),
    getParentPointsSettings: vi.fn(),
  };
});

const getControlsMock = vi.mocked(getParentControls);
const putControlsMock = vi.mocked(putParentControls);
const getPointsSettingsMock = vi.mocked(getParentPointsSettings);
const toastMock = vi.mocked(toast);

function renderPage() {
  return render(
    <MemoryRouter>
      <ParentControlsPage />
    </MemoryRouter>,
  );
}

beforeEach(() => {
  localStorage.clear();
  useParentStudentStore.setState({ studentId: 1 });
  getControlsMock.mockReset();
  getControlsMock.mockResolvedValue(CONTROLS);
  putControlsMock.mockReset();
  putControlsMock.mockImplementation((_studentId, patch) =>
    Promise.resolve({ ...CONTROLS, ...patch }),
  );
  getPointsSettingsMock.mockReset();
  getPointsSettingsMock.mockResolvedValue(POINTS);
  toastMock.mockReset();
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('ParentControlsPage：渲染', () => {
  it('渲染接口值；默认档（5/15）高亮为「标准」；兑换状态只读展示', async () => {
    renderPage();

    expect(await screen.findByTestId('controls-away-input')).toHaveValue(5);
    expect(screen.getByTestId('controls-idle-input')).toHaveValue(15);
    expect(getControlsMock).toHaveBeenCalledWith(1);

    // 预设高亮由「两个值是否恰好等于某档」现算，服务端没有档位状态
    expect(screen.getByTestId('preset-standard')).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByTestId('preset-loose')).toHaveAttribute('aria-pressed', 'false');
    expect(screen.getByTestId('preset-strict')).toHaveAttribute('aria-pressed', 'false');

    // 兑换状态来自另一个数据源，且是只读的（唯一出口是跳转奖励管理页）
    expect(await screen.findByTestId('controls-rewards-status')).toHaveTextContent(
      '已开启：孩子可以把积分兑换成奖励',
    );
    expect(getPointsSettingsMock).toHaveBeenCalledWith(1);
    expect(screen.getByRole('link', { name: '去奖励管理' })).toHaveAttribute(
      'href',
      '/parent/rewards',
    );
    expect(screen.queryByTestId('controls-rewards-error')).not.toBeInTheDocument();
  });

  it('未选择孩子 → 空态，且不发任何请求', () => {
    useParentStudentStore.setState({ studentId: null });

    renderPage();

    expect(screen.getByTestId('controls-no-student')).toBeInTheDocument();
    expect(screen.getByText('请先选择孩子')).toBeInTheDocument();
    expect(getControlsMock).not.toHaveBeenCalled();
    expect(getPointsSettingsMock).not.toHaveBeenCalled();
  });
});

describe('ParentControlsPage：预设档', () => {
  it('点「严格」→ 两个输入框被填成 2/5，高亮切到严格', async () => {
    renderPage();

    fireEvent.click(await screen.findByTestId('preset-strict'));

    expect(screen.getByTestId('controls-away-input')).toHaveValue(2);
    expect(screen.getByTestId('controls-idle-input')).toHaveValue(5);
    expect(screen.getByTestId('preset-strict')).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByTestId('preset-standard')).toHaveAttribute('aria-pressed', 'false');
    // 纯前端填值：**没有**发请求（要等家长点保存）
    expect(putControlsMock).not.toHaveBeenCalled();
  });

  it('点预设后手动改一个数字 → 高亮消失（不再等于任何一档）', async () => {
    renderPage();

    fireEvent.click(await screen.findByTestId('preset-loose'));
    expect(screen.getByTestId('preset-loose')).toHaveAttribute('aria-pressed', 'true');

    fireEvent.change(screen.getByTestId('controls-away-input'), { target: { value: '3' } });

    for (const key of ['loose', 'standard', 'strict']) {
      expect(screen.getByTestId(`preset-${key}`)).toHaveAttribute('aria-pressed', 'false');
    }
  });
});

describe('ParentControlsPage：校验与保存', () => {
  it('无改动 → 保存禁用；改了才 enabled', async () => {
    renderPage();

    const away = await screen.findByTestId('controls-away-input');
    expect(screen.getByTestId('save-controls')).toBeDisabled();

    fireEvent.change(away, { target: { value: '10' } });
    expect(screen.getByTestId('save-controls')).toBeEnabled();

    // 改回原值 → 重新禁用（判脏基准是服务端快照，不是「有没有碰过输入框」）
    fireEvent.change(away, { target: { value: '5' } });
    expect(screen.getByTestId('save-controls')).toBeDisabled();
  });

  it('0 / 181 / 空串 → 行内报错 + 保存禁用 + 不发请求', async () => {
    renderPage();

    const away = await screen.findByTestId('controls-away-input');

    for (const bad of ['0', '181', '']) {
      fireEvent.change(away, { target: { value: bad } });
      expect(screen.getByText('请填 1–180 的整数')).toBeInTheDocument();
      expect(screen.getByTestId('save-controls')).toBeDisabled();
    }

    fireEvent.click(screen.getByTestId('save-controls'));
    expect(putControlsMock).not.toHaveBeenCalled();
  });

  it('只改「离开页面」→ PUT body 只含 alertAwayMinutes（不含没变的 idle）', async () => {
    renderPage();

    fireEvent.change(await screen.findByTestId('controls-away-input'), {
      target: { value: '10' },
    });
    fireEvent.click(screen.getByTestId('save-controls'));

    await waitFor(() => expect(putControlsMock).toHaveBeenCalledTimes(1));
    expect(putControlsMock.mock.calls[0][0]).toBe(1);
    const patch = putControlsMock.mock.calls[0][1];
    expect(patch).toEqual({ alertAwayMinutes: 10 });
    // 后端语义是「未提供即不动」：多带一个没变的 alertIdleMinutes 是错的
    expect(Object.keys(patch)).toEqual(['alertAwayMinutes']);
  });

  it('两个都改 → 两个字段都发', async () => {
    renderPage();

    fireEvent.change(await screen.findByTestId('controls-away-input'), {
      target: { value: '10' },
    });
    fireEvent.change(screen.getByTestId('controls-idle-input'), { target: { value: '30' } });
    fireEvent.click(screen.getByTestId('save-controls'));

    await waitFor(() => expect(putControlsMock).toHaveBeenCalledTimes(1));
    expect(putControlsMock.mock.calls[0][1]).toEqual({
      alertAwayMinutes: 10,
      alertIdleMinutes: 30,
    });
  });

  it('保存成功 → toast 回显服务端值 + 用响应体刷新本地 + 保存重新禁用', async () => {
    renderPage();

    fireEvent.change(await screen.findByTestId('controls-away-input'), {
      target: { value: '10' },
    });
    // 服务端回读的值与提交的不同（模拟归一/并发改动）：本地必须用响应体，不自己拼
    putControlsMock.mockResolvedValueOnce({ alertAwayMinutes: 20, alertIdleMinutes: 40 });

    fireEvent.click(screen.getByTestId('save-controls'));

    await waitFor(() =>
      expect(toastMock).toHaveBeenCalledWith(
        'success',
        '已保存：离开页面 20 分钟 / 无操作 40 分钟',
      ),
    );
    expect(screen.getByTestId('controls-away-input')).toHaveValue(20);
    expect(screen.getByTestId('controls-idle-input')).toHaveValue(40);
    // 已对齐快照 → 保存重新 disabled
    expect(screen.getByTestId('save-controls')).toBeDisabled();
  });

  it('保存失败 → toast 出服务端文案，草稿保留可重存', async () => {
    renderPage();

    const away = await screen.findByTestId('controls-away-input');
    fireEvent.change(away, { target: { value: '10' } });
    putControlsMock.mockRejectedValueOnce(new ApiError(1001, 'alertAwayMinutes 必须是 1-180 的整数'));

    fireEvent.click(screen.getByTestId('save-controls'));

    await waitFor(() =>
      expect(toastMock).toHaveBeenCalledWith(
        'error',
        'alertAwayMinutes 必须是 1-180 的整数',
      ),
    );
    expect(screen.getByTestId('controls-save-error')).toBeInTheDocument();
    expect(away).toHaveValue(10);
    expect(screen.getByTestId('save-controls')).toBeEnabled();
  });
});

describe('ParentControlsPage：两个数据源互不拖累', () => {
  it('兑换状态拉失败 → 只有那张卡显示失败，灵敏度表单照常可读可存', async () => {
    getPointsSettingsMock.mockRejectedValue(new Error('boom'));
    renderPage();

    expect(await screen.findByTestId('controls-rewards-error')).toBeInTheDocument();
    expect(screen.queryByTestId('controls-error')).not.toBeInTheDocument();

    // 灵敏度表单不受影响
    const away = await screen.findByTestId('controls-away-input');
    expect(away).toHaveValue(5);
    fireEvent.change(away, { target: { value: '10' } });
    fireEvent.click(screen.getByTestId('save-controls'));
    await waitFor(() => expect(putControlsMock).toHaveBeenCalledTimes(1));
  });

  it('灵敏度拉失败 → 错误卡 + 重试可恢复', async () => {
    getControlsMock.mockReset();
    getControlsMock.mockRejectedValueOnce(new Error('boom'));
    renderPage();

    await screen.findByTestId('controls-error');
    expect(screen.queryByTestId('controls-away-input')).not.toBeInTheDocument();

    getControlsMock.mockResolvedValueOnce(CONTROLS);
    fireEvent.click(screen.getByRole('button', { name: '重试' }));

    expect(await screen.findByTestId('controls-away-input')).toHaveValue(5);
    expect(screen.queryByTestId('controls-error')).not.toBeInTheDocument();
  });
});

describe('ParentControlsPage：多孩归属', () => {
  it('切孩子时，在途的旧响应不许画到新孩子头上（显示骨架，不是上一个孩子的 5/15）', async () => {
    renderPage();
    expect(await screen.findByTestId('controls-away-input')).toHaveValue(5);

    // 第二个孩子的请求**挂着不返回**：若派生值没带 studentId 归属，会继续画 5/15
    getControlsMock.mockImplementation((id) =>
      id === 2 ? new Promise<ParentControls>(() => {}) : Promise.resolve(CONTROLS),
    );
    act(() => useParentStudentStore.setState({ studentId: 2 }));

    expect(screen.getByTestId('controls-skeleton')).toBeInTheDocument();
    expect(screen.queryByTestId('controls-away-input')).not.toBeInTheDocument();
    expect(getControlsMock).toHaveBeenCalledWith(2);
  });
});
