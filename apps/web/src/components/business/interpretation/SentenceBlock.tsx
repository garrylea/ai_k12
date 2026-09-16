import type { ReactNode } from 'react';
import type {
  InterpretationJudgeResult,
  InterpretationSentenceItem,
  InterpretationTermItem,
} from '@/services/api';
import ItemResultLine from './ItemResultLine';

export interface InterpretationAnswerValue {
  /** term → 学生写的释义 */
  terms: Record<string, string>;
  translation: string;
}

export type SentenceState = 'editing' | 'judging' | 'judged';

interface Props {
  sentence: InterpretationSentenceItem;
  value: InterpretationAnswerValue;
  onChange: (next: InterpretationAnswerValue) => void;
  state: SentenceState;
  result: InterpretationJudgeResult | null;
  isLast: boolean;
  onNext: () => void;
  onRetry: () => void;
}

const FIELD_BORDER = { border: '1px solid rgba(226, 232, 240, 0.8)' } as const;
const INPUT_CLASS =
  'w-full h-11 px-3 rounded-xl bg-white text-[var(--text-primary)] outline-none focus:ring-2 focus:ring-[var(--brand-500)]/30 disabled:opacity-70 disabled:bg-[var(--bg-subtle)]';

/** 与 QuestionRunner / DictationRunPage 同款转圈（线性 SVG，无 emoji）。 */
const Spinner = () => (
  <svg className="animate-spin text-[var(--brand-500)] shrink-0" width="18" height="18"
    viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"
    aria-hidden="true">
    <path d="M21 12a9 9 0 1 1-6.219-8.56" />
  </svg>
);

/**
 * 把原文里出现的字词高亮（下划线 + 主色）。
 *
 * 用 `plain`（去注音）去找位置——正文里没有注音，用带拼音的 `term` 永远找不着。
 * 每个词只标**首次出现**处，且**不重叠**（同一个词在后文再次出现不重复标）；
 * 找不到的词直接跳过——不报错，也不硬塞。
 */
function highlightTerms(text: string, terms: InterpretationTermItem[]): ReactNode[] {
  const spans: Array<{ start: number; end: number }> = [];
  const taken = new Array<boolean>(text.length).fill(false);
  for (const { plain } of terms) {
    if (!plain) continue;
    const idx = text.indexOf(plain);
    if (idx < 0) continue;
    let overlap = false;
    for (let i = idx; i < idx + plain.length; i++) {
      if (taken[i]) { overlap = true; break; }
    }
    if (overlap) continue;
    for (let i = idx; i < idx + plain.length; i++) taken[i] = true;
    spans.push({ start: idx, end: idx + plain.length });
  }
  spans.sort((a, b) => a.start - b.start);

  const nodes: ReactNode[] = [];
  let cursor = 0;
  spans.forEach((s, i) => {
    if (s.start > cursor) nodes.push(text.slice(cursor, s.start));
    nodes.push(
      <span
        key={`hl-${i}`}
        className="text-[var(--brand-500)] underline decoration-2 underline-offset-4"
      >
        {text.slice(s.start, s.end)}
      </span>,
    );
    cursor = s.end;
  });
  if (cursor < text.length) nodes.push(text.slice(cursor));
  return nodes;
}

/**
 * 单句「三行对译」卡（设计 plan §6.4）：
 *
 *   行1 原文（句中关键字词高亮）
 *   行2 关键字词 —— 该句没有字词则整行不渲染
 *   行3 整句翻译
 *
 * 三态：`editing`（可编辑）→ `judging`（已送出，转圈）→ `judged`（结果就地贴在各输入框下）。
 * 判后**输入框保留学生答案**（disabled），与标准答案上下并排，方便对照——这是不换页的主要收益。
 */
