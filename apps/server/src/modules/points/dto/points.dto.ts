import type { LevelInfo } from '../levels.js';

/**
 * 学生端积分查询端点的响应类型（`GET /api/points/me*`，spec §7.1）。
 *
 * 放 dto/ 而不是 points.service.ts：这几个形状是**端点契约**，Task 9–12 的埋点只调
 * `award()`、不碰它们；集中在这里便于与 `docs/api/openapi.yaml` 对照。
 */

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
