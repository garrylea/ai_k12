import { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import clsx from 'clsx';
import { Button, Card, PageHeader, Skeleton } from '@/components/base';
import {
  getKnowledgeGraphMastery,
  getMyPointRules,
  getWeakPoints,
  startTargetedPractice,
  type KnowledgeGraphMastery,
  type KnowledgeGraphNode,
  type WeakPointRecommendation,
} from '@/services/api';
import { pickPracticeCount } from './point-tiers';
import { heatForNode, isDashedBorder, summarizeParent } from './weak-point-heat';
import type { TargetedRunHandoff } from './run-handoff';

/** id 对应 subjects 表 seed（1=数学），与训练轨各页一致。 */
const MATH_SUBJECT_ID = 1;

/** 作答页读的 sessionStorage 键（与 TargetedConfigPage 同键，勿另起）。 */
const TARGETED_SESSION_KEY = 'training:targeted';

/** 展开箭头（线性 SVG，展开时旋转 90°）。 */
const ChevronIcon = ({ expanded }: { expanded: boolean }) => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5"
    strokeLinecap="round" strokeLinejoin="round"
    className={clsx('w-4 h-4 transition-transform', expanded && 'rotate-90')} aria-hidden="true">
    <path d="m9 6 6 6-6 6" />
  </svg>
);

function percent(score: number): string {
  return `${Math.round(score * 100)}%`;
}

/**
 * 数学薄弱点图谱（spec `2026-09-23-math-weakpoint-graph-design.md` §6）。
 *
 * 训练轨全屏页：**不在任何 Layout 下、硬编码 `data-theme="student-day"`**（CLAUDE.md 硬约束）。
 *
 * 两个请求**并行发、各自独立状态**：`weak-points` 失败只降级推荐条（图谱仍可用），
 * `mastery` 失败才整页给重试——一栏坏掉不拖垮另一栏。
 */
