import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { PointsService } from './points.service.js';
import { PointRulesService } from './point-rules.service.js';
import type { GroupedPointRules } from './point-rules.service.js';
import { RedemptionService } from './redemption.service.js';
import type { StudentRewards } from './redemption.service.js';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard.js';
import type { JwtUser } from '../../common/guards/jwt-auth.guard.js';
import { RolesGuard } from '../../common/guards/roles.guard.js';
import { Roles } from '../../common/decorators/roles.js';
import { CurrentUser } from '../../common/decorators/current-user.js';
import type { PointLedgerPage, PointsOverview } from './dto/points.dto.js';
// 分页默认值 / 上界 / 解析函数与家长端 Task 8 共用一份（`pagination.util.ts`），避免两套口径漂移
import { DEFAULT_PAGE, DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE, parsePositiveInt } from './pagination.util.js';

/**
 * 学生端积分查询（`/api/points`）。
 *
 * 四个端点全部**只读**：学生不能给自己发分，也不能兑换（兑换是家长端操作，见 spec §3 定案 #5）。
 * `studentId` 一律取自 JWT（`@CurrentUser()`），端点不接受任何「查哪个学生」的入参——防 IDOR。
 *
 * 手工校验 query：`page` / `pageSize` 是字符串，越界必须 400 而不是回落到默认值
 * （spec §7.1 明确要求；`RedemptionService.listRedemptions` 那种「查询类宽容回落」的
 * 口径**不适用**于这里的流水分页）。
 */
@Controller('api/points')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles('student')
export class PointsController {
  constructor(
    private readonly pointsService: PointsService,
    private readonly pointRulesService: PointRulesService,
    private readonly redemptionService: RedemptionService,
  ) {}

  /** 积分概览。新学生无 `student_points` 行 → 全 0 + 劈柴（不是 404）。 */
  @Get('me')
  async getMe(@CurrentUser() user: JwtUser): Promise<PointsOverview> {
    return this.pointsService.getOverview(user.sub);
  }

  /** 流水分页，最新在前。`page` 默认 1、`pageSize` 默认 20 且上限 100。 */
  @Get('me/ledger')
  async getMyLedger(
    @CurrentUser() user: JwtUser,
    @Query('page') page?: string,
    @Query('pageSize') pageSize?: string,
  ): Promise<PointLedgerPage> {
    return this.pointsService.getLedger(
      user.sub,
      parsePositiveInt(page, 'page', DEFAULT_PAGE),
      parsePositiveInt(pageSize, 'pageSize', DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE),
    );
  }

  /**
   * 各任务的档位与分值——学生端训练配置页的**「档位即可选项」数据源**
   * （前端因此不再硬编码 `COUNT_OPTIONS`）。
   *
   * ⚠️ **只回已启用档位**：`listGrouped` 有意返回全部档位，那是给家长页看的
   * （家长要能看到并重新启用下架档）；学生开练时的那份下拉不能出现下架档——
   * 它们恰好也是 `listTierKeys` 不认的值，选了会被 start 端点 400。
   * `isActive` 字段仍回传（恒为 true），便于与家长端响应对照调试。
   */
  @Get('me/rules')
  async getMyRules(@CurrentUser() user: JwtUser): Promise<GroupedPointRules> {
    const grouped = await this.pointRulesService.listGrouped(user.sub, { withDailyCounts: true });
    return {
      tasks: grouped.tasks.map((task) => ({
        ...task,
        tiers: task.tiers.filter((tier) => tier.isActive),
      })),
    };
  }

  /** 奖励清单（只含已上架），逐项带 `affordable` / `levelOk` / `gap`；学生只能看，兑换在家长端。 */
  @Get('me/rewards')
  async getMyRewards(@CurrentUser() user: JwtUser): Promise<StudentRewards> {
    return this.redemptionService.listForStudent(user.sub);
  }
}
