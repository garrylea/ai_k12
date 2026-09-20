import { Injectable } from '@nestjs/common';
import { SafetyAlertsRepository } from '../../database/repositories/safety-alerts.repo.js';

/**
 * 预警保留期（天）。**固定常量，不接受入参**（用户 2026-09-20 裁决）。
 *
 * 不给阈值加参数是为了杜绝「填 0 就删库」这类误操作；要改就改这个常量。
 */
export const RETENTION_DAYS = 30;

const DAY_MS = 24 * 60 * 60 * 1000;

export interface ExpiredAlertPreview {
  retentionDays: number;
  /** ISO 字符串：`created_at < cutoff` 的行会被清理。给前端展示用。 */
  cutoff: string;
  total: number;
  unread: number;
}

export interface ExpiredAlertPurgeResult {
  retentionDays: number;
  cutoff: string;
  deleted: number;
}

/**
 * 管理员端「预警数据」：预览 + 手动清理 30 天前的预警。
 *
 * **无 scheduler、无定时任务** —— 只由管理员点按钮触发（本批明确不做自动保留期，
 * 见 spec §9 已知限制）。仓储不写 `NOW()`，cutoff 在这里算好传下去。
 */
@Injectable()
export class AdminAlertsService {
  constructor(private readonly alertsRepo: SafetyAlertsRepository) {}

  /** 现在往前 30 天。`Date.now()` 而非仓储里的 `NOW()`，保留期才可离线断言。 */
  private cutoff(): Date {
    return new Date(Date.now() - RETENTION_DAYS * DAY_MS);
  }

  /** 清理前预览：有多少条会被删、其中多少条未读（未读的也会被删，让管理员心里有数）。 */
  async preview(): Promise<ExpiredAlertPreview> {
    const cutoff = this.cutoff();
    const { total, unread } = await this.alertsRepo.countOlderThan(cutoff);
    return { retentionDays: RETENTION_DAYS, cutoff: cutoff.toISOString(), total, unread };
  }

  /** 执行清理：物理删除 30 天前的预警（**含未读**）。返回删除条数。 */
  async purge(): Promise<ExpiredAlertPurgeResult> {
    const cutoff = this.cutoff();
    const deleted = await this.alertsRepo.deleteOlderThan(cutoff);
    return { retentionDays: RETENTION_DAYS, cutoff: cutoff.toISOString(), deleted };
  }
}
