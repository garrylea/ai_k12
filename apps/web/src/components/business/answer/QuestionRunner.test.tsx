// apps/web/src/components/business/answer/QuestionRunner.repro.test.tsx
// 复现测试：切题（上一题回退）后，之前已作答的答案应被回填，不丢失。
// 场景对应 bug 报告：专项训练/考试/错题练习时回到上一题看到作答空白。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useMemo, useState } from 'react';

// vitest globals:false 下 @testing-library/react 不会自动注册 afterEach cleanup，
// 需手动清理，否则上一个用例的 DOM 泄漏到下一个用例导致选择器重复命中。
afterEach(() => cleanup());

// 上传挂起 → 由用例自己 resolve。必须可控：只有能 resolve，才能断言「上传完成后恢复可提交」，
// 否则「上传中禁用」与「残留文本禁用」两条判据互相掩盖（删掉 onUploadingChange 接线也照样绿）。
// vi.hoisted 保证它在 vi.mock 工厂（被提升到文件顶部）之前就存在。
const uploadControl = vi.hoisted(() => ({
  resolve: undefined as undefined | ((v: { fileId: number; url: string }) => void),
}));

// 必须 ...actual 透传原模块——@/analytics/tracker 也从 '@/services/api' 取命名导出，
// 整体替换会让那边的导入变 undefined。
vi.mock('@/services/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/services/api')>();
  return {
    ...actual,
    uploadFile: vi.fn(
      () =>
        new Promise<{ fileId: number; url: string }>((resolve) => {
          uploadControl.resolve = resolve;
        }),
    ),
  };
});

// jsdom 没有 URL.createObjectURL，真实压缩必然抛错（占位会立刻变「上传失败」，
// 上传中态一瞬间就结束，用例会假性通过）。让压缩直通，上传才能真的停在挂起的 uploadFile 上。
vi.mock('@/utils/image-compress', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/utils/image-compress')>();
  return { ...actual, compressImageFile: vi.fn(async (f: File) => f) };
});
import { QuestionRunner } from './QuestionRunner';
import { uploadFile } from '@/services/api';
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

const SA_FILL_QUESTIONS: RunnerQuestion[] = [
  { n: '1', text: '化学填空题干', type: 'fill_blank' },
];

describe('内联自评闸门按学科开放（闸门③）', () => {
  it('化学填空返回 needsSelfAssessment 时进入自评视图', async () => {
    const user = userEvent.setup();
    const onSelfAssess = vi.fn(async () => {});
    render(
      <QuestionRunner
        questions={SA_FILL_QUESTIONS}
        subjectId={5}
        draftKeyPrefix="chem"
        variant="embedded"
        draftDisabled
        onSubmit={async (): Promise<RunnerJudgeOutcome> => ({
          isCorrect: null, method: 'self_assess', needsSelfAssessment: true, referenceAnswer: 'CO2',
        })}
        onSelfAssess={onSelfAssess}
        onFinish={() => {}}
      />,
    );
    await user.type(screen.getByRole('textbox'), 'CO2');
    await user.click(screen.getByTitle('提交'));
    expect(await screen.findByText('CO2')).toBeTruthy();
    await user.click(screen.getByRole('button', { name: '我做对了' }));
    expect(onSelfAssess).toHaveBeenCalledTimes(1);
  });

  it('数学填空保持 fire-and-forget：不弹自评、直接记结果', async () => {
    const user = userEvent.setup();
    const onFinish = vi.fn();
    render(
      <QuestionRunner
        questions={[{ n: '1', text: '数学填空题干', type: 'fill_blank' }]}
        subjectId={1}
        draftKeyPrefix="math"
        variant="embedded"
        draftDisabled
        onSubmit={async (): Promise<RunnerJudgeOutcome> => ({ isCorrect: true, method: 'exact' })}
        onFinish={onFinish}
      />,
    );
    await user.type(screen.getByRole('textbox'), '2/3');
    await user.click(screen.getByTitle('提交'));
    await waitFor(() => expect(onFinish).toHaveBeenCalled());
  });
});

