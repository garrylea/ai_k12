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
          // 不包 inline-flex：wrong 可能是后端合并出的多字长串（如 expected:'AB', actual:'C'），
          // inline-flex 会变成不可换行的原子盒而横向溢出；顺序内联 span 可自然折行。
          return (
            <span key={i}>
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
        // 「多」标签必须放在被删除线穿过的 span **外面**：text-decoration:none 无法撤销
        // 祖先传播下来的 line-through，放在里面会被一并划掉。
        return (
          <span key={i}>
            <span className="text-xs text-[var(--text-secondary)] mr-0.5">多</span>
            <span className="text-[var(--warning)] line-through">{op.text}</span>
          </span>
        );
      })}
    </p>
  );
}
