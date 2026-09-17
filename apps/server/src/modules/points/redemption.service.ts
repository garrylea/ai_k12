import {
  BadRequestException,
  Inject,
  Injectable,
  NotFoundException,
  Optional,
} from '@nestjs/common';
import type { Pool } from 'mysql2/promise';
import { ControlsRepository } from '../../database/repositories/controls.repo.js';
import { RewardCatalogRepository } from '../../database/repositories/reward-catalog.repo.js';
import type {
  RewardCatalogRow,
  RewardCatalogWriteInput,
} from '../../database/repositories/reward-catalog.repo.js';
import { PointRedemptionsRepository } from '../../database/repositories/point-redemptions.repo.js';
import type { PointRedemptionRow } from '../../database/repositories/point-redemptions.repo.js';
import { PointLedgerRepository } from '../../database/repositories/point-ledger.repo.js';
import { StudentPointsRepository } from '../../database/repositories/student-points.repo.js';
import { LEVELS, levelOf } from './levels.js';
import type { LevelInfo } from './levels.js';

/** 汇率缺省值（spec §4.2：`controls.points_per_yuan SMALLINT NOT NULL DEFAULT 20`）。 */
const DEFAULT_POINTS_PER_YUAN = 20;
/** 单次兑换分数上限。既是业务兜底，也防止 `cash_amount DECIMAL(10,2)` 溢出（INT 最大可到 21 亿）。 */
const MAX_POINTS = 999_999;
const MAX_NAME_LENGTH = 100;
const MAX_DESCRIPTION_LENGTH = 300;
const MAX_SORT_ORDER = 32_767;
const DEFAULT_PAGE_SIZE = 20;
const MAX_PAGE_SIZE = 100;

export type RedemptionType = 'cash' | 'reward';
export type RedemptionStatus = 'pending' | 'fulfilled';

/** 兑换入参：学生（家长代操作）要么声明花多少分换钱，要么指定要换的奖励。 */
export type RedeemInput =
  | { type: 'cash'; points: number }
  | { type: 'reward'; catalogId: number };

/** 家长批量保存奖励清单的一条。无 `id`（或 `id: null`）= 新增；有 `id` = 更新（整行覆盖）。 */
export interface RewardCatalogItemInput {
  id?: number | null;
  name: string;
  description?: string | null;
  pointsCost: number;
  minLevelCode?: string | null;
  isActive?: boolean;
  sortOrder?: number;
}

/** 家长配置页视角的奖励行。 */
export interface RewardCatalogView {
  id: number;
  name: string;
  description: string | null;
  pointsCost: number;
  minLevelCode: string | null;
  isActive: boolean;
  sortOrder: number;
}

/** 学生端只读视角：在 catalog 基础上给出「买不买得起 / 段位够不够 / 还差多少」。 */
export interface StudentRewardView {
  id: number;
  name: string;
  description: string | null;
  pointsCost: number;
  minLevelCode: string | null;
  affordable: boolean;
  levelOk: boolean;
  /** `max(0, pointsCost - balance)`，差多少分才够。 */
  gap: number;
}

export interface StudentRewards {
  balance: number;
  level: LevelInfo;
  items: StudentRewardView[];
}

export interface RedemptionView {
  id: number;
  type: RedemptionType;
  pointsSpent: number;
  cashAmount: number | null;
  rewardCatalogId: number | null;
  rewardName: string | null;
  status: RedemptionStatus;
  note: string | null;
  ledgerId: number | null;
  createdAt: Date;
  fulfilledAt: Date | null;
}

export interface RedeemResult {
  redemption: RedemptionView;
  balance: number;
  totalEarned: number;
  /** 兑换只会让余额变小，段位永远不降——这里回传的是兑换后的实时段位。 */
  level: LevelInfo;
}

export interface RedemptionList {
  items: RedemptionView[];
  total: number;
  page: number;
  pageSize: number;
}

/** 合法段位 code → 段位序号；未知 code 返回 -1（用于「脏 min_level_code 一律不可兑」）。 */
function levelIndexOf(code: string): number {
  return LEVELS.findIndex((level) => level.code === code);
}

function toRedemptionView(row: PointRedemptionRow): RedemptionView {
  return {
    id: row.id,
    type: row.type,
    pointsSpent: Number(row.points_spent),
    // DECIMAL 从 mysql2 回来是字符串，统一转 number 再出服务层
    cashAmount: row.cash_amount === null || row.cash_amount === undefined ? null : Number(row.cash_amount),
    rewardCatalogId: row.reward_catalog_id === null ? null : Number(row.reward_catalog_id),
    rewardName: row.reward_name,
    status: row.status,
    note: row.note,
    ledgerId: row.ledger_id === null ? null : Number(row.ledger_id),
    createdAt: row.created_at,
    fulfilledAt: row.fulfilled_at,
  };
}