describe('QuestionRunner 材料渲染（语文阅读/文段题）', () => {
  it('material 非空时题干上方渲染材料块（含图片走 resolveAsset），无 material 不渲染', () => {
    const withMaterial: RunnerQuestion[] = [{
      n: '1',
      text: '根据材料回答',
      type: 'choice',
      options: [{ label: 'A', text: '选项A' }],
      material: '## 材料一\n\n这是阅读材料\n\n![图1](chinese/paper/fig1.png)',
    }];
    const { unmount } = render(
      <QuestionRunner
        questions={withMaterial}
        subjectId={2}
        draftKeyPrefix="mat"
        variant="embedded"
        onSubmit={async (): Promise<RunnerJudgeOutcome> => ({ isCorrect: true, method: 'exact' })}
        onFinish={async () => {}}
      />,
    );

    const block = screen.getByTestId('question-material');
    expect(block.textContent).toContain('这是阅读材料');
    expect(block.querySelector('img')?.getAttribute('src')).toContain('/assets/chinese/paper/fig1.png');
    unmount();

    render(
      <QuestionRunner
        questions={[{ n: '1', text: '纯题面', type: 'choice', options: [{ label: 'A', text: '选项A' }] }]}
        subjectId={1}
        draftKeyPrefix="mat2"
        variant="embedded"
        onSubmit={async (): Promise<RunnerJudgeOutcome> => ({ isCorrect: true, method: 'exact' })}
        onFinish={async () => {}}
      />,
    );
    expect(screen.queryByTestId('question-material')).toBeNull();
  });
});

describe('QuestionRunner 题面高度比例（非理科 2/3 / 理科 1/3）', () => {
  function renderQ(subjectId: number, q: RunnerQuestion) {
    return render(
      <QuestionRunner
        questions={[q]}
        subjectId={subjectId}
        draftKeyPrefix={`stem-ratio-${subjectId}`}
        variant="embedded"
        draftDisabled
        onSubmit={async (): Promise<RunnerJudgeOutcome> => ({ isCorrect: true, method: 'exact' })}
        onFinish={async () => {}}
      />,
    );
  }
  const textQ: RunnerQuestion = { n: '1', text: '长文段题干', type: 'short_answer' };
  const choiceQ: RunnerQuestion = { n: '1', text: '选择题题干', type: 'choice', options: [{ label: 'A', text: '选项A' }] };

  it('语文/英语（非理科）：题干上限 66.67%，作答区无 280px 保底', () => {
    for (const id of [2, 3]) {
      const { unmount } = renderQ(id, textQ);
      expect(screen.getByTestId('question-stem').className).toContain('max-h-[66.67%]');
      expect(screen.getByTestId('question-stem').className).not.toContain('max-h-[33%]');
      expect(screen.getByTestId('question-answer').className).not.toContain('min-h-[280px]');
      unmount();
    }
  });

  it('数学/物理/化学（理科）：题干上限 1/3，作答区保留 280px 保底', () => {
    for (const id of [1, 4, 5]) {
      const { unmount } = renderQ(id, textQ);
      expect(screen.getByTestId('question-stem').className).toContain('max-h-[33%]');
      expect(screen.getByTestId('question-answer').className).toContain('min-h-[280px]');
      unmount();
    }
  });

  it('选择题：语文仍是 66.67%，理科维持 60%（选项区可压缩）', () => {
    const { unmount } = renderQ(2, choiceQ);
    expect(screen.getByTestId('question-stem').className).toContain('max-h-[66.67%]');
    unmount();

    renderQ(1, choiceQ);
    expect(screen.getByTestId('question-stem').className).toContain('max-h-[60%]');
    expect(screen.getByTestId('question-answer').className).not.toContain('min-h-[280px]');
  });

  it('阅读材料：非理科去掉 38vh 独立上限（交给题干区统一滚动），理科保留', () => {
    const withMaterial: RunnerQuestion = { ...choiceQ, material: '## 材料一\n\n这是阅读材料' };

    const { unmount } = renderQ(2, withMaterial);
    const chineseMaterial = screen.getByTestId('question-material');
    expect(chineseMaterial.className).not.toContain('max-h-[38vh]');
    expect(chineseMaterial.className).not.toContain('overflow-y-auto');
    unmount();

    renderQ(1, withMaterial);
    expect(screen.getByTestId('question-material').className).toContain('max-h-[38vh]');
  });
});

