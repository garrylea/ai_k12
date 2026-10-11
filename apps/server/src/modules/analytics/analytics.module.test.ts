import { describe, it, expect, afterEach, vi } from 'vitest';
import { AnalyticsModule, enrichLlmCallEntry } from './analytics.module.js';
import { emitLlmCall, setLlmCallSink } from '../../ai-core/infra/llm-call-log.js';
import { runWithRequestContext } from '../../ai-core/infra/request-context.js';
import type { TelemetryService } from './telemetry.service.js';
import type { EventsService } from './events.service.js';
import type { LlmCallLogEntry } from '../../ai-core/infra/llm-call-log.js';

// AnalyticsModule 构造器把 enrich 后的 push 挂到模块级 sink 单例上；测试结束必须摘掉，
// 否则同文件后续用例（乃至同 worker 的其他文件若共享模块注册表）会被残留 sink 污染。
afterEach(() => {
  setLlmCallSink(null);
});

const makeEntry = (overrides: Partial<LlmCallLogEntry> = {}): LlmCallLogEntry => ({
  requestId: 'r1', studentId: 9, dialogueId: null, scene: 'tutoring', subject: 'math',
  capability: 'tutoring', modelKey: 'local', modelId: 'Qwen3.8-27B', provider: 'local',
  attempt: 1, requestKind: 'chat', isFallback: false, success: true,
  errorType: null, httpStatus: 200, inputTokens: 10, outputTokens: 5,
  usageSource: 'provider', latencyMs: 100, ...overrides,
});

const makeModule = (pushed: LlmCallLogEntry[]) => {
  const telemetry = { llmCalls: { push: (e: LlmCallLogEntry) => pushed.push(e) } } as unknown as TelemetryService;
  const events = { track: vi.fn() } as unknown as EventsService;
  return { events, module: new AnalyticsModule(telemetry, events) };
};

describe('LLM sink 的 module enrich（spec §2.2）', () => {
  it('HTTP 上下文内：entry 被 enrich 上 context.module 再进 buffer', () => {
    const pushed: LlmCallLogEntry[] = [];
    makeModule(pushed);
    runWithRequestContext({ requestId: 'r1', studentId: 9, role: 'student', module: 'practice' }, () => {
      emitLlmCall(makeEntry());
    });
    expect(pushed).toHaveLength(1);
    expect(pushed[0].module).toBe('practice');
  });

  it('无 ALS（无 HTTP 触发链的调用）→ module null（归因边界，与 Phase 0 口径对齐）', () => {
    const pushed: LlmCallLogEntry[] = [];
    makeModule(pushed);
    emitLlmCall(makeEntry());
    expect(pushed).toHaveLength(1);
    expect(pushed[0].module).toBeNull();
  });

  it('ALS 存在但未带 module（旧调用点/无路由路径）→ module null，不抛', () => {
    const pushed: LlmCallLogEntry[] = [];
    makeModule(pushed);
    runWithRequestContext({ requestId: 'r2', studentId: null, role: null }, () => {
      emitLlmCall(makeEntry());
    });
    expect(pushed[0].module).toBeNull();
  });

  it('enrich 不改写原 entry（buffer 拿到的是副本）', () => {
    const pushed: LlmCallLogEntry[] = [];
    makeModule(pushed);
    const entry = makeEntry();
    runWithRequestContext({ requestId: 'r1', studentId: 9, role: 'student', module: 'ai' }, () => {
      emitLlmCall(entry);
    });
    expect(entry.module).toBeUndefined();
    expect(pushed[0].module).toBe('ai');
  });

  it('isFallback 事件路径在 enrich 后仍工作', () => {
    const pushed: LlmCallLogEntry[] = [];
    const { events } = makeModule(pushed);
    runWithRequestContext({ requestId: 'r1', studentId: 9, role: 'student', module: 'training' }, () => {
      emitLlmCall(makeEntry({ isFallback: true, scene: 'refinery' }));
    });
    expect(pushed[0].module).toBe('training');
    expect(events.track).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'llm_fallback_triggered' }),
    );
  });
});

describe('enrichLlmCallEntry（纯函数）', () => {
  it('ctx 为 null 或 ctx.module 为 null/undefined → module null', () => {
    expect(enrichLlmCallEntry(makeEntry(), null).module).toBeNull();
    expect(enrichLlmCallEntry(makeEntry(), { requestId: null, studentId: null, role: null }).module).toBeNull();
    expect(
      enrichLlmCallEntry(makeEntry(), { requestId: null, studentId: null, role: null, module: null }).module,
    ).toBeNull();
  });

  it('ctx.module 有值 → 原样带入', () => {
    expect(
      enrichLlmCallEntry(makeEntry(), { requestId: 'r1', studentId: 1, role: 'student', module: 'exams' }).module,
    ).toBe('exams');
  });
});