/**
 * 积分兑换（换钱 / 换奖励）与奖励清单管理。
 *
 * **核心不变式：兑换绝不碰 `total_earned`，段位只升不降。**
 * 兑换事务里写的是 `kind='redeem'` 的负流水 + `upsertDelta(studentId, 0, -points, conn)`——
 * `earnedDelta` 恒为 0。任何将来改动若把非 0 传进去，`total_earned` 会减少、段位随之下降，
 * 直接破坏 spec §3 定案 #2。`levels.ts` 的 `levelOf` 没有、也不该有降级逻辑。
 *
 * **已知限制：本期兑换不可撤销。** `point_redemptions.status` 只是为将来「撤销」预留的状态位，
 * 当前没有任何回补流水的代码路径，`setRedemptionStatus` 也只写状态/时间。要撤销必须另开设计
 * （写正流水 + 重新校验段位语义），**不要在这里加半个实现**（spec §7.3 已明记）。
 *
 * 错误码（spec §7.3）：`3001` 余额不足 / `3002` 未达段位门槛 / `3003` 奖励已下架 /
 * `3004` 兑换已关闭；`1001` 入参非法 / `1002` 资源不存在（沿用全仓约定）。
 * 服务层自带兜底校验：Task 8 的 Zod 是外层闸门，但直接调用本服务也不能写出废单。
 */
@Injectable()
export class RedemptionService {
  /**
   * `now` 必须 `@Optional()`：本类带 `@Injectable()`，TS 会发出 `design:paramtypes`，
   * 函数类型 `() => Date` 在运行时是 `Function`，Nest 会拿它当 token 去容器找、
   * 找不到就**启动直接失败**（DI 坑，见 `points.service.ts` 同款注释）。
   */
  constructor(
    @Inject('DATABASE_POOL') private readonly pool: Pool,
    private readonly controlsRepo: ControlsRepository,
    private readonly catalogRepo: RewardCatalogRepository,
    private readonly redemptionsRepo: PointRedemptionsRepository,
    private readonly ledgerRepo: PointLedgerRepository,
    private readonly pointsRepo: StudentPointsRepository,
    @Optional() private readonly now: () => Date = () => new Date(),
  ) {}

