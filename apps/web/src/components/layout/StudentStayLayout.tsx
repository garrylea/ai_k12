import { Outlet, NavLink } from 'react-router-dom';
import { BackButton, LogoutButton } from '@/components/base';

/**
 * 浅停留页外壳 —— 个人中心（P5.1）与奖励册（P5.2）专用。
 *
 * **为什么单独有这个外壳（别再把它并进任何跟随主题的外壳）**
 *
 * `docs/UX-UI设计文档.md` §1.5（第 58/59 行）按主题行为把学生页分成两类：
 * - 第 58 行「启用日夜切换」：课程详情、AI 讨论、课后作业、单元检测、成绩报告、
 *   辅轨答疑等学习沉浸页 —— 包 `.student-theme-container`，跟随 18:00–06:00
 *   自动切夜、并允许手动切换。
 * - 第 59 行「禁用夜间切换」：登录、注册、学科选择、入口选择页、章节星链图、
 *   **个人中心、奖励册**、设置 —— **直接写死 `data-theme="student-day"`**，
 *   不使用 `.student-theme-container`。
 *
 * 个人中心/奖励册原先挂在主轨侧栏外壳 `StudentLayout` 下（该外壳与 `StudentNav`
 * 已于 2026-09-20 删除）：那个外壳会读 `themeStore.mode` 自动切夜、顶栏还挂
 * 「日间/夜间」手动胶囊，**直接违反第 59 行**。它们是「浅停留页」（看一眼积分/奖励
 * 就走，不是沉浸学习），也不该出现主轨侧栏那套导航。所以拆出本外壳：写死日间、
 * 不带 `themeStore`、不带任何日夜切换 UI。
 *
 * 顶栏沿用学生端**同一套 CSS 变量 token 与视觉风格**（`bg-[var(--bg-card)]` +
 * `border-[var(--bg-subtle)]` + `--radius-pill` 胶囊），但不复用任何布局组件 ——
 * 复用就意味着又要处理主题分支。
 *
 * 顶栏「返回上一页」（`BackButton` 默认模式）是学生从这两页离开的出口：按用户裁决
 * 不走「返回星图」定死路径，而是回退一页（从哪来回哪去，从奖励册/个人中心互相跳转时
 * 也符合直觉）。
 */
const stayItems = [
  { to: '/student/rewards', label: '奖励册' },
  { to: '/student/profile', label: '个人中心' },
];

export default function StudentStayLayout() {
  return (
    <div
      data-theme="student-day"
      data-school="junior"
      className="flex h-screen flex-col overflow-hidden bg-[var(--bg-base)] text-[var(--text-primary)]"
    >
      {/* 顶部全局栏：学生端统一 token，但无日夜切换 */}
      <header className="h-16 bg-[var(--bg-card)] border-b border-[var(--bg-subtle)] flex items-center justify-between gap-4 px-6 shrink-0">
        {/* 统一返回控件：不传 to → 返回上一页（BackButton 默认模式） */}
        <BackButton />

        {/* 两页互跳入口（UX P5.1「入口：奖励册…」），当前页高亮 */}
        <nav className="flex items-center gap-1 bg-[var(--bg-subtle)] rounded-[var(--radius-pill)] p-1">
          {stayItems.map((item) => (
            <NavLink
              key={item.to}
              to={item.to}
              className={({ isActive }) =>
                `px-3 py-1 text-xs rounded-[var(--radius-pill)] transition-all ${
                  isActive
                    ? 'bg-[var(--brand-500)] text-white'
                    : 'text-[var(--text-tertiary)] hover:text-[var(--text-primary)]'
                }`
              }
            >
              {item.label}
            </NavLink>
          ))}
        </nav>

        <LogoutButton />
      </header>

      {/* 页面内容：学生端统一的 main 样式 */}
      <main className="flex-1 overflow-y-auto bg-[var(--bg-base)]">
        <Outlet />
      </main>
    </div>
  );
}
