import { useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import ReactMarkdown from 'react-markdown';
import { autoWrapMath, normalizeAnswerMath } from './LatexPreview';
import {
  markdownRemarkPlugins,
  markdownRemarkPluginsWithBreaks,
  markdownRehypePlugins,
  markdownComponents,
  makeAnswerComponents,
  preprocessMarkdown,
} from '@/components/markdown';
import { MaterialBlock } from './answer/MaterialBlock';
import { materialSlots } from './answer/materialPlacement';
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
  /** 无参考答案（method='no_standard_answer'）：不判对错、不计分、不要求自评 */
  unscored?: boolean;
}

interface Props {
  questions: PracticeQuestion[];
  answers: Record<string, AnswerRecord>;
  onClose: () => void;
  /** 插入在头部与列表之间的内容（考试结果页的得分卡等）。 */
  headerExtra?: ReactNode;
  /** 底部操作栏左侧扩展动作；考试结果页不传。 */
  footerExtra?: ReactNode;
  /** 批量拉取的解析（父层末题后调 getTrainingExplanations 获得），key = q.n；缺省 {} */
  initialExplanations?: Record<string, string | null>;
  /** 主观题参考答案（key = q.n；考试结果页传，训练结果页不传——自评时已看过） */
  referenceAnswers?: Record<string, string | null>;
  /** 结果页自评提交（考试结果页传）；返回后父层更新 answers 消除 needsSelfAssess */
  onSelfAssess?: (n: string, assessment: 'correct' | 'incorrect') => Promise<void>;
  /** 结果页导出当前题单为 PDF（专项/错题页传；考试结果页不传） */
  onExport?: () => void;
}

/**
 * 学生答案专用 components（作答大图）。
 * 模块级常量：渲染里现造组件表会让 <img> 每次重挂、反复下载。
 * 只用于「你的答案」这一处 —— 题面/参考答案/解析仍用题面小图样式。
 */
const answerComponents = makeAnswerComponents();

