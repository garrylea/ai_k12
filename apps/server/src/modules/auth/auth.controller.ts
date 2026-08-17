import { Controller, Post, Body, UseInterceptors } from '@nestjs/common';
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
}
