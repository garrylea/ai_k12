import type { StackItem } from './types';
import ResultItem from './ResultItem';

interface Props {
  items: StackItem[];
  onRetry: (sentenceIndex: number) => void;
}

/**
 * 作答结果栈。**按数组顺序渲染** —— 新项由调用方 unshift 进头部，
 * 所以数组头部（最新一次）自然渲染在最前面（设计 spec §7.3「倒序」）。
 */
export default function ResultStack({ items, onRetry }: Props) {
  if (items.length === 0) {
    return <p className="text-sm text-[var(--text-secondary)]">还没有作答记录</p>;
  }
  return (
    <div className="flex flex-col gap-3">
      {items.map((item, i) => (
        <ResultItem key={item.key} item={item} isNewest={i === 0} onRetry={onRetry} />
      ))}
    </div>
  );
}
