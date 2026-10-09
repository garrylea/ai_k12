import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { AnalyticsPageShell, EVENT_LABELS, FUNNEL_MODULES, eventLabel, fmtDuration, fmtPct } from './shared';

afterEach(() => cleanup());

describe('AnalyticsPageShell', () => {
  it('渲染 8 个 tab 与日期输入', () => {
    render(
      <MemoryRouter>
        <AnalyticsPageShell
          title="总览"
          description=""
          window={{ from: '2026-10-03', to: '2026-10-09' }}
          onWindowChange={() => {}}
        >
          <div>body</div>
        </AnalyticsPageShell>
      </MemoryRouter>,
    );
    expect(screen.getAllByRole('link')).toHaveLength(8);
    expect(screen.getByLabelText('开始日期')).toBeTruthy();
    expect(screen.getByLabelText('结束日期')).toBeTruthy();
    expect(screen.getByTestId('date-range')).toBeTruthy();
  });

  it('日期输入回显 window 值，children 正常渲染', () => {
    render(
      <MemoryRouter>
        <AnalyticsPageShell
          title="总览"
          description="描述"
          window={{ from: '2026-10-03', to: '2026-10-09' }}
          onWindowChange={() => {}}
        >
          <div>body</div>
        </AnalyticsPageShell>
      </MemoryRouter>,
    );
    expect((screen.getByLabelText('开始日期') as HTMLInputElement).value).toBe('2026-10-03');
    expect((screen.getByLabelText('结束日期') as HTMLInputElement).value).toBe('2026-10-09');
    expect(screen.getByText('body')).toBeTruthy();
  });
});

describe('格式化', () => {
  it('fmtPct：null → —，数值按百分比四舍五入', () => {
    expect(fmtPct(null)).toBe('—');
    expect(fmtPct(0)).toBe('0%');
    expect(fmtPct(0.426)).toBe('43%');
    expect(fmtPct(1)).toBe('100%');
  });

  it('fmtDuration：null → —，秒/分/时分段', () => {
    expect(fmtDuration(null)).toBe('—');
    expect(fmtDuration(45)).toBe('45 秒');
    expect(fmtDuration(125)).toBe('2 分');
    expect(fmtDuration(7265)).toBe('2 小时 1 分');
  });

  // T14 评审裁定①：3599s 用 round 会进位成 '0 小时 60 分'，必须 floor
  it('fmtDuration：3599 → 59 分（不显示 0 小时 60 分）', () => {
    expect(fmtDuration(3599)).toBe('59 分');
    expect(fmtDuration(3600)).toBe('1 小时 0 分');
  });

  it('EVENT_LABELS：17 事件 + 8 模块，字典外 key 原样返回', () => {
    const moduleKeys = new Set<string>(FUNNEL_MODULES);
    const eventKeys = Object.keys(EVENT_LABELS).filter((k) => !moduleKeys.has(k));
    expect(eventKeys).toHaveLength(17);
    expect(FUNNEL_MODULES).toHaveLength(8);
    expect(eventLabel('mainline')).toBe('主线');
    expect(eventLabel('study_session_started')).toBe('进入学习');
    expect(eventLabel('unknown_event')).toBe('unknown_event');
  });
});
