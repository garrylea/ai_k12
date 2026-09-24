import { Inject, Injectable } from '@nestjs/common';
import { LearningSessionsRepository } from '../../database/repositories/learning-sessions.repo.js';
import type { LearningSessionRow } from '../../database/repositories/learning-sessions.repo.js';
import type { ParentSessionItem, ParentSessionPage } from './dto/device-control.dto.js';

/**
 * 判「在线」的心跳窗口（秒）。
 *
 * ⚠️ **与客户端轮询间隔成对**：客户端 `LEARNING_SESSION_POLL_MS = 10_000`（10 秒，
 * 见计划 2）。45 秒 = 容忍 4 次丢包/抖动。**改一处必须同步另一处**
 * （沿用本仓 `CLIENT_IDLE_DETECTION_SECONDS` ↔ `IDLE_TIMEOUT_MS` 的镜像纪律）。
 *
 * 这个阈值**只在这一处**：前端不重算，只消费后端下发的 `online`。
 */
export const LEARNING_SESSION_ONLINE_WINDOW_SECONDS = 45;

/**
 * 家长端「进出时间」（spec §5.5）。
 *
 * 这是**新能力**：现有家长端时长全是聚合值（`parent-analytics.repo` 的
 * getStudyTimeTotal / ByDay / ByModule / BySubject / getActiveDays），没有一行返回原始起止时刻；
 * 而 `study_sessions` 是**学习页粒度**（进一个场景一行），不是登录粒度。所以靠
 * `learning_sessions` 而不是去拼 `study_sessions`。
 */
@Injectable()
export class LearningSessionLogService {
  constructor(
    @Inject(LearningSessionsRepository) private readonly sessions: LearningSessionsRepository,
  ) {}

  async list(studentId: number, days: number, limit: number): Promise<ParentSessionPage> {
    const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
    const [rows, total] = await Promise.all([
      this.sessions.listByStudent(studentId, since, limit),
      this.sessions.countByStudent(studentId, since),
    ]);
    return { items: rows.map((row) => this.toItem(row)), total };
  }

  private toItem(row: LearningSessionRow): ParentSessionItem {
    return {
      id: row.id,
      startedAt: row.started_at.toISOString(),
      endedAt: row.ended_at === null ? null : row.ended_at.toISOString(),
      // 后端算好下发，前端不重算阈值。已结束的会话永远不算在线。
      online:
        row.ended_at === null &&
        Date.now() - row.last_seen_at.getTime() <= LEARNING_SESSION_ONLINE_WINDOW_SECONDS * 1000,
      lockMinutes: row.lock_minutes === null ? null : Number(row.lock_minutes),
      lockExpiresAt:
        row.lock_expires_at === null ? null : row.lock_expires_at.toISOString(),
      unlockedAt: row.unlocked_at === null ? null : row.unlocked_at.toISOString(),
    };
  }
}
