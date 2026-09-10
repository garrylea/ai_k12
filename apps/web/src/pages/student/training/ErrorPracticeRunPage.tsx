import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { QuestionRunner } from '@/components/business/answer/QuestionRunner';
import type { RunnerAnswerRecord, RunnerQuestion } from '@/components/business/answer/types';
import { AnswerResultList } from '@/components/business/AnswerResultList';
import { DiscussDrawer, DiscussIconButton } from '@/components/business/DiscussDrawer';
import { DraftDrawer, DraftIconButton } from '@/components/business/DraftDrawer';
import { RunExitGuard } from '@/components/business/answer/RunExitGuard';
import { Modal } from '@/components/base';
import type { PracticeQuestion } from '@/components/business/AnswerModal';
import {
  bumpTrainingErrorLevels,
  getTrainingExplanations,
  getTrainingHint,
  judgeTraining,
  selfAssessTraining,
  waitTrainingExplanation,
  type TrainingErrorBookEntry,
} from '@/services/api';
import { normalizeOptions } from './normalizeOptions';

/** 数学 subject_id（tools/db/schema.sql subjects seed 首行）——训练轨 MVP 仅数学。 */
const MATH_SUBJECT_ID = 1;

/** 列表页写入的题单键（读后即删，防止刷新后重复进入旧题单）。 */
const SESSION_KEY = 'training:errors';

type Phase = 'answering' | 'result';

