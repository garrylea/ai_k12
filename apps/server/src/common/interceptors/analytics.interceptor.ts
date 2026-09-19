import { Injectable, NestInterceptor, ExecutionContext, CallHandler } from '@nestjs/common';
import { Observable, throwError } from 'rxjs';
import { catchError, tap } from 'rxjs/operators';
import type { Request } from 'express';
import type { JwtUser } from '../guards/jwt-auth.guard.js';
import type { ApiRequestLogEntry } from '../../database/repositories/api-request-logs.repo.js';
import { TelemetryService } from '../../modules/analytics/telemetry.service.js';

/** 不做埋点的路径：自指噪音 + 静态资源 */
const SKIP_PREFIXES = ['/assets/', '/uploads/'];
const SKIP_PATTERNS = [/^\/api\/admin\/analytics(\/|$)/, /^\/api\/track(\/|$)/];

export function shouldSkipRoute(path: string): boolean {
  if (SKIP_PREFIXES.some((p) => path.startsWith(p))) return true;
  return SKIP_PATTERNS.some((re) => re.test(path));
}

/** 按第二段路径推导模块名（/api/practice/... -> practice） */
export function moduleFromRoute(path: string): string | null {
  const m = /^\/api\/([^/?]+)/.exec(path);
  return m ? m[1] : null;
}

/** 优先用 Express 路由模板；拿不到时按形状替换，避免每个 id 一个基数 */
export function normalizeRoute(input: { baseUrl: string; routePath?: string; path: string }): string {
  if (input.routePath) return `${input.baseUrl}${input.routePath}`;
  const full = input.path.split('?')[0];
  return full
    .replace(/\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, '/:uuid')
    .replace(/\/\d+/g, '/:id');
}

@Injectable()
export class AnalyticsInterceptor implements NestInterceptor {
  constructor(private telemetry: TelemetryService) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    if (context.getType() !== 'http') return next.handle();
    const http = context.switchToHttp();
    const req = http.getRequest<Request & { user?: JwtUser; requestId?: string }>();
    const path = (req.originalUrl ?? req.url ?? '').split('?')[0];
    if (shouldSkipRoute(path)) return next.handle();

    const started = Date.now();
    const push = (statusCode: number, bizCode: number | null, errorCode: string | null) => {
      const user = req.user;
      const entry: ApiRequestLogEntry = {
        requestId: req.requestId ?? null,
        actorRole: user?.role ?? 'anonymous',
        studentId: user?.role === 'student' ? Number(user.sub) : null,
        method: req.method,
        route: normalizeRoute({
          baseUrl: req.baseUrl ?? '',
          routePath: (req as Request & { route?: { path?: string } }).route?.path,
          path,
        }),
        rawPath: path.slice(0, 255),
        module: moduleFromRoute(path),
        statusCode,
        bizCode,
        errorCode,
        latencyMs: Date.now() - started,
        isSse: String(req.headers['accept'] ?? '').includes('text/event-stream'),
      };
      this.telemetry.apiRequests.push(entry);
    };

    return next.handle().pipe(
      tap({
        // 全局 ResponseInterceptor 包成 {code,message,data}，这里读不到最终响应体；
        // 成功路径只记 HTTP 状态码（失败路径能拿到业务码，见 catchError）。
        next: () => push(http.getResponse().statusCode, null, null),
      }),
      catchError((err) => {
        const status = typeof err?.getStatus === 'function' ? err.getStatus() : 500;
        const payload = typeof err?.getResponse === 'function' ? err.getResponse() : null;
        const bizCode = payload && typeof payload === 'object' && typeof (payload as { code?: unknown }).code === 'number'
          ? (payload as { code: number }).code
          : null;
        push(status, bizCode, err?.name ?? 'Error');
        return throwError(() => err);
      }),
    );
  }
}
