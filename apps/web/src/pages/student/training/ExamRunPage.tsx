import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { QuestionRunner } from '@/components/business/answer/QuestionRunner';
import { RunExitGuard } from '@/components/business/answer/RunExitGuard';
import { DraftDrawer, DraftIconButton } from '@/components/business/DraftDrawer';
import type { RunnerQuestion } from '@/components/business/answer/types';
import {
  getExamSession,
  submitExamAnswer,
  submitExamSession,
  type ExamSessionInfo,
  type JudgeResult,
} from '@/services/api';
import { normalizeOptions } from './normalizeOptions';

/** 数学 subject_id（subjects seed 首行）——考试 MVP 仅数学。 */
const MATH_SUBJECT_ID = 1;

/** 列表页开考时写入的会话键（读后即删，防止刷新后重复消费旧会话）。 */
const SESSION_KEY = 'exam:session';

/** 剩余时间低于该秒数时倒计时变红（--error）。 */
const LOW_TIME_SECONDS = 5 * 60;

function pad2(n: number): string {
  return String(n).padStart(2, '0');
}

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
 * 考试进行页：限时答题 + 倒计时 + 续考恢复 + 归零自动交卷。
 * 无 BackButton（考试中不可返回）；答完末题即视为交卷（QuestionRunner onFinish）。
 */
