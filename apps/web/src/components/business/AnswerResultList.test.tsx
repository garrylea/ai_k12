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
