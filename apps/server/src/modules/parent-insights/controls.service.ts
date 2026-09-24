import { ConflictException, Injectable } from '@nestjs/common';
import { ControlsRepository } from '../../database/repositories/controls.repo.js';
import type { ParentControls } from './dto/parent-insights.dto.js';

/** 预警灵敏度可调范围（spec §4.2）：1..180 分钟。 */
export const ALERT_MINUTES_MIN = 1;
export const ALERT_MINUTES_MAX = 180;

/**
 * 单次学习锁定可调范围（spec §5.6）：1..480 分钟（8 小时）。
 *
 * 上限取 480 的理由：覆盖长时段自习；代价是「设 480 + 断网」会让最长 8 小时无法登出——
 * 这是**有意的严格性**（拔网线不解锁，否则等于白送逃逸通道），必须在家长端文案里说清。
 */
export const SESSION_LOCK_MINUTES_MIN = 1;
export const SESSION_LOCK_MINUTES_MAX = 480;

/** 本端点认这三个字段；兑换汇率/开关归 `PUT .../points/settings`，不在这里。 */
export interface ControlsUpdatePatch {
  alertAwayMinutes?: number;
  alertIdleMinutes?: number;
  /** `null` = 解除设置（合法值）；`undefined` = 不动。 */
  sessionLockMinutes?: number | null;
}

/**
 * 行为管控 —— 预警灵敏度 + 单次学习锁定读写（spec §4.1/§4.2/§5.6）。
 *
 * 学生归属校验在 controller（`requireOwnedStudent`），与本 controller 其余端点一致；
 * 这里只管「至少一个字段」与两条范围规则（阈值 1..180、锁定时长 1..480），都是 `409`/`1001`。
 *
 * 响应含**预警两个阈值 + 单次学习锁定分钟数**；兑换汇率/开关仍不在此：
 * `findByStudent` 还会读出兑换两列，本批明确不带出去（同一字段两个归属会打架；
 * Task 3 已出过一次「多返回两字段」的事故）。
 */
@Injectable()
export class ControlsService {
  constructor(private readonly controlsRepo: ControlsRepository) {}

  /** spec §4.1：`ensure`（无行则建默认行）→ 回读 → 只取三个字段。 */
  async get(studentId: number): Promise<ParentControls> {
    await this.controlsRepo.ensure(studentId);
    return this.snapshot(studentId);
  }

  /**
   * spec §4.2：至少一个字段（409/1001）→ 范围校验（409/1001）→ `ensure` → `update`
   * → **回读** `findByStudent` → 返回完整对象。
   *
   * 回读（而不是回声入参）是刻意的：`update` 是白名单部分更新，回读才是库里的真值。
   */
  async update(studentId: number, patch: ControlsUpdatePatch): Promise<ParentControls> {
    if (
      patch.alertAwayMinutes === undefined &&
      patch.alertIdleMinutes === undefined &&
      patch.sessionLockMinutes === undefined
    ) {
      throw new ConflictException({ code: 1001, message: '没有要更新的字段' });
    }
    const alertEntries: Array<[string, number | undefined]> = [
      ['alertAwayMinutes', patch.alertAwayMinutes],
      ['alertIdleMinutes', patch.alertIdleMinutes],
    ];
    for (const [name, value] of alertEntries) {
      if (value === undefined) continue;
      if (!Number.isInteger(value) || value < ALERT_MINUTES_MIN || value > ALERT_MINUTES_MAX) {
        throw new ConflictException({
          code: 1001,
          message: `${name} 必须是 ${ALERT_MINUTES_MIN}-${ALERT_MINUTES_MAX} 的整数（收到 ${value}）`,
        });
      }
    }
    // null 是合法值（解除设置），只在非 null 时校验范围。
    if (patch.sessionLockMinutes !== undefined && patch.sessionLockMinutes !== null) {
      const value = patch.sessionLockMinutes;
      if (
        !Number.isInteger(value) ||
        value < SESSION_LOCK_MINUTES_MIN ||
        value > SESSION_LOCK_MINUTES_MAX
      ) {
        throw new ConflictException({
          code: 1001,
          message: `sessionLockMinutes 必须是 ${SESSION_LOCK_MINUTES_MIN}-${SESSION_LOCK_MINUTES_MAX} 的整数或 null（收到 ${value}）`,
        });
      }
    }

    await this.controlsRepo.ensure(studentId);
    await this.controlsRepo.update(studentId, patch);
    return this.snapshot(studentId);
  }

  /** 只取这三个字段（`findByStudent` 的兑换两列在此丢弃，勿透传）。 */
  private async snapshot(studentId: number): Promise<ParentControls> {
    const controls = await this.controlsRepo.findByStudent(studentId);
    return {
      alertAwayMinutes: controls.alertAwayMinutes,
      alertIdleMinutes: controls.alertIdleMinutes,
      sessionLockMinutes: controls.sessionLockMinutes,
    };
  }
}
