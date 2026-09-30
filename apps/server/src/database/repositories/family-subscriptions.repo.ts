import { Injectable, Inject } from '@nestjs/common';
import type { Pool, PoolConnection, RowDataPacket } from 'mysql2/promise';
import { effectiveStatus } from '../../modules/billing/subscription-status.js';

export interface FamilySubscriptionTimes {
  trial_ends_at: Date | null;
  current_period_end: Date | null;
  plan_code: string | null;
}

interface TimesRow extends RowDataPacket, FamilySubscriptionTimes {}

/**
 * 家庭订阅（`family_subscriptions`，UNIQUE parent_id —— 一个家庭一行）。
 *
 * `status` / `plan_code` / `source` 是冗余展示列，业务口径以 `effectiveStatus`
 * 纯函数推导为准（见 billing/subscription-status.ts），本仓储只负责按调用方
 * 语义同步写这些列。
 */
@Injectable()
export class FamilySubscriptionsRepository {
  constructor(@Inject('DATABASE_POOL') private readonly pool: Pool) {}

  async findByParentId(parentId: number): Promise<FamilySubscriptionTimes | null> {
    const [rows] = await this.pool.execute<TimesRow[]>(
      `SELECT trial_ends_at, current_period_end, plan_code FROM family_subscriptions WHERE parent_id = ?`,
      [parentId],
    );
    return rows[0] ?? null;
  }

  /** 经 students 表按学生反查其家庭的订阅时间（学生端闸口用）。 */
  async findByStudentId(studentId: number): Promise<FamilySubscriptionTimes | null> {
    const [rows] = await this.pool.execute<TimesRow[]>(
      `SELECT fs.trial_ends_at, fs.current_period_end, fs.plan_code
         FROM students st
         JOIN family_subscriptions fs ON fs.parent_id = st.parent_id
        WHERE st.id = ?`,
      [studentId],
    );
    return rows[0] ?? null;
  }

  /**
   * 兜底补行（如存量家长首次触达时补试用行）：行已存在则**什么都不改**
   * （`ON DUPLICATE KEY UPDATE id = id`），绝不覆盖已有 trial/period 数据。
   *
   * @param conn 可选：调用方事务内执行时传入。
   */
  async upsertTrial(parentId: number, trialEndsAt: Date, conn?: PoolConnection): Promise<void> {
    await (conn ?? this.pool).execute(
      `INSERT INTO family_subscriptions (parent_id, status, trial_ends_at, source)
       VALUES (?, 'trialing', ?, 'trial')
       ON DUPLICATE KEY UPDATE id = id`,
      [parentId, trialEndsAt],
    );
  }

  /**
   * 付费续期——调用方事务内执行（与订单置 paid 同生共死）。
   * 行锁 + 「期内顺延 / 过期从 now 起算」；同步写冗余 status/plan_code/source。
   * 注意：锁与读必须走同一 conn（FOR UPDATE 读到的是锁窗口内的行，事务外 pool 读会绕开锁语义）。
   */
  async renewWithinTx(
    conn: PoolConnection,
    parentId: number,
    planCode: string,
    durationDays: number,
    now: Date,
  ): Promise<{ currentPeriodEnd: Date }> {
    const [locked] = await conn.execute<RowDataPacket[]>(
      `SELECT current_period_end FROM family_subscriptions WHERE parent_id = ? FOR UPDATE`,
      [parentId],
    );
    const currentEnd = (locked[0]?.current_period_end as Date | undefined) ?? null;
    const base = currentEnd != null && currentEnd.getTime() > now.getTime() ? currentEnd : now;
    const end = new Date(base.getTime() + durationDays * 86_400_000);
    if (locked.length === 0) {
      // 行不存在（异常态：付费时无行）——补偿插入
      await conn.execute(
        `INSERT INTO family_subscriptions (parent_id, status, current_period_end, plan_code, source)
         VALUES (?, 'active', ?, ?, 'order')`,
        [parentId, end, planCode],
      );
      return { currentPeriodEnd: end };
    }
    await conn.execute(
      `UPDATE family_subscriptions
          SET current_period_end = ?, status = 'active', plan_code = ?, source = 'order'
        WHERE parent_id = ?`,
      [end, planCode, parentId],
    );
    return { currentPeriodEnd: end };
  }

  /** 管理端操作前的家长存在性闸口（1005）；软删行视为不存在（同 parents.repo 口径）。 */
  async parentExists(parentId: number): Promise<boolean> {
    const [rows] = await this.pool.execute<RowDataPacket[]>(
      `SELECT id FROM parents WHERE id = ? AND deleted_at IS NULL LIMIT 1`,
      [parentId],
    );
    return rows.length > 0;
  }

