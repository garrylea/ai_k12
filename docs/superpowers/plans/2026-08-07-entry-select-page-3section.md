# 入口选择页（EntrySelectPage）三段式改版

## 目标
按用户需求把 `apps/web/src/pages/auth/EntrySelectPage.tsx` 改为三段式：顶栏品牌+用户信息 / 中部双入口大卡 / 底部脚注。视觉语言沿用本项目既定规范（暖底白卡、橘红渐变徽章、线性 SVG、复用 LogoutButton），把用户给的参考代码适配到本仓库约束。

## 确认项
- 主入口标签用「学习」（PRD §6 / style.md §2.7 / 现有代码一致），非「教学」。
- 路由保持真实存在的 `/student/subjects`（学习）、`/student/auxiliary`（答疑）。

## 参考代码的适配（强制偏离，原因如注）
| 参考 | 改为 | 原因 |
|------|------|------|
| 答疑卡用蓝色 `from-blue-600` | ~~两卡同橘红~~ → 答疑卡改用蓝色 `from-[#2563EB] to-[#6366F1]` | 2026-08-07 用户明确要求答疑卡改蓝色以区分辅线；style.md §2.6.2 已同步更新（仅入口页例外，辅线其余配色仍统一橘红） |
| `lucide-react` 图标 | 内联线性 SVG（答疑用 HelpCircleIcon，学习用 BookIcon） | lucide-react 未安装；仓库统一内联 SVG |
| `import { motion } from 'motion/react'` | `framer-motion`（或纯 CSS 过渡） | 仓库依赖是 framer-motion；现有 EntrySelectPage 用纯 CSS 过渡 |
| `bg-brand-primary` 等 | `var(--brand-500)` / 任意值 | tailwind 未配 brand 色，非真实类名 |
| 内联退出按钮 | 复用 `<LogoutButton />` | 已有组件 + 记忆「返回/退出用复用控件」 |
| `useAuthStore` | `localStorage.getItem('username')` | authStore 不存在；SubjectSelectPage/AuxiliaryHomePage 均如此 |
| 装饰性 blur 渐变球 | 去掉 | style.md §1「去除一切装饰元素」 |
| `/student/disciplines` `/student/qa` | `/student/subjects` `/student/auxiliary` | 真实路由 |
| 两卡不同图标 | ~~两卡同 BookIcon~~ -> 答疑用 HelpCircleIcon、学习用 BookIcon | 2026-08-07 用户要求答疑卡蓝色区分；问号圆圈更契合「答疑」语义 |

## 实现细节

### 1. 顶栏 Header
- `flex items-center justify-between`，下边框 `border-b border-slate-200/80` 作分割线（对齐 SubjectSelectPage header 模式）。
- 左：橘红 10% 底圆角徽章（`bg-[var(--brand-100)]`/`rgba(255,107,53,0.1)`）内放白色线性书形 SVG + 标题「K12 智学系统」（`text-[var(--text-primary)]`，font-bold，~18px）。不带副标题（避免冗余文字）。
- 右：用户信息片（品牌橘红圆形头像首字 + 用户名 `localStorage.getItem('username') ?? '同学'`）+ 复用 `<LogoutButton />`。头像首字取用户名 `[0]`。

### 2. 中部 Main
- 两张大卡，`grid grid-cols-1 md:grid-cols-2 gap-8`，居中 `max-w-3xl`。
- 卡片：白底 `rounded-3xl`、`h-64`、`border 1px solid rgba(226,232,240,0.8)`、`--shadow-card`，hover 升 `--shadow-elevated` + `-translate-y-1`，`focus:ring-4 focus:ring-[var(--brand-500)]/20`。
- 徽章：80×80，`rounded-2xl`，`linear-gradient(to top right,#FF6B35,#FF8C61)`，白色 BookIcon，`shadow-sm`。
- 标签：`text-3xl font-black tracking-tight text-[var(--text-primary)]`，「学习」→ `/student/subjects`；「答疑」→ `/student/auxiliary`。
- 入场动效：用 framer-motion 轻量 `opacity/y` stagger（已是依赖，与 StarMapPage 一致），尊重减少动效偏好（用 `useReducedMotion` 守卫，或退化为纯 CSS 过渡——实现时取其一，倾向 CSS 过渡保持与现状一致）。

### 3. 底部 Footer
- 居中小字「K12 智学系统 · 保护心流，助您独立掌控学习进度」，`text-xs text-[var(--text-tertiary)]`（或 `text-slate-400`）。

### 4. 容器
- `data-theme="student-day"`，`min-h-screen flex flex-col items-center justify-between p-6 md:p-10`，`backgroundColor: var(--bg-page)`。不用 `.student-theme-container`（非学习阶段页，物理屏蔽夜间）。

## 文档同步（记忆：变更代码或主文档时同步所有引用文档）
- 更新 `apps/web/style.md` §2.7：补充顶栏（品牌标识 + 用户信息 + 退出）、底部脚注的结构说明，使规范与新实现一致（此前 §2.7 禁用项「不出现冗余标题」需放宽：允许品牌标识与脚注）。

## 不做
- 不装 lucide-react；不引入 authStore；不加装饰渐变球；不改路由；不引入蓝色。
- 不改 SubjectSelectPage / 其他页面（本次仅 EntrySelectPage + style.md §2.7）。

## 验证
- `npm run build`（tsc -b + vite build）类型与构建通过。
- `npm run dev` 本地看入口页三段式布局、双卡同橘红、退出按钮可用、用户名正确显示。
