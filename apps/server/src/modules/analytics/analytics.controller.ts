import { BadRequestException, Body, Controller, Param, Patch, Post, Req, UseGuards } from '@nestjs/common';
import type { Request } from 'express';
import { z } from 'zod';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard.js';
import type { JwtUser } from '../../common/guards/jwt-auth.guard.js';
import { RolesGuard } from '../../common/guards/roles.guard.js';
import { Roles } from '../../common/decorators/roles.js';
import { CurrentUser } from '../../common/decorators/current-user.js';
import { StudySessionsService, END_REASONS } from './study-sessions.service.js';

/**
 * 采集端（student 角色，spec §8.1）。
 *
 * `/api/track/events` **不在本批**：`behavior_events` 表属 Phase 2（见计划头部「范围裁剪」）。
 * 在表不存在的情况下提前开端点只会得到一个 500。
 *
 * 不手工包 `{code, message, data}`——全局 `ResponseInterceptor` 统一包。
 */
const StartSchema = z.object({
  sessionUid: z.string().uuid(),
  module: z.string().min(1).max(32),
  scene: z.string().min(1).max(40),
  subjectId: z.number().int().positive().optional(),
  refType: z.string().max(24).optional(),
  refId: z.number().int().positive().optional(),
  // 设备三项**不做枚举校验**：非法值在 service 里落 NULL，不报错（设备信息是尽力而为）。
  screenClass: z.string().max(20).optional(),
  inputType: z.string().max(10).optional(),
  appShell: z.string().max(10).optional(),
});

// subjectId 可选：前端在「星图加载完、拿到学科」后随心跳补写（P6.5）。
// 允许缺失；给了但非法（0/负数/非整数）时 **宽容回落为「没带」**，不 400（心跳尽力而为）。
const HeartbeatSchema = z.object({
  state: z.enum(['visible', 'hidden']),
  subjectId: z.number().int().positive().optional(),
});
const EndSchema = z.object({ reason: z.enum(END_REASONS) });

function parseOrThrow<T>(schema: z.ZodType<T>, body: unknown): T {
  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    throw new BadRequestException({ code: 1001, message: '请求参数不合法' });
  }
  return parsed.data;
}

@Controller('api/study-sessions')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles('student')
export class AnalyticsController {
  constructor(private readonly studySessions: StudySessionsService) {}

  /** 开始一段学习会话（幂等，`@Post` 默认 201）。 */
  @Post()
  async start(@CurrentUser() user: JwtUser, @Body() body: unknown, @Req() req: Request) {
    const dto = parseOrThrow(StartSchema, body);
    return this.studySessions.start({
      ...dto,
      studentId: user.sub,
      userAgent: req.headers['user-agent'] ?? null,
    });
  }

  /** 心跳（PATCH 默认 200）。未命中 → `{activeSeconds: null}`，不报错。 */
  @Patch(':uid/heartbeat')
  async heartbeat(
    @CurrentUser() user: JwtUser,
    @Param('uid') uid: string,
    @Body() body: unknown,
  ) {
    const dto = parseOrThrow(HeartbeatSchema, body);
    return this.studySessions.heartbeat({
      studentId: user.sub,
      sessionUid: uid,
      state: dto.state,
      subjectId: dto.subjectId,
    });
  }

  /** 结束会话（幂等）。 */
  @Patch(':uid/end')
  async end(@CurrentUser() user: JwtUser, @Param('uid') uid: string, @Body() body: unknown) {
    const dto = parseOrThrow(EndSchema, body);
    return this.studySessions.end({ studentId: user.sub, sessionUid: uid, reason: dto.reason });
  }
}
