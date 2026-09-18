import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import clsx from 'clsx';
import { Button, Card, Modal, Skeleton, Tag, toast } from '@/components/base';
import {
  ApiError,
  getLevels,
  getParentRewardCatalog,
  saveParentRewardCatalog,
  type PointLevel,
  type RewardCatalogItemInput,
  type RewardCatalogView,
} from '@/services/api';

/**
 * 「奖励清单」Tab（计划三 §2.5，Task 6）。
 *
 * 本组件存在的理由，按「写错了会真坏」排序：
 *
 * 1. **保存是整表 `PUT`，必须把当前列表原样提交（含已下架行）**。
 *    服务端 `RedemptionService.normalizeCatalogItem` 对 `isActive` 的缺省是 **true**，
 *    所以「只发改动的行」或「漏带 isActive」会把家长刚下架的奖励**静默重新上架**
 *    （计划 §1.1#3、计划一 Task 8 审查点名）。整表提交同时承载了「清单里消失的 id
 *    = 软删」的语义——删除按钮只负责把行从本地数组拿掉，**不发单独的删除请求**。
 * 2. **保存成功后用响应体的完整清单替换本地数组**，id 由服务端生成/回填。
 *    自己拼一个 `[...old, {id: guessed}]` 迟早会与服务端的排序、归一化（name trim、
 *    description 归一）漂移。
 * 3. **空数组是合法语义**（= 全部软删），但孩子端奖励册会变空 → 保存前二次确认。
 * 4. **`minLevelCode` 只能来自 `GET /api/points/levels`**（段位表单一真源在后端，
 *    spec §3.1）。前端不维护段位常量，也不从 `PointsOverview` 里凑。
 * 5. **排序用「上移/下移」而不是裸排序号输入框**（计划 §2.5 选定）：`sortOrder` 是
 *    内部字段，家长不该看到；内部按 `数组下标 × 10` 生成，留出插入余量。
 *
 * 草稿与快照：`rows` 是草稿（输入框原值一律用**字符串**存，`Number()` 后回写会把
 * 用户打「-」「1a」的中间态吞掉），`snapshot` 是服务器清单的序列化结果；两者不等
 * 就是「未保存」。这个布尔值通过 `onRegisterLeaveGuard` 注册给页面，页面据此在
 * Tab 上打点、并在切 Tab / 切孩子前先弹确认（见 `ParentPointsPage`）。
 * **保存请求在飞时不算脏**：那次修改马上落库，再问「要不要放弃」纯属误报。
 */

export interface RewardCatalogPanelProps {
  studentId: number;
  /**
   * 把自己的「离场守卫」注册给页面；**卸载时以 `null` 注销**。
   *
   * 为什么需要它：面板是**按 Tab 条件渲染**的（切 Tab 就卸载、草稿随之蒸发），
   * 面板自己拦不住任何一次离场——只有页面在真正切换前问一句，草稿才保得住。
   * 页面还必须先问再切**孩子**（跨学生提交是事故）。
   */
  onRegisterLeaveGuard?: (guard: LeaveGuard | null) => void;
}

/**
 * 页面 ↔ 面板的离场守卫。`dirty` 是快照值（面板每次脏状态变化都重新注册，
 * 页面因此拿到的是最新值，也不需要订阅面板内部状态）。
 */
export interface LeaveGuard {
  /** 有未保存的改动；**保存请求在飞时为 false**（那次修改马上落库，不算要放弃的东西）。 */
  dirty: boolean;
  /**
   * 请求离场：面板弹「有未保存的修改，确定离开吗？」。
   * 点「确认离开」→ `onConfirmed()`；点「取消」/关闭 → `onCancelled?.()`。
   */
  confirmLeave: (onConfirmed: () => void, onCancelled?: () => void) => void;
}

const NAME_MAX = 100;
const DESC_MAX = 300;
const COST_MIN = 1;
const COST_MAX = 999_999;
/** `sortOrder` 的步长：留出插入余量（0、10、20…）；后端 Zod 上界是 9999。 */
const SORT_STEP = 10;
const SORT_MAX = 9999;

