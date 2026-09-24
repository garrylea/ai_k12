import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import clsx from 'clsx';
import { Button, Card, Input, Skeleton, toast } from '@/components/base';
import {
  ApiError,
  getParentControls,
  getParentLearningSessions,
  getParentPointsSettings,
  issueParentDeviceCommand,
  putParentControls,
  type ParentControls,
  type PointsSettings,
} from '@/services/api';
import { useParentStudentStore } from '@/store/parentStudentStore';

/**
 * 行为管控（spec §5.3 / plan Task 8；2026-09-23 新增第三块「单次学习锁定」）。
 *
 * 本页**共三块**：
 *   1. 预警灵敏度 —— 两个等待时长（切走 / 无操作），可调；
 *   2. 单次学习锁定 —— 时长（1..480）可调 + 「解除锁定」按钮（2026-09-23 新增）；
 *   3. 奖励兑换 —— **只读**状态 + 跳转奖励管理页（开关本身归 `/parent/rewards`）。
 *
 * **明确不做**（别照 PRD/UX 原文加回来）：每日最大使用时长（概念已于 2026-09-23 废除，
 * 见下）、禁用时段、辅线访问开关、拍照解题开关 —— 后三项仍裁决不做，`controls` 表里
 * 那几列保留待用。
 *
 * 2026-09-23 新增第三块「单次学习锁定」：`controls.session_lock_minutes`（1..480）。
 * 它是**单次登录起算的墙钟窗口**，**不是**被废除的「每日累计上限」——旧列
 * `daily_time_limit_minutes` 已在同一次迁移中改名并改语义，别再按每日累计去实现。
 *
 * 三条实现纪律：
 *   1. **派生状态带 `studentId` 归属**：切孩子不重挂载本页，只在 effect 里 `setData(null)`
 *      会慢一帧、把上一个孩子的阈值画出来（effect 在 commit 之后才跑）。
 *   2. **保存只发改动过的字段**：后端语义是「未提供即不动」，多带没变的字段等于把一份
 *      可能过期的草稿写回库（`PointsSettingsPanel` 同款纪律）。
 *   3. **无改动 → 保存禁用**：P6.5 踩过「点了没反应」的坑，宁可按钮灰着。
 */

const MINUTES_MIN = 1;
const MINUTES_MAX = 180;
const MINUTES_ERROR = `请填 ${MINUTES_MIN}–${MINUTES_MAX} 的整数`;

/** 「单次学习锁定」范围（spec §5.6）。null = 未设锁。 */
const LOCK_MINUTES_MIN = 1;
const LOCK_MINUTES_MAX = 480;
/** 与服务端列默认值一致（`controls.session_lock_minutes DEFAULT 30`，2026-09-24 用户裁决）。改一处要同步另一处。 */
const DEFAULT_LOCK_MINUTES = 30;
const LOCK_MINUTES_ERROR = `请填 ${LOCK_MINUTES_MIN}–${LOCK_MINUTES_MAX} 的整数`;

/**
 * 预设档 —— **纯前端常量**（spec §3.6）：点一下只把两个输入框填好，**不改服务端**，
 * 仍要点「保存」才生效。服务端没有「当前是哪个档」的概念，故高亮由「两个值是否恰好
 * 等于某档」现算，手动改一个数字高亮自然消失。
 */
const PRESETS = [
  { key: 'loose', label: '宽松', away: 15, idle: 30 },
  { key: 'standard', label: '标准', away: 5, idle: 15 },
  { key: 'strict', label: '严格', away: 2, idle: 5 },
] as const;

/** 解析输入框原值：`null` = 非法（空串 / 非数字 / 越界）。 */
function parseMinutes(raw: string): number | null {
  if (!/^\d+$/.test(raw)) return null;
  const value = Number(raw);
  return value >= MINUTES_MIN && value <= MINUTES_MAX ? value : null;
}

/**
 * 解析锁定输入框原值。
 * 返回 `number | null | undefined`：`undefined` = 非法；`null` = 空（= 不设锁）；数字 = 合法值。
 * 空串是**合法**的（解除设置），这与上面 `parseMinutes` 把空串当非法**不同**，别复用那个。
 */
function parseLockMinutes(raw: string): number | null | undefined {
  if (raw.trim() === '') return null;
  if (!/^\d+$/.test(raw)) return undefined;
  const value = Number(raw);
  return value >= LOCK_MINUTES_MIN && value <= LOCK_MINUTES_MAX ? value : undefined;
}

