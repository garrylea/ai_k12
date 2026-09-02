// apps/web/src/components/business/answer/ChoiceOptionList.tsx
import ReactMarkdown from 'react-markdown';
import remarkMath from 'remark-math';
import remarkGfm from 'remark-gfm';
import rehypeKatex from 'rehype-katex';

interface ChoiceOption { label: string; text: string }

interface Props {
  options: ChoiceOption[];
  value: string;
  onChange: (label: string) => void;
  disabled?: boolean;
}

/** 选择题点选作答：线性边框选项卡，点选高亮 brand 色，提交字母 label。
 *  样式遵循 CleanupPhase 的答题卡规范（--learn-* 变量、无 emoji、圆角卡片）。 */
export function ChoiceOptionList({ options, value, onChange, disabled = false }: Props) {
  return (
    <div className="flex flex-col gap-3 p-4" role="radiogroup" aria-label="选项">
      {options.map((opt) => {
        const selected = value === opt.label;
        return (
          <button
            key={opt.label}
            type="button"
            role="radio"
            aria-checked={selected}
            disabled={disabled}
            onClick={() => onChange(opt.label)}
            className={`flex items-start gap-3 p-4 rounded-xl border text-left transition-colors ${
              selected
                ? 'border-[var(--brand-500)] bg-[var(--brand-100)]'
                : 'border-[var(--learn-card-border)] hover:border-[var(--brand-500)]/40'
            } ${disabled ? 'cursor-not-allowed opacity-60' : ''}`}
          >
            <span
              className={`shrink-0 w-7 h-7 rounded-full border flex items-center justify-center text-sm font-bold ${
                selected
                  ? 'border-[var(--brand-500)] bg-[var(--brand-500)] text-white'
                  : 'border-[var(--bg-subtle)] text-[var(--text-secondary)]'
              }`}
            >
              {opt.label}
            </span>
            <span className="flex-1 text-[15px] leading-relaxed text-[var(--text-primary)] [&>p]:my-0">
              <ReactMarkdown remarkPlugins={[remarkMath, remarkGfm]} rehypePlugins={[rehypeKatex]}>
                {opt.text}
              </ReactMarkdown>
            </span>
          </button>
        );
      })}
    </div>
  );
}