const NAME_ERROR = `请填 1–${NAME_MAX} 个字符`;
const DESC_ERROR = `不超过 ${DESC_MAX} 个字符`;
const COST_ERROR = `请填 ${COST_MIN}–${COST_MAX} 的整数`;
/**
 * 家长碰过这一行之前不显示红错（新增即「请填…」两条红字是骂人），改用这句中性提示
 * 解释「保存为什么是灰的」——只把错误藏起来而让保存无声禁用同样说不通。
 */
const UNTOUCHED_HINT = '名称与所需积分填好后才能保存';

/** 服务端 1001 里能对到具体字段时的行内文案（原始 message 仍会显示在表单级提示里）。 */
const SERVER_FIELD_ERROR: Record<'name' | 'description' | 'pointsCost', string> = {
  name: '名称不符合服务端要求，请修改后重试',
  description: '说明不符合服务端要求，请修改后重试',
  pointsCost: '积分不符合服务端要求，请修改后重试',
};

type FieldName = 'name' | 'description' | 'pointsCost';
type FieldErrors = Partial<Record<FieldName, string>>;

interface RowDraft {
  /** React key：已有行用 `id`，未落库的新行用本地 `tempKey`。 */
  tempKey: string;
  id?: number;
  name: string;
  description: string;
  /** 输入框原值（字符串）；空串 = 没填，不是 0。 */
  pointsCost: string;
  /** '' = 无门槛（提交 null） */
  minLevelCode: string;
  isActive: boolean;
}

/** React key / testid 用的稳定标识（`new-1` 这种只在本次挂载内唯一，够用）。 */
function keyOf(row: RowDraft): string {
  return row.id === undefined ? row.tempKey : String(row.id);
}

function toRow(view: RewardCatalogView, tempKey: string): RowDraft {
  return {
    tempKey,
    id: view.id,
    name: view.name,
    description: view.description ?? '',
    pointsCost: String(view.pointsCost),
    minLevelCode: view.minLevelCode ?? '',
    isActive: view.isActive,
  };
}

/**
 * 一行 → 整表 `PUT` 的一条。`sortOrder` **由数组下标派生**（不存草稿），
 * 所以「上移/下移」只要换数组顺序，排序号自然跟着走。
 */
function toInput(row: RowDraft, index: number): RewardCatalogItemInput {
  // name 与 description **同一套规则**：都 trim，全空白等同没填。别只 trim 一边——
  // 「 abc 」原样发出、而「   」变 null 的不对称会让判脏（serialize 也走这里）
  // 与服务端归一后的快照悄悄错开。
  const description = row.description.trim();
  return {
    ...(row.id === undefined ? {} : { id: row.id }),
    name: row.name.trim(),
    // 空串必须是 null：空串会被服务端当成「有说明但长度为 0」的脏值
    description: description === '' ? null : description,
    pointsCost: Number(row.pointsCost),
    minLevelCode: row.minLevelCode === '' ? null : row.minLevelCode,
    isActive: row.isActive,
    sortOrder: Math.min(index * SORT_STEP, SORT_MAX),
  };
}

/** 判脏 / 判快照都用它：同一套派生规则，避免两份真相。 */
function serialize(rows: RowDraft[]): string {
  return JSON.stringify(rows.map((row, index) => toInput(row, index)));
}

function validate(row: RowDraft): FieldErrors {
  const errors: FieldErrors = {};
  const name = row.name.trim();
  if (name.length === 0 || name.length > NAME_MAX) errors.name = NAME_ERROR;
  if (row.description.trim().length > DESC_MAX) errors.description = DESC_ERROR;
  if (!/^\d+$/.test(row.pointsCost)) {
    errors.pointsCost = COST_ERROR;
  } else {
    const cost = Number(row.pointsCost);
    if (cost < COST_MIN || cost > COST_MAX) errors.pointsCost = COST_ERROR;
  }
  return errors;
}

