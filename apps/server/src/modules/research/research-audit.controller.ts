import { BadRequestException, Controller, Get, Query, UseGuards } from '@nestjs/common';
import { z } from 'zod';
import { ResearchAuditService } from './research-audit.service.js';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard.js';
import { RolesGuard } from '../../common/guards/roles.guard.js';
import { Roles } from '../../common/decorators/roles.js';

/** 空字符串 = 未填；与 papers 的 optionalInt 同语义。 */
function optionalInt(min: number, max?: number) {
  return z.preprocess(
    (v) => (v === '' || v === undefined ? undefined : v),
    z.coerce.number().int().min(min).max(max ?? Number.MAX_SAFE_INTEGER).optional(),
  );
}

/** ISO 时间：非法值 → 400/1001（不是让 Date.parse 出 Invalid Date 落到 DB）。 */
function optionalIso() {
  return z.preprocess(
    (v) => (v === '' || v === undefined ? undefined : v),
    z.string()
      .refine((s) => !Number.isNaN(Date.parse(s)), { message: '非法 ISO 时间' })
      .transform((s) => new Date(s))
      .optional(),
  );
}

const AuditQuerySchema = z.object({
  actorId: optionalInt(1),
  action: z.preprocess(
    (v) => (v === '' || v === undefined ? undefined : v),
    z.enum(['paper.delete', 'question.update', 'image.delete']).optional(),
  ),
  targetType: z.preprocess(
    (v) => (v === '' || v === undefined ? undefined : v),
    z.enum(['paper', 'question', 'image']).optional(),
  ),
  targetId: optionalInt(1),
  from: optionalIso(),
  to: optionalIso(),
  page: optionalInt(1).transform((v) => v ?? 1),
  pageSize: optionalInt(1, 100).transform((v) => v ?? 20),
});

/** 裸 ZodError 会被兜成 500/5000，客户端入参错误必须 400/1001。 */
function parseQuery<S extends z.ZodTypeAny>(schema: S, raw: unknown): z.output<S> {
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    const detail = parsed.error.issues
      .map((issue) => `${issue.path.join('.') || 'query'}: ${issue.message}`)
      .join('; ');
    throw new BadRequestException({ code: 1001, message: `入参校验失败：${detail}` });
  }
  return parsed.data;
}

@Controller('api/research/audit')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles('researcher')
export class ResearchAuditController {
  constructor(private readonly service: ResearchAuditService) {}

  @Get()
  list(@Query() query: unknown) {
    return this.service.list(parseQuery(AuditQuerySchema, query));
  }
}
