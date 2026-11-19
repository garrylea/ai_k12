import { Injectable } from '@nestjs/common';
import {
  ContentAuditRepository,
  type AuditFilters,
  type AuditLogRow,
} from '../../database/repositories/content-audit.repo.js';

export type AuditQuery = AuditFilters;

export interface AuditItem {
  id: number;
  actorId: number;
  actorRole: string;
  actorName: string | null;
  action: string;
  targetType: string;
  targetId: number;
  paperId: number | null;
  beforeJson: unknown;
  afterJson: unknown;
  note: string | null;
  createdAt: string;
}

export interface AuditListResult {
  items: AuditItem[];
  total: number;
  page: number;
  pageSize: number;
}

/** mysql2 对 JSON 列可能返回已解析对象，也可能返回字符串（取决于 typeCast）。 */
function parseJson(v: unknown): unknown {
  if (typeof v !== 'string') return v ?? null;
  try {
    return JSON.parse(v) as unknown;
  } catch {
    return v;
  }
}

function toItem(row: AuditLogRow): AuditItem {
  return {
    id: Number(row.id),
    actorId: Number(row.actor_id),
    actorRole: row.actor_role,
    actorName: row.actor_name,
    action: row.action,
    targetType: row.target_type,
    targetId: Number(row.target_id),
    paperId: row.paper_id === null ? null : Number(row.paper_id),
    beforeJson: parseJson(row.before_json),
    afterJson: parseJson(row.after_json),
    note: row.note,
    createdAt: new Date(row.created_at).toISOString(),
  };
}

@Injectable()
export class ResearchAuditService {
  constructor(private readonly repo: ContentAuditRepository) {}

  async list(query: AuditQuery): Promise<AuditListResult> {
    const { items, total } = await this.repo.findAll(query);
    return { items: items.map(toItem), total, page: query.page, pageSize: query.pageSize };
  }
}