/**
 * 服务端 1001 的 Zod path（`items.<下标>.<字段>`）→ 行内提示。
 *
 * 前端的 `validate` 已经覆盖了三个字段的取值范围，所以这里是**第二道防线**
 * （服务端加了前端没跟上的规则时才会有命中）；解析不到的（如 `id` 失效）走表单级提示。
 */
function serverFieldErrors(message: string, rows: RowDraft[]): Record<string, FieldErrors> {
  const byKey: Record<string, FieldErrors> = {};
  for (const match of message.matchAll(/items\.(\d+)\.(name|description|pointsCost)\b/g)) {
    const row = rows[Number(match[1])];
    if (!row) continue;
    const field = match[2] as FieldName;
    const key = keyOf(row);
    byKey[key] = { ...byKey[key], [field]: SERVER_FIELD_ERROR[field] };
  }
  return byKey;
}

const INPUT_CLASS =
  'h-9 w-full rounded-[var(--radius-button)] border border-[var(--bg-subtle)] bg-[var(--bg-card)] px-3 text-sm text-[var(--text-primary)] outline-none focus:border-[var(--brand-500)] disabled:cursor-not-allowed disabled:opacity-50';

interface Loaded {
  studentId: number;
  rows: RowDraft[];
  /** 服务器清单的序列化结果（判脏基准） */
  snapshot: string;
  levels: PointLevel[];
}

interface RowProps {
  row: RowDraft;
  index: number;
  count: number;
  levels: PointLevel[];
  error?: FieldErrors;
  /** 该行还没被碰过、却已有校验不通过的地方：用中性提示代替红错。 */
  hint?: string;
  saving: boolean;
  onPatch: (patch: Partial<RowDraft>) => void;
  onMove: (offset: -1 | 1) => void;
  onRemove: () => void;
}

