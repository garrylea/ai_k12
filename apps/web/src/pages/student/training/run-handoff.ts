/**
 * 两个会话页（数学专项 / 背单词）的 sessionStorage 交接体。
 *
 * 形状必须**两侧一起改**：配置页写入、run 页读回，中间不能留兼容旧格式的分支
 * （本题不要求兼容旧数组格式）。这里集中定义形状 + 解析，避免两侧各写一份类型后漂移。
 *
 * `sessionId` 允许为 `null`（计划一 Task 12：会话 INSERT 未包住、DB 故障时降级）——
 * run 页据此跳过 `complete`，学习照走、不发分、不报错。
 */
import type { TargetedPracticeQuestion, VocabularyQuestionItem } from '@/services/api';

export interface TargetedRunHandoff {
  sessionId: number | null;
  questions: TargetedPracticeQuestion[];
}

export interface VocabularyRunHandoff {
  sessionId: number | null;
  questions: VocabularyQuestionItem[];
}

/**
 * 解析移交体；`raw` 为空 / JSON 解析失败 / 形状不对一律返回 `null`，
 * 调用方按「空题单」处理（踢回配置页），与改动前行为一致。
 */
export function parseRunHandoff<T>(
  raw: string | null,
): { sessionId: number | null; questions: T[] } | null {
  if (!raw) return null;
  try {
    const value: unknown = JSON.parse(raw);
    if (value == null || typeof value !== 'object' || Array.isArray(value)) return null;
    const { sessionId, questions } = value as { sessionId?: unknown; questions?: unknown };
    // sessionId 必须显式存在且为 number | null；缺字段视为形状不对
    if (sessionId !== null && typeof sessionId !== 'number') return null;
    if (!Array.isArray(questions)) return null;
    return { sessionId, questions: questions as T[] };
  } catch {
    return null;
  }
}
