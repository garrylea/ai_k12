import { Inject, Injectable } from '@nestjs/common';
import type { Pool, RowDataPacket } from 'mysql2/promise';

export interface AuditEntry {
  actorId: number; actorRole: string; actorName: string | null;
  action: 'paper.delete' | 'question.update' | 'image.delete';
  targetType: 'paper' | 'question' | 'image'; targetId: number;
  paperId?: number | null; beforeJson?: unknown; afterJson?: unknown; note?: string | null;
}

export interface AuditFilters {
  actorId?: number;
  action?: string;
  targetType?: string;
  targetId?: number;
  /** 由 controller 把合法 ISO 字符串转成 Date 后传入。 */
  from?: Date;
  to?: Date;
  page: number;
  pageSize: number;
}

export interface AuditLogRow extends RowDataPacket {
  id: number;
  actor_id: number;
  actor_role: string;
  actor_name: string | null;
  action: string;
  target_type: string;
  target_id: number;
  paper_id: number | null;
  before_json: unknown;
  after_json: unknown;
  note: string | null;
  created_at: Date;
}

/** 内容纠错审计仓储：只追加，按创建时间倒序分页查询。 */
@Injectable()
export class ContentAuditRepository {
  constructor(@Inject('DATABASE_POOL') private readonly pool: Pool) {}

  async append(e: AuditEntry): Promise<void> {
    await this.pool.execute(
      `INSERT INTO content_audit_logs
        (actor_id, actor_role, actor_name, action, target_type, target_id, paper_id, before_json, after_json, note)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [e.actorId, e.actorRole, e.actorName, e.action, e.targetType, e.targetId,
       e.paperId ?? null, e.beforeJson == null ? null : JSON.stringify(e.beforeJson),
       e.afterJson == null ? null : JSON.stringify(e.afterJson), e.note ?? null],
    );
  }

  async findAll(filters: AuditFilters): Promise<{ items: AuditLogRow[]; total: number }> {
    const where: string[] = [];
    const params: Array<number | string | Date> = [];
    if (filters.actorId !== undefined) {
      where.push('actor_id = ?');
      params.push(filters.actorId);
    }
    if (filters.action !== undefined) {
      where.push('action = ?');
      params.push(filters.action);
    }
    if (filters.targetType !== undefined) {
      where.push('target_type = ?');
      params.push(filters.targetType);
    }
    if (filters.targetId !== undefined) {
      where.push('target_id = ?');
      params.push(filters.targetId);
    }
    // 双边给到用 BETWEEN（spec §7.6）；单边退化为 >= / <=。
    if (filters.from !== undefined && filters.to !== undefined) {
      where.push('created_at BETWEEN ? AND ?');
      params.push(filters.from, filters.to);
    } else if (filters.from !== undefined) {
      where.push('created_at >= ?');
      params.push(filters.from);
    } else if (filters.to !== undefined) {
      where.push('created_at <= ?');
      params.push(filters.to);
    }
    const whereSql = where.length > 0 ? `WHERE ${where.join(' AND ')}` : '';

    const [countRows] = await this.pool.execute<RowDataPacket[]>(
      `SELECT COUNT(*) AS total FROM content_audit_logs ${whereSql}`,
      params,
    );
    // 与 papers 仓储同理：LIMIT ? 不能走 execute 预编译。
    const [rows] = await this.pool.query<AuditLogRow[]>(
      `SELECT id, actor_id, actor_role, actor_name, action, target_type, target_id,
              paper_id, before_json, after_json, note, created_at
         FROM content_audit_logs ${whereSql}
        ORDER BY created_at DESC, id DESC
        LIMIT ? OFFSET ?`,
      [...params, filters.pageSize, (filters.page - 1) * filters.pageSize],
    );
    return { items: rows, total: Number(countRows[0]?.total ?? 0) };
  }
}
