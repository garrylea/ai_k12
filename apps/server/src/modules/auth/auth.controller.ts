import { Controller, Post, Body } from '@nestjs/common';
import { AuthService } from './auth.service.js';
import { z } from 'zod';

const LoginSchema = z.object({
  username: z.string().min(1),
  password: z.string().min(1),
});

const RegisterSchema = z.object({
  username: z.string().min(1).max(50),
  password: z.string().min(1).max(100),
  name: z.string().min(1).max(50),
  grade: z.string().optional(),
});

@Controller('api/auth')
export class AuthController {
  constructor(private authService: AuthService) {}

  @Post('login')
  async login(@Body() body: unknown) {
    const { username, password } = LoginSchema.parse(body);
    return this.authService.login(username, password);
  }

  @Post('register')
  async register(@Body() body: unknown) {
    const dto = RegisterSchema.parse(body);
    return this.authService.register(dto);
  }
}
