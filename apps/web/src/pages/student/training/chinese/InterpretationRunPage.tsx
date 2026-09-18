import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { PageHeader } from '@/components/base';
import { RunExitGuard } from '@/components/business/answer/RunExitGuard';
import {
  judgeInterpretation,
  type InterpretationJudgeResult,
  type InterpretationPassageDetail,
} from '@/services/api';
import SentenceBlock, {
  type InterpretationAnswerValue,
  type SentenceState,
} from '@/components/business/interpretation/SentenceBlock';
import { CelebrationOverlay } from '@/components/business';
import { usePointsFeedback } from '../points-feedback';

const EMPTY_ANSWER: InterpretationAnswerValue = { terms: {}, translation: '' };

interface ItemStats {
  termRight: number;
  termWrong: number;
  termUndetermined: number;
  sentRight: number;
  sentWrong: number;
  sentUndetermined: number;
}

/**
 * 「重新判题」的结果合并（设计 spec §7「已判定的项不清空」）：
 * 新结果里**未判定**的项若旧值已判出，保留旧值——学生不该因模型抖动丢掉已得的反馈。
 */
function mergeResult(
  prev: InterpretationJudgeResult | undefined,
  next: InterpretationJudgeResult,
): InterpretationJudgeResult {
  if (!prev) return next;
  const pick = <T extends { correct: boolean | null }>(p: T | undefined, n: T): T =>
    n.correct === null && p != null && p.correct !== null ? p : n;
  return {
    ...next,
    terms: next.terms.map((n) => pick(prev.terms.find((p) => p.term === n.term), n)),
    sentence: pick(prev.sentence, next.sentence),
  };
}

function sumStats(results: Array<InterpretationJudgeResult | undefined>): ItemStats {
  const s: ItemStats = {
    termRight: 0, termWrong: 0, termUndetermined: 0,
    sentRight: 0, sentWrong: 0, sentUndetermined: 0,
  };
  for (const r of results) {
    if (!r) continue;
    for (const t of r.terms) {
      if (t.correct === true) s.termRight++;
      else if (t.correct === false) s.termWrong++;
      else s.termUndetermined++;
    }
    if (r.sentence.correct === true) s.sentRight++;
    else if (r.sentence.correct === false) s.sentWrong++;
    else s.sentUndetermined++;
  }
  return s;
}

/**
 * 古诗文解释答题页：**逐句卡片列表 + 三行对译 + 逐句判题**（设计 plan §6.4）。
 *
 * 与默写答题页的关键差别：**不换页**。整篇句子从上到下排开，前面答过的句子留在页面上、
 * 结果就地贴在各输入框下方——翻译题必须看得见上下文，翻页式会把上文弄丢。
 *
 * 判题是**异步不阻塞**的：点「下一句」就把当前这句送出去，**不等模型回来**就展开下一句；
 * 结果回来再原地回填。所以学生不会卡着等，连点快速划过也没问题
 * （空答案由服务端短路成 unanswered，不花 LLM 调用）。
 *
 * 题单经 sessionStorage 交接（镜像 DictationRunPage）；空题单踢回配置页。
 */
