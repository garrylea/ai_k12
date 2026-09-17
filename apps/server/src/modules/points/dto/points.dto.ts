import type { LevelInfo } from '../levels.js';
import type { AwardResult } from '../points.service.js';

/**
 * 学生端积分查询端点的响应类型（`GET /api/points/me*`，spec §7.1）。
 *
 * 放 dto/ 而不是 points.service.ts：这几个形状是**端点契约**，Task 9–12 的埋点只调
 * `award()`、不碰它们；集中在这里便于与 `docs/api/openapi.yaml` 对照。
 */

/** 埋点端点的响应里回带的发分结果（wire 形状，**与 `AwardResult` 不同**）。
 *  `levelUp.from/to` 是段位 code 字符串（`'pichai'` / `'zhutie'`）而不是 `LevelInfo`
 *  对象——前端只需要 code 去查图标。 */
export interface PointsAwardDto {
  awarded: number;
  balance: number;
  levelUp: { from: string; to: string } | null;
}

/**
 * `AwardResult` -> wire 形状：段位对象压成 code。**所有埋点端点共用这一处映射**
 * （Task 9 起），不要在各自的 service 里再写一份。
 *
 * 未发分（helper 吞掉异常返回 null，或 `award` 尚未被调用）时返回 `undefined`——
 * JSON 序列化会直接丢掉该字段；正常业务结果（duplicate/no_rule/daily_limit）仍带
 * `awarded: 0` 的对象，形状稳定，前端不必按 presence 分支。
 */
export function toPointsAwardDto(result: AwardResult | null | undefined): PointsAwardDto | undefined {
  if (!result) return undefined;
  return {
    awarded: result.pointsAwarded,
    balance: result.balance,
    levelUp: result.levelUp ? { from: result.levelUp.from.code, to: result.levelUp.to.code } : null,
  };
}

/**
 * 甲类埋点（既有判题响应里内联的 `pointsAwarded` / `awardReason`，spec §7.2）的
 * **未发分原因**枚举。
 *
 * `duplicate` **刻意不在枚举内**：幂等命中（同日重判同一目标物）时本次并未入账，
 * `PointsService.award` 虽会带回首次分值，但那是历史账 —— 一律按「静默、`pointsAwarded=0`」
 * 处理，避免前端弹假 `+N 分`（与 Task 10 的 `JudgeOutput.awardReason` 同一口径）。
 */
export type PointsAwardReason = 'daily_limit' | 'no_rule' | 'tier_inactive' | 'genre_unset';

/** `GET /api/points/me` —— 概览。 */
export interface PointsOverview {
  balance: number;
  /** 累计获得；段位与进度都按它算（兑换只扣 balance，不影响它）。 */
  totalEarned: number;
  /** 今日 `kind='earn'` 的 SUM(points)。 */
  todayEarned: number;
  level: LevelInfo;
  /** 已满级（王者）时为 null。 */
  nextLevel: LevelInfo | null;
  /** 已满级时为 null。 */
  pointsToNextLevel: number | null;
  /** 0-100 整数；满级为 100。 */
  progressPercent: number;
}

export type PointLedgerKind = 'earn' | 'redeem';

/** 流水一条。只暴露展示所需字段——`dedupe_key` / `task_code` 等内部字段不下发。 */
export interface PointLedgerEntry {
  id: number;
  kind: PointLedgerKind;
  /** 展示文案**快照**（家长之后改分值/档位名，历史流水不变）。 */
  title: string;
  /** earn 正数 / redeem 负数。 */
  points: number;
  createdAt: Date;
  refType: string | null;
}

/** `GET /api/points/me/ledger?page&pageSize` —— 分页流水。 */
export interface PointLedgerPage {
  items: PointLedgerEntry[];
  total: number;
  page: number;
  pageSize: number;
}
