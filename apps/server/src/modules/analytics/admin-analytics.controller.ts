import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard.js';
import { RolesGuard } from '../../common/guards/roles.guard.js';
import { Roles } from '../../common/decorators/roles.js';
import { OpsAnalyticsService } from './ops-analytics.service.js';

/**
 * 运营分析聚合（admin，母 spec §7 端点 1-2）。
 *
 * 不手工包 `{code, message, data}`——全局 `ResponseInterceptor` 统一包。
 * 窗口参数 `from,to`（YYYY-MM-DD）的校验在 service 的 parseWindow（非法 → 400/1001）。
 * Task 9-11 在此追加其余 9 个端点。
 */
@Controller('api/admin/analytics')
@UseGuards(JwtAuthGuard, RolesGuard)
export class AdminAnalyticsController {
  constructor(private readonly ops: OpsAnalyticsService) {}

  /** 总览：DAU/WAU、总时长、总答题、正确率、模块 Top5。 */
  @Get('overview')
  @Roles('admin')
  overview(@Query() q: { from?: string; to?: string }) {
    return this.ops.overview(q);
  }

  /** 模块横向对比：人数/时长/答题/正确率。 */
  @Get('modules')
  @Roles('admin')
  modules(@Query() q: { from?: string; to?: string }) {
    return this.ops.modules(q);
  }

  /** 漏斗：8 模块分步去重人数 + 相对上步转化；module 白名单越界 → 400/1001。 */
  @Get('funnel')
  @Roles('admin')
  funnel(@Query() q: { module: string; from?: string; to?: string }) {
    return this.ops.funnel(q);
  }

  /** 事件流：全部 tier（裁决 3），过滤 event/module/from/to，分页 20。 */
  @Get('events')
  @Roles('admin')
  events(@Query() q: { event?: string; module?: string; from?: string; to?: string; page?: string }) {
    return this.ops.events(q);
  }

  /** 留存：cohort = 首活跃日 = cohortStart 的学生，D{n} = 当日有会话人头占比；days 越界 400/1001。 */
  @Get('retention')
  @Roles('admin')
  retention(@Query() q: { cohortStart?: string; days?: string }) {
    return this.ops.retention(q);
  }

  /** 设备分布：五维 students/seconds/sessions（仅 platformClass 另有 accuracy）+ 多设备分档与切换。 */
  @Get('devices')
  @Roles('admin')
  devices(@Query() q: { from?: string; to?: string }) {
    return this.ops.devices(q);
  }

  /** 分组对比：metric/outcome 白名单越界 400/1001；响应必带 correlation-not-causation 免责声明。 */
  @Get('cohort-compare')
  @Roles('admin')
  cohortCompare(@Query() q: { metric?: string; outcome?: string; from?: string; to?: string }) {
    return this.ops.cohortCompare(q);
  }

  /** 质量看板：API 失败率/错误码分布 + LLM 超时/fallback/归因 + 内容四指标（passageSkipRate 恒 null）。 */
  @Get('quality')
  @Roles('admin')
  quality(@Query() q: { from?: string; to?: string }) {
    return this.ops.quality(q);
  }

  /** LLM 用量分组：groupBy 白名单 scene|model|day|student 越界 400/1001；unavailable 单列不当 0 求和。 */
  @Get('llm-tokens')
  @Roles('admin')
  llmTokens(@Query() q: { groupBy?: string; from?: string; to?: string }) {
    return this.ops.llmTokens(q);
  }

  /** LLM 调用流水：scene/model/success 过滤，分页 20（success 只认 true/false）。 */
  @Get('llm-calls')
  @Roles('admin')
  llmCalls(@Query() q: { scene?: string; model?: string; success?: string; page?: string }) {
    return this.ops.llmCalls(q);
  }

  /** 请求流水：route LIKE / status_code / minLatency 过滤，分页 20。 */
  @Get('requests')
  @Roles('admin')
  requests(@Query() q: { path?: string; status?: string; minLatency?: string; page?: string }) {
    return this.ops.requests(q);
  }
}
