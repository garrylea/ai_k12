import type { InterpretationMethod } from '@/services/api';

interface Props {
  correct: boolean | null;
  method: InterpretationMethod;
  /** 标准答案（释义或译文）。**只在判题响应里才有**——判之前不渲染本组件。 */
  standard: string;
  comment: string | null;
}

/** 线性 SVG 勾（无 emoji，符合 style.md）。 */
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
    strokeLinecap="round" className="w-4 h-4 shrink-0" aria-hidden="true">
    <path d="M6 12h12" />
  </svg>
);

/**
 * 单项结果行（字词项与整句项共用）：✓ 正确 / ✗ 错误（附标准答案）/ — 未判定。
 *
 * 三种 `correct` 状态与后端 `method` 的对应关系（后端 §4.4）：
 *   true          → exact / ai
 *   false         → exact / ai / unanswered（unanswered 文案不同：「未作答」）
 *   null          → undetermined（模型没判出来，只此一种）
 */
export default function ItemResultLine({ correct, method, standard, comment }: Props) {
  if (correct === true) {
    return (
      <p className="mt-1.5 flex items-center gap-1.5 text-sm text-[var(--success)]">
        <CheckIcon />
        正确
      </p>
    );
  }

  if (correct === null) {
    return (
      <p className="mt-1.5 flex items-start gap-1.5 text-sm text-[var(--text-secondary)]">
        <span className="mt-0.5"><DashIcon /></span>
        <span>未判定（AI 暂时没判出来，可点「重新判题」）</span>
      </p>
    );
  }

  return (
    <div className="mt-1.5">
      <p className="flex items-start gap-1.5 text-sm text-[var(--error)]">
        <span className="mt-0.5"><CrossIcon /></span>
        <span>{method === 'unanswered' ? '未作答，应为：' : '错误，应为：'}{standard}</span>
      </p>
      {comment && (
        <p className="mt-1 pl-[22px] text-sm text-[var(--text-secondary)]">{comment}</p>
      )}
    </div>
  );
}
