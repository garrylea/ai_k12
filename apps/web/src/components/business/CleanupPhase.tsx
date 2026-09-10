// CleanupPhase：错题清零阶段——答题核心已收敛到 QuestionRunner（variant='embedded'），
// 本组件只保留父层职责（对外 props 不变）：
//   - 4 态状态机（answering/judging/allClear/hasErrors；judging 覆盖 bumpErrorLevels 窗口）
//   - bump 逻辑（仍错题递增级别）+ 庆祝页 + AnswerResultList
import { useCallback, useEffect, useMemo, useState } from 'react';
import { motion } from 'framer-motion';
import { QuestionRunner } from './answer/QuestionRunner';
import type { RunnerAnswerRecord, RunnerQuestion } from './answer/types';
import { AnswerResultList } from './AnswerResultList';
import type { PracticeQuestion } from './AnswerModal';
import {
  judgePractice,
  bumpErrorLevels,
  getTrainingExplanations,
  selfAssessPractice,
  waitTrainingExplanation,
  type PreviousErrorDetail,
  type JudgeResult,
} from '@/services/api';

type Phase = 'answering' | 'judging' | 'allClear' | 'hasErrors';

interface Props {
  errors: PreviousErrorDetail[];
  lessonId: number;
  subjectId: number;
  onComplete: (allCleared: boolean) => void;
}

const SPINNER_SVG = (
  <svg className="animate-spin text-[var(--brand-500)]" width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
    <path d="M21 12a9 9 0 1 1-6.219-8.56" />
  </svg>
);

const CheckCircleIcon = ({ className }: { className?: string }) => (
  <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <circle cx="12" cy="12" r="10" />
    <polyline points="9 12 12 15 16 10" />
  </svg>
);

