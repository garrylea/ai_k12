import { Injectable, NestMiddleware, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import type { Request, Response, NextFunction } from 'express';
import type { JwtUser } from '../guards/jwt-auth.guard.js';
import { BanRegistry } from '../guards/ban-registry.js';
import { SessionRegistry } from '../guards/session-registry.js';

/**
 * Parses the `Authorization: Bearer <jwt>` header and, when the token is valid,
 * attaches the decoded payload to `request.user`. Invalid/missing tokens are a
 * no-op here — access control is delegated to JwtAuthGuard on the routes that
 * require authentication, so public routes (login, subjects) stay open.
 */
@Injectable()
export class AuthMiddleware implements NestMiddleware {
  constructor(
    private jwtService: JwtService,
    private banRegistry: BanRegistry,
    private sessionRegistry: SessionRegistry,
  ) {}

  use(req: Request, _res: Response, next: NextFunction): void {
    const header = req.headers['authorization'];
    if (header && header.startsWith('Bearer ')) {
      const token = header.slice('Bearer '.length).trim();
      try {
        const payload = this.jwtService.verify<JwtUser>(token);
        // 进程内封禁即时生效：管理员封禁后旧 token 立即 401（DB is_active 只拦登录，拦不住已签发 token）
        if (payload.role === 'parent' && this.banRegistry.isBanned('parent', payload.sub)) {
          throw new UnauthorizedException({ code: 1003, message: '账号已停用' });
        }
        if (payload.role === 'student' && this.banRegistry.isBanned('student', payload.sub)) {
          throw new UnauthorizedException({ code: 1003, message: '账号已停用' });
        }
        // 单点登录互踢（2026-10-10）：token 携带的 seq 与注册表当前 seq 失配 = 已在别处重新
        // 登录。旧格式 token（无 seq）一律失配 → 上线后存量登录全部重登一次（预期行为）。
        // 抛 UnauthorizedException 会被下方 catch 捕获再原样重抛（instanceof 分支），与封禁
        // 401 同一条穿透路径，最终由 HttpExceptionFilter 渲染成 { code: 1013, ... }。
        if (!this.sessionRegistry.matches(payload.role, payload.sub, payload.seq)) {
          throw new UnauthorizedException({ code: 1013, message: '账号已在其他设备登录' });
        }
        (req as Request & { user?: JwtUser }).user = {
          sub: payload.sub,
          role: payload.role,
          familyId: payload.familyId,
          parentId: payload.parentId,
        };
      } catch (err) {
        // 封禁 401 必须抛给全局 HttpExceptionFilter（不能与无效 token 一样被吞掉）
        if (err instanceof UnauthorizedException) throw err;
        // invalid/expired token → leave request.user unset; guard decides
      }
    }
    next();
  }
}
