import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Param,
  ParseIntPipe,
  Patch,
  Post,
  Put,
  Query,
  UseGuards,
} from '@nestjs/common';
import { z } from 'zod';
import { ParentService } from '../parent/parent.service.js';
import { PointsService } from './points.service.js';
import { PointRulesService } from './point-rules.service.js';
import type { GroupedPointRules } from './point-rules.service.js';
import { RedemptionService } from './redemption.service.js';
import type { RedemptionList, RedeemResult, RewardCatalogView } from './redemption.service.js';
import { ControlsRepository } from '../../database/repositories/controls.repo.js';
import type { ControlsSnapshot } from '../../database/repositories/controls.repo.js';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard.js';
import type { JwtUser } from '../../common/guards/jwt-auth.guard.js';
import { RolesGuard } from '../../common/guards/roles.guard.js';
import { Roles } from '../../common/decorators/roles.js';
import { CurrentUser } from '../../common/decorators/current-user.js';
import { DEFAULT_PAGE, DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE, parsePositiveInt } from './pagination.util.js';
import type { PointLedgerPage, PointsOverview } from './dto/points.dto.js';

/**
 * 家长端分值与兑换端点（spec §7.3）。
 *
 * 与 `ParentController` **同前缀** `api/parent`（Nest 允许同前缀多 controller），
 * `@Roles('parent')`。所有 `studentId` 都来自路径，**每个 handler 第一件事**是
 * `ParentService.requireOwnedStudent(parentId, studentId)` —— 归属校验是唯一防线，
 * 不做「先查数据再判归属」（那样会泄漏「这个 id 存在」）。
 *
 * 本 controller 只做「校验 + 转发」：分值与兑换的业务规则全在学生端同款的三个 service 里
 * （`PointsService` / `PointRulesService` / `RedemptionService`），**不在这里重算段位、余额、
 * 汇率**，也不自己写一套档位合法性判断。
 */

/** 批量保存分值规则的一条。三个可改字段**全必填**：`updateBatch` 拒绝空 patch，
 *  Zod 层就要求给定，别让「一个字段都没填」的请求走到 service 才报 3005。 */
const RuleItemSchema = z.object({
  taskCode: z.string().min(1).max(40),
  tierKey: z.string().min(1).max(20),
  // 与 `PointRulesService` 同口径：0-9999；负数会写负流水破坏「段位只升不降」
  points: z.number().int().min(0).max(9999),
  // 「不限」只能用 null 表达；0 会让 `award()` 的上限判断恒真、该档位永久不发分
  dailyLimit: z.number().int().min(1).max(99).nullable(),
  isActive: z.boolean(),
});

const SaveRulesSchema = z.object({ rules: z.array(RuleItemSchema).min(1) });

/**
 * 奖励清单一条。**`isActive` 必填**（不是 optional）：`RedemptionService.normalizeCatalogItem`
 * 对它缺省为 true，若 Zod 放行缺省，家长前端只是提交一份「没带这个字段」的清单就会把已下架的
 * 奖励**静默重新上架**。`listCatalog` 有意回传软删行就是为了让前端原样带回 `isActive`。
 */
const CatalogItemSchema = z.object({
  id: z.number().int().positive().optional(),
  name: z.string().min(1).max(100),
  description: z.string().max(300).nullable(),
  pointsCost: z.number().int().min(1).max(999_999),
  minLevelCode: z.string().max(20).nullable(),
  isActive: z.boolean(),
  sortOrder: z.number().int().min(0).max(9999),
});

// 空数组是合法语义（= 整表清空 / 全部软删），故不加 .min(1)
const SaveCatalogSchema = z.object({ items: z.array(CatalogItemSchema) });

/** 兑换：换钱（积分由家长输入，金额由服务端按汇率推导）或换指定奖励。 */
const RedeemSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('cash'), points: z.number().int().min(1) }),
  z.object({ type: z.literal('reward'), catalogId: z.number().int().positive() }),
]);

const RedemptionStatusSchema = z.object({ status: z.enum(['pending', 'fulfilled']) });