interface LoadedControls {
  studentId: number;
  /** 输入框原值（字符串），不要 Number() 后回写。 */
  away: string;
  idle: string;
  /** 单次学习锁定输入框原值；空串 = 未设锁。 */
  lock: string;
  /** 服务器快照（判脏基准 + 只发改动字段的对照）。 */
  snapshot: ParentControls;
}

export default function ParentControlsPage() {
  const studentId = useParentStudentStore((s) => s.studentId);

  const [controls, setControls] = useState<LoadedControls | null>(null);
  const [controlsFailedStudentId, setControlsFailedStudentId] = useState<number | null>(null);
  const [controlsReload, setControlsReload] = useState(0);
  const [saving, setSaving] = useState(false);
  /** 保存失败提示要**标明是哪张卡**的（两张卡各有自己的保存，混着显示会让家长找错地方）。 */
  const [saveError, setSaveError] = useState<{ block: 'alerts' | 'lock'; message: string } | null>(
    null,
  );

  const [points, setPoints] = useState<{ studentId: number; value: PointsSettings } | null>(null);
  const [pointsFailedStudentId, setPointsFailedStudentId] = useState<number | null>(null);
  const [pointsReload, setPointsReload] = useState(0);

  /**
   * 「当前有没有进行中的学习会话」的探针。
   *
   * **三态，不能压成两个布尔**：`null` = 未知（还没查/查失败）、`{openId: null}` = 查到了、
   * 但没有进行中的会话。这两种都表现为「没有 openId」，但**裁决相反**——
   * 查失败时按钮要保持可点（交给服务端判 409/1001，不把家长卡死），查到没有才该禁用。
   */
  const [sessions, setSessions] = useState<{ studentId: number; openId: number | null } | null>(
    null,
  );
  const [unlocking, setUnlocking] = useState(false);
  const [sessionsReload, setSessionsReload] = useState(0);

  /**
   * 按 `studentId` 现算归属，而不是在 effect 里清空：effect 在 commit 之后才跑，
   * 清空会慢一帧 —— 那一帧显示的是**上一个孩子**的阈值。
   */
  const loaded = controls && controls.studentId === studentId ? controls : null;
  const controlsFailed = controlsFailedStudentId === studentId;
  const pointsValue = points && points.studentId === studentId ? points.value : null;
  const pointsFailed = pointsFailedStudentId === studentId;

  useEffect(() => {
    if (studentId === null) return;
    let cancelled = false;
    getParentControls(studentId)
      .then((res) => {
        if (cancelled) return;
        setControls({
          studentId,
          away: String(res.alertAwayMinutes),
          idle: String(res.alertIdleMinutes),
          lock: res.sessionLockMinutes === null ? '' : String(res.sessionLockMinutes),
          snapshot: res,
        });
        setSaveError(null);
        setControlsFailedStudentId(null);
      })
      .catch(() => {
        if (cancelled) return;
        setControls(null);
        setControlsFailedStudentId(studentId);
      });
    return () => {
      cancelled = true;
    };
  }, [studentId, controlsReload]);

  // 兑换状态只是**只读展示**，与灵敏度表单互不依赖 —— 它失败不影响上面那块（spec §5.3）。
  useEffect(() => {
    if (studentId === null) return;
    let cancelled = false;
    getParentPointsSettings(studentId)
      .then((res) => {
        if (cancelled) return;
        setPoints({ studentId, value: res });
        setPointsFailedStudentId(null);
      })
      .catch(() => {
        if (cancelled) return;
        setPoints(null);
        setPointsFailedStudentId(studentId);
      });
    return () => {
      cancelled = true;
    };
  }, [studentId, pointsReload]);

  /**
   * 查「当前有没有进行中的学习会话」，只用来决定「解除锁定」按钮的初态与提示。
   *
   * 查失败 → `sessions` 保持 `null`（未知），按钮**照样可点**：真正的闸门在服务端
   * （没有进行中会话时它返回 409/1001），本地判断只做提示，不该把家长卡在灰按钮上。
   */
  useEffect(() => {
    if (studentId === null) return;
    let cancelled = false;
    getParentLearningSessions(studentId, 1, 1)
      .then((res) => {
        if (cancelled) return;
        const open = res.items.find((item) => item.endedAt === null) ?? null;
        setSessions({ studentId, openId: open ? open.id : null });
      })
      .catch(() => {
        if (cancelled) return;
        setSessions(null);
      });
    return () => {
      cancelled = true;
    };
  }, [studentId, sessionsReload]);

  if (studentId === null) {
    return (
      <Card data-testid="controls-no-student" className="p-10 text-center">
        <p className="text-sm text-[var(--text-secondary)]">请先选择孩子</p>
        <Link
          to="/parent/students"
          className="mt-3 inline-block text-sm font-medium text-[var(--brand-600)] hover:underline"
        >
          去创建学生账号
        </Link>
      </Card>
    );
  }

  const patch = (updater: (prev: LoadedControls) => LoadedControls) => {
    // 任何一次编辑都清掉上一次保存失败留下的提示
    setSaveError(null);
    setControls((prev) => (prev && prev.studentId === studentId ? updater(prev) : prev));
  };

  const parsedAway = loaded ? parseMinutes(loaded.away) : null;
  const parsedIdle = loaded ? parseMinutes(loaded.idle) : null;
  const awayError = parsedAway === null;
  const idleError = parsedIdle === null;
  const awayChanged = parsedAway !== null && parsedAway !== loaded?.snapshot.alertAwayMinutes;
  const idleChanged = parsedIdle !== null && parsedIdle !== loaded?.snapshot.alertIdleMinutes;

  // 锁定值：`undefined` = 非法（行内报错）；`null` = 空 = 不设锁（合法）
  const parsedLock = loaded ? parseLockMinutes(loaded.lock) : undefined;
  const lockError = parsedLock === undefined;
  const lockChanged =
    parsedLock !== undefined && parsedLock !== (loaded?.snapshot.sessionLockMinutes ?? null);

  const activePreset =
    parsedAway !== null && parsedIdle !== null
      ? PRESETS.find((p) => p.away === parsedAway && p.idle === parsedIdle)
      : undefined;

  /**
   * **每张卡各有自己的保存按钮**（2026-09-24 用户裁决，推翻初版「共用一个」）：
   * 用户原话「按说每个 card 有自己的保存，不能说点上面 card 中的保存 button 也管着下面的 card」。
   * 两张卡的脏判定 / 可保存条件 / 提交字段都各自独立，互不干涉。
   */
  const alertsDirty = awayChanged || idleChanged;
  const canSaveAlerts = alertsDirty && !awayError && !idleError && !saving;
  const canSaveLock = lockChanged && !lockError && !saving;

  /** 查到了、而且确实没有进行中的会话 → 才禁用「解除」（查失败是未知，保持可点）。 */
  const sessionsKnown = sessions?.studentId === studentId;
  const knownNoSession = sessionsKnown && sessions!.openId === null;
  const canUnlock = !unlocking && !knownNoSession;
  const unlockHint = knownNoSession ? '当前没有进行中的学习，无需解除' : null;

  /**
   * 保存 —— **按卡分派**：`alerts` 只发两个预警阈值，`lock` 只发 `sessionLockMinutes`。
   * 各自的可用条件已在上面算好（`canSaveAlerts` / `canSaveLock`），互不干涉。
   */
  const doSave = async (block: 'alerts' | 'lock') => {
    if (loaded === null) return;
    // 只发改动过的字段：后端语义是「未提供即不动」
    const body: Partial<ParentControls> = {};
    if (block === 'alerts') {
      if (!canSaveAlerts || parsedAway === null || parsedIdle === null) return;
      if (awayChanged) body.alertAwayMinutes = parsedAway;
      if (idleChanged) body.alertIdleMinutes = parsedIdle;
    } else {
      if (!canSaveLock || parsedLock === undefined) return;
      // `null` 是「解除设置」这个**值**，必须显式发出去；漏发等于「不动」，家长会以为保存成功了
      body.sessionLockMinutes = parsedLock;
    }
    setSaving(true);
    setSaveError(null);
    try {
      const next = await putParentControls(studentId, body);
      // 用响应体刷新本地（服务端回读库里的真值），不自己拼
      setControls((prev) =>
        prev && prev.studentId === studentId
          ? {
              studentId,
              away: String(next.alertAwayMinutes),
              idle: String(next.alertIdleMinutes),
              lock: next.sessionLockMinutes === null ? '' : String(next.sessionLockMinutes),
              snapshot: next,
            }
          : prev,
      );
      // 回显服务端保存后的值：万一输入没被采纳，这句话会把差异摆在眼前（同 P6.5 的教训）
      toast(
        'success',
        block === 'lock'
          ? `已保存：单次学习锁定 ${next.sessionLockMinutes === null ? '未设' : `${next.sessionLockMinutes} 分钟`}`
          : `已保存：离开页面 ${next.alertAwayMinutes} 分钟 / 无操作 ${next.alertIdleMinutes} 分钟`,
      );
    } catch (err: unknown) {
      const message = err instanceof ApiError && err.message ? err.message : '保存失败';
      toast('error', message);
      setSaveError({ block, message });
    } finally {
      setSaving(false);
    }
  };

  /**
   * 解除锁定（spec §5.4）。服务端在没有进行中会话时返回 409/1001，
   * 所以 `canUnlock` 只是**前置提示**，真正的闸门在服务端；这里不因为本地判断而放弃请求。
   */
  const doUnlock = async () => {
    if (studentId === null || unlocking) return;
    setUnlocking(true);
    try {
      await issueParentDeviceCommand(studentId, 'unlock');
      toast('success', '已解除锁定，孩子现在可以退出学习');
      setSessionsReload((n) => n + 1);
    } catch (err: unknown) {
      toast('error', err instanceof ApiError && err.message ? err.message : '解除失败');
    } finally {
      setUnlocking(false);
    }
  };

  return (
    <div>
      <header className="mb-5">
        <h1 className="text-2xl font-black text-[var(--text-primary)]">行为管控</h1>
        <p className="mt-1 text-sm text-[var(--text-secondary)]">
          设置孩子离开学习页面多久后记录一条预警
        </p>
      </header>

      {controlsFailed ? (
        <Card
          data-testid="controls-error"
          className="flex flex-wrap items-center justify-between gap-4 border border-[var(--error)] p-4"
        >
          <span className="text-sm text-[var(--text-secondary)]">预警灵敏度暂时加载失败</span>
          <Button variant="secondary" size="sm" onClick={() => setControlsReload((n) => n + 1)}>
            重试
          </Button>
        </Card>
      ) : loaded === null ? (
        <div data-testid="controls-skeleton" className="space-y-3">
          <Skeleton width="100%" height={220} rounded />
        </div>
      ) : (
        <>
          <Card data-testid="controls-form" data-student-id={studentId} className="p-6">
          <div className="flex flex-wrap items-start justify-between gap-4">
            <div>
              <h2 className="text-base font-bold text-[var(--text-primary)]">预警灵敏度</h2>
              <p className="mt-0.5 text-xs text-[var(--text-secondary)]">
                孩子离开页面或在页面内长时间无操作，超过下面时长会记录一条预警（提示级，不会弹窗打扰）。
              </p>
            </div>
            <Button
              variant={canSaveAlerts ? 'primary' : 'ghost'}
              size="sm"
              loading={saving}
              disabled={!canSaveAlerts}
              data-testid="save-alerts"
              onClick={() => void doSave('alerts')}
            >
              保存
            </Button>
          </div>

          {saveError?.block === 'alerts' && (
            <p
              data-testid="controls-save-error"
              className="mt-4 rounded-[var(--radius-button)] border border-[var(--error)] px-3 py-2 text-xs text-[var(--error)]"
            >
              {saveError.message}
            </p>
          )}

          <div className="mt-5 flex flex-wrap items-center gap-3">
            <span className="text-xs font-medium text-[var(--text-secondary)]">快速设置</span>
            {PRESETS.map((preset) => (
              <button
                key={preset.key}
                type="button"
                data-testid={`preset-${preset.key}`}
                aria-pressed={activePreset?.key === preset.key}
                onClick={() =>
                  patch((prev) => ({
                    ...prev,
                    away: String(preset.away),
                    idle: String(preset.idle),
                  }))
                }
                className={clsx(
                  'rounded-full border px-4 py-1.5 text-sm font-medium transition-colors',
                  activePreset?.key === preset.key
                    ? 'border-[var(--brand-500)] bg-[var(--brand-100)] text-[var(--brand-600)]'
                    : 'border-[var(--bg-subtle)] text-[var(--text-secondary)] hover:bg-[var(--bg-subtle)]',
                )}
              >
                {`${preset.label}（${preset.away}/${preset.idle} 分钟）`}
              </button>
            ))}
          </div>

          <div className="mt-5 grid grid-cols-1 gap-5 lg:grid-cols-2">
            <Input
              label="离开页面等待时长（分钟）"
              data-testid="controls-away-input"
              type="number"
              min={MINUTES_MIN}
              max={MINUTES_MAX}
              step={1}
              inputMode="numeric"
              value={loaded.away}
              disabled={saving}
              error={awayError ? MINUTES_ERROR : undefined}
              onChange={(e) => patch((prev) => ({ ...prev, away: e.target.value }))}
            />
            <Input
              label="无操作等待时长（分钟）"
              data-testid="controls-idle-input"
              type="number"
              min={MINUTES_MIN}
              max={MINUTES_MAX}
              step={1}
              inputMode="numeric"
              value={loaded.idle}
              disabled={saving}
              error={idleError ? MINUTES_ERROR : undefined}
              onChange={(e) => patch((prev) => ({ ...prev, idle: e.target.value }))}
            />
          </div>
        </Card>

          <Card data-testid="controls-lock" className="mt-4 p-6">
            <div className="flex flex-wrap items-start justify-between gap-4">
              <div>
                <h2 className="text-base font-bold text-[var(--text-primary)]">单次学习锁定</h2>
                <p className="mt-0.5 text-xs text-[var(--text-secondary)]">
                  孩子登录学习端后，下面这段时间内不能退出登录，到点自动解除；也可以随时手动解除。
                  默认 {DEFAULT_LOCK_MINUTES} 分钟；清空输入框并保存表示解除锁定（不设锁）。
                </p>
              </div>
              <div className="flex items-center gap-4">
                <span data-testid="lock-status" className="text-sm text-[var(--text-secondary)]">
                  {loaded.snapshot.sessionLockMinutes === null
                    ? '当前：未设锁'
                    : `当前：${loaded.snapshot.sessionLockMinutes} 分钟`}
                </span>
                {/* 本卡**自己的**保存（只提交 sessionLockMinutes），与上面那张卡互不干涉 */}
                <Button
                  variant={canSaveLock ? 'primary' : 'ghost'}
                  size="sm"
                  loading={saving}
                  disabled={!canSaveLock}
                  data-testid="save-lock"
                  onClick={() => void doSave('lock')}
                >
                  保存
                </Button>
              </div>
            </div>

            {saveError?.block === 'lock' && (
              <p
                data-testid="lock-save-error"
                className="mt-4 rounded-[var(--radius-button)] border border-[var(--error)] px-3 py-2 text-xs text-[var(--error)]"
              >
                {saveError.message}
              </p>
            )}

            <div className="mt-5 flex flex-wrap items-end gap-4">
              <Input
                label={`锁定时长（分钟，${LOCK_MINUTES_MIN}–${LOCK_MINUTES_MAX}）`}
                data-testid="lock-minutes-input"
                type="number"
                min={LOCK_MINUTES_MIN}
                max={LOCK_MINUTES_MAX}
                step={1}
                inputMode="numeric"
                value={loaded.lock}
                disabled={saving}
                error={lockError ? LOCK_MINUTES_ERROR : undefined}
                onChange={(e) => patch((prev) => ({ ...prev, lock: e.target.value }))}
              />
              <Button
                variant="secondary"
                size="sm"
                loading={unlocking}
                disabled={!canUnlock}
                data-testid="unlock-button"
                onClick={() => void doUnlock()}
              >
                解除锁定
              </Button>
            </div>

            {unlockHint && (
              <p data-testid="unlock-hint" className="mt-2 text-xs text-[var(--text-secondary)]">
                {unlockHint}
              </p>
            )}
          </Card>
        </>
      )}

      <Card data-testid="controls-rewards" className="mt-4 p-6">
        <h2 className="text-base font-bold text-[var(--text-primary)]">奖励兑换</h2>
        <p className="mt-0.5 text-xs text-[var(--text-secondary)]">
          孩子用积分兑换奖励的开关，在奖励管理页设置。
        </p>

        {pointsFailed ? (
          <div className="mt-4 flex flex-wrap items-center justify-between gap-4">
            <span data-testid="controls-rewards-error" className="text-sm text-[var(--text-secondary)]">
              状态获取失败
            </span>
            <Button variant="secondary" size="sm" onClick={() => setPointsReload((n) => n + 1)}>
              重试
            </Button>
          </div>
        ) : pointsValue === null ? (
          <div data-testid="controls-rewards-skeleton" className="mt-4">
            <Skeleton width="100%" height={32} rounded />
          </div>
        ) : (
          <div className="mt-4 flex flex-wrap items-center justify-between gap-4">
            <span data-testid="controls-rewards-status" className="text-sm text-[var(--text-primary)]">
              {pointsValue.rewardRedemptionEnabled
                ? '已开启：孩子可以把积分兑换成奖励'
                : '已关闭：孩子暂时不能兑换积分'}
            </span>
            <Link
              to="/parent/rewards"
              className="text-sm font-medium text-[var(--brand-600)] hover:underline"
            >
              去奖励管理
            </Link>
          </div>
        )}
      </Card>
    </div>
  );
}
