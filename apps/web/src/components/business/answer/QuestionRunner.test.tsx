// apps/web/src/components/business/answer/QuestionRunner.repro.test.tsx
// 复现测试：切题（上一题回退）后，之前已作答的答案应被回填，不丢失。
// 场景对应 bug 报告：专项训练/考试/错题练习时回到上一题看到作答空白。
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useMemo, useState } from 'react';

// vitest globals:false 下 @testing-library/react 不会自动注册 afterEach cleanup，
// 需手动清理，否则上一个用例的 DOM 泄漏到下一个用例导致选择器重复命中。
afterEach(() => cleanup());
import { QuestionRunner } from './QuestionRunner';
import type { RunnerJudgeOutcome, RunnerQuestion } from './types';

function makeQuestions(): RunnerQuestion[] {
  return [
    { n: '1', text: '第一题题干', type: 'choice', options: [{ label: 'A', text: '选项A' }, { label: 'B', text: '选项B' }] },
    { n: '2', text: '第二题题干', type: 'choice', options: [{ label: 'A', text: '选项A' }, { label: 'B', text: '选项B' }] },
    { n: '3', text: '第三题题干', type: 'choice', options: [{ label: 'A', text: '选项A' }, { label: 'B', text: '选项B' }] },
  ];
}

// 模拟真实训练页的包裹方式：带 onQuestionChange（父层 setState 追踪当前题，切题会触发
// 父层重渲染）+ hints + draftDisabled，确认这些 props 不会破坏作答回填。
// questions 必须 useMemo 稳定引用（真实页面也是 entries/session 不变就不重建）——
// 否则每次父层重渲染都生成新数组，触发 QuestionRunner 切题 effect 无限循环。
function Wrapper({ textAnswer = false }: { textAnswer?: boolean }) {
  const [, force] = useState(0);
  const questions = useMemo(() => {
    const qs = makeQuestions();
    if (textAnswer) {
      qs[0] = { n: '1', text: '第一题题干', type: 'short_answer' };
    }
    return qs;
  }, [textAnswer]);
  return (
    <QuestionRunner
      questions={questions}
      subjectId={1}
      draftKeyPrefix="repro"
      variant="embedded"
      draftDisabled
      enableHint
      hints={{}}
      onRequestHint={async () => 'hint'}
      headerActions={() => null}
      onQuestionChange={() => force((x) => x + 1)}
      onSubmit={async (): Promise<RunnerJudgeOutcome> => ({ isCorrect: true, method: 'exact' })}
      onFinish={async () => {}}
    />
  );
}

async function renderRunner(opts?: { textAnswer?: boolean }) {
  const user = userEvent.setup();
  render(<Wrapper {...opts} />);
  return { user };
}

function optionRadio(needle: string): HTMLElement | undefined {
  return screen.getAllByRole('radio').find((r) => r.textContent?.includes(needle));
}

// 考试续考/刷新恢复：后端已答文本经 initialAnswers 在挂载时回填，直接点「上一题」也能看到
function renderWithInitialAnswers(initialAnswers: Record<string, string>) {
  const user = userEvent.setup();
  const questions = makeQuestions();
  render(
    <QuestionRunner
      questions={questions}
      subjectId={1}
      draftKeyPrefix="resume"
      variant="embedded"
      initialAnswers={initialAnswers}
      onSubmit={async (): Promise<RunnerJudgeOutcome> => ({ isCorrect: true, method: 'exact' })}
      onFinish={async () => {}}
    />,
  );
  return { user };
}

