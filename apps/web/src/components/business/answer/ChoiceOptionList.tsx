// apps/web/src/components/business/answer/ChoiceOptionList.tsx
import ReactMarkdown from 'react-markdown';
import {
  markdownRemarkPlugins,
  markdownRehypePlugins,
  preprocessMarkdown,
  MarkdownImg,
} from '@/components/markdown';

interface ChoiceOption { label: string; text: string }

interface Props {
  options: ChoiceOption[];
  value: string;
  onChange: (label: string) => void;
  disabled?: boolean;
}

// 自定义 img：选项里的图片用 inline-block 小尺寸（固定 30px 高），补 /assets/ 前缀 +
// 加载失败隐藏。选择题选项图通常是小图标/小图形，inline-block 让图文混排；不分桶。
const optionMarkdownComponents = {
  img: (props: { src?: string; alt?: string }) => (
    <MarkdownImg {...props} className="inline-block my-2 max-w-full h-[30px] object-contain rounded-lg align-middle" />
  ),
};

/** 选择题点选作答：线性边框选项卡，点选高亮 brand 色，提交字母 label。
 *  样式遵循 CleanupPhase 的答题卡规范（--learn-* 变量、无 emoji、圆角卡片）。 */
export function ChoiceOptionList({ options, value, onChange, disabled = false }: Props) {
  return (
    <div className="flex flex-col gap-2 p-3" role="radiogroup" aria-label="选项">
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
            className={`flex items-start gap-2 p-3 rounded-xl border text-left transition-colors ${
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
              <ReactMarkdown remarkPlugins={markdownRemarkPlugins} rehypePlugins={markdownRehypePlugins} components={optionMarkdownComponents}>
                {preprocessMarkdown(opt.text)}
              </ReactMarkdown>
            </span>
          </button>
        );
      })}
    </div>
  );
}
