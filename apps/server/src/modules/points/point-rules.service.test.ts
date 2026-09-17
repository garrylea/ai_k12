import { describe, it, expect, vi } from 'vitest';
import type { Pool } from 'mysql2/promise';
import { PointRulesService } from './point-rules.service.js';
import type { PointRuleUpdate } from './point-rules.service.js';
import { DEFAULT_RULES } from './default-rules.js';
import type { DefaultRule } from './default-rules.js';
import type { PointRulesRepository, PointRuleRow } from '../../database/repositories/point-rules.repo.js';
import type { PointLedgerRepository } from '../../database/repositories/point-ledger.repo.js';
import type { PointsService } from './points.service.js';

/** 造数据时不需要满足 RowDataPacket 的 `constructor` 约束。 */
type RuleFixture = Omit<PointRuleRow, 'constructor'>;

const STAMP = new Date(2026, 8, 17, 12, 0, 0, 0);
const DAY_START = new Date(2026, 8, 17, 0, 0, 0, 0);
const DAY_END = new Date(2026, 8, 18, 0, 0, 0, 0);

/** 由默认规则造一行库记录，测试里按需覆盖字段。 */
function rowFrom(d: DefaultRule, over: Partial<RuleFixture> = {}): PointRuleRow {
  const base: RuleFixture = {
    id: 1,
    student_id: 7,
    task_code: d.taskCode,
    tier_key: d.tierKey,
    tier_label: d.tierLabel,
    points: d.points,
    daily_limit: d.dailyLimit,
    sort_order: d.sortOrder,
    is_active: 1,
    created_at: STAMP,
    updated_at: STAMP,
  };
  return { ...base, ...over } as PointRuleRow;
}

/** 全量默认 15 条，id 按序递增。 */
function defaultRows(): PointRuleRow[] {
  return DEFAULT_RULES.map((d, i) => rowFrom(d, { id: i + 1 }));
}

const key = (taskCode: string, tierKey: string) => `${taskCode}/${tierKey}`;

/** 被测服务的全部依赖都是 mock：本用例不连真库。 */
function harness() {
  const rulesRepo = {
    findByStudent: vi.fn().mockResolvedValue([] as PointRuleRow[]),
    insertIgnoreBatch: vi.fn().mockResolvedValue(undefined),
    updateOne: vi.fn().mockResolvedValue(1),
  };
  const ledgerRepo = { countTodayEarned: vi.fn().mockResolvedValue(0) };
  // 日边界来自 PointsService（单一真源），这里注入固定值，与 points.service.test.ts 同一口径
  const points = {
    startOfToday: vi.fn().mockReturnValue(DAY_START),
    startOfTomorrow: vi.fn().mockReturnValue(DAY_END),
  };
  const conn = {
    beginTransaction: vi.fn().mockResolvedValue(undefined),
    commit: vi.fn().mockResolvedValue(undefined),
    rollback: vi.fn().mockResolvedValue(undefined),
    release: vi.fn(),
  };
  const pool = { getConnection: vi.fn().mockResolvedValue(conn) };
  const service = new PointRulesService(
    pool as unknown as Pool,
    rulesRepo as unknown as PointRulesRepository,
    ledgerRepo as unknown as PointLedgerRepository,
    points as unknown as PointsService,
  );
  return { service, rulesRepo, ledgerRepo, points, conn, pool };
}

/** 模拟「ensureRules 之前库中无规则行」：读规则的结果取决于补齐是否跑过。 */
function primeOnInsert(h: ReturnType<typeof harness>, rows: PointRuleRow[]) {
  let primed = false;
  h.rulesRepo.insertIgnoreBatch.mockImplementation(async () => {
    primed = true;
  });
  h.rulesRepo.findByStudent.mockImplementation(async () => (primed ? rows : []));
}

