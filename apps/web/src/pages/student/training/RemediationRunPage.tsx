import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { QuestionRunner } from '@/components/business/answer/QuestionRunner';
import type { RunnerQuestion } from '@/components/business/answer/types';
import { DiscussDrawer, DiscussIconButton } from '@/components/business/DiscussDrawer';
import { DraftPanel, DraftIconButton } from '@/components/business/DraftPanel';
import { RunExitGuard } from '@/components/business/answer/RunExitGuard';
import { Modal, PageHeader } from '@/components/base';
import { toast } from '@/components/base/Toast';
import { usePointsStore } from '@/store/pointsStore';
import {
  ApiError,
  getRemediationQuestions,
  getTrainingHint,
  selfAssessRemediation,
  submitRemediationAnswer,
} from '@/services/api';
import type { RemediationAnswerResult, RemediationQuestionsResult } from '@/services/api';

/** 数学 subject_id（tools/db/schema.sql subjects seed 首行）——训练轨 MVP 仅数学。 */
const MATH_SUBJECT_ID = 1;

/**
 * 相似题专项（错题补偿套题）作答页。
 *
 * 与其它训练轨答题页的差异：题单**由服务端持有**（不是 sessionStorage 交接）——
 * 进页面拉未答对项，答对即发分并推进，全对时后端清空套题 → 本页回训练首页。
 * 答错的题留在套题里，`onFinish` 重拉后换轮次再战，直到清零。
 */
