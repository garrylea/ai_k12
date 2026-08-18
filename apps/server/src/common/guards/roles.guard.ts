import {
  Injectable,
  CanActivate,
  ExecutionContext,
  UnauthorizedException,
  ForbiddenException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { ROLES_KEY } from '../decorators/roles.js';
import type { JwtUser } from './jwt-auth.guard.js';

@Injectable()
export class RolesGuard implements CanActivate {
  constructor(private reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const requiredRoles = this.reflector.getAllAndOverride<string[]>(ROLES_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (!requiredRoles) {
      return true;
    }
    const request = context.switchToHttp().getRequest();
    const user = request.user as JwtUser | undefined;
    if (!user) {
      throw new UnauthorizedException({ code: 1003, message: '未登录或 token 已过期' });
    }
    if (!requiredRoles.includes(user.role)) {
      throw new ForbiddenException({ code: 1005, message: '无权访问该资源' });
    }
    return true;
  }
}
