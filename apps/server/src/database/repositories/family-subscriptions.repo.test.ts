import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import 'dotenv/config';
import mysql from 'mysql2/promise';
import type { PoolConnection, RowDataPacket } from 'mysql2/promise';
import { FamilySubscriptionsRepository } from './family-subscriptions.repo';
import { SubscriptionPlansRepository } from './subscription-plans.repo';

/**
 * 真库集成测试（本机 MySQL，库/账号来自 apps/server/.env 的 DB_*）。
 *
 * 测试数据自建自清：家长 id 固定 900001/900002、学生 900101、套餐 plan_code
 * 前缀 `test_plan_`，均远离真实自增区间；beforeAll 先清一次（防上次崩溃残留），
 * afterAll 再清一次。family_subscriptions 随 parents 行 ON DELETE CASCADE，
 * 但仍显式先删（students 对 parents 是 RESTRICT，必须先删学生）。
 */

const PARENT_A = 900001; // 试用 / 续期主用例
const PARENT_B = 900002; // 续期「行不存在」补偿插入用例
const PARENT_C = 900003; // 管理端调整（批④ Task 5）无行用例 / listFamilies
const STUDENT_ID = 900101;

const pool = mysql.createPool({
  host: process.env.DB_HOST || 'localhost',
  port: parseInt(process.env.DB_PORT || '3306', 10),
  user: process.env.DB_USER || 'ai_k12',
  password: process.env.DB_PASS || 'ai_k12',
  database: process.env.DB_NAME || 'ai_k12',
  charset: 'utf8mb4',
});

const subsRepo = new FamilySubscriptionsRepository(pool);
const plansRepo = new SubscriptionPlansRepository(pool);

async function cleanupTestData() {
  await pool.execute(`DELETE FROM family_subscriptions WHERE parent_id IN (?, ?, ?)`, [PARENT_A, PARENT_B, PARENT_C]);
  await pool.execute(
    `DELETE FROM students WHERE id = ? OR parent_id IN (?, ?, ?)`,
    [STUDENT_ID, PARENT_A, PARENT_B, PARENT_C],
  );
  await pool.execute(
    `DELETE FROM parents WHERE id IN (?, ?, ?) OR phone IN ('19999990001', '19999990002', '19999990003')`,
    [PARENT_A, PARENT_B, PARENT_C],
  );
  await pool.execute(`DELETE FROM subscription_plans WHERE plan_code LIKE 'test_plan_%'`);
}

async function seedParentsAndStudent() {
  await pool.execute(
    `INSERT INTO parents (id, phone, password_hash) VALUES (?, '19999990001', 'x'), (?, '19999990002', 'x')`,
    [PARENT_A, PARENT_B],
  );
  await pool.execute(
    `INSERT INTO students (id, parent_id, username, password_hash, age, grade, school_level)
     VALUES (?, ?, 'sub_repo_test_stu', 'x', 10, '5', 'primary')`,
    [STUDENT_ID, PARENT_A],
  );
}

/** 调用方事务样板：repo 只在传入 conn 上执行，commit/rollback 归测试控制。 */
async function inTx(run: (conn: PoolConnection) => Promise<void>) {
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    await run(conn);
    await conn.commit();
  } catch (e) {
    await conn.rollback();
    throw e;
  } finally {
    conn.release();
  }
}

beforeAll(async () => {
  await cleanupTestData();
  await seedParentsAndStudent();
});

afterAll(async () => {
  await cleanupTestData();
  await pool.end();
});

