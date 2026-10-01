import { NavLink, Outlet } from 'react-router-dom';
import AlertBanner from '@/components/business/AlertBanner';
import BillingNoticeBar from '@/pages/parent/BillingNoticeBar';
import SubscriptionNoticeBar from '@/pages/parent/SubscriptionNoticeBar';
import MobileStudentSwitcher from './MobileStudentSwitcher';

const TABS = [
  { to: '/m/parent/dashboard', label: '仪表盘', testId: 'tab-dashboard' },
  { to: '/m/parent/errors', label: '错题', testId: 'tab-errors' },
  { to: '/m/parent/controls', label: '管控', testId: 'tab-controls' },
  { to: '/m/parent/more', label: '更多', testId: 'tab-more' },
];

/**
 * 家长移动端布局外壳（家长移动 PWA 计划 Task 2）：data-theme="parent" 容器 +
 * 顶栏（学生切换器占位 + 三条通知条）+ 底部四 Tab 导航（sticky bottom-0）。
 * 通知条复用电脑端同款组件，不另起炉灶。
 */
export default function MobileParentLayout() {
  return (
    <div data-theme="parent" className="flex min-h-screen flex-col bg-[var(--bg-base)]">
      <header className="border-b border-black/5 bg-white">
        <MobileStudentSwitcher />
        <AlertBanner />
        <BillingNoticeBar />
        <SubscriptionNoticeBar />
      </header>
      <main className="flex-1 px-4 py-4">
        <Outlet />
      </main>
      <nav aria-label="家长移动端主导航" className="sticky bottom-0 grid grid-cols-4 border-t border-black/5 bg-white">
        {TABS.map((t) => (
          <NavLink
            key={t.to}
            to={t.to}
            data-testid={t.testId}
            className={({ isActive }) =>
              `py-3 text-center text-sm ${isActive ? 'font-bold text-[var(--brand-500)]' : 'text-black/60'}`
            }
          >
            {t.label}
          </NavLink>
        ))}
      </nav>
    </div>
  );
}