describe('QuestionRunner 文本作答形态（2026-10-28：理科两栏 / 文字学科单栏）', () => {
  const textQ: RunnerQuestion[] = [{ n: '1', text: '请谈谈你的理解', type: 'short_answer' }];

  function renderText(
    subjectId: number,
    answerInput?: 'latex' | 'plain',
    onSubmit = vi.fn(async (): Promise<RunnerJudgeOutcome> => ({ isCorrect: null, method: 'self_assess', needsSelfAssessment: true })),
  ) {
    render(
      <QuestionRunner
        questions={textQ}
        subjectId={subjectId}
        answerInput={answerInput}
        draftKeyPrefix="input-mode"
        variant="embedded"
        draftDisabled
        onSubmit={onSubmit}
        onFinish={async () => {}}
      />,
    );
    return { onSubmit };
  }

  it('语文（subjectId=2）：整宽纯文本，不渲染「预览/草稿」右栏与 LaTeX 输入提示', () => {
    renderText(2);
    expect(screen.getByLabelText('作答区')).toBeTruthy();
    expect(screen.getByPlaceholderText('请在此作答')).toBeTruthy();
    expect(screen.queryByRole('button', { name: '预览' })).toBeNull();
    expect(screen.queryByRole('button', { name: '草稿' })).toBeNull();
    expect(screen.queryByPlaceholderText(/LaTeX/)).toBeNull();
  });

  it('英语（subjectId=3）同样走单栏纯文本', () => {
    renderText(3);
    expect(screen.getByLabelText('作答区')).toBeTruthy();
    expect(screen.queryByRole('button', { name: '预览' })).toBeNull();
  });

  it('数学/物理/化学仍保留左输入 + 右预览两栏', () => {
    for (const id of [1, 4, 5]) {
      const { unmount } = render(
        <QuestionRunner
          questions={textQ}
          subjectId={id}
          draftKeyPrefix={`input-mode-${id}`}
          variant="embedded"
          draftDisabled
          onSubmit={async (): Promise<RunnerJudgeOutcome> => ({ isCorrect: true, method: 'exact' })}
          onFinish={async () => {}}
        />,
      );
      // draftDisabled 下右栏是纯预览（无 tab 按钮），用 LaTeX 输入提示区分两栏形态
      expect(screen.getByPlaceholderText(/LaTeX/)).toBeTruthy();
      expect(screen.queryByLabelText('作答区')).toBeNull();
      unmount();
    }
  });

  it('显式 answerInput="latex" 可覆盖学科默认（参数优先）', () => {
    renderText(2, 'latex');
    expect(screen.getByPlaceholderText(/LaTeX/)).toBeTruthy();
    expect(screen.queryByLabelText('作答区')).toBeNull();
  });

  it('纯文本作答会原样提交给 onSubmit', async () => {
    const user = userEvent.setup();
    const { onSubmit } = renderText(2);
    await user.type(screen.getByLabelText('作答区'), '写出了自己的理解');
    // 单人题：提交按钮在底部（aria-label=提交）
    await user.click(screen.getByRole('button', { name: '提交' }));
    await waitFor(() => expect(onSubmit).toHaveBeenCalledWith(
      expect.objectContaining({ n: '1' }),
      '写出了自己的理解',
    ));
  });
});


describe('题面图注', () => {
  it('图片后紧跟的短说明渲染为 figcaption（不是正文段落）', () => {
    render(
      <QuestionRunner
        questions={[{ n: '1', text: '如图 1 所示\n![](questions/physics/x/1/stem_01.jpg)\n图1', type: 'choice',
                      options: [{ label: 'A', text: '甲' }, { label: 'B', text: '乙' }] }]}
        subjectId={4}
        draftKeyPrefix="cap"
        variant="embedded"
        draftDisabled
        onSubmit={async (): Promise<RunnerJudgeOutcome> => ({ isCorrect: true, method: 'exact' })}
        onFinish={() => {}}
      />,
    );
    const cap = screen.getByText('图1');
    expect(cap.tagName).toBe('FIGCAPTION');
  });
});


describe('多选题（multi_choice）', () => {
  it('可以同时选中多项，提交时答案按字母序拼成 "AC"', async () => {
    const user = userEvent.setup();
    const submitted: string[] = [];
    render(
      <QuestionRunner
        questions={[{
          n: '16', text: '多选：下列说法正确的是', type: 'multi_choice',
          options: [
            { label: 'A', text: '说法甲' },
            { label: 'B', text: '说法乙' },
            { label: 'C', text: '说法丙' },
            { label: 'D', text: '说法丁' },
          ],
        }]}
        subjectId={4}
        draftKeyPrefix="multi"
        variant="embedded"
        onSubmit={async (_q, answer) => { submitted.push(answer); return { isCorrect: true, method: 'exact' }; }}
        onFinish={async () => {}}
      />,
    );

    const boxes = screen.getAllByRole('checkbox');
    expect(boxes).toHaveLength(4);
    await user.click(boxes[0]);
    await user.click(boxes[2]);

    expect(boxes[0]).toHaveAttribute('aria-checked', 'true');
    expect(boxes[2]).toHaveAttribute('aria-checked', 'true');
    expect(boxes[1]).toHaveAttribute('aria-checked', 'false');

    await user.click(screen.getByRole('button', { name: '提交' }));
    expect(submitted).toEqual(['AC']);
  });
});


