import { describe, it, expect, vi } from 'vitest';
import { SubscriptionsService } from './subscriptions.service';

const DAY = 86_400_000;

const mkDeps = () => ({
  subsRepo: {
    findByParentId: vi.fn().mockResolvedValue(null),
    findByStudentId: vi.fn().mockResolvedValue(null),
    upsertTrial: vi.fn().mockResolvedValue(undefined),
    renewWithinTx: vi.fn().mockResolvedValue({ currentPeriodEnd: new Date('2026-10-30T00:00:00.000Z') }),
  },
  plansRepo: {
    listActive: vi.fn().mockResolvedValue([]),
  },
  usageRepo: {
    aggregateByDay: vi.fn().mockResolvedValue([]),
  },
});

const mkSvc = (d: ReturnType<typeof mkDeps>) =>
  new SubscriptionsService(d.subsRepo as any, d.plansRepo as any, d.usageRepo as any);

describe('SubscriptionsService.getStatusView', () => {
  it('学生视角：试用期内 -> trialing，daysRemaining=3，ISO 字符串序列化', async () => {
    const d = mkDeps();
    const trialEndsAt = new Date(Date.now() + 3 * DAY);
    d.subsRepo.findByStudentId.mockResolvedValue({
      trial_ends_at: trialEndsAt,
      current_period_end: null,
      plan_code: null,
    });
    const view = await mkSvc(d).getStatusView({ role: 'student', sub: 7 });
    expect(view).toEqual({
      status: 'trialing',
      planCode: null,
      trialEndsAt: trialEndsAt.toISOString(),
      currentPeriodEnd: null,
      daysRemaining: 3,
      source: 'trial',
    });
    expect(view.trialEndsAt).toBeTypeOf('string');
    expect(d.subsRepo.findByStudentId).toHaveBeenCalledWith(7);
    expect(d.subsRepo.findByParentId).not.toHaveBeenCalled();
  });

  it('家长视角走 findByParentId；付费期内 -> active + source=order + 按期剩余天数', async () => {
    const d = mkDeps();
    const currentPeriodEnd = new Date(Date.now() + 10 * DAY);
    d.subsRepo.findByParentId.mockResolvedValue({
      trial_ends_at: new Date(Date.now() - DAY),
      current_period_end: currentPeriodEnd,
      plan_code: 'month',
    });
    const view = await mkSvc(d).getStatusView({ role: 'parent', sub: 3 });
    expect(view.status).toBe('active');
    expect(view.source).toBe('order');
    expect(view.planCode).toBe('month');
    expect(view.daysRemaining).toBe(10);
    expect(view.currentPeriodEnd).toBe(currentPeriodEnd.toISOString());
    expect(d.subsRepo.findByParentId).toHaveBeenCalledWith(3);
    expect(d.subsRepo.findByStudentId).not.toHaveBeenCalled();
  });

  it('付费行（current_period_end 未来 + plan_code=month）-> {status:active, planCode:month}', async () => {
    const d = mkDeps();
    d.subsRepo.findByParentId.mockResolvedValue({
      trial_ends_at: null,
      current_period_end: new Date(Date.now() + 5 * DAY),
      plan_code: 'month',
    });
    const view = await mkSvc(d).getStatusView({ role: 'parent', sub: 3 });
    expect(view).toEqual({
      status: 'active',
      planCode: 'month',
      trialEndsAt: null,
      currentPeriodEnd: expect.any(String),
      daysRemaining: 5,
      source: 'order',
    });
  });

  it('admin 视角同样走 findByParentId', async () => {
    const d = mkDeps();
    const trialEndsAt = new Date(Date.now() + 5 * DAY);
    d.subsRepo.findByParentId.mockResolvedValue({
      trial_ends_at: trialEndsAt,
      current_period_end: null,
      plan_code: null,
    });
    const view = await mkSvc(d).getStatusView({ role: 'admin', sub: 1 });
    expect(view.status).toBe('trialing');
    expect(d.subsRepo.findByParentId).toHaveBeenCalledWith(1);
  });

  it('无订阅行 -> expired 空视图（null 字段 + daysRemaining=0）', async () => {
    const d = mkDeps();
    const view = await mkSvc(d).getStatusView({ role: 'parent', sub: 3 });
    expect(view).toEqual({
      status: 'expired',
      planCode: null,
      trialEndsAt: null,
      currentPeriodEnd: null,
      daysRemaining: 0,
      source: 'trial',
    });
  });

  it('试用已过期且无付费期 -> expired，daysRemaining=0', async () => {
    const d = mkDeps();
    d.subsRepo.findByStudentId.mockResolvedValue({
      trial_ends_at: new Date(Date.now() - 2 * DAY),
      current_period_end: null,
      plan_code: null,
    });
    const view = await mkSvc(d).getStatusView({ role: 'student', sub: 7 });
    expect(view.status).toBe('expired');
    expect(view.daysRemaining).toBe(0);
  });
});

