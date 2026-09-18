import { Button } from './Button';

export interface PaginationProps {
  /** 当前页，从 1 起。 */
  page: number;
  totalPages: number;
  onChange: (page: number) => void;
}

/**
 * 「上一页 / 第 N / M 页 / 下一页」三件套。
 *
 * 为什么现在抽出来：家长端已有第 3 处需要分页（兑换记录 + 错题 + 对话回放）。
 * 注意 `RedemptionHistoryPanel.tsx` **没有**改用它——那个文件已被测试覆盖，改它属于无关重构；
 * 本组件是「同形态」的通用版，新页面用。
 *
 * 命名导出（不是 default）：基座目录（`components/base/`）全部用具名导出，`index.ts` 逐行转出。
 * 从 `./Button` 直接引入而不是从 `'.'`：避免 `index ⇄ Pagination` 循环依赖。
 */
export function Pagination({ page, totalPages, onChange }: PaginationProps) {
  return (
    <div className="flex items-center justify-between gap-3">
      <Button
        variant="ghost"
        size="sm"
        disabled={page <= 1}
        onClick={() => onChange(page - 1)}
      >
        上一页
      </Button>
      <span className="text-xs text-[var(--text-secondary)]">
        {`第 ${page} / ${totalPages} 页`}
      </span>
      <Button
        variant="ghost"
        size="sm"
        disabled={page >= totalPages}
        onClick={() => onChange(page + 1)}
      >
        下一页
      </Button>
    </div>
  );
}
