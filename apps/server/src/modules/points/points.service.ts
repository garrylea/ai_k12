import { Inject, Injectable, Optional } from '@nestjs/common';
import type { Pool } from 'mysql2/promise';
import { PointRulesRepository } from '../../database/repositories/point-rules.repo.js';
import type { PointRuleRow } from '../../database/repositories/point-rules.repo.js';
import { PointLedgerRepository } from '../../database/repositories/point-ledger.repo.js';
import { StudentPointsRepository } from '../../database/repositories/student-points.repo.js';
import { DEFAULT_RULES, TASK_NAMES } from './default-rules.js';
import { detectLevelUp } from './levels.js';
import type { LevelInfo } from './levels.js';

export interface AwardInput {
  studentId: number;
  taskCode: string;
  tierKey?: string;          // 默认 'default'
  dedupeKey: string;         // 调用方拼，见 spec §4.4
  refType?: string | null;
  refId?: number | null;
}

export type AwardReason = 'daily_limit' | 'no_rule' | 'tier_inactive' | 'duplicate';

export interface AwardResult {
  pointsAwarded: number;     // 实际入账分（0 = 没发）
  balance: number;
  totalEarned: number;
  levelUp: { from: LevelInfo; to: LevelInfo } | null;
  reason?: AwardReason;
}

/**
 * 发分引擎：全部 8 类任务的**唯一**发分入口。
 *
 * **顺序不能变**（每一步都有理由）：
 * 0. 确保规则存在 → 1. 规则 → 2. 档位 → 3. 停用 → 4. 每日上限 → 5. 发分前累计 → 6. 事务（流水 + 快照）→ 7. 跨档。
 * - 每日上限必须早于 INSERT：先写再判会让「到上限的那一条」已经落库。
 * - 发分前累计必须早于事务：`detectLevelUp(old, new)` 要的是事务前的旧值。
 * - 停用早于上限：停用档位连计数都不该查。
 *
 * **只对 DB 故障抛错**：`no_rule` / `tier_inactive` / `daily_limit` / `duplicate`
 * 都是正常业务结果，以 `pointsAwarded: 0`（duplicate 为首次分值）+ `reason` 返回。
 *
 * **安全**：`dedupeKey` 是必填参数、**只能由服务端从已知 id 拼**（如 `paper:<sessionId>`）。
 * `findByDedupeKey` 没有 `student_id` 过滤，而 key 里嵌了自增 id——若 key 可来自请求体，
 * 客户端就能枚举/构造别人的 key。任何埋点都必须调 `todayKey()`，不要接受外部字符串。
 */
@Injectable()
export class PointsService {
  /**
   * `now` 必须 `@Optional()`：本类带 `@Injectable()`，TS 会发出 `design:paramtypes`，
   * 函数类型 `() => Date` 在运行时是 `Function`，Nest 会拿它当 token 去容器找、
   * 找不到就**启动直接失败**（同 `vocabulary.service.ts` 里注记的 DI 坑）。
   * 加 `@Optional()` 后容器跳过它，走这里的默认值；测试用第 5 个参数注入固定时钟。
   */
  constructor(
    @Inject('DATABASE_POOL') private readonly pool: Pool,
    private readonly rulesRepo: PointRulesRepository,
    private readonly ledgerRepo: PointLedgerRepository,
    private readonly pointsRepo: StudentPointsRepository,
    @Optional() private readonly now: () => Date = () => new Date(),
  ) {}

  /**
   * 发一次分。调用方负责拼 `dedupeKey`（spec §4.4 的幂等键表）。
   *
   * **自给自足**：本方法自己保证学生的规则已初始化，调用方**不需要**先跑
   * `PointRulesService.ensureRules()`（那是给积分页/家长配置页用的）。首次发分的学生
   * （家长没配过、本人也没点过积分页）在这里补齐默认档位，不会静默 0 分。
   */
  async award(input: AwardInput): Promise<AwardResult> {
    const { studentId, taskCode } = input;
    const tierKey = input.tierKey ?? 'default';

    // 0. 确保规则存在。award() 是 8 条发分路径的**公共入口**，不能假设调用方已跑过
    //    ensureRules（那一步只在「读/写规则」的端点里）。这里直接用 repo + 常量、
    //    刻意**不注入 PointRulesService**：避免两个 service 耦合与潜在循环依赖。
    //    INSERT IGNORE 撞唯一键即跳过，家长已改过的值不会被默认值覆盖，代价可忽略。
    await this.rulesRepo.insertIgnoreBatch(studentId, DEFAULT_RULES);

    // 1~2. 规则与档位
    const rules = await this.rulesRepo.findByStudent(studentId);
    const rule = rules.find((r) => r.task_code === taskCode && r.tier_key === tierKey) ?? null;
    if (rule === null) return this.skipped(studentId, 'no_rule');

    // 3. 家长停用了这一档
    if (rule.is_active === 0) return this.skipped(studentId, 'tier_inactive');

    const points = Number(rule.points);

    // 4. 每日上限：当天该 task_code 的 earn 流水**条数**（一轮/一篇/一个会话各算 1 条）。
    //    日界在 Node 侧算好传参，不用 SQL 的 CURDATE()（DB 会话时区可能与应用不一致）。
    const dailyLimit = rule.daily_limit === null || rule.daily_limit === undefined ? null : Number(rule.daily_limit);
    if (dailyLimit !== null) {
      // 日边界必须在同一次调用里只取一次时钟：两个边界各自 `now()` 一次，读数若跨过午夜
      // 就会得到「昨天 00:00 → 后天 00:00」的 48 小时窗口，把两天的发分都算进今天，
      // 学生在一日两轮的第二轮会被误判到上限。这里取一次 now 同时喂给两个边界。
      const now = this.now();
      const todayCount = await this.ledgerRepo.countTodayEarned(
        studentId,
        taskCode,
        this.startOfToday(now),
        this.startOfTomorrow(now),
      );
      if (todayCount >= dailyLimit) return this.skipped(studentId, 'daily_limit');
    }

    // 5. 发分前累计——事务之前读，跨档判定要拿它当旧值
    const before = await this.pointsRepo.find(studentId);

    // 6. 事务：写流水 + 同步快照
    const duplicate = await this.writeAward(input, rule, tierKey, points);

    // 幂等命中：返回**首次**的分数与当前余额，**不能**再加一次快照
    if (duplicate) {
      const first = await this.ledgerRepo.findByDedupeKey(input.dedupeKey);
      const snap = await this.pointsRepo.find(studentId);
      return {
        pointsAwarded: Number(first?.points ?? 0),
        balance: snap.balance,
        totalEarned: snap.totalEarned,
        levelUp: null,
        reason: 'duplicate',
      };
    }

    // 7. 提交后读新累计，用现成的 detectLevelUp 判跨档（不在这里重写阈值比较）
    const after = await this.pointsRepo.find(studentId);
    return {
      pointsAwarded: points,
      balance: after.balance,
      totalEarned: after.totalEarned,
      levelUp: detectLevelUp(before.totalEarned, after.totalEarned),
    };
  }

