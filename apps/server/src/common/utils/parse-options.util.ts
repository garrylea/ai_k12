/**
 * options JSON 字符串安全解析：null/空串/非数组/坏 JSON 一律返回 null。
 *
 * 从 training.service 提取为共享 util（exams / training 单一实现）。
 */
export function parseOptions(raw: string | null): unknown[] | null {
  if (raw == null || raw === '') return null;
  try {
    const v = JSON.parse(raw);
    if (!Array.isArray(v)) return null;
    // 做题题历史 options 可能带 isCorrect；解禁后这些题会下发给学生，读取时兜底剥离
    return v.map((o) => {
      if (o && typeof o === 'object' && 'isCorrect' in o) {
        const { isCorrect: _ignored, ...rest } = o as Record<string, unknown>;
        return rest;
      }
      return o;
    });
  } catch {
    return null;
  }
}
