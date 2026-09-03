import { useEffect, useMemo, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { AnswerResultList } from '@/components/business/AnswerResultList';
import {
  getExamResults,
  getExamSession,
  type ExamResultItem,
  type ExamSummary,
} from '@/services/api';
import { useThemeStore } from '@/store/themeStore';

const SPINNER_SVG = (
  <svg
    className="animate-spin text-[var(--brand-500)]"
    width="40"
    height="40"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    strokeLinecap="round"
  >
    <path d="M21 12a9 9 0 1 1-6.219-8.56" />
  </svg>
);

/**
 * 考试结果页：mount 校验会话已交卷（未交卷踢回答题页），拉取结果渲染
 * 得分卡（正确数/总题数/正确率大字）+ 逐题结果列表；确认返回考试列表。
 */
export default function ExamResultPage() {
  const { sessionId } = useParams();
  const sid = Number(sessionId);
  const navigate = useNavigate();
  const { mode, autoToggleNightMode } = useThemeStore();

  const [summary, setSummary] = useState<ExamSummary | null>(null);
  const [items, setItems] = useState<ExamResultItem[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  // 沉浸层夜间模式：挂一次 + 每分钟检查（镜像答题页用法）
  useEffect(() => {
    autoToggleNightMode();
    const t = setInterval(autoToggleNightMode, 60000);
    return () => clearInterval(t);
  }, [autoToggleNightMode]);

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        // 未交卷（直接访问 / 会话仍进行中）：踢回答题页继续考试
        const s = await getExamSession(sid);
        if (cancelled) return;
        if (s.status !== 'submitted') {
          navigate(`/student/training/exam/run/${sid}`, { replace: true });
          return;
        }
        const res = await getExamResults(sid);
        if (cancelled) return;
        setSummary(res);
        setItems(res.items);
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : '加载考试结果失败');
      }
    };
    void load();
    return () => {
      cancelled = true;
    };
  }, [sid, navigate]);

  const resultQuestions = useMemo(
    () => (items ?? []).map((it) => ({ n: String(it.questionNo), text: it.text })),
    [items],
  );

  // AnswerResultList 的 AnswerRecord 映射：isCorrect 后端为 0|1；
  // 解析展示 analysis ?? explanation（判题解析优先，缺省落题目自带解析）
  const answers = useMemo(() => {
    const map: Record<
      string,
      { isCorrect: boolean; method: string; analysis: string | null; studentAnswer: string; failed: boolean }
    > = {};
    for (const it of items ?? []) {
      map[String(it.questionNo)] = {
        isCorrect: it.isCorrect === 1,
        method: '',
        analysis: it.analysis ?? it.explanation,
        studentAnswer: it.answerText ?? '',
        failed: false,
      };
    }
    return map;
  }, [items]);

  // mount 读取中 / 加载失败：不渲染结果
  if (items == null) {
    return (
      <div className="student-theme-container" data-theme={mode} data-school="junior">
        <div className="flex h-screen flex-col items-center justify-center gap-4 bg-[var(--bg-page)] text-[var(--text-primary)]">
          {error ? (
            <>
              <p className="text-sm text-[var(--text-secondary)]">{error}</p>
              <button
                onClick={() => navigate('/student/training/exam')}
                className="h-10 rounded-[var(--radius-button)] border border-[var(--bg-subtle)] px-4 text-sm text-[var(--text-secondary)] transition-colors hover:bg-[var(--bg-base)]"
              >
                返回考试列表
              </button>
            </>
          ) : (
            <>
              {SPINNER_SVG}
              <p className="text-sm text-[var(--text-secondary)]">正在加载考试结果…</p>
            </>
          )}
        </div>
      </div>
    );
  }

  return (
    <div className="student-theme-container" data-theme={mode} data-school="junior">
      <div className="h-screen bg-[var(--bg-page)] text-[var(--text-primary)]">
        <AnswerResultList
          questions={resultQuestions}
          answers={answers}
          headerExtra={
            summary && (
              <div className="flex items-center justify-center gap-10 py-5">
                <div className="text-center">
                  <div className="font-mono text-4xl font-bold leading-none text-[var(--success)]">
                    {summary.correctCount}
                  </div>
                  <div className="mt-1.5 text-xs text-[var(--text-secondary)]">答对题数</div>
                </div>
                <div className="h-10 w-px bg-[var(--bg-subtle)]" aria-hidden="true" />
                <div className="text-center">
                  <div className="font-mono text-4xl font-bold leading-none text-[var(--text-primary)]">
                    {summary.totalCount}
                  </div>
                  <div className="mt-1.5 text-xs text-[var(--text-secondary)]">总题数</div>
                </div>
                <div className="h-10 w-px bg-[var(--bg-subtle)]" aria-hidden="true" />
                <div className="text-center">
                  <div className="font-mono text-4xl font-bold leading-none text-[var(--brand-500)]">
                    {summary.accuracy}%
                  </div>
                  <div className="mt-1.5 text-xs text-[var(--text-secondary)]">正确率</div>
                </div>
              </div>
            )
          }
          onClose={() => navigate('/student/training/exam')}
        />
      </div>
    </div>
  );
}
