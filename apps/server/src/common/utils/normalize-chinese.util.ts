import { PREFIX_STRIP } from './content-hash.util.js';

/**
 * 语文默写答案归一化：NFKC 全半角归一 → 去所有空白 → 去中英文标点 → 转小写。
 * 等价于「判对错时不算标点符号和空格」（设计 spec §5）。
 * 刻意不做简繁转换：教材为简体，学生也写简体，转繁会掩盖真实错误。
 * 复用 content-hash.util 的 PREFIX_STRIP，保证全仓只有一套标点表。
 */
export function normalizeChineseAnswer(s: string): string {
  return (s ?? '').normalize('NFKC').toLowerCase().replace(PREFIX_STRIP, '');
}

export type DictationDiffOp =
  | { type: 'equal'; text: string }
  | { type: 'wrong'; expected: string; actual: string }
  | { type: 'missing'; text: string }
  | { type: 'extra'; text: string };

/**
 * 逐字差异定位（LCS 最长公共子序列回溯）。
 * 入参须已归一化（用 normalizeChineseAnswer），因此差异视图展示的是
 * 「忽略标点与空格后」的对比——与判对错口径一致。
 * 相邻的「漏写 + 多写」会合并为一个 wrong（即写错字）。
 */
export function diffChinese(expected: string, actual: string): DictationDiffOp[] {
  const n = expected.length;
  const m = actual.length;
  // lcs[i][j] = expected[i..] 与 actual[j..] 的最长公共子序列长度（从后往前填）
  const lcs: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      lcs[i][j] = expected[i] === actual[j]
        ? lcs[i + 1][j + 1] + 1
        : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
    }
  }

  const raw: DictationDiffOp[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (expected[i] === actual[j]) {
      raw.push({ type: 'equal', text: expected[i] });
      i++;
      j++;
    } else if (lcs[i + 1][j] >= lcs[i][j + 1]) {
      raw.push({ type: 'missing', text: expected[i] }); // 学生漏写
      i++;
    } else {
      raw.push({ type: 'extra', text: actual[j] }); // 学生多写
      j++;
    }
  }
  while (i < n) {
    raw.push({ type: 'missing', text: expected[i] });
    i++;
  }
  while (j < m) {
    raw.push({ type: 'extra', text: actual[j] });
    j++;
  }

  // 合并：相邻 missing+extra → wrong（写错字）；同类连续项合并成一段
  const merged: DictationDiffOp[] = [];
  for (const op of raw) {
    const prev = merged[merged.length - 1];
    const prevIsOneSided = prev && (prev.type === 'missing' || prev.type === 'extra');
    const opIsOneSided = op.type === 'missing' || op.type === 'extra';
    if (prev && prevIsOneSided && opIsOneSided && prev.type !== op.type) {
      const p = prev as { type: 'missing' | 'extra'; text: string };
      const o = op as { type: 'missing' | 'extra'; text: string };
      merged[merged.length - 1] = p.type === 'missing'
        ? { type: 'wrong', expected: p.text, actual: o.text }
        : { type: 'wrong', expected: o.text, actual: p.text };
      continue;
    }
    if (prev && prev.type === op.type && (op.type === 'equal' || op.type === 'missing' || op.type === 'extra')) {
      (prev as { text: string }).text += op.text;
      continue;
    }
    merged.push(op);
  }
  return merged;
}
