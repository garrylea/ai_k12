import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import { createMemoryRouter, RouterProvider } from 'react-router-dom';
import MeaningRunPage from '@/pages/student/training/chinese/MeaningRunPage';

// globals: false —— @testing-library/react 不会自动注册 cleanup，必须自己写
afterEach(() => cleanup());

const PASSAGE = {
  passageId: 12,
  workTitle: '酬乐天扬州初逢席上见赠',
  semester: '上册',
  sentences: [
    { index: 0, text: '巴山楚水凄凉地', terms: [], answerable: true },
    { index: 1, text: '二十三年弃置身', terms: [], answerable: false },  // 不该被渲染成作答句
    { index: 2, text: '沉舟侧畔千帆过', terms: [{ term: '沉舟', plain: '沉船' }], answerable: true },
  ],
};

beforeEach(() => {
  sessionStorage.setItem('training:meaning', JSON.stringify([PASSAGE]));
});

/** RunExitGuard 用 useBlocker —— 必须是 data router（createMemoryRouter），不能用 MemoryRouter。 */
const renderPage = () => {
  const router = createMemoryRouter([{ path: '/', element: <MeaningRunPage /> }], {
    initialEntries: ['/'],
  });
  return render(<RouterProvider router={router} />);
};

describe('MeaningRunPage', () => {
  it('一次只渲染当前句；answerable:false 的句子不进作答区（但原文条里有）', () => {
    renderPage();
    expect(screen.getByRole('heading', { name: '古诗含义' })).toBeTruthy();
    // 第 1 句是当前句 → 它的原文出现在作答区；「二十三年弃置身」只在全诗原文条里
    expect(screen.getByText('本句深层含义')).toBeTruthy();
    expect(screen.getByRole('textbox', { name: '本句深层含义' })).toBeTruthy();
    // 可作答句只有 2 句（index 1 的 answerable:false 不计数）
    expect(screen.getByText(/第 1 \/ 2 句/)).toBeTruthy();
  });
});