describe('FamilySubscriptionsRepository（真库）', () => {
  it('upsertTrial 首次插入试用行；重复调用是纯兜底，不覆盖已有 trial_ends_at', async () => {
    const first = new Date('2026-10-10T00:00:00');
    const second = new Date('2026-12-31T00:00:00');

    await subsRepo.upsertTrial(PARENT_A, first);
    await subsRepo.upsertTrial(PARENT_A, second);

    const row = await subsRepo.findByParentId(PARENT_A);
    expect(row?.trial_ends_at?.getTime()).toBe(first.getTime());
  });

  it('findByParentId 命中；findByStudentId 经 students JOIN 反查到同一行', async () => {
    const byParent = await subsRepo.findByParentId(PARENT_A);
    expect(byParent).not.toBeNull();

    const byStudent = await subsRepo.findByStudentId(STUDENT_ID);
    expect(byStudent?.trial_ends_at?.getTime()).toBe(byParent?.trial_ends_at?.getTime());
  });

  it('renewWithinTx 期内顺延：base = current_period_end，剩余天数不吞', async () => {
    const now = new Date('2026-09-29T12:00:00');
    const currentEnd = new Date(now.getTime() + 10 * 86_400_000);
    await pool.execute(`UPDATE family_subscriptions SET current_period_end = ? WHERE parent_id = ?`, [currentEnd, PARENT_A]);

    let result!: { currentPeriodEnd: Date };
    await inTx(async (conn) => {
      result = await subsRepo.renewWithinTx(conn, PARENT_A, 'month', 30, now);
    });

    expect(result.currentPeriodEnd.getTime()).toBe(currentEnd.getTime() + 30 * 86_400_000);
    const row = await subsRepo.findByParentId(PARENT_A);
    expect(row?.current_period_end?.getTime()).toBe(currentEnd.getTime() + 30 * 86_400_000);
  });

  it('renewWithinTx 已过期：从 now 起算，不把过期天数续进去', async () => {
    const now = new Date('2026-09-29T12:00:00');
    const staleEnd = new Date(now.getTime() - 1 * 86_400_000);
    await pool.execute(`UPDATE family_subscriptions SET current_period_end = ? WHERE parent_id = ?`, [staleEnd, PARENT_A]);

    let result!: { currentPeriodEnd: Date };
    await inTx(async (conn) => {
      result = await subsRepo.renewWithinTx(conn, PARENT_A, 'month', 30, now);
    });

    expect(result.currentPeriodEnd.getTime()).toBe(now.getTime() + 30 * 86_400_000);
  });

  it('renewWithinTx 行不存在：事务内补偿插入 active 行', async () => {
    const now = new Date('2026-09-29T12:00:00');

    expect(await subsRepo.findByParentId(PARENT_B)).toBeNull();
    let result!: { currentPeriodEnd: Date };
    await inTx(async (conn) => {
      result = await subsRepo.renewWithinTx(conn, PARENT_B, 'year', 365, now);
    });

    expect(result.currentPeriodEnd.getTime()).toBe(now.getTime() + 365 * 86_400_000);
    const [rows] = await pool.execute<RowDataPacket[]>(
      `SELECT status, plan_code, source, current_period_end FROM family_subscriptions WHERE parent_id = ?`,
      [PARENT_B],
    );
    expect(rows[0]).toMatchObject({ status: 'active', plan_code: 'year', source: 'order' });
  });

  it('renewWithinTx 走传入 conn：调用方 rollback 后库内值不变', async () => {
    const now = new Date('2026-09-29T12:00:00');
    const before = await subsRepo.findByParentId(PARENT_A);
    expect(before?.current_period_end).not.toBeNull();

    const conn = await pool.getConnection();
    try {
      await conn.beginTransaction();
      await subsRepo.renewWithinTx(conn, PARENT_A, 'year', 365, now);
      await conn.rollback();
    } finally {
      conn.release();
    }

    const after = await subsRepo.findByParentId(PARENT_A);
    expect(after?.current_period_end?.getTime()).toBe(before?.current_period_end?.getTime());
  });
});

describe('SubscriptionPlansRepository（真库）', () => {
  const activeEarly = { code: 'test_plan_a', sortOrder: 900 };
  const activeLate = { code: 'test_plan_c', sortOrder: 901 };
  const inactive = { code: 'test_plan_b', sortOrder: 902 };

  beforeAll(async () => {
    for (const p of [activeEarly, activeLate, inactive]) {
      await pool.execute(
        `INSERT INTO subscription_plans (plan_code, name, price_cents, duration_days, is_active, sort_order)
         VALUES (?, ?, 2000, 30, ?, ?)`,
        [p.code, p.code, p === inactive ? 0 : 1, p.sortOrder],
      );
    }
  });

  it('listActive 只返回在售套餐且按 sort_order 排序', async () => {
    const rows = await plansRepo.listActive();
    const testRows = rows.filter((r) => r.plan_code.startsWith('test_plan_'));

    expect(testRows.map((r) => r.plan_code)).toEqual([activeEarly.code, activeLate.code]);
    expect(testRows[0]).toMatchObject({ price_cents: 2000, duration_days: 30 });
  });

  it('findActiveByCode 在售命中；下架/不存在返回 null', async () => {
    const hit = await plansRepo.findActiveByCode(activeEarly.code);
    expect(hit?.plan_code).toBe(activeEarly.code);

    expect(await plansRepo.findActiveByCode(inactive.code)).toBeNull();
    expect(await plansRepo.findActiveByCode('test_plan_missing')).toBeNull();
  });
});