export default function ErrorPracticeRunPage() {
  const navigate = useNavigate();

  const [phase, setPhase] = useState<Phase>('answering');
  const [hints, setHints] = useState<Record<string, string>>({});
  const [finalResults, setFinalResults] = useState<Record<string, RunnerAnswerRecord> | null>(null);
  // 「讲一讲」抽屉：打开时锚定当时题面（DiscussDrawer training 模式只需题面文本）
  const [discussQ, setDiscussQ] = useState<RunnerQuestion | null>(null);
  // 页面级草稿抽屉：始终可见图标，切题即清空（草稿不保存）
  const [draftOpen, setDraftOpen] = useState(false);
  const [currentQ, setCurrentQ] = useState<RunnerQuestion | null>(null);
  // 退出确认（X 按钮）：answered 由 QuestionRunner 传出
  const [exitConfirm, setExitConfirm] = useState<{ open: boolean; answered: number }>({ open: false, answered: 0 });
  // X 确认后放行导航（同步置 ref.current=false 再 navigate，绕开 RunExitGuard 二次拦截——ref 是同步生效的）
  const guardRef = useRef(true);
  // null = mount 读取中（本页无异步请求，仅同步解析 sessionStorage 后立即落值）
  const [entries, setEntries] = useState<TrainingErrorBookEntry[] | null>(null);
  // 结果页错题解析：末题后批量拉取（key = q.n）；孤儿题（questionId null）无解析不拉
  const [explanations, setExplanations] = useState<Record<string, string | null>>({});

  // StrictMode 下 effect 会跑两次：ref 守卫保证「读 + 删」只执行一次，
  // 否则第二次读到空会误判为无题单而踢回列表页。
  const bootstrappedRef = useRef(false);

  useEffect(() => {
    if (bootstrappedRef.current) return;
    bootstrappedRef.current = true;

    let parsed: TrainingErrorBookEntry[] = [];
    try {
      const raw = sessionStorage.getItem(SESSION_KEY);
      if (raw) {
        const value: unknown = JSON.parse(raw);
        if (Array.isArray(value)) parsed = value as TrainingErrorBookEntry[];
      }
    } catch {
      // 解析失败视为空题单，回列表页
    }
    // 读后即删：无论内容是否有效都清掉，避免刷新/回退后带着旧题单重复进入
    sessionStorage.removeItem(SESSION_KEY);
    setEntries(parsed);
  }, []);

  // 空题单（直接访问 / 解析失败 / 刷新后读不到）回列表页
  useEffect(() => {
    if (entries !== null && entries.length === 0) {
      navigate('/student/training/errors', { replace: true });
    }
  }, [entries, navigate]);

  // n（= String(errorBookId)）-> 错题条目映射
  const entryByN = useMemo(() => {
    const map = new Map<string, TrainingErrorBookEntry>();
    for (const e of entries ?? []) map.set(String(e.errorBookId), e);
    return map;
  }, [entries]);

  const questions: RunnerQuestion[] = useMemo(
    () =>
      (entries ?? []).map((e) => ({
        n: String(e.errorBookId),
        text: e.questionText,
        type: e.type ?? undefined,
        options: normalizeOptions(e.options),
      })),
    [entries],
  );

  // AnswerResultList 的题目输入（n/text 与 RunnerQuestion 一致，共用 errorBookId 键）
  const resultQuestions: PracticeQuestion[] = useMemo(
    () => (entries ?? []).map((e) => ({ n: String(e.errorBookId), text: e.questionText })),
    [entries],
  );

  const handleSubmit = useCallback(
    async (q: RunnerQuestion, answer: string) => {
      const entry = entryByN.get(q.n);
      // Task 4 列表页已禁选孤儿题（questionId 为空进不了题单）
      if (!entry || entry.questionId == null) {
        throw new Error('该题未入库，无法判题');
      }
      return judgeTraining({
        questionId: entry.questionId,
        subjectId: MATH_SUBJECT_ID,
        studentAnswer: answer,
        source: 'error_practice',
      });
    },
    [entryByN],
  );

  const handleRequestHint = useCallback(
    async (q: RunnerQuestion) => {
      const entry = entryByN.get(q.n);
      if (!entry || entry.questionId == null) {
        throw new Error('该题未入库，无法获取提示');
      }
      // 后端可能 503（AI 不可用）：直接 rethrow，QuestionRunner 内部 catch 置 hintState.error
      const res = await getTrainingHint(entry.questionId);
      setHints((prev) => ({ ...prev, [q.n]: res.hint }));
      return res.hint;
    },
    [entryByN],
  );

  const handleFinish = useCallback(
    async (results: Record<string, RunnerAnswerRecord>) => {
      setFinalResults(results);

      // 仍错的题：递增错题级别（答对的由后端 judge 端点清零，failed 不算答错不 bump）
      const stillWrongIds = (entries ?? [])
        .filter((e) => {
          const r = results[String(e.errorBookId)];
          return r && !r.isCorrect && !r.failed;
        })
        .map((e) => e.errorBookId);

      if (stillWrongIds.length > 0) {
        try {
          await bumpTrainingErrorLevels(stillWrongIds);
        } catch {
          // best-effort：bump 失败不阻断结果页
        }
      }

      // 错题批量拉解析（后端等 in-flight 生成，60s 兜底）：孤儿题（questionId null）无解析不拉。
      // 客观题答错 + 主观题（self_assess，无论自评对错）都要解析。
      const wrongQids: number[] = [];
      for (const e of entries ?? []) {
        const r = results[String(e.errorBookId)];
        if (e.questionId == null || !r || r.failed) continue;
        if (!r.isCorrect || r.method === 'self_assess') wrongQids.push(e.questionId);
      }
      let expls: Record<number, string | null> = {};
      if (wrongQids.length > 0) {
        try {
          expls = (await getTrainingExplanations(wrongQids)).explanations;
        } catch {
          // 拉取失败视为全部未生成，结果页显示「正在生成中 + 刷新」
        }
      }
      const byN: Record<string, string | null> = {};
      for (const e of entries ?? []) {
        if (e.questionId != null && expls[e.questionId]) byN[String(e.errorBookId)] = expls[e.questionId];
      }
      setExplanations(byN);

      setPhase('result');
    },
    [entries],
  );

  // mount 读取中 / 空题单（正在被踢回列表页）：不渲染内容
  if (entries == null || entries.length === 0) return null;

  return (
    <div className="student-theme-container" data-theme="student-day" data-school="junior">
      <div className="relative h-screen flex flex-col p-4 sm:p-6 bg-[var(--bg-page)] text-[var(--text-primary)]">
        {phase === 'result' ? (
          <AnswerResultList
            questions={resultQuestions}
            answers={finalResults ?? {}}
            initialExplanations={explanations}
            questionIdOf={(n) => entryByN.get(n)?.questionId ?? null}
            onWaitExplanation={async (qid) => {
              const res = await waitTrainingExplanation(qid);
              return res.explanation;
            }}
            onClose={() => navigate('/student/training/errors')}
          />
        ) : (
          <>
            <QuestionRunner
              questions={questions}
              subjectId={MATH_SUBJECT_ID}
              draftKeyPrefix="errp"
              variant="embedded"
              draftDisabled  // 内嵌草稿由页面级草稿抽屉替代（2026-09-07）
              enableHint
              hints={hints}
              onRequestHint={handleRequestHint}
              headerActions={(q) => (
                <DiscussIconButton onClick={() => setDiscussQ(q)} />
              )}
              onSubmit={handleSubmit}
              onSelfAssess={async (q, assessment) => {
                const entry = entryByN.get(q.n);
                // 与判题同款守卫：孤儿题（questionId 为空）进不了自评落库
                if (!entry || entry.questionId == null) throw new Error('该题未入库，无法自评');
                await selfAssessTraining({
                  questionId: entry.questionId,
                  subjectId: MATH_SUBJECT_ID,
                  assessment,
                  source: 'error_practice',
                });
              }}
              onFinish={handleFinish}
              onQuestionChange={setCurrentQ}
              onClose={(answered) => setExitConfirm({ open: true, answered })}
            />
            {/* 草稿入口：页面背景层右上角 absolute 定位。图标 DOM 必须排在各抽屉条件之前——同层兄弟
                z-index 均为 auto（DOM 靠后者绘制在上层），抽屉后渲染才能盖住图标、关闭钮才可点；
                DraftDrawer 条件保持最后，位于 DiscussDrawer 之上。 */}
            <div className="absolute top-4 right-4">
              <DraftIconButton onClick={() => setDraftOpen(true)} />
            </div>
            {discussQ && phase === 'answering' && (
              <DiscussDrawer
                mode="training"
                questionText={discussQ.text}
                // n = errorBookId，需经题单条目反查真实 questionId（孤儿题在列表页已禁选）
                questionId={entryByN.get(discussQ.n)?.questionId ?? undefined}
                onClose={() => setDiscussQ(null)}
              />
            )}
            {draftOpen && currentQ && (
              <DraftDrawer
                questionId={currentQ.n}
                draftKeyPrefix="errp"
                onClose={() => setDraftOpen(false)}
              />
            )}
          </>
        )}

        {/* X 退出确认（带已答进度） */}
        {exitConfirm.open && (
          <Modal open onClose={() => setExitConfirm({ open: false, answered: 0 })} title="退出练习">
            <p className="text-sm text-[var(--text-secondary)]">
              已答 {exitConfirm.answered}/{questions.length} 题，退出后未作答的题目不再保留。确定退出吗？
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
                  navigate('/student/training/errors', { replace: true });
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
          message="退出后未作答的题目将不再保留，确定要离开吗？"
          confirmLabel="确认离开"
        />
      </div>
    </div>
  );
}
