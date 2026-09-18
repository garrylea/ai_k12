import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import PointsSettingsPanel from './PointsSettingsPanel';
import { toast } from '@/components/base';
import {
  ApiError,
  getParentPointsSettings,
  saveParentPointsSettings,
  type PointsSettings,
} from '@/services/api';

/**
 * 家长端「兑换设置」（计划三 §2.6(a) / §3 Task 7）。
 *
 * 契约要点（每条都对应一个真实会坏的行为）：
 * 1. **只在有改动时可保存**；`PUT` **至少给一个字段**（空 patch 后端 400 1001）。
 * 2. **只改开关时 body 只能含 `rewardRedemptionEnabled`**——后端语义是「未提供即不动」，
 *    多带一个没变的 `pointsPerYuan` 会把一次误读的草稿写回库。
 * 3. `pointsPerYuan` 只允许 1–9999 整数；`0` / 超界 / 非数字 → 行内报错 + 保存禁用。
 * 4. 预览用与后端同口径的 `previewCashAmount`（整数运算再除），例子「100 积分 = 5.00 元」。
 * 5. 保存成功 `toast` + **用响应体刷新本地**（服务端归一后的值），并通过
 *    `onSettingsChanged` 通知页面 → 兑换表单同步开关状态。
 */

const SETTINGS: PointsSettings = { pointsPerYuan: 20, rewardRedemptionEnabled: true };

vi.mock('@/services/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/services/api')>();
  return {
    ...actual,
    getParentPointsSettings: vi.fn(),
    saveParentPointsSettings: vi.fn(),
  };
});

vi.mock('@/components/base', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/components/base')>();
  return { ...actual, toast: vi.fn() };
});

const getSettingsMock = vi.mocked(getParentPointsSettings);
const saveSettingsMock = vi.mocked(saveParentPointsSettings);
const toastMock = vi.mocked(toast);

function renderPanel(studentId = 1, onSettingsChanged = vi.fn()) {
  const utils = render(
    <PointsSettingsPanel studentId={studentId} onSettingsChanged={onSettingsChanged} />,
  );
  return { ...utils, onSettingsChanged };
}

