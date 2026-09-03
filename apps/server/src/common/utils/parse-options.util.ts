/**
 * options JSON 字符串安全解析：null/空串/非数组/坏 JSON 一律返回 null。
 *
 * 从 training.service 提取为共享 util（exams / training 单一实现）。
 */
export function parseOptions(raw: string | null): unknown[] | null {
  if (raw == null || raw === '') return null;
  try {
    const v = JSON.parse(raw);
    return Array.isArray(v) ? v : null;
  } catch {
    return null;
  }
}
