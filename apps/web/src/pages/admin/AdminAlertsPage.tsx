import { useCallback, useEffect, useRef, useState } from 'react';
import {
  getExpiredAlertStats,
  purgeExpiredAlerts,
  type AdminAlertRetentionPreview,
} from '@/services/api';
import { ConfirmDialog, Skeleton, toast } from '@/components/base';

/**
 * 管理员端「预警数据」：预览并**手动**清理 30 天前的预警。
 *
 * 阈值固定 30 天、不接受入参（后端常量），所以本页没有可填项、没有校验分支——
 * 唯一的状态机是「拉统计 → 确认 → 清理 → 重拉统计」。
 *
 * **没有自动保留期**：`safety_alerts` 不会自己清理，只有这里点按钮才会删
 * （spec §9 已知限制）。未读的也会被删——「清理一个月前」的字面意思。
 */
export default function AdminAlertsPage() {
  const [stats, setStats] = useState<AdminAlertRetentionPreview | null>(null);
  const [error, setError] = useState('');
  /** 确认框开合。`purging` 只用于按钮的禁用态（视觉），**不是**防连点的闸门。 */
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [purging, setPurging] = useState(false);
  /**
   * 防连点的真闸门，必须是 ref 而不是 state。
   *
   * 为什么 state 不够：`ConfirmDialog` 的确认按钮**没有 `disabled`**（本仓不为此改共享组件），
   * 而本页自己那个按钮在对话框打开时被 `fixed inset-0 z-50` 遮罩挡住、根本点不到；
   * 且 `setConfirmOpen(false)` 在 `await` 之后才执行，整个请求期间确认按钮都可点。
   * `setPurging(true)` 要等下一次渲染才生效，快速连点能在它落地前就发出第二个请求
   * （2026-09-20 评审实测：连点 3 次 → 3 个 DELETE）。清理不可恢复，这里用同步 ref 兜住。
   */
  const purgingRef = useRef(false);

  const load = useCallback(() => {
    getExpiredAlertStats()
      .then((res) => {
        setStats(res);
        setError('');
      })
      .catch((err: unknown) => {
        const msg = err instanceof Error ? err.message : '加载失败';
        setStats(null);
        setError(msg);
        toast('error', msg);
      });
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const handlePurge = async () => {
    // 在途请求未回来前，第二次点击直接丢弃（见 `purgingRef` 的注释）
    if (purgingRef.current) return;
    purgingRef.current = true;
    setPurging(true);
    try {
      const res = await purgeExpiredAlerts();
      setConfirmOpen(false);
      toast('success', `已清理 ${res.deleted} 条`);
      load();
    } catch (err) {
      toast('error', err instanceof Error ? err.message : '清理失败');
    } finally {
      purgingRef.current = false;
      setPurging(false);
    }
  };

  const header = (
    <div>
      <h1 className="text-2xl font-black tracking-tight" style={{ color: 'var(--text-primary)' }}>预警数据</h1>
      <p className="text-sm mt-1" style={{ color: 'var(--text-secondary)' }}>
        清理 30 天前的异常预警（含未读）。系统不会自动清理。
      </p>
    </div>
  );

  if (error) {
    return (
      <div className="space-y-6">
        {header}
        <div
          data-testid="alerts-stats-error"
          className="bg-white rounded-2xl border border-dashed border-gray-200 p-10 text-center text-sm"
          style={{ color: 'var(--text-secondary)' }}
        >
          预警数据加载失败，请稍后重试
        </div>
      </div>
    );
  }

  if (stats === null) {
    return (
      <div className="space-y-6">
        {header}
        <div data-testid="alerts-stats-loading" className="bg-white rounded-2xl border border-gray-200 p-5 space-y-3">
          <Skeleton width={120} height={14} />
          <Skeleton width={72} height={32} />
          <Skeleton width="60%" height={12} />
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {header}

      <div data-testid="alerts-stats" className="bg-white rounded-2xl border border-gray-200 p-6">
        <p className="text-sm" style={{ color: 'var(--text-secondary)' }}>
          {`${stats.retentionDays} 天前的预警`}
        </p>
        <p className="text-3xl font-black mt-2" style={{ color: 'var(--text-primary)' }}>
          {stats.total}
        </p>
        <p className="text-sm mt-2" style={{ color: 'var(--text-secondary)' }}>
          {`其中未读 ${stats.unread} 条`}
        </p>
        <p className="text-xs mt-1" style={{ color: 'var(--text-secondary)' }}>
          {`截止时间（此前创建）：${new Date(stats.cutoff).toLocaleString('zh-CN')}`}
        </p>

        <button
          type="button"
          data-testid="alerts-purge-btn"
          disabled={stats.total === 0 || purging}
          onClick={() => setConfirmOpen(true)}
          className="mt-5 px-4 py-2 rounded-lg text-sm font-semibold bg-[var(--brand-500)] text-white hover:opacity-90 transition-opacity disabled:opacity-40 disabled:cursor-not-allowed"
        >
          {`清理 ${stats.retentionDays} 天前的预警`}
        </button>
        {stats.total === 0 && (
          <p className="text-xs mt-2" style={{ color: 'var(--text-secondary)' }}>
            没有可清理的预警
          </p>
        )}
      </div>

      <ConfirmDialog
        open={confirmOpen}
        title="提示："
        message={`确认清理 ${stats.retentionDays} 天前的预警 ${stats.total} 条（其中未读 ${stats.unread} 条）？此操作不可恢复。`}
        onConfirm={handlePurge}
        onCancel={() => setConfirmOpen(false)}
      />
    </div>
  );
}
