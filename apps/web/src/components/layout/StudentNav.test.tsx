import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { StudentNav } from './StudentNav';

afterEach(() => {
  cleanup();
});

/**
 * 与 `ParentNav.test.tsx` 同一条理由：学生端侧栏在 `<lg`（<1024px）也收成 64px 图标栏、
 * 标签被 `hidden lg:inline` 隐藏，而**补图标之前那一栏是 4 行空白**。
 * 这条用例钉住「每个导航项都必须带线性 SVG 图标 + 可辨识的名字」。
 */
describe('StudentNav', () => {
  it('4 个入口每个都有线性 SVG 图标与可访问名字（窄屏收成图标栏时仍可辨识）', () => {
    render(
      <MemoryRouter>
        <StudentNav />
      </MemoryRouter>,
    );

    const expected: ReadonlyArray<[string, string]> = [
      ['/student/star-map', '星图导航'],
      ['/student/error-book', '错题本'],
      ['/student/rewards', '奖励册'],
      ['/student/profile', '个人中心'],
    ];

    for (const [href, label] of expected) {
      const link = screen.getByRole('link', { name: label });
      expect(link).toHaveAttribute('href', href);
      expect(link).toHaveAttribute('title', label);
      const svg = link.querySelector('svg');
      expect(svg).not.toBeNull();
      expect(svg).toHaveAttribute('aria-hidden', 'true');
      expect(svg).toHaveAttribute('fill', 'none');
      expect(svg).toHaveAttribute('stroke', 'currentColor');
    }
  });

  it('没有 emoji（style.md 硬规则）', () => {
    render(
      <MemoryRouter>
        <StudentNav />
      </MemoryRouter>,
    );
    const nav = screen.getByRole('navigation');
    expect(/\p{Extended_Pictographic}/u.test(nav.textContent ?? '')).toBe(false);
  });
});
