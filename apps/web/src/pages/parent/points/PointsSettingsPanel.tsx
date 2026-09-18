import { useEffect, useState } from 'react';
import clsx from 'clsx';
import { Button, Card, Skeleton, toast } from '@/components/base';
import {
  getParentPointsSettings,
  saveParentPointsSettings,
  type PointsSettings,
} from '@/services/api';
import { previewCashAmount } from './previewCash';

/**
 * 「兑换」Tab 的上半块 —— 兑换设置（计划三 §2.6(a)，Task 7）。
 *
 * 三条硬约束：
 * 1. **只在有改动时可保存**，且 `PUT` **至少给一个字段**（空 patch 后端 400 1001）。
 *    更进一步：**只发改动过的字段**。后端语义是「未提供即不动」，把没变的字段也带上
 *    等于把一份可能已经过期的草稿写回库（只切开关时多带 `pointsPerYuan` 就是这类错误）。
 * 2. 比例 `pointsPerYuan` 只允许 1–9999 整数；`0` 会让兑换算出无穷大金额。
 * 3. 预览与后端**同口径**：复用 `previewCashAmount`（整数运算再除，见它的注释），
 *    不在这里另写一份 `points / perYuan`。
 *
 * 草稿（输入框原值用字符串存）留在本组件内，页面切孩子时靠重挂载丢弃。
 * 保存成功后用**响应体**刷新本地（服务端可能归一），并通过 `onSettingsChanged` 通知
 * 页面 —— 同一个 Tab 下半块的兑换表单靠这条通道感知「兑换已关闭」。
 */
export interface PointsSettingsPanelProps {
  studentId: number;
  /** 保存成功（服务端已接受）后回调；页面据此让兑换表单重读设置。 */
  onSettingsChanged?: (next: PointsSettings) => void;
}

const RATE_MIN = 1;
const RATE_MAX = 9999;
const RATE_ERROR = `请填 ${RATE_MIN}–${RATE_MAX} 的整数`;

const INPUT_CLASS =
  'h-9 w-full rounded-[var(--radius-button)] border border-[var(--bg-subtle)] bg-[var(--bg-card)] px-3 text-sm tabular-nums text-[var(--text-primary)] outline-none focus:border-[var(--brand-500)] disabled:cursor-not-allowed disabled:opacity-50';

/** 解析输入框原值：`null` = 非法（空串 / 非数字 / 越界）。**`'0'` 明确非法**。 */
function parseRate(raw: string): number | null {
  if (!/^\d+$/.test(raw)) return null;
  const value = Number(raw);
  return value >= RATE_MIN && value <= RATE_MAX ? value : null;
}

interface Loaded {
  studentId: number;
  /** 输入框原值（字符串），不要 Number() 后回写。 */
  rate: string;
  enabled: boolean;
  /** 服务器快照（判脏基准 + 只发改动字段的对照）。 */
  snapshot: PointsSettings;
}

