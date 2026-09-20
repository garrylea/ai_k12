import { ConflictException, Injectable } from '@nestjs/common';
import { ControlsRepository } from '../../database/repositories/controls.repo.js';
import type { ParentControls } from './dto/parent-insights.dto.js';

/** 预警灵敏度可调范围（spec §4.2）：1..180 分钟。 */
export const ALERT_MINUTES_MIN = 1;
export const ALERT_MINUTES_MAX = 180;

/** 本端点只认这两个字段；兑换汇率/开关归 `PUT .../points/settings`，不在这里。 */
export interface ControlsUpdatePatch {
  alertAwayMinutes?: number;
  alertIdleMinutes?: number;
}

/**
 * 行为管控 —— 预警灵敏度读写（spec §4.1/§4.2）。
 *
 * 学生归属校验在 controller（`requireOwnedStudent`），与本 controller 其余端点一致；
 * 这里只管「至少一个字段」与「范围 1..180」两条业务规则，两者都是 `409`/`1001`。
 *
 * 响应**只含两个阈值**：`findByStudent` 还会读出兑换汇率/开关，本批明确不带出去
 * （同一字段两个归属会打架；Task 3 已出过一次「多返回两字段」的事故）。
 */
@Injectable()
export class ControlsService {
  constructor(private readonly controlsRepo: ControlsRepository) {}

  /** spec §4.1：`ensure`（无行则建默认行）→ 回读 → 只取两个阈值。 */
  async get(studentId: number): Promise<ParentControls> {
    await this.controlsRepo.ensure(studentId);
    return this.snapshot(studentId);
  }

  /**
   * spec §4.2：至少一个字段（409/1001）→ 范围 1..180（409/1001）→ `ensure` → `update`
   * → **回读** `findByStudent` → 返回完整对象。
   *
   * 回读（而不是回声入参）是刻意的：`update` 是白名单部分更新，回读才是库里的真值。
   */
  async update(studentId: number, patch: ControlsUpdatePatch): Promise<ParentControls> {
    if (patch.alertAwayMinutes === undefined && patch.alertIdleMinutes === undefined) {
      throw new ConflictException({ code: 1001, message: '没有要更新的字段' });
    }
    const entries: Array<[keyof ControlsUpdatePatch, number | undefined]> = [
      ['alertAwayMinutes', patch.alertAwayMinutes],
      ['alertIdleMinutes', patch.alertIdleMinutes],
    ];
    for (const [name, value] of entries) {
      if (value === undefined) continue;
      if (!Number.isInteger(value) || value < ALERT_MINUTES_MIN || value > ALERT_MINUTES_MAX) {
        throw new ConflictException({
          code: 1001,
          message: `${name} 必须是 ${ALERT_MINUTES_MIN}-${ALERT_MINUTES_MAX} 的整数（收到 ${value}）`,
        });
      }
    }

    await this.controlsRepo.ensure(studentId);
    await this.controlsRepo.update(studentId, patch);
    return this.snapshot(studentId);
  }

  /** 只取两个阈值列（`findByStudent` 的其余两列在此丢弃，勿透传）。 */
  private async snapshot(studentId: number): Promise<ParentControls> {
    const controls = await this.controlsRepo.findByStudent(studentId);
    return {
      alertAwayMinutes: controls.alertAwayMinutes,
      alertIdleMinutes: controls.alertIdleMinutes,
    };
  }
}
