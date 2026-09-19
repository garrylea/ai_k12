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
}

const storage = new AsyncLocalStorage<RequestContext>();

export function runWithRequestContext<T>(ctx: RequestContext, fn: () => T): T {
  return storage.run(ctx, fn);
}

export function getRequestContext(): RequestContext | null {
  return storage.getStore() ?? null;
}
