import { BadRequestException, Controller, Delete, Get, Param, ParseIntPipe, Query, UseGuards } from '@nestjs/common';
import { z } from 'zod';
import { AdminPapersService } from './admin-papers.service.js';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard.js';
import { RolesGuard } from '../../common/guards/roles.guard.js';
import { Roles } from '../../common/decorators/roles.js';

/** 空字符串 = 未填（前端清空筛选后会带 `x=`），不能让它被 coerce 成 0 后报错。 */
function optionalInt(min: number, max?: number) {
  return z.preprocess(
    (v) => (v === '' || v === undefined ? undefined : v),
    z.coerce.number().int().min(min).max(max ?? Number.MAX_SAFE_INTEGER).optional(),
  );
}

const PaperListQuerySchema = z.object({
  subjectId: optionalInt(1),
  year: optionalInt(2000, 2100),
  gradeBand: z.preprocess(
    (v) => (v === '' || v === undefined ? undefined : v),
    z.enum(['primary', 'junior', 'senior']).optional(),
  ),
  keyword: z.preprocess(
    (v) => (v === '' || v === undefined ? undefined : v),
    z.string().trim().max(50).optional(),
  ),
  page: optionalInt(1).transform((v) => v ?? 1),
  pageSize: optionalInt(1, 100).transform((v) => v ?? 20),
});

/**
 * 裸 ZodError 不是 HttpException，会被全局过滤器兜成 500/5000
 * （`http-exception.filter.ts:20-27`）—— 客户端入参错误必须 400/1001。
 * 同款：`auth.controller.ts` 的 parseInput。
 *
 * 泛型取 schema 本身（`z.output<S>`）而非 `parseInput<T>(z.ZodType<T>)`：后者的 T
 * 会从 zod 的 input 位置推断，而 preprocess 的 input 是 unknown，输出类型会整体退化成 unknown。
 */
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

@Controller('api/admin/papers')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles('admin')
export class AdminPapersController {
  constructor(private readonly service: AdminPapersService) {}

  /** 试卷列表：全学科分页，keyword 匹配标题。 */
  @Get()
  list(@Query() query: unknown) {
    return this.service.list(parseQuery(PaperListQuerySchema, query));
  }

  /** 删除前影响面预览（只读，不加锁）。 */
  @Get(':id/delete-preview')
  preview(@Param('id', ParseIntPipe) id: number) {
    return this.service.preview(id);
  }

  /** 删除套卷：独占题 + 考试会话 + 逐题作答，单事务。 */
  @Delete(':id')
  remove(@Param('id', ParseIntPipe) id: number) {
    return this.service.remove(id);
  }
}
