import { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Button, Card, PageHeader, Skeleton } from '@/components/base';
import {
  getKnowledgePoints,
  startTargetedPractice,
  type TrainingKnowledgePoint,
} from '@/services/api';
import { MATH_TASK_CODE, tierStatus, usePointTiers } from './point-tiers';
import type { TargetedRunHandoff } from './run-handoff';

/** id 对应 subjects 表 seed（1=数学），与现有训练页一致。 */
const MATH_SUBJECT_ID = 1;

/** 题型枚举与后端 questions.type 一致；空串 = 全部（payload type 传 null）。 */
const TYPE_OPTIONS = [
  { value: '', label: '全部' },
  { value: 'choice', label: '选择' },
  { value: 'fill_blank', label: '填空' },
  { value: 'true_false', label: '判断' },
  { value: 'short_answer', label: '解答' },
  { value: 'proof', label: '证明' },
  { value: 'calculation', label: '计算' },
] as const;

const selectClassName =
  'h-10 px-3 rounded-[var(--radius-button)] border border-[var(--learn-card-border)] ' +
  'bg-[var(--learn-card-bg)] text-[var(--learn-text-primary)] text-sm ' +
  'focus:outline-none focus:ring-2 focus:ring-[var(--brand-100)]';

/** 一级知识点 Chip（单选）。 */
function KpChip({
  label,
  active,
  onClick,
}: {
  label: string;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={
        'h-10 px-4 rounded-full border text-sm font-medium transition-colors ' +
        (active
          ? 'border-[var(--brand-500)] bg-[var(--brand-500)] text-[var(--text-on-brand)]'
          : 'border-[var(--learn-card-border)] bg-[var(--learn-card-bg)] text-[var(--learn-text-secondary)] hover:border-[var(--brand-500)]')
      }
    >
      {label}
    </button>
  );
}

/**
 * 题量档按钮（单选）：主行档位名，副行分值 + 剩余次数。
 * 档位与分值都来自 `GET /points/me/rules`（家长可改），前端不硬编码。
 */
function TierChip({
  label,
  points,
  status,
  active,
  capped,
  onClick,
}: {
  label: string;
  points: number;
  status: string | null;
  active: boolean;
  capped: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={
        'flex flex-col items-center justify-center min-h-11 px-4 py-1.5 rounded-full border ' +
        'text-sm font-medium transition-colors ' +
        (active
          ? 'border-[var(--brand-500)] bg-[var(--brand-500)] text-[var(--text-on-brand)]'
          : 'border-[var(--learn-card-border)] bg-[var(--learn-card-bg)] text-[var(--learn-text-secondary)] hover:border-[var(--brand-500)]') +
        (capped && !active ? ' opacity-60' : '')
      }
    >
      <span>{label}</span>
      <span
        className={
          'text-[0.625rem] font-normal ' +
          (active ? 'opacity-90' : 'text-[var(--learn-text-tertiary)]')
        }
      >
        +{points} 分{status ? ` · ${status}` : ''}
      </span>
    </button>
  );
}

/** 二级知识点列表项（单选）。 */
function KpListItem({
  name,
  active,
  onClick,
}: {
  name: string;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={
        'flex items-center gap-3 rounded-[var(--radius-card)] border px-4 py-3 text-left text-sm transition-colors ' +
        (active
          ? 'border-[var(--brand-500)] bg-[var(--brand-100)] text-[var(--learn-text-primary)]'
          : 'border-[var(--learn-card-border)] bg-[var(--learn-card-bg)] text-[var(--learn-text-primary)] hover:border-[var(--brand-500)]')
      }
    >
      <span
        className={
          'w-4 h-4 shrink-0 rounded-full border-2 ' +
          (active ? 'border-[var(--brand-500)] bg-[var(--brand-500)]' : 'border-[var(--learn-card-border)]')
        }
        aria-hidden="true"
      />
      <span className="min-w-0 truncate">{name}</span>
    </button>
  );
}