export default function PointsSettingsPanel({
  studentId,
  onSettingsChanged,
}: PointsSettingsPanelProps) {
  const [data, setData] = useState<Loaded | null>(null);
  const [failedStudentId, setFailedStudentId] = useState<number | null>(null);
  const [reload, setReload] = useState(0);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  /**
   * 按 `studentId` 现算归属，而不是在 effect 里清空：effect 在 commit 之后才跑，
   * 清空会慢一帧 —— 那一帧显示的是**上一个孩子的设置**。
   */
  const loaded = data && data.studentId === studentId ? data : null;
  const failed = failedStudentId === studentId;

  useEffect(() => {
    let cancelled = false;
    getParentPointsSettings(studentId)
      .then((settings) => {
        if (cancelled) return;
        setData({
          studentId,
          rate: String(settings.pointsPerYuan),
          enabled: settings.rewardRedemptionEnabled,
          snapshot: settings,
        });
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

  if (failed) {
    return (
      <Card
        data-testid="points-settings-error"
        data-student-id={studentId}
        className="flex flex-wrap items-center justify-between gap-4 border border-[var(--error)] p-4"
      >
        <span className="text-sm text-[var(--text-secondary)]">兑换设置暂时加载失败</span>
        <Button variant="secondary" size="sm" onClick={() => setReload((n) => n + 1)}>
          重试
        </Button>
      </Card>
    );
  }

  if (loaded === null) {
    return (
      <div data-testid="points-settings-skeleton" data-student-id={studentId} className="space-y-4">
        <Skeleton width="100%" height={160} rounded />
      </div>
    );
  }

  const parsedRate = parseRate(loaded.rate);
  const rateError = parsedRate === null;
  const rateChanged = parsedRate !== null && parsedRate !== loaded.snapshot.pointsPerYuan;
  const enabledChanged = loaded.enabled !== loaded.snapshot.rewardRedemptionEnabled;
  const dirty = rateChanged || enabledChanged;
  const canSave = dirty && !rateError && !saving;

  const patch = (updater: (prev: Loaded) => Loaded) => {
    // 任何一次编辑都清掉上一次保存失败留下的提示
    setSaveError(null);
    setData((prev) => (prev && prev.studentId === studentId ? updater(prev) : prev));
  };

  const doSave = async () => {
    if (!canSave || loaded === null || parsedRate === null) return;
    // 只发改动过的字段：后端语义是「未提供即不动」
    const body: Partial<PointsSettings> = {};
    if (rateChanged) body.pointsPerYuan = parsedRate;
    if (enabledChanged) body.rewardRedemptionEnabled = loaded.enabled;
    setSaving(true);
    setSaveError(null);
    try {
      const next = await saveParentPointsSettings(studentId, body);
      // 用响应体刷新本地（服务端可能归一），不自己拼
      setData((prev) =>
        prev && prev.studentId === studentId
          ? {
              studentId,
              rate: String(next.pointsPerYuan),
              enabled: next.rewardRedemptionEnabled,
              snapshot: next,
            }
          : prev,
      );
      toast('success', '兑换设置已保存');
      onSettingsChanged?.(next);
    } catch (err: unknown) {
      const message = err instanceof Error && err.message ? err.message : '保存失败';
      toast('error', message);
      setSaveError(message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <Card data-testid="points-settings" data-student-id={studentId} className="p-6">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h2 className="text-base font-bold text-[var(--text-primary)]">兑换设置</h2>
          <p className="mt-0.5 text-xs text-[var(--text-secondary)]">
            设置孩子把积分换成钱的比例，以及是否允许兑换。
          </p>
        </div>
        <Button
          variant={canSave ? 'primary' : 'ghost'}
          size="sm"
          loading={saving}
          disabled={!canSave}
          data-testid="save-settings"
          onClick={() => void doSave()}
        >
          保存
        </Button>
      </div>

      {saveError && (
        <p
          data-testid="points-settings-save-error"
          className="mt-4 rounded-[var(--radius-button)] border border-[var(--error)] px-3 py-2 text-xs text-[var(--error)]"
        >
          {saveError}
        </p>
      )}

      <div className="mt-5 grid grid-cols-1 gap-5 lg:grid-cols-2">
        <div>
          <label
            htmlFor="points-per-yuan"
            className="mb-1 block text-xs font-medium text-[var(--text-secondary)]"
          >
            多少积分兑 1 元
          </label>
          <input
            id="points-per-yuan"
            data-testid="settings-rate-input"
            type="number"
            min={RATE_MIN}
            max={RATE_MAX}
            step={1}
            inputMode="numeric"
            value={loaded.rate}
            disabled={saving}
            aria-invalid={rateError ? true : undefined}
            aria-describedby={rateError ? undefined : 'points-per-yuan-preview'}
            onChange={(e) => patch((prev) => ({ ...prev, rate: e.target.value }))}
            className={clsx(INPUT_CLASS, 'max-w-[12rem]', rateError && 'border-[var(--error)]')}
          />
          {rateError ? (
            <p data-testid="settings-rate-error" className="mt-1 text-xs text-[var(--error)]">
              {RATE_ERROR}
            </p>
          ) : (
            <p id="points-per-yuan-preview" className="mt-1 text-xs text-[var(--text-tertiary)]">
              <span data-testid="settings-rate-preview">{`${parsedRate} 积分 = 1 元`}</span>
              <span data-testid="settings-rate-example" className="ml-2">
                {`当前设置：100 积分 = ${previewCashAmount(100, parsedRate).toFixed(2)} 元`}
              </span>
            </p>
          )}
        </div>

        <div>
          <span className="mb-1 block text-xs font-medium text-[var(--text-secondary)]">
            允许积分兑换
          </span>
          <div className="flex items-center gap-3">
            <button
              type="button"
              role="switch"
              data-testid="settings-switch"
              aria-checked={loaded.enabled}
              aria-label="允许积分兑换"
              disabled={saving}
              onClick={() => patch((prev) => ({ ...prev, enabled: !prev.enabled }))}
              className={clsx(
                'relative inline-flex h-6 w-11 shrink-0 items-center rounded-[var(--radius-pill)] transition-colors',
                'focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-[var(--brand-100)]',
                'disabled:cursor-not-allowed disabled:opacity-50',
                loaded.enabled ? 'bg-[var(--brand-500)]' : 'bg-[var(--bg-subtle)]',
              )}
            >
              <span
                aria-hidden="true"
                className={clsx(
                  'inline-block h-5 w-5 rounded-full bg-[var(--bg-card)] shadow-[var(--shadow-card)] transition-transform',
                  loaded.enabled ? 'translate-x-[22px]' : 'translate-x-0.5',
                )}
              />
            </button>
            <span className="text-sm text-[var(--text-secondary)]">
              {loaded.enabled ? '孩子可兑换积分' : '已关闭，兑换表单不可用'}
            </span>
          </div>
        </div>
      </div>
    </Card>
  );
}
