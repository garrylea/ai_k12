# K12 智学系统 - UX/UI 工程

本目录用于实现 K12 智学系统的 UX/UI 设计稿与可交互原型。

## 📚 核心文档导航

在开始任何设计/编码任务前，必须先阅读以下三份基准文档：

- **[K12智学系统-产品需求文档.md](../../docs/K12智学系统-产品需求文档.md)** —— 产品需求基准（PRD）
  - §6 双轨学习场景（主线闯关 + 辅线探索）
  - §7 核心功能（AI 辅导、错题清零、奖励、家长端、§7.11 日夜护眼）
  - §8 输入交互 / §13 MVP 范围 / §14 风险与决策

- **[UX-UI设计文档.md](../../docs/UX-UI设计文档.md)** —— UI/UX 实现基准
  - §2 设计系统（颜色/字体/间距）
  - §5 页面清单（P1-P6 共 30 页页面规范）
  - §7 响应式适配 / §8 护眼与可访问性 / §9.3 PRD 对照清单

- **[style.md](./style.md)** —— **配色与风格唯一基准（必读）**
  - §2 统一一套配色（学生端橘红暖色 / 夜间暗茶金 / 家长端商务白蓝）
  - §3 字体与字号（学段差异仅体现在字号）
  - §4 间距/圆角/阴影统一规范
  - §7 章节星链图设计规范（大/中/小星球）
  - §8 学科选择页设计规范
  - §11 实施清单（每页开发前对照）

## 🚫 禁用规则（强制）

1. **严禁使用 emoji**：所有页面、组件、文案中禁止出现任何 emoji（包括但不限于 🚀📚🎯✨等）。图标使用线性 SVG。
2. **严禁使用吉祥物**：不出现"悟悟"或任何拟人化形象。
3. **严禁装饰性元素**：不使用彩虹、气球、星星等点缀。
4. **统一一套配色**：不再为小学/初中/高中设计三套配色。所有页面采用 style.md §2 定义的统一配色。学段差异仅通过字号微调体现。
5. **所有页面实现必须采用 style.md 中的配色与风格**。

## 🎯 关键约束

1. **护眼优先级最高**：夜间模式仅作用于 `student-theme-container` 沉浸层；登录/选科/星图/家长端等"浅停留"页面物理屏蔽夜间模式。
2. **首发学段范围**：MVP 仅数学，但页面框架需预留全学科扩展位。
3. **平板优先**：iPad 横屏 ≥1024px 为首发主力断点；PC App ≥1280px；手机端后续迭代。
4. **苏格拉底原则**：UI 上「提示」「讨论」按钮永远比「查看答案」更显眼。
5. **双轨视觉区隔**：主线橘红（#E55A2B） / 辅线紫（#8B5A8E），错题本、导航、Tag 必须明显区分。

## 🧭 核心流程（MVP）

```
登录 P1.1
  │  （按用户名格式自动判别：手机号 → 家长端；其他 → 学生端）
  ▼
学科选择 P1.5
  │  （语/数/英三科；MVP 仅数学可选，其余锁定）
  ▼
章节星链图 P2.1
  │  （本学期数学章节以星链展示，重要章节大星球，普通中星球，次要小星球）
  │  （点击章节星球 → 下方展开该章所有小节卡片）
  ▼
小节学习 → 卡片阅读 → AI 讨论 → 课后作业 → 错题清零 → 解锁下一节
```

## 🏗️ 技术栈

- **构建**：Vite 5 + TypeScript 5 + React 18
- **样式**：Tailwind CSS 3 + CSS Variables（多主题落地核心）
- **路由**：React Router 6（createBrowserRouter）
- **状态**：Zustand 5
- **动效**：Framer Motion 11
- **公式**：KaTeX 0.16

## 📁 目录结构

```
src/
├── App.tsx, main.tsx, vite-env.d.ts
├── routes/index.tsx          # 路由表
├── store/themeStore.ts       # 主题/夜间模式 store
├── styles/global.css         # CSS Variables 三套主题落地
├── tokens/                   # 设计 Token JSON 源
├── types/                    # 业务类型
├── components/
│   ├── base/                 # Button/Input/Tag/Card/Modal/Toast/Banner/Progress/Skeleton
│   ├── business/             # TextbookCard/AIDialogue/QuestionCard/ErrorBookCard/PlanetNode/SectionCard/RewardCard
│   └── layout/               # StudentLayout/ParentLayout/StudentNav/ParentNav
└── pages/                    # auth / student / parent 三大子模块
```

## 🎨 主题切换实现

`data-theme` 在容器上挂载：
- `student-day`：学生日间（橘红暖色）
- `student-night`：学生夜间（暗茶金，18:00-06:00 自动）
- `parent`：家长端（商务白蓝，强制日间）

学生学习沉浸层包裹 `.student-theme-container` 类。非沉浸层直接写死 `data-theme`。

## ⌨️ 常用命令

```bash
npm run dev      # 开发服务器（http://localhost:5173）
npm run build    # 类型检查 + 生产构建
npm run preview  # 预览生产构建
```

## 🧭 工作流

1. 阅读三份基准文档对应章节（PRD / UX-UI 设计文档 / style.md）。
2. 与用户确认 ToDo List 后再开始编码。
3. 任何与 PRD / style.md 冲突的设计决策需先与用户对齐。
4. 完成阶段性交付后，按 style.md §11 实施清单与 UX-UI 设计文档 §9.3 进行对照走查。
