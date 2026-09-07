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
  getTrainingHint,
  judgeTraining,
  markTrainingHidden,
  type TargetedPracticeQuestion,
} from '@/services/api';
import { toast } from '@/components/base/Toast';
import { normalizeOptions } from './normalizeOptions';

/** 数学 subject_id（tools/db/schema.sql subjects seed 首行）——训练轨 MVP 仅数学。 */
const MATH_SUBJECT_ID = 1;

/** 配置页写入的题单键（读后即删，防止刷新后重复进入旧题单）。 */
const SESSION_KEY = 'training:targeted';

type Phase = 'answering' | 'result';

export default function TargetedRunPage() {
  const navigate = useNavigate();

  const [phase, setPhase] = useState<Phase>('answering');
  const [hints, setHints] = useState<Record<string, string>>({});
  const [finalResults, setFinalResults] = useState<Record<string, RunnerAnswerRecord> | null>(null);
  // 「讲一讲」抽屉：打开时锚定当时题面（DiscussDrawer training 模式只需题面文本）
  const [discussQ, setDiscussQ] = useState<RunnerQuestion | null>(null);
  // 页面级草稿抽屉：始终可见图标，切题即清空（草稿不保存）；currentQ 由 QuestionRunner.onQuestionChange 喂
  const [draftOpen, setDraftOpen] = useState(false);
  const [currentQ, setCurrentQ] = useState<RunnerQuestion | null>(null);
  // 退出确认（X 按钮）：answered 由 QuestionRunner 传出
  const [exitConfirm, setExitConfirm] = useState<{ open: boolean; answered: number }>({ open: false, answered: 0 });
  // 「不再展示」确认 Modal：open 时锚定当前题 questionId
  const [markConfirm, setMarkConfirm] = useState<{ open: boolean; questionId: number | null }>(
    { open: false, questionId: null },
  );
  const [marking, setMarking] = useState(false);
  // X 确认后放行导航（同步置 ref.current=false 再 navigate，绕开 RunExitGuard 二次拦截——ref 是同步生效的）
  const guardRef = useRef(true);
  // null = mount 读取中（本页无异步请求，仅同步解析 sessionStorage 后立即落值）
  const [entries, setEntries] = useState<TargetedPracticeQuestion[] | null>(null);

  // StrictMode 下 effect 会跑两次：ref 守卫保证「读 + 删」只执行一次，
  // 否则第二次读到空会误判为无题单而踢回配置页。
  const bootstrappedRef = useRef(false);

  useEffect(() => {
    if (bootstrappedRef.current) return;
    bootstrappedRef.current = true;

    let parsed: TargetedPracticeQuestion[] = [];
    try {
      const raw = sessionStorage.getItem(SESSION_KEY);
      if (raw) {
        const value: unknown = JSON.parse(raw);
        if (Array.isArray(value)) parsed = value as TargetedPracticeQuestion[];
      }
    } catch {
      // 解析失败视为空题单，回配置页
    }
    // 读后即删：无论内容是否有效都清掉，避免刷新/回退后带着旧题单重复进入
    sessionStorage.removeItem(SESSION_KEY);
    setEntries(parsed);
  }, []);

  // 空题单（直接访问 / 解析失败 / 刷新后读不到）回配置页
  useEffect(() => {
    if (entries !== null && entries.length === 0) {
      navigate('/student/training/targeted', { replace: true });
    }
  }, [entries, navigate]);

  // n（= String(questionId)）-> 题单条目映射
  const entryByN = useMemo(() => {
    const map = new Map<string, TargetedPracticeQuestion>();
    for (const e of entries ?? []) map.set(String(e.questionId), e);
    return map;
  }, [entries]);

  const questions: RunnerQuestion[] = useMemo(
    () =>
      (entries ?? []).map((e) => ({
        n: String(e.questionId),
        text: e.text,
        type: e.type,
        options: normalizeOptions(e.options),
      })),
    [entries],
  );

  // AnswerResultList 的题目输入（n/text 与 RunnerQuestion 一致，共用 questionId 键）
  const resultQuestions: PracticeQuestion[] = useMemo(
    () => (entries ?? []).map((e) => ({ n: String(e.questionId), text: e.text })),
    [entries],
  );

  const handleSubmit = useCallback(
    async (q: RunnerQuestion, answer: string) => {
      const entry = entryByN.get(q.n);
      if (!entry) {
        throw new Error('题单条目缺失，无法判题');
      }
      return judgeTraining({
        questionId: entry.questionId,
        subjectId: MATH_SUBJECT_ID,
        studentAnswer: answer,
        source: 'targeted',
      });
    },
    [entryByN],
  );

  const handleRequestHint = useCallback(
    async (q: RunnerQuestion) => {
      const entry = entryByN.get(q.n);
      if (!entry) {
        throw new Error('题单条目缺失，无法获取提示');
      }
      // 后端可能 503（AI 不可用）：直接 rethrow，QuestionRunner 内部 catch 置 hintState.error
      const res = await getTrainingHint(entry.questionId);
      setHints((prev) => ({ ...prev, [q.n]: res.hint }));
      return res.hint;
    },
    [entryByN],
  );

  const handleFinish = useCallback(async (results: Record<string, RunnerAnswerRecord>) => {
    setFinalResults(results);
    // 与错题重做的差异点：专项练习答错已由后端 judge 端点自动入错题本，
    // 收尾无需 bump，直接进结果页。
    setPhase('result');
  }, []);

  const confirmMarkHidden = useCallback(async () => {
    if (markConfirm.questionId == null) return;
    setMarking(true);
    try {
      await markTrainingHidden({ questionId: markConfirm.questionId, subjectId: MATH_SUBJECT_ID });
      toast('success', '已加入不再展示清单');
    } catch (err) {
      toast('error', err instanceof Error ? err.message : '标记失败，请重试');
    } finally {
      setMarking(false);
      setMarkConfirm({ open: false, questionId: null });
    }
  }, [markConfirm.questionId]);

  // mount 读取中 / 空题单（正在被踢回配置页）：不渲染内容
  if (entries == null || entries.length === 0) return null;

  return (
    <div className="student-theme-container" data-theme="student-day" data-school="junior">
      <div className="relative h-screen flex flex-col p-4 sm:p-6 bg-[var(--bg-page)] text-[var(--text-primary)]">
        {phase === 'result' ? (
          <AnswerResultList
            questions={resultQuestions}
            answers={finalResults ?? {}}
            onClose={() => navigate('/student/training/targeted')}
          />
        ) : (
          <>
            <QuestionRunner
              questions={questions}
              subjectId={MATH_SUBJECT_ID}
              draftKeyPrefix="tp"
              variant="embedded"
              enableHint
              hints={hints}
              onRequestHint={handleRequestHint}
              headerActions={(q) => (
                <DiscussIconButton onClick={() => setDiscussQ(q)} />
              )}
              questionMetaActions={(q) => {
                const qid = Number(q.n);
                return (
                  <button
                    type="button"
                    disabled={marking}
                    onClick={() => setMarkConfirm({ open: true, questionId: qid })}
                    title="不再展示"
                    aria-label="不再展示这道题"
                    className="w-[38px] h-[38px] rounded-xl border border-[var(--bg-subtle)] bg-[var(--learn-card-bg)] flex items-center justify-center text-[var(--text-secondary)] shadow-sm hover:bg-[var(--bg-base)] transition-colors"
                  >
                    {/* 眼斜杠图标（线性 SVG）——视觉权重低于提示/讲一讲 */}
                    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M9.88 9.88a3 3 0 1 0 4.24 4.24" />
                      <path d="M10.73 5.08A10.43 10.43 0 0 1 12 5c7 0 10 7 10 7a13.16 13.16 0 0 1-1.67 2.68" />
                      <path d="M6.61 6.61A13.526 13.526 0 0 0 2 12s3 7 10 7a9.74 9.74 0 0 0 5.39-1.61" />
                      <line x1="2" y1="2" x2="22" y2="22" />
                    </svg>
                  </button>
                );
              }}
              onSubmit={handleSubmit}
              onFinish={handleFinish}
              onQuestionChange={setCurrentQ}
              onClose={(answered) => setExitConfirm({ open: true, answered })}
            />
            {discussQ && phase === 'answering' && (
              <DiscussDrawer
                mode="training"
                questionText={discussQ.text}
                questionId={Number(discussQ.n)}
                onClose={() => setDiscussQ(null)}
              />
            )}
            {/* 草稿入口：页面背景层右上角，absolute 定位；DOM 排在抽屉前，抽屉打开时自然盖住图标 */}
            <div className="absolute top-4 right-4">
              <DraftIconButton onClick={() => setDraftOpen(true)} />
            </div>
            {draftOpen && currentQ && (
              <DraftDrawer
                questionId={currentQ.n}
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
                  navigate('/student/training/targeted', { replace: true });
                }}
                className="h-10 px-4 rounded-[var(--radius-button)] bg-[var(--brand-500)] text-sm font-semibold text-white transition-colors hover:bg-[var(--brand-600)]"
              >
                确认退出
              </button>
            </div>
          </Modal>
        )}
        {/* 「不再展示」确认 */}
        {markConfirm.open && (
          <Modal
            open
            onClose={() => setMarkConfirm({ open: false, questionId: null })}
            title="不再展示"
          >
            <p className="text-sm text-[var(--text-secondary)]">
              标记后，下次专项练习将不再抽到这道题。当前题仍可继续作答。可在「专项练习」配置页的「我的不再展示清单」中撤销。
            </p>
            <div className="mt-6 flex justify-end gap-3">
              <button
                onClick={() => setMarkConfirm({ open: false, questionId: null })}
                className="h-10 px-4 rounded-[var(--radius-button)] border border-[var(--bg-subtle)] text-sm text-[var(--text-secondary)] transition-colors hover:bg-[var(--bg-base)]"
              >
                取消
              </button>
              <button
                onClick={() => void confirmMarkHidden()}
                disabled={marking}
                className="h-10 px-4 rounded-[var(--radius-button)] bg-[var(--brand-500)] text-sm font-semibold text-white transition-colors hover:bg-[var(--brand-600)] disabled:opacity-50"
              >
                {marking ? '提交中…' : '确认不再展示'}
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