/**
 * 兑换设置（`pointsPerYuan` / `rewardRedemptionEnabled`）。
 *
 * 与 rules 批量保存**刻意分开**：汇率和分值是两个关注点，混在一个 payload 里以后加设置项时
 * 容易打架（spec §7.3 的设计决定）。两个字段都可选，但**至少要给一个**——空 patch 是
 * 「什么都没改」的假成功，这里直接 400（`refine`）。
 */
const SettingsSchema = z
  .object({
    pointsPerYuan: z.number().int().min(1).max(9999).optional(),
    rewardRedemptionEnabled: z.boolean().optional(),
  })
  .refine((v) => v.pointsPerYuan !== undefined || v.rewardRedemptionEnabled !== undefined, {
    message: '至少需要 pointsPerYuan / rewardRedemptionEnabled 之一',
  });

/**
 * Zod 校验 + 把 `ZodError` 转成 400。
 *
 * 直接用 `Schema.parse()` 抛出的 `ZodError` 不是 `HttpException`，会被全局
 * `HttpExceptionFilter` 的 `@Catch()` 当未知错误映射成 **500**（code 5000）——
 * 客户端入参错误必须是 400 `1001`（本仓约定：「Zod 用于输入，坏输入用 BadRequestException」）。
 */
function parseInput<T>(schema: z.ZodType<T>, body: unknown): T {
  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    const detail = parsed.error.issues
      .map((issue) => `${issue.path.join('.') || 'body'}: ${issue.message}`)
      .join('; ');
    throw new BadRequestException({ code: 1001, message: `入参校验失败：${detail}` });
  }
  return parsed.data;
}

@Controller('api/parent')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles('parent')
export class ParentPointsController {
  constructor(
    private readonly parentService: ParentService,
    private readonly pointsService: PointsService,
    private readonly pointRulesService: PointRulesService,
    private readonly redemptionService: RedemptionService,
    private readonly controlsRepo: ControlsRepository,
  ) {}

  /** 概览：复用学生端同一份 `getOverview`（段位/进度的单一真源在 `levels.ts`，不在这里重算）。 */
  @Get('students/:id/points')
  async getPoints(
    @CurrentUser() user: JwtUser,
    @Param('id', ParseIntPipe) id: number,
  ): Promise<PointsOverview> {
    await this.parentService.requireOwnedStudent(user.sub, id);
    return this.pointsService.getOverview(id);
  }

  /** 按任务分组的**全部**规则（含下架档位——家长要能看到并重新启用）。 */
  @Get('students/:id/points/rules')
  async getRules(
    @CurrentUser() user: JwtUser,
    @Param('id', ParseIntPipe) id: number,
  ): Promise<GroupedPointRules> {
    await this.parentService.requireOwnedStudent(user.sub, id);
    return this.pointRulesService.listGrouped(id, { withDailyCounts: true });
  }

  /** 批量保存规则：一个事务，要么全成要么全不成（原子性在 `updateBatch` 里，不在 controller）。 */
  @Put('students/:id/points/rules')
  async saveRules(
    @CurrentUser() user: JwtUser,
    @Param('id', ParseIntPipe) id: number,
    @Body() body: unknown,
  ): Promise<null> {
    await this.parentService.requireOwnedStudent(user.sub, id);
    const { rules } = parseInput(SaveRulesSchema, body);
    await this.pointRulesService.updateBatch(id, rules);
    return null;
  }

  /** 流水分页（与学生端同口径：page 默认 1、pageSize 默认 20 且上限 100，越界 400）。 */
  @Get('students/:id/points/ledger')
  async getLedger(
    @CurrentUser() user: JwtUser,
    @Param('id', ParseIntPipe) id: number,
    @Query('page') page?: string,
    @Query('pageSize') pageSize?: string,
  ): Promise<PointLedgerPage> {
    await this.parentService.requireOwnedStudent(user.sub, id);
    return this.pointsService.getLedger(
      id,
      parsePositiveInt(page, 'page', DEFAULT_PAGE),
      parsePositiveInt(pageSize, 'pageSize', DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE),
    );
  }

