import { Injectable, Inject } from '@nestjs/common';
import type { Pool, RowDataPacket } from 'mysql2/promise';

export interface DaySeconds {
  day: string;
  seconds: number;
}

export interface ModuleSeconds {
  module: string;
  seconds: number;
}

export interface SubjectSeconds {
  subjectId: number;
  seconds: number;
}

/**
 * 家长端**只读**聚合仓储（spec §6.1）。
 *
 * 三条纪律：
 * 1. **隐私分层第三道锁**：本文件是家长端取数的唯一入口，**只准查 parent 层信号**。
 *    ops-only（提示依赖 / 连续失败 / 放弃点 / 自评）永不进这个文件——
 *    `parent-analytics.repo.test.ts` 的守卫用例会静态断言这一点。
 * 2. 时间窗由**应用层**算好传参（`from` 含、`toExclusive` 不含），**不用 `CURDATE()`**：
 *    DB 会话时区与 Node 可能不一致，会算错一天（`point-ledger.repo.ts` 的既有约定）。
 * 3. 学习时长只统计**已结束**的会话。`active` 但心跳超 5 分钟的孤儿会话
 *    （用户直接关标签、没有 end 请求）也要算进来，否则「今日已用」会永远不更新。
 *
 * Phase 1B 会往这里加专项 / 掌握度 / 目标三组查询；保持单一入口，不要按域拆文件。
 */
@Injectable()
export class ParentAnalyticsRepository {
  constructor(@Inject('DATABASE_POOL') private readonly pool: Pool) {}

  /**
   * 会话有效性的**唯一口径**，四处聚合共用。
   *
   * 抽成常量而不是四处复制：漏掉孤儿会话分支的散点 SQL 会让不同卡片上的
   * 「学习时长」互相打架，而家长会认为其中一个是 bug。
   */
  private static readonly EFFECTIVE_SESSION = `(status IN ('ended','abandoned')
      OR (status = 'active' AND last_heartbeat_at < NOW(3) - INTERVAL 5 MINUTE))`;

  async getStudyTimeTotal(studentId: number, from: Date, toExclusive: Date): Promise<number> {
    const [rows] = await this.pool.execute<(RowDataPacket & { total: number | string | null })[]>(
      `SELECT COALESCE(SUM(active_seconds), 0) AS total
       FROM study_sessions
       WHERE student_id = ? AND started_at >= ? AND started_at < ?
         AND ${ParentAnalyticsRepository.EFFECTIVE_SESSION}`,
      [studentId, from, toExclusive],
    );
    return Number(rows[0]?.total ?? 0);
  }

  async getStudyTimeByDay(studentId: number, from: Date, toExclusive: Date): Promise<DaySeconds[]> {
    const [rows] = await this.pool.execute<
      (RowDataPacket & { day: string; seconds: number | string | null })[]
    >(
      `SELECT DATE_FORMAT(started_at, '%Y-%m-%d') AS day,
              COALESCE(SUM(active_seconds), 0)    AS seconds
       FROM study_sessions
       WHERE student_id = ? AND started_at >= ? AND started_at < ?
         AND ${ParentAnalyticsRepository.EFFECTIVE_SESSION}
       GROUP BY day ORDER BY day`,
      [studentId, from, toExclusive],
    );
    return rows.map((r) => ({ day: r.day, seconds: Number(r.seconds ?? 0) }));
  }

  async getStudyTimeByModule(studentId: number, from: Date, toExclusive: Date): Promise<ModuleSeconds[]> {
    const [rows] = await this.pool.execute<
      (RowDataPacket & { module: string; seconds: number | string | null })[]
    >(
      `SELECT module, COALESCE(SUM(active_seconds), 0) AS seconds
       FROM study_sessions
       WHERE student_id = ? AND started_at >= ? AND started_at < ?
         AND ${ParentAnalyticsRepository.EFFECTIVE_SESSION}
       GROUP BY module ORDER BY seconds DESC`,
      [studentId, from, toExclusive],
    );
    return rows.map((r) => ({ module: r.module, seconds: Number(r.seconds ?? 0) }));
  }

  async getStudyTimeBySubject(studentId: number, from: Date, toExclusive: Date): Promise<SubjectSeconds[]> {
    const [rows] = await this.pool.execute<
      (RowDataPacket & { subjectId: number; seconds: number | string | null })[]
    >(
      `SELECT subject_id AS subjectId, COALESCE(SUM(active_seconds), 0) AS seconds
       FROM study_sessions
       WHERE student_id = ? AND started_at >= ? AND started_at < ?
         AND subject_id IS NOT NULL
         AND ${ParentAnalyticsRepository.EFFECTIVE_SESSION}
       GROUP BY subject_id ORDER BY seconds DESC`,
      [studentId, from, toExclusive],
    );
    return rows.map((r) => ({ subjectId: Number(r.subjectId), seconds: Number(r.seconds ?? 0) }));
  }

  /** 会话口径的「有学习的天数」。与旧「近 7 天活跃」（四路时间戳代理）**刻意不同**，见 spec §10。 */
  async getActiveDays(studentId: number, from: Date, toExclusive: Date): Promise<number> {
    const [rows] = await this.pool.execute<(RowDataPacket & { active_days: number | string | null })[]>(
      `SELECT COUNT(DISTINCT DATE(started_at)) AS active_days
       FROM study_sessions
       WHERE student_id = ? AND started_at >= ? AND started_at < ?
         AND ${ParentAnalyticsRepository.EFFECTIVE_SESSION}`,
      [studentId, from, toExclusive],
    );
    return Number(rows[0]?.active_days ?? 0);
  }
}
