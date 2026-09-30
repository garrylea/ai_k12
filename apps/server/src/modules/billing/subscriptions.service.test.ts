import { describe, it, expect, vi } from 'vitest';
import { SubscriptionsService } from './subscriptions.service';

const DAY = 86_400_000;

const mkDeps = () => ({
  subsRepo: {
    findByParentId: vi.fn().mockResolvedValue(null),
    findByStudentId: vi.fn().mockResolvedValue(null),
    upsertTrial: vi.fn().mockResolvedValue(undefined),
    renewWithinTx: vi.fn().mockResolvedValue({ currentPeriodEnd: new Date('2026-10-30T00:00:00.000Z') }),
    setTrialWithinTx: vi.fn().mockResolvedValue(undefined),
    adjustPeriodWithinTx: vi.fn().mockResolvedValue({ currentPeriodEnd: new Date('2026-10-30T00:00:00.000Z') }),
    parentExists: vi.fn().mockResolvedValue(true),
    listFamilies: vi.fn().mockResolvedValue({ total: 0, rows: [] }),
  },
  plansRepo: {
    listActive: vi.fn().mockResolvedValue([]),
  },
  usageRepo: {
    aggregateByDay: vi.fn().mockResolvedValue([]),
  },
  adjustmentsRepo: {
    insert: vi.fn().mockResolvedValue(undefined),
  },
  pool: {
    getConnection: vi.fn().mockResolvedValue({
      beginTransaction: vi.fn(),
      commit: vi.fn(),
      rollback: vi.fn(),
      release: vi.fn(),
    }),
  },
});

const mkSvc = (d: ReturnType<typeof mkDeps>) =>
  new SubscriptionsService(
    d.subsRepo as any,
    d.plansRepo as any,
    d.usageRepo as any,
    d.adjustmentsRepo as any,
    d.pool as any,
  );

/** 取 pool mock 最后一次 getConnection 的 conn mock（mockResolvedValue 存的是 Promise，需 await）。 */
const lastConn = async (d: ReturnType<typeof mkDeps>) =>
  (await d.pool.getConnection.mock.results.at(-1)!.value) as {
    beginTransaction: ReturnType<typeof vi.fn>;
    commit: ReturnType<typeof vi.fn>;
    rollback: ReturnType<typeof vi.fn>;
    release: ReturnType<typeof vi.fn>;
  };

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

// ---------- 批④ Task 5：管理端试用 / 订阅天数管理 ----------

