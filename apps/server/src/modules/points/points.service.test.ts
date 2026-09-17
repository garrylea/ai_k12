import { describe, it, expect, vi } from 'vitest';
import type { Pool } from 'mysql2/promise';
import { PointsService } from './points.service.js';
import { DEFAULT_RULES } from './default-rules.js';
import type { PointRulesRepository, PointRuleRow } from '../../database/repositories/point-rules.repo.js';
import type { PointLedgerRepository } from '../../database/repositories/point-ledger.repo.js';
import type { StudentPointsRepository } from '../../database/repositories/student-points.repo.js';

/** 造数据时不需要满足 RowDataPacket 的 `constructor` 约束。 */
type RuleFixture = Omit<PointRuleRow, 'constructor'>;

/** 一条英语背单词规则（每日上限 2，10 词档 2 分）。测试里按需覆盖字段。 */
function ruleRow(over: Partial<RuleFixture> = {}): PointRuleRow {
  const base: RuleFixture = {
    id: 1,
    student_id: 1,
    task_code: 'en_vocabulary',
    tier_key: '10',
    tier_label: '10 词',
    points: 2,
    daily_limit: 2,
    sort_order: 80,
    is_active: 1,
    created_at: new Date(2026, 8, 17),
    updated_at: new Date(2026, 8, 17),
  };
  return { ...base, ...over } as PointRuleRow;
}

/** 被测服务的全部依赖都是 mock：本用例不连真库。 */
function harness(startNow = new Date(2026, 8, 17, 10, 0, 0)) {
  let current = startNow;
  // 默认时钟读 `current`；setClock 可换成「每次调用返回不同值」的序列钟，用来建模跨午夜读数。
  let clock: () => Date = () => current;
  const rulesRepo = { findByStudent: vi.fn(), insertIgnoreBatch: vi.fn() };
  const ledgerRepo = {
    insert: vi.fn(),
    findByDedupeKey: vi.fn(),
    countTodayEarned: vi.fn(),
  };
  const pointsRepo = { find: vi.fn(), upsertDelta: vi.fn() };
  const conn = {
    beginTransaction: vi.fn().mockResolvedValue(undefined),
    commit: vi.fn().mockResolvedValue(undefined),
    rollback: vi.fn().mockResolvedValue(undefined),
    release: vi.fn(),
  };
  const pool = { getConnection: vi.fn().mockResolvedValue(conn) };
  const service = new PointsService(
    pool as unknown as Pool,
    rulesRepo as unknown as PointRulesRepository,
    ledgerRepo as unknown as PointLedgerRepository,
    pointsRepo as unknown as StudentPointsRepository,
    () => clock(),
  );
  return {
    service,
    rulesRepo,
    ledgerRepo,
    pointsRepo,
    conn,
    pool,
    setNow: (d: Date) => {
      current = d;
    },
    setClock: (fn: () => Date) => {
      clock = fn;
    },
  };
}

/** 成功的发分路径的通用桩：一条规则、未到上限、快照 490 → 492。 */
function stubHappyPath(h: ReturnType<typeof harness>) {
  h.rulesRepo.findByStudent.mockResolvedValue([ruleRow()]);
  h.ledgerRepo.countTodayEarned.mockResolvedValue(0);
  h.pointsRepo.find
    .mockResolvedValueOnce({ totalEarned: 490, balance: 100 })
    .mockResolvedValueOnce({ totalEarned: 492, balance: 102 });
  h.ledgerRepo.insert.mockResolvedValue({ id: 7, duplicate: false });
}

const INPUT = { studentId: 1, taskCode: 'en_vocabulary', tierKey: '10', dedupeKey: 'vsess:9' };

