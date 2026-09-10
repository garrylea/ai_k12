import { useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import ReactMarkdown from 'react-markdown';
import { autoWrapMath } from './LatexPreview';
import {
  markdownRemarkPlugins,
  markdownRemarkPluginsWithBreaks,
  markdownRehypePlugins,
  markdownComponents,
  preprocessMarkdown,
} from '@/components/markdown';
import type { PracticeQuestion } from './AnswerModal';

interface AnswerRecord {
  isCorrect: boolean;
  method: string;
  analysis?: string | null;
  errorType?: string | null;
  studentAnswer: string;
  /** 判定失败（超时/服务异常）的前端标记 */
  failed?: boolean;
  /** 主观题待自评（考试结果页）：渲染自评按钮 */
  needsSelfAssess?: boolean;
  /** 已有自评结果（重进结果页恢复）：'correct' | 'incorrect' */
  selfAssessment?: 'correct' | 'incorrect' | null;
}

interface Props {
  questions: PracticeQuestion[];
  answers: Record<string, AnswerRecord>;
  onClose: () => void;
  /** 插入在头部与列表之间的内容（考试结果页的得分卡等）。 */
  headerExtra?: ReactNode;
  /** 批量拉取的解析（父层末题后调 getTrainingExplanations 获得），key = q.n；缺省 {} */
  initialExplanations?: Record<string, string | null>;
  /** q.n -> 题库 questionId（孤儿题返回 null，不渲染刷新按钮）。 */
  questionIdOf?: (n: string) => number | null;
  /** 单题刷新等待（父层注入 waitTrainingExplanation），120s 倒计时。 */
  onWaitExplanation?: (questionId: number) => Promise<string | null>;
  /** 主观题参考答案（key = q.n；考试结果页传，训练结果页不传——自评时已看过） */
  referenceAnswers?: Record<string, string | null>;
  /** 结果页自评提交（考试结果页传）；返回后父层更新 answers 消除 needsSelfAssess */
  onSelfAssess?: (n: string, assessment: 'correct' | 'incorrect') => Promise<void>;
}

/** 刷新等待上限（秒），与后端 explanation-wait 端点 120s 对齐。 */
const REFRESH_TIMEOUT_SECONDS = 120;

function formatCountdown(s: number): string {
  const m = Math.floor(s / 60);
  const sec = String(s % 60).padStart(2, '0');
  return `${m}:${sec}`;
}

export function AnswerResultList({
  questions,
  answers,
  onClose,
  headerExtra,
  initialExplanations = {},
  questionIdOf,
  onWaitExplanation,
  referenceAnswers,
  onSelfAssess,
}: Props) {
  const [expandedN, setExpandedN] = useState<string | null>(null);
  // 解析缓存：初值来自父层末题后批量拉取；单题刷新后回写。
  const [explanations, setExplanations] = useState<Record<string, string | null>>(initialExplanations);
  const [refreshingN, setRefreshingN] = useState<string | null>(null);
  const [countdown, setCountdown] = useState<number | null>(null);
  const [assessingN, setAssessingN] = useState<string | null>(null);

  // 刷新倒计时（mm:ss），请求返回即停。
  useEffect(() => {
    if (countdown == null) return;
    const t = setInterval(() => setCountdown((c) => (c == null || c <= 1 ? null : c - 1)), 1000);
    return () => clearInterval(t);
  }, [countdown]);

  // 父层异步补拉（如考试结果页 mount 后等 in-flight）到达时合并：只接受非空值，
  // 不覆盖已展示/已刷新的解析。父层须 memoize/set-once 保持引用稳定，避免每渲染重置。
  useEffect(() => {
    setExplanations((prev) => {
      const next = { ...prev };
      let changed = false;
      for (const [k, v] of Object.entries(initialExplanations)) {
        if (v != null && next[k] !== v) {
          next[k] = v;
          changed = true;
        }
      }
      return changed ? next : prev;
    });
  }, [initialExplanations]);

  const handleRefresh = async (q: PracticeQuestion) => {
    if (!onWaitExplanation || refreshingN) return;
    const qid = questionIdOf?.(q.n) ?? null;
    if (qid == null) return;
    setRefreshingN(q.n);
    setCountdown(REFRESH_TIMEOUT_SECONDS);
    try {
      const text = await onWaitExplanation(qid);
      setExplanations((prev) => ({ ...prev, [q.n]: text }));
    } finally {
      setRefreshingN(null);
      setCountdown(null);
    }
  };

  const handleSelfAssess = async (n: string, assessment: 'correct' | 'incorrect') => {
    if (!onSelfAssess || assessingN) return;
    setAssessingN(n);
    try {
      await onSelfAssess(n, assessment);
    } finally {
      setAssessingN(null);
    }
  };

  const failedCount = questions.filter(q => answers[q.n]?.failed).length;
  const subjectiveCount = questions.filter(q => answers[q.n]?.method === 'self_assess' || answers[q.n]?.needsSelfAssess || answers[q.n]?.method === 'unanswered').length;
  const correctCount = questions.filter(q => answers[q.n]?.isCorrect && !answers[q.n]?.failed && answers[q.n]?.method !== 'self_assess' && !answers[q.n]?.needsSelfAssess && answers[q.n]?.method !== 'unanswered').length;
  const wrongCount = questions.length - correctCount - failedCount - subjectiveCount;

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
            {subjectiveCount > 0 && (
              <div className="flex items-center gap-1.5">
                <span className="w-2 h-2 rounded-full bg-[var(--brand-500)]" />
                <span className="text-[13px] text-[var(--text-secondary)]">主观 {subjectiveCount}</span>
              </div>
            )}
          </div>
        </div>

        {headerExtra && (
          <div className="shrink-0 border-b border-[var(--bg-subtle)]">{headerExtra}</div>
        )}

        {/* ═══ List ═══ */}
        <div className="flex-1 overflow-auto p-3">
          <div className="flex flex-col gap-2.5">
            {questions.map(q => {
              const a = answers[q.n];
              const failed = a?.failed;
              const correct = !!a?.isCorrect && !failed;
              const expanded = expandedN === q.n;
              const explanation = explanations[q.n] ?? null;
              const hasQuestionId = (questionIdOf?.(q.n) ?? null) != null;
              const rec = a;
              const subjective = !!rec?.needsSelfAssess || rec?.method === 'self_assess';
              const noAnswer = rec?.method === 'unanswered';
              return (
                <div key={q.n} className="bg-[var(--bg-card)] rounded-xl border border-[var(--bg-subtle)] overflow-hidden">
                  <div className="p-3.5 flex items-start gap-3">
                    {/* Status icon */}
                    <div className={`shrink-0 w-6 h-6 rounded-full flex items-center justify-center mt-0.5 ${failed ? 'bg-[var(--bg-subtle)]' : subjective || noAnswer ? 'bg-[var(--brand-100)]' : correct ? 'bg-[#E8F5EE]' : 'bg-[#FCE8E6]'}`}>
                      {failed ? (
                        <svg aria-hidden="true" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="var(--text-tertiary)" strokeWidth="3" strokeLinecap="round">
                          <line x1="5" y1="12" x2="19" y2="12" />
                        </svg>
                      ) : subjective || noAnswer ? (
                        <svg aria-hidden="true" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="var(--brand-500)" strokeWidth="2.5" strokeLinecap="round">
                          <circle cx="12" cy="12" r="8" />
                          <path d="M12 8v4" />
                          <path d="M12 16h.01" />
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
                        <ReactMarkdown remarkPlugins={markdownRemarkPlugins} rehypePlugins={markdownRehypePlugins} components={markdownComponents}>
                          {preprocessMarkdown(q.text)}
                        </ReactMarkdown>
                      </div>
                      <div className="mt-2 px-3 py-2 bg-[var(--bg-base)] rounded-lg">
                        <span className="text-xs text-[var(--text-tertiary)]">你的答案：</span>
                        {a?.studentAnswer ? (
                          <div className="text-[13px] text-[var(--text-primary)] leading-[1.6]">
                            <ReactMarkdown remarkPlugins={markdownRemarkPluginsWithBreaks} rehypePlugins={markdownRehypePlugins} components={markdownComponents}>
                              {preprocessMarkdown(autoWrapMath(a.studentAnswer))}
                            </ReactMarkdown>
                          </div>
                        ) : (
                          <span className="text-[13px] text-[var(--text-tertiary)]">（未作答）</span>
                        )}
                      </div>
                      {/* 主观题：无对错状态；参考答案/解析展开 + （待自评时）自评按钮 */}
                      {subjective && !failed && (
                        <div className="mt-2.5 flex flex-col gap-2">
                          <div className="flex items-center gap-2">
                            <button
                              onClick={() => setExpandedN(expanded ? null : q.n)}
                              className="px-4 py-1.5 rounded-lg border border-[var(--warning)] bg-[var(--brand-100)] text-[var(--warning)] text-xs font-medium hover:bg-[var(--warning)] hover:text-white transition-colors"
                            >
                              {expanded ? '收起解析' : '查看解析'}
                            </button>
                            {rec?.selfAssessment && (
                              <span className="text-xs text-[var(--text-tertiary)]">已自评：{rec.selfAssessment === 'correct' ? '做对了' : '做错了'}</span>
                            )}
                          </div>
                          {rec?.needsSelfAssess && onSelfAssess && (
                            <div className="flex items-center gap-2">
                              <span className="text-xs text-[var(--text-secondary)]">对照参考答案，这题你做对了还是做错了？</span>
                              <button
                                onClick={() => void handleSelfAssess(q.n, 'incorrect')}
                                disabled={assessingN != null}
                                className="px-3 py-1.5 rounded-lg border border-[var(--error)] text-[var(--error)] text-xs font-medium hover:bg-[#FCE8E6] transition-colors disabled:opacity-40"
                              >
                                我做错了
                              </button>
                              <button
                                onClick={() => void handleSelfAssess(q.n, 'correct')}
                                disabled={assessingN != null}
                                className="px-3 py-1.5 rounded-lg border border-[var(--success)] text-[var(--success)] text-xs font-medium hover:bg-[#E8F5EE] transition-colors disabled:opacity-40"
                              >
                                我做对了
                              </button>
                            </div>
                          )}
                        </div>
                      )}
                      {/* 空答案守卫：不计对错 */}
                      {noAnswer && !failed && !subjective && (
                        <div className="mt-2.5">
                          <span className="text-xs text-[var(--text-tertiary)]">该题暂无标准答案，不计入对错</span>
                        </div>
                      )}
                      {/* 判定失败提示 */}
                      {failed && (
                        <div className="mt-2 px-3 py-2 bg-[var(--bg-base)] rounded-lg">
                          <span className="text-xs text-[var(--text-tertiary)]">AI 判定失败，请稍后重试</span>
                        </div>
                      )}
                      {/* 解析（wrong only, non-failed）：有解析看解析 / 无解析有 questionId 可刷新 / 孤儿题暂无 */}
                      {!correct && !failed && !subjective && !noAnswer && (
                        <div className="mt-2.5 flex items-center gap-2">
                          {explanation ? (
                            <button
                              onClick={() => setExpandedN(expanded ? null : q.n)}
                              className="px-4 py-1.5 rounded-lg border border-[var(--warning)] bg-[var(--brand-100)] text-[var(--warning)] text-xs font-medium hover:bg-[var(--warning)] hover:text-white transition-colors"
                            >
                              {expanded ? '收起解析' : '查看解析'}
                            </button>
                          ) : hasQuestionId ? (
                            <>
                              <span className="text-xs text-[var(--text-tertiary)]">正在生成中…</span>
                              <button
                                onClick={() => handleRefresh(q)}
                                disabled={refreshingN != null}
                                className="px-3 py-1.5 rounded-lg border border-[var(--warning)] text-[var(--warning)] text-xs font-medium hover:bg-[var(--warning)] hover:text-white transition-colors disabled:opacity-40"
                                aria-label="刷新解析"
                              >
                                {refreshingN === q.n && countdown != null ? formatCountdown(countdown) : '刷新'}
                              </button>
                            </>
                          ) : (
                            <span className="text-xs text-[var(--text-tertiary)]">暂无解析，试试让 AI 讲一讲</span>
                          )}
                        </div>
                      )}
                    </div>
                  </div>
                  {/* 主观题展开：参考答案在上 */}
                  {expanded && subjective && referenceAnswers?.[q.n] && (
                    <div className="px-4 pb-1 pt-3.5 pl-[50px]">
                      <div className="p-3.5 bg-[var(--bg-base)] rounded-[10px]">
                        <div className="text-xs font-semibold text-[var(--text-tertiary)] mb-1.5">参考答案</div>
                        <div className="text-[13px] text-[var(--text-primary)] leading-[1.7]">
                          <ReactMarkdown remarkPlugins={markdownRemarkPlugins} rehypePlugins={markdownRehypePlugins} components={markdownComponents}>
                            {preprocessMarkdown(referenceAnswers[q.n]!)}
                          </ReactMarkdown>
                        </div>
                      </div>
                    </div>
                  )}
                  {/* Expanded explanation */}
                  {expanded && !failed && (subjective ? !!explanation : (!correct && explanation)) && (
                    <div className="px-4 pb-3.5 pl-[50px]">
                      <div className="p-3.5 bg-[var(--brand-100)] rounded-[10px] border-l-[3px] border-[var(--warning)]">
                        {a.errorType && (
                          <div className="text-xs font-semibold text-[var(--warning)] mb-1.5">错因：{a.errorType}</div>
                        )}
                        <div className="text-[13px] text-[var(--text-primary)] leading-[1.7]">
                          <ReactMarkdown remarkPlugins={markdownRemarkPlugins} rehypePlugins={markdownRehypePlugins} components={markdownComponents}>
                            {preprocessMarkdown(explanation)}
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
            onClick={onClose}
            className="px-8 py-2.5 rounded-[10px] bg-[var(--brand-500)] text-white text-sm font-semibold hover:bg-[var(--brand-600)] transition-colors shadow-sm"
          >
            确认
          </button>
        </div>
      </div>
    </div>
  );
}