/**
 * 批④ Task 5：管理端试用 / 订阅天数管理（真库）。
 * 锁读 + 冗余 status 同步 effectiveStatus 的语义只能对真 MySQL 验证
 * （mock conn 验不了 FOR UPDATE 与 DATETIME 往返），沿用本文件真库先例。
 */
describe('FamilySubscriptionsRepository 管理端调整（批④ Task 5，真库）', () => {
  const now = new Date('2026-09-30T12:00:00');

  beforeAll(async () => {
    await pool.execute(
      `INSERT INTO parents (id, phone, password_hash, name) VALUES (?, '19999990003', 'x', '测家长丙')`,
      [PARENT_C],
    );
  });

  async function setRow(fields: { trialEndsAt?: Date | null; currentPeriodEnd?: Date | null }) {
    // plan_code 一并重置：本 describe 不依赖前面 describe 的续期残留，消除用例间耦合
    const [cntRows] = await pool.execute<RowDataPacket[]>(
      `SELECT COUNT(*) AS n FROM family_subscriptions WHERE parent_id = ?`,
      [PARENT_A],
    );
    if (Number(cntRows[0].n) === 0) {
      await pool.execute(
        `INSERT INTO family_subscriptions (parent_id, status, trial_ends_at, current_period_end, plan_code, source)
         VALUES (?, 'expired', ?, ?, NULL, 'trial')`,
        [PARENT_A, fields.trialEndsAt ?? null, fields.currentPeriodEnd ?? null],
      );
      return;
    }
    await pool.execute(
      `UPDATE family_subscriptions SET trial_ends_at = ?, current_period_end = ?, plan_code = NULL WHERE parent_id = ?`,
      [fields.trialEndsAt ?? null, fields.currentPeriodEnd ?? null, PARENT_A],
    );
  }

  async function readRow() {
    const [rows] = await pool.execute<RowDataPacket[]>(
      `SELECT status, trial_ends_at, current_period_end, plan_code, source FROM family_subscriptions WHERE parent_id = ?`,
      [PARENT_A],
    );
    return rows[0] ?? null;
  }

  // ---------- setTrialWithinTx ----------

  it('setTrialWithinTx 行存在：写 trial_ends_at，冗余 status 同步 trialing', async () => {
    await setRow({ trialEndsAt: null, currentPeriodEnd: null });
    const trialEndsAt = new Date(now.getTime() + 5 * 86_400_000);

    await inTx(async (conn) => {
      await subsRepo.setTrialWithinTx(conn, PARENT_A, trialEndsAt, now);
    });

    const row = await readRow();
    expect(row?.trial_ends_at?.getTime()).toBe(trialEndsAt.getTime());
    expect(row?.status).toBe('trialing');
  });

  it('setTrialWithinTx null（收回）：trial_ends_at 置 NULL、status=expired', async () => {
    await setRow({ trialEndsAt: new Date(now.getTime() + 5 * 86_400_000), currentPeriodEnd: null });

    await inTx(async (conn) => {
      await subsRepo.setTrialWithinTx(conn, PARENT_A, null, now);
    });

    const row = await readRow();
    expect(row?.trial_ends_at).toBeNull();
    expect(row?.status).toBe('expired');
  });

  it('setTrialWithinTx 行有未来付费期：status 同步 active（付费期优先于试用）', async () => {
    const periodEnd = new Date(now.getTime() + 10 * 86_400_000);
    await setRow({ trialEndsAt: null, currentPeriodEnd: periodEnd });

    await inTx(async (conn) => {
      await subsRepo.setTrialWithinTx(conn, PARENT_A, new Date(now.getTime() + 3 * 86_400_000), now);
    });

    const row = await readRow();
    expect(row?.status).toBe('active');
    expect(row?.current_period_end?.getTime()).toBe(periodEnd.getTime()); // 不碰付费期
  });

  it('setTrialWithinTx 无行：补插 trialing 行（source=trial）', async () => {
    await pool.execute(`DELETE FROM family_subscriptions WHERE parent_id = ?`, [PARENT_C]);
    const trialEndsAt = new Date(now.getTime() + 5 * 86_400_000);

    await inTx(async (conn) => {
      await subsRepo.setTrialWithinTx(conn, PARENT_C, trialEndsAt, now);
    });

    const [rows] = await pool.execute<RowDataPacket[]>(
      `SELECT status, trial_ends_at, current_period_end, source FROM family_subscriptions WHERE parent_id = ?`,
      [PARENT_C],
    );
    expect(rows[0]).toMatchObject({ status: 'trialing', source: 'trial', current_period_end: null });
    expect(rows[0].trial_ends_at.getTime()).toBe(trialEndsAt.getTime());
  });

  it('setTrialWithinTx 无行 + null（收回）：不建行', async () => {
    await pool.execute(`DELETE FROM family_subscriptions WHERE parent_id = ?`, [PARENT_C]);

    await inTx(async (conn) => {
      await subsRepo.setTrialWithinTx(conn, PARENT_C, null, now);
    });

    expect(await subsRepo.findByParentId(PARENT_C)).toBeNull();
  });

  // ---------- adjustPeriodWithinTx ----------

  it('adjustPeriodWithinTx 正数：期内从期末顺延，不吞剩余天数', async () => {
    const periodEnd = new Date(now.getTime() + 10 * 86_400_000);
    await setRow({ trialEndsAt: null, currentPeriodEnd: periodEnd });

    let result!: { currentPeriodEnd: Date | null };
    await inTx(async (conn) => {
      result = await subsRepo.adjustPeriodWithinTx(conn, PARENT_A, 30, now);
    });

    expect(result.currentPeriodEnd?.getTime()).toBe(periodEnd.getTime() + 30 * 86_400_000);
    expect((await readRow())?.status).toBe('active');
  });

  it('adjustPeriodWithinTx 正数：已过期从 now 起算', async () => {
    const staleEnd = new Date(now.getTime() - 3 * 86_400_000);
    await setRow({ trialEndsAt: null, currentPeriodEnd: staleEnd });

    let result!: { currentPeriodEnd: Date | null };
    await inTx(async (conn) => {
      result = await subsRepo.adjustPeriodWithinTx(conn, PARENT_A, 30, now);
    });

    expect(result.currentPeriodEnd?.getTime()).toBe(now.getTime() + 30 * 86_400_000);
  });

  it('adjustPeriodWithinTx 正数：无行 → 补偿插入 active 行（source=admin，同 renewWithinTx 先例）', async () => {
    await pool.execute(`DELETE FROM family_subscriptions WHERE parent_id = ?`, [PARENT_C]);

    let result!: { currentPeriodEnd: Date | null };
    await inTx(async (conn) => {
      result = await subsRepo.adjustPeriodWithinTx(conn, PARENT_C, 15, now);
    });

    expect(result.currentPeriodEnd?.getTime()).toBe(now.getTime() + 15 * 86_400_000);
    const [rows] = await pool.execute<RowDataPacket[]>(
      `SELECT status, current_period_end, source FROM family_subscriptions WHERE parent_id = ?`,
      [PARENT_C],
    );
    expect(rows[0]).toMatchObject({ status: 'active', source: 'admin' });
  });

  it('adjustPeriodWithinTx 负数：从期末扣减', async () => {
    const periodEnd = new Date(now.getTime() + 10 * 86_400_000);
    await setRow({ trialEndsAt: null, currentPeriodEnd: periodEnd });

    let result!: { currentPeriodEnd: Date | null };
    await inTx(async (conn) => {
      result = await subsRepo.adjustPeriodWithinTx(conn, PARENT_A, -3, now);
    });

    expect(result.currentPeriodEnd?.getTime()).toBe(periodEnd.getTime() - 3 * 86_400_000);
    expect((await readRow())?.status).toBe('active');
  });

  it('adjustPeriodWithinTx 负数扣穿：current_period_end 置 NULL（过期态）、status=expired', async () => {
    const periodEnd = new Date(now.getTime() + 1 * 86_400_000);
    await setRow({ trialEndsAt: null, currentPeriodEnd: periodEnd });

    let result!: { currentPeriodEnd: Date | null };
    await inTx(async (conn) => {
      result = await subsRepo.adjustPeriodWithinTx(conn, PARENT_A, -3, now);
    });

    expect(result.currentPeriodEnd).toBeNull();
    const row = await readRow();
    expect(row?.current_period_end).toBeNull();
    expect(row?.status).toBe('expired');
  });

  it('adjustPeriodWithinTx 负数：无未来期（period 已过期）→ 行不动', async () => {
    const staleEnd = new Date(now.getTime() - 3 * 86_400_000);
    await setRow({ trialEndsAt: null, currentPeriodEnd: staleEnd });

    let result!: { currentPeriodEnd: Date | null };
    await inTx(async (conn) => {
      result = await subsRepo.adjustPeriodWithinTx(conn, PARENT_A, -3, now);
    });

    expect(result.currentPeriodEnd?.getTime()).toBe(staleEnd.getTime());
  });

  it('adjustPeriodWithinTx 负数：无行 → 不建行', async () => {
    await pool.execute(`DELETE FROM family_subscriptions WHERE parent_id = ?`, [PARENT_C]);

    let result!: { currentPeriodEnd: Date | null };
    await inTx(async (conn) => {
      result = await subsRepo.adjustPeriodWithinTx(conn, PARENT_C, -3, now);
    });

    expect(result.currentPeriodEnd).toBeNull();
    expect(await subsRepo.findByParentId(PARENT_C)).toBeNull();
  });

  it('adjustPeriodWithinTx 走传入 conn：rollback 后库内值不变（与业务写同生共死）', async () => {
    const periodEnd = new Date(now.getTime() + 10 * 86_400_000);
    await setRow({ trialEndsAt: null, currentPeriodEnd: periodEnd });

    const conn = await pool.getConnection();
    try {
      await conn.beginTransaction();
      await subsRepo.adjustPeriodWithinTx(conn, PARENT_A, 30, now);
      await conn.rollback();
    } finally {
      conn.release();
    }

    expect((await readRow())?.current_period_end?.getTime()).toBe(periodEnd.getTime());
  });

  // ---------- parentExists ----------

  it('parentExists：存在 true；不存在 / 软删 false', async () => {
    expect(await subsRepo.parentExists(PARENT_A)).toBe(true);
    expect(await subsRepo.parentExists(999999999)).toBe(false);
  });

  // ---------- listFamilies ----------

  it('listFamilies：keyword 手机号命中，字段齐全（studentCount / status / ISO 源头 Date）', async () => {
    await setRow({ trialEndsAt: new Date(now.getTime() + 5 * 86_400_000), currentPeriodEnd: null });

    const { total, rows } = await subsRepo.listFamilies('19999990001', 1, 20);

    expect(total).toBe(1);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      parent_id: PARENT_A,
      phone: '19999990001',
      student_count: 1, // STUDENT_ID 挂在 PARENT_A 下
      plan_code: null,
    });
    expect(rows[0].trial_ends_at).toBeInstanceOf(Date);
    expect(rows[0].current_period_end).toBeNull();
  });

  it('listFamilies：keyword 昵称命中多个；分页 total 不随页变、无订阅行家庭 status 侧字段为 null', async () => {
    await pool.execute(`UPDATE parents SET name = '测家长甲' WHERE id = ?`, [PARENT_A]);
    await pool.execute(`UPDATE parents SET name = '普通家长乙' WHERE id = ?`, [PARENT_B]);

    const page1 = await subsRepo.listFamilies('测家长', 1, 1);
    const page2 = await subsRepo.listFamilies('测家长', 2, 1);

    // '测家长' 命中 PARENT_A（测家长甲）与 PARENT_C（测家长丙），不命中 PARENT_B
    expect(page1.total).toBe(2);
    expect(page1.rows).toHaveLength(1);
    expect(page2.rows).toHaveLength(1);
    expect(page1.rows[0].parent_id).not.toBe(page2.rows[0].parent_id);
    // PARENT_C 无订阅行、无学生：LEFT JOIN 侧字段全 null、studentCount=0
    const all = await subsRepo.listFamilies('测家长', 1, 10);
    const cRow = all.rows.find((r) => r.parent_id === PARENT_C);
    expect(cRow).toBeDefined();
    expect(Number(cRow!.student_count)).toBe(0);
    expect(cRow!.trial_ends_at).toBeNull();
    expect(cRow!.current_period_end).toBeNull();
  });

  it('listFamilies：无命中 keyword → total 0 空列表；null keyword 返回全量分页', async () => {
    expect((await subsRepo.listFamilies('不存在的关键词xyz', 1, 20)).total).toBe(0);
    const all = await subsRepo.listFamilies(null, 1, 1);
    expect(all.rows).toHaveLength(1);
    expect(all.total).toBeGreaterThanOrEqual(2);
  });
});