describe('PointsService.award — 正常发分', () => {
  it('写流水 + 同步更新快照，返回本次分、余额与累计', async () => {
    const h = harness();
    stubHappyPath(h);

    const result = await h.service.award(INPUT);

    expect(result).toEqual({
      pointsAwarded: 2,
      balance: 102,
      totalEarned: 492,
      levelUp: null,
    });
    // 流水与快照必须同事务：两条写都拿到同一个 conn
    expect(h.ledgerRepo.insert).toHaveBeenCalledTimes(1);
    const [row, connArg] = h.ledgerRepo.insert.mock.calls[0];
    expect(row).toEqual({
      student_id: 1,
      kind: 'earn',
      task_code: 'en_vocabulary',
      tier_key: '10',
      points: 2,
      dedupe_key: 'vsess:9',
      title: '英语背单词 · 10 词', // 快照文案；家长之后改档位名不改历史
      ref_type: null,
      ref_id: null,
    });
    expect(connArg).toBe(h.conn);
    expect(h.pointsRepo.upsertDelta).toHaveBeenCalledWith(1, 2, 2, h.conn);
    expect(h.conn.commit).toHaveBeenCalledTimes(1);
    expect(h.conn.rollback).not.toHaveBeenCalled();
    expect(h.conn.release).toHaveBeenCalledTimes(1);
  });

  it('refType / refId 透传进流水', async () => {
    const h = harness();
    stubHappyPath(h);

    await h.service.award({ ...INPUT, refType: 'training_session', refId: 33 });

    expect(h.ledgerRepo.insert.mock.calls[0][0]).toMatchObject({
      ref_type: 'training_session',
      ref_id: 33,
    });
  });

  it('未传 tierKey 时按 default 档找规则', async () => {
    const h = harness();
    h.rulesRepo.findByStudent.mockResolvedValue([
      ruleRow({ task_code: 'mainline_lesson', tier_key: 'default', tier_label: '一课', points: 10, daily_limit: null }),
      ruleRow(),
    ]);
    h.pointsRepo.find.mockResolvedValue({ totalEarned: 100, balance: 100 });
    h.ledgerRepo.insert.mockResolvedValue({ id: 1, duplicate: false });

    const result = await h.service.award({ studentId: 1, taskCode: 'mainline_lesson', dedupeKey: 'lesson:1:5' });

    expect(result.pointsAwarded).toBe(10);
    expect(h.ledgerRepo.insert.mock.calls[0][0]).toMatchObject({ tier_key: 'default', title: '学完一课 · 一课' });
  });

  it('taskCode 不在 TASK_NAMES 时 title 用原始 taskCode 兜底，不出现 undefined', async () => {
    const h = harness();
    h.rulesRepo.findByStudent.mockResolvedValue([
      ruleRow({ task_code: 'brand_new_task', tier_key: 'default', tier_label: '一次', daily_limit: null }),
    ]);
    h.pointsRepo.find.mockResolvedValue({ totalEarned: 0, balance: 0 });
    h.ledgerRepo.insert.mockResolvedValue({ id: 1, duplicate: false });

    await h.service.award({ studentId: 1, taskCode: 'brand_new_task', dedupeKey: 'x:1' });

    expect(h.ledgerRepo.insert.mock.calls[0][0].title).toBe('brand_new_task · 一次');
  });
});

describe('PointsService.award — 幂等（dedupe_key 命中）', () => {
  it('返回首次分值与当前余额，不再加一次、不提交快照', async () => {
    const h = harness();
    // 家长后来把该档改成 7 分——流水里存的仍是首次的 2 分
    h.rulesRepo.findByStudent.mockResolvedValue([ruleRow({ points: 7 })]);
    h.ledgerRepo.countTodayEarned.mockResolvedValue(0);
    h.pointsRepo.find.mockResolvedValue({ totalEarned: 500, balance: 498 });
    h.ledgerRepo.insert.mockResolvedValue({ id: 0, duplicate: true });
    h.ledgerRepo.findByDedupeKey.mockResolvedValue({ points: 2 });

    const result = await h.service.award(INPUT);

    expect(result.pointsAwarded).toBe(2); // 首次值，不是当前规则的 7
    expect(result.reason).toBe('duplicate');
    expect(result.balance).toBe(498);
    expect(result.totalEarned).toBe(500);
    expect(result.levelUp).toBeNull();
    expect(h.ledgerRepo.findByDedupeKey).toHaveBeenCalledWith('vsess:9');
    expect(h.pointsRepo.upsertDelta).not.toHaveBeenCalled();
    expect(h.conn.commit).not.toHaveBeenCalled();
    expect(h.conn.rollback).toHaveBeenCalledTimes(1);
    expect(h.conn.release).toHaveBeenCalledTimes(1);
  });
});