export default function SentenceBlock({
  sentence, value, onChange, state, result, isLast, onNext, onRetry,
}: Props) {
  const locked = state !== 'editing';
  const hasUndetermined =
    result != null && (
      result.sentence.correct === null || result.terms.some((t) => t.correct === null)
    );
  // 判题请求本身失败（网络/服务异常）时 result 为 null，同样要给「重新判题」的出口
  const showRetry = state === 'judged' && (result == null || hasUndetermined);

  const termResultOf = (term: string) => result?.terms.find((t) => t.term === term) ?? null;

  return (
    <section
      className="rounded-2xl bg-white p-5 sm:p-6"
      style={{ border: '1px solid rgba(226, 232, 240, 0.8)' }}
      aria-label={`第 ${sentence.index + 1} 句`}
    >
      <p className="text-xs font-medium text-[var(--text-secondary)]">第 {sentence.index + 1} 句</p>

      {/* 行 1：原文 */}
      <p className="mt-2 text-xl leading-loose font-bold text-[var(--text-primary)]">
        {highlightTerms(sentence.text, sentence.terms)}
      </p>

      {/* 行 2：关键字词（没有则整行不渲染） */}
      {sentence.terms.length > 0 && (
        <div className="mt-4 flex flex-col gap-3">
          {sentence.terms.map(({ term }) => {
            const r = termResultOf(term);
            return (
              <div key={term} className="flex flex-col gap-1.5">
                <label className="flex items-center gap-3">
                  <span className="w-28 shrink-0 text-sm font-bold text-[var(--text-primary)]">
                    〔{term}〕
                  </span>
                  <input
                    className={INPUT_CLASS}
                    style={FIELD_BORDER}
                    value={value.terms[term] ?? ''}
                    disabled={locked}
                    onChange={(e) => onChange({
                      ...value,
                      terms: { ...value.terms, [term]: e.target.value },
                    })}
                    placeholder="写出这个词的意思"
                  />
                </label>
                {r && (
                  <div className="pl-[7.75rem]">
                    <ItemResultLine
                      correct={r.correct}
                      method={r.method}
                      standard={r.standard}
                      comment={r.comment}
                    />
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      {/* 行 3：整句翻译 */}
      <label className="mt-4 flex flex-col gap-1.5">
        <span className="text-sm font-bold text-[var(--text-primary)]">整句翻译</span>
        <textarea
          className="w-full min-h-[88px] p-3 rounded-xl bg-white text-[var(--text-primary)] leading-loose outline-none focus:ring-2 focus:ring-[var(--brand-500)]/30 disabled:opacity-70 disabled:bg-[var(--bg-subtle)]"
          style={FIELD_BORDER}
          value={value.translation}
          disabled={locked}
          onChange={(e) => onChange({ ...value, translation: e.target.value })}
          placeholder="把这句话译成白话"
        />
      </label>
      {result && (
        <ItemResultLine
          correct={result.sentence.correct}
          method={result.sentence.method}
          standard={result.sentence.standard}
          comment={result.sentence.comment}
        />
      )}

      {/* 卡片底部：提交 / 转圈 / 重新判题 */}
      {state === 'editing' && (
        <button
          onClick={onNext}
          className="mt-5 w-full h-12 rounded-2xl text-white font-bold"
          style={{ backgroundColor: 'var(--brand-500)' }}
        >
          {isLast ? '完成本篇' : '下一句'}
        </button>
      )}
      {state === 'judging' && (
        <div className="mt-5 h-12 flex items-center justify-center gap-2">
          <Spinner />
          <span className="text-sm text-[var(--text-secondary)]">AI 正在判题…</span>
        </div>
      )}
      {state === 'judged' && result == null && (
        <p className="mt-4 text-sm text-[var(--error)]">
          判题失败（网络或服务异常），可点「重新判题」再试一次。
        </p>
      )}
      {showRetry && (
        <button
          onClick={onRetry}
          className="mt-4 h-11 px-5 rounded-2xl font-bold bg-[var(--bg-subtle)] text-[var(--text-primary)]"
        >
          重新判题
        </button>
      )}
    </section>
  );
}
