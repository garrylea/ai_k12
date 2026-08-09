import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import ReactMarkdown from 'react-markdown';
import remarkMath from 'remark-math';
import remarkGfm from 'remark-gfm';
import rehypeKatex from 'rehype-katex';
import 'katex/dist/katex.min.css';
import { LatexEditor } from './LatexEditor';
import { LatexPreview } from './LatexPreview';
import { toast } from '@/components/base';

export interface PracticeQuestion { n: string; text: string; }

interface Props {
  questions: PracticeQuestion[];
  startIndex: number;
  cardId: number;
  lessonId: number;
  onSubmit: (questionText: string, studentAnswer: string) => Promise<{
    isCorrect: boolean; method: string; analysis: string | null; errorType?: string | null;
  }>;
  onFinish: () => void;
  onClose: () => void;
}

export function AnswerModal({ questions, startIndex, cardId, lessonId, onSubmit, onFinish, onClose }: Props) {
  const navigate = useNavigate();
  const [idx, setIdx] = useState(startIndex);
  const [answer, setAnswer] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [showHint, setShowHint] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const q = questions[idx];

  const handleSubmit = async () => {
    if (!answer.trim() || submitting) return;
    setSubmitting(true);
    setError(null);
    try {
      const res = await onSubmit(q.text, answer);
      if (res.isCorrect) {
        toast('success', '正确');
      } else {
        toast('error', '错误，已加入错题本');
      }
      setAnswer('');
      setShowHint(false);
      // 1.5s 后自动切题
      setTimeout(() => {
        if (idx + 1 < questions.length) {
          setIdx(idx + 1);
        } else {
          onFinish();
        }
      }, 1500);
    } catch (e: any) {
      setError(e?.message || '判对错失败，请重试');
    } finally {
      setSubmitting(false);
    }
  };

  const handleDiscuss = () => {
    onClose();
    navigate('/student/ai-discuss', { state: { cardId, lessonId } });
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40" role="dialog" aria-modal="true">
      <div className="w-[92vw] max-w-5xl h-[88vh] bg-[var(--bg-card)] rounded-2xl shadow-xl flex flex-col overflow-hidden">

        {/* ═══ 顶部：题面 + 提示/讨论图标 ═══ */}
        <div className="shrink-0 p-4 border-b border-[var(--bg-subtle)]">
          <div className="flex gap-3">
            {/* 题目区 */}
            <div className="flex-1 min-w-0">
              <div className="text-xs text-[var(--text-tertiary)] font-medium mb-2">
                第 {idx + 1} / {questions.length} 题
              </div>
              <div className="text-[15px] font-bold text-[var(--text-primary)] leading-[1.7]">
                <ReactMarkdown remarkPlugins={[remarkMath, remarkGfm]} rehypePlugins={[rehypeKatex]}>
                  {q.text}
                </ReactMarkdown>
              </div>
            </div>
            {/* 右侧图标按钮列 */}
            <div className="flex flex-col gap-2 shrink-0">
              {/* 提示 */}
              <button
                onClick={() => setShowHint(!showHint)}
                className="w-[38px] h-[38px] rounded-xl border border-[var(--bg-subtle)] bg-[var(--bg-card)] flex items-center justify-center text-[var(--warning)] shadow-sm hover:bg-[#FFF8F0] transition-colors"
                title="提示"
                aria-label="提示"
              >
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <circle cx="12" cy="12" r="10" />
                  <path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3" />
                  <line x1="12" y1="17" x2="12.01" y2="17" />
                </svg>
              </button>
              {/* 让 AI 讲一讲 */}
              <button
                onClick={handleDiscuss}
                className="w-[38px] h-[38px] rounded-xl border border-[var(--bg-subtle)] bg-[var(--bg-card)] flex items-center justify-center text-[var(--info)] shadow-sm hover:bg-[#F0F5FA] transition-colors"
                title="让 AI 讲一讲"
                aria-label="让 AI 讲一讲"
              >
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
                </svg>
              </button>
            </div>
          </div>
          {/* 提示抽屉 */}
          {showHint && (
            <div className="mt-3 p-3 rounded-lg bg-[#FFF8F0] border-l-[3px] border-[var(--warning)]">
              <p className="text-sm text-[var(--text-primary)] leading-relaxed">
                仔细审题，从已知条件出发，逐步推理。如果需要更多帮助，可以点击右侧「让 AI 讲一讲」。
              </p>
            </div>
          )}
        </div>

        {/* ═══ 中部：左编辑 右预览 ═══ */}
        <div className="flex-1 min-h-0 flex">
          <div className="w-1/2 border-r border-[var(--bg-subtle)] flex flex-col">
            <LatexEditor value={answer} onChange={setAnswer} />
          </div>
          <div className="w-1/2">
            <LatexPreview value={answer} />
          </div>
        </div>

        {/* ═══ 底部：关闭（左）+ 提交（右） ═══ */}
        <div className="shrink-0 flex items-center justify-between p-3 border-t border-[var(--bg-subtle)]">
          {/* 关闭 */}
          <button
            onClick={onClose}
            className="w-10 h-10 rounded-full border border-[var(--bg-subtle)] bg-[var(--bg-card)] flex items-center justify-center text-[var(--text-tertiary)] hover:bg-[var(--bg-base)] transition-colors"
            title="关闭"
            aria-label="关闭"
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
              <line x1="18" y1="6" x2="6" y2="18" />
              <line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </button>
          {/* 错误提示 */}
          {error && <span className="text-sm text-[var(--error)]">{error}</span>}
          {/* 提交 */}
          <button
            onClick={handleSubmit}
            disabled={!answer.trim() || submitting}
            className="w-12 h-12 rounded-full bg-[var(--brand-500)] text-white flex items-center justify-center disabled:opacity-40 hover:bg-[var(--brand-600)] transition-all shadow-md"
            title="提交"
            aria-label="提交"
          >
            {submitting ? (
              <svg className="animate-spin" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                <path d="M21 12a9 9 0 1 1-6.219-8.56" />
              </svg>
            ) : (
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <line x1="22" y1="2" x2="11" y2="13" />
                <polygon points="22 2 15 22 11 13 2 9 22 2" />
              </svg>
            )}
          </button>
        </div>
      </div>
    </div>
  );
}