describe('PointsService.award — 每日上限', () => {
  it('今日条数已达上限 → 不发分、不写流水', async () => {
    const h = harness();
    h.rulesRepo.findByStudent.mockResolvedValue([ruleRow({ daily_limit: 2 })]);
    h.ledgerRepo.countTodayEarned.mockResolvedValue(2);
    h.pointsRepo.find.mockResolvedValue({ totalEarned: 100, balance: 100 });

    const result = await h.service.award(INPUT);

    expect(result).toEqual({
      pointsAwarded: 0,
      balance: 100,
      totalEarned: 100,
      levelUp: null,
      reason: 'daily_limit',
    });
    expect(h.ledgerRepo.insert).not.toHaveBeenCalled();
    expect(h.pool.getConnection).not.toHaveBeenCalled();
    expect(h.pointsRepo.upsertDelta).not.toHaveBeenCalled();
  });

  it('计数窗口是本地「今日 00:00 ≤ created_at < 明日 00:00」', async () => {
    const h = harness(new Date(2026, 8, 17, 23, 59, 59));
    h.rulesRepo.findByStudent.mockResolvedValue([ruleRow({ daily_limit: 2 })]);
    h.ledgerRepo.countTodayEarned.mockResolvedValue(2);
    h.pointsRepo.find.mockResolvedValue({ totalEarned: 0, balance: 0 });

    await h.service.award(INPUT);

    expect(h.ledgerRepo.countTodayEarned).toHaveBeenCalledWith(
      1,
      'en_vocabulary',
      new Date(2026, 8, 17, 0, 0, 0, 0),
      new Date(2026, 8, 18, 0, 0, 0, 0),
    );
  });

  it('日边界由同一次取钟派生：两次读数跨午夜也不会撑成 48 小时窗口', async () => {
    const h = harness();
    // 时钟连读两次会跨过午夜：第 1 次在第 17 天末尾、第 2 次已进入第 18 天。
    // 若 award 分别裸调 startOfToday()/startOfTomorrow()（各自读一次钟），窗口会变成
    // 17 日 00:00 → 19 日 00:00（48 小时），把两天的发分都算进今天——学生第二轮被误判上限。
    const reads = [new Date(2026, 8, 17, 23, 59, 59, 999), new Date(2026, 8, 18, 0, 0, 0, 1)];
    let i = 0;
    h.setClock(() => reads[Math.min(i++, reads.length - 1)]);
    h.rulesRepo.findByStudent.mockResolvedValue([ruleRow({ daily_limit: 2 })]);
    h.ledgerRepo.countTodayEarned.mockResolvedValue(2);
    h.pointsRepo.find.mockResolvedValue({ totalEarned: 0, balance: 0 });

    await h.service.award(INPUT);

    const call = h.ledgerRepo.countTodayEarned.mock.calls[0] as unknown as [number, string, Date, Date];
    const [, , dayStart, dayEnd] = call;
    expect(dayStart).toEqual(new Date(2026, 8, 17, 0, 0, 0, 0));
    // 关键断言：窗口必须恰好 24 小时。只单独核对某一边的值抓不到双读数 bug。
    expect(dayEnd.getTime() - dayStart.getTime()).toBe(24 * 60 * 60 * 1000);
  });

  it('dailyLimit 为 null → 完全跳过计数', async () => {
    const h = harness();
    h.rulesRepo.findByStudent.mockResolvedValue([ruleRow({ daily_limit: null })]);
    h.pointsRepo.find.mockResolvedValue({ totalEarned: 0, balance: 0 });
    h.ledgerRepo.insert.mockResolvedValue({ id: 1, duplicate: false });

    const result = await h.service.award(INPUT);

    expect(result.pointsAwarded).toBe(2);
    expect(h.ledgerRepo.countTodayEarned).not.toHaveBeenCalled();
  });

  it('跨天：上限重置（注入时钟往前推一天）', async () => {
    const h = harness(new Date(2026, 8, 17, 10, 0, 0));
    h.rulesRepo.findByStudent.mockResolvedValue([ruleRow({ daily_limit: 2 })]);
    h.ledgerRepo.countTodayEarned.mockResolvedValueOnce(2).mockResolvedValueOnce(0);
    h.pointsRepo.find.mockResolvedValue({ totalEarned: 0, balance: 0 });
    h.ledgerRepo.insert.mockResolvedValue({ id: 1, duplicate: false });

    const first = await h.service.award(INPUT);
    expect(first.reason).toBe('daily_limit');
    expect(h.ledgerRepo.insert).not.toHaveBeenCalled();

    h.setNow(new Date(2026, 8, 18, 10, 0, 0));
    const second = await h.service.award({ ...INPUT, dedupeKey: 'vsess:10' });

    expect(second.pointsAwarded).toBe(2);
    expect(second.reason).toBeUndefined();
    expect(h.ledgerRepo.countTodayEarned).toHaveBeenNthCalledWith(
      1,
      1,
      'en_vocabulary',
      new Date(2026, 8, 17, 0, 0, 0, 0),
      new Date(2026, 8, 18, 0, 0, 0, 0),
    );
    expect(h.ledgerRepo.countTodayEarned).toHaveBeenNthCalledWith(
      2,
      1,
      'en_vocabulary',
      new Date(2026, 8, 18, 0, 0, 0, 0),
      new Date(2026, 8, 19, 0, 0, 0, 0),
    );
    expect(h.ledgerRepo.insert).toHaveBeenCalledTimes(1);
  });
});