export default function InterpretationRunPage() {
  const navigate = useNavigate();
  const [passages, setPassages] = useState<InterpretationPassageDetail[] | null>(null);
  const [pIdx, setPIdx] = useState(0);
  const [currentIdx, setCurrentIdx] = useState(0);
  const [answers, setAnswers] = useState<Record<number, InterpretationAnswerValue>>({});
  const [results, setResults] = useState<Record<number, InterpretationJudgeResult>>({});
  const [judging, setJudging] = useState<Record<number, boolean>>({});
  const [failed, setFailed] = useState<Record<number, boolean>>({});
  const [fullTranslation, setFullTranslation] = useState<string | null>(null);

  // 每句各自一个在途令牌：响应回来时令牌不匹配就丢弃（防「重新判题」连点导致旧响应覆盖新结果）
  const tokens = useRef<Record<number, number>>({});
  // 有作答时退出要确认（放行前须同步置 false 再 navigate，见 RunExitGuard 注释）
  const guardRef = useRef(true);

  // 甲类整篇发分：**只有最后一句判完才可能非 0**，中间句恒 0 且无 reason
  // → 必须静默（假「已达上限」文案的源头就在这）。决策全在共享模块里。
  const { award, celebrationProps } = usePointsFeedback();

  useEffect(() => {
    const raw = sessionStorage.getItem('training:interpretation');
    if (!raw) {
      navigate('/student/training/chinese/interpretation', { replace: true });
      return;
    }
    try {
      const parsed: unknown = JSON.parse(raw);
      if (!Array.isArray(parsed) || parsed.length === 0) {
        navigate('/student/training/chinese/interpretation', { replace: true });
        return;
      }
      setPassages(parsed as InterpretationPassageDetail[]);
    } catch {
      navigate('/student/training/chinese/interpretation', { replace: true });
    }
  }, [navigate]);

  const passage = passages?.[pIdx] ?? null;
  const sentenceCount = passage?.sentences.length ?? 0;
  const isLastSentence = currentIdx === sentenceCount - 1;

  const stateOf = (idx: number): SentenceState => {
    if (results[idx]) return 'judged';
    if (failed[idx]) return 'judged';      // 请求失败也进 judged（卡片显示错误 + 重新判题）
    if (judging[idx]) return 'judging';
    return 'editing';
  };

  const submit = async (idx: number, payload: {
    passageId: number; sentenceIndex: number;
    terms: Array<{ term: string; answer: string }>; translation: string;
  }) => {
    const token = (tokens.current[idx] ?? 0) + 1;
    tokens.current[idx] = token;
    setJudging((j) => ({ ...j, [idx]: true }));
    setFailed((f) => ({ ...f, [idx]: false }));
    try {
      const res = await judgeInterpretation(payload);
      if (tokens.current[idx] !== token) return;    // 过期响应丢弃
      setResults((prev) => ({ ...prev, [idx]: mergeResult(prev[idx], res) }));
      if (res.fullTranslation) setFullTranslation(res.fullTranslation);
      award({ pointsAwarded: res.pointsAwarded, awardReason: res.awardReason, title: '古诗文翻译' });
    } catch {
      if (tokens.current[idx] !== token) return;
      setFailed((f) => ({ ...f, [idx]: true }));
    } finally {
      if (tokens.current[idx] === token) setJudging((j) => ({ ...j, [idx]: false }));
    }
  };

  const payloadOf = (idx: number) => ({
    passageId: passage!.passageId,
    sentenceIndex: idx,
    // 传回的是 `term`（带注音原样）——服务端按存储的 term 精确配对
    terms: passage!.sentences[idx].terms.map((t) => ({
      term: t.term,
      answer: answers[idx]?.terms[t.term] ?? '',
    })),
    translation: answers[idx]?.translation ?? '',
  });

  const handleNext = () => {
    const idx = currentIdx;
    void submit(idx, payloadOf(idx));               // 送判但**不等它回来**
    if (idx < sentenceCount - 1) setCurrentIdx(idx + 1);
  };

  const handleRetry = (idx: number) => {
    void submit(idx, payloadOf(idx));
  };

  const resetForNextPassage = () => {
    tokens.current = {};
    setCurrentIdx(0);
    setAnswers({});
    setResults({});
    setJudging({});
    setFailed({});
    setFullTranslation(null);
  };

  const handlePassageDone = () => {
    if (passages && pIdx < passages.length - 1) {
      setPIdx(pIdx + 1);
      resetForNextPassage();
      return;
    }
    guardRef.current = false;
    sessionStorage.removeItem('training:interpretation');
    navigate('/student/training/chinese/special', { replace: true });
  };

  // 退出走 PageHeader 的返回按钮 → RunExitGuard 的 useBlocker 拦下并弹确认，
  // 用户确认后由 blocker.proceed() 放行（故本页不自己处理导航）。

  const stats = useMemo(
    () => sumStats(Array.from({ length: sentenceCount }, (_, i) => results[i])),
    [results, sentenceCount],
  );

  // 「本篇答完」= 最后一句已不再是 editing（已送出，判没判回来都算答完）
  const passageFinished = sentenceCount > 0 && isLastSentence && stateOf(currentIdx) !== 'editing';
  const anyJudging = Array.from({ length: sentenceCount }, (_, i) => stateOf(i)).includes('judging');
  const studentTranslation = useMemo(
    () => (passage ? passage.sentences.map((_, i) => answers[i]?.translation ?? '').join('') : ''),
    [passage, answers],
  );

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
          to="/student/training/chinese/interpretation"
          caption="退出"
          title="古诗文解释"
          titleClassName="text-4xl font-extrabold"
        />

        <p className="mt-6 text-sm text-[var(--text-secondary)]">
          《{passage.workTitle}》{'\u3000'}
          {passages && passages.length > 1 ? `第 ${pIdx + 1} / ${passages.length} 篇 · ` : ''}
          第 {Math.min(currentIdx + 1, sentenceCount)} / {sentenceCount} 句
        </p>

        <div className="mt-5 flex flex-col gap-5">
          {passage.sentences.slice(0, currentIdx + 1).map((s) => (
            <SentenceBlock
              key={s.index}
              sentence={s}
              value={answers[s.index] ?? EMPTY_ANSWER}
              onChange={(next) => setAnswers((prev) => ({ ...prev, [s.index]: next }))}
              state={stateOf(s.index)}
              result={results[s.index] ?? null}
              isLast={isLastSentence}
              onNext={handleNext}
              onRetry={() => handleRetry(s.index)}
            />
          ))}
        </div>

        {passageFinished && (
          <div
            className="mt-6 rounded-2xl bg-white p-6"
            style={{ border: '1px solid rgba(226, 232, 240, 0.8)' }}
          >
            <h3 className="text-lg font-bold text-[var(--text-primary)]">本篇完成</h3>

            {anyJudging && (
              <p className="mt-2 text-sm text-[var(--text-secondary)]">
                还有句子在判题中，结果会自动补上。
              </p>
            )}

            <ul className="mt-3 flex flex-col gap-1 text-sm text-[var(--text-secondary)]">
              <li>
                重点字词：对 {stats.termRight} · 错 {stats.termWrong}
                {stats.termUndetermined > 0 ? ` · 未判定 ${stats.termUndetermined}` : ''}
              </li>
              <li>
                整句翻译：对 {stats.sentRight} · 错 {stats.sentWrong}
                {stats.sentUndetermined > 0 ? ` · 未判定 ${stats.sentUndetermined}` : ''}
              </li>
            </ul>

            <div className="mt-5 border-t border-[var(--bg-subtle)] pt-4">
              <p className="text-sm font-bold text-[var(--text-primary)]">全文对照</p>
              <p className="mt-2 text-sm leading-loose text-[var(--text-secondary)]">
                <span className="font-medium text-[var(--text-primary)]">你的译文：</span>
                {studentTranslation || '（未作答）'}
              </p>
              <p className="mt-3 text-sm leading-loose text-[var(--text-secondary)]">
                <span className="font-medium text-[var(--text-primary)]">参考译文：</span>
                {fullTranslation ?? '（最后一句判完后才会显示整篇参考译文）'}
              </p>
            </div>

            <button
              onClick={handlePassageDone}
              className="mt-6 w-full h-12 rounded-2xl text-white font-bold"
              style={{ backgroundColor: 'var(--brand-500)' }}
            >
              {passages && pIdx < passages.length - 1 ? '下一篇' : '完成'}
            </button>
          </div>
        )}
      </div>
      {/* 段位晋升 / 全屏庆祝（决策表在 points-feedback，本页不自己判断何时弹） */}
      <CelebrationOverlay {...celebrationProps} />
    </div>
  );
}
