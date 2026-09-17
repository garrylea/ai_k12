import { describe, it, expect, vi } from 'vitest';
import type { Pool } from 'mysql2/promise';
import { RedemptionService } from './redemption.service.js';
import { levelOf } from './levels.js';
import type { ControlsRepository, ControlsSnapshot } from '../../database/repositories/controls.repo.js';
import type {
  RewardCatalogRepository,
  RewardCatalogRow,
} from '../../database/repositories/reward-catalog.repo.js';
import type {
  PointRedemptionsRepository,
  PointRedemptionRow,
} from '../../database/repositories/point-redemptions.repo.js';
import type { PointLedgerRepository } from '../../database/repositories/point-ledger.repo.js';
import type { StudentPointsRepository } from '../../database/repositories/student-points.repo.js';

type CatalogFixture = Omit<RewardCatalogRow, 'constructor'>;
type RedemptionFixture = Omit<PointRedemptionRow, 'constructor'>;

const STAMP = new Date(2026, 8, 17, 12, 0, 0, 0);

function catalogRow(over: Partial<CatalogFixture> = {}): RewardCatalogRow {
  const base: CatalogFixture = {
    id: 5,
    student_id: 1,
    name: '换个乐高',
    description: null,
    points_cost: 80,
    min_level_code: null,
    is_active: 1,
    sort_order: 0,
    created_at: STAMP,
    updated_at: STAMP,
  };
  return { ...base, ...over } as RewardCatalogRow;
}

function redemptionRow(over: Partial<RedemptionFixture> = {}): PointRedemptionRow {
  const base: RedemptionFixture = {
    id: 55,
    student_id: 1,
    type: 'cash',
    points_spent: 100,
    cash_amount: '5.00',
    reward_catalog_id: null,
    reward_name: null,
    status: 'pending',
    note: null,
    ledger_id: 900,
    created_at: STAMP,
    fulfilled_at: null,
  };
  return { ...base, ...over } as PointRedemptionRow;
}

/** 被测服务的全部依赖都是 mock：本用例不连真库。 */
function harness(startNow = new Date(2026, 8, 17, 12, 0, 0)) {
  let current = startNow;
  const controlsRepo = { ensure: vi.fn(), findByStudent: vi.fn() };
  const catalogRepo = {
    listByStudent: vi.fn().mockResolvedValue([] as RewardCatalogRow[]),
    findOne: vi.fn().mockResolvedValue(null),
    insert: vi.fn().mockResolvedValue(99),
    update: vi.fn().mockResolvedValue(1),
    deactivateMissing: vi.fn().mockResolvedValue(undefined),
  };
  const redemptionsRepo = {
    insert: vi.fn().mockResolvedValue(55),
    setLedgerId: vi.fn().mockResolvedValue(1),
    findOne: vi.fn().mockResolvedValue(null),
    listByStudent: vi.fn().mockResolvedValue([] as PointRedemptionRow[]),
    countByStudent: vi.fn().mockResolvedValue(0),
    updateStatus: vi.fn().mockResolvedValue(1),
  };
  const ledgerRepo = { insert: vi.fn().mockResolvedValue({ id: 900, duplicate: false }) };
  const pointsRepo = {
    find: vi.fn(),
    // 条件扣减的默认桩：余额够（affectedRows=1）。并发用例会改回 0。
    deductBalanceIfEnough: vi.fn().mockResolvedValue(1),
  };
  const conn = {
    beginTransaction: vi.fn().mockResolvedValue(undefined),
    commit: vi.fn().mockResolvedValue(undefined),
    rollback: vi.fn().mockResolvedValue(undefined),
    release: vi.fn(),
  };
  const pool = { getConnection: vi.fn().mockResolvedValue(conn) };
  const service = new RedemptionService(
    pool as unknown as Pool,
    controlsRepo as unknown as ControlsRepository,
    catalogRepo as unknown as RewardCatalogRepository,
    redemptionsRepo as unknown as PointRedemptionsRepository,
    ledgerRepo as unknown as PointLedgerRepository,
    pointsRepo as unknown as StudentPointsRepository,
    () => current,
  );
  return {
    service,
    controlsRepo,
    catalogRepo,
    redemptionsRepo,
    ledgerRepo,
    pointsRepo,
    conn,
    pool,
    setNow: (d: Date) => {
      current = d;
    },
  };
}