  /** 服务器本地时区的当日 00:00。刻意不用 SQL 的 CURDATE()（DB 会话时区可能与应用不一致）。
   *  **公开**——`PointRulesService` 的每日计数复用这两个边界，不要在别处重写一份日期格式化。 */
  startOfToday(now = this.now()): Date {
    return new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 0, 0, 0);
  }

  /** 服务器本地时区的次日 00:00（与 `startOfToday` 配对成半开区间 `>= start && < end`）。
   *  复用调用方传入的 `now`，**不在这里再读一次时钟**——调用方必须把同一个 `now` 同时喂给两个
   *  边界，否则两次读数跨午夜会撑出 48 小时窗口（见 `award` 每日上限分支）。 */
  startOfTomorrow(now = this.now()): Date {
    const d = this.startOfToday(now);
    d.setDate(d.getDate() + 1);
    return d;
  }

  /** dedupe_key 里的 YYYY-MM-DD，同样用本地时区。**公开**——所有埋点靠它拼 key，
   *  不要在各模块重写一份日期格式化（Task 10/11 会调它）。 */
  todayKey(now = this.now()): string {
    const d = this.startOfToday(now);
    const mm = String(d.getMonth() + 1).padStart(2, '0');
    const dd = String(d.getDate()).padStart(2, '0');
    return `${d.getFullYear()}-${mm}-${dd}`;
  }

  /**
   * 一个事务里「写流水 + 更新快照」；返回是否命中幂等。
   *
   * `INSERT IGNORE` 撞 `uniq_point_ledger_dedupe` 时 `duplicate === true`：
   * 该次什么都没写，显式回滚（不提交任何快照更新）——**绝不能**在重复路径上调 `upsertDelta`，
   * 否则前端每次重试都会白加一次分。
   *
   * `title` 是**快照**：家长之后改分值或档位名，历史流水不变。
   */
  private async writeAward(
    input: AwardInput,
    rule: PointRuleRow,
    tierKey: string,
    points: number,
  ): Promise<boolean> {
    const conn = await this.pool.getConnection();
    let duplicate = false;
    try {
      await conn.beginTransaction();
      const inserted = await this.ledgerRepo.insert(
        {
          student_id: input.studentId,
          kind: 'earn',
          task_code: input.taskCode,
          tier_key: tierKey,
          points,
          dedupe_key: input.dedupeKey,
          title: `${TASK_NAMES[input.taskCode] ?? input.taskCode} · ${rule.tier_label}`,
          ref_type: input.refType ?? null,
          ref_id: input.refId ?? null,
        },
        conn,
      );
      duplicate = inserted.duplicate;
      if (duplicate) {
        await conn.rollback();
      } else {
        await this.pointsRepo.upsertDelta(input.studentId, points, points, conn);
        await conn.commit();
      }
    } catch (err) {
      // rollback 失败（连接已断）不能顶掉真正的失败原因；吞掉回滚错误，向上抛原始 err
      try { await conn.rollback(); } catch { /* 保留原始错误 */ }
      throw err;
    } finally {
      conn.release();
    }
    return duplicate;
  }

  /** 不发分的统一返回（no_rule / tier_inactive / daily_limit）：读当前快照只为把余额带给前端。 */
  private async skipped(studentId: number, reason: AwardReason): Promise<AwardResult> {
    const snap = await this.pointsRepo.find(studentId);
    return {
      pointsAwarded: 0,
      balance: snap.balance,
      totalEarned: snap.totalEarned,
      levelUp: null,
      reason,
    };
  }
}