describe('题号后面的题型标签', () => {
  const base = {
    subjectId: 4, draftKeyPrefix: 'type-label', variant: 'embedded' as const,
    onSubmit: async (): Promise<RunnerJudgeOutcome> => ({ isCorrect: true, method: 'exact' }),
    onFinish: async () => {},
  };

  it('多选题标「多选」', () => {
    render(<QuestionRunner {...base} questions={[{ n: '16', text: '题干', type: 'multi_choice',
      options: [{ label: 'A', text: '甲' }, { label: 'B', text: '乙' }] }]} />);
    expect(screen.getByTestId('question-type')).toHaveTextContent('（多选）');
  });

  it('单选题标「单选」', () => {
    render(<QuestionRunner {...base} questions={[{ n: '1', text: '题干', type: 'choice',
      options: [{ label: 'A', text: '甲' }] }]} />);
    expect(screen.getByTestId('question-type')).toHaveTextContent('（单选）');
  });

  it('简答题标「简答」', () => {
    render(<QuestionRunner {...base} questions={[{ n: '22', text: '题干', type: 'short_answer' }]} />);
    expect(screen.getByTestId('question-type')).toHaveTextContent('（简答）');
  });
});

// 往作答框里贴一张 png：jsdom 无剪贴板，只能手工挂 clipboardData
function pasteImage(ta: HTMLTextAreaElement) {
  const evt = new Event('paste', { bubbles: true, cancelable: true }) as Event & { clipboardData?: unknown };
  Object.defineProperty(evt, 'clipboardData', {
    value: { items: [{ kind: 'file', type: 'image/png', getAsFile: () => new File(['x'], 'a.png', { type: 'image/png' }) }] },
  });
  fireEvent(ta, evt);
}

const submitBtn = () => screen.getByRole('button', { name: '提交' }) as HTMLButtonElement;

// 作答图相关用例的公共 props（两个 describe 共用：上传中禁提交 / 迟到结果归属）
const imageRunnerProps = {
  subjectId: 1,
  draftKeyPrefix: 'img',
  variant: 'embedded' as const,
  draftDisabled: true,
  hints: {},
  onRequestHint: async () => 'hint',
  headerActions: () => null,
  onQuestionChange: () => {},
  onSubmit: async (): Promise<RunnerJudgeOutcome> => ({ isCorrect: null, method: 'self_assess' }),
  onFinish: async () => {},
};

