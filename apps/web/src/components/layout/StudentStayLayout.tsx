import { Outlet, NavLink, useLocation, useNavigate } from 'react-router-dom';
import { ExitIcon } from '@/components/base';
import { LockedPillReveal } from '@/kiosk/LockedPillReveal';
import { buildStayReturnState, resolveStayReturn } from '@/utils/stayReturn';

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
 * 顶栏**左侧不再放「返回」**（2026-11-06 用户裁决）：它与右上角「退出本页」落点完全相同，
 * 两个入口重复。离开本页统一走右上角「退出本页」。
 *
 * 顶栏右侧「退出本页」的落点是**进入本页之前的那一页**（来源页协议，见 `@/utils/stayReturn`）——
 * **不是**回退浏览器历史，也**不是**登出（2026-11-04 用户裁决）、**不是**固定回 `/student/entry`：
 * tab 互跳会把兄弟页压进历史栈，学生从星图进来、切过奖励册再切回来，仍要回星图而不是奖励册
 * （2026-09-21 用户实测反馈）。学生从课程详情进来就回课程详情（连它的 `location.state` 一起还回去），
 * 从带 query 的训练页进来也原样带回 query。**三个 tab 同权**：练习记录（含详情）也回最初来源，
 * 不再按层级回个人中心（2026-11-06 用户实测修正）。来源缺失时兜底回星图。
 * 登出仍只在开始页右上角完成（`LogoutButton` 在 `EntrySelectPage` 保留）。
 *
 * 图标用全仓统一的 `ExitIcon`（与 `LogoutButton` 同一个图标，2026-11-06 用户要求）。
 */
const stayItems = [
  { to: '/student/rewards', label: '奖励册' },
  { to: '/student/profile', label: '个人中心' },
  { to: '/student/practice-history', label: '练习记录' },
];

export default function StudentStayLayout() {
  const location = useLocation();
  const navigate = useNavigate();
  // 「退出本页」落点 + 来源页自己的 location.state（课程详情缺 state 会被自己的「缺少课程信息」挡住）
  // 三个 tab 同权：不管当前在奖励册 / 个人中心 / 练习记录（含详情），都回进入浅停留页之前的那一页
  const back = resolveStayReturn(location.state);
  // 两页互跳时把来源原样带过去，否则切一次 tab 来源就丢了
  const carriedReturnState = buildStayReturnState(back.to, back.state);

  return (
    <div
      data-theme="student-day"
      data-school="junior"
      className="flex h-screen flex-col overflow-hidden bg-[var(--bg-base)] text-[var(--text-primary)]"
    >
      {/* 剩余时长浮层：锁定态由上层 `LearningSessionShell` 经 context 下发，
          没有上下文 / 未锁定时它自己渲染 null。三个 tab 是**兄弟路由**，React Router
          在它们之间导航时会**复用**本外壳（同位置、同类型，不会重挂），所以必须用
          `key={location.pathname}` 强制 reveal 重挂 —— 否则它的 `visible` 状态跨 tab
          存活，3 秒自动显示只在第一次进入浅停留区时出现一次。浮层全是 `fixed`，
          DOM 顺序不影响绘制。 */}
      <LockedPillReveal key={location.pathname} />
      {/* 顶部全局栏：学生端统一 token，但无日夜切换 */}
      {/* 三栏网格：左右各 1fr、中间胶囊 auto —— 左「返回」删除后胶囊仍停在原来的正中间，
          不能退回 justify-between（那会让胶囊左移，2026-11-06 用户指出）。 */}
      <header className="h-16 bg-[var(--bg-card)] border-b border-[var(--bg-subtle)] grid grid-cols-[1fr_auto_1fr] items-center gap-4 px-6 shrink-0">
        {/* 占位：与右侧「退出」对称，别删 */}
        <div aria-hidden="true" />

        {/* 两页互跳入口（UX P5.1「入口：奖励册…」），当前页高亮 */}
        <nav className="justify-self-center flex items-center gap-1 bg-[var(--bg-subtle)] rounded-[var(--radius-pill)] p-1">
          {stayItems.map((item) => (
            <NavLink
              key={item.to}
              to={item.to}
              state={carriedReturnState}
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

        {/* 退出本页：回到进入本页之前的那一页（唯一的离开入口），不是登出 */}
        <button
          type="button"
          onClick={() => navigate(back.to, { state: back.state })}
          title="退出本页"
          aria-label="退出本页"
          className="justify-self-end p-2.5 rounded-full bg-[var(--bg-card)] border border-[var(--bg-subtle)] shadow-sm hover:bg-[var(--bg-base)] transition-colors text-[var(--text-secondary)]"
        >
          <ExitIcon />
        </button>
      </header>

      {/* 页面内容：学生端统一的 main 样式 */}
      <main className="flex-1 overflow-y-auto bg-[var(--bg-base)]">
        <Outlet />
      </main>
    </div>
  );
}