describe('SubscriptionsService.ensureTrial', () => {
  it('调用 upsertTrial(parentId, now+7d)，允许 ±1 分钟误差', async () => {
    const d = mkDeps();
    await mkSvc(d).ensureTrial(9);
    expect(d.subsRepo.upsertTrial).toHaveBeenCalledTimes(1);
    const [parentId, trialEndsAt] = d.subsRepo.upsertTrial.mock.calls[0];
    expect(parentId).toBe(9);
    const expected = Date.now() + 7 * DAY;
    expect(Math.abs((trialEndsAt as Date).getTime() - expected)).toBeLessThan(60_000);
  });

  it('upsertTrial 抛错时向外传播（注册必须可见地失败）', async () => {
    const d = mkDeps();
    d.subsRepo.upsertTrial.mockRejectedValue(new Error('db down'));
    await expect(mkSvc(d).ensureTrial(9)).rejects.toThrow('db down');
  });
});

describe('SubscriptionsService.renewWithinTx', () => {
  it('透传 repo：conn/parentId/planCode/durationDays 原样，now 由 service 注入', async () => {
    const d = mkDeps();
    const conn = {} as any;
    const result = await mkSvc(d).renewWithinTx(conn, 3, 'year', 365);
    expect(d.subsRepo.renewWithinTx).toHaveBeenCalledWith(conn, 3, 'year', 365, expect.any(Date));
    expect(result).toEqual({ currentPeriodEnd: new Date('2026-10-30T00:00:00.000Z') });
  });
});

describe('SubscriptionsService.listPlans', () => {
  it('snake_case → camelCase 映射透传（is_active 过滤在 repo 侧，service 不再筛）', async () => {
    const d = mkDeps();
    d.plansRepo.listActive.mockResolvedValue([
      { id: 1, plan_code: 'month', name: '月度会员', price_cents: 19800, duration_days: 30 },
      { id: 2, plan_code: 'year', name: '年度会员', price_cents: 198000, duration_days: 365 },
    ]);
    await expect(mkSvc(d).listPlans()).resolves.toEqual([
      { planCode: 'month', name: '月度会员', priceCents: 19800, durationDays: 30 },
      { planCode: 'year', name: '年度会员', priceCents: 198000, durationDays: 365 },
    ]);
  });

  it('repo 回空数组（无在售套餐）→ 空数组', async () => {
    const d = mkDeps();
    await expect(mkSvc(d).listPlans()).resolves.toEqual([]);
  });
});