  /**
   * 执行一次兑换。顺序不可调（每步都有理由）：
   * 1 开关（关了立刻 3004，连快照都不读）→ 2 解析兑换内容并校验（现金验证 points /
   * 奖励验 is_active、min_level）→ 3 读快照（段位门槛与余额共用一次读）→ 4 余额（3001）→
   * 5 事务（兑换单 + 负流水 + 快照 + 回写 ledger_id）→ 6 事务后重读快照返回。
   *
   * 所有「不满足条件」的拒绝都发生在事务之前 → 失败时**零写入**，不会留下半张兑换单。
   */
  async redeem(studentId: number, input: RedeemInput): Promise<RedeemResult> {
    // 1. 兑换总开关
    await this.controlsRepo.ensure(studentId);
    const controls = await this.controlsRepo.findByStudent(studentId);
    if (!controls.rewardRedemptionEnabled) {
      throw new BadRequestException({ code: 3004, message: '兑换已关闭' });
    }

    // 2. 解析兑换内容
    let points: number;
    let cashAmount: number | null = null;
    let catalogRow: RewardCatalogRow | null = null;

    if (input.type === 'cash') {
      points = this.requirePositiveInt(input.points, 'points');
      const perYuan =
        Number.isFinite(controls.pointsPerYuan) && controls.pointsPerYuan > 0
          ? controls.pointsPerYuan
          : DEFAULT_POINTS_PER_YUAN;
      // 学生声明的是「花多少分」，金额是**被推导**出来的（不是反过来）。保留 2 位小数。
      cashAmount = Math.round((points / perYuan) * 100) / 100;
    } else {
      const row = await this.catalogRepo.findOne(studentId, input.catalogId);
      if (row === null) {
        // 归属校验内建在 repo 的 WHERE student_id = ? 里，别人的 id 同样落这里
        throw new NotFoundException({ code: 1002, message: '奖励不存在' });
      }
      if (row.is_active === 0) {
        throw new BadRequestException({ code: 3003, message: '奖励已下架' });
      }
      points = this.requirePositiveInt(Number(row.points_cost), 'points_cost');
      catalogRow = row;
    }

    // 3. 读快照：段位门槛与余额共用这一次读
    const snapshot = await this.pointsRepo.find(studentId);

    // 3a. 段位门槛（仅奖励有）。min_level_code 为 NULL/'' = 无门槛；未知 code 属脏数据，一律不可兑。
    if (catalogRow !== null && catalogRow.min_level_code !== null && catalogRow.min_level_code !== '') {
      const required = levelIndexOf(catalogRow.min_level_code);
      if (required < 0 || levelOf(snapshot.totalEarned).index < required) {
        throw new BadRequestException({ code: 3002, message: '未达该奖励的段位门槛' });
      }
    }

    // 4. 余额
    if (snapshot.balance < points) {
      throw new BadRequestException({ code: 3001, message: '积分余额不足' });
    }

    const title =
      input.type === 'cash'
        ? `兑换 · 现金 ¥${(cashAmount ?? 0).toFixed(2)}`
        : `兑换 · ${catalogRow?.name ?? ''}`;
    const rewardName = input.type === 'reward' ? (catalogRow?.name ?? null) : null;

    // 5. 事务：兑换单（pending）+ 负流水 + 快照扣余额 + 回写 ledger_id
    const written = await this.writeRedemption({
      studentId,
      type: input.type,
      points,
      cashAmount,
      catalogId: input.type === 'reward' ? (catalogRow?.id ?? null) : null,
      rewardName,
      title,
    });

    // 6. 事务后重读：balance 与 totalEarned 以库为准（totalEarned 必须与兑换前一致）
    const after = await this.pointsRepo.find(studentId);
    return {
      redemption: {
        id: written.id,
        type: input.type,
        pointsSpent: points,
        cashAmount,
        rewardCatalogId: input.type === 'reward' ? (catalogRow?.id ?? null) : null,
        rewardName,
        status: 'pending',
        note: null,
        ledgerId: written.ledgerId,
        createdAt: this.now(),
        fulfilledAt: null,
      },
      balance: after.balance,
      totalEarned: after.totalEarned,
      level: levelOf(after.totalEarned),
    };
  }

  /** 家长配置页的奖励清单：返回**全部**行（含已下架，便于重新启用）。 */
  async listCatalog(studentId: number): Promise<RewardCatalogView[]> {
    const rows = await this.catalogRepo.listByStudent(studentId);
    return rows.map((row) => ({
      id: row.id,
      name: row.name,
      description: row.description,
      pointsCost: Number(row.points_cost),
      minLevelCode: row.min_level_code,
      isActive: row.is_active === 1,
      sortOrder: Number(row.sort_order),
    }));
  }

  /**
   * 学生端只读：只回 active 奖励，并逐项标注 `affordable` / `levelOk` / `gap`，
   * 省得前端自己知道汇率、段位表和余额口径（单一真源在服务端）。
   */
  async listForStudent(studentId: number): Promise<StudentRewards> {
    const [rows, snapshot] = await Promise.all([
      this.catalogRepo.listByStudent(studentId),
      this.pointsRepo.find(studentId),
    ]);
    const level = levelOf(snapshot.totalEarned);

    const items: StudentRewardView[] = rows
      .filter((row) => row.is_active === 1)
      .map((row) => {
        const pointsCost = Number(row.points_cost);
        const minLevelCode = row.min_level_code;
        const hasGate = minLevelCode !== null && minLevelCode !== '';
        const required = hasGate ? levelIndexOf(minLevelCode) : -1;
        return {
          id: row.id,
          name: row.name,
          description: row.description,
          pointsCost,
          minLevelCode,
          affordable: snapshot.balance >= pointsCost,
          // 无门槛恒 true；未知 code（-1）恒 false
          levelOk: !hasGate || (required >= 0 && level.index >= required),
          gap: Math.max(0, pointsCost - snapshot.balance),
        };
      });

    return { balance: snapshot.balance, level, items };
  }