function RewardRow({
  row,
  index,
  count,
  levels,
  error,
  hint,
  saving,
  onPatch,
  onMove,
  onRemove,
}: RowProps) {
  const key = keyOf(row);
  const nameId = `reward-name-${key}`;
  const descId = `reward-desc-${key}`;
  const costId = `reward-cost-${key}`;
  const levelId = `reward-level-${key}`;

  return (
    <div
      data-testid={`reward-row-${key}`}
      className="border-t border-[var(--bg-subtle)] py-4 first:border-t-0 first:pt-0"
    >
      <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:gap-3">
        <div className="lg:min-w-0 lg:flex-[3_1_0%]">
          <label htmlFor={nameId} className="mb-1 block text-xs font-medium text-[var(--text-secondary)]">
            名称
          </label>
          <input
            id={nameId}
            type="text"
            maxLength={NAME_MAX}
            value={row.name}
            disabled={saving}
            aria-invalid={error?.name ? true : undefined}
            onChange={(e) => onPatch({ name: e.target.value })}
            className={clsx(INPUT_CLASS, error?.name && 'border-[var(--error)]')}
          />
          {error?.name && <p className="mt-1 text-xs text-[var(--error)]">{error.name}</p>}
        </div>

        <div className="lg:min-w-0 lg:flex-[3_1_0%]">
          <label htmlFor={descId} className="mb-1 block text-xs font-medium text-[var(--text-secondary)]">
            说明
          </label>
          <input
            id={descId}
            type="text"
            maxLength={DESC_MAX}
            placeholder="可不填"
            value={row.description}
            disabled={saving}
            aria-invalid={error?.description ? true : undefined}
            onChange={(e) => onPatch({ description: e.target.value })}
            className={clsx(INPUT_CLASS, error?.description && 'border-[var(--error)]')}
          />
          {error?.description && (
            <p className="mt-1 text-xs text-[var(--error)]">{error.description}</p>
          )}
        </div>

        <div className="lg:w-32 lg:shrink-0">
          <label htmlFor={costId} className="mb-1 block text-xs font-medium text-[var(--text-secondary)]">
            所需积分
          </label>
          <input
            id={costId}
            type="number"
            min={COST_MIN}
            max={COST_MAX}
            step={1}
            inputMode="numeric"
            value={row.pointsCost}
            disabled={saving}
            aria-invalid={error?.pointsCost ? true : undefined}
            onChange={(e) => onPatch({ pointsCost: e.target.value })}
            className={clsx(INPUT_CLASS, 'tabular-nums', error?.pointsCost && 'border-[var(--error)]')}
          />
          {error?.pointsCost && (
            <p className="mt-1 text-xs text-[var(--error)]">{error.pointsCost}</p>
          )}
        </div>

        <div className="lg:w-36 lg:shrink-0">
          <label htmlFor={levelId} className="mb-1 block text-xs font-medium text-[var(--text-secondary)]">
            最低段位
          </label>
          <select
            id={levelId}
            value={row.minLevelCode}
            disabled={saving}
            onChange={(e) => onPatch({ minLevelCode: e.target.value })}
            className={clsx(INPUT_CLASS, 'pr-2')}
          >
            <option value="">无门槛</option>
            {levels.map((level) => (
              <option key={level.code} value={level.code}>
                {level.name}
              </option>
            ))}
          </select>
        </div>

        <div className="lg:w-24 lg:shrink-0">
          <span className="mb-1 block text-xs font-medium text-[var(--text-secondary)]">上架</span>
          <div className="flex items-center gap-2">
            <button
              type="button"
              role="switch"
              aria-checked={row.isActive}
              aria-label={`${row.name || '新奖励'} 上架开关`}
              disabled={saving}
              onClick={() => onPatch({ isActive: !row.isActive })}
              className={clsx(
                'relative inline-flex h-6 w-11 shrink-0 items-center rounded-[var(--radius-pill)] transition-colors',
                'focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-[var(--brand-100)]',
                'disabled:cursor-not-allowed disabled:opacity-50',
                row.isActive ? 'bg-[var(--brand-500)]' : 'bg-[var(--bg-subtle)]',
              )}
            >
              <span
                aria-hidden="true"
                className={clsx(
                  'inline-block h-5 w-5 rounded-full bg-[var(--bg-card)] shadow-[var(--shadow-card)] transition-transform',
                  row.isActive ? 'translate-x-[22px]' : 'translate-x-0.5',
                )}
              />
            </button>
            {!row.isActive && <Tag variant="neutral">已下架</Tag>}
          </div>
        </div>

        <div className="lg:w-32 lg:shrink-0">
          <span className="mb-1 block text-xs font-medium text-[var(--text-secondary)]">排序 / 删除</span>
          <div className="flex items-center gap-1">
            <Button
              variant="ghost"
              size="sm"
              disabled={saving || index === 0}
              onClick={() => onMove(-1)}
            >
              上移
            </Button>
            <Button
              variant="ghost"
              size="sm"
              disabled={saving || index === count - 1}
              onClick={() => onMove(1)}
            >
              下移
            </Button>
            <Button variant="ghost" size="sm" disabled={saving} onClick={onRemove}>
              删除
            </Button>
          </div>
        </div>
      </div>

      {hint && (
        <p
          data-testid={`reward-row-hint-${key}`}
          className="mt-3 text-xs text-[var(--text-tertiary)]"
        >
          {hint}
        </p>
      )}
    </div>
  );
}

