import { useCallback, useEffect, useState } from 'react';
import {
  approveBillingClaim,
  grantFamilyDays,
  listBillingClaims,
  listBillingFamilies,
  rejectBillingClaim,
  setFamilyTrial,
  type AdminBillingClaimView,
  type AdminFamilyView,
  type SubscriptionStatusView,
} from '@/services/api';
import { Input, Modal, Skeleton, toast } from '@/components/base';
import { useAdminBillingBadgeStore } from '@/store/adminBillingBadgeStore';

/**
 * 管理端「订阅裁决」页（订阅批④ Task 7）：Tab 1 待裁决 + Tab 2 家庭订阅。
 *
 * 「现场核验」的口径（brief 审定）：管理端**没有**订单详情端点，家长端
 * `GET /billing/orders/{orderNo}` 对 admin 是 403 —— 所以「核验」= 行内刷新
 * + 「以渠道支付状态为准，请线下核实」提示，并把这单已有的裁决字段（备注 / 金额 /
 * 主张时间）全部展示在行内。**不新增后端端点，不调任何家长端点。**
 *
 * approve / reject 成功后重拉列表（行消失由重拉体现），并触发侧栏角标
 * store refresh（adminBillingBadgeStore——AdminNav 在 router 之外不重挂，
 * 必须由本页主动刷新）。
 * 调整试用 / 赠送天数成功后用返回的 StatusView **行内更新**，不整页重拉。
 */

const PAGE_SIZE = 20;

const FAMILY_STATUS_LABEL: Record<AdminFamilyView['status'], string> = {
  trialing: '试用中',
  active: '生效中',
  expired: '已过期',
};

function formatCents(cents: number): string {
  return `¥${(cents / 100).toFixed(2)}`;
}

/** 日期字段统一展示 YYYY-MM-DD（时区无关的截取口径：服务端给的是 UTC ISO）。 */
function formatDate(iso: string | null): string {
  return iso ? iso.slice(0, 10) : '—';
}

function formatDateTime(iso: string): string {
  return new Date(iso).toLocaleString('zh-CN');
}

/** 日期控件值（YYYY-MM-DD）→ 当天结束时刻的本地 ISO（试用覆盖所选整天）。 */
function endOfDayIso(dateStr: string): string {
  return new Date(`${dateStr}T23:59:59`).toISOString();
}