export default function ExamRunPage() {
  const { sessionId } = useParams();
  const sid = Number(sessionId);
  const navigate = useNavigate();

  const [session, setSession] = useState<ExamSessionInfo | null>(null);
  const [remainingSeconds, setRemainingSeconds] = useState<number | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [submitError, setSubmitError] = useState<string | null>(null);
  /** 已答题号集合（n = String(questionNo)）：续考恢复的 answered + 本地成功提交（Set 去重，重交不重复计数）。 */
  const [answeredNs, setAnsweredNs] = useState<Set<string>>(new Set());
  // 页面级草稿抽屉：考试中始终可见图标；交卷后（currentQ 不再更新）不渲染抽屉
  const [draftOpen, setDraftOpen] = useState(false);
  const [currentQ, setCurrentQ] = useState<RunnerQuestion | null>(null);
  /** 交卷去重：倒计时归零与 onFinish 可能并发触发。 */
  const submittingRef = useRef(false);
  // 交卷成功跳结果页前放行导航（同步置 ref.current=false 再 navigate，绕开 RunExitGuard 拦截——ref 是同步生效的）
  const guardRef = useRef(true);
  // StrictMode 下 effect 会跑两次：ref 守卫保证 sessionStorage「读 + 删」只执行一次，
  // 否则第二次读到空会误判为无会话（走服务端拉取虽然也能恢复，但语义上应消费新开卷数据）。
  const bootstrappedRef = useRef(false);

  // mount：优先 sessionStorage（列表页刚开的卷），无则 getExamSession（刷新/续考恢复）
  useEffect(() => {
    if (bootstrappedRef.current) return;
    bootstrappedRef.current = true;

    const boot = async () => {
      let info: ExamSessionInfo | null = null;
      try {
        const raw = sessionStorage.getItem(SESSION_KEY);
        if (raw) {
          const value: unknown = JSON.parse(raw);
          if (
            typeof value === 'object' &&
            value != null &&
            'sessionId' in value &&
            (value as ExamSessionInfo).sessionId === sid
          ) {
            info = value as ExamSessionInfo;
          }
        }
      } catch {
        // 解析失败视为无会话，走续考恢复
      }
      // 读后即删：无论内容是否有效都清掉，避免刷新/回退后带着旧会话重复进入
      sessionStorage.removeItem(SESSION_KEY);

      if (!info) {
        try {
          info = await getExamSession(sid);
        } catch (err) {
          setLoadError(err instanceof Error ? err.message : '加载考试失败');
          return;
        }
      }
      if (!info) return;

      // 已交卷（如别处已自动收卷）：直接去结果页
      if (info.status === 'submitted') {
        navigate(`/student/training/exam/result/${sid}`, { replace: true });
        return;
      }
      setSession(info);
      setRemainingSeconds(info.remainingSeconds);
      // 续考恢复的已答进度（answered 键为 questionId 的字符串形态）
      const answeredKeys = new Set(Object.keys(info.answered ?? {}));
      setAnsweredNs(
        new Set(
          info.questions
            .filter((q) => answeredKeys.has(String(q.questionId)))
            .map((q) => String(q.questionNo)),
        ),
      );
    };

    void boot();
  }, [sid, navigate]);

  // 倒计时：以服务端 remainingSeconds 为锚，本地每秒递减（不依赖本地时钟绝对值）；减到 0 停止
  useEffect(() => {
    if (session == null) return;
    const t = setInterval(() => {
      setRemainingSeconds((s) => (s == null || s <= 0 ? s : s - 1));
    }, 1000);
    return () => clearInterval(t);
  }, [session]);

  // 交卷（倒计时归零自动交卷与末题答完 onFinish 共用；submittingRef 去重）
  const handleSubmitExam = useCallback(async () => {
    if (submittingRef.current) return;
    submittingRef.current = true;
    setSubmitError(null);
    try {
      await submitExamSession(sid);
      guardRef.current = false;
      navigate(`/student/training/exam/result/${sid}`, { replace: true });
    } catch (err) {
      submittingRef.current = false;
      setSubmitError(err instanceof Error ? err.message : '交卷失败，请重试');
    }
  }, [sid, navigate]);

  // 倒计时归零：自动交卷
  useEffect(() => {
    if (session == null || remainingSeconds == null || remainingSeconds > 0) return;
    void handleSubmitExam();
  }, [remainingSeconds, session, handleSubmitExam]);

  const questions = useMemo<RunnerQuestion[]>(
    () =>
      (session?.questions ?? []).map((q) => ({
        n: String(q.questionNo),
        text: q.text,
        type: q.type,
        options: normalizeOptions(q.options),
      })),
    [session],
  );

  // n（= String(questionNo)）-> questionId 映射（提交答案用后端 questionId）
  const questionIdMap = useMemo(() => {
    const map = new Map<string, number>();
    for (const q of session?.questions ?? []) map.set(String(q.questionNo), q.questionId);
    return map;
  }, [session]);

  const handleSubmit = useCallback(
    (q: RunnerQuestion, answer: string) => {
      const questionId = questionIdMap.get(q.n);
      if (questionId == null) return Promise.reject(new Error('题目数据异常'));
      return submitExamAnswer(sid, questionId, answer).then(() => {
        setAnsweredNs((prev) => {
          if (prev.has(q.n)) return prev;
          const next = new Set(prev);
          next.add(q.n);
          return next;
        });
        // 后端白名单不回传对错；占位 JudgeResult 仅为满足组件契约（结果页从 getExamResults 拉真数据）
        return { questionId: 0, isCorrect: true, method: 'exact', analysis: null } as JudgeResult;
      });
    },
    [sid, questionIdMap],
  );

  const handleFinish = useCallback(() => {
    void handleSubmitExam();
  }, [handleSubmitExam]);

  // mount 读取中 / 加载失败：不渲染答题区
  if (session == null) {
    return (
      <div className="student-theme-container" data-theme="student-day" data-school="junior">
        <div className="relative flex h-screen flex-col items-center justify-center gap-4 bg-[var(--bg-page)] text-[var(--text-primary)]">
          {loadError ? (
            <>
              <p className="text-sm text-[var(--text-secondary)]">{loadError}</p>
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
              <p className="text-sm text-[var(--text-secondary)]">正在加载考试…</p>
            </>
          )}
        </div>
      </div>
    );
  }

  const remaining = remainingSeconds ?? 0;

  return (
    <div className="student-theme-container" data-theme="student-day" data-school="junior">
      <div className="relative flex h-screen flex-col p-4 sm:p-6 bg-[var(--bg-page)] text-[var(--text-primary)]">
        <QuestionRunner
          questions={questions}
          subjectId={MATH_SUBJECT_ID}
          draftKeyPrefix={`exam-${sid}`}
          variant="embedded"
          showResultFeedback={false}
          headerExtra={
            <div className="flex shrink-0 items-center gap-4">
              <span className="text-sm text-[var(--text-secondary)]">
                已答 {answeredNs.size}/{questions.length}
              </span>
              <span
                className="font-mono text-2xl font-bold tabular-nums"
                style={{ color: remaining < LOW_TIME_SECONDS ? 'var(--error)' : 'var(--text-primary)' }}
                aria-label="剩余时间"
              >
                {pad2(Math.floor(remaining / 60))}:{pad2(remaining % 60)}
              </span>
            </div>
          }
          onSubmit={handleSubmit}
          onFinish={handleFinish}
          onQuestionChange={setCurrentQ}
        />

        {/* 草稿入口：页面背景层右上角，absolute 定位；考试无「讲一讲」，仅本图标 + 倒计时在顶栏 */}
        <div className="absolute top-4 right-4">
          <DraftIconButton onClick={() => setDraftOpen(true)} />
        </div>
        {draftOpen && currentQ && (
          <DraftDrawer
            questionId={currentQ.n}
            onClose={() => setDraftOpen(false)}
          />
        )}

        {/* 考试无页内退出；拦截浏览器返回/刷新（计时不停，可续考） */}
        <RunExitGuard
          guardRef={guardRef}
          blockBeforeUnload
          title="离开考试"
          message="离开后计时不会暂停，可从考试列表续考返回。确认离开吗？"
          confirmLabel="确认离开"
          cancelLabel="继续考试"
        />

        {/* 交卷失败重试层（QuestionRunner 此时停在提交等待态，交卷成功即跳结果页） */}
        {submitError && (
          <div
            className="fixed inset-0 z-[60] flex items-center justify-center bg-black/40"
            role="alertdialog"
            aria-modal="true"
            aria-label="交卷失败"
          >
            <div className="mx-4 w-full max-w-sm rounded-2xl bg-[var(--bg-card)] p-6 text-center shadow-xl">
              <h2 className="text-base font-bold text-[var(--text-primary)]">交卷失败</h2>
              <p className="mt-2 text-sm text-[var(--text-secondary)]">{submitError}</p>
              <button
                onClick={() => void handleSubmitExam()}
                className="mt-4 h-10 w-full rounded-[var(--radius-button)] bg-[var(--brand-500)] text-sm font-semibold text-white transition-colors hover:bg-[var(--brand-600)]"
              >
                重试交卷
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
