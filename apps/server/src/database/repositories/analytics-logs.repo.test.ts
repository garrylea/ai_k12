import { describe, it, expect, vi } from 'vitest';
import { LlmCallLogsRepository } from './llm-call-logs.repo';
import { ApiRequestLogsRepository } from './api-request-logs.repo';

const mockPool = () => ({
  execute: vi.fn().mockResolvedValue([{ affectedRows: 1 }, []]),
  query: vi.fn().mockResolvedValue([{ affectedRows: 1 }, []]),
});

const entry = () => ({
  requestId: 'r1', studentId: 9, dialogueId: 3, scene: 'judgment', subject: 'math',
  capability: 'judgment', modelKey: 'local', modelId: 'Qwen3.8-27B', provider: 'local',
  attempt: 1, requestKind: 'chat' as const, isFallback: false, success: true,
  errorType: null, httpStatus: null, inputTokens: 120, outputTokens: 8,
  usageSource: 'provider' as const, latencyMs: 1180, module: 'practice',
});

// COLUMNS 下标（0-based，见实现）：scene=3、module=4、is_fallback=12、success=13、
// input_tokens=16、output_tokens=17、latency_ms=19（最后一列）。module 在 scene 之后，
// 与迁移 2026-10-10_llm_call_logs_module.sql 的 AFTER scene 一致。

describe('LlmCallLogsRepository.insertMany', () => {
  it('多行 INSERT 走 pool.query（占位符数量动态，不能用 execute）', async () => {
    const pool = mockPool();
    await new LlmCallLogsRepository(pool as any).insertMany([entry(), entry()]);
    expect(pool.execute).not.toHaveBeenCalled();
    const [sql, params] = pool.query.mock.calls[0];
    expect(sql).toContain('INSERT INTO llm_call_logs');
    expect(sql).toContain('student_id');
    expect(params).toHaveLength(40); // 2 行 × 20 列（列数见实现 COLUMNS）
    expect(params[0]).toBe('r1');
  });

  it('空数组直接 return，不发 SQL', async () => {
    const pool = mockPool();
    await new LlmCallLogsRepository(pool as any).insertMany([]);
    expect(pool.query).not.toHaveBeenCalled();
  });

  it('token 为 null 时原样写 null（不洗成 0）', async () => {
    const pool = mockPool();
    await new LlmCallLogsRepository(pool as any).insertMany([
      { ...entry(), usageSource: 'unavailable', inputTokens: null, outputTokens: null },
    ]);
    const [, params] = pool.query.mock.calls[0];
    expect(params[16]).toBeNull();
    expect(params[17]).toBeNull();
    expect(params[params.length - 1]).toBe(1180); // latency_ms 是最后一列
  });

  it('isFallback / success 布尔转 0|1', async () => {
    const pool = mockPool();
    await new LlmCallLogsRepository(pool as any).insertMany([{ ...entry(), isFallback: true, success: false }]);
    const [, params] = pool.query.mock.calls[0];
    expect(params[12]).toBe(1); // is_fallback
    expect(params[13]).toBe(0); // success
  });

  it('module 按列名配对写入（紧随 scene，同 api_request_logs.module 值域）', async () => {
    const pool = mockPool();
    await new LlmCallLogsRepository(pool as any).insertMany([entry()]);
    const [sql, params] = pool.query.mock.calls[0];
    // 列清单里 module 紧随 scene（配对靠 COLUMNS 顺序 + args 同序，SQL 侧可核对）
    expect(sql).toMatch(/scene, module,/);
    expect(params[3]).toBe('judgment'); // scene
    expect(params[4]).toBe('practice'); // module
  });

  it('module 缺省（后台任务入口未 enrich）写 null，不写 undefined', async () => {
    const pool = mockPool();
    const { module: _drop, ...noModule } = entry();
    await new LlmCallLogsRepository(pool as any).insertMany([noModule as any]);
    const [, params] = pool.query.mock.calls[0];
    expect(params[4]).toBeNull();
  });
});

describe('ApiRequestLogsRepository.insertMany', () => {
  it('落一条请求日志，含归一化 route 与 is_sse', async () => {
    const pool = mockPool();
    await new ApiRequestLogsRepository(pool as any).insertMany([{
      requestId: 'r1', actorRole: 'student', studentId: 9, method: 'POST',
      route: '/api/practice/:cardId/judge', rawPath: '/api/practice/12/judge',
      module: 'practice', statusCode: 201, bizCode: 0, errorCode: null,
      latencyMs: 1500, isSse: false,
    }]);
    const [sql, params] = pool.query.mock.calls[0];
    expect(sql).toContain('INSERT INTO api_request_logs');
    expect(params).toEqual(['r1', 'student', 9, 'POST', '/api/practice/:cardId/judge', '/api/practice/12/judge', 'practice', 201, 0, null, 1500, 0]);
  });
});