/** 通用桩：兑换开关打开、余额 100、累计 501（刚好过铸铁线 500）。 */
function stubControls(h: ReturnType<typeof harness>, over: Partial<ControlsSnapshot> = {}) {
  h.controlsRepo.findByStudent.mockResolvedValue({
    pointsPerYuan: 20,
    rewardRedemptionEnabled: true,
    ...over,
  });
}

describe('RedemptionService.redeem — 换钱', () => {
  it('points=100 / pointsPerYuan=20 → cashAmount=5.00，一条 redeem 负流水 + 快照只扣余额', async () => {
    const h = harness();
    stubControls(h);
    h.pointsRepo.find
      .mockResolvedValueOnce({ totalEarned: 501, balance: 100 }) // 事务前
      .mockResolvedValueOnce({ totalEarned: 501, balance: 0 }); // 事务后（累计必须没变）

    const result = await h.service.redeem(1, { type: 'cash', points: 100 });

    expect(h.controlsRepo.ensure).toHaveBeenCalledWith(1);
    expect(h.redemptionsRepo.insert).toHaveBeenCalledWith(
      {
        student_id: 1,
        type: 'cash',
        points_spent: 100,
        cash_amount: 5,
        reward_catalog_id: null,
        reward_name: null,
        note: null,
      },
      h.conn,
    );
    expect(h.ledgerRepo.insert).toHaveBeenCalledWith(
      {
        student_id: 1,
        kind: 'redeem',
        task_code: 'redeem',
        tier_key: 'default',
        points: -100,
        dedupe_key: 'redeem:55',
        title: '兑换 · 现金 ¥5.00',
        ref_type: null,
        ref_id: null,
        redemption_id: 55,
      },
      h.conn,
    );
    // 关键：条件扣减只动余额（SQL 里没有 total_earned），兑换绝不碰累计分
    expect(h.pointsRepo.deductBalanceIfEnough).toHaveBeenCalledWith(1, 100, h.conn);
    expect(h.redemptionsRepo.setLedgerId).toHaveBeenCalledWith(1, 55, 900, h.conn);
    expect(h.conn.commit).toHaveBeenCalledTimes(1);
    expect(h.conn.rollback).not.toHaveBeenCalled();
    expect(h.conn.release).toHaveBeenCalledTimes(1);

    expect(result).toMatchObject({ balance: 0, totalEarned: 501 });
    expect(result.level.code).toBe('zhutie');
    expect(result.redemption).toMatchObject({
      id: 55,
      type: 'cash',
      pointsSpent: 100,
      cashAmount: 5,
      status: 'pending',
    });
  });

  it('金额保留 2 位小数：10 分 / 3 分每元 → 3.33', async () => {
    const h = harness();
    stubControls(h, { pointsPerYuan: 3 });
    h.pointsRepo.find
      .mockResolvedValueOnce({ totalEarned: 10, balance: 10 })
      .mockResolvedValueOnce({ totalEarned: 10, balance: 0 });

    const result = await h.service.redeem(1, { type: 'cash', points: 10 });

    expect(result.redemption.cashAmount).toBe(3.33);
    expect(h.ledgerRepo.insert.mock.calls[0][0].title).toBe('兑换 · 现金 ¥3.33');
  });

  it('非默认汇率也按整数运算取整：201 分 / 200 分每元 → 1.01（浮点写法会错成 1.00）', async () => {
    const h = harness();
    stubControls(h, { pointsPerYuan: 200 });
    h.pointsRepo.find
      .mockResolvedValueOnce({ totalEarned: 501, balance: 1000 })
      .mockResolvedValueOnce({ totalEarned: 501, balance: 799 });

    const result = await h.service.redeem(1, { type: 'cash', points: 201 });

    // Math.round((201 / 200) * 100) / 100 === 1.00（201/200*100 = 100.49999999999999）
    // 文档公式 ROUND(201 / 200, 2) === 1.01，必须与之一致
    expect(result.redemption.cashAmount).toBe(1.01);
    expect(h.redemptionsRepo.insert.mock.calls[0][0].cash_amount).toBe(1.01);
    expect(h.ledgerRepo.insert.mock.calls[0][0].title).toBe('兑换 · 现金 ¥1.01');
  });

  it('points_per_yuan 缺失/非正数 → 兜底 20', async () => {
    const h = harness();
    stubControls(h, { pointsPerYuan: 0 });
    h.pointsRepo.find
      .mockResolvedValueOnce({ totalEarned: 0, balance: 100 })
      .mockResolvedValueOnce({ totalEarned: 0, balance: 0 });

    const result = await h.service.redeem(1, { type: 'cash', points: 100 });

    expect(result.redemption.cashAmount).toBe(5);
  });

  it('points <= 0 / 非整数 → 1001，且不写任何数据', async () => {
    const h = harness();
    stubControls(h);

    await expect(h.service.redeem(1, { type: 'cash', points: 0 })).rejects.toMatchObject({
      response: { code: 1001 },
    });
    await expect(h.service.redeem(1, { type: 'cash', points: -5 })).rejects.toMatchObject({
      response: { code: 1001 },
    });
    await expect(h.service.redeem(1, { type: 'cash', points: 1.5 })).rejects.toMatchObject({
      response: { code: 1001 },
    });

    expect(h.redemptionsRepo.insert).not.toHaveBeenCalled();
    expect(h.ledgerRepo.insert).not.toHaveBeenCalled();
    expect(h.pool.getConnection).not.toHaveBeenCalled();
  });
});

