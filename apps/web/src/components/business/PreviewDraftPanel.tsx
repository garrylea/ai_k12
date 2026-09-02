import { useState } from 'react';
import { LatexPreview } from './LatexPreview';
import { DraftWhiteboard } from './DraftWhiteboard';

type Tab = 'preview' | 'draft';

interface Props {
  answer: string;
  questionId: string;
  /** 仅数学学科启用草稿白板（PRD §7.12） */
  enabled: boolean;
}

export function PreviewDraftPanel({ answer, questionId, enabled }: Props) {
  const [tab, setTab] = useState<Tab>('preview');

  if (!enabled) {
    return <LatexPreview value={answer} />;
  }

  const tabBtn = (t: Tab, label: string) => (
    <button
      onClick={() => setTab(t)}
      aria-pressed={tab === t}
      className={`px-3 h-9 text-sm rounded-lg transition-colors ${
        tab === t
          ? 'bg-[var(--brand-100)] text-[var(--brand-500)] font-medium'
          : 'text-[var(--text-tertiary)] hover:bg-[var(--bg-subtle)]'
      }`}
    >
      {label}
    </button>
  );

  return (
    <div className="h-full flex flex-col">
      <div className="shrink-0 flex items-center gap-1 px-3 pt-2 border-b border-[var(--bg-subtle)]">
        {tabBtn('preview', '预览')}
        {tabBtn('draft', '草稿')}
      </div>
      <div className="flex-1 min-h-0">
        {tab === 'preview' ? <LatexPreview value={answer} /> : <DraftWhiteboard questionId={questionId} />}
      </div>
    </div>
  );
}