  /**
   * 管理端设定试用截止（批④ Task 5）——调用方事务内执行。
   * FOR UPDATE 锁读 → 直接改写 `trial_ends_at`（null=收回试用），冗余 status 按
   * effectiveStatus（新 trial 值 + 现付费期）同步。无行时：trialEndsAt=null 无从改起
   * （不建行，审计仍由 service 落）；有值则补插 trial 行（同 upsertTrial 的列形态）。
   */
  async setTrialWithinTx(
    conn: PoolConnection,
    parentId: number,
    trialEndsAt: Date | null,
    now: Date,
  ): Promise<void> {
    const [locked] = await conn.execute<RowDataPacket[]>(
      `SELECT current_period_end FROM family_subscriptions WHERE parent_id = ? FOR UPDATE`,
      [parentId],
    );
    if (locked.length === 0) {
      if (trialEndsAt == null) return;
      await conn.execute(
        `INSERT INTO family_subscriptions (parent_id, status, trial_ends_at, source)
         VALUES (?, ?, ?, 'trial')`,
        [parentId, effectiveStatus(now, { trialEndsAt, currentPeriodEnd: null }), trialEndsAt],
      );
      return;
    }
    const currentPeriodEnd = (locked[0].current_period_end as Date | null) ?? null;
    await conn.execute(
      `UPDATE family_subscriptions SET trial_ends_at = ?, status = ? WHERE parent_id = ?`,
      [trialEndsAt, effectiveStatus(now, { trialEndsAt, currentPeriodEnd }), parentId],
    );
  }

  /**
   * 管理端赠送 / 扣减订阅天数（批④ Task 5）——调用方事务内执行。
   * 顺延规则（spec §2.3，同 renewWithinTx）：正数——current_period_end 未来从其顺延、
   * 否则从 now；负数——从未来付费期扣减，扣到 < now 置 current_period_end=NULL
   * （过期态）。无行时正数补偿插入（source='admin'，admin 无套餐上下文 plan_code 留空）、
   * 负数不建行（审计仍由 service 落）。冗余 status 按 effectiveStatus 同步。
   */
  async adjustPeriodWithinTx(
    conn: PoolConnection,
    parentId: number,
    days: number,
    now: Date,
  ): Promise<{ currentPeriodEnd: Date | null }> {
    const [locked] = await conn.execute<RowDataPacket[]>(
      `SELECT trial_ends_at, current_period_end FROM family_subscriptions WHERE parent_id = ? FOR UPDATE`,
      [parentId],
    );
    if (locked.length === 0) {
      if (days < 0) return { currentPeriodEnd: null };
      const end = new Date(now.getTime() + days * 86_400_000);
      await conn.execute(
        `INSERT INTO family_subscriptions (parent_id, status, current_period_end, source)
         VALUES (?, 'active', ?, 'admin')`,
        [parentId, end],
      );
      return { currentPeriodEnd: end };
    }
    const trialEndsAt = (locked[0].trial_ends_at as Date | null) ?? null;
    const currentEnd = (locked[0].current_period_end as Date | null) ?? null;
    let end: Date | null;
    if (days > 0) {
      const base = currentEnd != null && currentEnd.getTime() > now.getTime() ? currentEnd : now;
      end = new Date(base.getTime() + days * 86_400_000);
    } else {
      if (currentEnd == null || currentEnd.getTime() <= now.getTime()) {
        return { currentPeriodEnd: currentEnd }; // 无未来期可扣，行不动
      }
      const deducted = new Date(currentEnd.getTime() + days * 86_400_000);
      end = deducted.getTime() < now.getTime() ? null : deducted; // 扣穿 → NULL=过期态
    }
    await conn.execute(
      `UPDATE family_subscriptions SET current_period_end = ?, status = ? WHERE parent_id = ?`,
      [end, effectiveStatus(now, { trialEndsAt, currentPeriodEnd: end }), parentId],
    );
    return { currentPeriodEnd: end };
  }

  /**
   * 管理端家庭订阅列表（批④ Task 5）：软删家长排除；keyword LIKE 手机号/昵称
   * （%/_ 转义防通配符注入）；学生数用相关子查询（同 parents.repo.search 口径，
   * 软删学生不计）。分页走池 `query`（`LIMIT ?` 坑，同 {@link OrdersRepository.listByParent}）。
   */
  async listFamilies(keyword: string | null, page: number, pageSize: number) {
    const offset = (page - 1) * pageSize;
    const like =
      keyword != null ? `%${keyword.replace(/[\\%_]/g, (c) => `\\${c}`)}%` : null;
    const where =
      keyword != null
        ? `WHERE p.deleted_at IS NULL AND (p.phone LIKE ? OR p.name LIKE ?)`
        : `WHERE p.deleted_at IS NULL`;
    const whereParams = keyword != null ? [like, like] : [];
    const [[cntRows], [rows]] = await Promise.all([
      this.pool.query<RowDataPacket[]>(`SELECT COUNT(*) AS total FROM parents p ${where}`, whereParams),
      this.pool.query<RowDataPacket[]>(
        `SELECT p.id AS parent_id, p.phone,
                (SELECT COUNT(*) FROM students s WHERE s.parent_id = p.id AND s.deleted_at IS NULL) AS student_count,
                fs.trial_ends_at, fs.current_period_end, fs.plan_code
           FROM parents p
           LEFT JOIN family_subscriptions fs ON fs.parent_id = p.id
           ${where}
           ORDER BY p.id DESC
           LIMIT ? OFFSET ?`,
        [...whereParams, pageSize, offset],
      ),
    ]);
    return { total: Number(cntRows[0].total), rows: rows as FamilyListRow[] };
  }
}

/** `listFamilies` 行：LEFT JOIN family_subscriptions，无订阅行家庭的时间/套餐列全 null。 */
export interface FamilyListRow extends RowDataPacket {
  parent_id: number;
  phone: string;
  student_count: number;
  trial_ends_at: Date | null;
  current_period_end: Date | null;
  plan_code: string | null;
}
