import { BadRequestException, Body, Controller, Post, UseGuards } from '@nestjs/common';
import { z } from 'zod';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard.js';
import type { JwtUser } from '../../common/guards/jwt-auth.guard.js';
import { RolesGuard } from '../../common/guards/roles.guard.js';
import { Roles } from '../../common/decorators/roles.js';
import { CurrentUser } from '../../common/decorators/current-user.js';
import { EventsService } from './events.service.js';
import type { TrackEventInput } from './events.service.js';
import type { SubjectsRepository } from '../../database/repositories/subjects.repo.js';

/**
 * 采集端点 POST /api/track/events（母 spec §5.2 / delta spec §6）。
 *
 * - client 白名单拒伪**在 EventsService.recordMany 内部**（第二道锁）：controller 不做
 *   allowed 过滤，把全部条目原样透传，伪造条目计入 rejected 而不是 400。
 * - 不手工包 `{code, message, data}` —— 全局 ResponseInterceptor 统一包。
 * - 本端点已被 AnalyticsInterceptor 的 skip 名单覆盖（`/^\/api\/track(\/|$)/`，自指噪音）。
 */
const TrackEventDto = z.object({
  event: z.string().min(1),
  module: z.string().min(1).optional(),
  scene: z.string().min(1).optional(),
  subjectId: z.number().int().positive().optional(),
  refType: z.string().min(1).optional(),
  refId: z.number().int().optional(),
  sessionUid: z.string().uuid().optional(),
  props: z.record(z.unknown()).optional(),
  clientTsMs: z.number().int().optional(),
});
const TrackBatchDto = z.object({ events: z.array(TrackEventDto).min(1).max(50) });

// auth.controller.ts parseInput 同款模式：裸 ZodError 会被全局过滤器兜成 500，入参错误必须 400/1001
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

@Controller('api/track')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles('student')
export class TrackController {
  constructor(
    private readonly events: EventsService,
    private readonly subjectsRepo: SubjectsRepository,
  ) {}

  @Post('events')
  async submit(
    @CurrentUser() user: JwtUser,
    @Body() body: unknown,
  ): Promise<{ accepted: number; rejected: number }> {
    const dto = parseInput(TrackBatchDto, body);
    // subjectId 校验与 study-sessions.service.start 同口径：只校验「在售学科」，
    // 不校验「学生是否有权学该学科」（本期有意放宽）；只对带 subjectId 的条目做。
    const subjectIds = [
      ...new Set(dto.events.map((e) => e.subjectId).filter((v): v is number => v != null)),
    ];
    if (subjectIds.length > 0) {
      const subjects = await this.subjectsRepo.findAll();
      for (const subjectId of subjectIds) {
        if (!subjects.some((s) => s.id === subjectId)) {
          throw new BadRequestException({ code: 1001, message: `未知学科：${subjectId}` });
        }
      }
    }
    const inputs: TrackEventInput[] = dto.events.map((e) => ({
      ...e,
      subjectId: e.subjectId ?? null,
      actorRole: 'student',
      studentId: user.sub,
      source: 'client',
    }));
    return this.events.recordMany(inputs);
  }
}
