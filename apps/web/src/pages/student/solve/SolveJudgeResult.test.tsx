import type { ComponentProps } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { SolveJudgeResult } from './SolveJudgeResult';
import type { FreeformJudgeResult } from './useFreeformJudge';
import { useChatStore } from '@/store/chatStore';

// globals: false —— 本仓不自动注册 RTL 的 cleanup，多用例文件必须自己收
afterEach(() => {
  cleanup();
  useChatStore.setState({ messages: [], isStreaming: false });
});

const RESULT: FreeformJudgeResult = {
  type: 'result',
  questionId: 42,
  totalScore: 8,
  maxScore: 10,
  verdict: 'partial',
  correctAnswer: '$x=1$',
};

function renderCard(over: Partial<ComponentProps<typeof SolveJudgeResult>> = {}) {
  return render(
    <SolveJudgeResult
      result={RESULT}
      submitting={false}
      myAnswer="我的答案是 **2**"
      report={'## 判题结果\n\n| 步骤 | 得分 |\n|---|---|\n| 1 | 8/10 |'}
      onRetry={vi.fn()}
      onAskHelp={vi.fn()}
      onEditAgain={vi.fn()}
      {...over}
    />,
  );
}

describe('SolveJudgeResult', () => {
  it('直接给结论/得分/我的答案/正确答案/完整报告', () => {
    const { container } = renderCard();

    expect(screen.getByText('部分正确')).toBeInTheDocument();
    expect(screen.getByText('得分 8 / 10')).toBeInTheDocument();
    expect(screen.getByText('我的答案')).toBeInTheDocument();
    expect(screen.getByText('正确答案')).toBeInTheDocument();
    expect(screen.getByText('完整判题报告')).toBeInTheDocument();
    // 我的答案按 Markdown 渲染（**2** 变粗体）
    expect(container.querySelector('strong')?.textContent).toBe('2');
    // 正确答案的 $x=1$ 走 KaTeX
    expect(container.querySelector('.katex')).toBeTruthy();
  });

  it('正确答案 / 报告支持 HTML 表格与内联 SVG', () => {
    const { container } = renderCard({
      result: {
        ...RESULT,
        verdict: 'correct',
        totalScore: 10,
        correctAnswer:
          '$x=1$\n\n<table><tbody><tr><td>甲</td></tr></tbody></table>\n\n<svg viewBox="0 0 10 10"><circle cx="5" cy="5" r="4" /></svg>',
      },
      report: '',
    });

    expect(screen.getByText('回答正确')).toBeInTheDocument();
    expect(container.querySelector('table td')?.textContent).toBe('甲');
    expect(container.querySelector('svg circle')).toBeTruthy();
    // 报告为空时不渲染空标题
    expect(screen.queryByText('完整判题报告')).toBeNull();
  });

  it('判题中点按钮不可用；出结果后可再答一次 / 答疑', () => {
    const onEditAgain = vi.fn();
    const onAskHelp = vi.fn();
    const { rerender } = renderCard({ onEditAgain, onAskHelp });

    fireEvent.click(screen.getByRole('button', { name: '再答一次' }));
    fireEvent.click(screen.getByRole('button', { name: '答疑' }));
    expect(onEditAgain).toHaveBeenCalledTimes(1);
    expect(onAskHelp).toHaveBeenCalledTimes(1);

    rerender(
      <SolveJudgeResult
        result={null}
        submitting
        myAnswer=""
        report=""
        onAskHelp={onAskHelp}
        onEditAgain={onEditAgain}
      />,
    );
    expect(screen.getByText(/AI 正在判题/)).toBeInTheDocument();
    expect(screen.getByText('模型正在思考，还没有输出…')).toBeInTheDocument();
  });

  it('判题中实时显示思考过程与报告增量，并给已等待时间', () => {
    useChatStore.setState({
      messages: [
        {
          role: 'assistant',
          content: '## 判题结果\n\n正在批改…',
          reasoning: '先独立解一遍\n再对步骤',
          streaming: true,
        },
      ],
      isStreaming: true,
    });

    renderCard({ result: null, submitting: true });

    expect(screen.getByText('思考过程（实时）')).toBeInTheDocument();
    expect(screen.getByText(/先独立解一遍/)).toBeInTheDocument();
    expect(screen.getByText('判题报告（生成中）')).toBeInTheDocument();
    expect(screen.getByText(/正在批改/)).toBeInTheDocument();
    expect(screen.getByText(/已等待 \d+ 秒/)).toBeInTheDocument();
  });

  it('学生停止后：显示已停止，可继续判题 / 返回作答', () => {
    const onRetry = vi.fn();
    const onEditAgain = vi.fn();
    renderCard({ result: null, submitting: false, stopped: true, onRetry, onEditAgain });

    expect(screen.getByText('已停止判题')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '继续判题' }));
    fireEvent.click(screen.getByRole('button', { name: '返回作答' }));
    expect(onRetry).toHaveBeenCalledTimes(1);
    expect(onEditAgain).toHaveBeenCalledTimes(1);
  });

  it('重练队列：结果卡显示「下一题」并回调；不传时不渲染', () => {
    const onNext = vi.fn();
    const { unmount } = renderCard({ nextLabel: '下一题', onNext });
    fireEvent.click(screen.getByRole('button', { name: '下一题' }));
    expect(onNext).toHaveBeenCalledTimes(1);
    unmount();

    renderCard();
    expect(screen.queryByRole('button', { name: '下一题' })).toBeNull();
  });

  it('重练队列：失败态也能「下一题」跳过', () => {
    const onNext = vi.fn();
    renderCard({
      result: null,
      submitting: false,
      error: '判题失败，请重试',
      nextLabel: '下一题',
      onNext,
    });

    fireEvent.click(screen.getByRole('button', { name: '下一题' }));
    expect(onNext).toHaveBeenCalledTimes(1);
  });

  it('判题失败：显示错误 + 重试 / 返回作答', () => {
    const onRetry = vi.fn();
    const onEditAgain = vi.fn();
    renderCard({ result: null, submitting: false, error: '判题失败，请重试', onRetry, onEditAgain });

    expect(screen.getByText('判题失败，请重试')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '重试' }));
    fireEvent.click(screen.getByRole('button', { name: '返回作答' }));
    expect(onRetry).toHaveBeenCalledTimes(1);
    expect(onEditAgain).toHaveBeenCalledTimes(1);
  });
});
