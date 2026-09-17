import { BadRequestException, Inject, Injectable } from '@nestjs/common';
import type { Pool } from 'mysql2/promise';
import { PointRulesRepository } from '../../database/repositories/point-rules.repo.js';
import type { PointRuleRow, UpdatePointRuleInput } from '../../database/repositories/point-rules.repo.js';
import { PointLedgerRepository } from '../../database/repositories/point-ledger.repo.js';
import { PointsService } from './points.service.js';
import { DEFAULT_RULES, TASK_NAMES } from './default-rules.js';

/**
 * 家长批量保存的一条。三个可改字段都可缺省（与仓储层 `UpdatePointRuleInput` 同形）：
 * 缺省 = 不动这一列。controller 的 Zod 三字段必填，这里是服务层兜底。
 */
export interface PointRuleUpdate {
  taskCode: string;
  tierKey: string;
  points?: number;
  dailyLimit?: number | null;
  isActive?: boolean;
}

/** 一条档位的展示视图。字段类型直接取自仓储行类型 `PointRuleRow`，不另立一份字段清单。 */
export interface PointRuleTierView {
  tierKey: PointRuleRow['tier_key'];
  tierLabel: PointRuleRow['tier_label'];
  points: PointRuleRow['points'];
  dailyLimit: PointRuleRow['daily_limit'];
  isActive: boolean;
  /** 今日已发分条数；`withDailyCounts: false` 时未计算，为 null。 */
  completedToday: number | null;
  /** 今日还剩几次；`dailyLimit == null`（不限）或未计算时为 null。 */
  remainingToday: number | null;
}

export interface PointRuleGroup {
  taskCode: PointRuleRow['task_code'];
  taskName: string;
  tiers: PointRuleTierView[];
}

/** `listGrouped` 的返回，与 `GET me/rules` 的响应体同形，controller 直接透传。 */
export interface GroupedPointRules {
  tasks: PointRuleGroup[];
}

/** 复合 key 的分隔符用 NUL：task_code / tier_key 是任意字符串，NUL 不可能出现在其中。 */
const KEY_SEP = '\u0000';

function ruleKey(taskCode: string, tierKey: string): string {
  return `${taskCode}${KEY_SEP}${tierKey}`;
}

/**
 * 家长可配的分值规则（`point_rules`）读写。
 *
 * **懒初始化**：学生第一次被读到规则时才补齐默认档位（`ensureRules`），因此新增任务/档位
 * 零迁移。补齐只按 `(task_code, tier_key)` 比对、只插缺失的 key——家长改过的值永不回溯，
 * 这是有意决定（见 `PointRulesRepository` 的类注释）。
 *
 * **日期口径**：日边界不在这里重写，直接借 `PointsService.startOfToday/startOfTomorrow`
 * （仓内硬规矩：不在各模块重写日期格式化，也不在 SQL 里用 `CURDATE()`）。因此本服务依赖
 * `PointsService`——单向依赖，`PointsService` **不**反向依赖本服务，无环。
 */
@Injectable()
export class PointRulesService {
  constructor(
    @Inject('DATABASE_POOL') private readonly pool: Pool,
    private readonly rulesRepo: PointRulesRepository,
    private readonly ledgerRepo: PointLedgerRepository,
    private readonly points: PointsService,
  ) {}

  /**
   * 补齐该生缺失的默认档位（幂等）。
   *
   * 只补 `(taskCode, tierKey)` 不存在的行；已存在的行一律不动——**哪怕家长把分值/启用状态
   * 改成了与默认值不同的样子**。这是「懒初始化不回溯」的实现点。
   *
   * `award()` 自己也会补（它要保证发分路径自给自足），所以本方法不是唯一的初始化入口；
   * 但「读/写规则」的端点必须先跑它：否则从未发过分的全新学生在积分页会看到空表，
   * `listTierKeys` 也会返回空数组 → Task 12 的每个 start 请求都被 400。
   */
  async ensureRules(studentId: number): Promise<void> {
    const existing = await this.rulesRepo.findByStudent(studentId);
    const present = new Set(existing.map((row) => ruleKey(row.task_code, row.tier_key)));
    const missing = DEFAULT_RULES.filter((rule) => !present.has(ruleKey(rule.taskCode, rule.tierKey)));
    if (missing.length === 0) return;
    await this.rulesRepo.insertIgnoreBatch(studentId, missing);
  }

