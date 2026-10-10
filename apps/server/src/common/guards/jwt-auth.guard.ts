import {
  Injectable,
  CanActivate,
  ExecutionContext,
  UnauthorizedException,
} from '@nestjs/common';

export interface JwtUser {
  sub: number;
  role: 'admin' | 'parent' | 'student';
  /** 仅学生 token 携带（= parent_id）；家长/管理员无。 */
  familyId?: number;
  parentId?: number;
  /** 会话序号（2026-10-10 单点登录互踢）：与 SessionRegistry 当前值失配 → 401/1013。 */
  seq?: number;
}

// NOTE: Phase A uses a simplified JWT guard. In production, this should
// integrate with @nestjs/passport PassportStrategy for proper JWT verification.
// For now, tokens are verified via AuthService and user info is attached
// to the request in AuthController / AuthMiddleware.
@Injectable()
export class JwtAuthGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest();
    const user = request.user as JwtUser | undefined;
    if (!user) {
      throw new UnauthorizedException({ code: 1003, message: '未登录或 token 已过期' });
    }
    return true;
  }
}
