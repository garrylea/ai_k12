import { useEffect, useMemo, useRef, useState } from 'react';
import { useLocation, useNavigate, useParams } from 'react-router-dom';
import { AnswerResultList } from '@/components/business/AnswerResultList';
import { CelebrationOverlay } from '@/components/business';
import {
  getExamResults,
  getExamSession,
  getTrainingExplanations,
  selfAssessTraining,
  waitTrainingExplanation,
  type ExamResultItem,
  type ExamSummary,
} from '@/services/api';
import { usePointsFeedback } from './points-feedback';

/** 数学 subject_id（tools/db/schema.sql subjects seed 首行）——训练轨 MVP 仅数学。 */
const MATH_SUBJECT_ID = 1;

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
  const location = useLocation();

  /**
   * 交卷发分结果由 `ExamRunPage` 经导航 state 交接（结果页自己的 `getExamResults`
   * 是 GET，**不补发分**）。**可选**：刷新页面 / 重复交卷 / 早退进来的历史项没有这个键，
   * 此时不弹任何积分反馈、也不报错。
   */
  const navPoints = (location.state as { points?: ExamSummary['points'] } | null)?.points;

  const { award, celebrationProps } = usePointsFeedback();
  // 只庆祝一次：StrictMode 双跑 effect、summary 后续更新都不得重复弹
  const celebratedRef = useRef(false);

  const [summary, setSummary] = useState<ExamSummary | null>(null);
  const [items, setItems] = useState<ExamResultItem[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  // 错题解析：初始为 getExamResults 的 explanation（存量历史 analysis 兜底）；
  // mount 后对仍为空的错题后台补拉（等 in-flight 生成，60s 兜底），完成后合并。
  const [explanations, setExplanations] = useState<Record<string, string | null>>({});

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

        // 初始解析：DB 题解优先，存量考试的历史 analysis 兜底（spec §5.2）
        const base: Record<string, string | null> = {};
        const missingIds: number[] = [];
        for (const it of res.items) {
          const text = it.explanation ?? it.analysis;
          base[String(it.questionNo)] = text;
          // 客观题答错 + 自评做错的主观题都要补拉解析
          if (
            text == null &&
            it.questionId != null &&
            (it.isCorrect === 0 || (it.isCorrect === null && it.selfAssessment === 'incorrect'))
          ) {
            missingIds.push(it.questionId);
          }
        }
        setExplanations(base);

        // 后台补拉（不阻塞首屏）：批量端点等 in-flight 生成完成，合并非空结果
        if (missingIds.length > 0) {
          try {
            const { explanations: fetched } = await getTrainingExplanations(missingIds);
            if (cancelled) return;
            setExplanations((prev) => {
              const next = { ...prev };
              for (const it of res.items) {
                const v = fetched[it.questionId];
                if (v != null && next[String(it.questionNo)] == null) next[String(it.questionNo)] = v;
              }
              return next;
            });
          } catch {
            // 补拉失败：保持「正在生成中 + 刷新」兜底
          }
        }
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : '加载考试结果失败');
      }
    };
    void load();
    return () => {
      cancelled = true;
    };
  }, [sid, navigate]);

  // 交卷是**大任务**：走全屏 task 庆祝（不是轻反馈），分数与积分同屏（计划 §3 Task 7c）。
  // 副标题要等 summary 到位才拼得出，所以放在这里而不是 load 里；
  // 「什么时候弹什么」全交给共享决策模块——0 分 / 无 points 一律静默。
  useEffect(() => {
    if (celebratedRef.current || !navPoints || !summary) return;
    celebratedRef.current = true;
    award({
      pointsAwarded: navPoints.awarded,
      levelUp: navPoints.levelUp,
      title: '数学测验',
      celebrate: {
        title: '本套试卷已交卷！',
        subtitle: `客观题 ${summary.correctCount}/${summary.totalCount} · 正确率 ${summary.accuracy}% · 积分 +${navPoints.awarded}`,
        primaryLabel: '查看成绩',
      },
    });
  }, [navPoints, summary, award]);

  const resultQuestions = useMemo(
    () => (items ?? []).map((it) => ({ n: String(it.questionNo), text: it.text })),
    [items],
  );

  // q.n（= questionNo）-> questionId 映射（单题刷新解析用）
  const questionIdByN = useMemo(() => {
    const map = new Map<string, number>();
    for (const it of items ?? []) map.set(String(it.questionNo), it.questionId);
    return map;
  }, [items]);

  // AnswerResultList 的 AnswerRecord 映射：isCorrect 后端为 0|1|null（null = 主观题待自评）；
  // 解析统一走 explanations prop
  const answers = useMemo(() => {
    const map: Record<
      string,
      {
        isCorrect: boolean;
        method: string;
        studentAnswer: string;
        failed: boolean;
        needsSelfAssess: boolean;
        selfAssessment: 'correct' | 'incorrect' | null;
      }
    > = {};
    for (const it of items ?? []) {
      map[String(it.questionNo)] = {
        isCorrect: it.isCorrect === 1,
        method: it.isCorrect === null ? 'self_assess' : '',
        studentAnswer: it.answerText ?? '',
        failed: false,
        needsSelfAssess: it.isCorrect === null && it.selfAssessment == null,
        selfAssessment: it.selfAssessment ?? null,
      };
    }
    return map;
  }, [items]);

  // 参考答案映射（key = q.n）：主观题自评时对照展示
  const referenceAnswers = useMemo(() => {
    const map: Record<string, string | null> = {};
    for (const it of items ?? []) map[String(it.questionNo)] = it.answer ?? null;
    return map;
  }, [items]);

  // 自评提交后更新本地态（消除 needsSelfAssess / 记录 selfAssessment），未自评横幅随之消失
  const handleSelfAssess = async (n: string, assessment: 'correct' | 'incorrect') => {
    const qid = questionIdByN.get(n);
    if (qid == null) return;
    await selfAssessTraining({
      questionId: qid,
      subjectId: MATH_SUBJECT_ID,
      assessment,
      source: 'exam',
      sourceRefId: sid,
    });
    setItems((prev) =>
      (prev ?? []).map((it) =>
        String(it.questionNo) === n ? { ...it, selfAssessment: assessment, needsSelfAssessment: false } : it,
      ),
    );
  };

  // mount 读取中 / 加载失败：不渲染结果
  if (items == null) {
    return (
      <div className="student-theme-container" data-theme="student-day" data-school="junior">
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
    <div className="student-theme-container" data-theme="student-day" data-school="junior">
      <div className="h-screen bg-[var(--bg-page)] text-[var(--text-primary)]">
        <AnswerResultList
          questions={resultQuestions}
          answers={answers}
          initialExplanations={explanations}
          questionIdOf={(n) => questionIdByN.get(n) ?? null}
          onWaitExplanation={async (qid) => {
            const res = await waitTrainingExplanation(qid);
            return res.explanation;
          }}
          referenceAnswers={referenceAnswers}
          onSelfAssess={handleSelfAssess}
          headerExtra={
            summary && (
              <div>
                {(() => {
                  // 未自评横幅：主观题尚未完成自评时提示（自评提交后 items 更新，横幅消失）
                  const unassessed = (items ?? []).filter((it) => it.isCorrect === null && it.selfAssessment == null).length;
                  if (unassessed > 0) {
                    return (
                      <div className="flex items-center justify-center gap-2 py-2 bg-[var(--brand-100)] text-[13px] text-[var(--warning)]">
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
                          <circle cx="12" cy="12" r="10" />
                          <path d="M12 8v4" />
                          <path d="M12 16h.01" />
                        </svg>
                        还有 {unassessed} 题未自评，请在下方列表完成自评
                      </div>
                    );
                  }
                  return null;
                })()}
                <div className="flex items-center justify-center gap-10 py-5">
                  <div className="text-center">
                    <div className="font-mono text-4xl font-bold leading-none text-[var(--success)]">{summary.correctCount}</div>
                    <div className="mt-1.5 text-xs text-[var(--text-secondary)]">客观题答对</div>
                  </div>
                  <div className="h-10 w-px bg-[var(--bg-subtle)]" aria-hidden="true" />
                  <div className="text-center">
                    <div className="font-mono text-4xl font-bold leading-none text-[var(--text-primary)]">
                      {summary.totalCount - (summary.subjectiveCount ?? 0)}
                    </div>
                    <div className="mt-1.5 text-xs text-[var(--text-secondary)]">客观题总数</div>
                  </div>
                  <div className="h-10 w-px bg-[var(--bg-subtle)]" aria-hidden="true" />
                  <div className="text-center">
                    <div className="font-mono text-4xl font-bold leading-none text-[var(--brand-500)]">{summary.accuracy}%</div>
                    <div className="mt-1.5 text-xs text-[var(--text-secondary)]">客观题正确率</div>
                  </div>
                  {(summary.subjectiveCount ?? 0) > 0 && (
                    <>
                      <div className="h-10 w-px bg-[var(--bg-subtle)]" aria-hidden="true" />
                      <div className="text-center">
                        <div className="font-mono text-4xl font-bold leading-none text-[var(--brand-500)]">{summary.subjectiveCount}</div>
                        <div className="mt-1.5 text-xs text-[var(--text-secondary)]">主观题（自评）</div>
                      </div>
                    </>
                  )}
                </div>
              </div>
            )
          }
          onClose={() => navigate('/student/training/exam')}
        />
      </div>
      {/* 段位晋升 / 交卷全屏庆祝（决策表在 points-feedback，本页不自己判断何时弹） */}
      <CelebrationOverlay {...celebrationProps} />
    </div>
  );
}
