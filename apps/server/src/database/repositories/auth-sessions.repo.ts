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
 * bump 是**同连接**原子操作（2026-10-10 终审修正）：显式 `pool.getConnection()`，
 * 在同一连接上先 `INSERT..ON DUPLICATE KEY UPDATE token_seq = LAST_INSERT_ID(token_seq + 1)`，
 * 再 `SELECT LAST_INSERT_ID()`——mysql2 的 LAST_INSERT_ID() 跨语句存活于**同一连接**，
 * 故 upsert 与回读之间不存在并发交错窗口。autocommit（默认）下两条语句各自原子且
 * 在同一连接上顺序执行，语义已完备，无需显式事务。注意此写法**不可**改回两次
 * pool.execute：不同池连接间 LAST_INSERT_ID() 不存活，且并发登录可交错出同 seq 双活。
 */
@Injectable()
export class AuthSessionsRepository {
  constructor(@Inject('DATABASE_POOL') private readonly pool: Pool) {}

  async bumpAndReturnSeq(role: AuthSessionSeqRow['role'], userId: number): Promise<number> {
    const conn = await this.pool.getConnection();
    try {
      await conn.execute(
        `INSERT INTO auth_sessions (role, user_id, token_seq) VALUES (?, ?, 1)
         ON DUPLICATE KEY UPDATE token_seq = LAST_INSERT_ID(token_seq + 1)`,
        [role, userId],
      );
      const [rows] = await conn.execute<(RowDataPacket & { seq: number })[]>(
        `SELECT LAST_INSERT_ID() AS seq`,
        [role, userId],
      );
      const seq = rows[0]?.seq;
      if (seq === undefined) {
        // upsert 成功后回读为空在逻辑上不可达；若发生则 fail loud（登录 500），
        // 绝不静默回退 seq=1——那会让多个会话拿到相同序号，单点登录静默失效。
        throw new Error(`auth_sessions bump: LAST_INSERT_ID() empty for ${role}:${userId}`);
      }
      return Number(seq);
    } finally {
      conn.release();
    }
  }

  /** 启动时 SessionRegistry 全量重建用（一行 = 一个登录过的账号，表很小）。 */
  async listAll(): Promise<AuthSessionSeqRow[]> {
    const [rows] = await this.pool.execute<(RowDataPacket & AuthSessionSeqRow)[]>(
      `SELECT role, user_id, token_seq FROM auth_sessions`,
    );
    return rows as AuthSessionSeqRow[];
  }
}