describe('RedemptionService.redeem — 兑换奖励', () => {
  it('奖励可兑：points_cost 作为扣分，reward_name 存快照，min_level 满足', async () => {
    const h = harness();
    stubControls(h);
    h.catalogRepo.findOne.mockResolvedValue(catalogRow({ min_level_code: 'zhutie', points_cost: 80 }));
    h.pointsRepo.find
      .mockResolvedValueOnce({ totalEarned: 501, balance: 100 })
      .mockResolvedValueOnce({ totalEarned: 501, balance: 20 });

    const result = await h.service.redeem(1, { type: 'reward', catalogId: 5 });

    expect(h.redemptionsRepo.insert.mock.calls[0][0]).toMatchObject({
      type: 'reward',
      points_spent: 80,
      cash_amount: null,
      reward_catalog_id: 5,
      reward_name: '换个乐高',
    });
    expect(h.ledgerRepo.insert.mock.calls[0][0]).toMatchObject({
      points: -80,
      title: '兑换 · 换个乐高',
    });
    expect(h.pointsRepo.deductBalanceIfEnough).toHaveBeenCalledWith(1, 80, h.conn);
    expect(result.balance).toBe(20);
    expect(result.totalEarned).toBe(501);
    expect(result.redemption.cashAmount).toBeNull();
    expect(result.redemption.rewardName).toBe('换个乐高');
  });

  it('catalog 行不存在（含别人的 id）→ 1002，不写任何数据', async () => {
    const h = harness();
    stubControls(h);
    h.catalogRepo.findOne.mockResolvedValue(null);

    await expect(h.service.redeem(1, { type: 'reward', catalogId: 5 })).rejects.toMatchObject({
      response: { code: 1002 },
    });

    expect(h.redemptionsRepo.insert).not.toHaveBeenCalled();
    expect(h.pool.getConnection).not.toHaveBeenCalled();
  });

  it('is_active=0 → 3003', async () => {
    const h = harness();
    stubControls(h);
    h.catalogRepo.findOne.mockResolvedValue(catalogRow({ is_active: 0 }));

    await expect(h.service.redeem(1, { type: 'reward', catalogId: 5 })).rejects.toMatchObject({
      response: { code: 3003 },
    });
    expect(h.redemptionsRepo.insert).not.toHaveBeenCalled();
  });

  it('未达 min_level_code → 3002（501 分是铸铁，门槛黄金 3000 分不满足）', async () => {
    const h = harness();
    stubControls(h);
    h.catalogRepo.findOne.mockResolvedValue(catalogRow({ min_level_code: 'huangjin' }));
    h.pointsRepo.find.mockResolvedValue({ totalEarned: 501, balance: 100 });

    await expect(h.service.redeem(1, { type: 'reward', catalogId: 5 })).rejects.toMatchObject({
      response: { code: 3002 },
    });

    expect(h.pointsRepo.deductBalanceIfEnough).not.toHaveBeenCalled();
    expect(h.redemptionsRepo.insert).not.toHaveBeenCalled();
  });

  it('min_level_code 恰好等于当前段位 → 放行（边界：>= 不是 >）', async () => {
    const h = harness();
    stubControls(h);
    h.catalogRepo.findOne.mockResolvedValue(catalogRow({ min_level_code: 'zhutie', points_cost: 80 }));
    h.pointsRepo.find
      .mockResolvedValueOnce({ totalEarned: 501, balance: 100 })
      .mockResolvedValueOnce({ totalEarned: 501, balance: 20 });

    await expect(h.service.redeem(1, { type: 'reward', catalogId: 5 })).resolves.toBeDefined();
  });
});

