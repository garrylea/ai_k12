import { useEffect, useState } from 'react';
import { Link, useLocation, useNavigate, useParams } from 'react-router-dom';
import ReactMarkdown from 'react-markdown';
import { Card, Skeleton } from '@/components/base';
import { toast } from '@/components/base/Toast';
import {
  markdownRemarkPlugins,
  markdownRemarkPluginsWithBreaks,
  markdownRehypePlugins,
  markdownComponents,
  makeAnswerComponents,
  preprocessMarkdown,
  preprocessMaterialMarkdown,
} from '@/components/markdown';
import { autoWrapMath } from '@/components/business/LatexPreview';
import {
  getMyPointRules,
  getPracticeHistoryDetail,
  redoPractice,
  startSimilarPractice,
  type PracticeHistoryDetail,
  type PracticeHistoryQuestion,
} from '@/services/api';
import {
  getTrainingSubject,
  SIMILAR_PRACTICE_SUBJECTS,
  TRAINING_SUBJECTS,
} from '@/subjectConfig';

/**
 * 练习记录详情（2026-11-01）——逐题回放：题面 + 我的答案 + 正确答案 + 解析 + 对错。
 *
 * 回放是只读的；单题动作按后端下发的 `canRedo` / `canSimilar` 显示
 * （2026-11-06）：重做不建记录、不发分；同类型等同一轮专项训练，走
 * `/student/training/targeted/run` 并在收尾 complete 发档位分。
 * 语文三专项的 questionId 为 null：answerText 是 JSON，题面改为「篇名 + 句原文」。
 * Markdown 一律走 `@/components/markdown` 共享配置（图片 resolveAsset / HTML / 表格带线）。
 */

const SUBJECT_NAME = new Map<number, string>(TRAINING_SUBJECTS.map((s) => [s.id, s.name]));

/** 同类型练习的可选题量：与后端档位白名单一致（2 题档为新补）。 */
const SIMILAR_COUNT_WHITELIST = [1, 2, 3, 5];

/** 学生作答专用 components（大图）：手绘/拍照的电路图、装置图按题面小图会被压成细线。 */
const answerComponents = makeAnswerComponents();