describe('QuestionRunner 回看上一题保留作答（bug 复现）', () => {
  it('选择题：答第1题并提交后，点「上一题」应恢复已选选项', async () => {
    const { user } = await renderRunner();

    // 初始在第 1 题
    expect(screen.getByText('第一题题干')).toBeInTheDocument();

    // 点选选项 A
    await user.click(optionRadio('选项A') as HTMLElement);
    // 提交 -> 切到第 2 题
    await user.click(screen.getByRole('button', { name: '提交' }));
    expect(await screen.findByText('第二题题干')).toBeInTheDocument();

    // 点「上一题」回第 1 题
    await user.click(screen.getByRole('button', { name: '上一题' }));
    expect(screen.getByText('第一题题干')).toBeInTheDocument();

    // 第 1 题的作答应恢复为 A（radio aria-checked）
    expect(optionRadio('选项A')).toHaveAttribute('aria-checked', 'true');
    expect(optionRadio('选项B')).toHaveAttribute('aria-checked', 'false');
  });

  it('选择题：连续答两题后再回退，各题答案按题分别保留', async () => {
    const { user } = await renderRunner();

    // 第 1 题答 A 提交
    await user.click(optionRadio('选项A') as HTMLElement);
    await user.click(screen.getByRole('button', { name: '提交' }));
    await screen.findByText('第二题题干');

    // 第 2 题答 B 提交
    await user.click(optionRadio('选项B') as HTMLElement);
    await user.click(screen.getByRole('button', { name: '提交' }));
    await screen.findByText('第三题题干');

    // 回退到第 2 题：应恢复 B
    await user.click(screen.getByRole('button', { name: '上一题' }));
    expect(screen.getByText('第二题题干')).toBeInTheDocument();
    expect(optionRadio('选项B')).toHaveAttribute('aria-checked', 'true');

    // 再回退到第 1 题：应恢复 A
    await user.click(screen.getByRole('button', { name: '上一题' }));
    expect(screen.getByText('第一题题干')).toBeInTheDocument();
    expect(optionRadio('选项A')).toHaveAttribute('aria-checked', 'true');
  });

  it('文本作答（LaTeX 输入框）：答完提交再回退，应恢复已填内容', async () => {
    const { user } = await renderRunner({ textAnswer: true });

    const input = () => screen.getByPlaceholderText(/在此用 LaTeX 作答/) as HTMLTextAreaElement;
    await user.type(input(), 'x^2+1');
    await user.click(screen.getByRole('button', { name: '提交' }));
    await screen.findByText('第二题题干');
    // 切走后不应再渲染第 1 题输入框
    expect(screen.queryByPlaceholderText(/在此用 LaTeX 作答/)).toBeNull();

    await user.click(screen.getByRole('button', { name: '上一题' }));
    expect(screen.getByText('第一题题干')).toBeInTheDocument();
    expect(input().value).toBe('x^2+1');
  });

  it('续考恢复：initialAnswers 在第 1 题直接回填已选 B，切走再回退仍保留', async () => {
    const { user } = renderWithInitialAnswers({ '1': 'B' });

    // 挂载即在第 1 题：B 应为 checked（后端已答文本回填）
    expect(screen.getByText('第一题题干')).toBeInTheDocument();
    expect(optionRadio('选项B')).toHaveAttribute('aria-checked', 'true');

    // 提交 -> 第 2 题
    await user.click(screen.getByRole('button', { name: '提交' }));
    await screen.findByText('第二题题干');

    // 回退到第 1 题：B 仍选中
    await user.click(screen.getByRole('button', { name: '上一题' }));
    expect(optionRadio('选项B')).toHaveAttribute('aria-checked', 'true');
  });

  // ── 左输入区 → 右预览区的比例滚动跟随（2026-09-22 bug：两侧独立滚动完全脱节）──
  // jsdom 无布局：用实例属性覆写滚动几何（左 250/500 = 0.5 → 右 0.5 × 600 = 300）
  it('文本作答：输入区滚动后预览区按比例跟随', async () => {
    await renderRunner({ textAnswer: true });

    const ta = screen.getByPlaceholderText(/在此用 LaTeX 作答/) as HTMLTextAreaElement;
    const preview = screen.getByTestId('latex-preview-scroll');
    const mock = (el: HTMLElement, geo: { scrollTop: number; scrollHeight: number; clientHeight: number }) => {
      let top = geo.scrollTop;
      Object.defineProperty(el, 'scrollTop', { get: () => top, set: (v: number) => { top = v; }, configurable: true });
      Object.defineProperty(el, 'scrollHeight', { get: () => geo.scrollHeight, configurable: true });
      Object.defineProperty(el, 'clientHeight', { get: () => geo.clientHeight, configurable: true });
      return { get scrollTop() { return top; } };
    };
    mock(ta, { scrollTop: 250, scrollHeight: 800, clientHeight: 300 });
    const pgeo = mock(preview, { scrollTop: 0, scrollHeight: 1000, clientHeight: 400 });

    fireEvent.scroll(ta);

    expect(pgeo.scrollTop).toBe(300);
  });
});


