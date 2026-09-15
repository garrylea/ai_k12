import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { PageHeader } from '@/components/base';
import {
  judgeDictation,
  fetchDictationFeedback,
  type DictationJudgeResult,
  type DictationQuestionItem,
} from '@/services/api';
import DictationAnswerForm, { type DictationAnswerValue } from '@/components/business/dictation/DictationAnswerForm';
import DictationDiffView from '@/components/business/dictation/DictationDiffView';

const EMPTY: DictationAnswerValue = { author: '', dynasty: '', body: '' };

/** 与 QuestionRunner 判题等待视图同款转圈（线性 SVG，无 emoji）。 */
const Spinner = ({ size = 16 }: { size?: number }) => (
  <svg
    className="animate-spin text-[var(--brand-500)] shrink-0"
    width={size}
    height={size}
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
 * 古诗文默写答题页。题单经 sessionStorage 交接（镜像 TargetedRunPage）；
 * 空题单直接踢回配置页。
 *
 * 判题与错因已解耦：`judgeDictation` 纯程序判对错（~25ms），回来即出对错 + 正文对比；
 * 答错才另调 `fetchDictationFeedback` 取 LLM 错因文案，错因区先转圈后填充，
 * 文案失败显示兜底提示，**不影响已出的对错结果**。
 */
export default function DictationRunPage() {
  const navigate = useNavigate();
  const [questions, setQuestions] = useState<DictationQuestionItem[] | null>(null);
  const [index, setIndex] = useState(0);
  const [answer, setAnswer] = useState<DictationAnswerValue>(EMPTY);
  const [result, setResult] = useState<DictationJudgeResult | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [correctCount, setCorrectCount] = useState(0);
  const [feedback, setFeedback] = useState<string | null>(null);
  const [feedbackLoading, setFeedbackLoading] = useState(false);
  // 在途错因请求的令牌：换题后迟到的响应不许写回，否则会把上一题的错因贴到下一题
  const feedbackToken = useRef(0);

  // 读题单（StrictMode 下 effect 会跑两次，读后即删须防第二次读到空）
  useEffect(() => {
    const raw = sessionStorage.getItem('training:dictation');
    if (!raw) {
      navigate('/student/training/chinese/dictation', { replace: true });
      return;
    }
    try {
      const parsed: unknown = JSON.parse(raw);
      // 合法 JSON 但不是数组（如对象/字符串）同样视为坏题单，避免渲染空白页
      if (!Array.isArray(parsed) || parsed.length === 0) {
        navigate('/student/training/chinese/dictation', { replace: true });
        return;
      }
      setQuestions(parsed as DictationQuestionItem[]);
    } catch {
      navigate('/student/training/chinese/dictation', { replace: true });
    }
  }, [navigate]);

  const current = questions?.[index] ?? null;
  const isLast = questions != null && index === questions.length - 1;

  const handleSubmit = async () => {
    if (!current) return;
    const token = ++feedbackToken.current;
    const payload = { questionId: current.questionId, ...answer };
    setSubmitting(true);
    setError(null);
    setFeedback(null);
    setFeedbackLoading(false);
    try {
      const res = await judgeDictation(payload);
      // 判题回来即出结果——错因还在路上也不等它
      setResult(res);
      if (res.isCorrect) setCorrectCount((n) => n + 1);
      if (res.feedbackPending) {
        setFeedbackLoading(true);
        fetchDictationFeedback(payload)
          .then((r) => {
            if (feedbackToken.current === token) setFeedback(r.feedback);
          })
          .catch(() => {
            if (feedbackToken.current === token) setFeedback(null);
          })
          .finally(() => {
            if (feedbackToken.current === token) setFeedbackLoading(false);
          });
      }
    } catch {
      setError('判题失败，请重试');
    } finally {
      setSubmitting(false);
    }
  };

  const handleNext = () => {
    feedbackToken.current++; // 作废在途错因请求
    setFeedback(null);
    setFeedbackLoading(false);
    if (!isLast) {
      setIndex((i) => i + 1);
      setAnswer(EMPTY);
      setResult(null);
      setError(null);
      return;
    }
    sessionStorage.removeItem('training:dictation');
    navigate('/student/training/chinese/special', { replace: true });
  };

  const progressText = useMemo(
    () => (questions ? `第 ${index + 1} / ${questions.length} 篇` : ''),
    [questions, index],
  );

  if (!current) return null;

  return (
    <div
      data-theme="student-day"
      data-school="junior"
      className="student-theme-container min-h-screen flex flex-col items-center p-4"
      style={{ backgroundColor: 'var(--bg-page)' }}
    >
      <div className="w-full max-w-3xl px-4 sm:px-8 py-10">
        <PageHeader
          to="/student/training/chinese/dictation"
          caption="退出"
          title="古诗文默写"
          titleClassName="text-4xl font-extrabold"
        />

        <p className="mt-6 text-sm text-[var(--text-secondary)]">
          {progressText}{'\u3000'}已答对 {correctCount} 篇
        </p>

        <h2 className="mt-4 text-2xl font-black text-[var(--text-primary)]">{current.prompt}</h2>

        <div className="mt-6">
          <DictationAnswerForm value={answer} onChange={setAnswer} disabled={result != null} />
        </div>

        {error && <p className="mt-4 text-sm text-[var(--error)]">{error}</p>}

        {result == null ? (
          <button
            onClick={handleSubmit}
            disabled={submitting}
            className="mt-8 w-full h-14 rounded-2xl text-white text-lg font-bold disabled:opacity-60 inline-flex items-center justify-center gap-2"
            style={{ backgroundColor: 'var(--brand-500)' }}
          >
            {submitting && <Spinner size={18} />}
            {submitting ? '正在判题…' : '提交'}
          </button>
        ) : (
          <div className="mt-8 rounded-2xl bg-white p-6" style={{ border: '1px solid rgba(226, 232, 240, 0.8)' }}>
            <p className={`text-xl font-black ${result.isCorrect ? 'text-[var(--success)]' : 'text-[var(--error)]'}`}>
              {result.isCorrect ? '全部正确' : '有错误'}
            </p>

            {!result.isCorrect && (
              <>
                <ul className="mt-4 flex flex-col gap-2 text-sm">
                  <li className="text-[var(--text-secondary)]">
                    作者：{result.fields.author.match ? '正确' : `错误，应为 ${result.reference.author}`}
                  </li>
                  <li className="text-[var(--text-secondary)]">
                    朝代：{result.fields.dynasty.match ? '正确' : `错误，应为 ${result.reference.dynasty}`}
                  </li>
                  <li className="text-[var(--text-secondary)]">
                    正文：{result.fields.body.match ? '正确' : '有出入（见下方对比）'}
                  </li>
                </ul>

                {!result.fields.body.match && (
                  <div className="mt-5">
                    <p className="text-sm font-bold text-[var(--text-primary)]">
                      正文对比（判对错忽略标点与空格）
                    </p>
                    <div className="mt-2">
                      <DictationDiffView ops={result.bodyDiff} />
                    </div>
                    <p className="mt-3 text-sm text-[var(--text-secondary)]">
                      正确正文：{result.reference.body}
                    </p>
                  </div>
                )}

                <div className="mt-5 border-t border-[var(--bg-subtle)] pt-4">
                  <p className="text-sm font-bold text-[var(--text-primary)]">错因提醒</p>
                  {feedbackLoading ? (
                    <div className="mt-2 flex items-center gap-2">
                      <Spinner />
                      <p className="text-sm text-[var(--text-secondary)]">AI 正在生成错因提醒…</p>
                    </div>
                  ) : (
                    <p className="mt-1 text-sm text-[var(--text-secondary)]">
                      {feedback ?? '暂时无法生成错因提醒，先对照上面的正文对比改一改。'}
                    </p>
                  )}
                </div>
              </>
            )}

            <button
              onClick={handleNext}
              className="mt-6 w-full h-12 rounded-2xl text-white font-bold"
              style={{ backgroundColor: 'var(--brand-500)' }}
            >
              {isLast ? '完成' : '下一篇'}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