function formatDateTime(iso: string): string {
  const d = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function MarkdownBlock({
  text,
  className,
  components = markdownComponents,
  breaks = false,
  material = false,
}: {
  text: string;
  className?: string;
  components?: typeof markdownComponents;
  /** 保留软换行（学生作答）：与考试结果页「你的答案」一致，否则多行步骤会挤成一段 */
  breaks?: boolean;
  /** 材料：单个换行按自然段处理（管线一行一段），见 preprocessMaterialMarkdown */
  material?: boolean;
}) {
  return (
    <div className={className}>
      <ReactMarkdown
        remarkPlugins={breaks ? markdownRemarkPluginsWithBreaks : markdownRemarkPlugins}
        rehypePlugins={markdownRehypePlugins}
        components={components}
      >
        {material ? preprocessMaterialMarkdown(text) : preprocessMarkdown(text)}
      </ReactMarkdown>
    </div>
  );
}

/** 语文专项的结构化作答 JSON → 可读键值行。解析失败返回 null（退化为原文展示）。 */
function parseStructured(answerText: string | null): Array<{ label: string; value: string }> | null {
  if (!answerText) return null;
  try {
    const obj = JSON.parse(answerText) as Record<string, unknown>;
    if (obj === null || typeof obj !== 'object') return null;
    const rows: Array<{ label: string; value: string }> = [];
    if (typeof obj.author === 'string') rows.push({ label: '作者', value: obj.author });
    if (typeof obj.dynasty === 'string') rows.push({ label: '朝代', value: obj.dynasty });
    if (typeof obj.body === 'string') rows.push({ label: '正文', value: obj.body });
    if (typeof obj.translation === 'string') rows.push({ label: '整句翻译', value: obj.translation });
    if (typeof obj.meaning === 'string') rows.push({ label: '深层含义', value: obj.meaning });
    if (typeof obj.emotion === 'string') rows.push({ label: '作者情感', value: obj.emotion });
    if (Array.isArray(obj.terms)) {
      const terms = (obj.terms as Array<{ term?: unknown; answer?: unknown }>)
        .filter((t) => t && typeof t.term === 'string')
        .map((t) => `${String(t.term)}：${typeof t.answer === 'string' ? t.answer : ''}`)
        .join('；');
      if (terms) rows.push({ label: '重点字词', value: terms });
    }
    return rows.length > 0 ? rows : null;
  } catch {
    return null;
  }
}

/** 「未作答」优先于三态判定：未答的题 isCorrect 为 null，不能显示成「未判定」。 */
function StatusBadge({ isCorrect, answered }: { isCorrect: boolean | null; answered: boolean }) {
  if (!answered) {
    return (
      <span className="inline-flex items-center rounded-[var(--radius-pill)] bg-[var(--bg-subtle)] px-2 py-0.5 text-xs text-[var(--warning)]">
        未作答
      </span>
    );
  }
  if (isCorrect === true) {
    return (
      <span className="inline-flex items-center gap-1 rounded-[var(--radius-pill)] bg-[var(--bg-subtle)] px-2 py-0.5 text-xs text-[var(--success)]">
        <svg aria-hidden="true" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
          <polyline points="20 6 9 17 4 12" />
        </svg>
        答对
      </span>
    );
  }
  if (isCorrect === false) {
    return (
      <span className="inline-flex items-center gap-1 rounded-[var(--radius-pill)] bg-[var(--bg-subtle)] px-2 py-0.5 text-xs text-[var(--error)]">
        <svg aria-hidden="true" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round">
          <line x1="6" y1="6" x2="18" y2="18" />
          <line x1="18" y1="6" x2="6" y2="18" />
        </svg>
        答错
      </span>
    );
  }
  return (
    <span className="inline-flex items-center rounded-[var(--radius-pill)] bg-[var(--bg-subtle)] px-2 py-0.5 text-xs text-[var(--text-tertiary)]">
      未判定
    </span>
  );
}

function QuestionCard({
  q,
  similarCounts,
  onRedo,
  onSimilar,
}: {
  q: PracticeHistoryQuestion;
  similarCounts: number[];
  onRedo: (q: PracticeHistoryQuestion) => Promise<void>;
  onSimilar: (q: PracticeHistoryQuestion, count: number) => Promise<void>;
}) {
  const structured = parseStructured(q.answerText);
  const isChineseSpecial = q.questionId === null;
  const answered = q.method !== 'unanswered' && q.answerText != null;
  // 面板/loading 是逐题状态：切记录时卡片 key 可能复用，关掉上一条残留的面板
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    setOpen(false);
    setBusy(false);
  }, [q]);

  return (
    <li className="rounded-[var(--radius-md)] border border-[var(--bg-subtle)] bg-[var(--bg-card)] p-4">
      <div className="mb-3 flex items-center gap-2">
        <span className="text-sm text-[var(--text-tertiary)]">{`第 ${q.questionOrder} 题`}</span>
        <StatusBadge isCorrect={q.isCorrect} answered={answered} />
        {(q.canRedo || (q.canSimilar && similarCounts.length > 0)) && (
          <div className="ml-auto flex items-center gap-1">
            {q.canRedo && (
              <button
                type="button"
                disabled={busy}
                onClick={() => { setBusy(true); void onRedo(q).finally(() => setBusy(false)); }}
                className="inline-flex h-8 items-center gap-1 rounded-[var(--radius-button)] px-2 text-sm font-semibold text-[var(--text-primary)] hover:bg-[var(--bg-subtle)] disabled:opacity-50"
              >
                <svg aria-hidden="true" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M3 12a9 9 0 1 0 3-6.7"/><polyline points="3 4 3 9 8 9"/></svg>
                重做
              </button>
            )}
            {q.canSimilar && similarCounts.length > 0 && (
              <div className="relative">
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => setOpen((v) => !v)}
                  className="inline-flex h-8 items-center gap-1 rounded-[var(--radius-button)] px-2 text-sm font-semibold text-[var(--brand-500)] hover:bg-[var(--brand-100)] disabled:opacity-50"
                >
                  <svg aria-hidden="true" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="8" y="8" width="12" height="12" rx="2"/><path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2"/></svg>
                  同类型练习
                </button>
                {open && (
                  <div className="absolute right-0 top-9 z-10 w-[236px] rounded-[var(--radius-md)] border border-[var(--bg-subtle)] bg-[var(--bg-card)] p-3 shadow-[var(--shadow-card)]">
                    <p className="mb-2 text-xs text-[var(--text-tertiary)]">练几题</p>
                    <div className="flex gap-1.5">
                      {similarCounts.map((n) => (
                        <button
                          key={n}
                          type="button"
                          disabled={busy}
                          onClick={() => { setOpen(false); setBusy(true); void onSimilar(q, n).finally(() => setBusy(false)); }}
                          className="h-8 flex-1 rounded-lg border border-[var(--bg-subtle)] text-sm font-semibold text-[var(--text-secondary)] hover:border-[var(--brand-500)] hover:text-[var(--brand-500)] disabled:opacity-50"
                        >
                          {n}
                        </button>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            )}
          </div>
        )}
      </div>

      {/* 材料（语文/英语阅读材料、物化题内材料）：独立区块、可滚动，样式与结果页一致 */}
      {q.materialText && (
        <div
          data-testid="history-material"
          className="md-prose mb-3 max-h-[32vh] overflow-y-auto rounded-lg border border-[var(--bg-subtle)] bg-[var(--bg-base)] px-3 py-2 text-sm text-[var(--text-primary)] leading-[1.7]"
        >
          <MarkdownBlock text={q.materialText} material />
        </div>
      )}

      {/* 题面：考试取 questionContent；语文专项取篇名 + 句原文 */}
      {q.questionContent ? (
        <MarkdownBlock text={q.questionContent} className="mb-3 text-sm text-[var(--text-primary)]" />
      ) : isChineseSpecial ? (
        <div className="mb-3 text-sm text-[var(--text-primary)]">
          {q.passageTitle && <p className="font-semibold">{q.passageTitle}</p>}
          {q.passageSentence && <p className="mt-1 text-[var(--text-secondary)]">{q.passageSentence}</p>}
        </div>
      ) : null}

      {/* 我的答案 */}
      <div className="mb-2 text-sm">
        <span className="text-[var(--text-tertiary)]">我的答案：</span>
        {structured ? (
          <div className="mt-1 space-y-0.5 pl-1">
            {structured.map((r) => (
              <div key={r.label} className="text-[var(--text-primary)]">
                <span className="text-[var(--text-tertiary)]">{`${r.label}：`}</span>
                {r.value}
              </div>
            ))}
          </div>
        ) : q.answerText ? (
          // 学生作答是**裸 LaTeX**（输入框存原文，预览区 LatexPreview 也会自动补 $）；
          // 不回填定界符就原样显示 \frac{1}{5}。口径与考试结果页 AnswerResultList 一致。
          <MarkdownBlock
            text={autoWrapMath(q.answerText)}
            components={answerComponents}
            breaks
            className="mt-1 text-[var(--text-primary)]"
          />
        ) : (
          <span className="text-[var(--text-tertiary)]">（未作答）</span>
        )}
      </div>

      {/* 正确答案 */}
      {q.questionAnswer ? (
        <div className="mb-2 text-sm">
          <span className="text-[var(--text-tertiary)]">正确答案：</span>
          <MarkdownBlock text={q.questionAnswer} className="mt-1 text-[var(--success)]" />
        </div>
      ) : null}

      {/* 解析 */}
      {q.analysis || q.questionAnalysis ? (
        <div className="mt-3 border-t border-[var(--bg-subtle)] pt-3">
          <p className="mb-1 text-xs text-[var(--text-tertiary)]">解析</p>
          <MarkdownBlock
            text={q.analysis ?? q.questionAnalysis ?? ''}
            className="text-sm text-[var(--text-secondary)]"
          />
        </div>
      ) : (
        <p className="mt-2 text-xs text-[var(--text-tertiary)]">解析未生成</p>
      )}
    </li>
  );
}

export default function PracticeHistoryDetailPage() {
  const { source, sessionId } = useParams<{ source: string; sessionId: string }>();
  const navigate = useNavigate();
  const location = useLocation();
  const [data, setData] = useState<PracticeHistoryDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [notFound, setNotFound] = useState(false);
  // 同类型题量 = 学生可用档位 ∩ [1,2,3,5]；空数组 → 不渲染同类型入口
  const [similarCounts, setSimilarCounts] = useState<number[]>([]);

  useEffect(() => {
    if (source !== 'exam' && source !== 'special') {
      setNotFound(true);
      setLoading(false);
      return;
    }
    const sid = Number(sessionId);
    if (!Number.isInteger(sid) || sid < 1) {
      setNotFound(true);
      setLoading(false);
      return;
    }
    let cancelled = false;
    setLoading(true);
    setNotFound(false);
    // 切记录先清档位：否则新记录会拿上一条的题量闪一下同类型按钮
    setSimilarCounts([]);
    getPracticeHistoryDetail(source, sid)
      .then((d) => {
        if (!cancelled) setData(d);
      })
      .catch(() => {
        if (!cancelled) setNotFound(true);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [source, sessionId]);

  useEffect(() => {
    if (!data) return;
    const subjectId = data.session.subjectId;
    // 同类型只开数学/物理/语文（语文仅基础运用与古诗文）；后端 canSimilar 已兜底，这里再挡一层
    if (!SIMILAR_PRACTICE_SUBJECTS.has(subjectId)) {
      setSimilarCounts([]);
      return;
    }
    const taskCode = getTrainingSubject(subjectId)?.targetedTaskCode;
    if (!taskCode) {
      setSimilarCounts([]);
      return;
    }
    if (!data.questions.some((q) => q.canSimilar)) {
      setSimilarCounts([]);
      return;
    }
    let cancelled = false;
    getMyPointRules()
      .then((rules) => {
        const tiers = rules.tasks.find((t) => t.taskCode === taskCode)?.tiers ?? [];
        const allowed = new Set(tiers.filter((t) => t.isActive).map((t) => t.tierKey));
        if (!cancelled) {
          setSimilarCounts(SIMILAR_COUNT_WHITELIST.filter((n) => allowed.has(String(n))));
        }
      })
      .catch(() => {
        if (!cancelled) setSimilarCounts([]);
      });
    return () => {
      cancelled = true;
    };
  }, [data]);

  if (loading) {
    return (
      <div className="mx-auto max-w-3xl space-y-3 px-6 py-8" data-testid="history-detail-skeleton">
        <Skeleton width="60%" height={28} rounded />
        <Skeleton width="100%" height={140} rounded />
        <Skeleton width="100%" height={140} rounded />
      </div>
    );
  }

  if (notFound || !data) {
    return (
      <div className="mx-auto max-w-3xl space-y-4 px-6 py-8">
        <Card className="p-6">
          <p className="text-sm text-[var(--text-secondary)]">这条练习记录不存在，或不属于你。</p>
          <Link
            to="/student/practice-history"
            state={location.state}
            className="mt-3 inline-block text-sm text-[var(--brand-500)] underline"
          >
            返回练习记录
          </Link>
        </Card>
      </div>
    );
  }

  const { session, questions } = data;
  const inProgress = session.completedAt === null;

  /** 重做：同一道原题再练一遍——交接体 sessionId 固定 null（不建记录、不发分）。 */
  async function handleRedo(q: PracticeHistoryQuestion) {
    if (!data || q.questionId == null) return;
    try {
      const res = await redoPractice(data.session.source, data.session.sessionId, q.questionId);
      sessionStorage.setItem('training:targeted', JSON.stringify({
        sessionId: null, questions: res.questions, title: res.title, mode: 'redo',
      }));
      const returnTo = `/student/practice-history/${data.session.source}/${data.session.sessionId}`;
      navigate(`/student/training/targeted/run?subjectId=${data.session.subjectId}&returnTo=${encodeURIComponent(returnTo)}`);
    } catch {
      toast('error', '重做暂时不可用，请稍后再试');
    }
  }

  /** 同类型：等同一轮专项训练——带 sessionId 交给答题页收尾发档位分。 */
  async function handleSimilar(q: PracticeHistoryQuestion, count: number) {
    if (!data || q.questionId == null) return;
    try {
      const res = await startSimilarPractice(data.session.source, data.session.sessionId, q.questionId, count);
      // 0 题不是错误：留在详情页提示，不跳一个空答题页
      if (res.questions.length === 0) {
        toast('info', '暂时没有同类题');
        return;
      }
      sessionStorage.setItem('training:targeted', JSON.stringify({
        sessionId: res.sessionId, questions: res.questions, title: res.title, mode: 'similar',
      }));
      const returnTo = `/student/practice-history/${data.session.source}/${data.session.sessionId}`;
      navigate(`/student/training/targeted/run?subjectId=${data.session.subjectId}&returnTo=${encodeURIComponent(returnTo)}`);
    } catch {
      toast('error', '暂时没有同类题，请稍后再试');
    }
  }

  return (
    <div className="mx-auto max-w-3xl space-y-6 px-6 py-8">
      <div>
        <Link
          to="/student/practice-history"
          // 把来源页协议带回列表：否则从详情返回列表后，顶栏「退出本页」只能兜底回星图
          state={location.state}
          className="inline-flex items-center gap-1 text-sm text-[var(--text-tertiary)] hover:text-[var(--text-primary)]"
        >
          <svg aria-hidden="true" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <polyline points="15 18 9 12 15 6" />
          </svg>
          返回练习记录
        </Link>
      </div>

      <Card className="p-5">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <span className="rounded-[var(--radius-pill)] bg-[var(--bg-subtle)] px-2 py-0.5 text-xs text-[var(--text-secondary)]">
                {SUBJECT_NAME.get(session.subjectId) ?? '学科'}
              </span>
              <h1 className="text-xl font-black tracking-tight text-[var(--text-primary)]">
                {session.title ?? (session.source === 'exam' ? '考试' : '专项练习')}
              </h1>
              {inProgress && (
                <span className="text-xs text-[var(--text-tertiary)]">进行中</span>
              )}
            </div>
            <p className="mt-2 text-xs text-[var(--text-tertiary)] tabular-nums">
              {formatDateTime(session.startedAt)}
              {session.completedAt ? ` — ${formatDateTime(session.completedAt)}` : ''}
            </p>
          </div>
          <div className="text-right">
            <p className="text-2xl font-bold tabular-nums text-[var(--text-primary)]">
              {`${session.correctCount}/${session.totalCount}`}
            </p>
            <p className="text-xs text-[var(--text-tertiary)]">答对</p>
          </div>
        </div>
      </Card>

      {questions.length === 0 ? (
        <Card className="p-6">
          <p className="text-sm text-[var(--text-secondary)]">这套卷子还没有作答记录。</p>
        </Card>
      ) : (
        <ol className="space-y-3">
          {questions.map((q) => (
            <QuestionCard
              key={`${q.questionOrder}-${q.refType ?? 'q'}-${q.refId ?? q.questionId}`}
              q={q}
              similarCounts={similarCounts}
              onRedo={handleRedo}
              onSimilar={handleSimilar}
            />
          ))}
        </ol>
      )}
    </div>
  );
}