describe('SubscriptionsService.getUsageView', () => {
  it('有付费期：periodEnd=currentPeriodEnd、periodStart=periodEnd-30d（rolling），聚合 totals + byDay 形状', async () => {
    const d = mkDeps();
    const periodEnd = new Date('2026-10-30T00:00:00.000Z');
    d.subsRepo.findByParentId.mockResolvedValue({
      trial_ends_at: null,
      current_period_end: periodEnd,
      plan_code: 'month',
    });
    d.usageRepo.aggregateByDay.mockResolvedValue([
      { day: '2026-10-01', calls: 3, input_tokens: 100, output_tokens: 200, tokens_unknown: 0 },
      { day: '2026-10-02', calls: 2, input_tokens: 50, output_tokens: null, tokens_unknown: 1 },
    ]);

    const view = await mkSvc(d).getUsageView(7);

    expect(view.periodEnd).toBe(periodEnd.toISOString());
    expect(view.periodStart).toBe(new Date(periodEnd.getTime() - 30 * 86_400_000).toISOString());
    expect(view.calls).toBe(5);
    expect(view.inputTokens).toBe(150);
    expect(view.outputTokens).toBe(200); // 单日 output NULL 按 0 参与求和
    expect(view.tokensUnknown).toBe(1); // 独立计数，不被归零吞掉
    expect(view.byDay).toEqual([
      { date: '2026-10-01', calls: 3, tokens: 300 },
      { date: '2026-10-02', calls: 2, tokens: 50 },
    ]);
    expect(d.usageRepo.aggregateByDay).toHaveBeenCalledWith(
      7,
      new Date(periodEnd.getTime() - 30 * 86_400_000),
      periodEnd,
    );
  });

  it('无订阅行：periodEnd=now（±1 分钟兜底误差），空窗口 → 全零 + byDay 只回有数据日（不补空日）', async () => {
    const d = mkDeps();
    d.subsRepo.findByParentId.mockResolvedValue(null);
    d.usageRepo.aggregateByDay.mockResolvedValue([]);

    const view = await mkSvc(d).getUsageView(7);

    const now = Date.now();
    expect(Math.abs(new Date(view.periodEnd).getTime() - now)).toBeLessThan(60_000);
    expect(Math.abs(new Date(view.periodStart).getTime() - (now - 30 * 86_400_000))).toBeLessThan(60_000);
    expect(view).toMatchObject({ calls: 0, inputTokens: 0, outputTokens: 0, tokensUnknown: 0, byDay: [] });
    expect(d.usageRepo.aggregateByDay).toHaveBeenCalledWith(7, expect.any(Date), expect.any(Date));
  });

  it('整月全 NULL（量不到）：单日 SUM 回 null → tokens 按 0 求和，tokensUnknown 计满', async () => {
    const d = mkDeps();
    d.subsRepo.findByParentId.mockResolvedValue({
      trial_ends_at: null,
      current_period_end: new Date('2026-10-30T00:00:00.000Z'),
      plan_code: 'month',
    });
    d.usageRepo.aggregateByDay.mockResolvedValue([
      { day: '2026-10-01', calls: 4, input_tokens: null, output_tokens: null, tokens_unknown: 4 },
    ]);

    const view = await mkSvc(d).getUsageView(7);

    expect(view.calls).toBe(4);
    expect(view.inputTokens).toBe(0);
    expect(view.outputTokens).toBe(0);
    expect(view.tokensUnknown).toBe(4);
    expect(view.byDay).toEqual([{ date: '2026-10-01', calls: 4, tokens: 0 }]);
  });

  it('mysql2 把 BIGINT SUM 回成 string 时按 Number 归一，不吃成字符串拼接', async () => {
    const d = mkDeps();
    d.subsRepo.findByParentId.mockResolvedValue({
      trial_ends_at: null,
      current_period_end: new Date('2026-10-30T00:00:00.000Z'),
      plan_code: 'month',
    });
    d.usageRepo.aggregateByDay.mockResolvedValue([
      { day: '2026-10-01', calls: '2', input_tokens: '10', output_tokens: '20', tokens_unknown: '0' },
      { day: '2026-10-02', calls: '1', input_tokens: '5', output_tokens: '5', tokens_unknown: '0' },
    ]);

    const view = await mkSvc(d).getUsageView(7);

    expect(view.calls).toBe(3);
    expect(view.inputTokens).toBe(15);
    expect(view.outputTokens).toBe(25);
    expect(view.tokensUnknown).toBe(0);
  });
});
