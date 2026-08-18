import { Injectable, NestInterceptor, ExecutionContext, CallHandler, HttpException, HttpStatus } from '@nestjs/common';
import type { Request } from 'express';
import { Observable } from 'rxjs';

/**
 * 轻量内存限流：同 IP 每窗口期 10 次，仅用于登录端点防爆破。
 * 单进程内存计数（无 Redis），重启即清零，MVP 够用。
 */
@Injectable()
export class ThrottleInterceptor implements NestInterceptor {
  private readonly limit = 10;
  private readonly windowMs = 60_000;
  private hits = new Map<string, { count: number; windowStart: number }>();

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    if (context.getType() !== 'http') {
      return next.handle();
    }
    const req = context.switchToHttp().getRequest<Request>();
    const ip = (req.ip ?? (req.headers['x-forwarded-for'] as string) ?? 'unknown').toString();
    const now = Date.now();
    const rec = this.hits.get(ip);
    if (!rec || now - rec.windowStart > this.windowMs) {
      this.hits.set(ip, { count: 1, windowStart: now });
    } else {
      rec.count += 1;
      if (rec.count > this.limit) {
        throw new HttpException(
          { code: 1008, message: '请求过于频繁，请稍后再试' },
          HttpStatus.TOO_MANY_REQUESTS,
        );
      }
    }
    return next.handle();
  }
}
