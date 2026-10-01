import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import BillingNoticeBar, { NOTICE_POLL_INTERVAL_MS } from './BillingNoticeBar';
import { toast } from '@/components/base';
import { ackBillingNotice, listUnreadBillingNotices, type BillingNoticeView } from '@/services/api';

/**
 * 裁决结果条回归（批④补丁 Task 4，spec §3.1）：
 * 两态文案 + 逐条「知道了」+ 失败语义（首拉失败隐藏可自愈、已展示后轮询失败保留、ack 失败 toast 且条目保留）。
 */

vi.mock('@/services/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/services/api')>();
  return {
    ...actual,
    listUnreadBillingNotices: vi.fn(),
    ackBillingNotice: vi.fn(),
  };
});

vi.mock('@/components/base', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/components/base')>();
  return { ...actual, toast: vi.fn() };
});

const listMock = vi.mocked(listUnreadBillingNotices);
const ackMock = vi.mocked(ackBillingNotice);
const toastMock = vi.mocked(toast);

function noticeOf(over: Partial<BillingNoticeView> = {}): BillingNoticeView {
  return {
    id: 1,
    type: 'claim_approved',
    orderNo: 'BJ20261001001',
    reason: null,
    createdAt: '2026-10-01T08:00:00.000Z',
    ...over,
  };
}

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  listMock.mockReset();
  ackMock.mockReset().mockResolvedValue({ ok: true });
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('BillingNoticeBar', () => {
  it('① approved → 「您的订阅已开通」；rejected → 「管理员未确认本次转账」+ 驳回原因', async () => {
    listMock.mockResolvedValue({ items: [noticeOf({ id: 1, type: 'claim_approved' })], total: 1 });
    const { unmount } = render(<BillingNoticeBar />);
    const bar = await screen.findByTestId('billing-notice-bar');
    expect(bar).toHaveTextContent('您的订阅已开通');
    expect(bar).not.toHaveTextContent('管理员未确认本次转账');
    unmount();

    listMock.mockResolvedValue({
      items: [noticeOf({ id: 2, type: 'claim_rejected', reason: '转账金额与订单不符' })],
      total: 1,
    });
    const { unmount: unmount2 } = render(<BillingNoticeBar />);
    const bar2 = await screen.findByTestId('billing-notice-bar');
    expect(bar2).toHaveTextContent('管理员未确认本次转账：转账金额与订单不符');
    unmount2();

    // reason 为 null（理论不会出现，但组件不许崩）→ 不带冒号
    listMock.mockResolvedValue({ items: [noticeOf({ id: 3, type: 'claim_rejected', reason: null })], total: 1 });
    unmount();
    render(<BillingNoticeBar />);
    const bar3 = await screen.findByTestId('billing-notice-bar');
    expect(bar3).toHaveTextContent('管理员未确认本次转账');
    expect(bar3.textContent).not.toContain('管理员未确认本次转账：');
  });

  it('② 点某条「知道了」→ ackBillingNotice(id) 被调、该条消失、另一条保留', async () => {
    listMock.mockResolvedValue({
      items: [
        noticeOf({ id: 7, type: 'claim_approved' }),
        noticeOf({ id: 8, type: 'claim_rejected', reason: '备注不符' }),
      ],
      total: 2,
    });
    render(<BillingNoticeBar />);
    await screen.findByTestId('billing-notice-bar');

    fireEvent.click(screen.getByTestId('billing-notice-ack-7'));
    await waitFor(() => expect(ackMock).toHaveBeenCalledWith(7));
    await waitFor(() => expect(screen.queryByTestId('billing-notice-ack-7')).not.toBeInTheDocument());
    expect(screen.getByTestId('billing-notice-ack-8')).toBeInTheDocument();
  });

  it('③ 全部 ack 完 → 容器不渲染', async () => {
    listMock.mockResolvedValue({
      items: [noticeOf({ id: 7 }), noticeOf({ id: 8, type: 'claim_rejected', reason: 'x' })],
      total: 2,
    });
    render(<BillingNoticeBar />);
    await screen.findByTestId('billing-notice-bar');

    fireEvent.click(screen.getByTestId('billing-notice-ack-7'));
    fireEvent.click(screen.getByTestId('billing-notice-ack-8'));
    await waitFor(() => expect(screen.queryByTestId('billing-notice-bar')).not.toBeInTheDocument());
  });

  it('④ 首拉失败 → 不渲染；下一轮轮询成功 → 恢复渲染', async () => {
    listMock.mockRejectedValueOnce(new Error('network down'));
    render(<BillingNoticeBar />);
    await waitFor(() => expect(listMock).toHaveBeenCalledTimes(1));
    expect(screen.queryByTestId('billing-notice-bar')).not.toBeInTheDocument();

    listMock.mockResolvedValue({ items: [noticeOf({ id: 9 })], total: 1 });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(NOTICE_POLL_INTERVAL_MS);
    });
    expect(await screen.findByTestId('billing-notice-bar')).toBeInTheDocument();
  });

  it('⑤ 已展示后再轮询失败 → 列表保留（不打折消失）', async () => {
    listMock.mockResolvedValue({ items: [noticeOf({ id: 10 })], total: 1 });
    render(<BillingNoticeBar />);
    await screen.findByTestId('billing-notice-bar');

    listMock.mockRejectedValue(new Error('network down'));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(NOTICE_POLL_INTERVAL_MS);
    });
    expect(screen.getByTestId('billing-notice-ack-10')).toBeInTheDocument();
  });

  it('⑥ ack 失败 → toast error「操作失败，请稍后再试」且条目保留', async () => {
    listMock.mockResolvedValue({ items: [noticeOf({ id: 11 })], total: 1 });
    render(<BillingNoticeBar />);
    await screen.findByTestId('billing-notice-ack-11');

    ackMock.mockRejectedValue(new Error('busy'));
    fireEvent.click(screen.getByTestId('billing-notice-ack-11'));
    await waitFor(() => expect(toastMock).toHaveBeenCalledWith('error', '操作失败，请稍后再试'));
    expect(screen.getByTestId('billing-notice-ack-11')).toBeInTheDocument();
  });
});