describe('RedemptionService.redeem — 通用校验', () => {
  it('兑换总开关关掉 → 3004，且早于任何其它校验', async () => {
    const h = harness();
    stubControls(h, { rewardRedemptionEnabled: false });

    await expect(h.service.redeem(1, { type: 'cash', points: 100 })).rejects.toMatchObject({
      response: { code: 3004 },
    });

    // 开关关闭时不查快照、不开事务
    expect(h.pointsRepo.find).not.toHaveBeenCalled();
    expect(h.pool.getConnection).not.toHaveBeenCalled();
    expect(h.catalogRepo.findOne).not.toHaveBeenCalled();
  });

  it('余额不足 → 3001，且没有任何流水/兑换单写入', async () => {
    const h = harness();
    stubControls(h);
    h.pointsRepo.find.mockResolvedValue({ totalEarned: 501, balance: 50 });

    await expect(h.service.redeem(1, { type: 'cash', points: 100 })).rejects.toMatchObject({
      response: { code: 3001, message: '积分余额不足' },
    });

    expect(h.redemptionsRepo.insert).not.toHaveBeenCalled();
    expect(h.ledgerRepo.insert).not.toHaveBeenCalled();
    expect(h.pointsRepo.deductBalanceIfEnough).not.toHaveBeenCalled();
    expect(h.pool.getConnection).not.toHaveBeenCalled();
  });

  it('余额刚好等于 points_spent → 放行（>= 边界）', async () => {
    const h = harness();
    stubControls(h);
    h.pointsRepo.find
      .mockResolvedValueOnce({ totalEarned: 100, balance: 100 })
      .mockResolvedValueOnce({ totalEarned: 100, balance: 0 });

    await expect(h.service.redeem(1, { type: 'cash', points: 100 })).resolves.toBeDefined();
  });

  it('事务失败 → 回滚并释放连接，原始错误向上抛', async () => {
    const h = harness();
    stubControls(h);
    h.pointsRepo.find.mockResolvedValue({ totalEarned: 501, balance: 100 });
    h.pointsRepo.deductBalanceIfEnough.mockRejectedValue(new Error('deadlock'));

    await expect(h.service.redeem(1, { type: 'cash', points: 100 })).rejects.toThrow('deadlock');

    expect(h.conn.rollback).toHaveBeenCalledTimes(1);
    expect(h.conn.commit).not.toHaveBeenCalled();
    expect(h.conn.release).toHaveBeenCalledTimes(1);
  });

  it('type 非法 → 1001，且早于任何 DB 访问（不开事务、不查开关/快照）', async () => {
    const h = harness();
    stubControls(h);

    await expect(
      h.service.redeem(1, { type: 'bogus' } as never),
    ).rejects.toMatchObject({ response: { code: 1001 } });

    expect(h.controlsRepo.ensure).not.toHaveBeenCalled();
    expect(h.controlsRepo.findByStudent).not.toHaveBeenCalled();
    expect(h.pointsRepo.find).not.toHaveBeenCalled();
    expect(h.catalogRepo.findOne).not.toHaveBeenCalled();
    expect(h.pool.getConnection).not.toHaveBeenCalled();
  });

  it('【并发钉子】事务前快照显示余额充足，但条件扣减 affectedRows=0 → 3001 并回滚（权威闸门）', async () => {
    const h = harness();
    stubControls(h);
    // advisory 预检看到余额够（两次并发都读到 100），预检放行
    h.pointsRepo.find.mockResolvedValue({ totalEarned: 501, balance: 100 });
    // 但真正扣减时余额已被并发的那一次掏空：条件 UPDATE 没匹配到行
    h.pointsRepo.deductBalanceIfEnough.mockResolvedValue(0);

    await expect(h.service.redeem(1, { type: 'cash', points: 100 })).rejects.toMatchObject({
      response: { code: 3001, message: '积分余额不足' },
    });

    // 权威闸门在事务内、用事务连接执行
    expect(h.pointsRepo.deductBalanceIfEnough).toHaveBeenCalledWith(1, 100, h.conn);
    // 半张兑换单/流水必须随事务一起回滚，绝不能 commit
    expect(h.conn.commit).not.toHaveBeenCalled();
    expect(h.conn.rollback).toHaveBeenCalledTimes(1);
    expect(h.conn.release).toHaveBeenCalledTimes(1);
  });
});