export default function RewardCatalogPanel({
  studentId,
  onRegisterLeaveGuard,
}: RewardCatalogPanelProps) {
  const [data, setData] = useState<Loaded | null>(null);
  const [failedStudentId, setFailedStudentId] = useState<number | null>(null);
  const [reload, setReload] = useState(0);
  const [saving, setSaving] = useState(false);
  const [serverErrors, setServerErrors] = useState<Record<string, FieldErrors>>({});
  const [saveError, setSaveError] = useState<string | null>(null);
  const [confirmEmpty, setConfirmEmpty] = useState(false);
  const [leavePrompt, setLeavePrompt] = useState<{
    onConfirmed: () => void;
    onCancelled?: () => void;
  } | null>(null);
  /** 新行的本地 key 序号：每次挂载从 1 开始（切孩子/切 Tab 重挂 → 又是一个干净面板）。 */
  const tempSeqRef = useRef(0);
  /**
   * 家长碰过哪些行。**新增的空行在被动过之前不报红错**——一点「新增奖励」就被
   * 「请填 1–100 个字符」+「请填 1–999999 的整数」两条红字骂一顿不是帮忙；
   * 那一行的中性提示（见 `UNTOUCHED_HINT`）负责解释保存为什么是灰的。
   * 字段编辑即算碰过；上移/下移/删除不改字段，不标记。
   */
  const [touchedKeys, setTouchedKeys] = useState<ReadonlySet<string>>(() => new Set());

  /**
   * 按 `studentId` 现算归属，而不是在 effect 里清空：effect 在 commit 之后才跑，
   * 清空会慢一帧——那一帧渲染的是**上一个孩子的清单**。
   */
  const loaded = data && data.studentId === studentId ? data : null;
  const rows = loaded?.rows ?? null;
  const failed = failedStudentId === studentId;

  useEffect(() => {
    let cancelled = false;
    // 段位表与清单一起拉：下拉没有段位就没法配门槛，失败一起给可重试的错误态。
    Promise.all([getParentRewardCatalog(studentId), getLevels()])
      .then(([views, levels]) => {
        if (cancelled) return;
        const nextRows = views.map((view, index) => toRow(view, `srv-${index}`));
        setData({
          studentId,
          rows: nextRows,
          snapshot: serialize(nextRows),
          levels: levels.levels,
        });
        setServerErrors({});
        setSaveError(null);
        setFailedStudentId(null);
      })
      .catch(() => {
        if (cancelled) return;
        setData(null);
        setFailedStudentId(studentId);
      });
    return () => {
      cancelled = true;
    };
  }, [studentId, reload]);

  const clientErrors = useMemo<Record<string, FieldErrors>>(() => {
    const next: Record<string, FieldErrors> = {};
    for (const row of rows ?? []) {
      const errors = validate(row);
      if (Object.keys(errors).length > 0) next[keyOf(row)] = errors;
    }
    return next;
  }, [rows]);

  const hasErrors = Object.keys(clientErrors).length > 0;
  const isDirty = rows !== null && loaded !== null && serialize(rows) !== loaded.snapshot;
  /**
   * 对外的「未保存」**排除保存进行中**：请求在飞时这次修改马上就要落库，此刻 Tab 上的
   * 「未保存」小圆点、切孩子时的「有未保存的修改，确定离开吗」都是误报——家长刚点过
   * 保存，被问「要不要放弃」只会以为保存失败了。
   *
   * 这个降级不会吞掉编辑：保存期间所有输入框/开关/上下移/删除/新增都是 `disabled`，
   * 飞在空中的那一次提交就是当前全部草稿（响应回来会整表替换本地数组）。
   */
  const dirty = isDirty && !saving;
  const canSave = isDirty && !hasErrors && !saving;

  const patchRows = (updater: (prev: RowDraft[]) => RowDraft[]) => {
    // 任何一次编辑都清掉上一次保存失败留下的提示（否则改完还挂着旧错，看着像没生效）
    setServerErrors({});
    setSaveError(null);
    setData((prev) =>
      prev && prev.studentId === studentId ? { ...prev, rows: updater(prev.rows) } : prev,
    );
  };

  const patchRow = (key: string, patch: Partial<RowDraft>) => {
    // 编辑即「碰过」：从这一刻起该行的校验红错才显示
    setTouchedKeys((prev) => (prev.has(key) ? prev : new Set(prev).add(key)));
    patchRows((prev) =>
      prev.map((row) => (keyOf(row) === key ? { ...row, ...patch } : row)),
    );
  };

  const moveRow = (index: number, offset: -1 | 1) => {
    patchRows((prev) => {
      const target = index + offset;
      if (target < 0 || target >= prev.length) return prev;
      const next = [...prev];
      [next[index], next[target]] = [next[target], next[index]];
      return next;
    });
  };

  const removeRow = (key: string) => {
    patchRows((prev) => prev.filter((row) => keyOf(row) !== key));
  };

  const addRow = () => {
    tempSeqRef.current += 1;
    const fresh: RowDraft = {
      tempKey: `new-${tempSeqRef.current}`,
      name: '',
      description: '',
      pointsCost: '',
      minLevelCode: '',
      isActive: true,
    };
    patchRows((prev) => [...prev, fresh]);
  };

  const doSave = async () => {
    if (rows === null) return;
    const payload = rows.map((row, index) => toInput(row, index));
    setSaving(true);
    setServerErrors({});
    setSaveError(null);
    try {
      const saved = await saveParentRewardCatalog(studentId, payload);
      const nextRows = saved.map((view, index) => toRow(view, `srv-${index}`));
      // 用响应体替换本地数组（id 由服务端生成），不自己拼
      setData((prev) =>
        prev && prev.studentId === studentId
          ? { ...prev, rows: nextRows, snapshot: serialize(nextRows) }
          : prev,
      );
      setConfirmEmpty(false);
      toast('success', '奖励清单已保存');
    } catch (err: unknown) {
      setConfirmEmpty(false);
      const message = err instanceof Error && err.message ? err.message : '保存失败';
      if (err instanceof ApiError && err.code === 1001) {
        // 入参错误：能对到字段的行内标红，原始文案留给表单级提示（不吞服务端的话）
        setServerErrors(serverFieldErrors(message, rows));
        setSaveError(message);
      } else {
        toast('error', message);
      }
    } finally {
      setSaving(false);
    }
  };

  const handleSave = () => {
    if (!canSave || rows === null) return;
    // 空清单 = 孩子的奖励册会变空，必须在真正提交前确认一次
    if (rows.length === 0) {
      setConfirmEmpty(true);
      return;
    }
    void doSave();
  };

  /**
   * 离场守卫：`dirty` 变化就重新注册（页面拿到的永远是最新快照），卸载时注销。
   * `confirmLeave` 只 set 一个 state，用 `useCallback` 固定住 → 这个 effect 只在
   * dirty 变化时跑，不会「注册 → 页面 setState → 再注册」打转。
   */
  const confirmLeave = useCallback((onConfirmed: () => void, onCancelled?: () => void) => {
    setLeavePrompt({ onConfirmed, onCancelled });
  }, []);

  useEffect(() => {
    if (!onRegisterLeaveGuard) return;
    onRegisterLeaveGuard({ dirty, confirmLeave });
    return () => onRegisterLeaveGuard(null);
  }, [dirty, confirmLeave, onRegisterLeaveGuard]);

  if (failed) {
    return (
      <Card
        data-testid="reward-catalog-error"
        data-student-id={studentId}
        className="flex flex-wrap items-center justify-between gap-4 border border-[var(--error)] p-4"
      >
        <span className="text-sm text-[var(--text-secondary)]">奖励清单暂时加载失败</span>
        <Button variant="secondary" size="sm" onClick={() => setReload((n) => n + 1)}>
          重试
        </Button>
      </Card>
    );
  }

  if (loaded === null || rows === null) {
    return (
      <div
        data-testid="reward-catalog-skeleton"
        data-student-id={studentId}
        className="space-y-4"
      >
        <Skeleton width="100%" height={200} rounded />
      </div>
    );
  }

  const mergedErrors = (key: string): FieldErrors | undefined => {
    // 没碰过的行不显示**客户端**校验（新增即满屏红字）；服务端错误照常显示——
    // 它只可能来自一次真实提交，那次提交必然已经把整表「碰」过一遍了。
    const client = touchedKeys.has(key) ? clientErrors[key] : undefined;
    const server = serverErrors[key];
    if (!client && !server) return undefined;
    // 客户端校验更即时，优先显示；服务端的补充在客户端没意见的字段上
    return { ...server, ...client };
  };

  /** 没碰过却有校验不通过的行：用一句中性提示代替红错（别只把保存按钮默默置灰）。 */
  const rowHint = (key: string): string | undefined =>
    !touchedKeys.has(key) && clientErrors[key] ? UNTOUCHED_HINT : undefined;

  return (
    <div data-student-id={studentId} className="space-y-4">
      <Card className="border border-[var(--bg-subtle)] p-6">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <h2 className="text-base font-bold text-[var(--text-primary)]">奖励清单</h2>
            <p className="mt-0.5 text-xs text-[var(--text-secondary)]">
              孩子用积分兑换的奖励。下架的奖励不会出现在孩子端，但会留在本页便于重新上架。
            </p>
          </div>
          <div className="flex items-center gap-3">
            <Button
              variant="secondary"
              size="sm"
              disabled={saving}
              data-testid="add-reward"
              onClick={addRow}
            >
              新增奖励
            </Button>
            <Button
              variant={canSave ? 'primary' : 'ghost'}
              size="sm"
              loading={saving}
              disabled={!canSave}
              data-testid="save-catalog"
              onClick={handleSave}
            >
              保存
            </Button>
          </div>
        </div>

        {saveError && (
          <p
            data-testid="reward-catalog-save-error"
            className="mt-4 rounded-[var(--radius-button)] border border-[var(--error)] px-3 py-2 text-xs text-[var(--error)]"
          >
            {saveError}
          </p>
        )}

        {rows.length === 0 ? (
          <p className="mt-4 text-sm text-[var(--text-secondary)]">还没有奖励</p>
        ) : (
          <div className="mt-4">
            {rows.map((row, index) => (
              <RewardRow
                key={keyOf(row)}
                row={row}
                index={index}
                count={rows.length}
                levels={loaded.levels}
                error={mergedErrors(keyOf(row))}
                hint={rowHint(keyOf(row))}
                saving={saving}
                onPatch={(patch) => patchRow(keyOf(row), patch)}
                onMove={(offset) => moveRow(index, offset)}
                onRemove={() => removeRow(keyOf(row))}
              />
            ))}
          </div>
        )}
      </Card>

      <Modal
        open={confirmEmpty}
        onClose={() => {
          if (!saving) setConfirmEmpty(false);
        }}
        title="清空全部奖励"
      >
        <div className="space-y-4">
          <p className="text-sm leading-relaxed text-[var(--text-secondary)]">
            将清空全部奖励，孩子端奖励册会变空。
          </p>
          <div className="flex justify-end gap-3">
            <Button variant="ghost" size="sm" disabled={saving} onClick={() => setConfirmEmpty(false)}>
              取消
            </Button>
            <Button
              variant="primary"
              size="sm"
              loading={saving}
              onClick={() => void doSave()}
            >
              确认清空
            </Button>
          </div>
        </div>
      </Modal>

      <Modal
        open={leavePrompt !== null}
        onClose={() => {
          const pending = leavePrompt;
          setLeavePrompt(null);
          pending?.onCancelled?.();
        }}
        title="有未保存的修改"
      >
        <div className="space-y-4">
          <p className="text-sm leading-relaxed text-[var(--text-secondary)]">
            有未保存的修改，确定离开吗？离开后本次修改会丢失。
          </p>
          <div className="flex justify-end gap-3">
            <Button
              variant="ghost"
              size="sm"
              onClick={() => {
                const pending = leavePrompt;
                setLeavePrompt(null);
                pending?.onCancelled?.();
              }}
            >
              取消
            </Button>
            <Button
              variant="primary"
              size="sm"
              onClick={() => {
                const pending = leavePrompt;
                setLeavePrompt(null);
                pending?.onConfirmed();
              }}
            >
              确认离开
            </Button>
          </div>
        </div>
      </Modal>
    </div>
  );
}
