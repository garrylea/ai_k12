import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { PageHeader } from '@/components/base';
import { CelebrationOverlay } from '@/components/business';
import { RunExitGuard } from '@/components/business/answer/RunExitGuard';
import WordPromptCard from '@/components/business/vocabulary/WordPromptCard';
import AnswerFeedList, { type FeedEntry } from '@/components/business/vocabulary/AnswerFeedList';
import {
  clearVocabularyWordProgress,
  fetchWordFamily,
  judgeVocabularyWord,
  type VocabularyJudgeResult,
  type VocabularyQuestionItem,
  type WordFamilyResult,
} from '@/services/api';
import { parseRunHandoff } from '../run-handoff';
import { useSessionPointsCompletion } from '../session-completion';
import { SessionPointsRetryNotice } from '../SessionPointsRetryNotice';

/**
 * 背单词答题页。
 *
 * **异步判定就落在这里**：提交后立刻翻到下一个词，**不等判定回来**（judge 可能调模型，
 * 耗时不定）；结果回来再回填到底部累积清单（AnswerFeedList）。这与古诗文解释页同构
 * （同样的「送判但不 await」+ 就地回填），学生不会卡着等，连点快速划过也没问题。
 *
 * 每道题的 `answer` 只在内存里，**不落 sessionStorage**：刷新即重来是刻意的
 * （进度已写库，「今日已背」不会丢，见配置页）。
 *
 * 题单经 sessionStorage 交接（镜像两个语文答题页）；空题单踢回配置页。
 */