  /**
   * 家长批量保存奖励清单：**一个事务**，要么全成、要么全不成。
   *
   * 语义是整表 PUT：无 `id` 新增、有 `id` 更新（整行覆盖）、payload 里消失的 id 软删
   * （`is_active = 0`）。校验必须**先跑完整批**再碰 DB——批是原子的，不能写到一半才发现非法。
   */
  async saveCatalog(studentId: number, items: RewardCatalogItemInput[]): Promise<RewardCatalogView[]> {
    const normalized = items.map((item, index) => this.normalizeCatalogItem(item, index));

    const conn = await this.pool.getConnection();
    try {
      await conn.beginTransaction();
      const keepIds: number[] = [];
      for (let i = 0; i < items.length; i += 1) {
        const id = items[i].id ?? null;
        if (id === null) {
          keepIds.push(await this.catalogRepo.insert(studentId, normalized[i], conn));
        } else {
          const affected = await this.catalogRepo.update(studentId, id, normalized[i], conn);
          if (affected === 0) {
            // id 不存在或属于别的学生：整批回滚，不留半套清单
            throw new BadRequestException({
              code: 1001,
              message: `奖励不存在或不属于该学生（id=${id}）`,
            });
          }
          keepIds.push(id);
        }
      }
      // 新增的自增 id 也在 keepIds 里，不会被自己的软删误伤
      await this.catalogRepo.deactivateMissing(studentId, keepIds, conn);
      await conn.commit();
    } catch (err) {
      // rollback 失败（连接已断）不能顶掉真正的失败原因；吞掉回滚错误，向上抛原始 err
      try { await conn.rollback(); } catch { /* 保留原始错误 */ }
      throw err;
    } finally {
      conn.release();
    }

    return this.listCatalog(studentId);
  }

  /** 兑换记录分页。`page` 从 1 起；非法值回落到默认，不抛错（查询类宽容）。 */
  async listRedemptions(
    studentId: number,
    page = 1,
    pageSize = DEFAULT_PAGE_SIZE,
  ): Promise<RedemptionList> {
    const safePage = Number.isInteger(page) && page >= 1 ? page : 1;
    const safeSize =
      Number.isInteger(pageSize) && pageSize >= 1 && pageSize <= MAX_PAGE_SIZE
        ? pageSize
        : DEFAULT_PAGE_SIZE;

    const [rows, total] = await Promise.all([
      this.redemptionsRepo.listByStudent(studentId, safeSize, (safePage - 1) * safeSize),
      this.redemptionsRepo.countByStudent(studentId),
    ]);

    return { items: rows.map(toRedemptionView), total, page: safePage, pageSize: safeSize };
  }

  /**
   * 只改兑换单状态（pending ⇄ fulfilled），**绝不动积分**——本期兑换不可撤销。
   * `fulfilled_at` 用服务器时间；回到 pending 时清空。归属校验在 repo 的 `WHERE student_id = ?`。
   */
  async setRedemptionStatus(
    studentId: number,
    id: number,
    status: RedemptionStatus,
  ): Promise<void> {
    if (status !== 'pending' && status !== 'fulfilled') {
      throw new BadRequestException({
        code: 1001,
        message: `status 必须是 pending 或 fulfilled（收到 ${String(status)}）`,
      });
    }
    const affected = await this.redemptionsRepo.updateStatus(
      studentId,
      id,
      status,
      status === 'fulfilled' ? this.now() : null,
    );
    if (affected === 0) {
      throw new NotFoundException({ code: 1002, message: '兑换单不存在' });
    }
  }

  /**
   * 兑换事务。返回新兑换单 id 与流水 id。
   *
   * ⚠️ 顺序不能变：必须先插兑换单拿自增 id，才能拼 `dedupe_key = 'redeem:<id>'`。
   * `redemption_id` 同时落进流水，便于将来「撤销」按单定位。
   *
   * `upsertDelta(..., 0, -points, conn)` 的 **earnedDelta 恒为 0**：这是「段位只升不降」的唯一
   * 实现点，改错一个参数就会让 `total_earned` 减少（见类注释）。
   */
  private async writeRedemption(args: {
    studentId: number;
    type: RedemptionType;
    points: number;
    cashAmount: number | null;
    catalogId: number | null;
    rewardName: string | null;
    title: string;
  }): Promise<{ id: number; ledgerId: number }> {
    const { studentId, points } = args;
    const conn = await this.pool.getConnection();
    try {
      await conn.beginTransaction();

      const redemptionId = await this.redemptionsRepo.insert(
        {
          student_id: studentId,
          type: args.type,
          points_spent: points,
          cash_amount: args.cashAmount,
          reward_catalog_id: args.catalogId,
          reward_name: args.rewardName,
          note: null,
        },
        conn,
      );

      const ledger = await this.ledgerRepo.insert(
        {
          student_id: studentId,
          kind: 'redeem',
          task_code: 'redeem',
          tier_key: 'default',
          points: -points,
          dedupe_key: `redeem:${redemptionId}`,
          title: args.title,
          ref_type: null,
          ref_id: null,
          redemption_id: redemptionId,
        },
        conn,
      );
      if (ledger.duplicate) {
        // 自增 id 刚拿到，dedupe_key 正常不可能撞。真撞了说明库里已存在同 id 流水（数据异常），
        // 此时 insertId 不可依赖——绝不能把 ledger_id=0 写进兑换单，直接失败回滚。
        throw new Error(`兑换单 ${redemptionId} 的流水已存在（dedupe_key 冲突）`);
      }

      // earnedDelta = 0：兑换只扣可用余额，绝不碰 total_earned
      await this.pointsRepo.upsertDelta(studentId, 0, -points, conn);

      const affected = await this.redemptionsRepo.setLedgerId(studentId, redemptionId, ledger.id, conn);
      if (affected === 0) {
        throw new Error(`兑换单 ${redemptionId} 回写 ledger_id 失败`);
      }

      await conn.commit();
      return { id: redemptionId, ledgerId: ledger.id };
    } catch (err) {
      try { await conn.rollback(); } catch { /* 保留原始错误 */ }
      throw err;
    } finally {
      conn.release();
    }
  }