export function AnswerResultList({
  questions,
  answers,
  onClose,
  headerExtra,
  footerExtra,
  initialExplanations = {},
  referenceAnswers,
  onSelfAssess,
  onExport,
}: Props) {
  const [expandedN, setExpandedN] = useState<string | null>(null);
  // 解析缓存：初值来自父层末题后批量拉取；父层后续补拉时合并。
  const [explanations, setExplanations] = useState<Record<string, string | null>>(initialExplanations);
  const [assessingN, setAssessingN] = useState<string | null>(null);

  // 父层异步补拉（如考试结果页 mount 后补拉）到达时合并：只接受非空值，
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

  const handleSelfAssess = async (n: string, assessment: 'correct' | 'incorrect') => {
    if (!onSelfAssess || assessingN) return;
    setAssessingN(n);
    try {
      await onSelfAssess(n, assessment);
    } finally {
      setAssessingN(null);
    }
  };

  // 统计口径：unscored（无参考答案）不进任何对/错/主观/未判定计数，
  // 否则 974 卷 35 道无答案题会被算成 35 道错题。
  const failedCount = questions.filter(q => answers[q.n]?.failed).length;
  const unscoredCount = questions.filter(q => answers[q.n]?.unscored).length;
  const subjectiveCount = questions.filter(q => {
    const r = answers[q.n];
    return !!r && !r.unscored && (r.method === 'self_assess' || r.needsSelfAssess || r.method === 'unanswered');
  }).length;
  const correctCount = questions.filter(q => {
    const r = answers[q.n];
    return !!r && !r.unscored && r.isCorrect && !r.failed && r.method !== 'self_assess' && !r.needsSelfAssess && r.method !== 'unanswered';
  }).length;
  const wrongCount = questions.length - correctCount - failedCount - subjectiveCount - unscoredCount;

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
            {unscoredCount > 0 && (
              <div className="flex items-center gap-1.5">
                <span className="w-2 h-2 rounded-full bg-[var(--text-tertiary)]" />
                <span className="text-[13px] text-[var(--text-secondary)]">无参考答案 {unscoredCount} 题</span>
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
              const rec = a;
              const unscored = rec?.unscored === true;
              const subjective = !unscored && (!!rec?.needsSelfAssess || rec?.method === 'self_assess');
              const noAnswer = !unscored && rec?.method === 'unanswered';
              const objectiveWrong = !correct && !noAnswer && !unscored;
              const showExplanationButton = !failed && !!explanation && (subjective || objectiveWrong);
              const showReferenceButton = !failed && subjective && !explanation && !!referenceAnswers?.[q.n];
              const slots = materialSlots(q);
              return (
                <div key={q.n} className="bg-[var(--bg-card)] rounded-xl border border-[var(--bg-subtle)] overflow-hidden">
                  <div className="p-3.5 flex items-start gap-3">
                    {/* Status icon */}
                    <div className={`shrink-0 w-6 h-6 rounded-full flex items-center justify-center mt-0.5 ${failed || unscored ? 'bg-[var(--bg-subtle)]' : subjective || noAnswer ? 'bg-[var(--brand-100)]' : correct ? 'bg-[#E8F5EE]' : 'bg-[#FCE8E6]'}`}>
                      {failed ? (
                        <svg aria-hidden="true" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="var(--text-tertiary)" strokeWidth="3" strokeLinecap="round">
                          <line x1="5" y1="12" x2="19" y2="12" />
                        </svg>
                      ) : unscored ? (
                        <svg aria-hidden="true" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="var(--text-tertiary)" strokeWidth="2.5" strokeLinecap="round">
                          <circle cx="12" cy="12" r="8" />
                          <path d="M8 12h8" />
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
                      {/* 材料位置固定规则：文章（material_url）在题干上方；题中素材（material_text）在题干下方 */}
                      <MaterialBlock
                        url={q.materialUrl}
                        text={slots.above}
                        variant="result"
                        testId="result-material"
                      />
                      <div className="text-sm font-medium text-[var(--text-primary)] leading-[1.6]">
                        <ReactMarkdown remarkPlugins={markdownRemarkPlugins} rehypePlugins={markdownRehypePlugins} components={markdownComponents}>
                          {preprocessMarkdown(q.text)}
                        </ReactMarkdown>
                      </div>
                      <MaterialBlock
                        url={null}
                        text={slots.below}
                        variant="result"
                        testId="result-material-text"
                      />
                      <div className="mt-2 px-3 py-2 bg-[var(--bg-base)] rounded-lg">
                        <span className="text-xs text-[var(--text-tertiary)]">你的答案：</span>
                        {a?.studentAnswer ? (
                          <div className="text-[13px] text-[var(--text-primary)] leading-[1.6]">
                            <ReactMarkdown remarkPlugins={markdownRemarkPluginsWithBreaks} rehypePlugins={markdownRehypePlugins} components={answerComponents}>
                              {preprocessMarkdown(autoWrapMath(a.studentAnswer))}
                            </ReactMarkdown>
                          </div>
                        ) : (
                          <span className="text-[13px] text-[var(--text-tertiary)]">（未作答）</span>
                        )}
                      </div>
                      {/* 主观题：无对错状态；自评按钮独立于解析是否存在 */}
                      {subjective && !failed && (
                        <div className="mt-2.5 flex flex-col gap-2">
                          {rec?.selfAssessment && (
                            <div className="flex items-center gap-2">
                              <span className="text-xs text-[var(--text-tertiary)]">已自评：{rec.selfAssessment === 'correct' ? '做对了' : '做错了'}</span>
                            </div>
                          )}
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
                      {/* 无参考答案：不判对错、不计分、无自评按钮 */}
                      {unscored && !failed && (
                        <div className="mt-2.5">
                          <span className="text-xs text-[var(--text-tertiary)]">无参考答案 · 不计分</span>
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
                      {/* 解析：只展示题库中已有内容；不等待生成，也不提供刷新。 */}
                      {(showExplanationButton || showReferenceButton) && (
                        <div className="mt-2.5 flex items-center gap-2">
                          <button
                            onClick={() => setExpandedN(expanded ? null : q.n)}
                            className="px-4 py-1.5 rounded-lg border border-[var(--warning)] bg-[var(--brand-100)] text-[var(--warning)] text-xs font-medium hover:bg-[var(--warning)] hover:text-white transition-colors"
                          >
                            {expanded
                              ? (showExplanationButton ? '收起解析' : '收起参考答案')
                              : (showExplanationButton ? '查看解析' : '查看参考答案')}
                          </button>
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
                          {/* 与「你的答案」同口径：保留换行 + 裸 LaTeX 自动补 $（题库答案多为一行一步） */}
                          <ReactMarkdown remarkPlugins={markdownRemarkPluginsWithBreaks} rehypePlugins={markdownRehypePlugins} components={markdownComponents}>
                            {preprocessMarkdown(normalizeAnswerMath(referenceAnswers[q.n]!))}
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
                          <ReactMarkdown remarkPlugins={markdownRemarkPluginsWithBreaks} rehypePlugins={markdownRehypePlugins} components={markdownComponents}>
                            {preprocessMarkdown(normalizeAnswerMath(explanation))}
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
        <div
          data-testid="answer-result-footer"
          className={`shrink-0 px-5 py-3 border-t border-[var(--bg-subtle)] flex flex-wrap items-center gap-3 ${
            footerExtra ? 'justify-between' : 'justify-center'
          }`}
        >
          {footerExtra && <div className="min-w-0">{footerExtra}</div>}
          <div className="ml-auto flex items-center justify-center gap-3">
            {onExport && (
              <button
                onClick={onExport}
                className="px-5 py-2.5 rounded-[10px] border border-[var(--bg-subtle)] text-sm font-semibold text-[var(--text-secondary)] hover:bg-[var(--bg-base)] transition-colors"
              >
                导出 PDF
              </button>
            )}
            <button
              onClick={onClose}
              className="px-8 py-2.5 rounded-[10px] bg-[var(--brand-500)] text-white text-sm font-semibold hover:bg-[var(--brand-600)] transition-colors shadow-sm"
            >
              确认
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
