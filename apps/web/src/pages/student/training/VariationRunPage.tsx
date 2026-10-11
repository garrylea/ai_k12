import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { QuestionRunner } from '@/components/business/answer/QuestionRunner';
import type { RunnerQuestion } from '@/components/business/answer/types';
import { DiscussDrawer, DiscussIconButton } from '@/components/business/DiscussDrawer';
import { DraftPanel, DraftIconButton } from '@/components/business/DraftPanel';
import { RunExitGuard } from '@/components/business/answer/RunExitGuard';
import { Modal, PageHeader } from '@/components/base';
import { toast } from '@/components/base/Toast';
import {
  ApiError,
  getTrainingHint,
  getTrainingVariations,
  selfAssessVariation,
  submitVariationAnswer,
} from '@/services/api';
import type { TrainingVariationItem, VariationAnswerResult } from '@/services/api';

/** 数学 subject_id（tools/db/schema.sql subjects seed 首行）——训练轨 MVP 仅数学。 */
const MATH_SUBJECT_ID = 1;
const ERRORS_PAGE = '/student/training/errors';

/**
 * 错题升级变式练习作答页（PRD §7.10，2026-10-11）。
 *
 * 与相似题专项（RemediationRunPage）同骨架，差异：
 * - 题单 = 服务端 pending 变式（`GET /api/training/variations/me`），可选 `?errorBookId=` 只练
 *   某条错题的变式（错题本条目入口）；无 pending 直接回错题本（不报喜——没生成过就没有）。
 * - **纯加练不发分**：无积分反馈、无庆祝层；**一次作答即落定**（判对判错都不重出），
 *   因此「换轮次重拉」在语义上只会拉到「本轮之后新落定的 pending（并发生成的新变式）」——
 *   正常情况下 finish 重拉即为空 → 回错题本。
 */
