import { Injectable, NestMiddleware } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type { Request, Response, NextFunction } from 'express';
import type { JwtUser } from '../guards/jwt-auth.guard.js';
import { runWithRequestContext } from '../../ai-core/infra/request-context.js';

/**
 * 每请求开一个 AsyncLocalStorage 上下文，让 ai-core 深处的 ModelClient 能归因到学生。
 * 必须排在 AuthMiddleware **之后**（需要 request.user）；见 app.module.ts 的注册顺序。
 * 同时给 req 挂 requestId，供拦截器与账本关联。
 */
@Injectable()
export class RequestContextMiddleware implements NestMiddleware {
  use(req: Request, _res: Response, next: NextFunction): void {
    const user = (req as Request & { user?: JwtUser }).user;
    const requestId = randomUUID();
    (req as Request & { requestId?: string }).requestId = requestId;
    runWithRequestContext(
      {
        requestId,
        studentId: user?.role === 'student' ? Number(user.sub) : null,
        role: user?.role ?? null,
      },
      next,
    );
  }
}
