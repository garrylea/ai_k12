// AnswerModal：主线课后作业答题弹窗——答题核心已收敛到 QuestionRunner（variant='modal'），
// 本组件只保留父层职责（对外 props 签名不变）：
//   - 判题进度追踪 + 逐题进度页外壳（judgingSlot 注入）
//   - 「让 AI 讲一讲」入口（headerActions）+ DiscussDrawer（modalExtras）
//   - 关闭抑制 onFinish（cancelledRef，放弃等待后不弹结果页）
import { useRef, useState } from 'react';
import { QuestionRunner } from './answer/QuestionRunner';
import type { RunnerJudgeOutcome, RunnerQuestion } from './answer/types';
import { DiscussDrawer, DiscussIconButton } from './DiscussDrawer';

export interface PracticeQuestion { n: string; text: string; }

/** 单题判题状态：等待 / 判题中 / 已判完 / 判定失败（进度页外壳用，key = q.n） */
type JudgeStatus = 'pending' | 'judging' | 'done' | 'failed';

interface Props {
  questions: PracticeQuestion[];
  startIndex: number;
  cardId: number;
  lessonId: number;
  subjectId: number;
  /** 提示缓存（key = 复合题号 q.n）：session 内命中即直显，省一次后端请求 */
  hints: Record<string, string>;
  onSubmit: (questionText: string, studentAnswer: string, n: string) => Promise<{
    isCorrect: boolean; method: string; analysis?: string | null; errorType?: string | null;
  }>;
  /** 拉取提示：父层调 /practice/hint（后端查 cards.hints 缓存，未命中 AI 生成并写回）并 setHint 入 store */
  onRequestHint: (questionText: string, n: string) => Promise<void>;
  onFinish: () => void;
  onClose: () => void;
}

export function AnswerModal({ questions, startIndex, cardId, lessonId, subjectId, hints, onSubmit, onRequestHint, onFinish, onClose }: Props) {
  // 判题进度（key = q.n）：提交标 judging、resolve 后 done/failed——经 onSubmit 包装驱动，
  // fire-and-forget 语义不变（QuestionRunner 不 await）。
  const [progress, setProgress] = useState<Record<string, JudgeStatus>>(() =>
    Object.fromEntries(questions.map((q) => [q.n, 'pending' as const])));
  // 「让 AI 讲一讲」抽屉：打开时锚定当时题面（DiscussDrawer 需题面文本创建 mainline 对话）。
  const [discussQ, setDiscussQ] = useState<RunnerQuestion | null>(null);
  // 关闭（含判题等待态「放弃等待」）后抑制 onFinish——结果页不再弹出。
  const cancelledRef = useRef(false);

  const handleClose = () => {
    cancelledRef.current = true;
    onClose();
  };

  const handleRunnerSubmit = async (q: RunnerQuestion, studentAnswer: string): Promise<RunnerJudgeOutcome> => {
    setProgress((p) => ({ ...p, [q.n]: 'judging' }));
    try {
      const res = await onSubmit(q.text, studentAnswer, q.n);
      setProgress((p) => ({ ...p, [q.n]: 'done' }));
      return res;
    } catch (err) {
      setProgress((p) => ({ ...p, [q.n]: 'failed' }));
      throw err;
    }
  };

  const handleRequestHint = async (q: RunnerQuestion): Promise<string> => {
    await onRequestHint(q.text, q.n);
    return hints[q.n] ?? '';
  };

  const doneCount = Object.values(progress).filter((s) => s === 'done' || s === 'failed').length;

  // ═══ 判题进度页外壳（父层保留，judgingSlot 注入 QuestionRunner）═══
  const judgingSlot = (
    <div className="w-full max-w-xl self-center flex-1 min-h-0 flex flex-col bg-[var(--learn-card-bg)] rounded-2xl shadow-xl overflow-hidden">
      <div className="p-6 flex flex-col items-center">
        {/* 旋转图标 */}
        <svg className="animate-spin text-[var(--brand-500)] mb-4" width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
          <path d="M21 12a9 9 0 1 1-6.219-8.56" />
        </svg>
        <h2 className="text-lg font-bold text-[var(--text-primary)]">AI 正在判题，请稍候</h2>
        <p className="text-sm text-[var(--text-tertiary)] mt-1.5">
          已完成 {doneCount} / {questions.length} 题
        </p>
      </div>
      {/* 逐题进度 */}
      <div className="flex-1 overflow-auto px-5 pb-5">
        <div className="flex flex-col gap-2">
          {questions.map((qi, i) => {
            const st = progress[qi.n] ?? 'pending';
            return (
              <div key={`${qi.n}-${i}`} className="flex items-center gap-3 px-3 py-2.5 rounded-lg bg-[var(--bg-base)]">
                <div className="shrink-0 w-5 h-5 flex items-center justify-center">
                  {st === 'judging' ? (
                    <svg className="animate-spin text-[var(--brand-500)]" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                      <path d="M21 12a9 9 0 1 1-6.219-8.56" />
                    </svg>
                  ) : st === 'done' ? (
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="var(--text-secondary)">
                      <circle cx="12" cy="12" r="6" />
                    </svg>
                  ) : st === 'failed' ? (
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="var(--text-tertiary)" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                      <line x1="18" y1="6" x2="6" y2="18" />
                      <line x1="6" y1="6" x2="18" y2="18" />
                    </svg>
                  ) : (
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="var(--bg-subtle)" strokeWidth="2.5">
                      <circle cx="12" cy="12" r="6" />
                    </svg>
                  )}
                </div>
                <span className="text-xs text-[var(--text-tertiary)] font-medium shrink-0">第 {i + 1} 题</span>
                <span className={`text-sm ${st === 'failed' ? 'text-[var(--text-tertiary)]' : 'text-[var(--text-secondary)]'}`}>
                  {st === 'judging' ? '判题中…' : st === 'done' ? '已判完' : st === 'failed' ? '判定失败' : '等待中'}
                </span>
              </div>
            );
          })}
        </div>
      </div>
      {/* 关闭（放弃等待） */}
      <div className="shrink-0 flex justify-center p-3 border-t border-[var(--bg-subtle)]">
        <button
          onClick={handleClose}
          className="px-6 py-2 rounded-lg border border-[var(--bg-subtle)] text-[var(--text-tertiary)] text-sm hover:bg-[var(--bg-base)] transition-colors"
        >
          关闭
        </button>
      </div>
    </div>
  );

  return (
    <QuestionRunner
      questions={questions}
      subjectId={subjectId}
      draftKeyPrefix={`card-${cardId}-q`}
      variant="modal"
      enableHint
      hints={hints}
      onRequestHint={handleRequestHint}
      startIndex={startIndex}
      showPrevButton={false}
      onClose={handleClose}
      headerActions={(q) => (
        <DiscussIconButton onClick={() => setDiscussQ(q)} />
      )}
      judgingSlot={judgingSlot}
      modalExtras={discussQ && (
        <DiscussDrawer
          mode="question"
          cardId={cardId}
          questionText={discussQ.text}
          subjectId={subjectId}
          lessonId={lessonId}
          onClose={() => setDiscussQ(null)}
        />
      )}
      onSubmit={handleRunnerSubmit}
      onFinish={() => {
        if (!cancelledRef.current) onFinish();
      }}
    />
  );
}