export default function VariationRunPage() {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const [data, setData] = useState<TrainingVariationItem[] | null>(null);
  const [loaded, setLoaded] = useState(false);
  // 换轮次：key 到 QuestionRunner 上强制重挂，重置内部题位与结果快照
  const [round, setRound] = useState(0);
  const [hints, setHints] = useState<Record<string, string>>({});
  const [currentQ, setCurrentQ] = useState<RunnerQuestion | null>(null);
  const [draftOpen, setDraftOpen] = useState(false);
  const [discussQ, setDiscussQ] = useState<RunnerQuestion | null>(null);
  const [exitConfirm, setExitConfirm] = useState<{ open: boolean; answered: number }>({
    open: false,
    answered: 0,
  });
  const guardRef = useRef(true);
  const bootstrappedRef = useRef(false);
  // 完成/离开处理幂等：finish 重拉为空与异常路径都会 navigate，守卫防双 toast 双跳
  const leavingRef = useRef(false);

  // query 一次解析进 ref：NaN/<1 一律按缺省（练全部 pending）处理，与后端口径一致
  const errorBookIdRef = useRef<number | undefined>(undefined);
  const rawId = Number(searchParams.get('errorBookId'));
  if (Number.isInteger(rawId) && rawId >= 1) errorBookIdRef.current = rawId;

  const leave = useCallback(
    (message?: string) => {
      if (leavingRef.current) return;
      leavingRef.current = true;
      if (message) toast('success', message);
      guardRef.current = false;
      navigate(ERRORS_PAGE, { replace: true });
    },
    [navigate],
  );

  const load = useCallback(async () => {
    try {
      const res = await getTrainingVariations({ errorBookId: errorBookIdRef.current });
      if (res.variations.length === 0) {
        // 无待练（没生成过 / 全部答完 / 全被并发落定）：静默回错题本，不弹完成 toast
        //（「变式练习完成」只在真正答完末题的 finish 路径报）
        navigate(ERRORS_PAGE, { replace: true });
        return;
      }
      setData(res.variations);
      setLoaded(true);
    } catch (err) {
      toast('error', err instanceof Error ? err.message : '加载失败');
      guardRef.current = false;
      navigate(ERRORS_PAGE, { replace: true });
    }
  }, [navigate]);

  useEffect(() => {
    if (bootstrappedRef.current) return;
    bootstrappedRef.current = true;
    void load();
  }, [load]);

  // 必须 useMemo：QuestionRunner 的切题 effect 依赖 questions 身份（同 RemediationRunPage 注释）
  const questions: RunnerQuestion[] = useMemo(
    () =>
      data
        ? data.map((v) => ({
            n: String(v.variationId),
            // 题面 id 对判题/提交接口是 questionId；n 只作 runner 内部 key，
            // 提交时用 data 里的映射反查（见 handleSubmit）
            text: v.text,
            type: v.type,
            options: v.options ?? undefined,
          }))
        : [],
    [data],
  );

  /** runner 的 q.n 是 variationId；提交接口要的是 questionId —— 反查映射。 */
  const questionIdOf = useCallback(
    (variationId: string): number => {
      const v = data?.find((item) => String(item.variationId) === variationId);
      return v ? v.questionId : Number(variationId); // 兜底直转（data 已加载时必然命中）
    },
    [data],
  );

  const handleSubmit = useCallback(
    async (q: RunnerQuestion, answer: string) => {
      try {
        const res: VariationAnswerResult = await submitVariationAnswer({
          questionId: questionIdOf(q.n),
          studentAnswer: answer,
        });
        // needsSelfAssessment=true：res 是 RunnerJudgeOutcome 的结构超集，直接返回合法，
        // runner 会据此渲染自评 UI（落定由 onSelfAssess 的 self-assess 端点完成）
        return res;
      } catch (err) {
        // 本页没有结果面展示「提交失败」：runner 会把 rejection 吞成 failed 记录后静默切下一题。
        // 4xx 是业务性拒绝（已作答 / 不在待练清单，如另一标签页刚答完），服务端 message 可照做；
        // 5xx/网络才是「检查网络」。先弹可见反馈再原样抛回（同 RemediationRunPage 做法）。
        const isClientReject =
          err instanceof ApiError && err.status !== undefined && err.status >= 400 && err.status < 500;
        toast('error', isClientReject ? err.message : '答案提交失败，请检查网络后重试');
        throw err;
      }
    },
    [questionIdOf],
  );

  const handleSelfAssess = useCallback(
    async (q: RunnerQuestion, assessment: 'correct' | 'incorrect') => {
      await selfAssessVariation({ questionId: questionIdOf(q.n), assessment });
    },
    [questionIdOf],
  );

  const handleRequestHint = useCallback(async (q: RunnerQuestion) => {
    // 后端可能 503（AI 不可用）：直接 rethrow，QuestionRunner 内部 catch 置 hintState.error
    const res = await getTrainingHint(questionIdOf(q.n));
    setHints((prev) => ({ ...prev, [q.n]: res.hint }));
    return res.hint;
  }, [questionIdOf]);

  const handleFinish = useCallback(async () => {
    // 完成处理幂等（同 RemediationRunPage completedRef 的理由）
    if (leavingRef.current) return;
    try {
      const res = await getTrainingVariations({ errorBookId: errorBookIdRef.current });
      if (res.variations.length === 0) {
        leave('变式练习完成');
      } else {
        // 还有 pending（并发生成的新变式落进来了）：换轮次重挂再答
        setData(res.variations);
        setRound((r) => r + 1);
      }
    } catch {
      // 重拉失败：题目与作答进度都在服务端，回错题本重新进入即可续做。
      toast('error', '网络不太稳定，请回错题本重新进入变式练习');
      leave();
    }
  }, [leave]);

  if (!loaded || !data) return null;

  return (
    <div className="student-theme-container" data-theme="student-day" data-school="junior">
      <div className="relative h-screen flex flex-col p-4 sm:p-6 bg-[var(--bg-page)] text-[var(--text-primary)]">
        <PageHeader
          to={ERRORS_PAGE}
          caption="返回错题本"
          title={`变式练习 · 待练 ${data.length} 题`}
          className="shrink-0 mb-4"
        />

        <div className="flex-1 min-h-0 flex">
          <div className="flex-1 min-w-0 min-h-0 flex flex-col">
            <QuestionRunner
              key={round}
              questions={questions}
              subjectId={MATH_SUBJECT_ID}
              draftKeyPrefix="variation"
              variant="embedded"
              draftDisabled
              enableHint
              hints={hints}
              onRequestHint={handleRequestHint}
              headerActions={(q) => <DiscussIconButton onClick={() => setDiscussQ(q)} />}
              onSubmit={handleSubmit}
              onSelfAssess={handleSelfAssess}
              onFinish={handleFinish}
              onQuestionChange={setCurrentQ}
              onClose={(answered) => setExitConfirm({ open: true, answered })}
            />
          </div>
          {draftOpen && currentQ && (
            <DraftPanel
              questionId={currentQ.n}
              draftKeyPrefix="variation"
              onClose={() => setDraftOpen(false)}
            />
          )}
        </div>

        {/* 草稿入口：背景层右上角 absolute（DOM 顺序说明同 RemediationRunPage） */}
        {!draftOpen && (
          <div className="absolute top-4 right-4">
            <DraftIconButton onClick={() => setDraftOpen(true)} />
          </div>
        )}
        {discussQ && (
          <DiscussDrawer
            mode="training"
            questionText={discussQ.text}
            questionId={questionIdOf(discussQ.n)}
            onClose={() => setDiscussQ(null)}
          />
        )}

        {/* X 退出确认（带已答进度）：进度已落库（一次作答即落定），故文案不说「不再保留」 */}
        {exitConfirm.open && (
          <Modal open onClose={() => setExitConfirm({ open: false, answered: 0 })} title="退出练习">
            <p className="text-sm text-[var(--text-secondary)]">
              已答 {exitConfirm.answered}/{questions.length} 题，退出后可在错题本继续变式练习。确定退出吗？
            </p>
            <div className="mt-6 flex justify-end gap-3">
              <button
                onClick={() => setExitConfirm({ open: false, answered: 0 })}
                className="h-10 px-4 rounded-[var(--radius-button)] border border-[var(--bg-subtle)] text-sm text-[var(--text-secondary)] transition-colors hover:bg-[var(--bg-base)]"
              >
                继续答题
              </button>
              <button
                onClick={() => leave()}
                className="h-10 px-4 rounded-[var(--radius-button)] bg-[var(--brand-500)] text-sm font-semibold text-white transition-colors hover:bg-[var(--brand-600)]"
              >
                确认退出
              </button>
            </div>
          </Modal>
        )}

        <RunExitGuard
          guardRef={guardRef}
          title="离开练习"
          message="变式练习进度已保存，离开后可在错题本继续。"
          confirmLabel="确认离开"
        />
      </div>
    </div>
  );
}
