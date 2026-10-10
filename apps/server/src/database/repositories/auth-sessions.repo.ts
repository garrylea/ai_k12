import { Injectable, Inject } from '@nestjs/common';
import type { Pool, RowDataPacket } from 'mysql2/promise';

export interface AuthSessionSeqRow {
  role: 'admin' | 'parent' | 'student';
  user_id: number;
  token_seq: number;
}

/**
 * 单点登录互踢的 seq 持久层（2026-10-10）。一行 = 一个登录过的账号，token_seq =
 * 当前有效会话序号；登录 bump +1，旧 token 的 seq 立即失配。
 *
 * bump 的 upsert 与回读是两条语句、非原子：同账号**并发**登录时「最终胜者」由最后
 * 一次 bump 决定，输家 token 的 seq 必然不匹配注册表而被踢——语义正确，无需事务。
 */
@Injectable()
export class AuthSessionsRepository {
  constructor(@Inject('DATABASE_POOL') private readonly pool: Pool) {}

  async bumpAndReturnSeq(role: AuthSessionSeqRow['role'], userId: number): Promise<number> {
    await this.pool.execute(
      `INSERT INTO auth_sessions (role, user_id, token_seq) VALUES (?, ?, 1)
       ON DUPLICATE KEY UPDATE token_seq = token_seq + 1`,
      [role, userId],
    );
    const [rows] = await this.pool.execute<(RowDataPacket & { token_seq: number })[]>(
      `SELECT token_seq FROM auth_sessions WHERE role = ? AND user_id = ?`,
      [role, userId],
    );
    return Number(rows[0]?.token_seq ?? 1);
  }

  /** 启动时 SessionRegistry 全量重建用（一行 = 一个登录过的账号，表很小）。 */
  async listAll(): Promise<AuthSessionSeqRow[]> {
    const [rows] = await this.pool.execute<(RowDataPacket & AuthSessionSeqRow)[]>(
      `SELECT role, user_id, token_seq FROM auth_sessions`,
    );
    return rows as AuthSessionSeqRow[];
  }
}
