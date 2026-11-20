import { BadRequestException, Body, Controller, Get, Param, ParseIntPipe, Patch, Post, Query, UseGuards } from '@nestjs/common';
import { z } from 'zod';
import { AdminStaffService } from './admin-staff.service.js';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard.js';
import { RolesGuard } from '../../common/guards/roles.guard.js';
import { Roles } from '../../common/decorators/roles.js';

const USERNAME_RE = /^[a-zA-Z0-9_]{3,50}$/;

/**
 * `.strict()`：body 带任何未声明字段（尤其 `role`）都算入参错误 → 400/1001，
 * 从入口就堵死「创建 admin」的尝试；服务端也不接受 role 参数。
 * 裸 ZodError 会被全局过滤器兜成 500，故统一走 parseBody 转 400/1001。
 */
const CreateSchema = z.object({
  username: z.string().regex(USERNAME_RE, '用户名只能包含字母、数字、下划线，3-50 位'),
  name: z.string().max(50).optional(),
  password: z.string().min(6).max(72),
}).strict();

const StatusSchema = z.object({ isActive: z.boolean() }).strict();

const PasswordSchema = z.object({ password: z.string().min(6).max(72) }).strict();

function parseBody<S extends z.ZodTypeAny>(schema: S, raw: unknown): z.output<S> {
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    const detail = parsed.error.issues
      .map((issue) => `${issue.path.join('.') || 'body'}: ${issue.message}`)
      .join('; ');
    throw new BadRequestException({ code: 1001, message: `入参校验失败：${detail}` });
  }
  return parsed.data;
}

@Controller('api/admin/staff')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles('admin')
export class AdminStaffController {
  constructor(private readonly service: AdminStaffService) {}

  @Get()
  list(@Query('search') search?: string) {
    return this.service.list((search ?? '').trim().slice(0, 50));
  }

  @Post()
  async create(@Body() body: unknown) {
    return this.service.create(parseBody(CreateSchema, body));
  }

  @Patch(':id/status')
  async setStatus(@Param('id', ParseIntPipe) id: number, @Body() body: unknown) {
    const { isActive } = parseBody(StatusSchema, body);
    await this.service.setStatus(id, isActive);
    return null;
  }

  @Patch(':id/password')
  async resetPassword(@Param('id', ParseIntPipe) id: number, @Body() body: unknown) {
    const { password } = parseBody(PasswordSchema, body);
    await this.service.resetPassword(id, password);
    return null;
  }
}
