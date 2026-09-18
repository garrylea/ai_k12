import { useEffect, useMemo, useRef, useState } from 'react';
import clsx from 'clsx';
import { Button, Card, Modal, Skeleton, Tag, toast } from '@/components/base';
import {
  ApiError,
  getParentPointRules,
  saveParentPointRules,
  type PointRuleSaveInput,
  type PointRuleTask,
  type PointRuleTier,
} from '@/services/api';

/**
 * 「积分规则」Tab（计划三 §2.4，Task 5）。
 *
 * 三条最容易写错、也是本组件存在的理由（计划 §1.1#1/#4/#5）：
 *
 * 1. **已下架档位必须显示**：`GET /parent/students/:id/points/rules` 有意不过滤
 *    `is_active`（`listGrouped` 是全量），家长要能看到并**重新启用**。只渲染
 *    `isActive === true` 的行 = 档位一旦下架就永远救不回来。
 * 2. **`PUT` 每条都要三字段齐全**：controller 的 Zod 把 `points`/`dailyLimit`/
 *    `isActive` 都设成必填，所以保存时把**该任务的全部档位**都发出去；`dailyLimit`
 *    空串必须发 `null`（不清真值会把「不限」写成上限）。
 * 3. **`dailyLimit = 0` 非法**：`award()` 的上限判断会恒真 → 该档位永久不发分
 *    （后端也会 400 1001）。前端把「空 = 不限」做成一等公民，并把 0 明确拦在行内。
 *    同理 `points` 只允许 0–9999 整数——负数会写负流水、拉低 `total_earned`，
 *    破坏「段位只升不降」。
 *
 * 草稿/快照分离：`draft` 用**字符串**存输入框原值（`Number()` 后回写会把用户打
 * 「1a」「-」的中间态吞掉），脏判定时才做数值比较。每张任务卡一份草稿、一个保存按钮。
 *
 * 保存后的重拉（父级按 taskCode 记账）：`versions` 决定**重挂哪张卡**（只重挂发起保存的
 * 那张，别的卡草稿不动），`settles` 决定**何时解除 `saving`**——成功、失败都要解除；
 * 待重挂的 taskCode 存在**集合**里（同一重拉窗口内可能连存两张卡）。
 *
 * 接缝：`studentId` 由页面下发；页面切孩子时会重挂载本组件，但本组件自己也把
 * `studentId` 编进「数据归属」与卡片 key——即使页面忘了重挂载，也不会拿上一个
 * 孩子的快照继续编辑（跨学生提交是事故）。
 */

export interface PointRulesPanelProps {
  studentId: number;
}

const POINTS_MIN = 0;
const POINTS_MAX = 9999;
const LIMIT_MIN = 1;
const LIMIT_MAX = 99;

const POINTS_ERROR = `分值请填 ${POINTS_MIN}–${POINTS_MAX} 的整数`;
/** 0 有专门的文案：它不是「没填」，是会让该档位永久不发分的值。 */
const LIMIT_ZERO_ERROR = '不限请留空；填 0 会让该档位不再发分';
const LIMIT_ERROR = `每日上限请填 ${LIMIT_MIN}–${LIMIT_MAX} 的整数，或不填表示不限`;

interface TierDraft {
  /** 输入框原值（字符串），不要解析后回写 */
  points: string;
  /** 空串 = 不限（提交时转 null） */
  dailyLimit: string;
  isActive: boolean;
}

type CardDraft = Record<string, TierDraft>;
type TierErrors = Record<string, { points?: string; dailyLimit?: string }>;

function pointsError(raw: string): string | null {
  if (!/^\d+$/.test(raw)) return POINTS_ERROR;
  const n = Number(raw);
  return n < POINTS_MIN || n > POINTS_MAX ? POINTS_ERROR : null;
}

function limitError(raw: string): string | null {
  if (raw === '') return null;
  if (!/^\d+$/.test(raw)) return LIMIT_ERROR;
  const n = Number(raw);
  if (n === 0) return LIMIT_ZERO_ERROR;
  return n < LIMIT_MIN || n > LIMIT_MAX ? LIMIT_ERROR : null;
}