export default function AdminBillingPage() {
  const [tab, setTab] = useState<'claims' | 'families'>('claims');

  // ---- Tab 1 待裁决 ----
  const [claims, setClaims] = useState<AdminBillingClaimView[] | null>(null);
  const [claimsError, setClaimsError] = useState('');
  const [rejectTarget, setRejectTarget] = useState<AdminBillingClaimView | null>(null);
  const [rejectReason, setRejectReason] = useState('');
  /** 在途闸门：approve/reject 请求未回来前丢弃同一行的后续点击（照 AdminAlertsPage 的 ref 口径）。 */
  const [busyOrderNo, setBusyOrderNo] = useState<string | null>(null);

  const refreshBadge = useAdminBillingBadgeStore((s) => s.refresh);

  const loadClaims = useCallback(() => {
    listBillingClaims('pending_review', 1, PAGE_SIZE)
      .then((res) => {
        setClaims(res.items);
        setClaimsError('');
      })
      .catch((err: unknown) => {
        const msg = err instanceof Error ? err.message : '加载失败';
        setClaims(null);
        setClaimsError(msg);
        toast('error', msg);
      });
  }, []);

  useEffect(() => {
    loadClaims();
  }, [loadClaims]);

  const handleApprove = async (orderNo: string) => {
    if (busyOrderNo !== null) return;
    setBusyOrderNo(orderNo);
    try {
      await approveBillingClaim(orderNo);
      toast('success', '已入账并开通订阅');
      loadClaims();
      refreshBadge();
    } catch (err) {
      toast('error', err instanceof Error ? err.message : '操作失败');
    } finally {
      setBusyOrderNo(null);
    }
  };

  const handleReject = async () => {
    if (rejectTarget === null || busyOrderNo !== null) return;
    setBusyOrderNo(rejectTarget.orderNo);
    try {
      await rejectBillingClaim(
        rejectTarget.orderNo,
        rejectReason.trim().length > 0 ? rejectReason.trim() : undefined,
      );
      setRejectTarget(null);
      setRejectReason('');
      toast('success', '已驳回');
      loadClaims();
      refreshBadge();
    } catch (err) {
      toast('error', err instanceof Error ? err.message : '操作失败');
    } finally {
      setBusyOrderNo(null);
    }
  };

  // ---- Tab 2 家庭订阅 ----
  const [keyword, setKeyword] = useState('');
  const [families, setFamilies] = useState<AdminFamilyView[] | null>(null);
  const [trialTarget, setTrialTarget] = useState<AdminFamilyView | null>(null);
  const [trialDate, setTrialDate] = useState('');
  const [grantTarget, setGrantTarget] = useState<AdminFamilyView | null>(null);
  const [grantDays, setGrantDays] = useState('');
  const [grantReason, setGrantReason] = useState('');
  /** families 是否已拉过：切 Tab 只拉一次，搜索/操作后按需重拉。 */
  const [familiesLoaded, setFamiliesLoaded] = useState(false);

  const loadFamilies = useCallback((kw: string) => {
    listBillingFamilies(kw, 1, PAGE_SIZE)
      .then((res) => {
        setFamilies(res.items);
        setFamiliesLoaded(true);
      })
      .catch((err: unknown) => {
        toast('error', err instanceof Error ? err.message : '加载失败');
      });
  }, []);

  useEffect(() => {
    if (tab === 'families' && !familiesLoaded) loadFamilies('');
  }, [tab, familiesLoaded, loadFamilies]);

  /** 操作成功后用返回 StatusView 行内更新对应家庭（不整页重拉）。 */
  const patchFamily = (parentId: number, view: SubscriptionStatusView) => {
    setFamilies((prev) =>
      prev === null
        ? prev
        : prev.map((f) =>
            f.parentId === parentId
              ? { ...f, status: view.status, planCode: view.planCode, trialEndsAt: view.trialEndsAt, currentPeriodEnd: view.currentPeriodEnd }
              : f,
          ),
    );
  };

  const handleTrialSave = async () => {
    if (trialTarget === null || trialDate === '') return;
    try {
      const view = await setFamilyTrial(trialTarget.parentId, endOfDayIso(trialDate));
      patchFamily(trialTarget.parentId, view);
      setTrialTarget(null);
      toast('success', '试用截止已更新');
    } catch (err) {
      toast('error', err instanceof Error ? err.message : '操作失败');
    }
  };

  const handleTrialRevoke = async () => {
    if (trialTarget === null) return;
    try {
      const view = await setFamilyTrial(trialTarget.parentId, null);
      patchFamily(trialTarget.parentId, view);
      setTrialTarget(null);
      toast('success', '试用已收回');
    } catch (err) {
      toast('error', err instanceof Error ? err.message : '操作失败');
    }
  };

  const handleGrant = async () => {
    if (grantTarget === null) return;
    const days = Number(grantDays);
    if (grantDays.trim() === '' || !Number.isInteger(days) || days === 0) {
      toast('error', '天数必须是非 0 整数');
      return;
    }
    try {
      const view = await grantFamilyDays(
        grantTarget.parentId,
        days,
        grantReason.trim().length > 0 ? grantReason.trim() : undefined,
      );
      patchFamily(grantTarget.parentId, view);
      setGrantTarget(null);
      setGrantDays('');
      setGrantReason('');
      toast('success', `已调整 ${days} 天`);
    } catch (err) {
      toast('error', err instanceof Error ? err.message : '操作失败');
    }
  };

  const header = (
    <div>
      <h1 className="text-2xl font-black tracking-tight" style={{ color: 'var(--text-primary)' }}>订阅裁决</h1>
      <p className="text-sm mt-1" style={{ color: 'var(--text-secondary)' }}>
        线下转账人工核实与家庭订阅调整。到账以渠道状态为准，请线下核实。
      </p>
    </div>
  );

  const tabButtonClass = (active: boolean) =>
    `px-4 py-2 text-sm font-semibold rounded-lg transition-colors ${
      active ? 'bg-[var(--brand-500)] text-white' : 'text-[var(--text-secondary)] hover:bg-[var(--bg-subtle)]'
    }`;

  return (
    <div className="space-y-6">
      {header}

      <div className="flex gap-2" role="tablist">
        <button type="button" role="tab" data-testid="tab-claims" aria-selected={tab === 'claims'} className={tabButtonClass(tab === 'claims')} onClick={() => setTab('claims')}>
          待裁决
        </button>
        <button type="button" role="tab" data-testid="tab-families" aria-selected={tab === 'families'} className={tabButtonClass(tab === 'families')} onClick={() => setTab('families')}>
          家庭订阅
        </button>
      </div>

      {tab === 'claims' && (
        <div data-testid="claims-panel" className="space-y-3">
          {claims === null && !claimsError && (
            <div className="bg-white rounded-2xl border border-gray-200 p-5 space-y-3">
              <Skeleton width={120} height={14} />
              <Skeleton width="60%" height={12} />
            </div>
          )}
          {claimsError && (
            <div data-testid="claims-error" className="bg-white rounded-2xl border border-dashed border-gray-200 p-10 text-center text-sm" style={{ color: 'var(--text-secondary)' }}>
              待裁决列表加载失败，请稍后重试
            </div>
          )}
          {claims !== null && claims.length === 0 && (
            <div data-testid="claims-empty" className="bg-white rounded-2xl border border-dashed border-gray-200 p-10 text-center text-sm" style={{ color: 'var(--text-secondary)' }}>
              暂无待裁决的转账主张
            </div>
          )}
          {claims !== null &&
            claims.map((c) => (
              <div key={c.orderNo} data-testid={`claim-row-${c.orderNo}`} className="bg-white rounded-2xl border border-gray-200 p-5">
                <div className="flex items-start justify-between gap-4 flex-wrap">
                  <div className="space-y-1 text-sm" style={{ color: 'var(--text-primary)' }}>
                    <p className="font-semibold">{c.parentPhone}</p>
                    <p style={{ color: 'var(--text-secondary)' }}>
                      {`${c.planName} · ${formatCents(c.amountCents)} · 主张于 ${formatDateTime(c.claimedAt)}`}
                    </p>
                    <p style={{ color: 'var(--text-secondary)' }}>{`订单号 ${c.orderNo} · 支付状态 ${c.paymentStatus}`}</p>
                    {c.claimNote !== null && (
                      <p style={{ color: 'var(--text-secondary)' }}>{`家长备注：${c.claimNote}`}</p>
                    )}
                  </div>
                  <div className="flex gap-2 shrink-0">
                    <button
                      type="button"
                      onClick={() => {
                        loadClaims();
                        toast('info', '以渠道支付状态为准，请线下核实到账');
                      }}
                      className="px-3 py-2 rounded-lg text-sm border border-gray-200 text-[var(--text-secondary)] hover:bg-[var(--bg-subtle)] transition-colors"
                    >
                      刷新
                    </button>
                    <button
                      type="button"
                      disabled={busyOrderNo !== null}
                      onClick={() => handleApprove(c.orderNo)}
                      className="px-3 py-2 rounded-lg text-sm font-semibold bg-[var(--brand-500)] text-white hover:opacity-90 transition-opacity disabled:opacity-40"
                    >
                      通过
                    </button>
                    <button
                      type="button"
                      disabled={busyOrderNo !== null}
                      onClick={() => {
                        setRejectTarget(c);
                        setRejectReason('');
                      }}
                      className="px-3 py-2 rounded-lg text-sm font-semibold border border-[var(--error)] text-[var(--error)] hover:bg-[var(--bg-subtle)] transition-colors disabled:opacity-40"
                    >
                      驳回
                    </button>
                  </div>
                </div>
              </div>
            ))}
        </div>
      )}

      {tab === 'families' && (
        <div data-testid="families-panel" className="space-y-3">
          <div className="flex gap-2">
            <input
              data-testid="family-search-input"
              value={keyword}
              onChange={(e) => setKeyword(e.target.value)}
              placeholder="手机号 / 昵称"
              className="flex-1 max-w-xs px-3 py-2 rounded-lg border border-gray-200 bg-white text-sm text-[var(--text-primary)]"
            />
            <button
              type="button"
              data-testid="family-search-btn"
              onClick={() => loadFamilies(keyword)}
              className="px-4 py-2 rounded-lg text-sm font-semibold bg-[var(--brand-500)] text-white hover:opacity-90 transition-opacity"
            >
              搜索
            </button>
          </div>
          {families === null && (
            <div className="bg-white rounded-2xl border border-gray-200 p-5 space-y-3">
              <Skeleton width={120} height={14} />
              <Skeleton width="60%" height={12} />
            </div>
          )}
          {families !== null &&
            families.map((f) => (
              <div key={f.parentId} data-testid={`family-row-${f.parentId}`} className="bg-white rounded-2xl border border-gray-200 p-5">
                <div className="flex items-start justify-between gap-4 flex-wrap">
                  <div className="space-y-1 text-sm" style={{ color: 'var(--text-primary)' }}>
                    <p className="font-semibold">{f.phone}</p>
                    <p style={{ color: 'var(--text-secondary)' }}>{`${f.studentCount} 个孩子 · ${FAMILY_STATUS_LABEL[f.status]}`}</p>
                    <p style={{ color: 'var(--text-secondary)' }}>{`试用截止 ${formatDate(f.trialEndsAt)} · 到期 ${formatDate(f.currentPeriodEnd)}`}</p>
                  </div>
                  <div className="flex gap-2 shrink-0">
                    <button
                      type="button"
                      onClick={() => {
                        setTrialTarget(f);
                        setTrialDate(f.trialEndsAt ? f.trialEndsAt.slice(0, 10) : '');
                      }}
                      className="px-3 py-2 rounded-lg text-sm border border-gray-200 text-[var(--text-secondary)] hover:bg-[var(--bg-subtle)] transition-colors"
                    >
                      调整试用
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        setGrantTarget(f);
                        setGrantDays('');
                        setGrantReason('');
                      }}
                      className="px-3 py-2 rounded-lg text-sm border border-gray-200 text-[var(--text-secondary)] hover:bg-[var(--bg-subtle)] transition-colors"
                    >
                      赠送 / 扣减
                    </button>
                  </div>
                </div>
              </div>
            ))}
        </div>
      )}

      {/* 驳回原因表单 */}
      <Modal open={rejectTarget !== null} onClose={() => setRejectTarget(null)} title="驳回转账主张">
        <div className="space-y-4">
          <p className="text-sm" style={{ color: 'var(--text-secondary)' }}>
            {rejectTarget !== null ? `订单 ${rejectTarget.orderNo}（${rejectTarget.parentPhone}）` : ''}
          </p>
          <Input
            data-testid="reject-reason-input"
            value={rejectReason}
            onChange={(e) => setRejectReason(e.target.value)}
            placeholder="驳回原因（选填，最长 200 字）"
            maxLength={200}
          />
          <div className="flex justify-end gap-2">
            <button type="button" onClick={() => setRejectTarget(null)} className="px-4 py-2 rounded-lg text-sm border border-gray-200 text-[var(--text-secondary)] hover:bg-[var(--bg-subtle)] transition-colors">
              取消
            </button>
            <button type="button" onClick={handleReject} className="px-4 py-2 rounded-lg text-sm font-semibold bg-[var(--error)] text-white hover:opacity-90 transition-opacity">
              确认驳回
            </button>
          </div>
        </div>
      </Modal>

      {/* 调整试用 */}
      <Modal open={trialTarget !== null} onClose={() => setTrialTarget(null)} title="调整试用">
        <div className="space-y-4">
          <p className="text-sm" style={{ color: 'var(--text-secondary)' }}>
            {trialTarget !== null ? `${trialTarget.phone} · 试用截止 ${formatDate(trialTarget.trialEndsAt)}` : ''}
          </p>
          <input
            type="date"
            data-testid="trial-date-input"
            value={trialDate}
            onChange={(e) => setTrialDate(e.target.value)}
            className="w-full px-3 py-2 rounded-lg border border-gray-200 bg-white text-sm text-[var(--text-primary)]"
          />
          <div className="flex justify-end gap-2">
            <button type="button" data-testid="trial-revoke-btn" onClick={handleTrialRevoke} className="px-4 py-2 rounded-lg text-sm font-semibold border border-[var(--error)] text-[var(--error)] hover:bg-[var(--bg-subtle)] transition-colors">
              收回试用
            </button>
            <button type="button" data-testid="trial-save-btn" disabled={trialDate === ''} onClick={handleTrialSave} className="px-4 py-2 rounded-lg text-sm font-semibold bg-[var(--brand-500)] text-white hover:opacity-90 transition-opacity disabled:opacity-40 disabled:cursor-not-allowed">
              保存
            </button>
          </div>
        </div>
      </Modal>

      {/* 赠送 / 扣减天数 */}
      <Modal open={grantTarget !== null} onClose={() => setGrantTarget(null)} title="赠送 / 扣减订阅天数">
        <div className="space-y-4">
          <p className="text-sm" style={{ color: 'var(--text-secondary)' }}>
            {grantTarget !== null ? `${grantTarget.phone} · 正数赠送、负数扣减` : ''}
          </p>
          <Input
            data-testid="grant-days-input"
            type="number"
            value={grantDays}
            onChange={(e) => setGrantDays(e.target.value)}
            placeholder="天数（非 0 整数）"
          />
          <Input
            data-testid="grant-reason-input"
            value={grantReason}
            onChange={(e) => setGrantReason(e.target.value)}
            placeholder="原因（选填，最长 200 字）"
            maxLength={200}
          />
          <div className="flex justify-end">
            <button type="button" data-testid="grant-submit-btn" onClick={handleGrant} className="px-4 py-2 rounded-lg text-sm font-semibold bg-[var(--brand-500)] text-white hover:opacity-90 transition-opacity">
              确认调整
            </button>
          </div>
        </div>
      </Modal>
    </div>
  );
}
