/**
 * 训练轨 run 页共享：后端 options（JSON 数组，字符串选项如 "A. 1" 或 {label,text}）
 * 归一化为 QuestionRunner 需要的 {label, text} 形态。
 * 提取前导字母作 label（判题/答案比对用字母），剩余作选项文本；
 * 无法解析时按序号补字母 label，保证选择题可点选。
 * 专项练习（TargetedRunPage）与错题练习（ErrorPracticeRunPage）共用一份。
 */
export function normalizeOptions(
  raw: unknown[] | null | undefined,
): Array<{ label: string; text: string }> | undefined {
  if (!raw || raw.length === 0) return undefined;
  return raw.map((item, i) => {
    if (typeof item === 'string') {
      const m = item.match(/^\(?([A-Za-z])[.、．)）]\s*(.*)$/);
      if (m) return { label: m[1].toUpperCase(), text: m[2] || m[1].toUpperCase() };
      return { label: String.fromCharCode(65 + i), text: item };
    }
    if (item != null && typeof item === 'object' && 'label' in item && 'text' in item) {
      const o = item as { label: unknown; text: unknown };
      if (typeof o.label === 'string' && typeof o.text === 'string') return { label: o.label, text: o.text };
    }
    return { label: String.fromCharCode(65 + i), text: String(item) };
  });
}
