import { useEffect, useRef, useState } from 'react';
import clsx from 'clsx';
import { Button, Card, Modal, Skeleton, toast } from '@/components/base';
import {
  ApiError,
  getLevels,
  getParentPoints,
  getParentPointsSettings,
  getParentRewardCatalog,
  redeemParentPoints,
  type PointLevel,
  type PointsSettings,
  type RewardCatalogView,
} from '@/services/api';
import { previewCashAmount } from './previewCash';

/**
 * 「兑换」Tab 的下半块 —— 兑换表单（计划三 §2.6(b) / §2.8，Task 7）。
 *
 * 三条硬要求：
 * 1. **金额预览与后端同口径取整**。复用 `previewCashAmount`（见 `./previewCash`），
 *    与 `redemption.service.ts` 同一式；写成 `points / perYuan` 再 `toFixed` 在非默认
 *    汇率下会差 1 分钱。汇率的兑换方向是 **积分 → 钱**：家长输入积分数，金额被推导
 *    出来，不是反过来。
 * 2. **确认弹窗写明「兑换不可撤销」**（spec §7.3 已知限制）。未确认绝不发请求。
 * 3. **错误码分流**（§2.8 唯一映射表）：`3001`/`3002` inline 不 toast；`3003` toast +
 *    重拉清单；`3004` 表单整块置灰 + inline。
 *
 * 余额只作 UX 预判（不足就禁用提交），**服务端仍是唯一权威**——并发下余额不足会返回
 * 3001，所以本地不判余额也照样能提交，按错误处理即可。
 *
 * 与上方面板的耦合：`pointsPerYuan` 与开关都来自 `GET points/settings`，本组件自己读
 * （兑换本来就需要汇率）；页面在上方面板保存成功后自增 `settingsVersion`，本组件据此
 * 重读设置。只加一个数字版本的接线，不把两份表单的状态混在一起。
 */
export interface RedeemPanelProps {
  studentId: number;
  /** 兑换成功后调用，让页面重拉概览卡（余额/段位变了）。 */
  onPointsChanged?: () => void;
  /** 页面上方「兑换设置」保存成功后自增，触发本组件重读设置（开关/汇率）。 */
  settingsVersion?: number;
}

const INPUT_CLASS =
  'h-9 w-full rounded-[var(--radius-button)] border border-[var(--bg-subtle)] bg-[var(--bg-card)] px-3 text-sm tabular-nums text-[var(--text-primary)] outline-none focus:border-[var(--brand-500)] disabled:cursor-not-allowed disabled:opacity-50';

type Mode = 'cash' | 'reward';

interface LoadedData {
  studentId: number;
  balance: number;
  level: PointLevel;
  catalog: RewardCatalogView[];
  levels: PointLevel[];
}

interface LoadedSettings {
  studentId: number;
  value: PointsSettings;
}

type RedeemBody = { type: 'cash'; points: number } | { type: 'reward'; catalogId: number };

/** 一条奖励对当前这个孩子的可行性与差距。 */
interface RewardGate {
  affordable: boolean;
  levelOk: boolean;
  gap: number;
  requiredName: string | null;
}

