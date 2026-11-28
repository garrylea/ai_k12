import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { toast } from '@/components/base';
import { recommendFeaturedSet } from '@/services/api';
import RecommendFeaturedSetButton from './RecommendFeaturedSetButton';

/**
 * 精选题推荐按钮（2026-11-28）：idle → sending → done 状态机 + toast 反馈。
 * vitest globals:false —— 显式 import + 自己写 afterEach(cleanup)，否则 DOM 泄漏串命中。
 */

vi.mock('@/services/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/services/api')>();
  return { ...actual, recommendFeaturedSet: vi.fn() };
});

vi.mock('@/components/base', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/components/base')>();
  return { ...actual, toast: vi.fn() };
});

const recommendMock = vi.mocked(recommendFeaturedSet);
const toastMock = vi.mocked(toast);

beforeEach(() => {
  recommendMock.mockReset();
  toastMock.mockReset();
  recommendMock.mockResolvedValue({ setId: 3, alreadyRecommended: false });
});

afterEach(() => {
  cleanup();
});

describe('RecommendFeaturedSetButton 状态机', () => {
  it('点击推荐后变为已推荐，且不会重复提交', async () => {
    render(<RecommendFeaturedSetButton questionIds={[1, 2]} />);

    fireEvent.click(screen.getByRole('button', { name: '推荐这套题' }));

    expect(await screen.findByRole('button', { name: '已推荐' })).toBeDisabled();
    expect(recommendMock).toHaveBeenCalledWith([1, 2]);
    expect(recommendMock).toHaveBeenCalledTimes(1);
    expect(toastMock).toHaveBeenCalledWith('success', '已推荐给教研员');
  });

  it('已推荐后再点不会重复提交', async () => {
    render(<RecommendFeaturedSetButton questionIds={[1]} />);

    fireEvent.click(screen.getByRole('button', { name: '推荐这套题' }));
    await screen.findByRole('button', { name: '已推荐' });
    fireEvent.click(screen.getByRole('button', { name: '已推荐' }));

    expect(recommendMock).toHaveBeenCalledTimes(1);
  });

  it('接口失败：回到可重试态并弹错误 toast', async () => {
    recommendMock.mockRejectedValueOnce(new Error('网络异常'));
    render(<RecommendFeaturedSetButton questionIds={[7]} />);

    fireEvent.click(screen.getByRole('button', { name: '推荐这套题' }));

    await waitFor(() => expect(toastMock).toHaveBeenCalledWith('error', '网络异常'));
    const btn = screen.getByRole('button', { name: '推荐这套题' });
    expect(btn).toBeEnabled();

    // 可重试：第二次成功 → 已推荐
    fireEvent.click(btn);
    expect(await screen.findByRole('button', { name: '已推荐' })).toBeDisabled();
    expect(recommendMock).toHaveBeenCalledTimes(2);
  });

  it('非 Error 抛出时错误 toast 用兜底文案', async () => {
    recommendMock.mockRejectedValueOnce('boom');
    render(<RecommendFeaturedSetButton questionIds={[1]} />);

    fireEvent.click(screen.getByRole('button', { name: '推荐这套题' }));

    await waitFor(() => expect(toastMock).toHaveBeenCalledWith('error', '推荐失败'));
  });
});

describe('RecommendFeaturedSetButton 禁用态', () => {
  it('有 disabledReason 时渲染禁用按钮且显示原因，不发请求', () => {
    render(
      <RecommendFeaturedSetButton questionIds={[]} disabledReason="暂无标准答案" />,
    );

    const btn = screen.getByRole('button', { name: '暂无标准答案' });
    expect(btn).toBeDisabled();
    fireEvent.click(btn);
    expect(recommendMock).not.toHaveBeenCalled();
    expect(toastMock).not.toHaveBeenCalled();
  });
});
