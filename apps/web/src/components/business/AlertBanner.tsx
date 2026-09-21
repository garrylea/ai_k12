import { useCallback, useEffect, useRef, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { Banner } from '@/components/base';
import { getParentUnreadAlerts, markParentAlertRead, type ParentUnreadAlerts } from '@/services/api';

/**
 * 轮询间隔（spec §3.4）：预警数据源（学生心跳）本身就是 30s 粒度，更快的轮询没有意义。
 * 后台标签页会被浏览器节流到约 1 次/分钟，回前台的下一次轮询立刻补上，可接受。
 */
export const ALERT_POLL_INTERVAL_MS = 30_000;

/**
 * 家长端全局预警 Banner（「及时可见」批，spec §3.4）：
 * 30s 轮询 + 路由切换即刷 → 有未读就挂在所有家长页顶部；**点击即已读**（2026-09-20
 * 用户裁决：点了 banner 查看信息后 banner 消失，不提供「不看不消失」的关闭钮）。
 *
 * 覆盖家长名下**全部孩子**、**全部级别**（含 info 级走神——上一批「info 只进列表页」
 * 的裁决被本批显式推翻）；配色按最新一条的 `level` 映射：warning/critical → danger（红），
 * 其余（info 走神）→ warning（橙）。
 */
export default function AlertBanner() {
  const navigate = useNavigate();
  const location = useLocation();
  const [unread, setUnread] = useState<ParentUnreadAlerts | null>(null);
  const skipNextLoadRef = useRef(false);
  const requestIdRef = useRef(0);

  const load = useCallback(() => {
    const id = ++requestIdRef.current;
    getParentUnreadAlerts()
      .then((data) => {
        if (id !== requestIdRef.current) return;
        setUnread(data);
      })
      .catch(() => {
        /* 轮询失败静默：保持上次值，不打扰 */
      });
  }, []);

  // 挂载即查 + 路由切换即刷（读预警返回后立刻反映「已读完」）
  useEffect(() => {
    if (skipNextLoadRef.current) {
      skipNextLoadRef.current = false;
      return;
    }
    load();
  }, [load, location.pathname]);

  useEffect(() => {
    const timer = setInterval(load, ALERT_POLL_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [load]);

  if (!unread || unread.total === 0 || unread.items.length === 0) return null;

  const latest = unread.items[0];
  const title = unread.total > 1 ? `有 ${unread.total} 条新预警，最新：${latest.message}` : latest.message;
  const type = latest.level === 'warning' || latest.level === 'critical' ? 'danger' : 'warning';

  const handleClick = () => {
    // 点击即已读：乐观清掉 + 跳转；标已读失败静默（下次轮询会再出现，可接受）
    setUnread(null);
    skipNextLoadRef.current = true;
    void Promise.allSettled(unread.items.map((alert) => markParentAlertRead(alert.id)));
    navigate('/parent/alerts');
  };

  return (
    <Banner
      type={type}
      title={title}
      description={`${latest.studentName ?? '孩子'} · 点击查看详情并标记已读`}
      action={
        <button
          type="button"
          onClick={handleClick}
          className="px-4 py-1.5 bg-white text-[var(--error)] rounded-md text-sm font-semibold hover:bg-gray-50 shrink-0"
        >
          立即查看
        </button>
      }
    />
  );
}