describe('PointsService.award — 规则懒初始化（全新学生）', () => {
  it('首次 findByStudent 返回空 → 先补默认规则再读，发分正常进行', async () => {
    const h = harness();
    // 模型化「ensure 前库中无规则行、INSERT IGNORE 之后就位」：读规则的结果取决于 ensure 是否跑过。
    // 去掉实现里的那一步，本用例会退回 no_rule —— 它就是「全新学生首课静默 0 分」的回归钉子。
    let primed = false;
    h.rulesRepo.insertIgnoreBatch.mockImplementation(async () => {
      primed = true;
    });
    h.rulesRepo.findByStudent.mockImplementation(async () => (primed ? [ruleRow()] : []));
    h.ledgerRepo.countTodayEarned.mockResolvedValue(0);
    h.pointsRepo.find
      .mockResolvedValueOnce({ totalEarned: 0, balance: 0 })
      .mockResolvedValueOnce({ totalEarned: 2, balance: 2 });
    h.ledgerRepo.insert.mockResolvedValue({ id: 1, duplicate: false });

    const result = await h.service.award(INPUT);

    // 必须用 repo + 常量补齐（不走 PointRulesService），且只补一次
    expect(h.rulesRepo.insertIgnoreBatch).toHaveBeenCalledTimes(1);
    expect(h.rulesRepo.insertIgnoreBatch).toHaveBeenCalledWith(1, DEFAULT_RULES);
    // ensure 必须早于读规则：反了就还是读到空数组 → 静默 0 分
    expect(h.rulesRepo.insertIgnoreBatch.mock.invocationCallOrder[0]).toBeLessThan(
      h.rulesRepo.findByStudent.mock.invocationCallOrder[0],
    );
    // 发分路径确实走下去了（不是 no_rule）
    expect(result.reason).toBeUndefined();
    expect(result).toEqual({
      pointsAwarded: 2,
      balance: 2,
      totalEarned: 2,
      levelUp: null,
    });
    expect(h.ledgerRepo.insert).toHaveBeenCalledTimes(1);
  });

  it('存量学生：无差别跑一次 INSERT IGNORE（幂等 no-op），发分按读到的自定义分值而非默认值', async () => {
    const h = harness();
    stubHappyPath(h);
    // 家长把 10 词档改成了 5 分；INSERT IGNORE 撞唯一键静默跳过，读到的仍是 5
    h.rulesRepo.findByStudent.mockResolvedValue([ruleRow({ points: 5 })]);

    const result = await h.service.award(INPUT);

    expect(h.rulesRepo.insertIgnoreBatch).toHaveBeenCalledWith(1, DEFAULT_RULES);
    expect(result.pointsAwarded).toBe(5);
    expect(h.ledgerRepo.insert.mock.calls[0][0].points).toBe(5);
  });
});

describe('PointsService.award — 规则缺失 / 停用', () => {
  it('找不到档位 → no_rule，不抛错、不写流水', async () => {
    const h = harness();
    h.rulesRepo.findByStudent.mockResolvedValue([ruleRow({ tier_key: '15' })]);
    h.pointsRepo.find.mockResolvedValue({ totalEarned: 30, balance: 30 });

    const result = await h.service.award(INPUT);

    expect(result).toEqual({
      pointsAwarded: 0,
      balance: 30,
      totalEarned: 30,
      levelUp: null,
      reason: 'no_rule',
    });
    expect(h.ledgerRepo.insert).not.toHaveBeenCalled();
    expect(h.ledgerRepo.countTodayEarned).not.toHaveBeenCalled();
  });

  it('该生一条规则都没有 → 同样是 no_rule', async () => {
    const h = harness();
    h.rulesRepo.findByStudent.mockResolvedValue([]);
    h.pointsRepo.find.mockResolvedValue({ totalEarned: 0, balance: 0 });

    const result = await h.service.award(INPUT);

    expect(result.reason).toBe('no_rule');
    expect(result.pointsAwarded).toBe(0);
  });

  it('is_active=0 → tier_inactive，且早于每日上限检查', async () => {
    const h = harness();
    h.rulesRepo.findByStudent.mockResolvedValue([ruleRow({ is_active: 0 })]);
    h.pointsRepo.find.mockResolvedValue({ totalEarned: 5, balance: 5 });

    const result = await h.service.award(INPUT);

    expect(result.reason).toBe('tier_inactive');
    expect(result.pointsAwarded).toBe(0);
    expect(result.balance).toBe(5);
    expect(h.ledgerRepo.countTodayEarned).not.toHaveBeenCalled();
    expect(h.ledgerRepo.insert).not.toHaveBeenCalled();
  });
});