function toDraft(tier: PointRuleTier): TierDraft {
  return {
    points: String(tier.points),
    dailyLimit: tier.dailyLimit === null ? '' : String(tier.dailyLimit),
    isActive: tier.isActive,
  };
}

function initDraft(task: PointRuleTask): CardDraft {
  const draft: CardDraft = {};
  for (const tier of task.tiers) draft[tier.tierKey] = toDraft(tier);
  return draft;
}

/** 草稿脏判定：与服务器快照做**数值**比较，所以「08」不算改动。非法值自然为脏（保存被校验拦住）。 */
function isTierDirty(tier: PointRuleTier, draft: TierDraft | undefined): boolean {
  if (!draft) return false;
  const points = draft.points === '' ? NaN : Number(draft.points);
  const limit = draft.dailyLimit === '' ? null : Number(draft.dailyLimit);
  return points !== tier.points || limit !== tier.dailyLimit || draft.isActive !== tier.isActive;
}

/** 今日进度文案。`dailyLimit === null` 是「不限」，不是「0 次」。 */
function progressText(tier: PointRuleTier): string {
  if (tier.completedToday === null) return '今日进度 —';
  if (tier.dailyLimit === null) return `今日已发 ${tier.completedToday} 次（不限）`;
  return `今日已发 ${tier.completedToday} / ${tier.dailyLimit} 次`;
}

/** 把一组 taskCode 的计数器各 +1（`versions` / `settles` 共用，两者都是按卡存的计数）。 */
function bumpCounters(prev: Record<string, number>, codes: Set<string>): Record<string, number> {
  const next = { ...prev };
  for (const code of codes) next[code] = (next[code] ?? 0) + 1;
  return next;
}

const INPUT_CLASS =
  'h-9 w-full rounded-[var(--radius-button)] border border-[var(--bg-subtle)] bg-[var(--bg-card)] px-3 text-sm tabular-nums text-[var(--text-primary)] outline-none focus:border-[var(--brand-500)] disabled:cursor-not-allowed disabled:opacity-50';

interface TierRowProps {
  taskCode: string;
  tier: PointRuleTier;
  draft: TierDraft;
  error?: { points?: string; dailyLimit?: string };
  saving: boolean;
  onPatch: (patch: Partial<TierDraft>) => void;
}

