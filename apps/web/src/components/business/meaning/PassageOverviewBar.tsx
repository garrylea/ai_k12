import { useState } from 'react';
import type { MeaningSentenceItem } from '@/services/api';

interface Props {
  /** 全部句子（含 answerable:false 的——诗要完整显示） */
  sentences: MeaningSentenceItem[];
  currentIndex: number;
  judgedIndexes: Set<number>;
}

/**
 * 顶部全诗原文条。**渲染全部句子**：含义常常依赖上下文（如《行路难》末句的情感
 * 要看前面「心茫然」才知道是转振作），所以未答的句子也要看得见。
 * 当前句高亮、已答的置灰；可折叠。
 */
export default function PassageOverviewBar({ sentences, currentIndex, judgedIndexes }: Props) {
  const [open, setOpen] = useState(true);

  return (
    <div className="rounded-2xl bg-white p-4" style={{ border: '1px solid rgba(226, 232, 240, 0.8)' }}>
      <button
        onClick={() => setOpen((v) => !v)}
        className="flex items-center gap-2 text-sm font-bold text-[var(--text-primary)]"
        aria-expanded={open}
      >
        全诗原文
        <span className="text-xs font-normal text-[var(--text-secondary)]">{open ? '收起' : '展开'}</span>
      </button>

      {open && (
        <ol className="mt-3 flex flex-col gap-1.5">
          {sentences.map((s) => {
            const isCurrent = s.index === currentIndex;
            const judged = judgedIndexes.has(s.index);
            const color = isCurrent
              ? 'var(--text-primary)'
              : judged ? 'var(--text-tertiary, var(--text-secondary))' : 'var(--text-secondary)';
            return (
              <li
                key={s.index}
                className={`text-sm leading-relaxed ${isCurrent ? 'font-bold' : ''} ${judged ? 'opacity-50' : ''}`}
                style={{ color }}
              >
                {s.text}
              </li>
            );
          })}
        </ol>
      )}
    </div>
  );
}
