import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { ParentNav } from './ParentNav';
import { useThemeStore } from '@/store/themeStore';

afterEach(() => {
  cleanup();
  useThemeStore.setState({ mode: 'student-day' });
});

/**
 * 侧栏在 `<lg`（<1024px）时收成 64px 图标栏、标签被 `hidden lg:inline` 隐藏。
 * 2026-09-20 用户实际走查时**因此在家长端找不到「目标设定」**——那一栏当时是 10 行空白。
 * 这条用例钉住「每个导航项都必须带线性 SVG 图标 + 可辨识的名字」，
 * 防止以后新增项时又只写文字标签。
 */
describe('ParentNav', () => {
  it('11 个入口每个都有线性 SVG 图标与可访问名字（窄屏收成图标栏时仍可辨识）', () => {
    render(
      <MemoryRouter>
        <ParentNav />
      </MemoryRouter>,
    );

    const expected: ReadonlyArray<[string, string]> = [
      ['/parent/messages', '消息'],
      ['/parent/students', '学生账号'],
      ['/parent/dashboard', '仪表盘'],
      ['/parent/report', '学情报告'],
      ['/parent/errors', '错题查看'],
      ['/parent/chat-logs', 'AI 对话回放'],
      ['/parent/alerts', '异常预警'],
      ['/parent/goals', '目标设定'],
      ['/parent/controls', '行为管控'],
      ['/parent/rewards', '奖励管理'],
      ['/parent/account', '账号设置'],
    ];

    for (const [href, label] of expected) {
      const link = screen.getByRole('link', { name: label });
      expect(link).toHaveAttribute('href', href);
      // 悬停提示：窄屏只有图标时，title 是唯一的文字线索
      expect(link).toHaveAttribute('title', label);
      // 图标：必须是 svg（线性 SVG 由 style.md 规定；emoji 一律不许）。
      // 用 querySelector 而不是 getByRole('img')：`aria-hidden` 的裸 <svg> 没有 img 角色。
      const svg = link.querySelector('svg');
      expect(svg).not.toBeNull();
      expect(svg).toHaveAttribute('aria-hidden', 'true');
      // 线性（不填充）+ stroke 继承文字色，保证浅色/深色底都可见
      expect(svg).toHaveAttribute('fill', 'none');
      expect(svg).toHaveAttribute('stroke', 'currentColor');
    }
  });

  it('没有 emoji（style.md 硬规则）', () => {
    render(
      <MemoryRouter>
        <ParentNav />
      </MemoryRouter>,
    );
    // 只查侧栏本身，避免误伤页面里别处的内容
    const nav = screen.getByRole('navigation');
    expect(/\p{Extended_Pictographic}/u.test(nav.textContent ?? '')).toBe(false);
  });
});
