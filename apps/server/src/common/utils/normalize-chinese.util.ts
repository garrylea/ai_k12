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
 * 归一化并记录每个归一字对应的原文下标，供差异视图回投标点用。
 * 逐字归一化与整串归一化不一致时（NFKC 跨字符展开、İ 之类变长小写化）返回 null，
 * 调用方退回无标点视图——宁可少显示标点，也不能让判题口径漂移。
 */
function normalizeWithOrigins(s: string): { normalized: string; origins: number[] } | null {
  const source = s ?? '';
  const parts: string[] = [];
  const origins: number[] = [];
  for (let i = 0; i < source.length; i++) {
    const piece = normalizeChineseAnswer(source[i]);
    for (let k = 0; k < piece.length; k++) {
      parts.push(piece[k]);
      origins.push(i);
    }
  }
  const normalized = parts.join('');
  if (normalized !== normalizeChineseAnswer(source)) return null;
  return { normalized, origins };
}

/**
 * 带标点的正文差异：判对错仍按 `normalizeChineseAnswer` 后的文本比对（口径不变），
 * 但展示文本回投到原文，让学生看到带标点的整句。
 *
 * 归一字与被剥掉的标点归属规则：标点归**其后**的那个字，串尾标点归最后一个字。
 * 于是
 *   - equal 段自然带上前后标点（「床前明月」+「，疑是地上霜。」）；
 *   - wrong 段保持单字干净（「光」应为「先」），标点留给下一段，避免 expected/actual 两侧重复；
 *   - 整段漏写时，段内标点全部保留（「，浊酒一杯家万里，燕然未勒归无计。」）。
 * 一个 op 结束时若下一个 op 是错处，则本 op 顺手吃掉中间的标点，防止标点被孤立丢弃。
 */
export function diffChineseInOriginalText(expectedOriginal: string, actualOriginal: string): DictationDiffOp[] {
  const exp = normalizeWithOrigins(expectedOriginal);
  const act = normalizeWithOrigins(actualOriginal);
  if (!exp || !act) {
    // 退化：拿不到原文映射就用归一文差异（无标点，但判题口径与展示口径仍一致）
    return diffChinese(normalizeChineseAnswer(expectedOriginal), normalizeChineseAnswer(actualOriginal));
  }

  const ops = diffChinese(exp.normalized, act.normalized);
  const expText = projectSide(expectedOriginal, exp, ops, 'expected');
  const actText = projectSide(actualOriginal, act, ops, 'actual');

  return ops.map((op, i) => {
    if (op.type === 'equal') {
      // 相等段取 expected 侧：学生可能整篇不打标点，只有 expected 侧才带得出规范标点。
      return { type: 'equal', text: expText[i] };
    }
    if (op.type === 'missing') return { type: 'missing', text: expText[i] };
    if (op.type === 'extra') return { type: 'extra', text: actText[i] };
    return { type: 'wrong', expected: expText[i], actual: actText[i] };
  });
}

type Side = 'expected' | 'actual';

/** 该 op 是否在指定侧占用归一字（equal / wrong 两侧都占）。 */
function touchesSide(op: DictationDiffOp, side: Side): boolean {
  if (op.type === 'equal' || op.type === 'wrong') return true;
  return op.type === 'missing' ? side === 'expected' : side === 'actual';
}

/** 该 op 在指定侧占用几个归一字。 */
function tokenCountOn(op: DictationDiffOp, side: Side): number {
  if (op.type === 'equal' || op.type === 'missing' || op.type === 'extra') return op.text.length;
  return side === 'expected' ? op.expected.length : op.actual.length;
}

/** 该侧下一个占位的 op 类型（跳过不占该侧的 op）；没有则 null。 */
function nextTypeOn(ops: DictationDiffOp[], index: number, side: Side): DictationDiffOp['type'] | null {
  for (let i = index + 1; i < ops.length; i++) {
    if (touchesSide(ops[i], side)) return ops[i].type;
  }
  return null;
}

/**
 * 把一段 op 序列投影回某一侧的原文，返回与 ops 等长的展示文本数组（不占该侧的位置为 ''）。
 *
 * 每个 raw op 恰好从其所属侧消费 1 个归一字，合并只把相邻同类 op 粘起来，
 * 故按序推进「归一下标 + 原文下标」两个游标即可复原每段覆盖的原文区间。
 * 标点归属：只有 equal 段会领前置标点（读起来才自然）；error 段保持干净，
 * 其后的标点留给下一个 equal 段。若下一段不是 equal（或没有下一段），
 * 本段就把尾部标点一并吃掉，避免标点被孤立丢弃。
 */
function projectSide(
  original: string,
  map: { normalized: string; origins: number[] },
  ops: DictationDiffOp[],
  side: Side,
): string[] {
  const out: string[] = new Array<string>(ops.length).fill('');
  let normalizedCursor = 0;
  let origCursor = 0;

  for (let i = 0; i < ops.length; i++) {
    const op = ops[i];
    if (!touchesSide(op, side)) continue;
    const count = tokenCountOn(op, side);
    if (count <= 0) continue;

    const last = Math.min(normalizedCursor + count - 1, map.origins.length - 1);
    const charStart = map.origins[normalizedCursor];
    const charEnd = map.origins[last] + 1;
    const tailEnd = map.origins[last + 1] ?? original.length;

    const nextIsEqual = nextTypeOn(ops, i, side) === 'equal';

    let start: number;
    let end: number;
    if (op.type === 'equal') {
      start = Math.min(origCursor, charStart); // 领前置标点：读起来才连贯
      end = nextIsEqual ? charEnd : tailEnd;   // 下一段是 equal 就把尾部标点留给它
    } else if (op.type === 'missing') {
      start = charStart;
      end = nextIsEqual ? charEnd : tailEnd;   // 漏写整段要连着段内段尾标点一起展示
    } else {
      // extra / wrong：只占自己的字，前后标点留给相邻的 equal 段，避免同一标点出现两次
      start = charStart;
      end = charEnd;
    }

    out[i] = original.slice(start, end);
    origCursor = end;
    normalizedCursor += count;
  }
  return out;
}

/** 默写判题结果（纯计算，不含任何 DB/LLM 副作用）。 */
export interface DictationEvaluation {
  isCorrect: boolean;
  fields: { author: { match: boolean }; dynasty: { match: boolean }; body: { match: boolean } };
  bodyDiff: DictationDiffOp[];
}

/**
 * 纯函数判对错：三字段 `normalizeChineseAnswer` 后全等才 `isCorrect=true`（忽略标点与空格）。
 * 不碰 DB、不调 LLM——判题与错题本写入、错因生成彻底解耦。
 */
export function evaluateDictation(
  expected: { author: string; dynasty: string; body: string },
  student: { author: string; dynasty: string; body: string },
): DictationEvaluation {
  const author = { match: normalizeChineseAnswer(student.author) === normalizeChineseAnswer(expected.author) };
  const dynasty = { match: normalizeChineseAnswer(student.dynasty) === normalizeChineseAnswer(expected.dynasty) };
  const body = { match: normalizeChineseAnswer(student.body) === normalizeChineseAnswer(expected.body) };
  return {
    isCorrect: author.match && dynasty.match && body.match,
    fields: { author, dynasty, body },
    bodyDiff: body.match ? [] : diffChineseInOriginalText(expected.body, student.body),
  };
}

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