describe('SubscriptionsService.adminSetTrial', () => {
  it('合法 ISO：开事务 → setTrialWithinTx(conn, …) → adjustments 落一行(trial_set) → commit → 返回新 StatusView', async () => {
    const d = mkDeps();
    const trialEndsAt = new Date('2026-12-31T00:00:00.000Z');
    d.subsRepo.findByParentId.mockResolvedValue({
      trial_ends_at: trialEndsAt,
      current_period_end: null,
      plan_code: null,
    });

    const view = await mkSvc(d).adminSetTrial(3, '2026-12-31T00:00:00.000Z', 42);

    const conn = await lastConn(d);
    expect(conn.beginTransaction).toHaveBeenCalledTimes(1);
    expect(d.subsRepo.setTrialWithinTx).toHaveBeenCalledWith(conn, 3, trialEndsAt, expect.any(Date));
    expect(d.adjustmentsRepo.insert).toHaveBeenCalledTimes(1);
    expect(d.adjustmentsRepo.insert).toHaveBeenCalledWith(
      { parentId: 3, adminId: 42, type: 'trial_set', trialEndsAt, deltaDays: null, reason: null },
      conn,
    );
    expect(conn.commit).toHaveBeenCalledTimes(1);
    expect(conn.release).toHaveBeenCalledTimes(1);
    expect(view.status).toBe('trialing'); // StatusView 来自写后新读（findByParentId 已 mock 成新值）
    expect(view.trialEndsAt).toBe(trialEndsAt.toISOString());
  });

  it('trialEndsAt=null（收回）：透传 null，adjustments 的 trialEndsAt 也是 null', async () => {
    const d = mkDeps();
    await mkSvc(d).adminSetTrial(3, null, 42);

    const conn = await lastConn(d);
    expect(d.subsRepo.setTrialWithinTx).toHaveBeenCalledWith(conn, 3, null, expect.any(Date));
    expect(d.adjustmentsRepo.insert).toHaveBeenCalledWith(
      { parentId: 3, adminId: 42, type: 'trial_set', trialEndsAt: null, deltaDays: null, reason: null },
      conn,
    );
  });

  it('非法 ISO → 400/1001；不开事务、不落痕', async () => {
    const d = mkDeps();
    await expect(mkSvc(d).adminSetTrial(3, 'not-a-date', 42)).rejects.toMatchObject({
      response: { code: 1001 },
    });
    expect(d.pool.getConnection).not.toHaveBeenCalled();
    expect(d.adjustmentsRepo.insert).not.toHaveBeenCalled();
  });

  it('家长不存在 → 404/1005；不落痕', async () => {
    const d = mkDeps();
    d.subsRepo.parentExists.mockResolvedValue(false);
    await expect(mkSvc(d).adminSetTrial(3, '2026-12-31T00:00:00.000Z', 42)).rejects.toMatchObject({
      response: { code: 1005 },
    });
    expect(d.pool.getConnection).not.toHaveBeenCalled();
    expect(d.adjustmentsRepo.insert).not.toHaveBeenCalled();
  });

  it('repo 抛错 → rollback + 向外抛（审计与写同生共死）', async () => {
    const d = mkDeps();
    d.subsRepo.setTrialWithinTx.mockRejectedValue(new Error('db down'));
    await expect(mkSvc(d).adminSetTrial(3, '2026-12-31T00:00:00.000Z', 42)).rejects.toThrow('db down');

    const conn = await lastConn(d);
    expect(conn.rollback).toHaveBeenCalledTimes(1);
    expect(d.adjustmentsRepo.insert).not.toHaveBeenCalled();
  });
});

describe('SubscriptionsService.adminGrantDays', () => {
  it('正数：adjustPeriodWithinTx(conn, …, 30) → adjustments 落一行(grant_days) → 返回新 StatusView', async () => {
    const d = mkDeps();
    const periodEnd = new Date('2026-10-30T00:00:00.000Z');
    d.subsRepo.findByParentId.mockResolvedValue({
      trial_ends_at: null,
      current_period_end: periodEnd,
      plan_code: 'month',
    });

    const view = await mkSvc(d).adminGrantDays(3, 30, '客诉补偿', 42);

    const conn = await lastConn(d);
    expect(d.subsRepo.adjustPeriodWithinTx).toHaveBeenCalledWith(conn, 3, 30, expect.any(Date));
    expect(d.adjustmentsRepo.insert).toHaveBeenCalledTimes(1);
    expect(d.adjustmentsRepo.insert).toHaveBeenCalledWith(
      { parentId: 3, adminId: 42, type: 'grant_days', trialEndsAt: null, deltaDays: 30, reason: '客诉补偿' },
      conn,
    );
    expect(conn.commit).toHaveBeenCalledTimes(1);
    expect(view.status).toBe('active');
  });

  it('负数透传（扣减方向由 repo 决定）；reason 缺省落 null', async () => {
    const d = mkDeps();
    await mkSvc(d).adminGrantDays(3, -5, undefined, 42);

    expect(d.subsRepo.adjustPeriodWithinTx).toHaveBeenCalledWith(expect.anything(), 3, -5, expect.any(Date));
    expect(d.adjustmentsRepo.insert).toHaveBeenCalledWith(
      { parentId: 3, adminId: 42, type: 'grant_days', trialEndsAt: null, deltaDays: -5, reason: null },
      expect.anything(),
    );
  });

  it('days=0 → 400/1001；非整数 → 400/1001；不开事务不落痕', async () => {
    const d = mkDeps();
    for (const bad of [0, 1.5, '30' as unknown as number]) {
      await expect(mkSvc(d).adminGrantDays(3, bad, undefined, 42)).rejects.toMatchObject({
        response: { code: 1001 },
      });
    }
    expect(d.pool.getConnection).not.toHaveBeenCalled();
    expect(d.adjustmentsRepo.insert).not.toHaveBeenCalled();
  });

  it('reason 超 200 字 → 400/1001', async () => {
    const d = mkDeps();
    await expect(mkSvc(d).adminGrantDays(3, 30, 'x'.repeat(201), 42)).rejects.toMatchObject({
      response: { code: 1001 },
    });
    expect(d.adjustmentsRepo.insert).not.toHaveBeenCalled();
  });

  it('家长不存在 → 404/1005', async () => {
    const d = mkDeps();
    d.subsRepo.parentExists.mockResolvedValue(false);
    await expect(mkSvc(d).adminGrantDays(3, 30, undefined, 42)).rejects.toMatchObject({
      response: { code: 1005 },
    });
    expect(d.adjustmentsRepo.insert).not.toHaveBeenCalled();
  });

  it('repo 抛错 → rollback + 向外抛', async () => {
    const d = mkDeps();
    d.subsRepo.adjustPeriodWithinTx.mockRejectedValue(new Error('db down'));
    await expect(mkSvc(d).adminGrantDays(3, 30, undefined, 42)).rejects.toThrow('db down');
    const conn = await lastConn(d);
    expect(conn.rollback).toHaveBeenCalledTimes(1);
  });
});

