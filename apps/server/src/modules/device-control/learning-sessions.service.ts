import { Inject, Injectable } from '@nestjs/common';
import { LearningSessionsRepository } from '../../database/repositories/learning-sessions.repo.js';
import type { LearningSessionRow } from '../../database/repositories/learning-sessions.repo.js';
import { ControlsRepository } from '../../database/repositories/controls.repo.js';
import type { StudentSessionView } from './dto/device-control.dto.js';

/** 本期只有 Electron 壳会写；埋点既有枚举是 web|electron，这里复用。 */
export const LEARNING_SESSION_APP_SHELL = 'electron';

/**
 * 把一行映射成对外视图。
 *
 * `toISOString()` 而不是交给 JSON 序列化：`Date` 直接序列化虽也是 ISO，但一旦某个
 * 字段被 mysql2 配成 `dateStrings` 就会退化成 `"2026-09-23 01:00:00.000"`，
 * 前端 `new Date(...)` 在 Safari 上会得到 Invalid Date。显式转换把这个风险钉死。
 */
export function toSessionView(row: LearningSessionRow): StudentSessionView {
  return {
    id: row.id,
    startedAt: row.started_at.toISOString(),
    lockMinutes: row.lock_minutes === null ? null : Number(row.lock_minutes),
    lockExpiresAt: row.lock_expires_at === null ? null : row.lock_expires_at.toISOString(),
    unlockedAt: row.unlocked_at === null ? null : row.unlocked_at.toISOString(),
  };
}

@Injectable()
export class LearningSessionsService {
  constructor(
    @Inject(LearningSessionsRepository) private readonly sessions: LearningSessionsRepository,
    @Inject(ControlsRepository) private readonly controls: ControlsRepository,
  ) {}

  /**
   * 取或建本次学习会话（spec §5.1）。幂等。
   *
   * 顺序很重要：**先查进行中的会话**。命中就直接返回——绝不能在客户端重启时
   * 重新读一遍 `session_lock_minutes` 再算一个新的到期时间，那等于「重启即重置时钟」，
   * 学生只要重启就能无限续时。
   */
  async openOrGet(studentId: number): Promise<StudentSessionView> {
    const open = await this.sessions.findOpen(studentId);
    if (open) {
      await this.sessions.touch(studentId);
      return toSessionView(open);
    }

    const lockMinutes = await this.controls.findSessionLockMinutes(studentId);
    const created = await this.sessions.insertOpen({
      studentId,
      appShell: LEARNING_SESSION_APP_SHELL,
      lockMinutes,
    });
    return toSessionView(created);
  }
}
