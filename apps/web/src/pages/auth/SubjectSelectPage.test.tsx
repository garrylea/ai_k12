import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import SubjectSelectPage from './SubjectSelectPage';
import { getMyPoints } from '@/services/api';

/**
 * 学科图标回归：语/数/英三卡原先共用一枚书本图标（2026-11-08 起改为按学科区分）。
 */

vi.mock('@/services/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/services/api')>();
  return { ...actual, fetchSubjects: vi.fn().mockResolvedValue([]), getMyPoints: vi.fn() };
});

const getMyPointsMock = vi.mocked(getMyPoints);

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

beforeEach(() => {
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addEventListener: () => {},
    removeEventListener: () => {},
    addListener: () => {},
    removeListener: () => {},
    dispatchEvent: () => false,
  }));
  getMyPointsMock.mockResolvedValue({
    balance: 0,
    totalEarned: 0,
    todayEarned: 0,
    level: { code: 'pichai', name: '劈柴', index: 0, threshold: 0 },
    nextLevel: { code: 'zhutie', name: '铸铁', index: 1, threshold: 500 },
    pointsToNextLevel: 500,
    progressPercent: 0,
  });
});

function renderPage() {
  return render(
    <MemoryRouter initialEntries={['/student/subjects']}>
      <Routes>
        <Route path="/student/subjects" element={<SubjectSelectPage />} />
      </Routes>
    </MemoryRouter>,
  );
}

describe('SubjectSelectPage 学科图标', () => {
  it('语/数/英三张卡用三种不同的学科图标', () => {
    const { container } = renderPage();
    const icons = Array.from(container.querySelectorAll('[data-subject-icon]')).map((el) =>
      el.getAttribute('data-subject-icon'),
    );

    expect(icons).toHaveLength(3);
    expect(new Set(icons)).toEqual(new Set(['chinese', 'math', 'english']));
  });
});
