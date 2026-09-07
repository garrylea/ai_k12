# 训练模块主题统一日间 设计

日期：2026-09-05
状态：待用户复审
范围：`apps/web` 训练模块（`/student/training/*`）

## 背景与目标

用户要求把 `/student/training/home` 入口下的三个模块【专项训练】【考试】【错题练习】及其所有子页面的颜色统一为日间模式（`student-day`），不再随时间自动切到夜间。教学模块和答疑系统保持现状不动。

## 现状

- 主题机制：`data-theme` 属性 + `.student-theme-container` 类作为变量作用域容器；CSS 变量定义在 `apps/web/src/styles/global.css`（`:root, [data-theme='student-day']` 默认，`[data-theme='student-night']` 覆盖）。`themeStore.autoToggleNightMode()` 在 18:00–06:00 把 `mode` 切到 `student-night`。
- 训练模块路由全部独立于 `StudentLayout`，物理隔离；8 个子页面外壳写 `data-theme={mode}` 并调用 `autoToggleNightMode` + 每分钟轮询。`TrainingHomePage` 和 `TrainingSubjectPage` 已固定 `student-day`。
- 训练页面**无**手动日夜切换按钮。

## 受影响页面清单

| 路由 | 组件文件 | 改动 |
|---|---|---|
| `/student/training` | `pages/student/TrainingSubjectPage.tsx` | 无（已固定 day） |
| `/student/training/home` | `pages/student/training/TrainingHomePage.tsx` | 无（已固定 day） |
| `/student/training/targeted` | `pages/student/training/TargetedConfigPage.tsx` | 是 |
| `/student/training/targeted/run` | `pages/student/training/TargetedRunPage.tsx` | 是 |
| `/student/training/targeted/hidden` | `pages/student/training/HiddenQuestionsPage.tsx` | 是 |
| `/student/training/exam` | `pages/student/training/ExamListPage.tsx` | 是 |
| `/student/training/exam/run/:sessionId` | `pages/student/training/ExamRunPage.tsx` | 是 |
| `/student/training/exam/result/:sessionId` | `pages/student/training/ExamResultPage.tsx` | 是 |
| `/student/training/errors` | `pages/student/training/ErrorPracticePage.tsx` | 是 |
| `/student/training/errors/run` | `pages/student/training/ErrorPracticeRunPage.tsx` | 是 |

## 共享答题组件的影响分析（关键）

被训练和教学（`CourseDetailPage`）同时使用的组件：`QuestionRunner` / `AnswerResultList` / `DiscussDrawer` / `AnswerModal` / `CleanupPhase`，以及传递依赖 `ChoiceOptionList` / `LatexEditor` / `PreviewDraftPanel` / `DraftWhiteboard` / `LatexPreview` / `SymbolPalette` / `DiscussChat`。

**关键结论**：这些共享组件**全部没有硬编码** `data-theme` / `student-day` / `student-night` / `student-theme-container`，内部统一用 `var(--xxx)` CSS 变量。它们完全依赖外层容器的 `data-theme` 注入变量值。

→ **共享组件一行都不用动**。教学页 `CourseDetailPage` 保留 `data-theme={mode}`（夜间时 `student-night` 注入教学子树）；训练页外壳固定 `data-theme="student-day"`（日间 token 注入训练子树）。同一组件，不同 token 上下文，互不干扰。

## 不受影响范围

- **教学模块**：`CourseDetailPage` 自带 `student-theme-container` + `data-theme={mode}` + 日夜切换按钮，独立于训练，不动。
- **答疑系统**：`AuxiliaryLayout.tsx:12` 和 `ConversationManagePage.tsx:143` 已写死 `data-theme="student-day"`，与训练模块无耦合，不动。
- **星图**：`StarMapPage` 无 wrapper 也无 themeStore 引用，恒为 `:root` day，不动。
- **共享答题组件**：见上，不动。

## 方案（采纳 A）

对 8 个训练页面文件，每个做如下机械改动：
1. 删除 `import { useThemeStore } from '@/store/themeStore';`
2. 删除 `const { mode, autoToggleNightMode } = useThemeStore();` 解构
3. 删除调用 `autoToggleNightMode()` + `setInterval(autoToggleNightMode, 60000)` 的 `useEffect`（连同 import `useEffect` 若不再用）
4. 把外壳 `<div className="student-theme-container" data-theme={mode} ...>` 中的 `data-theme={mode}` 改为 `data-theme="student-day"`
5. 保留 `.student-theme-container` className（变量作用域容器，背景/过渡样式仍需要）
6. 若文件还有其它 `mode` 引用（极少），一并清理

## style.md 约束写入

在 `apps/web/style.md` §2（配色）下新增 §2.7「训练模块主题统一约束」，内容要点：
- `/student/training/*` 下全部页面（专项训练 / 考试 / 错题练习及其子页）固定 `student-day`，不分日夜
- 实现方式：页面外壳写死 `data-theme="student-day"`，**不**调用 `useThemeStore` / `autoToggleNightMode`
- 共享答题组件（`QuestionRunner` / `AnswerResultList` / `DiscussDrawer` / `AnswerModal` / `CleanupPhase` 等）通过 `var(--xxx)` 与外层 `data-theme` 解耦，禁止在共享组件内硬编码主题 class/attr
- 与教学模块（`CourseDetailPage` 保留日夜）和答疑系统（已固定 day）的边界规则

## 验证

- `npm run lint` 通过
- 本地 `npm run dev` 后，手动访问 8 个训练页面在 18:00–06:00 时段仍为日间样式
- 教学模块 `CourseDetailPage` 在夜间仍正常切夜
- 答疑 `/student/auxiliary/*` 不变

## 非目标

- 不重构 `themeStore`（`autoToggleNightMode` 仍保留，供教学模块使用）
- 不动 `global.css` 三套主题变量
- 不改共享答题组件
- 不引入新的主题锁类（如 `.training-theme-lock`）——YAGNI
