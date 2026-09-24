import { Injectable, Inject } from '@nestjs/common';
import type { Pool, ResultSetHeader, RowDataPacket } from 'mysql2/promise';

/** 本期唯一命令（spec §5.4）。用数组而不是 ENUM 类型：新增命令只改这里。 */
export const DEVICE_COMMANDS = ['unlock'] as const;
export type DeviceCommandName = (typeof DEVICE_COMMANDS)[number];

export interface DeviceCommandRow extends RowDataPacket {
  id: number;
  student_id: number;
  command: string;
  status: 'pending' | 'consumed' | 'expired';
  issued_by_parent_id: number;
  created_at: Date;
  consumed_at: Date | null;
}

/**
 * 家长 → 学生端命令队列（spec §4.3）。
 *
 * 消费（认领 + 落 unlocked_at）在 `LearningSessionsRepository.pollAndConsume` 的事务里，
 * 不在这里——那两个动作必须同生共死。本仓储**只负责插入**。
 */
@Injectable()
export class DeviceCommandsRepository {
  constructor(@Inject('DATABASE_POOL') private readonly pool: Pool) {}

  async insert(input: {
    studentId: number;
    command: DeviceCommandName;
    issuedByParentId: number;
  }): Promise<DeviceCommandRow> {
    const [result] = await this.pool.execute<ResultSetHeader>(
      `INSERT INTO device_commands (student_id, command, issued_by_parent_id) VALUES (?, ?, ?)`,
      [input.studentId, input.command, input.issuedByParentId],
    );
    const [rows] = await this.pool.execute<DeviceCommandRow[]>(
      `SELECT id, student_id, command, status, issued_by_parent_id, created_at, consumed_at
       FROM device_commands WHERE id = ? LIMIT 1`,
      [result.insertId],
    );
    if (!rows[0]) throw new Error(`device_commands ${result.insertId} 插入后读不到`);
    return rows[0];
  }
}
