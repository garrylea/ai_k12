import { Body, ConflictException, Controller, Get, Param, ParseIntPipe, Patch, Post, Put, UseGuards, Request } from '@nestjs/common';
import type { Request as ExpressRequest } from 'express';
import { z } from 'zod';
import { ParentService } from './parent.service.js';
import { AdminMessagesService } from '../admin/admin-messages.service.js';
import { JwtAuthGuard, type JwtUser } from '../../common/guards/jwt-auth.guard.js';
import { RolesGuard } from '../../common/guards/roles.guard.js';
import { Roles } from '../../common/decorators/roles.js';

const CreateStudentSchema = z.object({
  name: z.string().min(1).max(50),
  // 排除 11 位纯数字（会与家长手机号在统一登录里歧义，auth.service 按 admins->parents->students 级联）
  username: z.string().min(2).max(50).regex(/^(?!\d{11}$)[a-zA-Z0-9_]+$/, '用户名仅限字母/数字/下划线，且不能是 11 位纯数字'),
  password: z.string().min(6).max(32),
  age: z.number().int().min(3).max(18),
  grade: z.string().min(1).max(20),
});

const ResetPasswordSchema = z.object({ newPassword: z.string().min(6).max(32) });
const StatusSchema = z.object({ isActive: z.boolean() });

/**
 * 家长改自己密码的 body（spec §4.6）。
 *
 * 越界走 `safeParse` 后抛 `409`/`1001`（spec 的校验链口径），**不是** Zod 默认的 400、
 * 更不是裸 `ZodError`（那会被全局过滤器兜成 500/5000）。服务层还有一道同样的长度校验
 * 作为最后防线（`ParentService.changePassword`，直连服务的调用方绕过 schema 也拦得住）。
 */
const ChangePasswordSchema = z.object({
  oldPassword: z.string().min(1).max(100),
  newPassword: z.string().min(6).max(32),
});

const SubjectConfigSchema = z.object({
  gradeCode: z.string().min(1).max(20),
  term: z.enum(['first', 'second']),
  textbookVersionId: z.number().int().positive().optional(),
});

@Controller('api/parent')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles('parent')
export class ParentController {
  constructor(
    private parentService: ParentService,
    private messagesService: AdminMessagesService,
  ) {}

  @Post('students')
  async create(@Request() req: ExpressRequest, @Body() body: unknown) {
    const user = (req as ExpressRequest & { user?: JwtUser }).user!;
    const dto = CreateStudentSchema.parse(body);
    return this.parentService.createStudent(user.sub, dto);
  }

  @Get('students')
  async list(@Request() req: ExpressRequest) {
    const user = (req as ExpressRequest & { user?: JwtUser }).user!;
    return this.parentService.listStudents(user.sub);
  }

  @Patch('students/:id/reset-password')
  async resetPassword(
    @Request() req: ExpressRequest,
    @Param('id', ParseIntPipe) id: number,
    @Body() body: unknown,
  ) {
    const user = (req as ExpressRequest & { user?: JwtUser }).user!;
    const { newPassword } = ResetPasswordSchema.parse(body);
    return this.parentService.resetPassword(user.sub, id, newPassword);
  }

  @Patch('students/:id/status')
  async setStatus(
    @Request() req: ExpressRequest,
    @Param('id', ParseIntPipe) id: number,
    @Body() body: unknown,
  ) {
    const user = (req as ExpressRequest & { user?: JwtUser }).user!;
    const { isActive } = StatusSchema.parse(body);
    return this.parentService.setStatus(user.sub, id, isActive);
  }

  @Get('students/:id/subject-configs')
  async getSubjectConfigs(@Request() req: ExpressRequest, @Param('id', ParseIntPipe) id: number) {
    const user = (req as ExpressRequest & { user?: JwtUser }).user!;
    return this.parentService.getSubjectConfigs(user.sub, id);
  }

  @Put('students/:id/subject-configs/:subjectId')
  async updateSubjectConfig(
    @Request() req: ExpressRequest,
    @Param('id', ParseIntPipe) id: number,
    @Param('subjectId', ParseIntPipe) subjectId: number,
    @Body() body: unknown,
  ) {
    const user = (req as ExpressRequest & { user?: JwtUser }).user!;
    const dto = SubjectConfigSchema.parse(body);
    return this.parentService.updateSubjectConfig(user.sub, id, subjectId, dto);
  }

  @Get('messages')
  async myMessages(@Request() req: ExpressRequest) {
    const user = (req as ExpressRequest & { user?: JwtUser }).user!;
    return this.messagesService.listForParent(user.sub);
  }

  @Get('messages/unread-count')
  async unread(@Request() req: ExpressRequest) {
    const user = (req as ExpressRequest & { user?: JwtUser }).user!;
    return this.messagesService.unreadCount(user.sub);
  }

  @Patch('messages/:id/read')
  async read(@Request() req: ExpressRequest, @Param('id', ParseIntPipe) id: number) {
    const user = (req as ExpressRequest & { user?: JwtUser }).user!;
    await this.messagesService.markRead(user.sub, id);
    return null;
  }

  /** 家长自己的账号信息（spec §4.5）——账号级、非按学生，故落在本 controller。 */
  @Get('account')
  async account(@Request() req: ExpressRequest) {
    const user = (req as ExpressRequest & { user?: JwtUser }).user!;
    return this.parentService.getAccount(user.sub);
  }

  /** 家长改自己的密码（spec §4.6）。改后**不失效旧 token**（本仓无 token 版本机制）。 */
  @Patch('password')
  async changePassword(@Request() req: ExpressRequest, @Body() body: unknown) {
    const user = (req as ExpressRequest & { user?: JwtUser }).user!;
    const parsed = ChangePasswordSchema.safeParse(body);
    if (!parsed.success) {
      const detail = parsed.error.issues
        .map((issue) => `${issue.path.join('.') || 'body'}: ${issue.message}`).join('; ');
      throw new ConflictException({ code: 1001, message: `入参校验失败：${detail}` });
    }
    await this.parentService.changePassword(user.sub, parsed.data.oldPassword, parsed.data.newPassword);
    return null;
  }
}
