import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import AdminAlertsPage from './AdminAlertsPage';
import {
  ApiError,
  getExpiredAlertStats,
  purgeExpiredAlerts,
  type AdminAlertRetentionPreview,
} from '@/services/api';
import { toast } from '@/components/base';

vi.mock('@/services/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/services/api')>();
  return {
    ...actual,
    getExpiredAlertStats: vi.fn(),
    purgeExpiredAlerts: vi.fn(),
  };
});

vi.mock('@/components/base', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/components/base')>();
  return { ...actual, toast: vi.fn() };
});

const getStatsMock = vi.mocked(getExpiredAlertStats);
const purgeMock = vi.mocked(purgeExpiredAlerts);
const toastMock = vi.mocked(toast);

const CUTOFF = '2026-08-21T02:00:00.000Z';

function preview(over: Partial<AdminAlertRetentionPreview> = {}): AdminAlertRetentionPreview {
  return { retentionDays: 30, cutoff: CUTOFF, total: 12, unread: 3, ...over };
}

function renderPage() {
  return render(<AdminAlertsPage />);
}

beforeEach(() => {
  getStatsMock.mockReset().mockResolvedValue(preview());
  purgeMock.mockReset().mockResolvedValue({ retentionDays: 30, cutoff: CUTOFF, deleted: 12 });
  toastMock.mockReset();
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('AdminAlertsPage 四态', () => {
  it('加载中 → Skeleton（不出错误卡/信息卡）', () => {
    getStatsMock.mockReturnValue(new Promise(() => {}));

    renderPage();

    expect(screen.getByTestId('alerts-stats-loading')).toBeInTheDocument();
    expect(screen.queryByTestId('alerts-stats')).not.toBeInTheDocument();
    expect(screen.queryByTestId('alerts-stats-error')).not.toBeInTheDocument();
  });

  it('失败 → 虚线错误卡 + toast("error")', async () => {
    getStatsMock.mockRejectedValueOnce(new ApiError(5000, '服务异常'));

    renderPage();

    expect(await screen.findByTestId('alerts-stats-error')).toBeInTheDocument();
    expect(screen.getByText('预警数据加载失败，请稍后重试')).toBeInTheDocument();
    expect(toastMock).toHaveBeenCalledWith('error', '服务异常');
    expect(screen.queryByTestId('alerts-stats')).not.toBeInTheDocument();
  });

  it('就绪 → 大数字 total + 未读副行 + 截止时间，按钮可点', async () => {
    renderPage();

    expect(await screen.findByTestId('alerts-stats')).toBeInTheDocument();
    expect(screen.getByText('30 天前的预警')).toBeInTheDocument();
    expect(screen.getByText('12')).toBeInTheDocument();
    expect(screen.getByText('其中未读 3 条')).toBeInTheDocument();
    expect(screen.getByText(/截止时间（此前创建）：/)).toBeInTheDocument();

    const btn = screen.getByTestId('alerts-purge-btn');
    expect(btn).toBeEnabled();
    expect(btn).toHaveTextContent('清理 30 天前的预警');
  });

  it('total = 0 → 按钮 disabled（没东西可清，不该弹确认框）', async () => {
    getStatsMock.mockResolvedValue(preview({ total: 0, unread: 0 }));

    renderPage();

    const btn = await screen.findByTestId('alerts-purge-btn');
    expect(btn).toBeDisabled();
    expect(screen.getByText('没有可清理的预警')).toBeInTheDocument();

    fireEvent.click(btn);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });
});

describe('AdminAlertsPage 清理确认流程', () => {
  it('点按钮 → 出确认框，message 带条数与未读数', async () => {
    renderPage();

    fireEvent.click(await screen.findByTestId('alerts-purge-btn'));

    const dialog = await screen.findByRole('dialog');
    expect(dialog).toHaveTextContent('确认清理 30 天前的预警 12 条（其中未读 3 条）？此操作不可恢复。');
    // 只是打开确认框，还没发删除请求
    expect(purgeMock).not.toHaveBeenCalled();
  });

  it('确认 → 调 DELETE + toast("success", 已清理 N 条) + 重新拉统计', async () => {
    renderPage();
    await screen.findByTestId('alerts-stats');
    const loadsBefore = getStatsMock.mock.calls.length;

    fireEvent.click(screen.getByTestId('alerts-purge-btn'));
    await screen.findByRole('dialog');

    purgeMock.mockResolvedValueOnce({ retentionDays: 30, cutoff: CUTOFF, deleted: 12 });
    // 清理后统计归零，重拉必须反映出来
    getStatsMock.mockResolvedValue(preview({ total: 0, unread: 0 }));

    fireEvent.click(screen.getByRole('button', { name: '确认' }));

    await waitFor(() => {
      expect(purgeMock).toHaveBeenCalledTimes(1);
    });
    expect(toastMock).toHaveBeenCalledWith('success', '已清理 12 条');
    // 重新拉统计：调用次数增加，且界面换成 0
    await waitFor(() => {
      expect(getStatsMock.mock.calls.length).toBeGreaterThan(loadsBefore);
    });
    expect(await screen.findByText('没有可清理的预警')).toBeInTheDocument();
    // 确认后对话框关闭
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('取消 → 关闭确认框，一条请求都不发', async () => {
    renderPage();

    fireEvent.click(await screen.findByTestId('alerts-purge-btn'));
    await screen.findByRole('dialog');

    fireEvent.click(screen.getByRole('button', { name: '取消' }));

    await waitFor(() => {
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    });
    expect(purgeMock).not.toHaveBeenCalled();
    expect(toastMock).not.toHaveBeenCalled();
  });

  it('清理失败 → toast("error")，确认框不关（管理员可重试）', async () => {
    renderPage();

    fireEvent.click(await screen.findByTestId('alerts-purge-btn'));
    await screen.findByRole('dialog');

    purgeMock.mockRejectedValueOnce(new ApiError(5000, '数据库异常'));
    fireEvent.click(screen.getByRole('button', { name: '确认' }));

    await waitFor(() => {
      expect(toastMock).toHaveBeenCalledWith('error', '数据库异常');
    });
    expect(screen.getByRole('dialog')).toBeInTheDocument();
  });
});
