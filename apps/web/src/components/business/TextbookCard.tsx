import { useState } from 'react';
import { Button } from '@/components/base';

interface TextbookCardProps {
  content: string;
  currentPage: number;
  totalPages: number;
  chapterBreadcrumb: string;
  onPrev: () => void;
  onNext: () => void;
  onDiscuss: () => void;
}

export function TextbookCard({
  content,
  currentPage,
  totalPages,
  chapterBreadcrumb,
  onPrev,
  onNext,
  onDiscuss,
}: TextbookCardProps) {
  const [selectedText, setSelectedText] = useState('');

  const handleMouseUp = () => {
    const sel = window.getSelection();
    if (sel && sel.toString().trim().length > 0) {
      setSelectedText(sel.toString().trim());
    } else {
      setSelectedText('');
    }
  };

  return (
    <div className="relative flex flex-col h-full student-theme-container">
      {/* 顶部面包屑 + 页码 */}
      <div className="flex items-center justify-between px-6 py-3 bg-[var(--bg-subtle)] rounded-t-[var(--radius-card)]">
        <span className="text-sm text-[var(--text-secondary)]">{chapterBreadcrumb}</span>
        <span className="text-sm font-medium text-[var(--text-tertiary)]">
          {currentPage} / {totalPages}
        </span>
      </div>

      {/* 教材卡片内容 */}
      <div
        className="flex-1 overflow-y-auto px-8 py-6 bg-[var(--bg-card)]"
        onMouseUp={handleMouseUp}
      >
        <div
          className="text-[var(--text-primary)]"
          style={{
            fontSize: 'var(--fs-textbook)',
            lineHeight: 'var(--lh-textbook)',
          }}
          dangerouslySetInnerHTML={{ __html: content }}
        />
      </div>

      {/* 选中文字快捷讨论 */}
      {selectedText && (
        <div className="absolute left-1/2 -translate-x-1/2 bottom-24 z-10">
          <Button size="sm" onClick={() => { onDiscuss(); setSelectedText(''); }}>
            讨论：" {selectedText.slice(0, 15)}{selectedText.length > 15 ? '...' : ''}"
          </Button>
        </div>
      )}

      {/* 底部固定操作栏 */}
      <div className="flex items-center justify-between px-6 py-4 bg-[var(--bg-card)] border-t border-[var(--bg-subtle)] rounded-b-[var(--radius-card)]">
        <Button variant="ghost" size="md" onClick={onPrev} disabled={currentPage <= 1}>
          上一页
        </Button>
        <Button variant="primary" size="lg" onClick={onDiscuss} className="px-8">
          讨论
        </Button>
        <Button variant="ghost" size="md" onClick={onNext} disabled={currentPage >= totalPages}>
          下一页
        </Button>
      </div>
    </div>
  );
}
