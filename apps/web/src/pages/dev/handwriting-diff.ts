/** 手写识别率比对的归一化 + LCS 字级对齐。纯函数、零依赖（spec §6）。 */

/** 归一化：NFKC（全角→半角）→ 去空白与全部 Unicode 标点（中西文）→ 英文小写。 */
export function normalizeForCompare(s: string): string {
  return s.normalize('NFKC').replace(/[\s\p{P}]/gu, '').toLowerCase();
}

export interface DiffError { expected: string; got: string | null }

export interface CompareResult {
  expected: string;
  recognized: string;
  matched: number;
  accuracy: number;
  errors: DiffError[];
  extra: string[];
}

export function compareHandwriting(expected: string, recognized: string): CompareResult {
  const e = [...normalizeForCompare(expected)];
  const r = [...normalizeForCompare(recognized)];
  const m = e.length;
  const n = r.length;

  // dp[i][j] = e 前 i 个与 r 前 j 个的 LCS 长度
  const dp: number[][] = Array.from({ length: m + 1 }, () => new Array<number>(n + 1).fill(0));
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      dp[i][j] = e[i - 1] === r[j - 1] ? dp[i - 1][j - 1] + 1 : Math.max(dp[i - 1][j], dp[i][j - 1]);
    }
  }

  // 回溯出对齐序列（顺序对）
  type Pair = { expected: string | null; got: string | null };
  const pairs: Pair[] = [];
  let i = m;
  let j = n;
  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && e[i - 1] === r[j - 1]) {
      pairs.push({ expected: e[i - 1], got: r[j - 1] });
      i--; j--;
    } else if (i > 0 && (j === 0 || dp[i - 1][j] >= dp[i][j - 1])) {
      pairs.push({ expected: e[i - 1], got: null }); // 漏识别（平局优先漏，使漏+多相邻可合并为错字）
      i--;
    } else {
      pairs.push({ expected: null, got: r[j - 1] }); // 多识别
      j--;
    }
  }
  pairs.reverse();

  const matched = dp[m][n];
  const accuracy = m === 0 ? (n === 0 ? 1 : 0) : matched / m;
  // 错字呈现：LCS 回溯只产出「相等对 / 漏字 / 多字」，把相邻的漏字+多字合并为错字对
  const errors: DiffError[] = [];
  const extra: string[] = [];
  const missed: string[] = [];
  const inserted: string[] = [];
  const flush = () => {
    while (missed.length > 0 && inserted.length > 0) {
      errors.push({ expected: missed.shift() as string, got: inserted.shift() as string });
    }
    for (const ch of missed) errors.push({ expected: ch, got: null });
    for (const ch of inserted) extra.push(ch);
    missed.length = 0;
    inserted.length = 0;
  };
  for (const p of pairs) {
    if (p.expected === null) inserted.push(p.got as string);
    else if (p.got === null) missed.push(p.expected);
    else flush();
  }
  flush();
  return { expected: e.join(''), recognized: r.join(''), matched, accuracy, errors, extra };
}
