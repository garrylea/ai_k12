import { Injectable, NestMiddleware } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import type { Request, Response, NextFunction } from 'express';
import type { JwtUser } from '../guards/jwt-auth.guard.js';

/**
 * Parses the `Authorization: Bearer <jwt>` header and, when the token is valid,
 * attaches the decoded payload to `request.user`. Invalid/missing tokens are a
 * no-op here — access control is delegated to JwtAuthGuard on the routes that
 * require authentication, so public routes (login, subjects) stay open.
 */
@Injectable()
export class AuthMiddleware implements NestMiddleware {
  constructor(private jwtService: JwtService) {}

  use(req: Request, _res: Response, next: NextFunction): void {
    const header = req.headers['authorization'];
    if (header && header.startsWith('Bearer ')) {
      const token = header.slice('Bearer '.length).trim();
      try {
        const payload = this.jwtService.verify<JwtUser>(token);
        (req as Request & { user?: JwtUser }).user = {
          sub: payload.sub,
          role: payload.role,
          familyId: payload.familyId,
          parentId: payload.parentId,
        };
      } catch {
        // invalid/expired token → leave request.user unset; guard decides
      }
    }
    next();
  }
}
