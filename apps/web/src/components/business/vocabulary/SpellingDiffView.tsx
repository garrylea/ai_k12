import type { VocabularyCharDiffOp } from '@/services/api';

interface Props {
  ops: VocabularyCharDiffOp[];
  /** 正确答案（全对时也显示一遍，方便学生对照） */
  expected: string;
}

/**
 * 中→英答错时的逐字符差异高亮：漏字母、错字母、多字母分别着色。
 *
 * 只做展示，**不参与判对错**——判对错的唯一口径在服务端（含拼写变体表）。
 */
export default function SpellingDiffView({ ops, expected }: Props) {
  return (
    <div className="mt-2 text-sm" data-testid="spelling-diff">
      <div className="flex flex-wrap items-baseline gap-1">
        <span className="text-[var(--text-secondary)]">你的拼写：</span>
        <span className="font-mono text-base">
          {ops.map((op, i) =>
            op.type === 'equal' ? (
              <span key={i} className="text-[var(--text-primary)]">{op.text}</span>
            ) : (
              <span key={i}>
                {op.actual && (
                  <span className="text-[var(--error)] line-through">{op.actual}</span>
                )}
              </span>
            ),
          )}
        </span>
      </div>
      <div className="mt-0.5 flex flex-wrap items-baseline gap-1">
        <span className="text-[var(--text-secondary)]">正确拼写：</span>
        <span className="font-mono text-base">
          {ops.map((op, i) =>
            op.type === 'equal' ? (
              <span key={i} className="text-[var(--text-primary)]">{op.text}</span>
            ) : (
              <span key={i}>
                {op.expected && (
                  <span className="font-bold text-[var(--success)]">{op.expected}</span>
                )}
              </span>
            ),
          )}
        </span>
      </div>
      {/* 差异数组为空（理论上不该发生）时兜底显示标准答案，学生至少能看到正确形式 */}
      {ops.length === 0 && (
        <div className="mt-0.5 text-[var(--text-secondary)]">应为 {expected}</div>
      )}
    </div>
  );
}
