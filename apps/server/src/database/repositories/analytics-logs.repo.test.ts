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
  usageSource: 'provider' as const, latencyMs: 1180,
});

describe('LlmCallLogsRepository.insertMany', () => {
  it('多行 INSERT 走 pool.query（占位符数量动态，不能用 execute）', async () => {
    const pool = mockPool();
    await new LlmCallLogsRepository(pool as any).insertMany([entry(), entry()]);
    expect(pool.execute).not.toHaveBeenCalled();
    const [sql, params] = pool.query.mock.calls[0];
    expect(sql).toContain('INSERT INTO llm_call_logs');
    expect(sql).toContain('student_id');
    expect(params).toHaveLength(38); // 2 行 × 19 列（列数见实现 COLUMNS）
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
    // COLUMNS 里的下标：input_tokens=15、output_tokens=16（0-based，见实现 COLUMNS）
    expect(params[15]).toBeNull();
    expect(params[16]).toBeNull();
    expect(params[params.length - 1]).toBe(1180); // latency_ms 是最后一列
  });

  it('isFallback / success 布尔转 0|1', async () => {
    const pool = mockPool();
    await new LlmCallLogsRepository(pool as any).insertMany([{ ...entry(), isFallback: true, success: false }]);
    const [, params] = pool.query.mock.calls[0];
    expect(params[11]).toBe(1); // is_fallback
    expect(params[12]).toBe(0); // success
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
