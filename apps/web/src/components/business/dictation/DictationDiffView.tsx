import type { DictationDiffOp } from '@/services/api';

interface Props {
  ops: DictationDiffOp[];
  className?: string;
}

/**
 * 正文逐字差异展示：正确字符为默认色，错字/漏字标红，多字标橙并带删除线。
 * 差异以「忽略标点与空格」后的文本对比（与判对错口径一致，设计 spec §5）。
 */
export default function DictationDiffView({ ops, className = '' }: Props) {
  return (
    <p className={`text-lg leading-loose tracking-wide text-[var(--text-primary)] ${className}`}>
      {ops.map((op, i) => {
        if (op.type === 'equal') {
          return <span key={i}>{op.text}</span>;
        }
        if (op.type === 'wrong') {
          return (
            <span key={i} className="inline-flex items-baseline">
              <span className="text-[var(--error)] font-bold underline decoration-wavy">{op.actual}</span>
              <span className="mx-0.5 text-xs text-[var(--text-secondary)]">应为</span>
              <span className="text-[var(--success)] font-bold">{op.expected}</span>
            </span>
          );
        }
        if (op.type === 'missing') {
          return (
            <span key={i} className="text-[var(--error)] font-bold">
              <span className="text-xs text-[var(--text-secondary)] mr-0.5">漏</span>
              {op.text}
            </span>
          );
        }
        return (
          <span key={i} className="text-[var(--warning)] line-through">
            <span className="text-xs text-[var(--text-secondary)] mr-0.5 no-underline">多</span>
            {op.text}
          </span>
        );
      })}
    </p>
  );
}
