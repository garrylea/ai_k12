// 学生答案里的手绘图在结果页必须能看清（默认题面小图样式会压成 50px 细条）。
// 注意：本组件还会渲染题面/解析等多处 Markdown —— 用例里只放一张图（在学生答案里），
// 也不展开「查看解析」，否则 getByRole('img') 会命中多个。
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { AnswerResultList } from './AnswerResultList';

afterEach(() => cleanup());

describe('AnswerResultList 学生答案图片', () => {
  it('学生答案含图片：结果页按作答大图样式渲染', () => {
    render(
      <AnswerResultList
        questions={[{ n: '1', text: '电路图题' }]}
        answers={{ '1': { isCorrect: false, method: 'self_assess', studentAnswer: '2. ![图1](/uploads/a/b.png)' } }}
        onClose={() => {}}
      />,
    );
    const img = screen.getByRole('img');
    expect(img.getAttribute('src')).toBe('/uploads/a/b.png');
    expect(img.className).toContain('max-h-[40vh]');
    expect(img.className).not.toContain('h-[50px]');
  });

  it('题面图片仍按题面小图样式渲染（只改学生答案这一处）', () => {
    render(
      <AnswerResultList
        questions={[{ n: '1', text: '![题面图](/uploads/t/t.png)' }]}
        answers={{ '1': { isCorrect: true, method: 'exact', studentAnswer: 'A' } }}
        onClose={() => {}}
      />,
    );
    const img = screen.getByRole('img');
    expect(img.className).toContain('h-[50px]');
    expect(img.className).not.toContain('max-h-[40vh]');
  });
});

describe('AnswerResultList 材料排版', () => {
  it('材料块挂 md-prose，Markdown 标题按标题渲染、单换行分成自然段', () => {
    render(
      <AnswerResultList
        questions={[{ n: '1', text: '题一', material: '## 发言稿三\n①第一段。\n②第二段。' }]}
        answers={{ '1': { isCorrect: true, method: 'exact', studentAnswer: 'A' } }}
        onClose={() => {}}
      />,
    );
    const block = screen.getByTestId('result-material-text');
    expect(block.className).toContain('md-prose');
    expect(block.querySelector('h2')?.textContent).toBe('发言稿三');
    // 管线材料一行一段：单换行必须拆成两个 <p>，不能挤成一段
    const paragraphs = [...block.querySelectorAll('p')];
    expect(paragraphs.map((p) => p.textContent)).toEqual(['①第一段。', '②第二段。']);
  });
});

describe('AnswerResultList 题号', () => {
  it('每道题在状态图标左侧显示题号（2026-11-01 用户要求）', () => {
    render(
      <AnswerResultList
        questions={[{ n: '1', text: '题一' }, { n: '2', text: '题二' }]}
        answers={{
          '1': { isCorrect: true, method: 'exact', studentAnswer: 'A' },
          '2': { isCorrect: false, method: 'exact', studentAnswer: 'B' },
        }}
        onClose={() => {}}
      />,
    );
    expect(screen.getByTestId('result-qno-1')).toHaveTextContent('1');
    expect(screen.getByTestId('result-qno-2')).toHaveTextContent('2');
  });

  it('题号用原始 questionNo：前序题被 is_active=0 隐藏时，不从 1 重新编排', () => {
    // 复刻 session 50 / paper 361 的真实场景：第 1 题 is_active=0 被过滤，
    // 学生答题时 ExamRunPage 显示「第 2 题」…（原始题号）。结果页必须同样用
    // 原始题号，而不是按数组下标重编成 1/2/3。
    render(
      <AnswerResultList
        questions={[
          { n: '2', text: '题二' },
          { n: '3', text: '题三' },
          { n: '5', text: '题五（跳号）' },
        ]}
        answers={{
          '2': { isCorrect: true, method: 'exact', studentAnswer: 'A' },
          '3': { isCorrect: false, method: 'exact', studentAnswer: 'B' },
          '5': { isCorrect: true, method: 'exact', studentAnswer: 'C' },
        }}
        onClose={() => {}}
      />,
    );
    expect(screen.getByTestId('result-qno-2')).toHaveTextContent('2');
    expect(screen.getByTestId('result-qno-3')).toHaveTextContent('3');
    expect(screen.getByTestId('result-qno-5')).toHaveTextContent('5');
  });
});

describe('AnswerResultList 无参考答案（method=no_standard_answer）', () => {
  it('unscored 项显示「无参考答案 · 不计分」，无自评按钮，且不计入对/错/主观计数', () => {
    render(
      <AnswerResultList
        questions={[{ n: '1', text: '客观题' }, { n: '2', text: '无答案题' }]}
        answers={{
          '1': { isCorrect: true, method: 'exact', studentAnswer: 'A' },
          '2': { isCorrect: false, method: 'no_standard_answer', studentAnswer: '写了点东西', unscored: true },
        }}
        onClose={() => {}}
        onSelfAssess={async () => {}}
      />,
    );
    expect(screen.getByText('无参考答案 · 不计分')).toBeTruthy();
    // 顶部统计单列无参考答案题数
    expect(screen.getByText('无参考答案 1 题')).toBeTruthy();
    // 不计分：不渲染自评按钮，也不出「查看解析」的对错分支
    expect(screen.queryAllByRole('button', { name: /自评|做对|做错/ })).toHaveLength(0);
    // 计数：题面 2 道，只算 1 道答对，无错题/主观题
    expect(screen.getByText(/对\s*1/)).toBeTruthy();
    expect(screen.getByText(/错\s*0/)).toBeTruthy();
    expect(screen.queryByText(/主观\s*\d/)).toBeNull();
  });

  it('普通记录（不传 unscored）计数保持原样', () => {
    render(
      <AnswerResultList
        questions={[{ n: '1', text: '题一' }, { n: '2', text: '题二' }]}
        answers={{
          '1': { isCorrect: true, method: 'exact', studentAnswer: 'A' },
          '2': { isCorrect: false, method: 'exact', studentAnswer: 'B' },
        }}
        onClose={() => {}}
      />,
    );
    expect(screen.queryByText(/无参考答案/)).toBeNull();
    expect(screen.getByText(/对\s*1/)).toBeTruthy();
    expect(screen.getByText(/错\s*1/)).toBeTruthy();
  });
});

describe('AnswerResultList 导出入口', () => {
  it('传 onExport 时出现「导出 PDF」并可点击', async () => {
    const onExport = vi.fn();
    render(
      <AnswerResultList
        questions={[{ n: '1', text: '题面' }]}
        answers={{ '1': { isCorrect: true, method: 'exact', studentAnswer: 'A' } }}
        onClose={() => {}}
        onExport={onExport}
      />,
    );
    await userEvent.click(screen.getByRole('button', { name: '导出 PDF' }));
    expect(onExport).toHaveBeenCalledTimes(1);
  });

  it('不传 onExport 时不渲染「导出 PDF」', () => {
    render(
      <AnswerResultList
        questions={[{ n: '1', text: '题面' }]}
        answers={{ '1': { isCorrect: true, method: 'exact', studentAnswer: 'A' } }}
        onClose={() => {}}
      />,
    );
    expect(screen.queryByRole('button', { name: '导出 PDF' })).toBeNull();
  });
});