export function CleanupPhase({ errors, lessonId, subjectId, onComplete }: Props) {
  const [phase, setPhase] = useState<Phase>('answering');
  const [countdown, setCountdown] = useState(5);
  const [finalResults, setFinalResults] = useState<Record<string, RunnerAnswerRecord> | null>(null);
  // 结果页错题解析：末题后批量拉取（key = questionN）；孤儿题（questionId null）无解析不拉
  const [explanations, setExplanations] = useState<Record<string, string | null>>({});

  const questions: PracticeQuestion[] = errors.map((e) => ({
    n: e.questionN,
    text: e.questionText,
  }));

  // q.n -> 错题记录：onSubmit 需要 error.cardId / lessonId。questionN 可能跨卡撞号，
  // 优先按题面文本精确匹配，取不到再回退首条。
  const errorsByN = useMemo(() => {
    const m = new Map<string, PreviousErrorDetail[]>();
    for (const e of errors) {
      const list = m.get(e.questionN) ?? [];
      list.push(e);
      m.set(e.questionN, list);
    }
    return m;
  }, [errors]);

  // 庆祝倒计时
  useEffect(() => {
    if (phase !== 'allClear') return;
    if (countdown <= 0) {
      onComplete(true);
      return;
    }
    const t = setInterval(() => setCountdown((c) => c - 1), 1000);
    return () => clearInterval(t);
  }, [phase, countdown, onComplete]);

  const handleSubmit = useCallback(async (q: RunnerQuestion, studentAnswer: string): Promise<JudgeResult> => {
    const candidates = errorsByN.get(q.n) ?? [];
    const error = candidates.find((e) => e.questionText === q.text) ?? candidates[0];
    if (!error) throw new Error('错题记录缺失');

    return judgePractice({
      cardId: error.cardId,
      // 必须写错题来源卡「真正所属的课」：清零阶段会清到其他课的错题，
      // 若传当前页 lessonId，practice_results.lesson_id 会与卡片所属课不一致，
      // 导致课程级「重置课堂练习」（按 lesson_id 删）漏删该卡记录。取不到时回退当前页。
      lessonId: error.lessonId ?? lessonId,
      subjectId,
      questionN: error.questionN,
      questionText: error.questionText,
      studentAnswer,
    });
  }, [errorsByN, lessonId, subjectId]);

  const handleFinish = useCallback(async (results: Record<string, RunnerAnswerRecord>) => {
    // 判题 Promise 已由 QuestionRunner 等待完毕；judging 态覆盖下方 bumpErrorLevels 窗口
    setPhase('judging');

    // 统计仍错的题
    const stillWrongIds: number[] = [];
    for (const err of errors) {
      const a = results[err.questionN];
      if (a && !a.isCorrect && !a.failed) {
        stillWrongIds.push(err.errorBookId);
      }
    }

    // 递增仍错题的级别
    if (stillWrongIds.length > 0) {
      try {
        await bumpErrorLevels(stillWrongIds);
      } catch { /* best-effort */ }
    }

    // 错题批量拉解析（后端等 in-flight 生成，60s 兜底）：孤儿题（questionId null）无解析不拉。
    // 客观题答错 + 主观题（self_assess，无论自评对错）都要解析。
    const wrongQids: number[] = [];
    for (const e of errors) {
      const a = results[e.questionN];
      if (e.questionId == null || !a || a.failed) continue;
      if (!a.isCorrect || a.method === 'self_assess') wrongQids.push(e.questionId);
    }
    let expls: Record<number, string | null> = {};
    if (wrongQids.length > 0) {
      try {
        expls = (await getTrainingExplanations(wrongQids)).explanations;
      } catch { /* 拉取失败：结果页显示「正在生成中 + 刷新」 */ }
    }
    const byN: Record<string, string | null> = {};
    for (const e of errors) {
      if (e.questionId != null && expls[e.questionId]) byN[e.questionN] = expls[e.questionId];
    }
    setExplanations(byN);

    const allCorrect = stillWrongIds.length === 0
      && errors.every((e) => {
        const a = results[e.questionN];
        return a && a.isCorrect;
      });

    setFinalResults(results);
    setPhase(allCorrect ? 'allClear' : 'hasErrors');
  }, [errors]);

  // ========== ANSWERING 态：答题核心收敛到 QuestionRunner（embedded）==========
  if (phase === 'answering') {
    return (
      <QuestionRunner
        questions={questions}
        subjectId={subjectId}
        draftKeyPrefix="err-q"
        variant="embedded"
        title={(index, total) => `错题巩固 — 第 ${index + 1}/${total} 题`}
        onSubmit={handleSubmit}
        // 主观题自评落库：与 handleSubmit 同款错题记录定位（题面精确匹配优先，回退首条）
        onSelfAssess={async (q, assessment, ctx) => {
          const candidates = errorsByN.get(q.n) ?? [];
          const err = candidates.find((e) => e.questionText === q.text) ?? candidates[0];
          if (!err) throw new Error('错题记录缺失，无法自评');
          await selfAssessPractice({
            cardId: err.cardId,
            // 与判题同款：写错题来源卡真正所属的课，取不到回退当前页
            lessonId: err.lessonId ?? lessonId,
            subjectId,
            questionN: q.n,
            questionText: q.text,
            questionId: ctx.questionId,
            studentAnswer: ctx.studentAnswer,
            assessment,
          });
        }}
        onFinish={handleFinish}
      />
    );
  }

  // ========== JUDGING 态（判题等待由 QuestionRunner 内置视图覆盖，此处为 bump 窗口）==========
  if (phase === 'judging') {
    return (
      <div className="flex-1 min-h-0 flex items-center justify-center" style={{ maxWidth: 'var(--learn-card-max-w)', width: '100%', margin: '0 auto' }}>
        <div className="text-center space-y-4 p-8 rounded-xl" style={{ backgroundColor: 'var(--learn-card-bg)' }}>
          {SPINNER_SVG}
          <h2 className="text-lg font-bold text-[var(--text-primary)]">判题中，请稍候…</h2>
          <p className="text-sm text-[var(--text-tertiary)]">AI 正在判定你的答案，请耐心等待</p>
        </div>
      </div>
    );
  }

  // ========== ALL CLEAR 态（庆祝页）==========
  if (phase === 'allClear') {
    return (
      <div className="flex-1 min-h-0 flex items-center justify-center" style={{ maxWidth: 'var(--learn-card-max-w)', width: '100%', margin: '0 auto' }}>
        <motion.div
          initial={{ opacity: 0, scale: 0.9 }}
          animate={{ opacity: 1, scale: 1 }}
          className="text-center space-y-6 p-8"
        >
          <style>{`
            @keyframes driftDownCleanup {
              0% { transform: translateY(-20px) rotate(0deg) scale(0.6); opacity: 0; }
              15% { opacity: 0.9; }
              85% { opacity: 0.9; }
              100% { transform: translateY(500px) rotate(360deg) scale(1.1); opacity: 0; }
            }
          `}</style>
          <div className="relative h-32 overflow-hidden">
            {Array.from({ length: 12 }).map((_, i) => {
              const shapes = ['🌸', '✨', '🎉', '🌟'];
              const shape = shapes[i % shapes.length];
              const delay = (i * 0.1).toFixed(2);
              const left = ((i * 9) % 90).toFixed(0);
              return (
                <div
                  key={i}
                  className="absolute"
                  style={{
                    left: `${left}%`,
                    top: '-10px',
                    animation: `driftDownCleanup 2s ease-out ${delay}s infinite normal forwards`,
                    opacity: 0,
                  }}
                >
                  {shape}
                </div>
              );
            })}
          </div>

          <div className="w-20 h-20 mx-auto rounded-full bg-[#E2F0D9] border-4 border-green-600 flex items-center justify-center text-green-700">
            <CheckCircleIcon className="w-12 h-12" />
          </div>
          <h2 className="text-2xl font-extrabold text-[var(--text-primary)]">错题清零完成！</h2>
          <p className="text-[var(--text-secondary)]">
            {countdown > 0 ? `${countdown} 秒后自动开始学习` : '正在进入...'}
          </p>
          <button
            onClick={() => onComplete(true)}
            className="px-8 py-3 rounded-xl bg-[var(--brand-500)] text-white font-semibold hover:bg-[var(--brand-600)] transition-colors shadow-sm"
          >
            开始学习
          </button>
        </motion.div>
      </div>
    );
  }

  // ========== HAS ERRORS 态（对错表）==========
  if (phase === 'hasErrors') {
    return (
      <div className="flex-1 min-h-0 flex flex-col" style={{ maxWidth: 'var(--learn-card-max-w)', width: '100%', margin: '0 auto' }}>
        <AnswerResultList
          questions={questions}
          answers={finalResults ?? {}}
          initialExplanations={explanations}
          // questionN 可能跨卡撞号：取首个有 questionId 的候选（判题 handleSubmit 用题面匹配，此处题面不可得）
          questionIdOf={(n) => (errorsByN.get(n) ?? []).find((e) => e.questionId != null)?.questionId ?? null}
          onWaitExplanation={async (qid) => {
            const res = await waitTrainingExplanation(qid);
            return res.explanation;
          }}
          onClose={() => onComplete(false)}
        />
      </div>
    );
  }

  return null;
}
