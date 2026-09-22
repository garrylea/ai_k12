import { Injectable, Inject } from '@nestjs/common';
import type { Pool, ResultSetHeader, RowDataPacket } from 'mysql2/promise';

export interface RemediationSetRow {
  id: number;
  student_id: number;
  subject_id: number;
  status: string;
  created_at: Date;
  updated_at: Date;
}

export interface RemediationGroupRow {
  id: number;
  set_id: number;
  kp_id: number;
  type: string;
  difficulty: number;
  origin_question_id: number;
  ai_pending_count: number;
  created_at: Date;
}

export interface RemediationItemRow {
  id: number;
  group_id: number;
  question_id: number;
  is_correct: number;
  points_awarded: number;
  attempts: number;
  last_answered_at: Date | null;
  created_at: Date;
}

@Injectable()
export class RemediationRepository {
  constructor(@Inject('DATABASE_POOL') private readonly pool: Pool) {}

  async findActiveByStudent(studentId: number, subjectId: number): Promise<RemediationSetRow | null> {
    // LIMIT 1 是字面常量，不是占位符，可用 execute
    const [rows] = await this.pool.execute<RowDataPacket[]>(
      `SELECT * FROM remediation_sets WHERE student_id = ? AND subject_id = ? AND status = 'active' ORDER BY id DESC LIMIT 1`,
      [studentId, subjectId],
    );
    return (rows[0] as RemediationSetRow) ?? null;
  }

  /**
   * 取本人在该学科的 active 套题；没有就新建。返回 `created` 供调用方判断「这套是不是我建的」。
   *
   * **并发安全**：唯一键 `uniq_rsets_active`（条件式生成列 `active_student_id`，见
   * `tools/db/migrations/2026-09-22_remediation_sets_active_unique.sql`）保证同一学生同一学科
   * **至多一条 active**。两个标签页同时点「生成练习」时，后到者撞 `ER_DUP_ENTRY` → 按「已有套题」
   * 处理（同 `createGroupOrSkip` 的先例），返回既有 id 且 `created=false`。
   *
   * ⚠️ 调用方**不得**在 `created=false` 时回收「空套题」——那可能是并发请求刚建好、组还没落库的套题，
   * 删掉会把对方刚建的组级联清空。注意这是与 T7-M1 **同类**的数据丢失，但**不是** T7-M1 本身：
   * T7-M1 说的是 `createdNow === true` 的一方在 `groupsCreated === 0` 时回收，可能删掉并发方刚建好的组；
   * 本唯一键**不覆盖**那条路径，T7-M1 仍然敞开。
   */
  async findOrCreateActiveSet(
    studentId: number,
    subjectId: number,
  ): Promise<{ id: number; created: boolean }> {
    const existing = await this.findActiveByStudent(studentId, subjectId);
    if (existing) return { id: existing.id, created: false };
    try {
      const [result] = await this.pool.execute<ResultSetHeader>(
        `INSERT INTO remediation_sets (student_id, subject_id) VALUES (?, ?)`,
        [studentId, subjectId],
      );
      return { id: result.insertId, created: true };
    } catch (err) {
      if ((err as { code?: string })?.code === 'ER_DUP_ENTRY') {
        const winner = await this.findActiveByStudent(studentId, subjectId);
        if (winner) return { id: winner.id, created: false };
      }
      throw err;
    }
  }

  async findGroupById(groupId: number): Promise<RemediationGroupRow | null> {
    const [rows] = await this.pool.execute<RowDataPacket[]>(
      `SELECT * FROM remediation_groups WHERE id = ?`,
      [groupId],
    );
    return (rows[0] as RemediationGroupRow) ?? null;
  }

  async findGroupsBySet(setId: number): Promise<RemediationGroupRow[]> {
    const [rows] = await this.pool.execute<RowDataPacket[]>(
      `SELECT * FROM remediation_groups WHERE set_id = ? ORDER BY id`,
      [setId],
    );
    return rows as RemediationGroupRow[];
  }

  async findGroupByTriple(setId: number, kpId: number, type: string, difficulty: number): Promise<RemediationGroupRow | null> {
    const [rows] = await this.pool.execute<RowDataPacket[]>(
      `SELECT * FROM remediation_groups WHERE set_id = ? AND kp_id = ? AND type = ? AND difficulty = ?`,
      [setId, kpId, type, difficulty],
    );
    return (rows[0] as RemediationGroupRow) ?? null;
  }

  async createGroup(setId: number, kpId: number, type: string, difficulty: number, originQuestionId: number): Promise<number> {
    const [result] = await this.pool.execute<ResultSetHeader>(
      `INSERT INTO remediation_groups (set_id, kp_id, type, difficulty, origin_question_id) VALUES (?, ?, ?, ?, ?)`,
      [setId, kpId, type, difficulty, originQuestionId],
    );
    return result.insertId;
  }

  async updateGroupAiPending(groupId: number, count: number): Promise<void> {
    await this.pool.execute(`UPDATE remediation_groups SET ai_pending_count = ? WHERE id = ?`, [count, groupId]);
  }

  /** INSERT IGNORE：撞 uniq_ritems_group_question（同组同题）静默跳过，返回实际插入数。 */
  async insertItems(groupId: number, questionIds: number[]): Promise<number> {
    if (questionIds.length === 0) return 0;
    const values = questionIds.map(() => '(?, ?)').join(',');
    const params = questionIds.flatMap((qid) => [groupId, qid]);
    const [result] = await this.pool.execute<ResultSetHeader>(
      `INSERT IGNORE INTO remediation_set_items (group_id, question_id) VALUES ${values}`,
      params,
    );
    return result.affectedRows;
  }

  async findItemsBySet(setId: number): Promise<RemediationItemRow[]> {
    const [rows] = await this.pool.execute<RowDataPacket[]>(
      `SELECT i.* FROM remediation_set_items i
       JOIN remediation_groups g ON g.id = i.group_id
       WHERE g.set_id = ? ORDER BY i.id`,
      [setId],
    );
    return rows as RemediationItemRow[];
  }

  async findItemBySetQuestion(setId: number, questionId: number): Promise<RemediationItemRow | null> {
    const [rows] = await this.pool.execute<RowDataPacket[]>(
      `SELECT i.* FROM remediation_set_items i
       JOIN remediation_groups g ON g.id = i.group_id
       WHERE g.set_id = ? AND i.question_id = ?`,
      [setId, questionId],
    );
    return (rows[0] as RemediationItemRow) ?? null;
  }

  async markItemCorrect(itemId: number): Promise<void> {
    await this.pool.execute(`UPDATE remediation_set_items SET is_correct = 1 WHERE id = ?`, [itemId]);
  }

  async markPointsAwarded(itemId: number): Promise<void> {
    await this.pool.execute(`UPDATE remediation_set_items SET points_awarded = 1 WHERE id = ?`, [itemId]);
  }

  async recordAttempt(itemId: number): Promise<void> {
    await this.pool.execute(
      `UPDATE remediation_set_items SET attempts = attempts + 1, last_answered_at = NOW(3) WHERE id = ?`,
      [itemId],
    );
  }

  /** 全对清套：物理删除整套记录（CASCADE 清 groups/items；spec §2 决策 7）。 */
  async deleteSet(setId: number): Promise<void> {
    await this.pool.execute(`DELETE FROM remediation_sets WHERE id = ?`, [setId]);
  }
}
