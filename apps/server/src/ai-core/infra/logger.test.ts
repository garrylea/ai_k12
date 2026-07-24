import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Logger, createLogger } from './logger.js';

describe('Logger', () => {
  let logSpy: ReturnType<typeof vi.spyOn>;
  let errSpy: ReturnType<typeof vi.spyOn>;
  let warnSpy: ReturnType<typeof vi.spyOn>;
  let debugSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    debugSpy = vi.spyOn(console, 'debug').mockImplementation(() => {});
  });

  it('creates with a random UUID traceId by default', () => {
    const logger = new Logger();
    expect(logger.getTraceId()).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
    );
  });

  it('accepts a custom traceId', () => {
    const logger = new Logger('trace-123');
    expect(logger.getTraceId()).toBe('trace-123');
  });

  it('logs a structured JSON entry with traceId at info level via console.log', () => {
    const logger = new Logger('trace-abc');
    logger.log('info', 'ModelClient', 'chat', { model: 'qwen' }, { tokens: 10 }, 42);

    expect(logSpy).toHaveBeenCalledTimes(1);
    const entry = JSON.parse(logSpy.mock.calls[0][0] as string);
    expect(entry.traceId).toBe('trace-abc');
    expect(entry.level).toBe('info');
    expect(entry.component).toBe('ModelClient');
    expect(entry.action).toBe('chat');
    expect(entry.input).toEqual({ model: 'qwen' });
    expect(entry.output).toEqual({ tokens: 10 });
    expect(entry.duration).toBe(42);
    expect(entry.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(entry.error).toBeUndefined();
  });

  it('includes error field and routes to console.error', () => {
    const logger = new Logger('trace-err');
    logger.log('error', 'ModelClient', 'chat', {}, {}, 0, 'timeout');

    expect(errSpy).toHaveBeenCalledTimes(1);
    const entry = JSON.parse(errSpy.mock.calls[0][0] as string);
    expect(entry.level).toBe('error');
    expect(entry.error).toBe('timeout');
  });

  it('routes warn and debug to the correct console methods', () => {
    const logger = new Logger('t');
    logger.log('warn', 'c', 'a', {}, {}, 1);
    logger.log('debug', 'c', 'a', {}, {}, 1);

    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(debugSpy).toHaveBeenCalledTimes(1);
    expect(logSpy).not.toHaveBeenCalled();
  });

  it('createLogger returns a Logger with the given traceId', () => {
    const logger = createLogger('trace-factory');
    expect(logger).toBeInstanceOf(Logger);
    expect(logger.getTraceId()).toBe('trace-factory');
  });
});
