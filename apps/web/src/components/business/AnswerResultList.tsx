import { useState } from 'react';
import type { PracticeQuestion } from './AnswerModal';

interface AnswerRecord {
  isCorrect: boolean;
  method: string;
  analysis: string | null;
  errorType?: string | null;
  studentAnswer: string;
}

interface Props {
  questions: PracticeQuestion[];
  answers: Record<string, AnswerRecord>;
  onRetry: () => void;
}

export function AnswerResultList({ questions, answers, onRetry }: Props) {
  const [openN, setOpenN] = useState<string | null>(null);
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40">
      <div className="w-[92vw] max-w-2xl max-h-[80vh] overflow-auto bg-[var(--bg-card)] rounded-2xl shadow-xl p-6">
        <h2 className="text-lg font-bold mb-4 text-[var(--text-primary)]">答题结果</h2>
        <ul className="space-y-2">
          {questions.map(q => {
            const a = answers[q.n];
            const correct = a?.isCorrect;
            return (
              <li key={q.n} className="flex items-center gap-3 p-3 rounded-lg border border-[var(--bg-subtle)]">
                <span className="text-sm text-[var(--text-primary)] flex-1 truncate">{q.text.slice(0, 40)}</span>
                <span className={correct ? 'text-green-600 font-semibold' : 'text-red-600 font-semibold'}>
                  {correct ? '✓ 对' : '✗ 错'}
                </span>
                {!correct && (
                  <button
                    onClick={() => setOpenN(openN === q.n ? null : q.n)}
                    className="text-xs px-2 py-1 rounded bg-[var(--brand-500)] text-white"
                  >
                    解析
                  </button>
                )}
              </li>
            );
          })}
        </ul>
        {openN !== null && answers[openN]?.analysis && (
          <div className="mt-3 p-3 rounded-lg bg-[var(--bg-subtle)] text-sm text-[var(--text-primary)] whitespace-pre-wrap">
            {answers[openN].analysis}
          </div>
        )}
        <div className="mt-6 flex justify-end">
          <button
            onClick={onRetry}
            className="px-6 py-2 rounded-[var(--radius-button)] bg-[var(--brand-500)] text-white"
          >
            完成
          </button>
        </div>
      </div>
    </div>
  );
}
