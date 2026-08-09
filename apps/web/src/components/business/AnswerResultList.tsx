import { useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkMath from 'remark-math';
import remarkGfm from 'remark-gfm';
import rehypeKatex from 'rehype-katex';
import 'katex/dist/katex.min.css';
import type { PracticeQuestion } from './AnswerModal';

interface AnswerRecord {
  isCorrect: boolean;
  method: string;
  analysis: string | null;
  errorType?: string | null;
  studentAnswer: string;
  /** 判定失败（超时/服务异常）的前端标记 */
  failed?: boolean;
}

interface Props {
  questions: PracticeQuestion[];
  answers: Record<string, AnswerRecord>;
  onRetry: () => void;
}

export function AnswerResultList({ questions, answers, onRetry }: Props) {
  const [expandedN, setExpandedN] = useState<string | null>(null);

  const failedCount = questions.filter(q => answers[q.n]?.failed).length;
  const correctCount = questions.filter(q => answers[q.n]?.isCorrect && !answers[q.n]?.failed).length;
  const wrongCount = questions.length - correctCount - failedCount;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40" role="dialog" aria-modal="true">
      <div className="w-[92vw] max-w-2xl max-h-[80vh] flex flex-col bg-[var(--bg-card)] rounded-2xl shadow-xl overflow-hidden">

        {/* ═══ Header: title + stats ═══ */}
        <div className="shrink-0 px-5 py-4 border-b border-[var(--bg-subtle)] flex items-center justify-between">
          <h2 className="text-[17px] font-bold text-[var(--text-primary)]">答题结果</h2>
          <div className="flex gap-4">
            <div className="flex items-center gap-1.5">
              <span className="w-2 h-2 rounded-full bg-[var(--success)]" />
              <span className="text-[13px] text-[var(--text-secondary)]">对 {correctCount}</span>
            </div>
            <div className="flex items-center gap-1.5">
              <span className="w-2 h-2 rounded-full bg-[var(--error)]" />
              <span className="text-[13px] text-[var(--text-secondary)]">错 {wrongCount}</span>
            </div>
            {failedCount > 0 && (
              <div className="flex items-center gap-1.5">
                <span className="w-2 h-2 rounded-full bg-[var(--text-tertiary)]" />
                <span className="text-[13px] text-[var(--text-secondary)]">未判定 {failedCount}</span>
              </div>
            )}
          </div>
        </div>

        {/* ═══ List ═══ */}
        <div className="flex-1 overflow-auto p-3">
          <div className="flex flex-col gap-2.5">
            {questions.map(q => {
              const a = answers[q.n];
              const failed = a?.failed;
              const correct = !!a?.isCorrect && !failed;
              const expanded = expandedN === q.n;
              return (
                <div key={q.n} className="bg-[var(--bg-card)] rounded-xl border border-[var(--bg-subtle)] overflow-hidden">
                  <div className="p-3.5 flex items-start gap-3">
                    {/* Status icon */}
                    <div className={`shrink-0 w-6 h-6 rounded-full flex items-center justify-center mt-0.5 ${failed ? 'bg-[var(--bg-subtle)]' : correct ? 'bg-[#E8F5EE]' : 'bg-[#FCE8E6]'}`}>
                      {failed ? (
                        <svg aria-hidden="true" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="var(--text-tertiary)" strokeWidth="3" strokeLinecap="round">
                          <line x1="5" y1="12" x2="19" y2="12" />
                        </svg>
                      ) : correct ? (
                        <svg aria-hidden="true" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="var(--success)" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
                          <polyline points="20 6 9 17 4 12" />
                        </svg>
                      ) : (
                        <svg aria-hidden="true" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="var(--error)" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
                          <line x1="18" y1="6" x2="6" y2="18" />
                          <line x1="6" y1="6" x2="18" y2="18" />
                        </svg>
                      )}
                    </div>
                    {/* Content */}
                    <div className="flex-1 min-w-0">
                      <div className="text-sm font-medium text-[var(--text-primary)] leading-[1.6]">
                        <ReactMarkdown remarkPlugins={[remarkMath, remarkGfm]} rehypePlugins={[rehypeKatex]}>
                          {q.text}
                        </ReactMarkdown>
                      </div>
                      <div className="mt-2 px-3 py-2 bg-[var(--bg-base)] rounded-lg">
                        <span className="text-xs text-[var(--text-tertiary)]">你的答案：</span>
                        <span className="text-[13px] text-[var(--text-primary)] font-mono">{a?.studentAnswer || '（未作答）'}</span>
                      </div>
                      {/* 判定失败提示 */}
                      {failed && (
                        <div className="mt-2 px-3 py-2 bg-[var(--bg-base)] rounded-lg">
                          <span className="text-xs text-[var(--text-tertiary)]">AI 判定失败，请稍后重试</span>
                        </div>
                      )}
                      {/* 查看解析 button (wrong only, non-failed) */}
                      {!correct && !failed && a?.analysis && (
                        <button
                          onClick={() => setExpandedN(expanded ? null : q.n)}
                          className="mt-2.5 px-4 py-1.5 rounded-lg border border-[var(--warning)] bg-[var(--brand-100)] text-[var(--warning)] text-xs font-medium hover:bg-[var(--warning)] hover:text-white transition-colors"
                        >
                          {expanded ? '收起解析' : '查看解析'}
                        </button>
                      )}
                    </div>
                  </div>
                  {/* Expanded analysis */}
                  {expanded && !correct && !failed && a?.analysis && (
                    <div className="px-4 pb-3.5 pl-[50px]">
                      <div className="p-3.5 bg-[var(--brand-100)] rounded-[10px] border-l-[3px] border-[var(--warning)]">
                        {a.errorType && (
                          <div className="text-xs font-semibold text-[var(--warning)] mb-1.5">错因：{a.errorType}</div>
                        )}
                        <div className="text-[13px] text-[var(--text-primary)] leading-[1.7]">
                          <ReactMarkdown remarkPlugins={[remarkMath, remarkGfm]} rehypePlugins={[rehypeKatex]}>
                            {a.analysis}
                          </ReactMarkdown>
                        </div>
                      </div>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </div>

        {/* ═══ Footer ═══ */}
        <div className="shrink-0 px-5 py-3 border-t border-[var(--bg-subtle)] flex justify-center">
          <button
            onClick={onRetry}
            className="px-8 py-2.5 rounded-[10px] bg-[var(--brand-500)] text-white text-sm font-semibold hover:bg-[var(--brand-600)] transition-colors shadow-sm"
          >
            完成
          </button>
        </div>
      </div>
    </div>
  );
}
