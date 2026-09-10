// apps/web/src/components/business/answer/QuestionRunner.tsx
// 共享答题组件：布局与 fire-and-forget 判题取自 CleanupPhase，hint 交互取自
// AnswerModal。variant 只影响外壳（modal 加 fixed 遮罩），内部答题区一致。
// 不做（YAGNI，父层负责）：庆祝页、bumpErrorLevels、DiscussDrawer、结果列表渲染。
// 收敛扩展（AnswerModal/CleanupPhase 挂载用）：startIndex / onClose / showPrevButton /
// headerActions / judgingSlot / modalExtras 均为可选，缺省时行为与扩展前完全一致。
import { useCallback, useLayoutEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import ReactMarkdown from 'react-markdown';
import {
  markdownRemarkPlugins,
  markdownRehypePlugins,
  preprocessMarkdown,
  MarkdownImg,
} from '@/components/markdown';
import { LatexEditor } from '../LatexEditor';
import { PreviewDraftPanel } from '../PreviewDraftPanel';
import { clearDraft } from '../draft-store';
import { ChoiceOptionList } from './ChoiceOptionList';
import type { RunnerAnswerRecord, RunnerJudgeOutcome, RunnerQuestion, RunnerSelfAssessContext } from './types';

/** 数学 subject_id（tools/db/schema.sql subjects seed 首行）——仅数学启用内嵌草稿（PRD §7.12） */
const MATH_SUBJECT_ID = 1;

const SPINNER_SVG = (
  <svg className="animate-spin text-[var(--brand-500)]" width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
    <path d="M21 12a9 9 0 1 1-6.219-8.56" />
  </svg>
);

const ChevronLeftIcon = () => (
  <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <polyline points="15 18 9 12 15 6" />
  </svg>
);

// 自定义 img：题面图走 MarkdownImg 的 bucketHeight 模式——按宽高比分桶固定高度
// （>5→60px / 其它→120px，见 markdown.tsx MarkdownImg 注释），
// resolveAsset / 破图隐藏仍由 MarkdownImg 处理。className 不带固定高（分桶算法给），
// 保留 margin/居中/max-w-full/object-contain/圆角。
const questionMarkdownComponents = {
  img: (props: { src?: string; alt?: string }) => (
    <MarkdownImg {...props} bucketHeight className="block mx-auto my-4 max-w-full object-contain rounded-lg" />
  ),
};

export interface QuestionRunnerProps {
  questions: RunnerQuestion[];
  /** 学科 id（subjects seed 首行 = 数学）；与 draftDisabled 一起决定内嵌草稿 tab 是否启用 */
  subjectId: number;
  /** 单题草稿键 = `${draftKeyPrefix}-${q.n}` */
  draftKeyPrefix: string;
  variant: 'modal' | 'embedded';
  /** 默认 false；训练轨答题页置 true——内嵌草稿由页面级草稿抽屉替代（主线 AnswerModal/CleanupPhase 保持草稿 tab） */
  draftDisabled?: boolean;
  /** 默认 'auto'：type=choice/true_false 且有 options 时点选作答，否则文本作答 */
  answerMode?: 'auto' | 'text';
  enableHint?: boolean;
  /** 提示缓存（key = q.n），父层持有（session 缓存） */
  hints?: Record<string, string>;
  /** 拉取提示：父层请求后端并回写 hints；组件内部只管展示态（show/loading/error） */
  onRequestHint?: (q: RunnerQuestion) => Promise<string>;
  /** 默认 true；考试置 false（不渲染判题对错反馈，judging 文案用「正在提交」） */
  showResultFeedback?: boolean;
  onSubmit: (q: RunnerQuestion, answer: string) => Promise<RunnerJudgeOutcome>;
  /** 主观题自评提交（self_assess 模式）：学生点「我做对了/我做错了」后调用；父层落库。
   *  缺省时自评不落库但仍强制选择后才放行（防跳过）。 */
  onSelfAssess?: (q: RunnerQuestion, assessment: 'correct' | 'incorrect', ctx: RunnerSelfAssessContext) => Promise<void>;
  onFinish: (results: Record<string, RunnerAnswerRecord>) => void;
  /** 考试倒计时等插槽：渲染在标题行右侧 */
  headerExtra?: ReactNode;
  /** 顶部标题：固定文案或随题位变化的函数（CleanupPhase「错题巩固 — 第 i/n 题」）；默认「第 {i+1}/{n} 题」 */
  title?: string | ((index: number, total: number) => string);
  /** 初始题位（AnswerModal 续答语义）；默认 0 */
  startIndex?: number;
  /** 提供时作答态底部左侧渲染关闭 X，参数 answered = 已提交判题数（父层退出确认文案用；判题等待态的关闭入口由父层 judgingSlot 自理） */
  onClose?: (answered: number) => void;
  /** 默认 true；false 隐藏「上一题」（AnswerModal 旧行为无回退，行为保持） */
  showPrevButton?: boolean;
  /** 题面右侧操作插槽（hint 按钮旁），收到当前题——AnswerModal 的「让 AI 讲一讲」入口 */
  headerActions?: (q: RunnerQuestion) => ReactNode;
  /** 元动作插槽（如「不再展示」）：始终渲染，不 gate（区别于 headerActions 的「先看提示」门禁）。 */
  questionMetaActions?: (q: RunnerQuestion) => ReactNode;
  /** 覆盖内置判题等待视图（AnswerModal 的逐题进度页外壳） */
  judgingSlot?: ReactNode;
  /** modal 外壳内追加浮层（DiscussDrawer 等 absolute 定位）；仅作答态渲染 */
  modalExtras?: ReactNode;
  /** 当前题变化时回调（父层追踪当前题，供页面级草稿抽屉做 key 触发清空）；首次 mount 也触发 */
  onQuestionChange?: (q: RunnerQuestion, idx: number) => void;
  /** 初始作答映射（key = q.n）：续考/恢复场景传入后端已存的作答文本，首次 mount 时写入本地
   *  作答映射（answerByNRef），回看已答题目即恢复。仅在挂载时生效一次。 */
  initialAnswers?: Record<string, string>;
}

export function QuestionRunner({
  questions,
  subjectId,
  draftKeyPrefix,
  variant,
  draftDisabled = false,
  answerMode = 'auto',
  enableHint = false,
  hints,
  onRequestHint,
  showResultFeedback = true,
  onSubmit,
  onSelfAssess,
  onFinish,
  headerExtra,
  title,
  startIndex,
  onClose,
  showPrevButton = true,
  headerActions,
  questionMetaActions,
  judgingSlot,
  modalExtras,
  onQuestionChange,
  initialAnswers,
}: QuestionRunnerProps) {
  const [idx, setIdx] = useState(startIndex ?? 0);
  const [answer, setAnswer] = useState('');
  // answering：作答中；judging：末题已交，等待后台判题全部完成；self_assess：主观题自评视图
  const [phase, setPhase] = useState<'answering' | 'judging' | 'self_assess'>('answering');
  const [hintState, setHintState] = useState<{ show: boolean; loading: boolean; error: boolean }>({
    show: false,
    loading: false,
    error: false,
  });
  // 本地追踪判题结果（避免父层闭包过期问题），onFinish 时快照交给父层
  const resultsRef = useRef<Record<string, RunnerAnswerRecord>>({});
  const pendingRef = useRef<Map<number, Promise<unknown>>>(new Map());
  // 重交竞态防护：每次提交递增该题的序号，慢的旧 promise resolve 时序号不匹配即丢弃，
  // 防止首次提交的慢 AI 判题结果覆盖学生重交后的新结果。
  const seqRef = useRef<Record<string, number>>({});

  // 主观题自评视图（self_assess 模式）：提交后判题即时返回待自评 + 参考答案/解析，
  // 学生点「我做对了/我做错了」后才放行下一题（强制自评，不跳过）。
  const [selfAssess, setSelfAssess] = useState<{
    question: RunnerQuestion;
    submittedAnswer: string;
    questionId: number | null;
    referenceAnswer: string;
    explanation: string;
    assessing: boolean;
    error: boolean;
  } | null>(null);

  const total = questions.length;
  const q = questions[idx];

  // 当前题变化通知父层（页面级草稿抽屉依赖它拿 key 触发清空）；父层应 useCallback 稳定引用避免重跑
  const onQuestionChangeRef = useRef(onQuestionChange);
  onQuestionChangeRef.current = onQuestionChange;
  useLayoutEffect(() => {
    if (q) onQuestionChangeRef.current?.(q, idx);
  }, [idx, q]);

  const requestHint = enableHint ? onRequestHint : undefined;

  // 作答按 q.n 持久化（事件回调写入）—— 切题时按 q.n 回填，避免「回看上一题
  // 答案消失」。currentNRef 在渲染期同步为当前 q.n，供 updateAnswer 在事件
  // 回调里定位写入的键。resultsRef 仅记判题结果（onFinish 快照），不复用它
  // 回填输入：判题 pending 期间 resultsRef 还没落 studentAnswer，会回填空。
  const currentNRef = useRef<string>('');
  currentNRef.current = q?.n ?? '';
  // 初始作答（续考恢复）在挂载时并入映射：首次 mount 的 initialAnswers 即为最终数据
  // （父层都是数据就绪后才挂载本组件），之后切题回填即可取到已答内容。
  const answerByNRef = useRef<Record<string, string>>(initialAnswers ?? {});
  const updateAnswer = useCallback((next: string) => {
    setAnswer(next);
    if (currentNRef.current) answerByNRef.current[currentNRef.current] = next;
  }, []);

  // 切题时重置提示面板展示态（提示文本本身存于 props.hints，跨题保留），
  // 并回填当前题已记录的作答（answerByNRef）——「上一题」回退时恢复之前
  // 选中/填写的值，新题回填空串。useLayoutEffect 同步在 paint 前回填，
  // 避免旧题答案在新题上闪一帧。
  useLayoutEffect(() => {
    setHintState({ show: false, loading: false, error: false });
    const nq = questions[idx];
    setAnswer(nq ? (answerByNRef.current[nq.n] ?? '') : '');
  }, [idx, questions]);

  // 提交后切下一题；末题进入等待态，等所有后台判题完成后交结果给父层。
  // （自评完成后走同一出口，保证末题自评也正确触发 onFinish。）
  const advance = useCallback((fromIdx: number) => {
    if (fromIdx + 1 < total) {
      // 自评完成/同步判题返回后切下一题：phase 复位回作答态
      // （inline 分支期间曾置 'judging'，自评分支曾置 'self_assess'）
      setPhase('answering');
      setIdx(fromIdx + 1);
    } else {
      // 末题：进入等待态，等所有后台判题完成后交结果给父层
      setPhase('judging');
      void Promise.allSettled([...pendingRef.current.values()]).then(() => {
        onFinish({ ...resultsRef.current });
      });
    }
  }, [total, onFinish]);

  const handleSubmit = useCallback(async () => {
    if (!answer.trim() || phase !== 'answering' || !q) return;

    const thisIdx = idx;
    const submittedAnswer = answer;
    const question = q;

    clearDraft(`${draftKeyPrefix}-${question.n}`);
    setAnswer('');

    const seq = (seqRef.current[question.n] ?? 0) + 1;
    seqRef.current[question.n] = seq;

    // 主观题（解答/证明）：同步等待判题返回——self_assess 模式即时返回待自评
    // （进入自评视图，强制自评后放行）；ai 模式返回判定结果（记录后切题）。
    // showResultFeedback=false（考试）：不在此自评（交卷后结果页自评），走 fire-and-forget。
    const inlineSelfAssess = showResultFeedback && (question.type === 'short_answer' || question.type === 'proof');
    if (inlineSelfAssess) {
      setPhase('judging');
      try {
        const res = await Promise.resolve(onSubmit(question, submittedAnswer));
        if (seqRef.current[question.n] !== seq) return; // 过期结果，丢弃
        if (res.needsSelfAssessment) {
          setSelfAssess({
            question,
            submittedAnswer,
            questionId: res.questionId ?? null,
            referenceAnswer: res.referenceAnswer ?? '',
            explanation: res.explanation ?? '',
            assessing: false,
            error: false,
          });
          setPhase('self_assess');
          return;
        }
        // ai 模式 / 客观题语义的返回：noStandardAnswer（空答案守卫）也走这里——中性记录不进自评
        resultsRef.current[question.n] = {
          isCorrect: res.isCorrect ?? false,
          method: res.method,
          errorType: res.errorType ?? null,
          studentAnswer: submittedAnswer,
        };
        advance(thisIdx);
      } catch {
        if (seqRef.current[question.n] !== seq) return;
        resultsRef.current[question.n] = {
          isCorrect: false, method: 'ai', errorType: null, studentAnswer: submittedAnswer, failed: true,
        };
        advance(thisIdx);
      }
      return;
    }

    // fire-and-forget：不 await，判题在后台进行，学生立即切下一题。
    // showResultFeedback=false 时结果仍记入 resultsRef（供 onFinish），仅 UI 不显示对错。
    const p = Promise.resolve(onSubmit(question, submittedAnswer))
      .then((res: RunnerJudgeOutcome) => {
        if (seqRef.current[question.n] !== seq) return res; // 过期结果（已被重交覆盖），丢弃
        resultsRef.current[question.n] = {
          isCorrect: res.isCorrect ?? false,
          method: res.method,
          errorType: res.errorType ?? null,
          studentAnswer: submittedAnswer,
        };
        return res;
      })
      .catch(() => {
        if (seqRef.current[question.n] !== seq) return; // 过期结果，丢弃
        resultsRef.current[question.n] = {
          isCorrect: false,
          method: 'ai',
          errorType: null,
          studentAnswer: submittedAnswer,
          failed: true,
        };
      });

    pendingRef.current.set(thisIdx, p);

    advance(thisIdx);
  }, [answer, phase, q, idx, draftKeyPrefix, showResultFeedback, onSubmit, advance]);

  // 自评提交：学生点「我做对了/我做错了」——先经父层落库（onSelfAssess 可缺省），
  // 成功后本地记录布尔结果并放行；落库失败留在自评视图可重点。
  const handleSelfAssess = useCallback(async (assessment: 'correct' | 'incorrect') => {
    if (!selfAssess || selfAssess.assessing) return;
    setSelfAssess((s) => (s ? { ...s, assessing: true, error: false } : s));
    const { question, submittedAnswer, questionId } = selfAssess;
    try {
      if (onSelfAssess) {
        await onSelfAssess(question, assessment, { questionId, studentAnswer: submittedAnswer });
      }
    } catch {
      // 落库失败：留在自评视图可重点（结果已本地记录，不重复入 resultsRef）
      setSelfAssess((s) => (s ? { ...s, assessing: false, error: true } : s));
      return;
    }
    resultsRef.current[question.n] = {
      isCorrect: assessment === 'correct',
      method: 'self_assess',
      errorType: null,
      studentAnswer: submittedAnswer,
    };
    const idxOf = questions.findIndex((x) => x.n === question.n);
    setSelfAssess(null);
    advance(idxOf < 0 ? idx : idxOf);
  }, [selfAssess, onSelfAssess, questions, advance, idx]);

  if (!q) return null;

  // ===== 选择题判定：auto 模式下 choice/true_false 走点选 =====
  const choiceOptions: Array<{ label: string; text: string }> | null = (() => {
    if (answerMode !== 'auto') return null;
    if (q.type !== 'choice' && q.type !== 'true_false') return null;
    if (q.options && q.options.length > 0) return q.options;
    if (q.type === 'true_false') {
      return [
        { label: '对', text: '对' },
        { label: '错', text: '错' },
      ];
    }
    return null;
  })();

  const handleHintClick = async () => {
    if (!requestHint) return;
    if (hintState.show) {
      setHintState((s) => ({ ...s, show: false })); // 已展开 -> 收起
      return;
    }
    setHintState((s) => ({ ...s, show: true }));
    if (hints?.[q.n] || hintState.loading) return; // 已缓存或正在拉取 -> 直显/等待
    setHintState((s) => ({ ...s, loading: true, error: false }));
    try {
      await requestHint(q);
    } catch {
      setHintState((s) => ({ ...s, error: true }));
    } finally {
      setHintState((s) => ({ ...s, loading: false }));
    }
  };

  // ========== JUDGING 态 ==========
  const judgingView = (
    <div className="flex-1 min-h-0 flex items-center justify-center">
      <div className="text-center space-y-4 p-8 rounded-xl" style={{ backgroundColor: 'var(--learn-card-bg)' }}>
        {SPINNER_SVG}
        <h2 className="text-lg font-bold text-[var(--text-primary)]">
          {showResultFeedback ? '判题中，请稍候…' : '正在提交，请稍候…'}
        </h2>
        <p className="text-sm text-[var(--text-tertiary)]">
          {showResultFeedback ? 'AI 正在判定你的答案，请耐心等待' : '正在提交'}
        </p>
      </div>
    </div>
  );

  // ========== SELF-ASSESS 态（主观题 self_assess 模式） ==========
  const selfAssessView = selfAssess && (
    <div className="flex-1 min-h-0 flex flex-col gap-3">
      <h1 className="font-bold shrink-0" style={{ fontSize: 'var(--fs-learn-h1)', lineHeight: '1.75rem', color: 'var(--learn-heading-1)' }}>
        对照参考答案，自评这道题
      </h1>
      <div className="flex-1 min-h-0 overflow-y-auto p-4 rounded-xl border border-[var(--learn-card-border)] shadow-sm"
           style={{ backgroundColor: 'var(--learn-card-bg)' }}>
        <div className="text-xs font-semibold text-[var(--text-tertiary)] mb-1.5">参考答案</div>
        <div className="text-sm text-[var(--text-primary)] leading-[1.7]">
          <ReactMarkdown remarkPlugins={markdownRemarkPlugins} rehypePlugins={markdownRehypePlugins} components={questionMarkdownComponents}>
            {preprocessMarkdown(selfAssess.referenceAnswer || '（暂无参考答案）')}
          </ReactMarkdown>
        </div>
        {selfAssess.explanation && (
          <>
            <div className="text-xs font-semibold text-[var(--text-tertiary)] mt-4 mb-1.5">解题思路与解析</div>
            <div className="text-sm text-[var(--text-primary)] leading-[1.7]">
              <ReactMarkdown remarkPlugins={markdownRemarkPlugins} rehypePlugins={markdownRehypePlugins} components={questionMarkdownComponents}>
                {preprocessMarkdown(selfAssess.explanation)}
              </ReactMarkdown>
            </div>
          </>
        )}
      </div>
      <div className="shrink-0 flex items-center justify-between gap-3 p-3 rounded-xl border border-[var(--learn-card-border)]"
           style={{ backgroundColor: 'var(--learn-card-bg)' }}>
        <p className="text-xs text-[var(--text-secondary)] leading-relaxed">
          你刚才的作答是对的（过程/结论与参考一致）还是错的（思路或结果有误）？
          {selfAssess.error && <span className="block text-[var(--error)]">自评提交失败，请重试。</span>}
        </p>
        <div className="flex gap-2 shrink-0">
          <button
            onClick={() => void handleSelfAssess('incorrect')}
            disabled={selfAssess.assessing}
            className="h-10 px-4 rounded-lg border border-[var(--error)] text-[var(--error)] text-sm font-medium disabled:opacity-40 hover:bg-[#FCE8E6] transition-colors"
          >
            我做错了
          </button>
          <button
            onClick={() => void handleSelfAssess('correct')}
            disabled={selfAssess.assessing}
            className="h-10 px-4 rounded-lg border border-[var(--success)] text-[var(--success)] text-sm font-medium disabled:opacity-40 hover:bg-[#E8F5EE] transition-colors"
          >
            我做对了
          </button>
        </div>
      </div>
    </div>
  );

  // ========== ANSWERING 态 ==========
  const answeringView = (
    <div className="flex-1 min-h-0 flex flex-col gap-3">
      {/* 标题行：默认「第 i/n 题」，headerExtra（考试倒计时等）靠右 */}
      <div className="shrink-0 flex items-center justify-between gap-3">
        <h1 className="font-bold" style={{ fontSize: 'var(--fs-learn-h1)', lineHeight: '1.75rem', color: 'var(--learn-heading-1)' }}>
          {typeof title === 'function' ? title(idx, total) : (title ?? `第 ${idx + 1}/${total} 题`)}
        </h1>
        {headerExtra}
      </div>

      <div
        className="flex-1 min-h-0 flex flex-col rounded-xl overflow-hidden border border-[var(--learn-card-border)] shadow-sm"
        style={{ backgroundColor: 'var(--learn-card-bg)' }}
      >
        {/* 题面 + 提示按钮 + 提示抽屉 */}
        <div className="shrink-0 max-h-[45vh] overflow-y-auto p-4 border-b border-[var(--bg-subtle)]">
          <div className="flex gap-3">
            <div className="flex-1 min-w-0">
              <div
                className={`${variant === 'embedded' ? 'text-lg' : 'text-xl'} text-[var(--text-primary)] [&>*]:font-bold leading-[1.7]`}
              >
                <ReactMarkdown remarkPlugins={markdownRemarkPlugins} rehypePlugins={markdownRehypePlugins} components={questionMarkdownComponents}>
                  {preprocessMarkdown(q.text)}
                </ReactMarkdown>
              </div>
            </div>
            {(requestHint || headerActions || questionMetaActions) && (
              <div className="flex flex-col gap-2 shrink-0">
                {/* 元动作（始终可见，不 gate）：如「不再展示」按钮 */}
                {questionMetaActions && questionMetaActions(q)}
                {requestHint && (
                  <button
                    onClick={handleHintClick}
                    className="w-[38px] h-[38px] rounded-xl border border-[var(--bg-subtle)] bg-[var(--learn-card-bg)] flex items-center justify-center text-[var(--warning)] shadow-sm hover:bg-[var(--brand-100)] transition-colors"
                    title="提示"
                    aria-label="提示"
                  >
                    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <circle cx="12" cy="12" r="10" />
                      <path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3" />
                      <line x1="12" y1="17" x2="12.01" y2="17" />
                    </svg>
                  </button>
                )}
                {/* 渐进式：提示开启时，「讲一讲」等 headerActions 仅在看过提示后出现（hints 有缓存即视为看过）；提示未开启时不 gate（向后兼容） */}
                {headerActions && (!requestHint || hints?.[q.n]) && headerActions(q)}
              </div>
            )}
          </div>
          {/* 提示抽屉 */}
          {hintState.show && (
            <div className="mt-3 p-3 rounded-lg bg-[var(--brand-100)] border-l-[3px] border-[var(--warning)]">
              {hintState.loading ? (
                <div className="flex items-center gap-2 text-sm text-[var(--text-secondary)]">
                  <svg className="animate-spin text-[var(--warning)]" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                    <path d="M21 12a9 9 0 1 1-6.219-8.56" />
                  </svg>
                  <span>正在生成提示…</span>
                </div>
              ) : hints?.[q.n] ? (
                <div className="text-sm text-[var(--text-primary)] leading-relaxed">
                  <ReactMarkdown remarkPlugins={markdownRemarkPlugins} rehypePlugins={markdownRehypePlugins} components={questionMarkdownComponents}>
                    {preprocessMarkdown(hints[q.n])}
                  </ReactMarkdown>
                </div>
              ) : (
                <p className="text-sm text-[var(--text-primary)] leading-relaxed">
                  {hintState.error ? '提示生成失败，请稍后再试。' : '暂无提示'}
                </p>
              )}
            </div>
          )}
        </div>

        {/* 作答区：选择题点选 / 文本作答（左编辑右预览草稿）。保底高度：长题面滚动限高时不被挤没 */}
        <div className="flex-1 min-h-[280px] flex">
          {choiceOptions ? (
            <div className="flex-1 min-h-0 overflow-auto">
              <ChoiceOptionList options={choiceOptions} value={answer} onChange={updateAnswer} />
            </div>
          ) : (
            <>
              <div className="w-1/2 border-r border-[var(--bg-subtle)] flex flex-col">
                <LatexEditor value={answer} onChange={updateAnswer} />
              </div>
              {/* 右半区：预览 / 草稿 tab。主线保留数学草稿（PRD §7.12）；训练轨答题页传 draftDisabled
                  关闭——页面级 DraftDrawer 取代内嵌草稿，其余上下文（AnswerModal 弹窗 / CleanupPhase
                  错题巩固）不受影响，仍按 subjectId === MATH_SUBJECT_ID 启用 */}
              <div className="w-1/2">
                <PreviewDraftPanel
                  answer={answer}
                  questionId={`${draftKeyPrefix}-${q.n}`}
                  enabled={!draftDisabled && subjectId === MATH_SUBJECT_ID}
                />
              </div>
            </>
          )}
        </div>

        {/* 底部：关闭（可选）/ 上一题 / 提交 */}
        <div className="shrink-0 flex items-center justify-between p-3 border-t border-[var(--bg-subtle)]">
          <div className="flex items-center gap-2">
            {onClose && (
              <button
                onClick={() => onClose(Object.keys(resultsRef.current).length)}
                className="w-10 h-10 rounded-full border border-[var(--bg-subtle)] bg-[var(--learn-card-bg)] flex items-center justify-center text-[var(--text-tertiary)] hover:bg-[var(--bg-base)] transition-colors"
                title="关闭"
                aria-label="关闭"
              >
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                  <line x1="18" y1="6" x2="6" y2="18" />
                  <line x1="6" y1="6" x2="18" y2="18" />
                </svg>
              </button>
            )}
            {showPrevButton && (
              <button
                onClick={() => setIdx((i) => Math.max(0, i - 1))}
                disabled={idx <= 0}
                className="flex items-center gap-1 h-10 px-4 rounded-lg border border-[var(--bg-subtle)] text-[var(--text-tertiary)] text-sm disabled:opacity-40 hover:bg-[var(--bg-base)] transition-colors"
              >
                <ChevronLeftIcon />
                <span>上一题</span>
              </button>
            )}
          </div>
          <button
            onClick={handleSubmit}
            disabled={!answer.trim()}
            className="w-12 h-12 rounded-full bg-[var(--brand-500)] text-white flex items-center justify-center disabled:opacity-40 hover:bg-[var(--brand-600)] transition-all shadow-md"
            title="提交"
            aria-label="提交"
          >
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <line x1="5" y1="12" x2="19" y2="12" />
              <polyline points="12 5 19 12 12 19" />
            </svg>
          </button>
        </div>
      </div>
    </div>
  );

  const view = phase === 'self_assess' ? selfAssessView
    : phase === 'judging' ? (judgingSlot ?? judgingView)
    : answeringView;

  // ========== 外壳：variant 只影响这里，内部答题区完全一致 ==========
  if (variant === 'modal') {
    return (
      <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40" role="dialog" aria-modal="true">
        {/* relative：modalExtras（DiscussDrawer 等 absolute 浮层）以本壳为定位容器 */}
        <div className="relative w-[92vw] max-w-5xl h-[88vh] flex flex-col p-3">
          {view}
          {(phase === 'answering' || phase === 'self_assess') && modalExtras}
        </div>
      </div>
    );
  }

  return (
    <div className="flex-1 min-h-0 flex flex-col" style={{ maxWidth: 'var(--learn-card-max-w)', width: '100%', margin: '0 auto' }}>
      {view}
    </div>
  );
}
