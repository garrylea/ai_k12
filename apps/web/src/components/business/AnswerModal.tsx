import { useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkMath from 'remark-math';
import remarkGfm from 'remark-gfm';
import rehypeKatex from 'rehype-katex';
import 'katex/dist/katex.min.css';
import { LatexEditor } from './LatexEditor';
import { LatexPreview } from './LatexPreview';

export interface PracticeQuestion { n: number; text: string; }

interface Props {
  questions: PracticeQuestion[];
  startIndex: number;
  onSubmit: (questionText: string, studentAnswer: string) => Promise<{
    isCorrect: boolean; method: string; analysis: string | null; errorType?: string | null;
  }>;
  onFinish: () => void;       // 全部做完
  onClose: () => void;
}

export function AnswerModal({ questions, startIndex, onSubmit, onFinish, onClose }: Props) {
  const [idx, setIdx] = useState(startIndex);
  const [answer, setAnswer] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const q = questions[idx];

  const handleSubmit = async () => {
    if (!answer.trim() || submitting) return;
    setSubmitting(true);
    setError(null);
    try {
      await onSubmit(q.text, answer);
      setAnswer('');
      if (idx + 1 < questions.length) {
        setIdx(idx + 1);
      } else {
        onFinish();
      }
    } catch (e: any) {
      setError(e?.message || '判对错失败，请重试');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40" role="dialog" aria-modal="true">
      <div className="w-[92vw] max-w-5xl h-[88vh] bg-[var(--bg-card)] rounded-2xl shadow-xl flex flex-col overflow-hidden">
        {/* 顶部：题面 */}
        <div className="shrink-0 h-[32%] overflow-auto p-5 border-b border-[var(--bg-subtle)]">
          <div className="text-xs text-[var(--text-secondary)] mb-2">第 {idx + 1} / {questions.length} 题</div>
          <div className="prose prose-sm max-w-none text-[var(--text-primary)]">
            <ReactMarkdown remarkPlugins={[remarkMath, remarkGfm]} rehypePlugins={[rehypeKatex]}>
              {q.text}
            </ReactMarkdown>
          </div>
        </div>
        {/* 下部：左编辑 右预览 */}
        <div className="flex-1 min-h-0 flex">
          <div className="w-1/2 border-r border-[var(--bg-subtle)] flex flex-col">
            <LatexEditor value={answer} onChange={setAnswer} />
          </div>
          <div className="w-1/2">
            <LatexPreview value={answer} />
          </div>
        </div>
        {/* 底部：提交 */}
        <div className="shrink-0 flex items-center justify-between p-3 border-t border-[var(--bg-subtle)]">
          <button onClick={onClose} className="text-sm text-[var(--text-secondary)] hover:text-[var(--text-primary)]">退出</button>
          {error && <span className="text-sm text-red-500">{error}</span>}
          <button
            onClick={handleSubmit}
            disabled={!answer.trim() || submitting}
            className="px-8 py-2.5 rounded-[var(--radius-button)] bg-[var(--brand-500)] text-white font-medium disabled:opacity-40 hover:bg-[var(--brand-600)]"
          >
            {submitting ? '判对错中…' : '提交'}
          </button>
        </div>
      </div>
    </div>
  );
}