export default function TargetedConfigPage() {
  const navigate = useNavigate();

  // KP 平铺列表（mount 拉一次）
  const [kps, setKps] = useState<TrainingKnowledgePoint[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  // 级联选择状态
  const [parentKpId, setParentKpId] = useState<number | null>(null);
  const [childKpId, setChildKpId] = useState<number | null>(null);

  // 题型 / 题量（题量档位来自积分规则，家长可改；`tiers == null` = 仍在加载）
  const [type, setType] = useState('');
  const {
    tiers,
    tierKey,
    setTierKey,
    error: tiersError,
    retry: loadTiers,
  } = usePointTiers(MATH_TASK_CODE);

  // 开练状态
  const [starting, setStarting] = useState(false);
  const [startError, setStartError] = useState<string | null>(null);
  const [emptyHint, setEmptyHint] = useState(false);

  const loadKps = useCallback(async () => {
    setLoadError(null);
    try {
      const data = await getKnowledgePoints(MATH_SUBJECT_ID);
      setKps(data);
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : '加载知识点失败');
      setKps([]);
    }
  }, []);

  useEffect(() => {
    void loadKps();
  }, [loadKps]);

  // 平铺列表 -> 一级 / 当前一级的二级
  const parentKps = useMemo(
    () => (kps ?? []).filter((k) => k.parentKpId == null),
    [kps],
  );
  const childKps = useMemo(
    () => (kps ?? []).filter((k) => k.parentKpId === parentKpId),
    [kps, parentKpId],
  );

  const selectParent = (id: number) => {
    if (parentKpId === id) return;
    setParentKpId(id);
    // 切一级必清二级（不同一级下二级 id 不重叠，但语义上重置更明确）
    setChildKpId(null);
    setEmptyHint(false);
  };

  const canStart = parentKpId != null && childKpId != null && tierKey != null && !starting;

  const startPractice = async () => {
    if (!canStart || childKpId == null || tierKey == null) return;
    setStarting(true);
    setStartError(null);
    setEmptyHint(false);
    try {
      const res = await startTargetedPractice({
        subjectId: MATH_SUBJECT_ID,
        kpId: childKpId,
        type: type || null,
        // tierKey 对这两个任务是纯数字字符串（家长端不能新增档位），直接当题量
        count: Number(tierKey),
      });
      if (res.questions.length === 0) {
        // 空集合非错误：提示后留在配置页，学生可换专项/题型再试
        setEmptyHint(true);
        return;
      }
      // 题单 + 会话 id 交给 run 页（读后即删）：sessionId 是收尾发分的唯一凭据，
      // 丢掉它 run 页就没法调 completeTrainingSession（可能是 null = 降级不发分）
      const handoff: TargetedRunHandoff = { sessionId: res.sessionId, questions: res.questions };
      sessionStorage.setItem('training:targeted', JSON.stringify(handoff));
      navigate('/student/training/targeted/run');
    } catch (err) {
      setStartError(err instanceof Error ? err.message : '开练失败，请重试');
    } finally {
      setStarting(false);
    }
  };

  return (
    <div className="student-theme-container" data-theme="student-day" data-school="junior">
      <div className="min-h-screen bg-[var(--bg-page)] text-[var(--text-primary)]">
        <div className="mx-auto w-full max-w-[64rem] px-4 sm:px-8 pt-6 sm:pt-8 pb-16">
          {/* 顶栏 */}
          <PageHeader to="/student/training/home" caption="返回训练" title="专项练习" />

          {/* 工具条：不再展示清单入口 */}
          <div className="flex justify-end mb-3">
            <Button
              variant="secondary"
              size="sm"
              onClick={() => navigate('/student/training/targeted/hidden')}
            >
              我的不再展示清单
            </Button>
          </div>

          {/* 配置区 */}
          <Card className="mt-6 space-y-6 bg-[var(--learn-card-bg)] border border-[var(--learn-card-border)]">
            {/* 知识点两级选择 */}
            <section aria-label="知识点选择">
              <h2 className="text-sm font-semibold text-[var(--learn-text-secondary)] mb-3">知识点</h2>
              {kps == null && !loadError ? (
                <div className="space-y-3">
                  <Skeleton width="40%" height={14} />
                  <Skeleton height={40} />
                </div>
              ) : loadError ? (
                <div className="flex items-center gap-4">
                  <p className="text-sm text-[var(--learn-text-secondary)]">{loadError}</p>
                  <Button variant="secondary" size="sm" onClick={() => void loadKps()}>
                    重试
                  </Button>
                </div>
              ) : parentKps.length === 0 ? (
                <p className="text-sm text-[var(--learn-text-secondary)]">暂无可选知识点</p>
              ) : (
                <div className="space-y-4">
                  {/* 一级 Chip 组（单选） */}
                  <div className="flex flex-wrap gap-2">
                    {parentKps.map((kp) => (
                      <KpChip
                        key={kp.id}
                        label={kp.name}
                        active={parentKpId === kp.id}
                        onClick={() => selectParent(kp.id)}
                      />
                    ))}
                  </div>
                  {/* 二级列表（单选；未选一级时提示引导） */}
                  {parentKpId != null &&
                    (childKps.length === 0 ? (
                      <p className="text-sm text-[var(--learn-text-tertiary)]">
                        该专项下暂无细分知识点
                      </p>
                    ) : (
                      <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                        {childKps.map((kp) => (
                          <KpListItem
                            key={kp.id}
                            name={kp.name}
                            active={childKpId === kp.id}
                            onClick={() => {
                              setChildKpId(kp.id);
                              setEmptyHint(false);
                            }}
                          />
                        ))}
                      </div>
                    ))}
                </div>
              )}
            </section>

            {/* 题型 + 题量 */}
            <section className="flex flex-wrap items-end gap-6" aria-label="题型与题量">
              <label className="flex flex-col gap-1.5">
                <span className="text-xs font-medium text-[var(--learn-text-secondary)]">题型</span>
                <select
                  value={type}
                  onChange={(e) => {
                    setType(e.target.value);
                    setEmptyHint(false);
                  }}
                  className={selectClassName}
                  aria-label="题型筛选"
                >
                  {TYPE_OPTIONS.map((opt) => (
                    <option key={opt.value} value={opt.value}>{opt.label}</option>
                  ))}
                </select>
              </label>
              <div className="flex flex-col gap-1.5">
                <span className="text-xs font-medium text-[var(--learn-text-secondary)]">题量</span>
                {tiersError ? (
                  <div className="flex items-center gap-3">
                    <p className="text-sm text-[var(--learn-text-secondary)]">{tiersError}</p>
                    <Button variant="secondary" size="sm" onClick={() => void loadTiers()}>
                      重试
                    </Button>
                  </div>
                ) : tiers == null ? (
                  <div className="flex flex-wrap gap-2" data-testid="tier-skeleton">
                    <Skeleton width={72} height={44} rounded />
                    <Skeleton width={72} height={44} rounded />
                    <Skeleton width={72} height={44} rounded />
                  </div>
                ) : tiers.length === 0 ? (
                  <p className="text-sm text-[var(--learn-text-secondary)]">家长已停用该任务</p>
                ) : (
                  <div className="flex flex-wrap gap-2">
                    {tiers.map((tier) => {
                      const { text, capped } = tierStatus(tier);
                      return (
                        <TierChip
                          key={tier.tierKey}
                          label={tier.tierLabel}
                          points={tier.points}
                          status={text}
                          active={tierKey === tier.tierKey}
                          capped={capped}
                          onClick={() => {
                            setTierKey(tier.tierKey);
                            setEmptyHint(false);
                          }}
                        />
                      );
                    })}
                  </div>
                )}
              </div>
            </section>

            {/* 开练 + 反馈 */}
            <section className="flex flex-col gap-3">
              <div className="flex items-center gap-4">
                <Button
                  variant="primary"
                  size="lg"
                  loading={starting}
                  disabled={!canStart}
                  onClick={() => void startPractice()}
                >
                  开始练习
                </Button>
                {parentKpId != null && childKpId == null && !starting && (
                  <span className="text-xs text-[var(--learn-text-tertiary)]">
                    请先选择细分知识点
                  </span>
                )}
              </div>
              {emptyHint && (
                <p className="text-sm text-[var(--learn-text-secondary)]">该专项题目已练完或全部标记不再展示。可更换专项/题型，或在「我的不再展示清单」中重置。</p>
              )}
              {startError && (
                <p className="text-sm text-[var(--error)]">{startError}</p>
              )}
            </section>
          </Card>
        </div>
      </div>
    </div>
  );
}
