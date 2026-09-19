import type { UsageSource } from '../types.js';

/**
 * 一次 LLM 调用的账本条目。**每次逻辑调用一行，每次重试尝试各一行**（attempt 递增）。
 *
 * 为什么放 ai-core：`ModelClient` 是全部 14 个 capability 的唯一出口，在这里埋点
 * 才能既不漏又不改 capability。但这个文件**不能依赖 Nest DI**（capability 是零参
 * `new` 出来的，见 CLAUDE.md 的 DI 坑），所以用**模块级 sink 单例**——由
 * AnalyticsModule 在启动时把「推入 TelemetryBuffer」的函数注册进来。
 */
export interface LlmCallLogEntry {
  requestId: string | null;
  studentId: number | null;
  dialogueId: number | null;
  scene: string | null;
  subject: string | null;
  capability: string | null;
  modelKey: string | null;
  modelId: string | null;
  provider: string;
  attempt: number;
  requestKind: 'chat' | 'stream';
  isFallback: boolean;
  success: boolean;
  errorType: string | null;
  httpStatus: number | null;
  inputTokens: number | null;
  outputTokens: number | null;
  usageSource: UsageSource;
  latencyMs: number;
}

export type LlmCallSink = (entry: LlmCallLogEntry) => void;

let sink: LlmCallSink | null = null;

export function setLlmCallSink(next: LlmCallSink | null): void {
  sink = next;
}

/** 记账永不抛：埋点坏了也不能让一次 LLM 调用失败。 */
export function emitLlmCall(entry: LlmCallLogEntry): void {
  if (!sink) return;
  try {
    sink(entry);
  } catch {
    /* 记账失败只吞掉，不冒泡 */
  }
}
