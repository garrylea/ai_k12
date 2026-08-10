import { useEffect, useRef, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkMath from 'remark-math';
import remarkGfm from 'remark-gfm';
import rehypeKatex from 'rehype-katex';
import 'katex/dist/katex.min.css';
import { LatexEditor } from './LatexEditor';
import { LatexPreview } from './LatexPreview';
import { DiscussDrawer } from './DiscussDrawer';

export interface PracticeQuestion { n: string; text: string; }

/** 单题判题状态：等待 / 判题中 / 已判完 / 判定失败 */
type JudgeStatus = 'pending' | 'judging' | 'done' | 'failed';

interface Props {
  questions: PracticeQuestion[];
  startIndex: number;
  cardId: number;
  lessonId: number;
  subjectId: number;
  /** 提示缓存（key = 复合题号 q.n）：session 内命中即直显，省一次后端请求 */
  hints: Record<string, string>;
  onSubmit: (questionText: string, studentAnswer: string) => Promise<{
    isCorrect: boolean; method: string; analysis: string | null; errorType?: string | null;
  }>;
  /** 拉取提示：父层调 /practice/hint（后端查 cards.hints 缓存，未命中 AI 生成并写回）并 setHint 入 store */
  onRequestHint: (questionText: string, n: string) => Promise<void>;
  onFinish: () => void;
  onClose: () => void;
}

export function AnswerModal({ questions, startIndex, cardId, lessonId, subjectId, hints, onSubmit, onRequestHint, onFinish, onClose }: Props) {
  const [idx, setIdx] = useState(startIndex);
  const [answer, setAnswer] = useState('');
  const [showHint, setShowHint] = useState(false);
  const [showDiscuss, setShowDiscuss] = useState(false);
  const [hintLoading, setHintLoading] = useState(false);
  const [hintError, setHintError] = useState(false);
  // answering：作答中；judging：末题已交，等待后台判题全部完成
  const [mode, setMode] = useState<'answering' | 'judging'>('answering');
  const [progress, setProgress] = useState<JudgeStatus[]>(() => questions.map(() => 'pending'));
  const pendingRef = useRef<Map<number, Promise<unknown>>>(new Map());
  const cancelledRef = useRef(false);
  const q = questions[idx];

  // 切题时重置提示面板状态（提示文本本身存于 props.hints，跨题保留）。
  // 必须在 `if (!q) return null` 之前调用（hooks 不能条件性调用）。
  useEffect(() => {
    setShowHint(false);
    setHintLoading(false);
    setHintError(false);
    setShowDiscuss(false);
  }, [idx]);

  if (!q) return null;

  const handleHintClick = async () => {
    if (showHint) { setShowHint(false); return; }   // 已展开 -> 收起
    setShowHint(true);
    if (hints[q.n] || hintLoading) return;           // 已缓存或正在拉取 -> 直显/等待
    setHintLoading(true);
    setHintError(false);
    try {
      await onRequestHint(q.text, q.n);
    } catch {
      setHintError(true);
    } finally {
      setHintLoading(false);
    }
  };

  const handleSubmit = () => {
    if (!answer.trim() || mode !== 'answering') return;
    const submittedIdx = idx;
    const submittedAnswer = answer;
    // 标记该题判题中
    setProgress(p => p.map((s, i) => (i === submittedIdx ? 'judging' : s)));
    // fire-and-forget：不 await，判题在后台进行，学生立即切到下一题
    const p = Promise.resolve(onSubmit(q.text, submittedAnswer))
      .then(() => setProgress(pr => pr.map((s, i) => (i === submittedIdx ? 'done' : s))))
      .catch(() => setProgress(pr => pr.map((s, i) => (i === submittedIdx ? 'failed' : s))));
    pendingRef.current.set(submittedIdx, p);
    setAnswer('');
    setShowHint(false);
    if (submittedIdx + 1 < questions.length) {
      setIdx(submittedIdx + 1);
    } else {
      // 末题：进入判题等待态，等所有后台判题完成后弹结果列表
      setMode('judging');
      Promise.allSettled([...pendingRef.current.values()]).then(() => {
        if (!cancelledRef.current) onFinish();
      });
    }
  };

  const handleClose = () => {
    cancelledRef.current = true;
    onClose();
  };

  // 让 AI 讲一讲：在弹窗内打开右侧抽屉做苏格拉底讨论（不再跳转占位页）。
  const handleDiscuss = () => {
    setShowDiscuss(true);
  };

  const doneCount = progress.filter(s => s === 'done' || s === 'failed').length;

  // ═══ 判题进度页（末题交卷后）═══
  if (mode === 'judging') {
    return (
      <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40" role="dialog" aria-modal="true">
        <div className="w-[92vw] max-w-xl bg-[var(--bg-card)] rounded-2xl shadow-xl flex flex-col overflow-hidden">
          <div className="p-6 flex flex-col items-center">
            {/* 旋转图标 */}
            <svg className="animate-spin text-[var(--brand-500)] mb-4" width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
              <path d="M21 12a9 9 0 1 1-6.219-8.56" />
            </svg>
            <h2 className="text-lg font-bold text-[var(--text-primary)]">AI 正在判题，请稍候</h2>
            <p className="text-sm text-[var(--text-tertiary)] mt-1.5">
              已完成 {doneCount} / {questions.length} 题
            </p>
          </div>
          {/* 逐题进度 */}
          <div className="flex-1 overflow-auto px-5 pb-5">
            <div className="flex flex-col gap-2">
              {questions.map((qi, i) => {
                const st = progress[i];
                return (
                  <div key={qi.n} className="flex items-center gap-3 px-3 py-2.5 rounded-lg bg-[var(--bg-base)]">
                    <div className="shrink-0 w-5 h-5 flex items-center justify-center">
                      {st === 'judging' ? (
                        <svg className="animate-spin text-[var(--brand-500)]" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                          <path d="M21 12a9 9 0 1 1-6.219-8.56" />
                        </svg>
                      ) : st === 'done' ? (
                        <svg width="16" height="16" viewBox="0 0 24 24" fill="var(--text-secondary)">
                          <circle cx="12" cy="12" r="6" />
                        </svg>
                      ) : st === 'failed' ? (
                        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="var(--text-tertiary)" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                          <line x1="18" y1="6" x2="6" y2="18" />
                          <line x1="6" y1="6" x2="18" y2="18" />
                        </svg>
                      ) : (
                        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="var(--bg-subtle)" strokeWidth="2.5">
                          <circle cx="12" cy="12" r="6" />
                        </svg>
                      )}
                    </div>
                    <span className="text-xs text-[var(--text-tertiary)] font-medium shrink-0">第 {i + 1} 题</span>
                    <span className={`text-sm ${st === 'failed' ? 'text-[var(--text-tertiary)]' : 'text-[var(--text-secondary)]'}`}>
                      {st === 'judging' ? '判题中…' : st === 'done' ? '已判完' : st === 'failed' ? '判定失败' : '等待中'}
                    </span>
                  </div>
                );
              })}
            </div>
          </div>
          {/* 关闭（放弃等待） */}
          <div className="shrink-0 flex justify-center p-3 border-t border-[var(--bg-subtle)]">
            <button
              onClick={handleClose}
              className="px-6 py-2 rounded-lg border border-[var(--bg-subtle)] text-[var(--text-tertiary)] text-sm hover:bg-[var(--bg-base)] transition-colors"
            >
              关闭
            </button>
          </div>
        </div>
      </div>
    );
  }

  // ═══ 作答页 ═══
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40" role="dialog" aria-modal="true">
      <div className="relative w-[92vw] max-w-5xl h-[88vh] bg-[var(--bg-card)] rounded-2xl shadow-xl flex flex-col overflow-hidden">

        {/* ═══ 顶部：题面 + 提示/讨论图标 ═══ */}
        <div className="shrink-0 p-4 border-b border-[var(--bg-subtle)]">
          <div className="flex gap-3">
            {/* 题目区 */}
            <div className="flex-1 min-w-0">
              <div className="text-xs text-[var(--text-tertiary)] font-medium mb-2">
                第 {idx + 1} / {questions.length} 题
              </div>
              <div className="text-xl text-[var(--text-primary)] [&>*]:font-bold leading-[1.7]">
                <ReactMarkdown remarkPlugins={[remarkMath, remarkGfm]} rehypePlugins={[rehypeKatex]}>
                  {q.text}
                </ReactMarkdown>
              </div>
            </div>
            {/* 右侧图标按钮列 */}
            <div className="flex flex-col gap-2 shrink-0">
              {/* 提示 */}
              <button
                onClick={handleHintClick}
                className="w-[38px] h-[38px] rounded-xl border border-[var(--bg-subtle)] bg-[var(--bg-card)] flex items-center justify-center text-[var(--warning)] shadow-sm hover:bg-[var(--brand-100)] transition-colors"
                title="提示"
                aria-label="提示"
              >
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <circle cx="12" cy="12" r="10" />
                  <path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3" />
                  <line x1="12" y1="17" x2="12.01" y2="17" />
                </svg>
              </button>
              {/* 让 AI 讲一讲 */}
              <button
                onClick={handleDiscuss}
                className="w-[38px] h-[38px] rounded-xl border border-[var(--bg-subtle)] bg-[var(--bg-card)] flex items-center justify-center text-[var(--info)] shadow-sm hover:bg-[var(--bg-subtle)] transition-colors"
                title="让 AI 讲一讲"
                aria-label="让 AI 讲一讲"
              >
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
                </svg>
              </button>
            </div>
          </div>
          {/* 提示抽屉 */}
          {showHint && (
            <div className="mt-3 p-3 rounded-lg bg-[var(--brand-100)] border-l-[3px] border-[var(--warning)]">
              {hintLoading ? (
                <div className="flex items-center gap-2 text-sm text-[var(--text-secondary)]">
                  <svg className="animate-spin text-[var(--warning)]" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                    <path d="M21 12a9 9 0 1 1-6.219-8.56" />
                  </svg>
                  <span>正在生成提示…</span>
                </div>
              ) : hints[q.n] ? (
                <div className="text-sm text-[var(--text-primary)] leading-relaxed">
                  <ReactMarkdown remarkPlugins={[remarkMath, remarkGfm]} rehypePlugins={[rehypeKatex]}>
                    {hints[q.n]}
                  </ReactMarkdown>
                </div>
              ) : (
                <p className="text-sm text-[var(--text-primary)] leading-relaxed">
                  {hintError
                    ? '提示生成失败，请稍后再试。如果需要更多帮助，可以点击右侧「让 AI 讲一讲」。'
                    : '仔细审题，从已知条件出发，逐步推理。如果需要更多帮助，可以点击右侧「让 AI 讲一讲」。'}
                </p>
              )}
            </div>
          )}
        </div>

        {/* ═══ 中部：左编辑 右预览 ═══ */}
        <div className="flex-1 min-h-0 flex">
          <div className="w-1/2 border-r border-[var(--bg-subtle)] flex flex-col">
            <LatexEditor value={answer} onChange={setAnswer} />
          </div>
          <div className="w-1/2">
            <LatexPreview value={answer} />
          </div>
        </div>

        {/* ═══ 底部：关闭（左）+ 提交（右）═══ */}
        <div className="shrink-0 flex items-center justify-between p-3 border-t border-[var(--bg-subtle)]">
          {/* 关闭 */}
          <button
            onClick={handleClose}
            className="w-10 h-10 rounded-full border border-[var(--bg-subtle)] bg-[var(--bg-card)] flex items-center justify-center text-[var(--text-tertiary)] hover:bg-[var(--bg-base)] transition-colors"
            title="关闭"
            aria-label="关闭"
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
              <line x1="18" y1="6" x2="6" y2="18" />
              <line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </button>
          {/* 提交：不等待判题，立即切题 */}
          <button
            onClick={handleSubmit}
            disabled={!answer.trim()}
            className="w-12 h-12 rounded-full bg-[var(--brand-500)] text-white flex items-center justify-center disabled:opacity-40 hover:bg-[var(--brand-600)] transition-all shadow-md"
            title="提交"
            aria-label="提交"
          >
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <line x1="22" y1="2" x2="11" y2="13" />
              <polygon points="22 2 15 22 11 13 2 9 22 2" />
            </svg>
          </button>
        </div>

        {/* 让 AI 讲一讲：右侧抽屉（仅手动关闭，覆盖右部/放大全屏） */}
        {showDiscuss && (
          <DiscussDrawer
            mode="question"
            cardId={cardId}
            questionText={q.text}
            subjectId={subjectId}
            lessonId={lessonId}
            onClose={() => setShowDiscuss(false)}
          />
        )}
      </div>
    </div>
  );
}
