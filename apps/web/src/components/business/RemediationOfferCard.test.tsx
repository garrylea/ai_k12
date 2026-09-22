import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { RemediationOfferCard } from './RemediationOfferCard';
import { toast } from '@/components/base/Toast';

/**
 * 错题补偿套题询问卡（考试结果页 / 专项完成页共用）。
 *
 * vitest globals:false —— 必须显式 import + 自己写 afterEach(cleanup)。
 *
 * toast mock 只对「从 `@/components/base/Toast` 直接 import」生效，故组件里
 * 也必须从该路径 import toast（勿改走 barrel），否则 mock 不生效、会真弹 toast。
 *
 * 成功路径断言的是被 mock 的 toast 调用，而非 DOM 文本：组件成功后立刻
 * `setState('done')` 返回 null，「已生成 …」只存在于 toast 消息里、不进 DOM。
 */
const generateRemediationSet = vi.hoisted(() => vi.fn());
vi.mock('@/services/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/services/api')>();
  return { ...actual, generateRemediationSet };
});

vi.mock('@/components/base/Toast', () => ({ toast: vi.fn() }));

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

beforeEach(() => {
  generateRemediationSet.mockReset();
  vi.mocked(toast).mockClear();
});

describe('RemediationOfferCard', () => {
  it('错题数 > 0 时渲染询问卡', () => {
    render(<RemediationOfferCard source="exam" sessionId={7} wrongCount={3} />);
    expect(screen.getByText(/本场错了 3 道题/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /生成练习/ })).toBeInTheDocument();
  });

  it('点击“跳过”隐藏卡片', () => {
    render(<RemediationOfferCard source="exam" sessionId={7} wrongCount={3} />);
    fireEvent.click(screen.getByRole('button', { name: /跳过/ }));
    expect(screen.queryByText(/本场错了/)).not.toBeInTheDocument();
  });

  it('targeted 来源携带 wrongQuestionIds 调用生成', async () => {
    generateRemediationSet.mockResolvedValue({
      setId: 5,
      groupsCreated: 2,
      itemsCreated: 6,
      skippedNoKp: 0,
      aiPendingCount: 0,
    });
    render(
      <RemediationOfferCard source="targeted" sessionId={8} wrongCount={2} wrongQuestionIds={[11, 12]} />,
    );
    fireEvent.click(screen.getByRole('button', { name: /生成练习/ }));
    await vi.waitFor(() =>
      expect(toast).toHaveBeenCalledWith('success', expect.stringContaining('已生成')),
    );
    expect(generateRemediationSet).toHaveBeenCalledWith({
      source: 'targeted',
      sessionId: 8,
      wrongQuestionIds: [11, 12],
    });
  });
});
