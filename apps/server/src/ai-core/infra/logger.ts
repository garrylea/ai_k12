import type { AgentLog } from '../types.js';
import { randomUUID } from 'crypto';

export class Logger {
  private traceId: string;

  constructor(traceId?: string) {
    this.traceId = traceId ?? randomUUID();
  }

  getTraceId(): string {
    return this.traceId;
  }

  log(
    level: AgentLog['level'],
    component: string,
    action: string,
    input: Record<string, unknown>,
    output: Record<string, unknown>,
    duration: number,
    error?: string,
  ): void {
    const entry: AgentLog = {
      timestamp: new Date().toISOString(),
      traceId: this.traceId,
      level,
      component,
      action,
      input,
      output,
      duration,
      ...(error ? { error } : {}),
    };

    const logLine = JSON.stringify(entry);

    switch (level) {
      case 'error': console.error(logLine); break;
      case 'warn': console.warn(logLine); break;
      case 'debug': console.debug(logLine); break;
      default: console.log(logLine);
    }
  }
}

/** Factory for creating loggers per-request with an optional propagated traceId. */
export function createLogger(traceId?: string): Logger {
  return new Logger(traceId);
}