beforeEach(() => {
  getSettingsMock.mockReset();
  saveSettingsMock.mockReset();
  toastMock.mockReset();
  getSettingsMock.mockResolvedValue(SETTINGS);
  saveSettingsMock.mockImplementation((_studentId, patch) =>
    Promise.resolve({ ...SETTINGS, ...patch }),
  );
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('PointsSettingsPanel：渲染与预览', () => {
  it('渲染接口值：比例输入 + 开关，并给出「N 积分 = 1 元」与 100 积分示例', async () => {
    renderPanel();

    const rate = await screen.findByTestId('settings-rate-input');
    expect(getSettingsMock).toHaveBeenCalledWith(1);
    expect(rate).toHaveValue(20);
    expect(screen.getByTestId('settings-switch')).toHaveAttribute('aria-checked', 'true');

    // 「100 积分 = 5.00 元」由同口径纯函数推导，不是硬编码字符串
    expect(screen.getByTestId('settings-rate-preview')).toHaveTextContent('20 积分 = 1 元');
    expect(screen.getByTestId('settings-rate-example')).toHaveTextContent(
      '当前设置：100 积分 = 5.00 元',
    );
  });

  it('加载中给骨架；加载失败给可重试的错误态', async () => {
    getSettingsMock.mockReturnValue(new Promise<PointsSettings>(() => {}));
    const skeleton = renderPanel();
    expect(screen.getByTestId('points-settings-skeleton')).toBeInTheDocument();
    skeleton.unmount();

    getSettingsMock.mockReset();
    getSettingsMock.mockRejectedValueOnce(new Error('boom'));
    renderPanel();
    await screen.findByTestId('points-settings-error');

    getSettingsMock.mockResolvedValueOnce(SETTINGS);
    fireEvent.click(screen.getByRole('button', { name: '重试' }));
    expect(await screen.findByTestId('settings-rate-input')).toHaveValue(20);
    expect(screen.queryByTestId('points-settings-error')).not.toBeInTheDocument();
  });
});

describe('PointsSettingsPanel：草稿与保存', () => {
  it('未改动时保存 disabled；改了比例后 enabled', async () => {
    renderPanel();

    const rate = await screen.findByTestId('settings-rate-input');
    expect(screen.getByTestId('save-settings')).toBeDisabled();

    fireEvent.change(rate, { target: { value: '25' } });
    expect(screen.getByTestId('save-settings')).toBeEnabled();
  });

  it('比例改成 0 / 超界 → 行内报错 + 保存 disabled + 不发请求', async () => {
    renderPanel();

    const rate = await screen.findByTestId('settings-rate-input');

    fireEvent.change(rate, { target: { value: '0' } });
    expect(screen.getByTestId('settings-rate-error')).toBeInTheDocument();
    expect(screen.getByTestId('save-settings')).toBeDisabled();

    fireEvent.change(rate, { target: { value: '10000' } });
    expect(screen.getByTestId('settings-rate-error')).toBeInTheDocument();
    expect(screen.getByTestId('save-settings')).toBeDisabled();

    fireEvent.change(rate, { target: { value: '' } });
    expect(screen.getByTestId('settings-rate-error')).toBeInTheDocument();
    expect(screen.getByTestId('save-settings')).toBeDisabled();

    fireEvent.click(screen.getByTestId('save-settings'));
    expect(saveSettingsMock).not.toHaveBeenCalled();
  });

  it('只改开关 → PUT body 只含 rewardRedemptionEnabled（不含 pointsPerYuan）', async () => {
    renderPanel();

    const toggle = await screen.findByTestId('settings-switch');
    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute('aria-checked', 'false');
    expect(screen.getByTestId('save-settings')).toBeEnabled();

    fireEvent.click(screen.getByTestId('save-settings'));

    await waitFor(() => expect(saveSettingsMock).toHaveBeenCalledTimes(1));
    const patch = saveSettingsMock.mock.calls[0][1];
    expect(patch).toEqual({ rewardRedemptionEnabled: false });
    // 后端语义是「未提供即不动」：多带一个没变的 pointsPerYuan 是错的
    expect(Object.keys(patch)).toEqual(['rewardRedemptionEnabled']);
  });

  it('只改比例 → PUT body 只含 pointsPerYuan', async () => {
    renderPanel();

    const rate = await screen.findByTestId('settings-rate-input');
    fireEvent.change(rate, { target: { value: '25' } });
    fireEvent.click(screen.getByTestId('save-settings'));

    await waitFor(() => expect(saveSettingsMock).toHaveBeenCalledTimes(1));
    expect(saveSettingsMock.mock.calls[0][1]).toEqual({ pointsPerYuan: 25 });
  });

  it('比例与开关都改 → 两个字段都发', async () => {
    renderPanel();

    const rate = await screen.findByTestId('settings-rate-input');
    fireEvent.change(rate, { target: { value: '25' } });
    fireEvent.click(screen.getByTestId('settings-switch'));
    fireEvent.click(screen.getByTestId('save-settings'));

    await waitFor(() => expect(saveSettingsMock).toHaveBeenCalledTimes(1));
    expect(saveSettingsMock.mock.calls[0][1]).toEqual({
      pointsPerYuan: 25,
      rewardRedemptionEnabled: false,
    });
  });

  it('保存成功：toast + 用响应体刷新本地（含服务端归一值）+ 通知页面', async () => {
    const { onSettingsChanged } = renderPanel();

    const rate = await screen.findByTestId('settings-rate-input');
    fireEvent.change(rate, { target: { value: '25' } });

    // 服务端把值归一成 30（模拟归一/漂移）：本地必须用响应体，而不是自己拼
    saveSettingsMock.mockResolvedValueOnce({ pointsPerYuan: 30, rewardRedemptionEnabled: false });

    fireEvent.click(screen.getByTestId('save-settings'));

    await waitFor(() => expect(toastMock).toHaveBeenCalledWith('success', '兑换设置已保存'));
    expect(await screen.findByDisplayValue('30')).toBeInTheDocument();
    expect(screen.getByTestId('settings-switch')).toHaveAttribute('aria-checked', 'false');
    // 已对齐快照 → 保存重新 disabled
    expect(screen.getByTestId('save-settings')).toBeDisabled();
    expect(onSettingsChanged).toHaveBeenCalledWith({
      pointsPerYuan: 30,
      rewardRedemptionEnabled: false,
    });
  });

  it('后端 1001 → toast 出服务端文案', async () => {
    renderPanel();

    const rate = await screen.findByTestId('settings-rate-input');
    fireEvent.change(rate, { target: { value: '25' } });
    saveSettingsMock.mockRejectedValueOnce(new ApiError(1001, '入参校验失败'));

    fireEvent.click(screen.getByTestId('save-settings'));

    await waitFor(() => expect(toastMock).toHaveBeenCalledWith('error', '入参校验失败'));
    // 草稿还在，可以改完重存
    expect(rate).toHaveValue(25);
    expect(screen.getByTestId('save-settings')).toBeEnabled();
  });
});