export default function VocabularyRunPage() {
  const navigate = useNavigate();
  const [questions, setQuestions] = useState<VocabularyQuestionItem[] | null>(null);
  const [idx, setIdx] = useState(0);
  const [drafts, setDrafts] = useState<Record<number, string>>({});
  const [entries, setEntries] = useState<FeedEntry[]>([]);
  const [feedCollapsed, setFeedCollapsed] = useState(false);
  const [cleared, setCleared] = useState<Record<number, boolean>>({});
  const [finished, setFinished] = useState(false);
  // 配置页交接来的会话 id：收尾发分的唯一凭据；null = 会话 INSERT 降级（不发分）
  const [sessionId, setSessionId] = useState<number | null>(null);

  // 词根族：只缓存当前展开的那个词，翻页即收起
  const [familyOpen, setFamilyOpen] = useState(false);
  const [family, setFamily] = useState<WordFamilyResult | null>(null);
  const [familyLoading, setFamilyLoading] = useState(false);
  const [familyFailed, setFamilyFailed] = useState(false);

  // 同一题重复提交的守卫（回车连按两下不该判两次）
  const submittedRef = useRef<Set<number>>(new Set());
  // 连击守卫：提交后卡片立刻换成下一个词，快速双击的第二下会落在**下一题**上、
  // 把它当成空作答交出去。250ms 足够吞掉双击，又短到不会挡住正常答题节奏。
  const lastSubmitAtRef = useRef(0);
  const guardRef = useRef(true);

  // 完成发分（乙类会话页唯一入口）：最后一个词提交、finished 变 true 的那一刻调 complete。
  // 注意本页判题是「提交即翻页、判定异步回填」，完成点**不是**最后一次判题返回——
  // 等模型回来再发分会把学生卡在成绩页。sessionId 为 null 时 hook 内部直接跳过。
  const { complete: completeSession, retry, needsRetry, retrying, celebrationProps } =
    useSessionPointsCompletion(sessionId, `英语背单词 · ${questions?.length ?? 0} 词`);

  useEffect(() => {
    const handoff = parseRunHandoff<VocabularyQuestionItem>(
      sessionStorage.getItem('training:vocabulary'),
    );
    // 形状不对 / 解析失败 / 空词单一律视为「空题单」踢回配置页
    if (!handoff || handoff.questions.length === 0) {
      navigate('/student/training/english/vocabulary', { replace: true });
      return;
    }
    setQuestions(handoff.questions);
    setSessionId(handoff.sessionId);
    setEntries(handoff.questions.map((q) => ({ question: q, answer: '', submitted: false })));
  }, [navigate]);

  // finished 变 true 即收尾（内部 startedRef 防重入，StrictMode 双跑也只发一次）
  useEffect(() => {
    if (finished) completeSession();
  }, [finished, completeSession]);

  const question = questions?.[idx] ?? null;

  /** 判题（fire-and-forget）：结果按题目下标回填，失败只标记不打断 */
  const judgeAt = (index: number, answer: string, q: VocabularyQuestionItem) => {
    void judgeVocabularyWord({
      wordId: q.wordId,
      senseIndex: q.senseIndex,
      promptKind: q.promptKind,
      answer,
    })
      .then((result: VocabularyJudgeResult) => {
        setEntries((prev) =>
          prev.map((e, i) => (i === index ? { ...e, result } : e)),
        );
      })
      .catch(() => {
        setEntries((prev) => prev.map((e, i) => (i === index ? { ...e, failed: true } : e)));
      });
  };

  const advance = (index: number) => {
    if (questions && index < questions.length - 1) {
      setIdx(index + 1);
      setFamilyOpen(false);
      setFamily(null);
      setFamilyFailed(false);
      return;
    }
    setFinished(true);
    guardRef.current = false;
  };

  const submit = (index: number, overrideAnswer?: string) => {
    if (!questions || submittedRef.current.has(index)) return;
    const now = Date.now();
    if (now - lastSubmitAtRef.current < 250) return;
    lastSubmitAtRef.current = now;
    const q = questions[index];
    const answer = overrideAnswer ?? drafts[index] ?? '';
    submittedRef.current.add(index);
    setEntries((prev) => prev.map((e, i) => (i === index ? { ...e, answer, submitted: true } : e)));
    judgeAt(index, answer, q);
    advance(index);
  };

  const handleClearMark = (wordId: number) => {
    setCleared((prev) => ({ ...prev, [wordId]: true }));
    void clearVocabularyWordProgress(wordId).catch(() => {
      // 失败就撤回本地标记，免得学生以为已经清掉了
      setCleared((prev) => ({ ...prev, [wordId]: false }));
    });
  };

  const handleToggleFamily = () => {
    if (!question) return;
    const next = !familyOpen;
    setFamilyOpen(next);
    if (!next || family || familyLoading) return;
    setFamilyLoading(true);
    setFamilyFailed(false);
    void fetchWordFamily(question.wordId)
      .then((res) => setFamily(res))
      .catch(() => setFamilyFailed(true))
      .finally(() => setFamilyLoading(false));
  };

  const handleFinish = () => {
    guardRef.current = false;
    sessionStorage.removeItem('training:vocabulary');
    navigate('/student/training/english/vocabulary', { replace: true });
  };

  const summary = useMemo(
    () =>
      entries.reduce(
        (acc, e) => {
          const v = e.result?.verdict;
          if (v === 'correct') acc.correct += 1;
          else if (v === 'off_target') acc.offTarget += 1;
          else if (v === 'wrong') acc.wrong += 1;
          return acc;
        },
        { correct: 0, offTarget: 0, wrong: 0 },
      ),
    [entries],
  );

  if (!questions) return null;

  return (
    <div
      data-theme="student-day"
      data-school="junior"
      className="student-theme-container min-h-screen flex flex-col items-center p-4"
      style={{ backgroundColor: 'var(--bg-page)' }}
    >
      <RunExitGuard
        guardRef={guardRef}
        title="确认离开？"
        message="离开后本轮已作答的记录不会保留（背过的词与错题统计已经记录，不会丢）。"
        confirmLabel="确认离开"
        cancelLabel="继续背词"
      />

      <div className="w-full max-w-3xl px-4 sm:px-8 py-10">
        <PageHeader
          to="/student/training/english/vocabulary"
          caption="退出"
          title="背单词"
          titleClassName="text-4xl font-extrabold"
        />

        <p className="mt-6 text-sm text-[var(--text-secondary)]">
          {finished ? '本轮完成' : `第 ${idx + 1} / ${questions.length} 个`}
        </p>

        {!finished && question && (
          <div className="mt-5">
            <WordPromptCard
              question={question}
              value={drafts[idx] ?? ''}
              onChange={(v) => setDrafts((prev) => ({ ...prev, [idx]: v }))}
              onSubmit={() => submit(idx)}
              onSkip={() => submit(idx, '')}
              familyOpen={familyOpen}
              family={family}
              familyLoading={familyLoading}
              familyFailed={familyFailed}
              onToggleFamily={handleToggleFamily}
            />
          </div>
        )}

        {finished && (
          <div
            className="mt-5 rounded-2xl bg-white p-6"
            style={{ border: '1px solid rgba(226, 232, 240, 0.8)' }}
          >
            <h3 className="text-lg font-bold text-[var(--text-primary)]">本轮成绩</h3>
            <p className="mt-3 text-sm text-[var(--text-secondary)]">
              共 {questions.length} 个词 · 答对{' '}
              <span className="font-bold text-[var(--success)]">{summary.correct}</span> · 未答到考点{' '}
              <span className="font-bold text-[var(--warning)]">{summary.offTarget}</span> · 答错{' '}
              <span className="font-bold text-[var(--error)]">{summary.wrong}</span>
            </p>
            <p className="mt-2 text-xs text-[var(--text-secondary)]">
              「未答到考点」是熟词僻义题里答成了常见义——你答的没错，只是没考到那个意思，不计错。
            </p>
            {/* 发分失败（award_failed / 网络异常）：不弹负反馈，给一个可再点的出口 */}
            {needsRetry && (
              <div className="mt-4">
                <SessionPointsRetryNotice retrying={retrying} onRetry={retry} />
              </div>
            )}
            <button
              onClick={handleFinish}
              className="mt-6 h-12 w-full rounded-2xl text-white font-bold"
              style={{ backgroundColor: 'var(--brand-500)' }}
            >
              完成
            </button>
          </div>
        )}

        <AnswerFeedList
          entries={entries}
          collapsed={feedCollapsed}
          onToggleCollapsed={() => setFeedCollapsed((v) => !v)}
          onClearMark={handleClearMark}
          cleared={cleared}
        />
      </div>

      {/* 段位晋升全屏庆祝（决策表在 points-feedback，本页不自己判断何时弹） */}
      <CelebrationOverlay {...celebrationProps} />
    </div>
  );
}