  /**
   * 按 `taskCode` 分组的规则表（组、组内档位都按 `sort_order`，来自 repo 的 ORDER BY）。
   *
   * `withDailyCounts: true` 时每个 `taskCode` 只查**一次** `countTodayEarned`（同日同任务的所有
   * 档位共用同一天计数），算出 `completedToday` / `remainingToday`；`dailyLimit == null` 表示不限，
   * `remainingToday` 为 null。未要求计数时两项都是 null（未计算），不假装成 0。
   *
   * 日边界在一次调用里只取一次：`dayEnd` 由 `dayStart` 派生，不会出现「一半任务算今天、
   * 一半算明天」，也不会因两次读数跨午夜把窗口撑成 48 小时。
   */
  async listGrouped(
    studentId: number,
    opts: { withDailyCounts?: boolean } = {},
  ): Promise<GroupedPointRules> {
    await this.ensureRules(studentId);
    const rows = await this.rulesRepo.findByStudent(studentId);

    const withDailyCounts = opts.withDailyCounts === true;
    // 一次调用只取一次日边界：dayEnd 由 dayStart 派生（startOfTomorrow 复用同一个时刻，不再读钟）。
    // 两个边界各自取钟若跨午夜，会得到 48 小时窗口，把两天的发分都算进今日。
    const dayStart = withDailyCounts ? this.points.startOfToday() : null;
    const dayEnd = dayStart === null ? null : this.points.startOfTomorrow(dayStart);
    const counts = new Map<string, number>();

    const groups = new Map<string, PointRuleGroup>();
    const tasks: PointRuleGroup[] = [];

    for (const row of rows) {
      let group = groups.get(row.task_code);
      if (group === undefined) {
        group = {
          taskCode: row.task_code,
          taskName: TASK_NAMES[row.task_code] ?? row.task_code,
          tiers: [],
        };
        groups.set(row.task_code, group);
        tasks.push(group); // rows 已按 sort_order 排，首次出现的顺序就是分组顺序
      }

      const dailyLimit =
        row.daily_limit === null || row.daily_limit === undefined ? null : Number(row.daily_limit);

      let completedToday: number | null = null;
      if (withDailyCounts && dayStart !== null && dayEnd !== null) {
        let count = counts.get(row.task_code);
        if (count === undefined) {
          count = await this.ledgerRepo.countTodayEarned(studentId, row.task_code, dayStart, dayEnd);
          counts.set(row.task_code, count);
        }
        completedToday = count;
      }

      group.tiers.push({
        tierKey: row.tier_key,
        tierLabel: row.tier_label,
        points: Number(row.points),
        dailyLimit,
        isActive: row.is_active === 1,
        completedToday,
        // 家长事后调低上限时今日条数可能已超限，剩次数按 0 封底，不给负数
        remainingToday:
          dailyLimit === null || completedToday === null ? null : Math.max(0, dailyLimit - completedToday),
      });
    }

    return { tasks };
  }

  /**
   * 该生该任务**已启用**的档位白名单，按 `sort_order` 排。
   *
   * Task 12 的两个 start 端点靠它校验「档位即可选项」。**必须**先 `ensureRules`：
   * 从未发过分的全新学生若直接查会拿到空数组，所有 start 请求都会 400。
   */
  async listTierKeys(studentId: number, taskCode: string): Promise<string[]> {
    await this.ensureRules(studentId);
    const rows = await this.rulesRepo.findByStudent(studentId);
    return rows
      .filter((row) => row.task_code === taskCode && row.is_active === 1)
      // repo 已按 sort_order, id 排；这里再排一次是把顺序写死成服务层契约（不依赖调用方）
      .sort((a, b) => a.sort_order - b.sort_order || a.id - b.id)
      .map((row) => row.tier_key);
  }