describe('RedemptionService.redeem — 段位只升不降（核心钉子）', () => {
  it('兑换后 totalEarned 不变 → levelOf 结果不变（501 分始终是铸铁）', async () => {
    const h = harness();
    stubControls(h);
    const before = { totalEarned: 501, balance: 501 };
    // 库里兑换后只扣了余额，total_earned 原样
    const after = { totalEarned: 501, balance: 401 };
    h.pointsRepo.find.mockResolvedValueOnce(before).mockResolvedValueOnce(after);

    const result = await h.service.redeem(1, { type: 'cash', points: 100 });

    // 兑换前就是铸铁（500 阈值），兑换后必须还是铸铁
    expect(levelOf(before.totalEarned).code).toBe('zhutie');
    expect(result.totalEarned).toBe(before.totalEarned);
    expect(levelOf(result.totalEarned).code).toBe(levelOf(before.totalEarned).code);
    expect(result.level.code).toBe('zhutie');
    // 唯一能保证这一点的写法：扣余额走条件 UPDATE，SQL 只 SET balance、不写 total_earned
    expect(h.pointsRepo.deductBalanceIfEnough).toHaveBeenCalledWith(1, 100, h.conn);
  });
});

describe('RedemptionService.listForStudent — 学生端只读', () => {
  it('只返回 active 项，并标注 affordable / levelOk / gap', async () => {
    const h = harness();
    h.catalogRepo.listByStudent.mockResolvedValue([
      catalogRow({ id: 1, name: '便宜', points_cost: 30, min_level_code: null }),
      catalogRow({ id: 2, name: '贵', points_cost: 150, min_level_code: null }),
      catalogRow({ id: 3, name: '段位不够', points_cost: 10, min_level_code: 'wangzhe' }),
    ]);
    h.pointsRepo.find.mockResolvedValue({ totalEarned: 501, balance: 100 });

    const view = await h.service.listForStudent(1);

    expect(h.catalogRepo.listByStudent).toHaveBeenCalledWith(1);
    expect(view.balance).toBe(100);
    expect(view.level.code).toBe('zhutie');
    expect(view.items).toEqual([
      {
        id: 1,
        name: '便宜',
        description: null,
        pointsCost: 30,
        minLevelCode: null,
        affordable: true,
        levelOk: true,
        gap: 0,
      },
      {
        id: 2,
        name: '贵',
        description: null,
        pointsCost: 150,
        minLevelCode: null,
        affordable: false,
        levelOk: true,
        gap: 50,
      },
      {
        id: 3,
        name: '段位不够',
        description: null,
        pointsCost: 10,
        minLevelCode: 'wangzhe',
        affordable: true,
        levelOk: false,
        gap: 0,
      },
    ]);
  });

  it('未知 min_level_code（脏数据）→ levelOk=false，不抛错', async () => {
    const h = harness();
    h.catalogRepo.listByStudent.mockResolvedValue([catalogRow({ min_level_code: 'not-a-level' })]);
    h.pointsRepo.find.mockResolvedValue({ totalEarned: 99999, balance: 99999 });

    const view = await h.service.listForStudent(1);

    expect(view.items[0].levelOk).toBe(false);
  });
});

