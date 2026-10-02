import { NavLink, Outlet, useNavigate } from 'react-router-dom';
import AlertBanner from '@/components/business/AlertBanner';
import BillingNoticeBar from '@/pages/parent/BillingNoticeBar';
import SubscriptionNoticeBar from '@/pages/parent/SubscriptionNoticeBar';
import { LogoutButton } from '@/components/base';
import MobileStudentSwitcher from './MobileStudentSwitcher';

const TABS = [
  { to: '/m/parent/dashboard', label: '仪表盘', testId: 'tab-dashboard' },
  { to: '/m/parent/alerts', label: '预警', testId: 'tab-alerts' },
  { to: '/m/parent/errors', label: '错题', testId: 'tab-errors' },
  { to: '/m/parent/controls', label: '管控', testId: 'tab-controls' },
  { to: '/m/parent/more', label: '更多', testId: 'tab-more' },
];

/**
 * 家长移动端布局外壳（家长移动 PWA 计划 Task 2；第 5 Tab「预警」为 2026-10-02 用户裁决）：
 * data-theme="parent" 容器 + 顶栏（学生切换器 + 退出登录 + 三条通知条）+ 底部五 Tab 导航（sticky bottom-0）。
 * 通知条复用电脑端同款组件，不另起炉灶。
 * 退出登录挂壳级（对齐 ParentNav/AdminNav 的桌面惯例）：复用统一 LogoutButton
 * （清 token/userId/username/userRole → 跳登录页），移动端没有别的退出入口，勿移除。
 */
export default function MobileParentLayout() {
  const navigate = useNavigate();

  // AlertBanner 是桌面共享组件，点击跳电脑端 /parent/alerts；移动壳内经此容器
  // 在 capture 阶段拦截整体点击，改跳移动端预警页（不改动共享组件本身）。
  const interceptAlertBannerClick = (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    navigate('/m/parent/alerts');
  };

  return (
    <div data-theme="parent" className="flex min-h-screen flex-col bg-[var(--bg-base)]">
      <header className="border-b border-[var(--bg-subtle)] bg-white">
        <div className="flex items-center">
          <div className="min-w-0 flex-1">
            <MobileStudentSwitcher />
          </div>
          <LogoutButton className="!p-2 mr-3 shrink-0" />
        </div>
        <div onClickCapture={interceptAlertBannerClick}>
          <AlertBanner />
        </div>
        <BillingNoticeBar />
        <SubscriptionNoticeBar />
      </header>
      <main className="flex-1 px-4 py-4">
        <Outlet />
      </main>
      <nav aria-label="家长移动端主导航" className="sticky bottom-0 grid grid-cols-5 border-t border-[var(--bg-subtle)] bg-white">
        {TABS.map((t) => (
          <NavLink
            key={t.to}
            to={t.to}
            data-testid={t.testId}
            className={({ isActive }) =>
              `py-3 text-center text-sm ${isActive ? 'font-bold text-[var(--brand-500)]' : 'text-[var(--text-secondary)]'}`
            }
          >
            {t.label}
          </NavLink>
        ))}
      </nav>
    </div>
  );
}
