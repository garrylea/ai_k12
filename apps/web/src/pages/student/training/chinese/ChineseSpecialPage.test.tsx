import { describe, it, expect, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import ChineseSpecialPage from '@/pages/student/training/chinese/ChineseSpecialPage';

// globals: false —— @testing-library/react 不会自动注册 cleanup，必须自己写
afterEach(() => cleanup());

/** 六张卡都是静态的（无网络请求），只要 Router 上下文供 navigate 用即可。 */
describe('ChineseSpecialPage', () => {
  it('六张卡都在：三个古诗文专项 + 真题考试 / 专项练习 / 错题练习', () => {
    render(
      <MemoryRouter>
        <ChineseSpecialPage />
      </MemoryRouter>,
    );
    expect(screen.getByRole('button', { name: '进入古诗文默写' })).toBeTruthy();
    expect(screen.getByRole('button', { name: '进入古诗文解释' })).toBeTruthy();
    expect(screen.getByRole('button', { name: '进入古诗含义' })).toBeTruthy();
    expect(screen.getByRole('button', { name: '进入语文真题考试' })).toBeTruthy();
    expect(screen.getByRole('button', { name: '进入语文专项练习' })).toBeTruthy();
    expect(screen.getByRole('button', { name: '进入语文错题练习' })).toBeTruthy();
    expect(screen.getByText('真题考试')).toBeTruthy();
    expect(screen.getByText('专项练习')).toBeTruthy();
    expect(screen.getByText('错题练习')).toBeTruthy();
    expect(screen.getByText('深层含义 · 作者情感')).toBeTruthy();
  });

  it('标题改为「语文 · 训练」', () => {
    render(
      <MemoryRouter>
        <ChineseSpecialPage />
      </MemoryRouter>,
    );
    expect(screen.getByText('语文 · 训练')).toBeTruthy();
  });
});
