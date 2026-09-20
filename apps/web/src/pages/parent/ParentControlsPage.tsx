import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import clsx from 'clsx';
import { Button, Card, Input, Skeleton, toast } from '@/components/base';
import {
  ApiError,
  getParentControls,
  getParentPointsSettings,
  putParentControls,
  type ParentControls,
  type PointsSettings,
} from '@/services/api';
import { useParentStudentStore } from '@/store/parentStudentStore';

/**
 * 行为管控 P6.6（spec §5.3 / plan Task 8）。
 *
 * 本页**只有两块**，且由用户 2026-09-20 裁决定死（spec §1.1/§1.2）：
 *   1. 预警灵敏度 —— 两个等待时长（切走 / 无操作），可调；
 *   2. 奖励兑换 —— **只读**状态 + 跳转奖励管理页（开关本身归 `/parent/rewards`）。
 *
 * **明确不做**（别照 PRD/UX 原文加回来）：每日最大使用时长、禁用时段、
 * 辅线访问开关、拍照解题开关 —— 四项均已裁决不做，`controls` 表里那几列保留待用。
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

interface LoadedControls {
  studentId: number;
  /** 输入框原值（字符串），不要 Number() 后回写。 */
  away: string;
  idle: string;
  /** 服务器快照（判脏基准 + 只发改动字段的对照）。 */
  snapshot: ParentControls;
}

export default function ParentControlsPage() {
  const studentId = useParentStudentStore((s) => s.studentId);

  const [controls, setControls] = useState<LoadedControls | null>(null);
  const [controlsFailedStudentId, setControlsFailedStudentId] = useState<number | null>(null);
  const [controlsReload, setControlsReload] = useState(0);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  const [points, setPoints] = useState<{ studentId: number; value: PointsSettings } | null>(null);
  const [pointsFailedStudentId, setPointsFailedStudentId] = useState<number | null>(null);
  const [pointsReload, setPointsReload] = useState(0);

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
  const dirty = awayChanged || idleChanged;
  const canSave = dirty && !awayError && !idleError && !saving;
  const activePreset =
    parsedAway !== null && parsedIdle !== null
      ? PRESETS.find((p) => p.away === parsedAway && p.idle === parsedIdle)
      : undefined;

  const doSave = async () => {
    if (!canSave || loaded === null || parsedAway === null || parsedIdle === null) return;
    // 只发改动过的字段：后端语义是「未提供即不动」
    const body: Partial<ParentControls> = {};
    if (awayChanged) body.alertAwayMinutes = parsedAway;
    if (idleChanged) body.alertIdleMinutes = parsedIdle;
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
              snapshot: next,
            }
          : prev,
      );
      // 回显服务端保存后的值：万一输入没被采纳，这句话会把差异摆在眼前（同 P6.5 的教训）
      toast(
        'success',
        `已保存：离开页面 ${next.alertAwayMinutes} 分钟 / 无操作 ${next.alertIdleMinutes} 分钟`,
      );
    } catch (err: unknown) {
      const message = err instanceof ApiError && err.message ? err.message : '保存失败';
      toast('error', message);
      setSaveError(message);
    } finally {
      setSaving(false);
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
        <Card data-testid="controls-form" data-student-id={studentId} className="p-6">
          <div className="flex flex-wrap items-start justify-between gap-4">
            <div>
              <h2 className="text-base font-bold text-[var(--text-primary)]">预警灵敏度</h2>
              <p className="mt-0.5 text-xs text-[var(--text-secondary)]">
                孩子离开页面或在页面内长时间无操作，超过下面时长会记录一条预警（提示级，不会弹窗打扰）。
              </p>
            </div>
            <Button
              variant={canSave ? 'primary' : 'ghost'}
              size="sm"
              loading={saving}
              disabled={!canSave}
              data-testid="save-controls"
              onClick={() => void doSave()}
            >
              保存
            </Button>
          </div>

          {saveError && (
            <p
              data-testid="controls-save-error"
              className="mt-4 rounded-[var(--radius-button)] border border-[var(--error)] px-3 py-2 text-xs text-[var(--error)]"
            >
              {saveError}
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