function TierRow({ taskCode, tier, draft, error, saving, onPatch }: TierRowProps) {
  const pointsId = `points-${taskCode}-${tier.tierKey}`;
  const limitId = `limit-${taskCode}-${tier.tierKey}`;

  return (
    <div
      data-testid={`tier-row-${taskCode}-${tier.tierKey}`}
      className="flex flex-col gap-3 border-t border-[var(--bg-subtle)] py-4 first:border-t-0 first:pt-0 lg:flex-row lg:items-start lg:gap-4"
    >
      <div className="lg:w-44 lg:shrink-0">
        <div className="flex items-center gap-2">
          <span className="text-sm font-medium text-[var(--text-primary)]">{tier.tierLabel}</span>
          {!draft.isActive && <Tag variant="neutral">已下架</Tag>}
        </div>
        <p className="mt-0.5 text-xs tabular-nums text-[var(--text-tertiary)]">
          {progressText(tier)}
        </p>
      </div>

      <div className="lg:w-28 lg:shrink-0">
        <label htmlFor={pointsId} className="mb-1 block text-xs font-medium text-[var(--text-secondary)]">
          分值
        </label>
        <input
          id={pointsId}
          data-testid={`points-input-${taskCode}-${tier.tierKey}`}
          type="number"
          min={POINTS_MIN}
          max={POINTS_MAX}
          step={1}
          inputMode="numeric"
          value={draft.points}
          disabled={saving}
          aria-invalid={error?.points ? true : undefined}
          onChange={(e) => onPatch({ points: e.target.value })}
          className={clsx(INPUT_CLASS, error?.points && 'border-[var(--error)]')}
        />
        {error?.points && <p className="mt-1 text-xs text-[var(--error)]">{error.points}</p>}
      </div>

      <div className="lg:w-32 lg:shrink-0">
        <label htmlFor={limitId} className="mb-1 block text-xs font-medium text-[var(--text-secondary)]">
          每日上限
        </label>
        <input
          id={limitId}
          data-testid={`limit-input-${taskCode}-${tier.tierKey}`}
          type="number"
          min={LIMIT_MIN}
          max={LIMIT_MAX}
          step={1}
          inputMode="numeric"
          placeholder="不限"
          value={draft.dailyLimit}
          disabled={saving}
          aria-invalid={error?.dailyLimit ? true : undefined}
          onChange={(e) => onPatch({ dailyLimit: e.target.value })}
          className={clsx(INPUT_CLASS, error?.dailyLimit && 'border-[var(--error)]')}
        />
        {error?.dailyLimit && (
          <p className="mt-1 text-xs text-[var(--error)]">{error.dailyLimit}</p>
        )}
      </div>

      <div className="lg:w-24 lg:shrink-0">
        <span className="mb-1 block text-xs font-medium text-[var(--text-secondary)]">启用</span>
        <button
          type="button"
          role="switch"
          aria-checked={draft.isActive}
          aria-label={`${tier.tierLabel} 启用开关`}
          data-testid={`tier-switch-${taskCode}-${tier.tierKey}`}
          disabled={saving}
          onClick={() => onPatch({ isActive: !draft.isActive })}
          className={clsx(
            'relative inline-flex h-6 w-11 shrink-0 items-center rounded-[var(--radius-pill)] transition-colors',
            'focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-[var(--brand-100)]',
            'disabled:cursor-not-allowed disabled:opacity-50',
            draft.isActive ? 'bg-[var(--brand-500)]' : 'bg-[var(--bg-subtle)]',
          )}
        >
          <span
            aria-hidden="true"
            className={clsx(
              'inline-block h-5 w-5 rounded-full bg-[var(--bg-card)] shadow-[var(--shadow-card)] transition-transform',
              draft.isActive ? 'translate-x-[22px]' : 'translate-x-0.5',
            )}
          />
        </button>
      </div>
    </div>
  );
}

interface TaskRulesCardProps {
  studentId: number;
  task: PointRuleTask;
  /**
   * 「本卡那次重拉已结束」的信号，成功与失败都会变号。只用来复位 `saving`
   * （见组件内的 effect），与 `versions` 的重挂载职责**刻意分开**。
   */
  settleToken: number;
  /** 保存后回报**本卡**的 taskCode：父级只重挂这一张卡（见 `versions`）。 */
  onSaved: (taskCode: string) => void;
}

