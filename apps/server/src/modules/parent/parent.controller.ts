import { Body, Controller, Get, Param, ParseIntPipe, Patch, Post, UseGuards, Request } from '@nestjs/common';
import type { Request as ExpressRequest } from 'express';
import { z } from 'zod';
import { ParentService } from './parent.service.js';
import { JwtAuthGuard, type JwtUser } from '../../common/guards/jwt-auth.guard.js';
import { RolesGuard } from '../../common/guards/roles.guard.js';
import { Roles } from '../../common/decorators/roles.js';

const CreateStudentSchema = z.object({
  name: z.string().min(1).max(50),
  username: z.string().min(2).max(50).regex(/^[a-zA-Z0-9_]+$/, '用户名仅限字母/数字/下划线'),
  password: z.string().min(6).max(32),
  age: z.number().int().min(3).max(18),
  grade: z.string().min(1).max(20),
});

const ResetPasswordSchema = z.object({ newPassword: z.string().min(6).max(32) });
const StatusSchema = z.object({ isActive: z.boolean() });

@Controller('api/parent/students')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles('parent')
export class ParentController {
  constructor(private parentService: ParentService) {}

  @Post()
  async create(@Request() req: ExpressRequest, @Body() body: unknown) {
    const user = (req as ExpressRequest & { user?: JwtUser }).user!;
    const dto = CreateStudentSchema.parse(body);
    return this.parentService.createStudent(user.sub, dto);
  }

  @Get()
  async list(@Request() req: ExpressRequest) {
    const user = (req as ExpressRequest & { user?: JwtUser }).user!;
    return this.parentService.listStudents(user.sub);
  }

  @Patch(':id/reset-password')
  async resetPassword(
    @Request() req: ExpressRequest,
    @Param('id', ParseIntPipe) id: number,
    @Body() body: unknown,
  ) {
    const user = (req as ExpressRequest & { user?: JwtUser }).user!;
    const { newPassword } = ResetPasswordSchema.parse(body);
    return this.parentService.resetPassword(user.sub, id, newPassword);
  }

  @Patch(':id/status')
  async setStatus(
    @Request() req: ExpressRequest,
    @Param('id', ParseIntPipe) id: number,
    @Body() body: unknown,
  ) {
    const user = (req as ExpressRequest & { user?: JwtUser }).user!;
    const { isActive } = StatusSchema.parse(body);
    return this.parentService.setStatus(user.sub, id, isActive);
  }
}
