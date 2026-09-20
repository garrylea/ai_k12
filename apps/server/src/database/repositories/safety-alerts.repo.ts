import { Injectable, Inject } from '@nestjs/common';
import type { Pool, ResultSetHeader, RowDataPacket } from 'mysql2/promise';
import type { SafetyAlertRow } from './types.js';

/** 列表行：预警本体 + join 出来的孩子名（取不到就是「未知学生」，不做非空断言）。 */
export interface SafetyAlertRowWithStudentName extends SafetyAlertRow {
  student_name: string | null;
}

@Injectable()
export class SafetyAlertsRepository {
  constructor(@Inject('DATABASE_POOL') private readonly pool: Pool) {}

  async create(row: Omit<SafetyAlertRow, 'id' | 'created_at' | 'is_read' | 'read_at'>): Promise<number> {
    const [result] = await this.pool.execute<ResultSetHeader>(
      `INSERT INTO safety_alerts
       (parent_id, student_id, dialogue_id, message_id, type, level, message, context)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [row.parent_id, row.student_id, row.dialogue_id, row.message_id, row.type, row.level, row.message, row.context],
    );
    return result.insertId;
  }

  async findByParent(parentId: number): Promise<SafetyAlertRow[]> {
    const [rows] = await this.pool.execute<RowDataPacket[]>(
      `SELECT * FROM safety_alerts WHERE parent_id = ? ORDER BY id DESC`,
      [parentId],
    );
    return rows as SafetyAlertRow[];
  }

  async markRead(id: number): Promise<void> {
    await this.pool.execute(
      `UPDATE safety_alerts SET is_read = 1, read_at = NOW(3) WHERE id = ?`,
      [id],
    );
  }

  /** 去重窗口：同一学生 + 同一 type 在 `since` 之后是否已写过一条（spec §3.5，30 分钟）。 */
  async existsRecent(studentId: number, type: string, since: Date): Promise<boolean> {
    const [rows] = await this.pool.execute<(RowDataPacket & { n: number | string })[]>(
      `SELECT COUNT(*) AS n FROM safety_alerts
       WHERE student_id = ? AND type = ? AND created_at >= ?`,
      [studentId, type, since],
    );
    return Number(rows[0]?.n ?? 0) > 0;
  }

  async findById(id: number): Promise<SafetyAlertRow | null> {
    const [rows] = await this.pool.execute<SafetyAlertRow[]>(
      `SELECT * FROM safety_alerts WHERE id = ? LIMIT 1`,
      [id],
    );
    return rows[0] ?? null;
  }

  /**
   * 未读预警计数（`is_read = 0`）。`studentId` 省略 = 该家长**全部孩子**。
   *
   * 仪表盘 `unreadAlerts` 真查用（spec §4.2 ①）：顶层卡片传家长、孩子卡片传
   * `(parentId, studentId)`。独立 `COUNT(*)` 而不是复用 `listByParent`——后者会
   * 顺手把整页行取回来，仪表盘只要一个数字。
   */
  async countUnread(parentId: number, studentId?: number): Promise<number> {
    const where: string[] = ['parent_id = ?', 'is_read = 0'];
    const params: number[] = [parentId];
    if (studentId !== undefined) {
      where.push('student_id = ?');
      params.push(studentId);
    }
    const [rows] = await this.pool.execute<(RowDataPacket & { n: number | string })[]>(
      `SELECT COUNT(*) AS n FROM safety_alerts WHERE ${where.join(' AND ')}`,
      params,
    );
    return Number(rows[0]?.n ?? 0);
  }

  /**
   * 家长端列表（join students 取孩子名）。
   * 排序固定 `created_at DESC, id DESC`（同一毫秒的稳定次序）；半开区间不涉及。
   * 孤儿行理论上不可能（两个 FK 都是 ON DELETE CASCADE），但 `studentName` 仍按可空处理。
   */
  async listByParent(
    parentId: number,
    filters: { studentId?: number; unreadOnly?: boolean },
    limit: number,
    offset: number,
  ): Promise<{ items: SafetyAlertRowWithStudentName[]; total: number }> {
    const where: string[] = ['sa.parent_id = ?'];
    const params: Array<number> = [parentId];
    if (filters.studentId !== undefined) { where.push('sa.student_id = ?'); params.push(filters.studentId); }
    if (filters.unreadOnly) where.push('sa.is_read = 0');
    const clause = where.join(' AND ');

    // COUNT 无 LIMIT，照旧走 execute（预处理语句）
    const [countRows] = await this.pool.execute<(RowDataPacket & { n: number | string })[]>(
      `SELECT COUNT(*) AS n FROM safety_alerts sa WHERE ${clause}`, params,
    );
    // LIMIT ? / OFFSET ? 必须用 pool.query（客户端转义）：MySQL 对预处理语句的 `LIMIT ?`
    // 报 "Incorrect arguments to mysqld_stmt_execute"，execute 会让本端点对真库每调必 500
    // （parent-insights.repo.ts:210-211 的既有铁律，同仓 ai-dialogues / chinese-passages /
    // point-ledger 均如此绕开）。形态护栏见 safety-alerts.repo.test.ts「LIMIT ? 走 query」。
    const [rows] = await this.pool.query<SafetyAlertRowWithStudentName[]>(
      `SELECT sa.*, s.name AS student_name
       FROM safety_alerts sa LEFT JOIN students s ON s.id = sa.student_id
       WHERE ${clause}
       ORDER BY sa.created_at DESC, sa.id DESC
       LIMIT ? OFFSET ?`,
      [...params, limit, offset],
    );
    return { items: rows, total: Number(countRows[0]?.n ?? 0) };
  }
}