function TaskRulesCard({ studentId, task, settleToken, onSaved }: TaskRulesCardProps) {
  const [draft, setDraft] = useState<CardDraft>(() => initDraft(task));
  const [saving, setSaving] = useState(false);
  const [confirming, setConfirming] = useState<{
    payload: PointRuleSaveInput[];
    messages: string[];
  } | null>(null);

  /**
   * 重拉结束（成功/失败）→ 复位 saving。
   *
   * **不能只靠「成功路径重挂载」复位它**：重拉失败时拿不到新快照，不能重挂载
   * （重挂载会按**旧**快照重新 init 草稿，把家长刚填的值改回去），于是 `saving`
   * 就得靠这条路径解除，否则该卡永久转圈、页面内无法恢复。
   * 成功路径上本卡通常已因 key 变化重挂载（新实例 saving 本就是 false），
   * 这里再置一次是无害的空操作；初始挂载时同样是无害的空操作。
   */
  useEffect(() => {
    setSaving(false);
  }, [settleToken]);

  /** 校验结果由草稿派生（不另存一份 state，避免两份真相漂移）。 */
  const errors = useMemo<TierErrors>(() => {
    const next: TierErrors = {};
    for (const tier of task.tiers) {
      const d = draft[tier.tierKey];
      if (!d) continue;
      const p = pointsError(d.points);
      const l = limitError(d.dailyLimit);
      if (p || l) next[tier.tierKey] = { points: p ?? undefined, dailyLimit: l ?? undefined };
    }
    return next;
  }, [task.tiers, draft]);

  const hasErrors = Object.keys(errors).length > 0;
  const dirty = task.tiers.some((tier) => isTierDirty(tier, draft[tier.tierKey]));
  const canSave = dirty && !hasErrors && !saving;

  const patchTier = (tierKey: string, patch: Partial<TierDraft>) => {
    setDraft((prev) => ({ ...prev, [tierKey]: { ...prev[tierKey], ...patch } }));
  };

  /**
   * 该任务**当前能提交的**档位，每条带齐三字段（后端 Zod 三个都必填）。
   *
   * **缺 draft 的档位直接跳过**（选择项 A，不猜值、不发这条）：draft 只在卡片挂载时
   * 按快照 init，而「重拉带来的新档位」只让**发起保存的那张卡**重挂载，所以别的卡
   * 可能在重拉后拿到一个自己没有 draft 的档位（行也因 `if (!d) return null` 不渲染）。
   * 两种行为里选跳过：后端 `updateBatch` 只更新传入的行（`point-rules.service.ts`），
   * 跳过 = 该档位保持服务端原值，正是「没编辑就不动」的语义；回退用快照值补一条则是
   * 一次**假编辑**（拿可能过期的快照回写一遍），没有收益。跳过的是一条真实存在的档位，
   * 所以留一条内部告警（`console.warn`）而非静默丢。
   *
   * 返回空数组不会出现：`canSave` 要求至少一个档位脏，而脏的档位必有 draft
   * （`isTierDirty` 对缺 draft 返回 false），后端 `rules` 数组的 `min(1)` 因此不会被撞。
   */
  const buildPayload = (): PointRuleSaveInput[] => {
    const payload: PointRuleSaveInput[] = [];
    for (const tier of task.tiers) {
      const d = draft[tier.tierKey];
      if (!d) {
        console.warn(
          `[PointRulesPanel] 档位 ${task.taskCode}.${tier.tierKey} 没有草稿（重拉带入了未重挂载的新档位），本次保存跳过该档位`,
        );
        continue;
      }
      payload.push({
        taskCode: task.taskCode,
        tierKey: tier.tierKey,
        points: Number(d.points),
        dailyLimit: d.dailyLimit === '' ? null : Number(d.dailyLimit),
        isActive: d.isActive,
      });
    }
    return payload;
  };

  const doSave = async (payload: PointRuleSaveInput[]) => {
    setSaving(true);
    try {
      await saveParentPointRules(studentId, payload);
      setConfirming(null);
      toast('success', `已保存「${task.taskName}」的分值`);
      // 重拉：避免拿本地快照继续编辑（别处改了同一批档位时会漂移）。
      // **成功路径故意不解除 saving** —— 重拉回来后卡片会重挂载并重置为不 loading；
      // 在这一帧解除会让按钮瞬间可点，家长双击就能把同一份改动发两遍。
      onSaved(task.taskCode);
    } catch (err: unknown) {
      setConfirming(null);
      // 1001（Zod 校验）与其它错误都回显服务端文案；3005 是唯一需要「重拉 + 重来」的分支。
      if (err instanceof ApiError && err.code === 3005) {
        toast('error', '档位已变化，请确认后重新保存');
        onSaved(task.taskCode);
      } else {
        toast('error', err instanceof Error && err.message ? err.message : '保存失败');
      }
      setSaving(false);
    }
  };

  const handleSave = () => {
    if (!canSave) return;
    const payload = buildPayload();

    // 需要二次确认的两类改动：孩子实际能拿到的分变少，或某个档位被停用。
    // 只对「保存后仍启用」的档位判分值下调——已经停用的档位调分不影响孩子。
    const downgraded = task.tiers.filter((tier) => {
      const d = draft[tier.tierKey];
      return d ? d.isActive && Number(d.points) < tier.points : false;
    });
    const deactivated = task.tiers.filter((tier) => {
      const d = draft[tier.tierKey];
      return d ? tier.isActive && !d.isActive : false;
    });

    const messages: string[] = [];
    if (downgraded.length > 0) {
      messages.push('下调分值后，孩子之后完成该任务只能拿新分值，历史流水不变。');
    }
    if (deactivated.length > 0) {
      messages.push('停用档位后，该档位不会再出现在孩子的可选档位里，也不会再发分（历史流水保留）。');
    }

    if (messages.length > 0) {
      setConfirming({ payload, messages });
      return;
    }
    void doSave(payload);
  };

  return (
    <Card
      data-testid={`point-rules-card-${task.taskCode}`}
      className="border border-[var(--bg-subtle)] p-6"
    >
      <div className="flex items-start justify-between gap-4">
        <div>
          <h3 className="text-base font-bold text-[var(--text-primary)]">{task.taskName}</h3>
          <p className="mt-0.5 font-mono text-xs text-[var(--text-tertiary)]">{task.taskCode}</p>
        </div>
        <Button
          variant={canSave ? 'primary' : 'ghost'}
          size="sm"
          loading={saving}
          disabled={!canSave}
          data-testid={`save-task-${task.taskCode}`}
          onClick={handleSave}
        >
          保存
        </Button>
      </div>

      {task.tiers.length === 0 ? (
        <p className="mt-4 text-sm text-[var(--text-secondary)]">该任务暂无档位</p>
      ) : (
        <div className="mt-4">
          {task.tiers.map((tier) => {
            const d = draft[tier.tierKey];
            if (!d) return null;
            return (
              <TierRow
                key={tier.tierKey}
                taskCode={task.taskCode}
                tier={tier}
                draft={d}
                error={errors[tier.tierKey]}
                saving={saving}
                onPatch={(patch) => patchTier(tier.tierKey, patch)}
              />
            );
          })}
        </div>
      )}

      <Modal
        open={confirming !== null}
        onClose={() => {
          if (!saving) setConfirming(null);
        }}
        title={`确认修改「${task.taskName}」的分值`}
      >
        <div className="space-y-4">
          <ul className="list-disc space-y-2 pl-5 text-sm leading-relaxed text-[var(--text-secondary)]">
            {confirming?.messages.map((message) => (
              <li key={message}>{message}</li>
            ))}
          </ul>
          <div className="flex justify-end gap-3">
            <Button variant="ghost" size="sm" disabled={saving} onClick={() => setConfirming(null)}>
              取消
            </Button>
            <Button
              variant="primary"
              size="sm"
              loading={saving}
              onClick={() => confirming && void doSave(confirming.payload)}
            >
              确认保存
            </Button>
          </div>
        </div>
      </Modal>
    </Card>
  );
}

