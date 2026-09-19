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

/**
 * 覆盖边界（**已知缺口，勿当作 bug 反复报**）：Nest 的守卫在拦截器**之前**执行，
 * 未匹配的路径也进不了处理器，所以被 JwtAuthGuard/RolesGuard 拒掉的 401/403、
 * 以及 404 都**不会**落进 api_request_logs。即本表覆盖的是「走到了处理器的请求」。
 * 影响：失败率里不含鉴权失败（会在 Phase 2 的报表口径里注明）。
 * 若将来需要全覆盖，改成在 AuthMiddleware 之后注册一个中间件、用 res.on('finish') 记账
 * （中间件不会拒请求，因此不会漏）。
 */
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
        // 从**响应**头判定 SSE，而不是请求头：前端的流式调用只发 Content-Type/Authorization，
        // 浏览器补的是 Accept: */*，请求头判定永远不成立。流式处理器会自己 setHeader
        // 'Content-Type: text/event-stream'，tap 触发时它已经写好。
        isSse: String(http.getResponse().getHeader('content-type') ?? '').includes('text/event-stream'),
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