// 主观题同步提交 + 强制自评（self_assess 模式）：提交后判题即时返回 needsSelfAssessment，
// 进入自评视图（参考答案+解析+我做对了/我做错了），必须自评后才放行。
// 题目数组用模块级常量（真实页面 entries/session 不变即引用稳定，等价 useMemo）。
const SA_PROOF_QUESTIONS: RunnerQuestion[] = [
  { n: '1', text: '证明题题干', type: 'proof' },
  { n: '2', text: '第二题题干', type: 'proof' },
];

const SA_SHORT_QUESTIONS: RunnerQuestion[] = [
  { n: '1', text: '解答题题干', type: 'short_answer' },
];

describe('主观题自评（self_assess 模式）', () => {
  it('提交后进入自评视图，点「我做对了」才放行下一题', async () => {
    const user = userEvent.setup();
    const onSelfAssess = vi.fn(async () => {});
    render(
      <QuestionRunner
        questions={SA_PROOF_QUESTIONS}
        subjectId={1}
        draftKeyPrefix="sa"
        variant="embedded"
        draftDisabled
        onSubmit={async (): Promise<RunnerJudgeOutcome> => ({
          isCorrect: null, method: 'self_assess', needsSelfAssessment: true,
          referenceAnswer: '参考证明过程', explanation: '解析内容',
        })}
        onSelfAssess={onSelfAssess}
        onFinish={() => {}}
      />,
    );
    await user.type(screen.getByRole('textbox'), '我的证明');
    await user.click(screen.getByTitle('提交'));
    // 自评视图出现：参考答案 + 自评按钮，未自评前不放行下一题
    expect(await screen.findByText('参考证明过程')).toBeTruthy();
    expect(screen.queryByText('第二题题干')).toBeNull();
    await user.click(screen.getByRole('button', { name: '我做对了' }));
    expect(onSelfAssess).toHaveBeenCalledWith(
      expect.objectContaining({ n: '1' }),
      'correct',
      expect.objectContaining({ studentAnswer: '我的证明' }),
    );
    expect(await screen.findByText('第二题题干')).toBeTruthy();
  });

  it('未提供 onSelfAssess 也强制选择（自评不落库但不可跳过）', async () => {
    const user = userEvent.setup();
    const onFinish = vi.fn();
    render(
      <QuestionRunner
        questions={SA_SHORT_QUESTIONS}
        subjectId={1}
        draftKeyPrefix="sa2"
        variant="embedded"
        draftDisabled
        onSubmit={async (): Promise<RunnerJudgeOutcome> => ({
          isCorrect: null, method: 'self_assess', needsSelfAssessment: true, referenceAnswer: 'x=1',
        })}
        onFinish={onFinish}
      />,
    );
    await user.type(screen.getByRole('textbox'), '解答');
    await user.click(screen.getByTitle('提交'));
    // 进入自评视图；不做选择时 onFinish 不触发
    expect(await screen.findByText('x=1')).toBeTruthy();
    expect(onFinish).not.toHaveBeenCalled();
    await user.click(screen.getByRole('button', { name: '我做错了' }));
    await waitFor(() => {
      expect(onFinish).toHaveBeenCalledWith(
        expect.objectContaining({ '1': expect.objectContaining({ isCorrect: false, method: 'self_assess' }) }),
      );
    });
  });
});
