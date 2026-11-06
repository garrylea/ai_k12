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
  /** 多选题：可同时选多个，value 是「按字母排序的选中集合」（如 "BD"）。 */
  multiple?: boolean;
  /** 判断题：选项只有「对/错」，用图形（绿勾/红叉）代替文字，避免 label 与 text 重复出现两次。 */
  trueFalse?: boolean;
}

// 自定义 img：选项里的图片 inline-block，最高 140px（原先 30px 太小，看不清图选项），补 /assets/ 前缀 +
// 加载失败隐藏。选择题选项图通常是小图标/小图形，inline-block 让图文混排；不分桶。
const optionMarkdownComponents = {
  img: (props: { src?: string; alt?: string }) => (
    <MarkdownImg {...props} className="inline-block my-2 max-w-full max-h-[140px] w-auto object-contain rounded-lg align-middle" />
  ),
};

/** 线性图标（不用 emoji）：对勾 / 叉。 */
function CheckIcon() {
  return (
    <svg width="30" height="30" viewBox="0 0 24 24" fill="none" stroke="currentColor"
      strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <polyline points="20 6 9 17 4 12" />
    </svg>
  );
}

function CrossIcon() {
  return (
    <svg width="30" height="30" viewBox="0 0 24 24" fill="none" stroke="currentColor"
      strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <line x1="6" y1="6" x2="18" y2="18" />
      <line x1="18" y1="6" x2="6" y2="18" />
    </svg>
  );
}

/** 选择题点选作答：线性边框选项卡，点选高亮 brand 色，提交字母 label。
 *  多选题（multiple）按字母集合作答，value 形如 "BD"。
 *  判断题（trueFalse）只用绿勾 / 红叉表达，不再重复写「对/错」两个字。
 *  样式遵循 CleanupPhase 的答题卡规范（--learn-* 变量、无 emoji、圆角卡片）。 */
export function ChoiceOptionList({
  options, value, onChange, disabled = false, multiple = false, trueFalse = false,
}: Props) {
  const selectedSet = multiple ? new Set(value.split('')) : null;

  if (trueFalse) {
    return (
      <div className="flex gap-3 p-3" role="radiogroup" aria-label="判断">
        {options.map((opt) => {
          const selected = value === opt.label;
          const isYes = ['对', '正确'].includes(opt.label) || ['对', '正确'].includes(opt.text.trim());
          const tone = isYes ? 'var(--success)' : 'var(--error)';
          const tint = isYes ? '#E8F5EE' : '#FCE8E6';
          return (
            <button
              key={opt.label}
              type="button"
              role="radio"
              aria-checked={selected}
              aria-label={isYes ? '对' : '错'}
              title={isYes ? '对' : '错'}
              disabled={disabled}
              onClick={() => onChange(opt.label)}
              className={`flex-1 h-16 rounded-xl border flex items-center justify-center transition-colors ${
                selected ? 'border-current' : 'border-[var(--learn-card-border)] hover:border-current'
              } ${disabled ? 'cursor-not-allowed opacity-60' : ''}`}
              style={{
                color: tone,
                backgroundColor: selected ? tint : 'transparent',
              }}
            >
              {isYes ? <CheckIcon /> : <CrossIcon />}
            </button>
          );
        })}
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-2 p-3" role={multiple ? 'group' : 'radiogroup'} aria-label="选项">
      {options.map((opt) => {
        const selected = multiple ? selectedSet!.has(opt.label) : value === opt.label;
        return (
          <button
            key={opt.label}
            type="button"
            role={multiple ? 'checkbox' : 'radio'}
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