export default function RemediationRunPage() {
  const navigate = useNavigate();
  const [data, setData] = useState<RemediationQuestionsResult | null>(null);
  const [loaded, setLoaded] = useState(false);
  // 换轮次：key 到 QuestionRunner 上强制重挂，重置内部题位与结果快照
  const [round, setRound] = useState(0);
  const [hints, setHints] = useState<Record<string, string>>({});
  // 页面级草稿抽屉：始终可见图标，切题即清空；currentQ 由 QuestionRunner.onQuestionChange 喂
  const [currentQ, setCurrentQ] = useState<RunnerQuestion | null>(null);
  const [draftOpen, setDraftOpen] = useState(false);
  const [discussQ, setDiscussQ] = useState<RunnerQuestion | null>(null);
  // 退出确认（X 按钮）：answered 由 QuestionRunner 传出
  const [exitConfirm, setExitConfirm] = useState<{ open: boolean; answered: number }>({
    open: false,
    answered: 0,
  });
  // X 确认后放行导航（同步置 ref.current=false 再 navigate，绕开 RunExitGuard 二次拦截）
  const guardRef = useRef(true);
  // StrictMode 下 effect 会跑两次：ref 守卫保证只加载一次
  const bootstrappedRef = useRef(false);
  // 完成处理幂等：submit 的 `setCompleted`（路径 1）与 onFinish 重拉发现空（路径 2）都会触发，
  // 无守卫会弹两条相同 toast —— fire-and-forget 的 .then 先于 allSettled 续体执行，
  // 路径 1 已 navigate 离开、组件卸载也拦不住模块级的 toast。
  const completedRef = useRef(false);
  const pushPoints = usePointsStore((s) => s.push);

  const handleCompleted = useCallback(() => {
    if (completedRef.current) return;
    completedRef.current = true;
    toast('success', '套题全部答对，已清零');
    guardRef.current = false;
    navigate('/student/training/home', { replace: true });
  }, [navigate]);

  const load = useCallback(async () => {
    try {
      const res = await getRemediationQuestions();
      if (res.questions.length === 0) {
        // 进页面时就发现已清零（上次答完 / 后端批量标对）：报喜后回首页。
        // 这是独立于 handleCompleted 的一条路径，故不接 completedRef。
        if (res.itemCount > 0 && res.correctCount === res.itemCount) {
          toast('success', '套题全部答对，已清零');
        }
        navigate('/student/training/home', { replace: true });
        return;
      }
      setData(res);
      setLoaded(true);
    } catch (err) {
      toast('error', err instanceof Error ? err.message : '加载失败');
      navigate('/student/training/home', { replace: true });
    }
  }, [navigate]);

  useEffect(() => {
    if (bootstrappedRef.current) return;
    bootstrappedRef.current = true;
    void load();
  }, [load]);

  // 必须 useMemo：QuestionRunner 的切题 effect 依赖 questions 身份，每渲染换新数组会把
  // 提示面板状态反复重置（提示永远展不开）
  const questions: RunnerQuestion[] = useMemo(
    () =>
      data
        ? data.questions.map((q) => ({
            n: String(q.questionId),
            text: q.text,
            type: q.type,
            options: q.options ?? undefined,
          }))
        : [],
    [data],
  );

  const handlePoints = useCallback(
    (res: RemediationAnswerResult) => {
      if (res.points && res.points.pointsAwarded > 0) {
        const levelUp = res.points.levelUp
          ? { from: res.points.levelUp.from.name, to: res.points.levelUp.to.name }
          : null;
        // push 内部已 revision + 1（勿再 bumpRevision）；levelUp 只承载，
        // 由 PointsToast / CelebrationOverlay 决定怎么展示
        pushPoints({ points: res.points.pointsAwarded, title: '相似题专项', levelUp });
      }
    },
    [pushPoints],
  );

  const handleSubmit = useCallback(
    async (q: RunnerQuestion, answer: string) => {
      try {
        const res = await submitRemediationAnswer({ questionId: Number(q.n), studentAnswer: answer });
        handlePoints(res);
        if (res.setCompleted) handleCompleted();
        // RemediationAnswerResult 是 RunnerJudgeOutcome 的结构超集，直接返回合法
        return res;
      } catch (err) {
        // 本页没有结果面能展示「提交失败」：runner 会把 rejection 吞成 failed 记录后静默切下一题，
        // 学生将完全无感。先弹一条可见反馈，再原样抛回，让 runner 照常记录 failed 并推进。
        // 4xx 是**业务性拒绝**（该题已答对 / 不在当前套题 / 已无进行中套题，如另一标签页刚清套），
        // 服务端 message 本身就是给学生看的、可照做；说成「检查网络」会把人引到错方向。
        const isClientReject =
          err instanceof ApiError && err.status !== undefined && err.status >= 400 && err.status < 500;
        toast('error', isClientReject ? err.message : '答案提交失败，请检查网络后重试');
        throw err;
      }
    },
    [handlePoints, handleCompleted],
  );

  const handleSelfAssess = useCallback(
    async (q: RunnerQuestion, assessment: 'correct' | 'incorrect') => {
      const res = await selfAssessRemediation({ questionId: Number(q.n), assessment });
      handlePoints(res);
      if (res.setCompleted) handleCompleted();
    },
    [handlePoints, handleCompleted],
  );

  const handleRequestHint = useCallback(async (q: RunnerQuestion) => {
    // 后端可能 503（AI 不可用）：直接 rethrow，QuestionRunner 内部 catch 置 hintState.error
    const res = await getTrainingHint(Number(q.n));
    setHints((prev) => ({ ...prev, [q.n]: res.hint }));
    return res.hint;
  }, []);

  // onFinish 传入的本地 results 快照这里用不上：重拉服务端状态更权威，
  // 还能覆盖「题目被下线批量标对」这类服务端行为
  const handleFinish = useCallback(async () => {
    // 已由 setCompleted 触发完成并 navigate 离开：runner 在末题提交后仍会再触发一次 onFinish，
    // 此时重拉纯属多余（套题已清，重拉结果必然是空），更要紧的是这次请求若失败会把
    // 已完成的学生拖进下面那条失败路径。completedRef 是同步 ref，卸载拦不住、但能拦住这次多余请求。
    if (completedRef.current) return;
    try {
      const res = await getRemediationQuestions();
      if (res.questions.length === 0) {
        handleCompleted();
      } else {
        // 还有本轮答错的题：换轮次重挂 runner 再战
        setData(res);
        setRound((r) => r + 1);
      }
    } catch {
      // 重拉失败：题目与作答进度都在服务端，回训练首页重新进入即可续做。
      // 留在原地只会看到 runner 判题态那只 spinner（无 X、无重试），学生无从自救。
      toast('error', '网络不太稳定，请回训练首页重新进入相似题专项');
      guardRef.current = false;
      navigate('/student/training/home', { replace: true });
    }
  }, [handleCompleted, navigate]);

  if (!loaded || !data) return null;

  return (
    <div className="student-theme-container" data-theme="student-day" data-school="junior">
      <div className="relative h-screen flex flex-col p-4 sm:p-6 bg-[var(--bg-page)] text-[var(--text-primary)]">
        <PageHeader
          to="/student/training/home"
          caption="返回训练"
          title={`相似题专项 · 已答对 ${data.correctCount}/${data.itemCount}`}
          className="shrink-0 mb-4"
        />

        {/* 答题区与草稿面板并排：草稿占真实空间，答题列随之被挤窄 */}
        <div className="flex-1 min-h-0 flex">
          <div className="flex-1 min-w-0 min-h-0 flex flex-col">
            <QuestionRunner
              key={round}
              questions={questions}
              subjectId={MATH_SUBJECT_ID}
              draftKeyPrefix="rem"
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
              draftKeyPrefix="rem"
              onClose={() => setDraftOpen(false)}
            />
          )}
        </div>

        {/* 草稿入口：背景层右上角 absolute，仅面板收起时显示。
            DOM 顺序：草稿这行必须排在 DiscussDrawer 之前——讨论抽屉要盖住它、关闭钮才可点
            （同 TargetedRunPage 的层级说明）。 */}
        {!draftOpen && (
          <div className="absolute top-4 right-4">
            <DraftIconButton onClick={() => setDraftOpen(true)} />
          </div>
        )}
        {discussQ && (
          <DiscussDrawer
            mode="training"
            questionText={discussQ.text}
            questionId={Number(discussQ.n)}
            onClose={() => setDiscussQ(null)}
          />
        )}

        {/* X 退出确认（带已答进度）：进度已落库，故文案不说「不再保留」 */}
        {exitConfirm.open && (
          <Modal open onClose={() => setExitConfirm({ open: false, answered: 0 })} title="退出练习">
            <p className="text-sm text-[var(--text-secondary)]">
              已答 {exitConfirm.answered}/{questions.length} 题，退出后可在训练首页继续相似题专项练习。确定退出吗？
            </p>
            <div className="mt-6 flex justify-end gap-3">
              <button
                onClick={() => setExitConfirm({ open: false, answered: 0 })}
                className="h-10 px-4 rounded-[var(--radius-button)] border border-[var(--bg-subtle)] text-sm text-[var(--text-secondary)] transition-colors hover:bg-[var(--bg-base)]"
              >
                继续答题
              </button>
              <button
                onClick={() => {
                  guardRef.current = false;
                  navigate('/student/training/home', { replace: true });
                }}
                className="h-10 px-4 rounded-[var(--radius-button)] bg-[var(--brand-500)] text-sm font-semibold text-white transition-colors hover:bg-[var(--brand-600)]"
              >
                确认退出
              </button>
            </div>
          </Modal>
        )}

        {/* 浏览器返回/路由跳转拦截（X 确认已同步置 guardRef.current=false 故不二次弹） */}
        <RunExitGuard
          guardRef={guardRef}
          title="离开练习"
          message="相似题练习进度已保存，离开后可在训练首页继续。"
          confirmLabel="确认离开"
        />
      </div>
    </div>
  );
}
