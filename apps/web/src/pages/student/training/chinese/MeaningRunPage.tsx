import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { PageHeader } from '@/components/base';
import { RunExitGuard } from '@/components/business/answer/RunExitGuard';
import { judgeMeaning, type MeaningPassageDetail } from '@/services/api';
import { AnswerBlock } from '@/components/business/meaning/AnswerBlock';
import ResultStack from '@/components/business/meaning/ResultStack';
import PassageOverviewBar from '@/components/business/meaning/PassageOverviewBar';
import type { MeaningAnswerPayload, StackItem } from '@/components/business/meaning/types';

/**
 * 古诗含义答题页：**一次只出一句**，上方是固定位置的作答区，下方是倒序结果栈。
 *
 * 判题异步不阻塞：点「提交」立刻在结果栈 unshift 一条 pending、作答区马上推进到
 * 下一句，模型回来再原地替换。所以学生不会卡着等，连点快速划过也没问题
 * （空答案由服务端短路成 unanswered，不花 LLM 调用）。
 *
 * 每句各自一个在途令牌（`tokens`）——响应回来时令牌不匹配就丢弃，
 * 防「重新判题」连点导致旧响应覆盖新结果。
 */
export default function MeaningRunPage() {
  const navigate = useNavigate();
  const [passages, setPassages] = useState<MeaningPassageDetail[] | null>(null);
  const [pIdx, setPIdx] = useState(0);
  /** 在「可作答句子」列表里的位置——answerable:false 的句子直接跳过 */
  const [cursor, setCursor] = useState(0);
  const [stack, setStack] = useState<StackItem[]>([]);
  const tokens = useRef<Record<number, number>>({});
  const guardRef = useRef(true);

  useEffect(() => {
    const raw = sessionStorage.getItem('training:meaning');
    if (!raw) { navigate('/student/training/chinese/meaning', { replace: true }); return; }
    try {
      const parsed: unknown = JSON.parse(raw);
      if (!Array.isArray(parsed) || parsed.length === 0) {
        navigate('/student/training/chinese/meaning', { replace: true });
        return;
      }
      setPassages(parsed as MeaningPassageDetail[]);
    } catch {
      navigate('/student/training/chinese/meaning', { replace: true });
    }
  }, [navigate]);

  const passage = passages?.[pIdx] ?? null;
  const answerableIdx = useMemo(
    () => (passage ? passage.sentences.filter((s) => s.answerable).map((s) => s.index) : []),
    [passage],
  );
  const currentIndex = answerableIdx[cursor] ?? -1;
  const currentSentence = passage?.sentences.find((s) => s.index === currentIndex) ?? null;
  const finished = answerableIdx.length > 0 && cursor >= answerableIdx.length;

  const runJudge = async (sentenceIndex: number, answer: MeaningAnswerPayload) => {
    const passageId = passage!.passageId;
    const token = (tokens.current[sentenceIndex] ?? 0) + 1;
    tokens.current[sentenceIndex] = token;
    const key = `${sentenceIndex}-${token}`;
    const text = passage!.sentences.find((s) => s.index === sentenceIndex)?.text ?? '';

    // 新项 unshift 到头部 → 最新的一次排在最前（设计 spec §7.3「倒序」）。
    // 该句已经在栈里（重新判题）则**原地替换** —— 挪到头部会把句子顺序打乱。
    setStack((prev) => {
      const at = prev.findIndex((it) => it.sentenceIndex === sentenceIndex);
      const fresh: StackItem = { kind: 'pending', key, sentenceIndex, text, answer };
      if (at < 0) return [fresh, ...prev];
      const next = [...prev];
      next[at] = fresh;
      return next;
    });

    try {
      const res = await judgeMeaning({ passageId, sentenceIndex, ...answer });
      if (tokens.current[sentenceIndex] !== token) return;   // 过期响应丢弃
      setStack((prev) => prev.map((it) => (
        it.key === key ? { kind: 'judged', key, sentenceIndex, text, answer, result: res } : it
      )));
    } catch {
      if (tokens.current[sentenceIndex] !== token) return;
      setStack((prev) => prev.map((it) => (
        it.key === key ? { kind: 'failed', key, sentenceIndex, text, answer } : it
      )));
    }
  };

  const handleSubmit = (answer: MeaningAnswerPayload) => {
    if (currentIndex < 0) return;
    void runJudge(currentIndex, answer);
    setCursor((c) => c + 1);          // 送判但**不等它回来**，立刻推进
  };

  const handleRetry = (sentenceIndex: number) => {
    const item = stack.find((it) => it.sentenceIndex === sentenceIndex);
    if (!item) return;
    void runJudge(sentenceIndex, item.answer);
  };

  const resetForNextPassage = () => {
    tokens.current = {};
    setCursor(0);
    setStack([]);                      // 结果栈每首清空重来（设计 spec §7.3）
  };

  const handlePassageDone = () => {
    if (passages && pIdx < passages.length - 1) {
      setPIdx(pIdx + 1);
      resetForNextPassage();
      return;
    }
    guardRef.current = false;
    sessionStorage.removeItem('training:meaning');
    navigate('/student/training/chinese/special', { replace: true });
  };

  /** 已作答的句子（含还在判定的 pending 与 failed —— 答过了，只是还没判出来）→ 原文条置灰 */
  const answeredIndexes = useMemo(
    () => new Set(stack.map((it) => it.sentenceIndex)),
    [stack],
  );

  const stats = useMemo(() => {
    const s = { termRight: 0, termWrong: 0, termUndet: 0,
                meanRight: 0, meanWrong: 0, meanUndet: 0,
                emoRight: 0, emoWrong: 0, emoUndet: 0 };
    const bump = (c: boolean | null, p: 'term' | 'mean' | 'emo') => {
      if (c === true) s[`${p}Right`]++;
      else if (c === false) s[`${p}Wrong`]++;
      else s[`${p}Undet`]++;
    };
    for (const it of stack) {
      if (it.kind !== 'judged') continue;
      for (const t of it.result.terms) bump(t.correct, 'term');
      bump(it.result.meaning.correct, 'mean');
      bump(it.result.emotion.correct, 'emo');
    }
    return s;
  }, [stack]);

  const anyPending = stack.some((it) => it.kind === 'pending');

  if (!passage) return null;

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
        message="离开后本篇已作答的内容不会保留。"
        confirmLabel="确认离开"
        cancelLabel="继续答题"
      />

      <div className="w-full max-w-3xl px-4 sm:px-8 py-10">
        <PageHeader
          to="/student/training/chinese/meaning"
          caption="退出"
          title="古诗含义"
          titleClassName="text-4xl font-extrabold"
        />

        <p className="mt-6 text-sm text-[var(--text-secondary)]">
          《{passage.workTitle}》{'\u3000'}
          {passages && passages.length > 1 ? `第 ${pIdx + 1} / ${passages.length} 首 · ` : ''}
          第 {Math.min(cursor + 1, answerableIdx.length)} / {answerableIdx.length} 句
        </p>

        <div className="mt-4">
          <PassageOverviewBar
            sentences={passage.sentences}
            currentIndex={currentIndex}
            judgedIndexes={answeredIndexes}
          />
        </div>

        <div className="mt-5">
          {!finished && currentSentence ? (
            <AnswerBlock key={currentSentence.index} sentence={currentSentence} onSubmit={handleSubmit} />
          ) : (
            <div className="rounded-2xl bg-white p-6" style={{ border: '1px solid rgba(226, 232, 240, 0.8)' }}>
              <h3 className="text-lg font-bold text-[var(--text-primary)]">本篇完成</h3>
              {anyPending && (
                <p className="mt-2 text-sm text-[var(--text-secondary)]">还有句子在判题中，结果会自动补上。</p>
              )}
              <ul className="mt-3 flex flex-col gap-1 text-sm text-[var(--text-secondary)]">
                <li>重点字词：对 {stats.termRight} · 错 {stats.termWrong}{stats.termUndet > 0 ? ` · 未判定 ${stats.termUndet}` : ''}</li>
                <li>深层含义：对 {stats.meanRight} · 错 {stats.meanWrong}{stats.meanUndet > 0 ? ` · 未判定 ${stats.meanUndet}` : ''}</li>
                <li>作者情感：对 {stats.emoRight} · 错 {stats.emoWrong}{stats.emoUndet > 0 ? ` · 未判定 ${stats.emoUndet}` : ''}</li>
              </ul>
              <button
                onClick={handlePassageDone}
                className="mt-6 w-full h-12 rounded-2xl text-white font-bold"
                style={{ backgroundColor: 'var(--brand-500)' }}
              >
                {passages && pIdx < passages.length - 1 ? '下一首' : '完成'}
              </button>
            </div>
          )}
        </div>

        <h3 className="mt-8 text-lg font-bold text-[var(--text-primary)]">作答结果（最新在最前）</h3>
        <div className="mt-3">
          <ResultStack items={stack} onRetry={handleRetry} />
        </div>
      </div>
    </div>
  );
}
