// 学生答案里的手绘图在结果页必须能看清（默认题面小图样式会压成 50px 细条）。
// 注意：本组件还会渲染题面/解析等多处 Markdown —— 用例里只放一张图（在学生答案里），
// 也不展开「查看解析」，否则 getByRole('img') 会命中多个。
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
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