describe('PointRulesService.ensureRules — 懒初始化（幂等补齐）', () => {
  it('库里只有前 3 条默认档位 → 只补缺的 12 条，且补的正是缺的那些 key', async () => {
    const h = harness();
    const present = defaultRows().slice(0, 3);
    h.rulesRepo.findByStudent.mockResolvedValue(present);

    await h.service.ensureRules(7);

    expect(h.rulesRepo.insertIgnoreBatch).toHaveBeenCalledTimes(1);
    const [studentId, missing] = h.rulesRepo.insertIgnoreBatch.mock.calls[0];
    expect(studentId).toBe(7);
    expect(missing).toHaveLength(12);
    expect((missing as DefaultRule[]).map((r) => key(r.taskCode, r.tierKey))).toEqual(
      DEFAULT_RULES.slice(3).map((r) => key(r.taskCode, r.tierKey)),
    );
  });

  it('库里已全量 15 条 → 直接跳过，不调 insertIgnoreBatch（幂等 no-op）', async () => {
    const h = harness();
    h.rulesRepo.findByStudent.mockResolvedValue(defaultRows());

    await h.service.ensureRules(7);

    expect(h.rulesRepo.insertIgnoreBatch).not.toHaveBeenCalled();
  });

  it('家长改过的值不被覆盖：同 key 但分值/启用状态不同 → 该 key 不进补齐列表', async () => {
    const h = harness();
    const rows = defaultRows();
    const i = rows.findIndex((r) => r.task_code === 'math_targeted' && r.tier_key === '5');
    rows[i] = { ...rows[i], points: 99, is_active: 0 }; // 家长改成 99 分并下架
    h.rulesRepo.findByStudent.mockResolvedValue(rows);

    await h.service.ensureRules(7);

    // 15 个 key 齐全 → 一条都不补，家长的值原样保留（懒初始化有意不回溯默认值）
    expect(h.rulesRepo.insertIgnoreBatch).not.toHaveBeenCalled();
  });

  it('部分缺失 + 家长改过：只补缺的那条，改过的 key 不出现', async () => {
    const h = harness();
    const rows = defaultRows().filter((r) => !(r.task_code === 'cn_meaning' && r.tier_key === 'default'));
    const i = rows.findIndex((r) => r.task_code === 'math_targeted' && r.tier_key === '5');
    rows[i] = { ...rows[i], points: 99, is_active: 0 };
    h.rulesRepo.findByStudent.mockResolvedValue(rows);

    await h.service.ensureRules(7);

    const sent = h.rulesRepo.insertIgnoreBatch.mock.calls[0][1] as DefaultRule[];
    expect(sent.map((r) => key(r.taskCode, r.tierKey))).toEqual(['cn_meaning/default']);
    // 家长改过的那条分值绝不能被默认值顶回去
    expect(sent.some((r) => r.points === 99)).toBe(false);
    expect(h.rulesRepo.insertIgnoreBatch).toHaveBeenCalledTimes(1);
  });
});

