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
   * 再按 upsert 结果分支取 seq。**必须分支**（2026-10-10 Fix round 2）：`LAST_INSERT_ID(expr)`
   * 只在 **UPDATE** 分支设置会话值；fresh **INSERT**（账号有史以来首次登录）时
   * `SELECT LAST_INSERT_ID()` 返回的是新行的 AUTO_INCREMENT `id` 而非 1 —— 若不分支，
   * 首登 seq = 行 id (N) 而表里 token_seq=1，之后每次登录 seq (2..N) 都 ≤ N 被判为旧
   * token，最新登录被立刻踢下线。故：
   * - `affectedRows === 1`（INSERT，新建行 token_seq 恒为 1）→ 短路返回 1，不回读；
   * - `affectedRows === 2`（UPDATE）→ 同连接 `SELECT LAST_INSERT_ID()`（无 bind 参数）取值；
   * - `affectedRows === 0` 对本 upsert 不可达（UPDATE 分支必然改变值）→ 抛错 fail loud。
   *
   * mysql2 的 LAST_INSERT_ID() 跨语句存活于**同一连接**，故 upsert 与回读之间不存在
   * 并发交错窗口。autocommit（默认）下两条语句各自原子且在同一连接上顺序执行，语义已
   * 完备，无需显式事务。注意此写法**不可**改回两次 pool.execute：不同池连接间
   * LAST_INSERT_ID() 不存活，且并发登录可交错出同 seq 双活。
 */
@Injectable()
export class AuthSessionsRepository {
  constructor(@Inject('DATABASE_POOL') private readonly pool: Pool) {}

  async bumpAndReturnSeq(role: AuthSessionSeqRow['role'], userId: number): Promise<number> {
    const conn = await this.pool.getConnection();
    try {
      const [result] = await conn.execute(
        `INSERT INTO auth_sessions (role, user_id, token_seq) VALUES (?, ?, 1)
         ON DUPLICATE KEY UPDATE token_seq = LAST_INSERT_ID(token_seq + 1)`,
        [role, userId],
      );
      const affectedRows = (result as { affectedRows?: number }).affectedRows;
      if (affectedRows === 1) {
        // INSERT 分支：行刚创建，token_seq 恒为 1。LAST_INSERT_ID(expr) 未在此分支
        // 设置会话值，回读会拿到 AUTO_INCREMENT id 而非 1 —— 必须短路返回 1。
        return 1;
      }
      if (affectedRows !== 2) {
        // UPDATE 分支必然改变 token_seq（affectedRows=2）；0 对本 upsert 不可达，
        // 若发生则 fail loud（登录 500），绝不静默猜测——那会让单点登录静默失效。
        throw new Error(
          `auth_sessions bump: unexpected affectedRows=${affectedRows} for ${role}:${userId}`,
        );
      }
      const [rows] = await conn.execute<(RowDataPacket & { seq: number })[]>(
        `SELECT LAST_INSERT_ID() AS seq`,
      );
      const seq = rows[0]?.seq;
      if (seq === undefined) {
        // UPDATE 分支回读为空在逻辑上不可达；若发生则 fail loud（登录 500），
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
