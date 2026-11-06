import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { createMemoryRouter, RouterProvider } from 'react-router-dom';
import TrainingSubjectPage from './TrainingSubjectPage';

afterEach(() => cleanup());

function renderPage() {
  const router = createMemoryRouter(
    [
      { path: '/student/training', element: <TrainingSubjectPage /> },
      { path: '/student/training/home', element: <div>四卡页</div> },
      { path: '/student/training/chinese/special', element: <div>语文专项页</div> },
      { path: '/student/training/english/vocabulary', element: <div>背单词页</div> },
    ],
    { initialEntries: ['/student/training'] },
  );
  return { router, ...render(<RouterProvider router={router} />) };
}

describe('TrainingSubjectPage', () => {
  it('渲染六个学科', () => {
    renderPage();
    for (const name of ['数学', '语文', '英语', '物理', '化学', '道德与法治']) {
      expect(screen.getByText(name)).toBeTruthy();
    }
  });

  it('道法卡已开放，点击进入四卡页并带 subjectId=9', () => {
    const { router } = renderPage();
    expect(screen.queryByText('内容准备中')).toBeNull();
    fireEvent.click(screen.getByLabelText('选择道德与法治训练'));
    expect(router.state.location.pathname).toBe('/student/training/home');
    expect(router.state.location.search).toBe('?subjectId=9');
  });

  it('点物理进入四卡页并带 subjectId=4', async () => {
    const { router } = renderPage();
    fireEvent.click(screen.getByLabelText('选择物理训练'));
    expect(router.state.location.pathname).toBe('/student/training/home');
    expect(router.state.location.search).toBe('?subjectId=4');
  });
});
