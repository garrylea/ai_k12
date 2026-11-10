// 做题错题「重练」的题单队列：错题本写入、做题页读取。
// 存 sessionStorage（不是 localStorage）：一次重练只属于当前标签页，关掉即失效。
// 读后不删：刷新要能恢复当前题；完成/主动退出由调用方 clearRedoQueue()。

export const FREEFORM_REDO_KEY = 'training:freeform-redo';

export interface FreeformRedoItem {
  errorBookId: number;
  questionId: number;
  questionText: string;
  type: string | null;
  /** questions.full_score；null 时做题页按 10 */
  fullScore: number | null;
}

export interface FreeformRedoQueue {
  subjectId: number;
  items: FreeformRedoItem[];
  /** 当前题下标（0-based） */
  index: number;
}

const isPositiveInt = (v: unknown): v is number =>
  typeof v === 'number' && Number.isInteger(v) && v > 0;

function safeGet(): string | null {
  try {
    return sessionStorage.getItem(FREEFORM_REDO_KEY);
  } catch {
    // 隐私模式 / 存储被禁用
    return null;
  }
}

export function saveRedoQueue(queue: FreeformRedoQueue): void {
  try {
    sessionStorage.setItem(FREEFORM_REDO_KEY, JSON.stringify(queue));
  } catch {
    // 配额满 / 隐私模式：页面仍可继续，只是刷新后恢复不了
  }
}

export function clearRedoQueue(): void {
  try {
    sessionStorage.removeItem(FREEFORM_REDO_KEY);
  } catch {
    // ignore
  }
}

/**
 * 读取并校验队列；任何结构不合法都清键并返回 null（页面据此回错题本）。
 * 校验点：subjectId 正整数、items 非空、每题 errorBookId/questionId 正整数、
 * questionText 非空、fullScore 为正整数或 null、index 落在 [0, len-1]。
 */
export function readRedoQueue(): FreeformRedoQueue | null {
  const raw = safeGet();
  if (!raw) return null;

  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    clearRedoQueue();
    return null;
  }

  const q = value as Partial<FreeformRedoQueue> | null;
  const items = q?.items;
  const valid =
    !!q &&
    isPositiveInt(q.subjectId) &&
    Array.isArray(items) &&
    items.length > 0 &&
    items.every(
      (i) =>
        !!i &&
        isPositiveInt(i.errorBookId) &&
        isPositiveInt(i.questionId) &&
        typeof i.questionText === 'string' &&
        i.questionText.trim().length > 0 &&
        (i.fullScore == null || isPositiveInt(i.fullScore)),
    ) &&
    typeof q.index === 'number' &&
    Number.isInteger(q.index) &&
    q.index >= 0 &&
    q.index < items.length;

  if (!valid) {
    clearRedoQueue();
    return null;
  }

  return {
    subjectId: q.subjectId as number,
    items: items as FreeformRedoItem[],
    index: q.index as number,
  };
}

/** 只推进下标；队列不存在/越界时不写。 */
export function updateRedoIndex(index: number): void {
  const q = readRedoQueue();
  if (!q || !Number.isInteger(index) || index < 0 || index >= q.items.length) return;
  saveRedoQueue({ ...q, index });
}

const REDO_FIGURE_RE = /!\[[^\]]*\]\((\/uploads\/freeform\/[^)\s]+)[^)]*\)/g;

/**
 * 从题干 Markdown 提取做题配图（与后端 FREEFORM_FIGURE_PREFIX 一致），去重、最多 6 张。
 * 重练时作为 figureUrls 随判题下发；无权图由后端宽松模式跳过。
 */
export function extractRedoFigures(content: string): string[] {
  const out = new Set<string>();
  for (const m of content.matchAll(REDO_FIGURE_RE)) {
    out.add(m[1]);
    if (out.size >= 6) break;
  }
  return [...out];
}