describe('作答图上传中禁提交（防占位文本落库）', () => {

  // 每个用例都从「上传未发起」开始：不清掉上个用例遗留的 resolve 的话，
  // 用例里 resolve 的是上一个 render 的 promise，断言会假性通过。
  beforeEach(() => {
    uploadControl.resolve = undefined;
    vi.mocked(uploadFile).mockClear();
  });

  it('作答图上传中：提交按钮禁用，上传完成恢复（防占位文本落库）', async () => {
    const questions = [{ n: '1', text: '电路图题', type: 'short_answer' }];
    render(
      <QuestionRunner
        questions={questions}
        answerInput="latex"
        {...imageRunnerProps}
      />,
    );
    const ta = screen.getByRole('textbox') as HTMLTextAreaElement;

    pasteImage(ta);

    // 先证明真的进了上传流程（占位已插入 + 上传真的发起）——否则下面的「禁用」可以被
    // hasPendingUpload 的文本兜底单独解释掉，测不出 onUploadingChange 有没有接线。
    await waitFor(() => expect(ta.value).toContain('上传中…'));
    expect(vi.mocked(uploadFile)).toHaveBeenCalledTimes(1);
    expect(submitBtn().disabled).toBe(true);
    // 上传态专属文案：文本兜底态写的是「有图片未上传完成…」，两者不会撞
    expect(submitBtn().title).toBe('图片上传中');

    await act(async () => {
      uploadControl.resolve!({ fileId: 1, url: '/uploads/a/b.png' });
    });

    // 占位被真实图片替换 → 上传态结束，恢复可提交（这条才证明「恢复」）
    await waitFor(() => expect(ta.value).toContain('![图1]'));
    expect(submitBtn().disabled).toBe(false);
    expect(submitBtn().title).toBe('提交');
  });

  it('答案里残留「上传中…」标记时也禁用提交（切题时在飞上传的兜底，见 hasPendingUpload）', async () => {
    // 用 initialAnswers 直接注入残留文本：模拟"上传途中切走、回来时编辑器已换题"的状态
    render(
      <QuestionRunner
        questions={[{ n: '1', text: '电路图题', type: 'short_answer' }]}
        answerInput="latex"
        initialAnswers={{ '1': '2. ［图1 上传中…］' }}
        {...imageRunnerProps}
      />,
    );
    await waitFor(() => expect(submitBtn().disabled).toBe(true));
    // 没有在飞上传，禁用只能来自文本兜底 —— 文案须是兜底那条，不能是上传态那条
    expect(submitBtn().title).toBe('有图片未上传完成，请删除标记后重试');
  });

  it('上传途中切回选择题：上传态必须归零，不能把提交永久锁死', async () => {
    // 选择题与解答题共存：切到选择题时 LatexEditor 会被卸载，它不会再把 uploading=false 回传，
    // 所以父层必须自己在切题时归零（否则 answerUploading 永远 true、整页再也提交不了）。
    const questions: RunnerQuestion[] = [
      { n: '1', text: '选择题题干', type: 'choice', options: [{ label: 'A', text: '选项A' }, { label: 'B', text: '选项B' }] },
      { n: '2', text: '解答题题干', type: 'short_answer' },
    ];
    const user = userEvent.setup();
    render(
      <QuestionRunner
        questions={questions}
        answerInput="latex"
        startIndex={1}
        {...imageRunnerProps}
      />,
    );
    const ta = screen.getByRole('textbox') as HTMLTextAreaElement;
    pasteImage(ta);
    await waitFor(() => expect(ta.value).toContain('上传中…'));
    expect(submitBtn().disabled).toBe(true);

    await user.click(screen.getByRole('button', { name: /上一题/ }));
    // 回到选择题后先选一项：把「空答案」这条禁用原因排除掉，剩下的只能是残留上传态
    await user.click(screen.getByRole('radio', { name: /选项A/ }));

    expect(submitBtn().disabled).toBe(false);
    expect(submitBtn().title).toBe('提交');
  });
});