export default function RedeemPanel({
  studentId,
  onPointsChanged,
  settingsVersion = 0,
}: RedeemPanelProps) {
  const [data, setData] = useState<LoadedData | null>(null);
  const [dataFailedStudentId, setDataFailedStudentId] = useState<number | null>(null);
  /**
   * 「成功过一次、但最近这次后台刷新失败」——**不是**错误态，只配一行非致命提示。
   *
   * 只在兑换成功后的重拉失败时会出现：那笔兑换已经扣了积分，若把 `data` 清空、
   * 翻成「兑换信息暂时加载失败」，家长会以为钱没扣/兑换失败（审查 #1）。
   * 判断「有没有可用旧数据」用 ref 记住上次成功加载的学生，而不是读 `data`——
   * 切换孩子时 `data` 还留着上一个孩子的值，那个不算「当前孩子有数据」。
   */
  const [dataStale, setDataStale] = useState(false);
  const loadedStudentIdRef = useRef<number | null>(null);
  const [dataReload, setDataReload] = useState(0);
  const [settingsData, setSettingsData] = useState<LoadedSettings | null>(null);
  const [settingsFailedStudentId, setSettingsFailedStudentId] = useState<number | null>(null);
  const [settingsReload, setSettingsReload] = useState(0);

  const [mode, setMode] = useState<Mode>('cash');
  const [pointsInput, setPointsInput] = useState('');
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  /** 服务端业务拒绝的 inline 提示（3001/3002/1001 等）；编辑时清空。 */
  const [serverInline, setServerInline] = useState<string | null>(null);
  /** 3004：服务端说兑换已关闭 → 表单就此置灰（即使本地设置仍是开着的）。 */
  const [closedByServer, setClosedByServer] = useState(false);

  // 余额/段位/清单/段位表随孩子与重拉变化
  useEffect(() => {
    let cancelled = false;
    Promise.all([getParentPoints(studentId), getParentRewardCatalog(studentId), getLevels()])
      .then(([points, catalog, levels]) => {
        if (cancelled) return;
        setData({
          studentId,
          balance: points.balance,
          level: points.level,
          catalog,
          levels: levels.levels,
        });
        loadedStudentIdRef.current = studentId;
        setDataStale(false);
        setDataFailedStudentId(null);
      })
      .catch(() => {
        if (cancelled) return;
        // 当前孩子已经有成功加载过的数据 → 这次只是后台刷新失败，保留旧数据 + 非致命提示。
        // 首次加载 / 切孩子后的加载失败才进错误态（没有可用数据，必须让家长看到重试）。
        if (loadedStudentIdRef.current === studentId) {
          setDataStale(true);
          return;
        }
        setData(null);
        setDataFailedStudentId(studentId);
      });
    return () => {
      cancelled = true;
    };
  }, [studentId, dataReload]);

  // 兑换设置单独一条：settingsVersion 变化只重读设置，不重置上面那份数据（不闪骨架）
  useEffect(() => {
    let cancelled = false;
    getParentPointsSettings(studentId)
      .then((value) => {
        if (cancelled) return;
        setSettingsData({ studentId, value });
        setSettingsFailedStudentId(null);
        // 设置里开关已重新打开：解掉 3004 的本地置灰，否则家长在设置里开了开关，
        // 表单却一直灰着（3004 是「读到的服务端状态」，服务端状态已经变了）。
        if (value.rewardRedemptionEnabled) setClosedByServer(false);
      })
      .catch(() => {
        if (cancelled) return;
        setSettingsFailedStudentId(studentId);
      });
    return () => {
      cancelled = true;
    };
  }, [studentId, settingsVersion, settingsReload]);

  const loadedData = data && data.studentId === studentId ? data : null;
  const settings = settingsData && settingsData.studentId === studentId ? settingsData.value : null;

  if (dataFailedStudentId === studentId || settingsFailedStudentId === studentId) {
    return (
      <Card
        data-testid="redeem-error"
        data-student-id={studentId}
        className="flex flex-wrap items-center justify-between gap-4 border border-[var(--error)] p-4"
      >
        <span className="text-sm text-[var(--text-secondary)]">兑换信息暂时加载失败</span>
        <Button
          variant="secondary"
          size="sm"
          onClick={() => {
            setDataReload((n) => n + 1);
            setSettingsReload((n) => n + 1);
          }}
        >
          重试
        </Button>
      </Card>
    );
  }

  if (loadedData === null || settings === null) {
    return (
      <div data-testid="redeem-skeleton" data-student-id={studentId} className="space-y-4">
        <Skeleton width="100%" height={260} rounded />
      </div>
    );
  }

  const { balance, level, catalog, levels } = loadedData;
  const perYuan = settings.pointsPerYuan;
  const levelByCode = new Map(levels.map((item) => [item.code, item]));

  const settingsClosed = !settings.rewardRedemptionEnabled;
  const formDisabled = settingsClosed || closedByServer;

  const cashPoints = /^\d+$/.test(pointsInput) ? Number(pointsInput) : null;
  const cashValid = cashPoints !== null && cashPoints >= 1;
  const cashAmount = cashValid ? previewCashAmount(cashPoints, perYuan) : 0;
  const insufficient = cashValid && cashPoints > balance;

  const activeCatalog = catalog.filter((item) => item.isActive);
  const gateOf = (item: RewardCatalogView): RewardGate => {
    const required = item.minLevelCode ? levelByCode.get(item.minLevelCode) : undefined;
    return {
      affordable: balance >= item.pointsCost,
      // 未知 code 属脏数据，一律不可兑（与后端 `levelIndexOf < 0 → 3002` 同口径）
      levelOk: !item.minLevelCode || (required !== undefined && level.index >= required.index),
      gap: Math.max(0, item.pointsCost - balance),
      requiredName: required?.name ?? null,
    };
  };
  const selected = activeCatalog.find((item) => item.id === selectedId) ?? null;
  const selectedGate = selected ? gateOf(selected) : null;

  const cashCanSubmit = !formDisabled && cashValid && !insufficient;
  const rewardCanSubmit =
    !formDisabled &&
    selected !== null &&
    selectedGate !== null &&
    selectedGate.affordable &&
    selectedGate.levelOk;

  const inlineError = settingsClosed
    ? '兑换已关闭，打开开关后可兑换'
    : closedByServer
      ? '兑换已关闭，可在上方设置中开启'
      : (serverInline ??
        // `insufficient` 是「换钱输入超额」的本地判据，只属于换钱模式；
        // 切到换奖励还显示它会答非所问（该模式根本没用那个输入框）——审查 #2
        (mode === 'cash' && insufficient ? `可用积分不足，当前 ${balance} 分` : null));

  const switchMode = (next: Mode) => {
    if (next === mode) return;
    setMode(next);
    setServerInline(null);
  };

  const submitRequest = () => {
    if (mode === 'cash' ? !cashCanSubmit : !rewardCanSubmit) return;
    setConfirmOpen(true);
  };

  const doRedeem = async () => {
    let body: RedeemBody | null;
    if (mode === 'cash') {
      if (cashPoints === null || !cashValid) return;
      body = { type: 'cash', points: cashPoints };
    } else {
      if (selected === null) return;
      body = { type: 'reward', catalogId: selected.id };
    }

    setSubmitting(true);
    setServerInline(null);
    try {
      const result = await redeemParentPoints(studentId, body);
      const redemption = result.redemption;
      toast(
        'success',
        redemption.type === 'cash'
          ? `已为孩子兑换 ¥${(redemption.cashAmount ?? 0).toFixed(2)}`
          : `已兑换「${redemption.rewardName ?? ''}」`,
      );
      // 余额用响应体（服务端权威），并重拉清单/汇率防止漂移
      setData((prev) =>
        prev && prev.studentId === studentId ? { ...prev, balance: result.balance } : prev,
      );
      setConfirmOpen(false);
      setPointsInput('');
      setSelectedId(null);
      onPointsChanged?.();
      setDataReload((n) => n + 1);
    } catch (err: unknown) {
      setConfirmOpen(false);
      const code = err instanceof ApiError ? err.code : null;
      const message = err instanceof Error && err.message ? err.message : '兑换失败';
      if (code === 3001) {
        // inline（不 toast）：本地判余额只是 UX，并发下服务端才是权威
        setServerInline(`可用积分不足，当前 ${balance} 分`);
      } else if (code === 3002) {
        const name = selected?.minLevelCode
          ? levelByCode.get(selected.minLevelCode)?.name
          : undefined;
        setServerInline(name ? `该奖励需达到「${name}」才可兑换` : '未达该奖励的段位门槛');
      } else if (code === 3004) {
        // 表单整块置灰 + inline，由上面的 inlineError 呈现
        setClosedByServer(true);
      } else if (code === 3003) {
        toast('error', message);
        setDataReload((n) => n + 1);
      } else {
        toast('error', message);
      }
    } finally {
      setSubmitting(false);
    }
  };

  const confirmSummary =
    mode === 'cash'
      ? cashPoints === null
        ? ''
        : `将扣除 ${cashPoints} 积分，兑换 ¥${previewCashAmount(cashPoints, perYuan).toFixed(2)}`
      : selected
        ? `将扣除 ${selected.pointsCost} 积分，兑换「${selected.name}」`
        : '';
  const confirmRemaining = balance - (mode === 'cash' ? (cashPoints ?? 0) : (selected?.pointsCost ?? 0));

  return (
    <Card data-testid="redeem-panel" data-student-id={studentId} className="p-6">
      <h2 className="text-base font-bold text-[var(--text-primary)]">兑换</h2>
      <p className="mt-0.5 text-xs text-[var(--text-secondary)]">
        为孩子把积分换成现金或奖励。兑换会立即扣除积分，且不可撤销。
      </p>

      {inlineError && (
        <p
          data-testid="redeem-inline"
          role="alert"
          className="mt-4 rounded-[var(--radius-button)] border border-[var(--error)] px-3 py-2 text-xs text-[var(--error)]"
        >
          {inlineError}
        </p>
      )}

      {/*
        非致命提示（审查 #1）：兑换成功后余额已按响应体更新，只是这次后台重拉失败。
        数据仍可用（不整块错误态），但汇率/清单可能略旧——说清楚，别吓人。
      */}
      {dataStale && (
        <p data-testid="redeem-stale" className="mt-4 text-xs text-[var(--text-tertiary)]">
          信息可能不是最新，稍后自动刷新
        </p>
      )}

      <div
        data-testid="redeem-form"
        data-disabled={formDisabled ? 'true' : undefined}
        aria-disabled={formDisabled || undefined}
        className={clsx('mt-4', formDisabled && 'opacity-50')}
      >
        <div
          role="radiogroup"
          aria-label="兑换方式"
          className="inline-flex rounded-[var(--radius-button)] bg-[var(--bg-base)] p-1"
        >
          {(
            [
              { key: 'cash', label: '换钱' },
              { key: 'reward', label: '换奖励' },
            ] as const
          ).map((item) => (
            <button
              key={item.key}
              type="button"
              role="radio"
              aria-checked={mode === item.key}
              disabled={formDisabled}
              onClick={() => switchMode(item.key)}
              className={clsx(
                'rounded-[var(--radius-button)] px-4 py-1.5 text-sm font-medium transition-colors',
                'disabled:cursor-not-allowed',
                mode === item.key
                  ? 'bg-[var(--bg-card)] text-[var(--brand-600)] shadow-[var(--shadow-card)]'
                  : 'text-[var(--text-secondary)]',
              )}
            >
              {item.label}
            </button>
          ))}
        </div>

        {mode === 'cash' ? (
          <div className="mt-5 max-w-md">
            <label
              htmlFor="redeem-points"
              className="mb-1 block text-xs font-medium text-[var(--text-secondary)]"
            >
              兑换积分
            </label>
            <input
              id="redeem-points"
              data-testid="redeem-points-input"
              type="number"
              min={1}
              step={1}
              inputMode="numeric"
              placeholder="输入要花掉的积分"
              value={pointsInput}
              disabled={formDisabled}
              onChange={(e) => {
                setPointsInput(e.target.value);
                setServerInline(null);
              }}
              className={clsx(
                INPUT_CLASS,
                'max-w-[12rem]',
                cashValid && insufficient && 'border-[var(--error)]',
              )}
            />
            {cashValid && (
              <>
                <p data-testid="redeem-cash-preview" className="mt-3 text-lg font-bold text-[var(--text-primary)]">
                  {`¥${cashAmount.toFixed(2)}`}
                </p>
                <p data-testid="redeem-cash-summary" className="mt-1 text-sm text-[var(--text-secondary)]">
                  {`将扣除 ${cashPoints} 积分，兑换 ¥${cashAmount.toFixed(2)}；兑换后余额 ${
                    balance - cashPoints
                  } 分`}
                </p>
              </>
            )}
          </div>
        ) : (
          <div className="mt-5">
            {activeCatalog.length === 0 ? (
              <p className="text-sm text-[var(--text-secondary)]">暂无可兑换的奖励</p>
            ) : (
              <div
                role="radiogroup"
                aria-label="选择奖励"
                className="grid grid-cols-1 gap-3 lg:grid-cols-2"
              >
                {activeCatalog.map((item) => {
                  const gate = gateOf(item);
                  const selectable = gate.affordable && gate.levelOk;
                  const checked = selectedId === item.id;
                  return (
                    <button
                      key={item.id}
                      type="button"
                      role="radio"
                      data-testid={`reward-option-${item.id}`}
                      aria-checked={checked}
                      disabled={formDisabled || !selectable}
                      onClick={() => {
                        setSelectedId(item.id);
                        setServerInline(null);
                      }}
                      className={clsx(
                        'rounded-[var(--radius-card)] border p-4 text-left transition-colors',
                        'disabled:cursor-not-allowed',
                        checked
                          ? 'border-[var(--brand-500)] bg-[var(--brand-100)]'
                          : 'border-[var(--bg-subtle)] bg-[var(--bg-card)]',
                        !selectable && 'opacity-60',
                      )}
                    >
                      <div className="flex items-start justify-between gap-3">
                        <span className="text-sm font-medium text-[var(--text-primary)]">
                          {item.name}
                        </span>
                        <span className="shrink-0 text-sm tabular-nums text-[var(--text-secondary)]">
                          {`${item.pointsCost} 积分`}
                        </span>
                      </div>
                      <div className="mt-1 flex flex-wrap gap-x-3 text-xs">
                        {item.minLevelCode && (
                          <span className="text-[var(--text-tertiary)]">
                            {gate.requiredName
                              ? gate.levelOk
                                ? `已达「${gate.requiredName}」`
                                : `需达到「${gate.requiredName}」段位`
                              : // 脏 code（段位表里查不到）：项已按后端同口径置为不可兑，
                                // 但不能让家长只看到灰按钮没有原因。回退文案照服务端学生端
                                // 用的「更高段位」，不自己编段位名——审查 #3
                                '需达到更高段位'}
                          </span>
                        )}
                        {!gate.affordable && (
                          <span className="text-[var(--text-tertiary)]">{`还差 ${gate.gap} 分`}</span>
                        )}
                      </div>
                    </button>
                  );
                })}
              </div>
            )}
          </div>
        )}

        <div className="mt-5">
          <Button
            data-testid="redeem-submit"
            variant="primary"
            size="md"
            loading={submitting}
            disabled={mode === 'cash' ? !cashCanSubmit : !rewardCanSubmit}
            onClick={submitRequest}
          >
            兑换
          </Button>
        </div>
      </div>

      <Modal
        open={confirmOpen}
        onClose={() => {
          if (!submitting) setConfirmOpen(false);
        }}
        title="确认兑换"
      >
        <div className="space-y-4">
          <p className="text-sm leading-relaxed text-[var(--text-secondary)]">
            兑换不可撤销，只能再兑一次或线下补偿。
          </p>
          <p className="text-sm text-[var(--text-primary)]">{confirmSummary}</p>
          <p className="text-sm text-[var(--text-secondary)]">
            {`兑换后余额 ${confirmRemaining} 分`}
          </p>
          <div className="flex justify-end gap-3">
            <Button
              variant="ghost"
              size="sm"
              disabled={submitting}
              onClick={() => setConfirmOpen(false)}
            >
              取消
            </Button>
            <Button
              data-testid="redeem-confirm"
              variant="primary"
              size="sm"
              loading={submitting}
              onClick={() => void doRedeem()}
            >
              确认兑换
            </Button>
          </div>
        </div>
      </Modal>
    </Card>
  );
}
