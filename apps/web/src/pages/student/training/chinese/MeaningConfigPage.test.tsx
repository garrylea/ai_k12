import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { render, screen, cleanup, act, fireEvent } from '@testing-library/react';
import { createMemoryRouter, RouterProvider } from 'react-router-dom';
import MeaningConfigPage from '@/pages/student/training/chinese/MeaningConfigPage';
import { fetchMeaningPassages } from '@/services/api';

// globals: false —— @testing-library/react 不会自动注册 cleanup，必须自己写
afterEach(() => cleanup());

vi.mock('@/services/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/services/api')>();
  return { ...actual, fetchMeaningPassages: vi.fn() };
});

const fetchMock = vi.mocked(fetchMeaningPassages);

const PASSAGES = [
  { passageId: 1, workTitle: '行路难', semester: '上册' },
  { passageId: 2, workTitle: '酬乐天扬州初逢席上见赠', semester: '下册' },
];

describe('MeaningConfigPage', () => {
  beforeEach(() => {
    fetchMock.mockReset();
    fetchMock.mockResolvedValue({ passages: PASSAGES });
  });

  /** 篇目在 useEffect 里异步拉取 —— render 必须包在 act 里等它落地，否则 setState 会报警告。 */
  const renderPage = async () => {
    const router = createMemoryRouter([{ path: '/', element: <MeaningConfigPage /> }], {
      initialEntries: ['/'],
    });
    let result!: ReturnType<typeof render>;
    await act(async () => { result = render(<RouterProvider router={router} />); });
    return result;
  };

  it('渲染三档范围、1/2/3 篇数与开始按钮', async () => {
    await renderPage();
    for (const label of ['全部', '上册', '下册']) {
      expect(screen.getByRole('button', { name: label })).toBeTruthy();
    }
    for (const label of ['1 首', '2 首', '3 首']) {
      expect(screen.getByRole('button', { name: label })).toBeTruthy();
    }
    expect(screen.getByRole('button', { name: /开始练习（随机 1 首）/ })).toBeTruthy();
    expect(screen.getByRole('heading', { name: '古诗含义' })).toBeTruthy();
  });

  it('展开「指定篇目」后渲染拉取到的篇目标题', async () => {
    await renderPage();
    expect(screen.queryByText(/《行路难》/)).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: /指定篇目/ }));
    expect(screen.getByText(/《行路难》/)).toBeTruthy();
    expect(screen.getByText(/《酬乐天扬州初逢席上见赠》/)).toBeTruthy();
  });
});