describe('PointsService.award — 跨档检测', () => {
  it('490 + 10 → 劈柴升铸铁', async () => {
    const h = harness();
    h.rulesRepo.findByStudent.mockResolvedValue([
      ruleRow({ task_code: 'mainline_lesson', tier_key: 'default', tier_label: '一课', points: 10, daily_limit: null }),
    ]);
    h.pointsRepo.find
      .mockResolvedValueOnce({ totalEarned: 490, balance: 490 })
      .mockResolvedValueOnce({ totalEarned: 500, balance: 500 });
    h.ledgerRepo.insert.mockResolvedValue({ id: 1, duplicate: false });

    const result = await h.service.award({ studentId: 1, taskCode: 'mainline_lesson', dedupeKey: 'lesson:1:5' });

    expect(result.levelUp?.from.code).toBe('pichai');
    expect(result.levelUp?.to.code).toBe('zhutie');
    expect(result.totalEarned).toBe(500);
  });

  it('500 + 10 → 同档内加分，levelUp 为 null', async () => {
    const h = harness();
    h.rulesRepo.findByStudent.mockResolvedValue([
      ruleRow({ task_code: 'mainline_lesson', tier_key: 'default', tier_label: '一课', points: 10, daily_limit: null }),
    ]);
    h.pointsRepo.find
      .mockResolvedValueOnce({ totalEarned: 500, balance: 500 })
      .mockResolvedValueOnce({ totalEarned: 510, balance: 510 });
    h.ledgerRepo.insert.mockResolvedValue({ id: 1, duplicate: false });

    const result = await h.service.award({ studentId: 1, taskCode: 'mainline_lesson', dedupeKey: 'lesson:1:6' });

    expect(result.levelUp).toBeNull();
    expect(result.pointsAwarded).toBe(10);
  });

  it('发分前的累计在事务之前读取（跨档判定用旧值）', async () => {
    const h = harness();
    h.rulesRepo.findByStudent.mockResolvedValue([
      ruleRow({ task_code: 'mainline_lesson', tier_key: 'default', tier_label: '一课', points: 10, daily_limit: null }),
    ]);
    h.pointsRepo.find
      .mockResolvedValueOnce({ totalEarned: 490, balance: 0 })
      .mockResolvedValueOnce({ totalEarned: 500, balance: 10 });
    h.ledgerRepo.insert.mockResolvedValue({ id: 1, duplicate: false });

    await h.service.award({ studentId: 1, taskCode: 'mainline_lesson', dedupeKey: 'lesson:1:7' });

    // 第一次 find（旧值）必须发生在 insert 之前
    const findOrder = h.pointsRepo.find.mock.invocationCallOrder[0];
    const insertOrder = h.ledgerRepo.insert.mock.invocationCallOrder[0];
    expect(findOrder).toBeLessThan(insertOrder);
    expect(h.pointsRepo.find).toHaveBeenCalledTimes(2);
  });
});

describe('PointsService 时间工具', () => {
  it('todayKey 用本地日期并补零', () => {
    const h = harness(new Date(2026, 0, 5, 8, 0, 0));
    expect(h.service.todayKey()).toBe('2026-01-05');
    h.setNow(new Date(2026, 11, 31, 23, 59, 59));
    expect(h.service.todayKey()).toBe('2026-12-31');
  });
});

describe('PointsService.award — 异常', () => {
  it('DB 写失败时向上抛，且回滚并释放连接', async () => {
    const h = harness();
    stubHappyPath(h);
    h.pointsRepo.upsertDelta.mockRejectedValue(new Error('deadlock'));

    await expect(h.service.award(INPUT)).rejects.toThrow('deadlock');

    expect(h.conn.rollback).toHaveBeenCalledTimes(1);
    expect(h.conn.commit).not.toHaveBeenCalled();
    expect(h.conn.release).toHaveBeenCalledTimes(1);
  });

  it('回滚本身失败时仍抛原始错误（连接错误不掩盖真正的失败原因）', async () => {
    const h = harness();
    stubHappyPath(h);
    h.pointsRepo.upsertDelta.mockRejectedValue(new Error('deadlock'));
    h.conn.rollback.mockRejectedValue(new Error('connection lost'));

    // 若 rollback 的错误逃出去，调用方看到的会是 'connection lost' 而不是 'deadlock'
    await expect(h.service.award(INPUT)).rejects.toThrow('deadlock');
    expect(h.conn.rollback).toHaveBeenCalledTimes(1);
    expect(h.conn.release).toHaveBeenCalledTimes(1);
  });
});
