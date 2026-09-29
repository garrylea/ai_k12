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
  await pool.execute(`DELETE FROM family_subscriptions WHERE parent_id IN (?, ?)`, [PARENT_A, PARENT_B]);
  await pool.execute(`DELETE FROM students WHERE id = ? OR parent_id IN (?, ?)`, [STUDENT_ID, PARENT_A, PARENT_B]);
  await pool.execute(`DELETE FROM parents WHERE id IN (?, ?) OR phone IN ('19999990001', '19999990002')`, [PARENT_A, PARENT_B]);
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