export default function PointRulesPanel({ studentId }: PointRulesPanelProps) {
  const [data, setData] = useState<{ studentId: number; tasks: PointRuleTask[] } | null>(null);
  const [failedStudentId, setFailedStudentId] = useState<number | null>(null);
  const [reload, setReload] = useState(0);
  /**
   * 每张卡一份重挂载计数（**不是**全局一个 version）：保存 A 卡后只重挂 A 卡，
   * B 卡正在编辑但没保存的草稿不被连带清掉。计划接受的取舍只有「切 Tab / 切孩子
   * 丢草稿」，没有「保存同一 Tab 内另一张卡时丢」。计数在**重拉回来之后**才自增，
   * 保证重挂载读到的就是新快照（提前自增会拿旧数据初始化草稿）。
   */
  const [versions, setVersions] = useState<Record<string, number>>({});
  /**
   * 每张卡一份「本卡那次重拉已结束」计数（**成功、失败都自增**）：只用来让卡解除
   * `saving`，与 `versions` 的重挂载职责刻意分开。
   *
   * 两条踩坑：① 不能只用重挂载复位 `saving`——重拉失败时不能重挂载（会把草稿按旧
   * 快照重置），那条路径上永远转圈；② 也不能用全局一个 tick——那会顺手解开**别的**
   * 仍在提交中的卡的 `saving`，正好废掉「提交期间禁用按钮」的防重复提交。所以按卡存。
   */
  const [settles, setSettles] = useState<Record<string, number>>({});
  /**
   * 本次重拉要结算（重挂 + 解 saving）的卡。**必须是集合，不能是单槽**：A 的重拉还在
   * 路上时又保存了 B，单槽会被 B 覆盖，A 的那次 `.then` 只读到 'B' —— A 从此永远
   * `saving=true` 且不会重挂载，页面内无解。被取消的那次重拉（`reload` 又变了）
   * **不清空它**，留给后一次重拉一起消费。
   */
  const pendingResetsRef = useRef<Set<string>>(new Set());
  /**
   * 已经成功加载过、且属于**哪个**学生的表格。用来区分两种失败：首次加载失败 → 错误态；
   * 保存后的重拉失败 → **保留**旧表格（不能因为一次刷新失败就让家长正在看的整张表消失），
   * 只解 saving + 提示重试。切孩子后旧 id 不匹配，仍走错误态。
   */
  const loadedStudentIdRef = useRef<number | null>(null);

  /**
   * 按 `studentId` 现算归属，而不是在 effect 里清空：effect 在 commit 之后才跑，
   * 清空会慢一帧——那一帧渲染的是**上一个孩子的档位**（切换孩子时最不能出现的东西）。
   */
  const tasks = data && data.studentId === studentId ? data.tasks : null;
  const failed = failedStudentId === studentId;

  useEffect(() => {
    let cancelled = false;
    getParentPointRules(studentId)
      .then((res) => {
        if (cancelled) return;
        setData({ studentId, tasks: res.tasks });
        loadedStudentIdRef.current = studentId;
        const pending = pendingResetsRef.current;
        pendingResetsRef.current = new Set();
        if (pending.size > 0) {
          // versions 决定「重挂哪张卡」；settles 是成功路径的兜底解除
          //（正常由重挂载顺带把 saving 归零）。
          setVersions((prev) => bumpCounters(prev, pending));
          setSettles((prev) => bumpCounters(prev, pending));
        }
        setFailedStudentId(null);
      })
      .catch(() => {
        if (cancelled) return;
        const pending = pendingResetsRef.current;
        pendingResetsRef.current = new Set();
        // 重拉失败拿不到新快照 → 不重挂载（重挂会按旧快照重置草稿），只解 saving，
        // 否则发起保存的那张卡会永久转圈。
        if (pending.size > 0) {
          setSettles((prev) => bumpCounters(prev, pending));
          toast('error', '积分规则刷新失败，请稍后重试');
        }
        if (loadedStudentIdRef.current === studentId) return;
        setData(null);
        setFailedStudentId(studentId);
      });
    return () => {
      cancelled = true;
    };
  }, [studentId, reload]);

  if (failed) {
    return (
      <Card
        data-testid="point-rules-error"
        data-student-id={studentId}
        className="flex flex-wrap items-center justify-between gap-4 border border-[var(--error)] p-4"
      >
        <span className="text-sm text-[var(--text-secondary)]">积分规则暂时加载失败</span>
        <Button variant="secondary" size="sm" onClick={() => setReload((n) => n + 1)}>
          重试
        </Button>
      </Card>
    );
  }

  if (tasks === null) {
    return (
      <div
        data-testid="point-rules-skeleton"
        data-student-id={studentId}
        className="space-y-4"
      >
        <Skeleton width="100%" height={180} rounded />
        <Skeleton width="100%" height={180} rounded />
      </div>
    );
  }

  if (tasks.length === 0) {
    return (
      <Card data-testid="point-rules-empty" data-student-id={studentId} className="p-10 text-center">
        <p className="text-sm text-[var(--text-secondary)]">暂无积分任务配置</p>
      </Card>
    );
  }

  return (
    <div data-student-id={studentId} className="space-y-6">
      {tasks.map((task) => (
        <TaskRulesCard
          key={`${studentId}-${task.taskCode}-${versions[task.taskCode] ?? 0}`}
          studentId={studentId}
          task={task}
          settleToken={settles[task.taskCode] ?? 0}
          onSaved={(taskCode) => {
            pendingResetsRef.current.add(taskCode);
            setReload((n) => n + 1);
          }}
        />
      ))}
    </div>
  );
}
