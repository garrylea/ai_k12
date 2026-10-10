import { AsyncLocalStorage } from 'node:async_hooks';

/**
 * 请求级上下文，让 ai-core 深处的 `ModelClient` 能知道「这次调用来自哪个学生/哪个请求」，
 * 而不必改 14 个 capability 的签名（见 spec §6.5）。
 *
 * 放在 ai-core/infra（而非 spec 写的 modules/analytics）是**有意的**：ai-core 不能反向
 * 依赖 modules，否则形成循环依赖。
 *
 * 局限：ALS 只对「同一条 async 链」有效。HTTP 请求内 fire-and-forget 的
 * ExplanationCacheService 能拿到（Promise 链保留上下文）；若将来改成 setTimeout /
 * 队列调度，必须改传 `ChatRequest.meta.studentId` 显式归因（spec 把这条列为硬要求）。
 */
export interface RequestContext {
  requestId: string | null;
  studentId: number | null;
  role: string | null;
  /**
   * HTTP 请求模块（api 第一段，同 api_request_logs.module 值域；spec §2.2）。
   * 由 RequestContextMiddleware 建上下文时填；ai-core 自身不填。
   * NULL = 真正无 HTTP 触发链的调用（如启动期任务）；HTTP 触发的 fire-and-forget
   * （解释缓存 / 标题生成）与 admin/parent 的 HTTP 调用带触发请求的 module
   * （ALS 随 Promise 链延续），与归属覆盖率口径一致。
   */
  module?: string | null;
}

const storage = new AsyncLocalStorage<RequestContext>();

/**
 * 按第二段路径推导模块名（/api/practice/... -> practice）。
 * 2026-10-10 自 common/interceptors/analytics.interceptor.ts 迁入：ai-core 不能反向
 * import common（循环依赖，见文件头注释），公共纯函数放 ai-core 两侧共用防漂移。
 * 定死行为：裸 `/api`、`/api/`、无 /api 前缀 → null。
 */
export function moduleFromRoute(path: string): string | null {
  const m = /^\/api\/([^/?]+)/.exec(path);
  return m ? m[1] : null;
}

export function runWithRequestContext<T>(ctx: RequestContext, fn: () => T): T {
  return storage.run(ctx, fn);
}

export function getRequestContext(): RequestContext | null {
  return storage.getStore() ?? null;
}