  /** 奖励清单：**含已下架行**（家长要能重新上架，前端整表 PUT 时原样带回 `isActive`）。 */
  @Get('students/:id/reward-catalog')
  async getCatalog(
    @CurrentUser() user: JwtUser,
    @Param('id', ParseIntPipe) id: number,
  ): Promise<RewardCatalogView[]> {
    await this.parentService.requireOwnedStudent(user.sub, id);
    return this.redemptionService.listCatalog(id);
  }

  /** 批量保存奖励清单：无 `id` 新增、有 `id` 整行覆盖、消失的 `id` 软删；返回保存后的完整清单。 */
  @Put('students/:id/reward-catalog')
  async saveCatalog(
    @CurrentUser() user: JwtUser,
    @Param('id', ParseIntPipe) id: number,
    @Body() body: unknown,
  ): Promise<RewardCatalogView[]> {
    await this.parentService.requireOwnedStudent(user.sub, id);
    const { items } = parseInput(SaveCatalogSchema, body);
    return this.redemptionService.saveCatalog(id, items);
  }

  /** 兑换（Nest `@Post` 默认 201）。余额/段位/开关/下架等业务拒绝由 service 抛 3001-3004。 */
  @Post('students/:id/points/redeem')
  async redeem(
    @CurrentUser() user: JwtUser,
    @Param('id', ParseIntPipe) id: number,
    @Body() body: unknown,
  ): Promise<RedeemResult> {
    await this.parentService.requireOwnedStudent(user.sub, id);
    const dto = parseInput(RedeemSchema, body);
    return this.redemptionService.redeem(id, dto);
  }

  /** 兑换记录分页（spec §7.3 只有 `?page`；pageSize 由 service 取默认 20）。 */
  @Get('students/:id/redemptions')
  async getRedemptions(
    @CurrentUser() user: JwtUser,
    @Param('id', ParseIntPipe) id: number,
    @Query('page') page?: string,
  ): Promise<RedemptionList> {
    await this.parentService.requireOwnedStudent(user.sub, id);
    return this.redemptionService.listRedemptions(id, parsePositiveInt(page, 'page', DEFAULT_PAGE));
  }

  /**
   * 只改兑换单状态（pending ⇄ fulfilled），**不动积分**。
   *
   * 这条路径**没有 studentId**：先按 id 反查兑换单拿 `student_id`（不存在 → 404 1002），
   * 再跑 `requireOwnedStudent`。反查走 `RedemptionService`，controller 不碰仓储。
   */
  @Patch('redemptions/:id')
  async patchRedemption(
    @CurrentUser() user: JwtUser,
    @Param('id', ParseIntPipe) id: number,
    @Body() body: unknown,
  ): Promise<null> {
    const studentId = await this.redemptionService.findStudentIdByRedemptionId(id);
    await this.parentService.requireOwnedStudent(user.sub, studentId);
    const { status } = parseInput(RedemptionStatusSchema, body);
    await this.redemptionService.setRedemptionStatus(studentId, id, status);
    return null;
  }

  /** 兑换设置：读 `controls`（缺行先 `ensure` 补默认行，与兑换端点的懒初始化同口径）。 */
  @Get('students/:id/points/settings')
  async getSettings(
    @CurrentUser() user: JwtUser,
    @Param('id', ParseIntPipe) id: number,
  ): Promise<ControlsSnapshot> {
    await this.parentService.requireOwnedStudent(user.sub, id);
    await this.controlsRepo.ensure(id);
    return this.controlsRepo.findByStudent(id);
  }

  /** 兑换设置：部分更新，至少给一个字段（空 patch 是假成功，Zod 层 400）。返回更新后的全量。 */
  @Put('students/:id/points/settings')
  async saveSettings(
    @CurrentUser() user: JwtUser,
    @Param('id', ParseIntPipe) id: number,
    @Body() body: unknown,
  ): Promise<ControlsSnapshot> {
    await this.parentService.requireOwnedStudent(user.sub, id);
    const patch = parseInput(SettingsSchema, body);
    await this.controlsRepo.ensure(id);
    await this.controlsRepo.update(id, patch);
    return this.controlsRepo.findByStudent(id);
  }
}