describe('PointRulesService.listGrouped — 规则分组', () => {
  it('按 taskCode 分组（sortOrder 序）、组内按 sortOrder；taskName 取自 TASK_NAMES', async () => {
    const h = harness();
    h.rulesRepo.findByStudent.mockResolvedValue(defaultRows());

    const { tasks } = await h.service.listGrouped(7);

    expect(tasks.map((t) => t.taskCode)).toEqual([
      'mainline_lesson',
      'math_paper',
      'math_targeted',
      'error_fix',
      'cn_dictation',
      'cn_interpretation',
      'cn_meaning',
      'en_vocabulary',
    ]);
    expect(tasks.find((t) => t.taskCode === 'math_targeted')?.taskName).toBe('数学专项');
    expect(tasks.find((t) => t.taskCode === 'math_targeted')?.tiers.map((t) => t.tierKey)).toEqual([
      '1',
      '3',
      '5',
      '10',
    ]);
    expect(tasks.find((t) => t.taskCode === 'cn_dictation')?.tiers.map((t) => t.tierLabel)).toEqual([
      '古诗',
      '古文',
    ]);
  });

  it('规则先补齐再读：全新学生也能拿到 8 个任务的全量档位', async () => {
    const h = harness();
    primeOnInsert(h, defaultRows());

    const { tasks } = await h.service.listGrouped(7);

    expect(tasks).toHaveLength(8);
    expect(tasks.flatMap((t) => t.tiers)).toHaveLength(15);
    // ensureRules 内部先读一次找缺失、再补；补完必须早于**第二次**读（取全量规则）。
    // 反了就是空表 —— 「全新学生开练 400」的回归钉子。
    expect(h.rulesRepo.findByStudent).toHaveBeenCalledTimes(2);
    expect(h.rulesRepo.insertIgnoreBatch.mock.invocationCallOrder[0]).toBeLessThan(
      h.rulesRepo.findByStudent.mock.invocationCallOrder[1],
    );
  });

  it('withDailyCounts:true → 每个 taskCode 只查一次流水，日边界取自注入的时钟', async () => {
    const h = harness();
    h.rulesRepo.findByStudent.mockResolvedValue(defaultRows());

    await h.service.listGrouped(7, { withDailyCounts: true });

    expect(h.points.startOfToday).toHaveBeenCalledTimes(1);
    expect(h.points.startOfTomorrow).toHaveBeenCalledTimes(1);
    // 8 个 taskCode 各一次（不是 15 个档位各一次）
    expect(h.ledgerRepo.countTodayEarned).toHaveBeenCalledTimes(8);
    expect(h.ledgerRepo.countTodayEarned).toHaveBeenCalledWith(7, 'math_targeted', DAY_START, DAY_END);
    expect(h.ledgerRepo.countTodayEarned).toHaveBeenCalledWith(7, 'en_vocabulary', DAY_START, DAY_END);
  });

  it('completedToday / remainingToday：不限（null）→ null；有限额 → limit - 今日条数', async () => {
    const h = harness();
    h.rulesRepo.findByStudent.mockResolvedValue(defaultRows());
    h.ledgerRepo.countTodayEarned.mockImplementation(async (_sid: number, taskCode: string) =>
      taskCode === 'en_vocabulary' ? 1 : 0,
    );

    const { tasks } = await h.service.listGrouped(7, { withDailyCounts: true });

    const vocab = tasks.find((t) => t.taskCode === 'en_vocabulary');
    expect(vocab?.tiers.map((t) => [t.dailyLimit, t.completedToday, t.remainingToday])).toEqual([
      [2, 1, 1],
      [2, 1, 1],
      [2, 1, 1],
    ]);
    expect(tasks.find((t) => t.taskCode === 'mainline_lesson')?.tiers[0]).toMatchObject({
      dailyLimit: null,
      completedToday: 0,
      remainingToday: null,
    });
  });

  it('今日条数已超上限（家长事后调低）→ remainingToday 夹到 0，不给负数', async () => {
    const h = harness();
    h.rulesRepo.findByStudent.mockResolvedValue(defaultRows());
    h.ledgerRepo.countTodayEarned.mockImplementation(async (_sid: number, taskCode: string) =>
      taskCode === 'en_vocabulary' ? 5 : 0,
    );

    const { tasks } = await h.service.listGrouped(7, { withDailyCounts: true });

    const vocab = tasks.find((t) => t.taskCode === 'en_vocabulary');
    expect(vocab?.tiers[0]).toMatchObject({ completedToday: 5, remainingToday: 0 });
  });

  it('不传 withDailyCounts → 不查流水，两项都为 null（未计算）', async () => {
    const h = harness();
    h.rulesRepo.findByStudent.mockResolvedValue(defaultRows());

    const { tasks } = await h.service.listGrouped(7);

    expect(h.ledgerRepo.countTodayEarned).not.toHaveBeenCalled();
    expect(tasks[0].tiers[0]).toMatchObject({ completedToday: null, remainingToday: null });
  });

  it('is_active=0 的档位仍回传（家长配置页要能重新启用），isActive 为布尔', async () => {
    const h = harness();
    const rows = defaultRows();
    const i = rows.findIndex((r) => r.task_code === 'math_targeted' && r.tier_key === '5');
    rows[i] = { ...rows[i], is_active: 0 };
    h.rulesRepo.findByStudent.mockResolvedValue(rows);

    const { tasks } = await h.service.listGrouped(7);

    const tier = tasks.find((t) => t.taskCode === 'math_targeted')?.tiers.find((t) => t.tierKey === '5');
    expect(tier?.isActive).toBe(false);
  });
});

describe('PointRulesService.listTierKeys — 档位白名单（Task 12 用）', () => {
  it("math_targeted → ['1','3','5','10']", async () => {
    const h = harness();
    h.rulesRepo.findByStudent.mockResolvedValue(defaultRows());

    await expect(h.service.listTierKeys(7, 'math_targeted')).resolves.toEqual(['1', '3', '5', '10']);
  });

  it("家长把 '5' 置 isActive:false 后 → ['1','3','10']", async () => {
    const h = harness();
    const rows = defaultRows();
    const i = rows.findIndex((r) => r.task_code === 'math_targeted' && r.tier_key === '5');
    rows[i] = { ...rows[i], is_active: 0 };
    h.rulesRepo.findByStudent.mockResolvedValue(rows);

    await expect(h.service.listTierKeys(7, 'math_targeted')).resolves.toEqual(['1', '3', '10']);
  });

  it('全新学生（库里一条都没有）→ 先补齐再查，返回默认档位而不是空数组', async () => {
    const h = harness();
    primeOnInsert(h, defaultRows());

    const keys = await h.service.listTierKeys(7, 'math_targeted');

    // 返回空数组会让 Task 12 的每个 start 请求都被 400 —— 这条就是那个回归钉子
    expect(keys).toEqual(['1', '3', '5', '10']);
    expect(h.rulesRepo.insertIgnoreBatch).toHaveBeenCalledTimes(1);
    expect(h.rulesRepo.findByStudent).toHaveBeenCalledTimes(2);
    expect(h.rulesRepo.insertIgnoreBatch.mock.invocationCallOrder[0]).toBeLessThan(
      h.rulesRepo.findByStudent.mock.invocationCallOrder[1],
    );
  });

  it('按 sort_order 排（repo 返回乱序时也稳）', async () => {
    const h = harness();
    const rows = defaultRows().filter((r) => r.task_code === 'en_vocabulary').reverse();
    h.rulesRepo.findByStudent.mockResolvedValue(rows);

    await expect(h.service.listTierKeys(7, 'en_vocabulary')).resolves.toEqual(['10', '15', '20']);
  });

  it('全档位都被停用 → 空数组；未知 taskCode → 空数组', async () => {
    const h = harness();
    const rows = defaultRows().filter((r) => r.task_code === 'math_targeted').map((r) => ({ ...r, is_active: 0 }));
    rows.push(rowFrom(DEFAULT_RULES[0])); // 别的任务有规则不影响本任务结果
    h.rulesRepo.findByStudent.mockResolvedValue(rows);

    await expect(h.service.listTierKeys(7, 'math_targeted')).resolves.toEqual([]);
    await expect(h.service.listTierKeys(7, 'brand_new_task')).resolves.toEqual([]);
  });
});

