import { Controller, Post, Body, UseInterceptors, HttpCode, BadRequestException } from '@nestjs/common';
import { AuthService } from './auth.service.js';
import { ThrottleInterceptor } from '../../common/interceptors/throttle.interceptor.js';
import { z } from 'zod';

const LoginSchema = z.object({
  username: z.string().min(1).max(50),
  password: z.string().min(1).max(100),
});

const ParentRegisterSchema = z.object({
  phone: z.string().regex(/^1\d{10}$/, '手机号格式有误'),
  password: z.string().min(6).max(32),
  name: z.string().min(1).max(50).optional(),
});

const ResetRequestSchema = z.object({
  phone: z.string().regex(/^1\d{10}$/, '手机号格式有误'),
});

const ResetSchema = z.object({
  phone: z.string().regex(/^1\d{10}$/, '手机号格式有误'),
  code: z.string().regex(/^\d{6}$/, '验证码必须是 6 位数字'),
  newPassword: z.string().min(6).max(32),
});

/**
 * Zod 校验 + 把 `ZodError` 转成 400（code 1001）。
 * 裸 ZodError 不是 HttpException，会被全局 HttpExceptionFilter 兜成 500 ——
 * 客户端入参错误必须是 400（同 parent-points.controller.ts 的 parseInput 模式）。
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

@Controller('api/auth')
export class AuthController {
  constructor(private authService: AuthService) {}

  @Post('login')
  @UseInterceptors(ThrottleInterceptor)
  async login(@Body() body: unknown) {
    const { username, password } = LoginSchema.parse(body);
    return this.authService.login(username, password);
  }

  /** 家长注册（注册即登录）。学生自主注册已下线（PRD §7.8）。 */
  @Post('register')
  @UseInterceptors(ThrottleInterceptor)
  async register(@Body() body: unknown) {
    const dto = ParentRegisterSchema.parse(body);
    return this.authService.register(dto);
  }

  /** 忘记密码①：请求模拟验证码（验证码直接在响应体返回 + 服务端日志）。 */
  @Post('password/reset-request')
  @HttpCode(200)
  @UseInterceptors(ThrottleInterceptor)
  async requestPasswordReset(@Body() body: unknown) {
    const { phone } = parseInput(ResetRequestSchema, body);
    return this.authService.requestPasswordReset(phone);
  }

  /** 忘记密码②：验证码 + 新密码重置（成功后不失效旧 token）。 */
  @Post('password/reset')
  @HttpCode(200)
  @UseInterceptors(ThrottleInterceptor)
  async resetPassword(@Body() body: unknown) {
    const dto = parseInput(ResetSchema, body);
    return this.authService.resetPassword(dto);
  }
}
