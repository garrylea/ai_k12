// 物理/化学走 enabled=false 分支（直接返回 LatexPreview），数学走 tab 分支，
// 两条路都必须把作答大图样式透传下去——漏一条就会出现"物理题里图被压成 50px"。
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { PreviewDraftPanel } from './PreviewDraftPanel';
import { ANSWER_IMG_CLASS } from '@/components/markdown';

afterEach(() => cleanup());

const ANSWER = '![图1](/uploads/a/b.png)';

describe('PreviewDraftPanel 图片样式透传', () => {
  it('enabled=false（物理/化学）：大图样式生效', () => {
    render(<PreviewDraftPanel answer={ANSWER} questionId="q1" enabled={false} imgClassName={ANSWER_IMG_CLASS} />);
    expect(screen.getByRole('img').className).toContain('max-h-[40vh]');
  });

  it('enabled=true（数学）：默认 tab 是预览，大图样式同样生效', () => {
    render(<PreviewDraftPanel answer={ANSWER} questionId="q1" enabled imgClassName={ANSWER_IMG_CLASS} />);
    expect(screen.getByRole('img').className).toContain('max-h-[40vh]');
  });
});
