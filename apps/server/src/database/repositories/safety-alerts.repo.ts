import { Injectable, Inject } from '@nestjs/common';
import type { Pool, ResultSetHeader, RowDataPacket } from 'mysql2/promise';
import type { SafetyAlertRow } from './types.js';

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
}