export default function WeakPointGraphPage() {
  const navigate = useNavigate();
  const studentId = Number(localStorage.getItem('userId')) || 0;

  const [mastery, setMastery] = useState<KnowledgeGraphMastery | null>(null);
  const [masteryError, setMasteryError] = useState(false);
  const [rec, setRec] = useState<WeakPointRecommendation | null>(null);
  const [recFailed, setRecFailed] = useState(false);

  const [expanded, setExpanded] = useState<Set<number>>(new Set());
  const [selectedKpId, setSelectedKpId] = useState<number | null>(null);

  // 档位：决定「开始补这个」的题量（≥3 的最小可用档）
  const [tiers, setTiers] = useState<Array<{ tierKey: string }> | null>(null);
  const [starting, setStarting] = useState(false);
  const [startNotice, setStartNotice] = useState<string | null>(null);

  const loadMastery = useCallback(async () => {
    setMasteryError(false);
    try {
      setMastery(await getKnowledgeGraphMastery(studentId, MATH_SUBJECT_ID));
    } catch {
      setMasteryError(true);
      setMastery(null);
    }
  }, [studentId]);

  const loadRec = useCallback(async () => {
    setRecFailed(false);
    try {
      setRec(await getWeakPoints(studentId, MATH_SUBJECT_ID, 1));
    } catch {
      // 失败只降级推荐条：图谱是主内容，不该被推荐拖垮
      setRecFailed(true);
      setRec(null);
    }
  }, [studentId]);

  useEffect(() => {
    void loadMastery();
    void loadRec();
  }, [loadMastery, loadRec]);

  useEffect(() => {
    let cancelled = false;
    getMyPointRules()
      .then((data) => {
        if (cancelled) return;
        setTiers(data.tasks.find((t) => t.taskCode === 'math_targeted')?.tiers ?? []);
      })
      .catch(() => {
        if (!cancelled) setTiers([]);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const nodes = mastery?.nodes ?? [];

  const parents = useMemo(() => nodes.filter((n) => n.parentId == null), [nodes]);
  const childrenOf = useCallback(
    (parentId: number) => nodes.filter((n) => n.parentId === parentId),
    [nodes],
  );
  const nodeById = useMemo(() => new Map(nodes.map((n) => [n.id, n])), [nodes]);

  const selected = selectedKpId != null ? nodeById.get(selectedKpId) ?? null : null;

  const practiceCount = tiers == null ? null : pickPracticeCount(tiers);

  const toggleParent = (id: number) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  /** 「开始补这个」：复用专项练习开练端点，成功后走既有作答页交接。 */
  const startPractice = async (kpId: number) => {
    if (practiceCount == null || starting) return;
    setStarting(true);
    setStartNotice(null);
    try {
      const res = await startTargetedPractice({
        subjectId: MATH_SUBJECT_ID,
        kpId,
        // 不限题型：薄弱点补漏不该被题型卡住
        type: null,
        count: practiceCount,
      });
      if (res.questions.length === 0) {
        // 空题单非错误：留在本页提示，学生可换知识点
        setStartNotice('暂时抽不到这个知识点的题，换一个试试');
        return;
      }
      const handoff: TargetedRunHandoff = { sessionId: res.sessionId, questions: res.questions };
      sessionStorage.setItem(TARGETED_SESSION_KEY, JSON.stringify(handoff));
      navigate('/student/training/targeted/run');
    } catch (err) {
      setStartNotice(err instanceof Error ? err.message : '开练失败，请重试');
    } finally {
      setStarting(false);
    }
  };

  const goErrors = (kpId?: number) => {
    navigate(kpId == null ? '/student/training/errors' : `/student/training/errors?kpId=${kpId}`);
  };

  return (
    <div
      data-theme="student-day"
      className="min-h-screen flex flex-col items-center p-4"
      style={{ backgroundColor: 'var(--bg-page)' }}
    >
      <div className="w-full max-w-5xl px-4 sm:px-8 py-8">
        <PageHeader
          to="/student/training/home"
          caption="返回训练"
          title="薄弱点图谱 · 数学"
          titleClassName="text-3xl font-extrabold"
        />

        {/* 推荐条：recFailed 时整条不渲染 */}
        {!recFailed && (
          <div className="mt-6">
            {rec == null ? (
              <Skeleton height={72} />
            ) : rec.recommendation ? (
              <Card className="flex flex-wrap items-center gap-4 border border-[var(--learn-card-border)] bg-[var(--learn-card-bg)]">
                <div className="min-w-0 flex-1">
                  <div className="text-lg font-bold text-[var(--text-primary)]">
                    最该补：{rec.recommendation.name}
                  </div>
                  <div className="mt-1 text-sm text-[var(--text-secondary)]">
                    掌握度 {percent(rec.recommendation.masteryScore)} · 样本 {rec.recommendation.sampleSize} 题
                    · 可抽 {rec.recommendation.availableQuestionCount} 题
                  </div>
                </div>
                <div className="flex gap-3">
                  <Button
                    variant="secondary"
                    size="sm"
                    onClick={() => goErrors(rec.recommendation!.knowledgePointId)}
                  >
                    看这个知识点的错题
                  </Button>
                  <Button
                    variant="primary"
                    size="sm"
                    disabled={practiceCount == null || starting}
                    onClick={() => void startPractice(rec.recommendation!.knowledgePointId)}
                  >
                    开始补这个
                  </Button>
                </div>
              </Card>
            ) : (
              <Card className="flex flex-wrap items-center gap-4 border border-[var(--learn-card-border)] bg-[var(--learn-card-bg)]">
                <div className="min-w-0 flex-1">
                  <div className="text-lg font-bold text-[var(--text-primary)]">
                    还没有足够的数据来判断你的薄弱点
                  </div>
                  <div className="mt-1 text-sm text-[var(--text-secondary)]">
                    先做一次练习或考试，我们就能给你诊断。
                  </div>
                </div>
                <div className="flex gap-3">
                  <Button variant="secondary" size="sm" onClick={() => navigate('/student/training/targeted')}>
                    去专项练习
                  </Button>
                  <Button variant="primary" size="sm" onClick={() => navigate('/student/training/exam')}>
                    去考试
                  </Button>
                </div>
              </Card>
            )}
          </div>
        )}

        {startNotice && (
          <div className="mt-4 text-sm text-[var(--text-secondary)]" role="status">
            {startNotice}
          </div>
        )}

        {/* 主体：lg 两栏；窄屏详情降级为底部抽屉（同一个 DOM 节点，靠 class 切换） */}
        {masteryError ? (
          <div className="mt-12 flex flex-col items-center gap-4">
            <p className="text-[var(--text-secondary)]">图谱加载失败</p>
            <Button variant="primary" onClick={() => void loadMastery()}>
              重试
            </Button>
          </div>
        ) : mastery == null ? (
          <div className="mt-8 grid gap-4 lg:grid-cols-[minmax(0,1fr)_20rem]">
            <div className="space-y-3">
              {Array.from({ length: 6 }, (_, i) => (
                <Skeleton key={i} height={52} />
              ))}
            </div>
            <Skeleton height={200} />
          </div>
        ) : (
          <div className="mt-8 grid gap-6 lg:grid-cols-[minmax(0,1fr)_20rem]">
            {/* 左：一级折叠树 */}
            <div className="space-y-2" aria-label="知识点树">
              {parents.map((parent) => {
                const children = childrenOf(parent.id);
                const summary = summarizeParent(children);
                const isOpen = expanded.has(parent.id);
                return (
                  <div key={parent.id}>
                    <button
                      type="button"
                      onClick={() => toggleParent(parent.id)}
                      aria-expanded={isOpen}
                      className="w-full flex items-center gap-3 rounded-[var(--radius-card)] border border-[var(--learn-card-border)] bg-[var(--learn-card-bg)] px-4 py-3 text-left transition-colors hover:bg-[var(--bg-subtle)] focus:outline-none focus:ring-2 focus:ring-[var(--brand-100)]"
                    >
                      <span className="text-[var(--text-tertiary)]">
                        <ChevronIcon expanded={isOpen} />
                      </span>
                      <span
                        className="w-3 h-3 rounded-full shrink-0"
                        style={
                          summary.weakestLevel == null
                            ? { background: 'var(--bg-subtle)' }
                            : { background: heatForNode({ confidence: 'ok', level: summary.weakestLevel }).background }
                        }
                        aria-hidden="true"
                      />
                      <span className="flex-1 font-semibold text-[var(--text-primary)]">{parent.name}</span>
                      <span className="text-sm text-[var(--text-secondary)]">
                        {summary.weakestLevel == null ? '未开始' : `${summary.pendingCount} 个待补`}
                      </span>
                    </button>

                    {isOpen && (
                      <div className="mt-2 flex flex-wrap gap-2 pl-8">
                        {children.map((child) => {
                          const style = heatForNode(child);
                          return (
                            <button
                              key={child.id}
                              type="button"
                              onClick={() => setSelectedKpId(child.id)}
                              className={clsx(
                                'rounded-[var(--radius-button)] px-3 py-2 text-sm font-medium transition-opacity hover:opacity-80 focus:outline-none focus:ring-2 focus:ring-[var(--brand-100)]',
                                isDashedBorder(child.confidence) && 'border border-dashed border-[var(--text-tertiary)]',
                              )}
                              style={style}
                            >
                              {child.name}
                            </button>
                          );
                        })}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>

            {/* 右：详情栏。未选中 → 提示（窄屏隐藏）；选中 → 详情（窄屏为底部抽屉） */}
            <aside
              className={clsx(
                'rounded-[var(--radius-card)] border border-[var(--learn-card-border)] bg-[var(--learn-card-bg)] p-4',
                selected == null
                  ? 'hidden lg:block'
                  : 'fixed inset-x-0 bottom-0 z-20 max-h-[70vh] overflow-y-auto rounded-b-none lg:static lg:max-h-none lg:rounded-b-[var(--radius-card)]',
              )}
              aria-label="知识点详情"
            >
              {selected == null ? (
                <p className="text-sm text-[var(--text-tertiary)]">点左侧知识点看详情</p>
              ) : (
                <KpDetail
                  node={selected}
                  practiceCount={practiceCount}
                  starting={starting}
                  onStart={() => void startPractice(selected.id)}
                  onViewErrors={() => goErrors(selected.id)}
                />
              )}
            </aside>
          </div>
        )}

        {/* 页脚：覆盖口径 + 未标注错题（为 0 时不渲染后半句） */}
        {mastery && (
          <footer className="mt-8 border-t border-[var(--bg-subtle)] pt-4 text-sm text-[var(--text-tertiary)]">
            <p>
              知识点覆盖 {mastery.coverage.coveredQuestions} / {mastery.coverage.totalQuestions} 道题
            </p>
            {mastery.coverage.uncoveredUnclearedErrors > 0 && (
              <p className="mt-1 flex items-center gap-2">
                另有 {mastery.coverage.uncoveredUnclearedErrors} 道未标注知识点的题，不计入上图
                <Button variant="secondary" size="sm" onClick={() => goErrors()}>
                  去错题页看
                </Button>
              </p>
            )}
          </footer>
        )}
      </div>
    </div>
  );
}

/** 详情栏内容：掌握度条 / 对错数 / 最近作答 / 可信度说明 + 两个动作。 */
function KpDetail({
  node,
  practiceCount,
  starting,
  onStart,
  onViewErrors,
}: {
  node: KnowledgeGraphNode;
  practiceCount: number | null;
  starting: boolean;
  onStart: () => void;
  onViewErrors: () => void;
}) {
  return (
    <div className="space-y-3">
      <h2 className="text-lg font-bold text-[var(--text-primary)]">{node.name}</h2>

      {node.confidence === 'none' ? (
        <p className="text-sm text-[var(--text-secondary)]">未开始</p>
      ) : (
        <>
          <div className="text-sm text-[var(--text-secondary)]">
            掌握度 {percent(node.masteryScore ?? 0)}
          </div>
          <div className="h-2 w-full overflow-hidden rounded-full bg-[var(--bg-subtle)]">
            <div
              className="h-full rounded-full"
              style={{
                width: `${Math.round((node.masteryScore ?? 0) * 100)}%`,
                background: heatForNode(node).background,
              }}
            />
          </div>
          <div className="text-sm text-[var(--text-secondary)]">
            对 {node.correctCount} 错 {node.errorCount}
          </div>
          <div className="text-sm text-[var(--text-secondary)]">
            样本 {node.sampleSize} 题
            {node.confidence === 'insufficient' && '（样本不足（<5 题），暂不判定强弱）'}
          </div>
          {node.lastSeenAt && (
            <div className="text-sm text-[var(--text-tertiary)]">
              最近作答 {node.lastSeenAt.slice(0, 10)}
            </div>
          )}
        </>
      )}

      <div className="text-sm text-[var(--text-tertiary)]">
        可抽 {node.availableQuestionCount} 题
      </div>

      <div className="flex flex-col gap-2 pt-1">
        <Button variant="secondary" size="sm" onClick={onViewErrors}>
          看这个知识点的错题
        </Button>
        <Button
          variant="primary"
          size="sm"
          disabled={practiceCount == null || starting}
          onClick={onStart}
        >
          开始补这个
        </Button>
      </div>
    </div>
  );
}