describe('PointRulesService.updateBatch — 家长批量保存', () => {
  const A: PointRuleUpdate = { taskCode: 'math_targeted', tierKey: '1', points: 3, dailyLimit: 2, isActive: true };
  const B: PointRuleUpdate = { taskCode: 'math_targeted', tierKey: '3', points: 9, dailyLimit: null, isActive: false };

  /** 家长保存前先补默认档位，再在一个事务里逐条更新。 */
  function stubBatch(h: ReturnType<typeof harness>) {
    h.rulesRepo.findByStudent.mockResolvedValue(defaultRows());
    h.rulesRepo.updateOne.mockResolvedValue(1);
  }

  it('一个事务里逐条 updateOne（同一连接），全部成功才 commit', async () => {
    const h = harness();
    stubBatch(h);

    await h.service.updateBatch(7, [A, B]);

    expect(h.rulesRepo.insertIgnoreBatch).not.toHaveBeenCalled(); // 已全量，无需补齐
    expect(h.rulesRepo.updateOne).toHaveBeenCalledTimes(2);
    expect(h.rulesRepo.updateOne).toHaveBeenNthCalledWith(
      1,
      7,
      'math_targeted',
      '1',
      { points: 3, dailyLimit: 2, isActive: true },
      h.conn,
    );
    expect(h.rulesRepo.updateOne).toHaveBeenNthCalledWith(
      2,
      7,
      'math_targeted',
      '3',
      { points: 9, dailyLimit: null, isActive: false },
      h.conn,
    );
    expect(h.conn.beginTransaction).toHaveBeenCalledTimes(1);
    expect(h.conn.commit).toHaveBeenCalledTimes(1);
    expect(h.conn.rollback).not.toHaveBeenCalled();
    expect(h.conn.release).toHaveBeenCalledTimes(1);
  });

  it('全新学生：批前先 ensureRules，档位从无到有后照样更新成功', async () => {
    const h = harness();
    let primed = false;
    h.rulesRepo.insertIgnoreBatch.mockImplementation(async () => {
      primed = true;
    });
    h.rulesRepo.findByStudent.mockImplementation(async () => (primed ? defaultRows() : []));
    h.rulesRepo.updateOne.mockResolvedValue(1);

    await h.service.updateBatch(7, [A]);

    expect(h.rulesRepo.insertIgnoreBatch).toHaveBeenCalledWith(7, DEFAULT_RULES);
    expect(h.rulesRepo.updateOne).toHaveBeenCalledTimes(1);
    expect(h.conn.commit).toHaveBeenCalledTimes(1);
  });

  it('原样重存（值没变）→ affectedRows 仍是 1，不误报 3005', async () => {
    const h = harness();
    stubBatch(h);
    // mysql2 默认带 CLIENT_FOUND_ROWS：UPDATE 的 affectedRows 是**匹配行数**而非改动行数，
    // 因此「家长原样再存一次」返回 1。这条钉住服务层不能把 1 误读成「缺档位」。
    h.rulesRepo.updateOne.mockResolvedValue(1);

    await expect(h.service.updateBatch(7, [A])).resolves.toBeUndefined();
    expect(h.conn.commit).toHaveBeenCalledTimes(1);
  });

  it('任一档位不存在（affectedRows=0）→ 3005，且整批回滚不提交', async () => {
    const h = harness();
    stubBatch(h);
    h.rulesRepo.updateOne.mockResolvedValueOnce(1).mockResolvedValueOnce(0);

    await expect(h.service.updateBatch(7, [A, B])).rejects.toMatchObject({
      response: { code: 3005, message: '档位不存在' },
    });

    // 第一条已经写进去了，必须靠回滚撤销——「要么全成、要么全不成」
    expect(h.conn.rollback).toHaveBeenCalledTimes(1);
    expect(h.conn.commit).not.toHaveBeenCalled();
    expect(h.conn.release).toHaveBeenCalledTimes(1);
  });

  it('points 为负 → 400，且压根不碰 DB（负数会写成负的 earn 流水，破坏段位只升不降）', async () => {
    const h = harness();
    stubBatch(h);

    await expect(
      h.service.updateBatch(7, [{ ...A, points: -1 }]),
    ).rejects.toMatchObject({ status: 400, response: { code: 1001 } });

    expect(h.pool.getConnection).not.toHaveBeenCalled();
    expect(h.rulesRepo.updateOne).not.toHaveBeenCalled();
    expect(h.rulesRepo.insertIgnoreBatch).not.toHaveBeenCalled();
    expect(h.rulesRepo.findByStudent).not.toHaveBeenCalled();
  });

  it('points 超过 9999 → 400', async () => {
    const h = harness();
    stubBatch(h);

    await expect(h.service.updateBatch(7, [{ ...A, points: 10000 }])).rejects.toMatchObject({
      status: 400,
      response: { code: 1001 },
    });
    expect(h.pool.getConnection).not.toHaveBeenCalled();
  });

  it('points = 0 / 9999 是合法边界（0 分的档位是允许的）', async () => {
    const h = harness();
    stubBatch(h);

    await expect(h.service.updateBatch(7, [{ ...A, points: 0 }, { ...B, points: 9999 }])).resolves.toBeUndefined();

    expect(h.conn.commit).toHaveBeenCalledTimes(1);
  });

  it('dailyLimit = 0 → 400（0 会让「今日条数 >= 0」恒真，档位永久不发分）', async () => {
    const h = harness();
    stubBatch(h);

    await expect(h.service.updateBatch(7, [{ ...A, dailyLimit: 0 }])).rejects.toMatchObject({
      status: 400,
      response: { code: 1001 },
    });

    expect(h.pool.getConnection).not.toHaveBeenCalled();
    expect(h.rulesRepo.updateOne).not.toHaveBeenCalled();
  });

  it('dailyLimit = 100 → 400；null 合法（null 是「不限」的唯一表达）', async () => {
    const h = harness();
    stubBatch(h);

    await expect(h.service.updateBatch(7, [{ ...A, dailyLimit: 100 }])).rejects.toMatchObject({
      status: 400,
      response: { code: 1001 },
    });
    await expect(h.service.updateBatch(7, [{ ...A, dailyLimit: null }])).resolves.toBeUndefined();
  });

  it('批内任一非法 → 整批不落库（校验先跑全量，不是边写边校验）', async () => {
    const h = harness();
    stubBatch(h);

    await expect(h.service.updateBatch(7, [A, { ...B, dailyLimit: -3 }])).rejects.toMatchObject({
      status: 400,
      response: { code: 1001 },
    });

    expect(h.rulesRepo.updateOne).not.toHaveBeenCalled();
    expect(h.pool.getConnection).not.toHaveBeenCalled();
  });

  it('条目没有任何可改字段 → 400，绝不能进 updateOne', async () => {
    const h = harness();
    stubBatch(h);
    // 建模「内部调用方/绕过 Zod 时漏字段」——若放行，updateOne 的 patch 为空 → 返回 0
    // → 被误读成「档位不存在」→ 对一个真实存在的档位报假 3005。
    const empty: PointRuleUpdate = { taskCode: 'math_targeted', tierKey: '1' };

    await expect(h.service.updateBatch(7, [empty])).rejects.toMatchObject({
      status: 400,
      response: { code: 1001 },
    });

    expect(h.rulesRepo.updateOne).not.toHaveBeenCalled();
    expect(h.pool.getConnection).not.toHaveBeenCalled();
  });

  it('只给一个可改字段也照常下发（patch 只含给到的字段）', async () => {
    const h = harness();
    stubBatch(h);
    const partial: PointRuleUpdate = { taskCode: 'math_targeted', tierKey: '1', isActive: false };

    await h.service.updateBatch(7, [partial]);

    expect(h.rulesRepo.updateOne).toHaveBeenCalledWith(
      7,
      'math_targeted',
      '1',
      { isActive: false },
      h.conn,
    );
  });
});
