import { Inject, Injectable } from '@nestjs/common';
import type { Pool, RowDataPacket } from 'mysql2/promise';

export interface AuditEntry {
  actorId: number; actorRole: string; actorName: string | null;
  action: 'paper.delete' | 'question.update' | 'image.delete';
  targetType: 'paper' | 'question' | 'image'; targetId: number;
  paperId?: number | null; beforeJson?: unknown; afterJson?: unknown; note?: string | null;
}

/** 删卷/改题等写审计时从当前用户身上取的最小身份信息。 */
export interface AuditActor {
  sub: number;
  role: string;
  name?: string | null;
}

/** 只用到 execute 的最小执行器接口（Pool 与 PoolConnection 都满足）。 */
type Queryable = { execute(sql: string, values?: unknown): Promise<unknown> };

const INSERT_SQL = `INSERT INTO content_audit_logs
        (actor_id, actor_role, actor_name, action, target_type, target_id, paper_id, before_json, after_json, note)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;

function insertParams(e: AuditEntry): Array<string | number | null> {
  return [
    e.actorId, e.actorRole, e.actorName, e.action, e.targetType, e.targetId,
    e.paperId ?? null, e.beforeJson == null ? null : JSON.stringify(e.beforeJson),
    e.afterJson == null ? null : JSON.stringify(e.afterJson), e.note ?? null,
  ];
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

  /** 独立审计写入（不参与业务事务）：仅用于没有外部事务的写路径。 */
  async append(e: AuditEntry): Promise<void> {
    await this.pool.execute(INSERT_SQL, insertParams(e));
  }

  /**
   * 在调用方给定的连接上写审计——用于必须和业务操作同一事务的场景（spec §9.2）。
   * `deletePaperCascade` 传入的是它 `beginTransaction` 拿到的 `PoolConnection`，
   * 审计插入因此参与同一事务：插入失败会连带整笔删卷回滚，反之亦然。
   */
  async appendOnConnection(conn: Queryable, e: AuditEntry): Promise<void> {
    await conn.execute(INSERT_SQL, insertParams(e));
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