describe('RedemptionService — 家长奖励清单', () => {
  it('listCatalog 回传全部行（含已下架），isActive 为布尔', async () => {
    const h = harness();
    h.catalogRepo.listByStudent.mockResolvedValue([
      catalogRow({ id: 1, is_active: 1 }),
      catalogRow({ id: 2, is_active: 0 }),
    ]);

    const rows = await h.service.listCatalog(1);

    expect(rows.map((r) => r.isActive)).toEqual([true, false]);
  });

  it('saveCatalog：无 id 新增、有 id 更新、消失的 id 软删，全在一个事务里', async () => {
    const h = harness();
    h.catalogRepo.insert.mockResolvedValue(99);
    h.catalogRepo.listByStudent.mockResolvedValue([]);

    await h.service.saveCatalog(1, [
      { id: 5, name: '改名', pointsCost: 60 },
      { name: '新增', pointsCost: 30, minLevelCode: 'zhutie', sortOrder: 2 },
    ]);

    expect(h.catalogRepo.update).toHaveBeenCalledWith(
      1,
      5,
      {
        name: '改名',
        description: null,
        pointsCost: 60,
        minLevelCode: null,
        isActive: true,
        sortOrder: 0,
      },
      h.conn,
    );
    expect(h.catalogRepo.insert).toHaveBeenCalledWith(
      1,
      {
        name: '新增',
        description: null,
        pointsCost: 30,
        minLevelCode: 'zhutie',
        isActive: true,
        sortOrder: 2,
      },
      h.conn,
    );
    // 保留 id = payload 里的 5 + 新增生成的 99
    expect(h.catalogRepo.deactivateMissing).toHaveBeenCalledWith(1, [5, 99], h.conn);
    expect(h.conn.commit).toHaveBeenCalledTimes(1);
    expect(h.conn.release).toHaveBeenCalledTimes(1);
  });

  it('saveCatalog：payload 为空 → 全部软删', async () => {
    const h = harness();

    await h.service.saveCatalog(1, []);

    expect(h.catalogRepo.insert).not.toHaveBeenCalled();
    expect(h.catalogRepo.update).not.toHaveBeenCalled();
    expect(h.catalogRepo.deactivateMissing).toHaveBeenCalledWith(1, [], h.conn);
  });

  it('saveCatalog：非法 points_cost（0 / 非整数 / 超上限）→ 1001，且先校验后碰 DB', async () => {
    const h = harness();

    await expect(h.service.saveCatalog(1, [{ name: 'x', pointsCost: 0 }])).rejects.toMatchObject({
      response: { code: 1001 },
    });
    await expect(h.service.saveCatalog(1, [{ name: 'x', pointsCost: 1.5 }])).rejects.toMatchObject({
      response: { code: 1001 },
    });
    await expect(h.service.saveCatalog(1, [{ name: 'x', pointsCost: 1_000_000 }])).rejects.toMatchObject({
      response: { code: 1001 },
    });

    expect(h.pool.getConnection).not.toHaveBeenCalled();
  });

  it('saveCatalog：非法 min_level_code / 空名字 → 1001', async () => {
    const h = harness();

    await expect(
      h.service.saveCatalog(1, [{ name: 'x', pointsCost: 10, minLevelCode: 'bogus' }]),
    ).rejects.toMatchObject({ response: { code: 1001 } });
    await expect(h.service.saveCatalog(1, [{ name: '', pointsCost: 10 }])).rejects.toMatchObject({
      response: { code: 1001 },
    });

    expect(h.pool.getConnection).not.toHaveBeenCalled();
  });

  it('saveCatalog：更新不存在的 id（affectedRows 0）→ 1001 并回滚整批', async () => {
    const h = harness();
    h.catalogRepo.update.mockResolvedValue(0);

    await expect(h.service.saveCatalog(1, [{ id: 777, name: 'x', pointsCost: 10 }])).rejects.toMatchObject(
      { response: { code: 1001 } },
    );

    expect(h.conn.rollback).toHaveBeenCalledTimes(1);
    expect(h.conn.commit).not.toHaveBeenCalled();
  });
});

