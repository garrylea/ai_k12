import { useState, useEffect, useRef, useCallback } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkMath from 'remark-math';
import remarkGfm from 'remark-gfm';
import rehypeKatex from 'rehype-katex';
import 'katex/dist/katex.min.css';
import { motion } from 'framer-motion';
import { LatexEditor } from './LatexEditor';
import { LatexPreview } from './LatexPreview';
import { AnswerResultList } from './AnswerResultList';
import type { PracticeQuestion } from './AnswerModal';
import { judgePractice, bumpErrorLevels, type PreviousErrorDetail, type JudgeResult } from '@/services/api';

type Phase = 'answering' | 'judging' | 'allClear' | 'hasErrors';

interface AnswerRecord {
  isCorrect: boolean;
  method: string;
  analysis: string | null;
  errorType?: string | null;
  studentAnswer: string;
  failed?: boolean;
}

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

const ChevronLeftIcon = () => (
  <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <polyline points="15 18 9 12 15 6" />
  </svg>
);

export function CleanupPhase({ errors, lessonId, subjectId, onComplete }: Props) {
  const [phase, setPhase] = useState<Phase>('answering');
  const [idx, setIdx] = useState(0);
  const [answer, setAnswer] = useState('');
  const [countdown, setCountdown] = useState(5);
  // 本地追踪判题结果（避免 store 闭包过期问题）
  const resultsRef = useRef<Record<string, AnswerRecord>>({});
  const [finalResults, setFinalResults] = useState<Record<string, AnswerRecord> | null>(null);
  const pendingRef = useRef<Map<number, Promise<unknown>>>(new Map());

  const questions: PracticeQuestion[] = errors.map((e) => ({
    n: e.questionN,
    text: e.questionText,
  }));

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

  const currentError = errors[idx];
  const totalErrors = errors.length;

  const handleSubmit = useCallback(async () => {
    if (!answer.trim() || !currentError) return;

    const thisIdx = idx;
    const submittedAnswer = answer;
    const error = currentError;

    setAnswer('');

    const p = Promise.resolve(
      judgePractice({
        cardId: error.cardId,
        // 必须写错题来源卡「真正所属的课」：清零阶段会清到其他课的错题，
        // 若传当前页 lessonId，practice_results.lesson_id 会与卡片所属课不一致，
        // 导致课程级「重置课堂练习」（按 lesson_id 删）漏删该卡记录。取不到时回退当前页。
        lessonId: error.lessonId ?? lessonId,
        subjectId,
        questionN: error.questionN,
        questionText: error.questionText,
        studentAnswer: submittedAnswer,
      }),
    )
      .then((res: JudgeResult) => {
        resultsRef.current[error.questionN] = {
          isCorrect: res.isCorrect,
          method: res.method,
          analysis: res.analysis,
          errorType: res.errorType ?? null,
          studentAnswer: submittedAnswer,
        };
        return res;
      })
      .catch(() => {
        resultsRef.current[error.questionN] = {
          isCorrect: false,
          method: 'ai',
          analysis: null,
          errorType: null,
          studentAnswer: submittedAnswer,
          failed: true,
        };
      });

    pendingRef.current.set(thisIdx, p);

    if (thisIdx + 1 < totalErrors) {
      setIdx(thisIdx + 1);
    } else {
      setPhase('judging');
      try {
        await Promise.allSettled([...pendingRef.current.values()]);
      } catch { /* ignore */ }

      const final = { ...resultsRef.current };
      setFinalResults(final);

      // 统计仍错的题
      const stillWrongIds: number[] = [];
      for (const err of errors) {
        const a = final[err.questionN];
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

      const allCorrect = stillWrongIds.length === 0
        && errors.every((e) => {
          const a = final[e.questionN];
          return a && a.isCorrect;
        });

      if (allCorrect) {
        setPhase('allClear');
      } else {
        setPhase('hasErrors');
      }
    }
  }, [answer, idx, currentError, lessonId, subjectId, errors, totalErrors]);

  // ========== ANSWERING 态 ==========
  if (phase === 'answering' && currentError) {
    return (
      <div className="flex-1 min-h-0 flex flex-col" style={{ maxWidth: 'var(--learn-card-max-w)', width: '100%', margin: '0 auto' }}>
        <div className="shrink-0 mb-3">
          <h1 className="font-bold" style={{ fontSize: 'var(--fs-learn-h1)', lineHeight: '1.75rem', color: 'var(--learn-heading-1)' }}>
            错题巩固 — 第 {idx + 1}/{totalErrors} 题
          </h1>
        </div>

        <div className="flex-1 min-h-0 flex flex-col rounded-xl overflow-hidden border border-[var(--learn-card-border)] shadow-sm" style={{ backgroundColor: 'var(--learn-card-bg)' }}>
          <div className="shrink-0 p-4 border-b border-[var(--bg-subtle)]">
            <div className="text-xl text-[var(--text-primary)] [&>*]:font-bold leading-[1.7]">
              <ReactMarkdown remarkPlugins={[remarkMath, remarkGfm]} rehypePlugins={[rehypeKatex]}>
                {currentError.questionText}
              </ReactMarkdown>
            </div>
          </div>

          <div className="flex-1 min-h-0 flex">
            <div className="w-1/2 border-r border-[var(--bg-subtle)] flex flex-col">
              <LatexEditor value={answer} onChange={setAnswer} />
            </div>
            <div className="w-1/2">
              <LatexPreview value={answer} />
            </div>
          </div>

          <div className="shrink-0 flex items-center justify-between p-3 border-t border-[var(--bg-subtle)]">
            <button
              onClick={() => setIdx((i) => Math.max(0, i - 1))}
              disabled={idx <= 0}
              className="flex items-center gap-1 h-10 px-4 rounded-lg border border-[var(--bg-subtle)] text-[var(--text-tertiary)] text-sm disabled:opacity-40 hover:bg-[var(--bg-base)] transition-colors"
            >
              <ChevronLeftIcon />
              <span>上一题</span>
            </button>
            <button
              onClick={handleSubmit}
              disabled={!answer.trim()}
              className="w-12 h-12 rounded-full bg-[var(--brand-500)] text-white flex items-center justify-center disabled:opacity-40 hover:bg-[var(--brand-600)] transition-all shadow-md"
              title="提交"
            >
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <line x1="5" y1="12" x2="19" y2="12" />
                <polyline points="12 5 19 12 12 19" />
              </svg>
            </button>
          </div>
        </div>
      </div>
    );
  }

  // ========== JUDGING 态 ==========
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
          onClose={() => onComplete(false)}
        />
      </div>
    );
  }

  return null;
}
