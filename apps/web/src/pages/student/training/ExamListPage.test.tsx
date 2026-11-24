import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import ExamListPage from './ExamListPage';
import { getExamPapers } from '@/services/api';
import { getTrainingSubject } from '@/constants';

/**
 * 考试列表页标题按学科配置渲染（不写学科分支）。
 * 英语/语文走 `getTrainingSubject().examListTitle`，防止新增学科时标题回落成「考试」。
 */

vi.mock('@/services/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/services/api')>();
  return { ...actual, getExamPapers: vi.fn() };
});

const getExamPapersMock = vi.mocked(getExamPapers);

beforeEach(() => {
  getExamPapersMock.mockReset();
  getExamPapersMock.mockResolvedValue([]);
});

afterEach(() => cleanup());

function renderAt(subjectId: number) {
  return render(
    <MemoryRouter initialEntries={[`/student/training/exam?subjectId=${subjectId}`]}>
      <ExamListPage />
    </MemoryRouter>,
  );
}

describe('ExamListPage 标题读配置', () => {
  it.each([
    [3, '英语 · 真题'],
    [2, '语文 · 真题'],
  ])('subjectId=%i 显示「%s」', async (subjectId, title) => {
    renderAt(subjectId);
    expect(getTrainingSubject(subjectId)?.examListTitle).toBe(title);
    expect(await screen.findByText(title)).toBeInTheDocument();
    expect(screen.queryByText('考试')).toBeNull();
  });

  it('请求带上了对应 subjectId', async () => {
    renderAt(3);
    expect(getExamPapersMock).toHaveBeenCalledWith(
      expect.objectContaining({ subjectId: 3 }),
    );
  });
});