// 迟到的上传结果必须写回「发起时的题号」（spec §4.1 第 9 步）。
// 修复前 updateAnswer 用的是 currentNRef（此刻已是新题），旧图 URL / 旧题整段文本会落进新题。
describe('作答图上传结果按发起题号写回（切题后迟到的上传）', () => {
  beforeEach(() => {
    uploadControl.resolve = undefined;
    vi.mocked(uploadFile).mockClear();
  });

  it('切到选择题后迟到 resolve：新题不被污染（仍禁用），结果写回原题', async () => {
    const questions: RunnerQuestion[] = [
      { n: '0', text: '选择题题干', type: 'choice', options: [{ label: 'A', text: '选项A' }, { label: 'B', text: '选项B' }] },
      { n: '1', text: '解答题题干', type: 'short_answer' },
    ];
    const user = userEvent.setup();
    render(<QuestionRunner questions={questions} answerInput="latex" startIndex={1} {...imageRunnerProps} />);

    const ta = screen.getByRole('textbox') as HTMLTextAreaElement;
    await user.type(ta, '2.');
    pasteImage(ta);
    await waitFor(() => expect(ta.value).toContain('上传中…'));

    // 切到选择题：编辑器卸载（valueRef 冻结在旧题文本上，这正是污染源）
    await user.click(screen.getByRole('button', { name: /上一题/ }));
    expect(screen.queryByRole('textbox')).toBeNull();

    await act(async () => {
      uploadControl.resolve!({ fileId: 1, url: '/uploads/a/b.png' });
    });

    // ① 新题没作答：修复前旧题整段文本会落进来，按钮变成可点/标题变「提交」
    expect(submitBtn().disabled).toBe(true);
    expect(submitBtn().title).toBe('请先作答');

    // ② 结果确实写回了原题（而不是丢失）：答完选择题回到 q1 能看到真 URL
    await user.click(screen.getByRole('radio', { name: /选项A/ }));
    await user.click(submitBtn());
    expect(await screen.findByText('解答题题干')).toBeTruthy();
    const back = screen.getByRole('textbox') as HTMLTextAreaElement;
    expect(back.value).toContain('![图1](/uploads/a/b.png)');
    expect(back.value).not.toContain('上传中');
  });

  it('LaTeX→LaTeX 切题（实例不卸载）：迟到 resolve 仍写回原题，占位被结算而非丢弃', async () => {
    const questions: RunnerQuestion[] = [
      { n: '0', text: '第一题题干', type: 'short_answer' },
      { n: '1', text: '第二题题干', type: 'short_answer' },
    ];
    const user = userEvent.setup();
    render(<QuestionRunner questions={questions} answerInput="latex" startIndex={1} {...imageRunnerProps} />);

    const ta = screen.getByRole('textbox') as HTMLTextAreaElement;
    pasteImage(ta);
    await waitFor(() => expect(ta.value).toContain('上传中…'));

    await user.click(screen.getByRole('button', { name: /上一题/ }));
    const q0 = screen.getByRole('textbox') as HTMLTextAreaElement;
    await user.type(q0, '第一题答案');

    await act(async () => {
      uploadControl.resolve!({ fileId: 1, url: '/uploads/a/b.png' });
    });

    // 迟到结果不能落到当前这道 LaTeX 题上（实例复用 / 未复用都必须守住）
    expect(q0.value).toBe('第一题答案');
    expect(q0.value).not.toContain('![');

    // 答掉 q0 前进到 q1：占位已被真实 URL 替换，不是被丢弃后残留的上传中标记
    await user.click(submitBtn());
    expect(await screen.findByText('第二题题干')).toBeTruthy();
    const back = screen.getByRole('textbox') as HTMLTextAreaElement;
    expect(back.value).toContain('![图1](/uploads/a/b.png)');
    expect(back.value).not.toContain('上传中');
  });

  it('回到原题并继续输入后才 resolve：按占位补丁写回，不吞掉学生新输入', async () => {
    // 复现路径：q1 贴图（上传在飞）→ 切到 q0 → 答完提交回到 q1（占位已回填）→ 继续打字 → resolve。
    // 修复前迟到回调把「发起上传时的整段文本快照」emit 回父层，「继续写」被静默吞掉。
    const questions: RunnerQuestion[] = [
      { n: '0', text: '选择题题干', type: 'choice', options: [{ label: 'A', text: '选项A' }, { label: 'B', text: '选项B' }] },
      { n: '1', text: '解答题题干', type: 'short_answer' },
    ];
    const user = userEvent.setup();
    render(<QuestionRunner questions={questions} answerInput="latex" startIndex={1} {...imageRunnerProps} />);

    const ta = screen.getByRole('textbox') as HTMLTextAreaElement;
    await user.type(ta, '2.');
    pasteImage(ta);
    await waitFor(() => expect(ta.value).toContain('上传中…'));

    // 切到 q0 把 q1 的编辑器卸载（旧实例的 valueRef 从此冻在贴图时那一刻的文本上）
    await user.click(screen.getByRole('button', { name: /上一题/ }));
    await user.click(screen.getByRole('radio', { name: /选项A/ }));
    await user.click(submitBtn());
    expect(await screen.findByText('解答题题干')).toBeTruthy();

    // 回到 q1：占位由切题回填重新出现在输入框里，学生继续往后写
    const back = screen.getByRole('textbox') as HTMLTextAreaElement;
    expect(back.value).toContain('上传中…');
    await user.type(back, '继续写');

    await act(async () => {
      uploadControl.resolve!({ fileId: 1, url: '/uploads/a/b.png' });
    });

    await waitFor(() => expect(back.value).toContain('![图1](/uploads/a/b.png)'));
    // 图片补丁必须落在占位处，学生之后打的字一个字都不能少
    expect(back.value).toContain('继续写');
    expect(back.value).not.toContain('上传中');
  });

  it('答案里残留「上传失败」标记时同样禁用提交（失败文本不能当答案交上去）', async () => {
    render(
      <QuestionRunner
        questions={[{ n: '1', text: '电路图题', type: 'short_answer' }]}
        answerInput="latex"
        initialAnswers={{ '1': '2. ［图1 上传失败］' }}
        {...imageRunnerProps}
      />,
    );
    await waitFor(() => expect(submitBtn().disabled).toBe(true));
    // 与「上传中」区分文案：学生该做的是删标记后重新粘贴，不是等
    expect(submitBtn().title).toBe('有图片上传失败，请删除标记后重新粘贴');
  });
});