describe('RedemptionService — 兑换记录', () => {
  it('listRedemptions 分页并把 DECIMAL 金额转成 number', async () => {
    const h = harness();
    h.redemptionsRepo.listByStudent.mockResolvedValue([redemptionRow()]);
    h.redemptionsRepo.countByStudent.mockResolvedValue(1);

    const page = await h.service.listRedemptions(1, 2, 10);

    expect(h.redemptionsRepo.listByStudent).toHaveBeenCalledWith(1, 10, 10);
    expect(h.redemptionsRepo.countByStudent).toHaveBeenCalledWith(1);
    expect(page).toMatchObject({ total: 1, page: 2, pageSize: 10 });
    expect(page.items[0]).toMatchObject({
      id: 55,
      type: 'cash',
      pointsSpent: 100,
      cashAmount: 5,
      status: 'pending',
    });
    expect(typeof page.items[0].cashAmount).toBe('number');
  });

  it('setRedemptionStatus fulfilled → 只写 status/fulfilled_at，绝不动积分', async () => {
    const h = harness(new Date(2026, 8, 17, 12, 0, 0));

    await h.service.setRedemptionStatus(1, 55, 'fulfilled');

    expect(h.redemptionsRepo.updateStatus).toHaveBeenCalledWith(1, 55, 'fulfilled', STAMP);
    expect(h.ledgerRepo.insert).not.toHaveBeenCalled();
    expect(h.pointsRepo.deductBalanceIfEnough).not.toHaveBeenCalled();
    expect(h.pool.getConnection).not.toHaveBeenCalled();
  });

  it('setRedemptionStatus pending → fulfilled_at 清空', async () => {
    const h = harness();

    await h.service.setRedemptionStatus(1, 55, 'pending');

    expect(h.redemptionsRepo.updateStatus).toHaveBeenCalledWith(1, 55, 'pending', null);
  });

  it('setRedemptionStatus 非法状态 → 1001', async () => {
    const h = harness();

    await expect(
      h.service.setRedemptionStatus(1, 55, 'cancelled' as never),
    ).rejects.toMatchObject({ response: { code: 1001 } });
    expect(h.redemptionsRepo.updateStatus).not.toHaveBeenCalled();
  });

  it('setRedemptionStatus 兑换单不存在/不属于该生（affectedRows 0）→ 1002', async () => {
    const h = harness();
    h.redemptionsRepo.updateStatus.mockResolvedValue(0);

    await expect(h.service.setRedemptionStatus(1, 55, 'fulfilled')).rejects.toMatchObject({
      response: { code: 1002 },
    });
  });
});
