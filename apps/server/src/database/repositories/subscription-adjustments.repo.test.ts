import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import 'dotenv/config';
import mysql from 'mysql2/promise';
import type { PoolConnection, RowDataPacket } from 'mysql2/promise';
import { SubscriptionAdjustmentsRepository } from './subscription-adjustments.repo';

/**
 * 真库集成测试（同 family-subscriptions.repo.test.ts 的库/账号口径）。
 * 家长 id 900011 远离真实自增区间，自建自清；subscription_adjustments 对
 * parents 是 FK CASCADE，但仍显式先删流水再删家长。
 */

const PARENT = 900011;
const ADMIN = 900012; // admin_id 无外键，纯审计值

const pool = mysql.createPool({
  host: process.env.DB_HOST || 'localhost',
  port: parseInt(process.env.DB_PORT || '3306', 10),
  user: process.env.DB_USER || 'ai_k12',
  password: process.env.DB_PASS || 'ai_k12',
  database: process.env.DB_NAME || 'ai_k12',
  charset: 'utf8mb4',
});

const repo = new SubscriptionAdjustmentsRepository(pool);

async function cleanup() {
  await pool.execute(`DELETE FROM subscription_adjustments WHERE parent_id = ?`, [PARENT]);
  await pool.execute(`DELETE FROM parents WHERE id = ? OR phone = '19999990011'`, [PARENT]);
}

async function countRows(): Promise<number> {
  const [rows] = await pool.execute<RowDataPacket[]>(
    `SELECT COUNT(*) AS n FROM subscription_adjustments WHERE parent_id = ?`,
    [PARENT],
  );
  return Number(rows[0].n);
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
  await cleanup();
  await pool.execute(`INSERT INTO parents (id, phone, password_hash) VALUES (?, '19999990011', 'x')`, [PARENT]);
});

afterAll(async () => {
  await cleanup();
  await pool.end();
});

describe('SubscriptionAdjustmentsRepository（真库）', () => {
  it('insert（无 conn）：trial_set 落一行（trial_ends_at 有值、delta_days NULL）', async () => {
    const trialEndsAt = new Date('2026-12-31T00:00:00');

    await repo.insert({
      parentId: PARENT,
      adminId: ADMIN,
      type: 'trial_set',
      trialEndsAt,
      deltaDays: null,
      reason: null,
    });

    const [rows] = await pool.execute<RowDataPacket[]>(
      `SELECT parent_id, admin_id, type, trial_ends_at, delta_days, reason
         FROM subscription_adjustments WHERE parent_id = ?`,
      [PARENT],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      parent_id: PARENT,
      admin_id: ADMIN,
      type: 'trial_set',
      delta_days: null,
      reason: null,
    });
    expect(rows[0].trial_ends_at.getTime()).toBe(trialEndsAt.getTime());
  });

  it('insert：grant_days（delta_days 负数 + reason）落一行', async () => {
    await repo.insert({
      parentId: PARENT,
      adminId: ADMIN,
      type: 'grant_days',
      trialEndsAt: null,
      deltaDays: -3,
      reason: '误充补录',
    });

    const [rows] = await pool.execute<RowDataPacket[]>(
      `SELECT type, delta_days, reason, trial_ends_at FROM subscription_adjustments WHERE parent_id = ?`,
      [PARENT],
    );
    expect(rows).toHaveLength(2);
    expect(rows[1]).toMatchObject({ type: 'grant_days', delta_days: -3, reason: '误充补录', trial_ends_at: null });
  });

  it('insert（事务 conn）：与调用方事务同生共死——rollback 后不落行', async () => {
    const before = await countRows();

    const conn = await pool.getConnection();
    try {
      await conn.beginTransaction();
      await repo.insert(
        { parentId: PARENT, adminId: ADMIN, type: 'grant_days', trialEndsAt: null, deltaDays: 30, reason: null },
        conn,
      );
      await conn.rollback();
    } finally {
      conn.release();
    }

    expect(await countRows()).toBe(before);
  });
});
