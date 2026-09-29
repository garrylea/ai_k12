import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { getSubscriptionStatus, type SubscriptionStatusView } from '@/services/api';
import { clearAuth } from '@/utils/auth';
import { releaseOnLogout } from '@/kiosk/desktopBridge';

/**
 * 学生端订阅锁定页 `/student/locked`（批③ Task 2）。
 *
 * 全屏独立页，不进任何 Layout（与训练轨同口径）；登出走统一收尾
 * `releaseOnLogout()`（学习会话结束 + 解 kiosk 壳锁定）+ `clearAuth()`
 * （与 `LogoutButton` / `RequireRole` 同一套键：token/userId/username/userRole）。
 * 不带学习时长锁定闸门：订阅已失效，不能把学生困在本页。
 */
export default function StudentLockedPage() {
  const navigate = useNavigate();
  const [data, setData] = useState<SubscriptionStatusView | null>(null);
  useEffect(() => {
    getSubscriptionStatus()
      .then(setData)
      .catch(() => setData(null));
  }, []);

  const statusText =
    data?.status === 'trialing'
      ? '试用已结束'
      : data?.status === 'expired'
        ? '订阅已过期'
        : '本账号未订阅';

  return (
    <div className="student-theme-container min-h-screen" data-theme="student-day">
      <div className="mx-auto flex min-h-screen max-w-md flex-col items-center justify-center gap-4 px-6 text-center">
        <h1 className="text-2xl font-black text-[var(--text-primary)]">{statusText}</h1>
        <p className="text-sm text-[var(--text-secondary)]">
          学习功能需要有效订阅，请联系家长在家长端订阅或续费。
        </p>
        {data?.currentPeriodEnd && (
          <p className="text-xs text-[var(--text-secondary)]">
            到期时间：{data.currentPeriodEnd.slice(0, 10)}
          </p>
        )}
        <button
          type="button"
          className="rounded-[var(--radius-pill)] bg-[var(--brand-600)] px-6 py-2 text-sm font-semibold text-white"
          onClick={() => {
            releaseOnLogout();
            clearAuth();
            navigate('/login');
          }}
        >
          返回登录
        </button>
      </div>
    </div>
  );
}