  /**
   * 正整数边界校验（`points` / `points_cost` 共用）。1 ~ `MAX_POINTS`，服务层兜底——
   * Task 8 的 Zod 是外层闸门，但直接调用本服务也不能写出废单/让金额溢出 DECIMAL(10,2)。
   */
  private requirePositiveInt(value: number, label: string): number {
    if (!Number.isInteger(value) || value <= 0 || value > MAX_POINTS) {
      throw new BadRequestException({
        code: 1001,
        message: `${label} 必须是 1-${MAX_POINTS} 的整数（收到 ${String(value)}）`,
      });
    }
    return value;
  }

  /**
   * 把一条家长入参规范化成完整可写行。缺省值：description/minLevelCode = null、
   * **isActive = true**、sortOrder = 0。任何非法输入抛 1001（在事务之前，整批不落库）。
   *
   * ⚠️ `isActive` 缺省为 true 意味着：更新一条**已下架**的行时若不显式带 `isActive: false`，
   * 会被重新上架。`listCatalog` 会回传每行的 isActive，前端整表 PUT 时应原样带回。
   */
  private normalizeCatalogItem(item: RewardCatalogItemInput, index: number): RewardCatalogWriteInput {
    if (item.id !== undefined && item.id !== null && (!Number.isInteger(item.id) || item.id <= 0)) {
      throw new BadRequestException({ code: 1001, message: `第 ${index + 1} 条的 id 非法` });
    }

    const name = typeof item.name === 'string' ? item.name.trim() : '';
    if (name.length === 0 || name.length > MAX_NAME_LENGTH) {
      throw new BadRequestException({
        code: 1001,
        message: `第 ${index + 1} 条的 name 必须是 1-${MAX_NAME_LENGTH} 字符`,
      });
    }

    const description = item.description ?? null;
    if (description !== null && (typeof description !== 'string' || description.length > MAX_DESCRIPTION_LENGTH)) {
      throw new BadRequestException({
        code: 1001,
        message: `第 ${index + 1} 条的 description 必须不超过 ${MAX_DESCRIPTION_LENGTH} 字符`,
      });
    }

    const pointsCost = this.requirePositiveInt(item.pointsCost, 'pointsCost');

    const rawMinLevel = item.minLevelCode ?? null;
    const minLevelCode = rawMinLevel === '' ? null : rawMinLevel;
    if (minLevelCode !== null && levelIndexOf(minLevelCode) < 0) {
      throw new BadRequestException({
        code: 1001,
        message: `第 ${index + 1} 条的 minLevelCode 不是合法段位（收到 ${String(minLevelCode)}）`,
      });
    }

    const isActive = item.isActive ?? true;
    if (typeof isActive !== 'boolean') {
      throw new BadRequestException({ code: 1001, message: `第 ${index + 1} 条的 isActive 必须是布尔值` });
    }

    const sortOrder = item.sortOrder ?? 0;
    if (!Number.isInteger(sortOrder) || sortOrder < 0 || sortOrder > MAX_SORT_ORDER) {
      throw new BadRequestException({
        code: 1001,
        message: `第 ${index + 1} 条的 sortOrder 必须是 0-${MAX_SORT_ORDER} 的整数`,
      });
    }

    return { name, description, pointsCost, minLevelCode, isActive, sortOrder };
  }
}
