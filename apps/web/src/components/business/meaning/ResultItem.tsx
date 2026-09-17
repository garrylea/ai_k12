import type { MeaningPartResult, MeaningTermResultItem } from '@/services/api';
import type { StackItem } from './types';

interface Props {
  item: StackItem;
  /** 是否是栈里最新的一条（由 ResultStack 按 index === 0 传入） */
  isNewest: boolean;
  onRetry: (sentenceIndex: number) => void;
}

/** 线性 SVG（无 emoji，符合 style.md）。 */
const CheckIcon = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"
    strokeLinecap="round" strokeLinejoin="round" className="w-4 h-4 shrink-0" aria-hidden="true">
    <path d="M4 12.5 9.5 18 20 6.5" />
  </svg>
);

const CrossIcon = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"
    strokeLinecap="round" strokeLinejoin="round" className="w-4 h-4 shrink-0" aria-hidden="true">
    <path d="M6 6l12 12M18 6L6 18" />
  </svg>
);

const DashIcon = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"
    strokeLinecap="round" strokeLinejoin="round" className="w-4 h-4 shrink-0" aria-hidden="true">
    <path d="M6 12h12" />
  </svg>
);

/** 重试：逆时针回转箭头（线性 SVG，无 emoji）。 */
const RetryIcon = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"
    strokeLinecap="round" strokeLinejoin="round" className="w-4 h-4" aria-hidden="true">
    <path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8" />
    <path d="M3 3v5h5" />
  </svg>
);

/**
 * 标准答案兜底：`toKeyTerms` 把缺失的 `gloss` 降级成 `''`，直接渲染会剩下
 * 「应为：」这种悬空标签。题库本来就可能没有标准释义，明说比留白好。
 *
 * **只用于判错分支**——判对时标准答案只是补充信息，题库没有就不渲染这一行
 * （见 `StandardLine`）。
 */
const standardOf = (standard: string) => (standard.trim() !== '' ? standard : '（题库无标准释义）');

/**
 * 判对时的标准答案行：灰字，缩进与「你的：」对齐。
 * 题库没有标准答案时**整行不渲染**——判对已经给了结论，不必再摆一个空标签。
 */
const StandardLine = ({ standard }: { standard: string }) =>
  standard.trim() === '' ? null : (
    <p className="mt-0.5 pl-[22px] text-sm text-[var(--text-secondary)]">标准：{standard}</p>
  );

/** 单块（含义 / 情感）的结果行：勾=正确（附灰字标准）/ 叉=错误（附你的 vs 标准）/ 横杠=未判定。 */
function PartLine({ label, part, mine }: { label: string; part: MeaningPartResult; mine: string }) {
  if (part.correct === true) {
    return (
      <div className="mt-1">
        <p className="flex items-center gap-1.5 text-sm text-[var(--success)]">
          <CheckIcon />{label}：正确
        </p>
        <StandardLine standard={part.standard} />
      </div>
    );
  }
  if (part.correct === null) {
    return (
      <p className="mt-1 flex items-start gap-1.5 text-sm text-[var(--text-secondary)]">
        <span className="mt-0.5"><DashIcon /></span>
        <span>{label}：未判定（AI 暂时没判出来，可点右上角的重试图标）</span>
      </p>
    );
  }
  return (
    <div className="mt-1">
      <p className="flex items-start gap-1.5 text-sm text-[var(--error)]">
        <span className="mt-0.5"><CrossIcon /></span>
        <span>{label}：{part.method === 'unanswered' ? '未作答，应为：' : '错误，应为：'}{standardOf(part.standard)}</span>
      </p>
      {mine.trim() !== '' && (
        <p className="mt-1 pl-[22px] text-sm text-[var(--text-secondary)]">你的：{mine}</p>
      )}
      {part.comment && (
        <p className="mt-1 pl-[22px] text-sm text-[var(--text-secondary)]">{part.comment}</p>
      )}
    </div>
  );
}

/** 字词项的结果行——多个字词各一行。 */
function TermLines({ items }: { items: MeaningTermResultItem[] }) {
  if (items.length === 0) return null;   // 该句无重点字词 → 整行不渲染
  return (
    <div className="mt-1">
      {items.map((t) => (
        <div key={t.term}>
          {t.correct === true && (
            <div>
              <p className="flex items-center gap-1.5 text-sm text-[var(--success)]">
                <CheckIcon />〔{t.term}〕正确
              </p>
              <StandardLine standard={t.standard} />
            </div>
          )}
          {t.correct === null && (
            <p className="flex items-center gap-1.5 text-sm text-[var(--text-secondary)]">
              <DashIcon />〔{t.term}〕未判定
            </p>
          )}
          {t.correct === false && (
            <div>
              <p className="flex items-start gap-1.5 text-sm text-[var(--error)]">
                <span className="mt-0.5"><CrossIcon /></span>
                <span>〔{t.term}〕{t.method === 'unanswered' ? '未作答，应为：' : '应为：'}{standardOf(t.standard)}</span>
              </p>
              {t.comment && (
                <p className="mt-1 pl-[22px] text-sm text-[var(--text-secondary)]">{t.comment}</p>
              )}
            </div>
          )}
        </div>
      ))}
    </div>
  );
}

/** 结果栈里的单条。**最新的一条**（数组 index 0）左侧有 brand 色竖条。 */
export default function ResultItem({ item, isNewest, onRetry }: Props) {
  return (
    <div
      className="rounded-2xl bg-white p-4"
      style={{
        border: '1px solid rgba(226, 232, 240, 0.8)',
        borderLeft: isNewest ? '3px solid var(--brand-500)' : undefined,
      }}
    >
      <div className="flex items-baseline justify-between gap-3">
        <span className="text-xs text-[var(--text-secondary)]">第 {item.sentenceIndex + 1} 句</span>
        {/* 图标按钮：视觉无文字，可访问名仍是「重新判题」（读屏与测试都按它找） */}
        <button
          type="button"
          onClick={() => onRetry(item.sentenceIndex)}
          aria-label="重新判题"
          title="重新判题"
          className="text-[var(--brand-500)] transition-opacity hover:opacity-70"
        >
          <RetryIcon />
        </button>
      </div>
      <p className="mt-1 text-sm text-[var(--text-primary)]">{item.text}</p>

      {item.kind === 'pending' && (
        <p className="mt-2 text-sm text-[var(--text-secondary)]">判定中…</p>
      )}

      {item.kind === 'failed' && (
        <p className="mt-2 text-sm text-[var(--error)]">判定失败，请点右上角的重试图标再试一次</p>
      )}

      {item.kind === 'judged' && (
        <div className="mt-2">
          <TermLines items={item.result.terms} />
          <PartLine label="深层含义" part={item.result.meaning} mine={item.answer.meaning} />
          <PartLine label="作者情感" part={item.result.emotion} mine={item.answer.emotion} />
        </div>
      )}
    </div>
  );
}