  /**
   * 家长批量保存：**一个事务**里逐条更新，要么全成、要么全不成。
   *
   * 顺序：先全量校验 → 再 `ensureRules`（新任务零迁移）→ 开事务逐条 `updateOne`。
   * 任何一条 `affectedRows === 0` 即抛 `3005 档位不存在` 并回滚整批。
   *
   * `affectedRows` 是**匹配**行数而非改动行数（mysql2 默认 `CLIENT_FOUND_ROWS`），
   * 所以家长原样重存同样的值仍返回 1，不会被误判成「档位不存在」。
   */
  async updateBatch(studentId: number, rules: PointRuleUpdate[]): Promise<void> {
    // 校验必须先跑完整批再碰 DB：批是原子的，不能写到一半才发现非法
    const patches = rules.map((rule) => this.buildPatch(rule));

    await this.ensureRules(studentId);

    const conn = await this.pool.getConnection();
    try {
      await conn.beginTransaction();
      for (let i = 0; i < rules.length; i += 1) {
        const { taskCode, tierKey } = rules[i];
        const affected = await this.rulesRepo.updateOne(studentId, taskCode, tierKey, patches[i], conn);
        if (affected === 0) {
          // 0 只有两种来源：档位不存在，或 patch 为空（空 patch 已在 buildPatch 挡掉）
          throw new BadRequestException({ code: 3005, message: '档位不存在' });
        }
      }
      await conn.commit();
    } catch (err) {
      // rollback 失败（连接已断）不能顶掉真正的失败原因；吞掉回滚错误，向上抛原始 err
      try { await conn.rollback(); } catch { /* 保留原始错误 */ }
      throw err;
    } finally {
      conn.release();
    }
  }

  /**
   * 把一条入参转成 patch，只带上**显式给到**的字段。
   *
   * 三个字段全缺省时必须在这里挡住：`updateOne` 对空 patch 返回 0，而 0 的语义被重载为
   * 「该 (task_code, tier_key) 不存在」——放行会对一个真实存在的档位报假 3005。
   */
  private buildPatch(rule: PointRuleUpdate): UpdatePointRuleInput {
    const patch: UpdatePointRuleInput = {};

    if (rule.points !== undefined) {
      // 不允许负数：`award()` 会把它写成 `kind='earn'` 的负分流水，`total_earned` 随之减少，
      // 破坏「段位只升不降」的不变式（`student-points.repo.ts` 把 total_earned 记为单调递增）。
      if (!Number.isInteger(rule.points) || rule.points < 0 || rule.points > 9999) {
        throw new BadRequestException({
          code: 1001,
          message: `points 必须是 0-9999 的整数（收到 ${String(rule.points)}）`,
        });
      }
      patch.points = rule.points;
    }

    if (rule.dailyLimit !== undefined) {
      // 不允许 0：`award()` 的上限判断是 `countTodayEarned(...) >= dailyLimit`，0 会让它恒真，
      // 该档位从此永久不发分。「不限」只能用 null 表达。
      if (rule.dailyLimit !== null && (!Number.isInteger(rule.dailyLimit) || rule.dailyLimit < 1 || rule.dailyLimit > 99)) {
        throw new BadRequestException({
          code: 1001,
          message: `dailyLimit 必须是 null 或 1-99 的整数（收到 ${String(rule.dailyLimit)}）`,
        });
      }
      patch.dailyLimit = rule.dailyLimit;
    }

    if (rule.isActive !== undefined) patch.isActive = rule.isActive;

    if (Object.keys(patch).length === 0) {
      throw new BadRequestException({
        code: 1001,
        message: '至少需要一个可改字段（points / dailyLimit / isActive）',
      });
    }

    return patch;
  }
}