describe('SubscriptionsService.listFamilies', () => {
  it('分页越界 → 400/1001（不钳制，仓规）', async () => {
    const d = mkDeps();
    await expect(mkSvc(d).listFamilies(undefined, 0, 20)).rejects.toMatchObject({ response: { code: 1001 } });
    await expect(mkSvc(d).listFamilies(undefined, 1, 51)).rejects.toMatchObject({ response: { code: 1001 } });
    expect(d.subsRepo.listFamilies).not.toHaveBeenCalled();
  });

  it('keyword 去首尾空白后透传；空/纯空白 → null（全量）', async () => {
    const d = mkDeps();
    await mkSvc(d).listFamilies('  13800  ', 1, 20);
    expect(d.subsRepo.listFamilies).toHaveBeenCalledWith('13800', 1, 20);

    await mkSvc(d).listFamilies('   ', 1, 20);
    expect(d.subsRepo.listFamilies).toHaveBeenCalledWith(null, 1, 20);
  });

  it('行映射：effectiveStatus 推导 status + ISO 序列化 + studentCount 归一 Number', async () => {
    const d = mkDeps();
    const trialEndsAt = new Date(Date.now() + 3 * 86_400_000);
    const periodEnd = new Date(Date.now() + 10 * 86_400_000);
    d.subsRepo.listFamilies.mockResolvedValue({
      total: 3,
      rows: [
        { parent_id: 11, phone: '13800000001', student_count: '2', trial_ends_at: trialEndsAt, current_period_end: null, plan_code: null },
        { parent_id: 12, phone: '13800000002', student_count: 1, trial_ends_at: null, current_period_end: periodEnd, plan_code: 'month' },
        { parent_id: 13, phone: '13800000003', student_count: 0, trial_ends_at: null, current_period_end: null, plan_code: null },
      ],
    });

    const result = await mkSvc(d).listFamilies(undefined, 1, 20);

    expect(result.total).toBe(3);
    expect(result.page).toBe(1);
    expect(result.pageSize).toBe(20);
    expect(result.items).toEqual([
      { parentId: 11, phone: '13800000001', studentCount: 2, status: 'trialing', planCode: null, trialEndsAt: trialEndsAt.toISOString(), currentPeriodEnd: null },
      { parentId: 12, phone: '13800000002', studentCount: 1, status: 'active', planCode: 'month', trialEndsAt: null, currentPeriodEnd: periodEnd.toISOString() },
      { parentId: 13, phone: '13800000003', studentCount: 0, status: 'expired', planCode: null, trialEndsAt: null, currentPeriodEnd: null },
    ]);
  });
});
