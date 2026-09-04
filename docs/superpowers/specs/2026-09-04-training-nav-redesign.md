# 训练轨导航重构：选学科 → 三卡页（专项/考试/错题）— 设计

日期：2026-09-04
状态：已批准（用户确认三卡页形态 + 错题卡显示未清零数 + 卡片顺序专项/考试/错题）

## 背景与问题

训练轨现状交互缺陷（探索确认，feat/training-module 联调阶段发现）：

1. 选完学科（数学）直接落地**专项配置页**（TrainingSubjectPage.tsx L38 直接 navigate `/student/training/targeted`），考试唯一入口藏在专项页顶栏右上角（TargetedConfigPage.tsx L192-197，全仓库唯一指向 `/student/training/exam` 的链接）——必须先进专项才能考试；
2. **错题练习完全没有 UI 入口**：`/student/training/errors` 无任何入站链接，只能手输 URL 到达。

PRD §6.3 中三类训练（错题练习/专项练习/真题考试）为**并列**关系，现实现把专项当默认落地页是走样。

## 设计决策（用户确认）

| 决策点 | 选择 |
|---|---|
| 三选一形态 | **独立三卡页**（复刻 style.md §2.7 入口选择页语言），非 Tab 单页 |
| 错题卡片 | **显示未清零错题数**（实时拉 error-book API）；0 题显示「暂无未清零错题」仍可点击 |
| 卡片顺序 | 专项 / 考试 / 错题 |
| 学科上下文 | 沿用共享常量 `MATH_SUBJECT_ID`，不做路由参数化（MVP 仅数学，多学科时再引） |
| 服务端 | **零改动**（纯前端导航层） |

## 路由结构（只加一条）

| 路由 | 组件 | 变化 |
|---|---|---|
| `/student/training` | TrainingSubjectPage（选学科） | 选「数学」后改跳三卡页 |
| `/student/training/home` | **TrainingHomePage（新建）** | 三卡选择页 |
| 其余 7 条训练子路由 | 现有页面 | 路由不动，只改页内导航目标 |

## 三卡页规范（复用 §2.7 语言）

- **顶栏**：`BackButton to="/student/training"` + 标题「数学 · 训练」。
- **三卡**：`grid grid-cols-1 md:grid-cols-3 gap-6` 独立白卡漂浮暖底（圆角 24px、`--shadow-card`、hover `--shadow-elevated` + `hover:-translate-y-1`）。
- **徽章**：三卡统一橘红渐变 `from-[#FF6B35] to-[#FFB25A]`（训练入口同款）+ 白色线性 SVG 图标，靠图标与文字标签区分（单一色板硬规则）：
  - 专项练习：靶心图标 → `/student/training/targeted`
  - 考试：试卷图标 → `/student/training/exam`
  - 错题练习：循环箭头图标 → `/student/training/errors`
- **错题数徽标**：mount 时 `getTrainingErrorBook(MATH_SUBJECT_ID)` 取数组长度；载入中/失败显示「--」不阻塞；0 显示「暂无未清零错题」。
- 无 emoji、无吉祥物、无冗余副标题（§2.7 规则）。

## 改动清单

1. 新建 `apps/web/src/pages/student/training/TrainingHomePage.tsx`；
2. `TrainingSubjectPage.tsx`：跳转目标 `targeted` → `home`，更新注释；
3. `TargetedConfigPage.tsx`：删除顶栏「考试」链接；BackButton → `/student/training/home`；
4. `ErrorPracticePage.tsx` / `ExamListPage.tsx`：BackButton → `/student/training/home`；
5. `apps/web/src/routes/index.tsx` 注册 `/student/training/home`；
6. 文档同步：PRD §6.3 实现状态注记、style.md 新增训练三卡页小节。

## 验证

- `npm run lint` + `npm run build`；
- 路由走查（a11y 文字断言）：`/student/training` 选数学 → 落地 `/student/training/home` → 三卡分别可达 targeted/exam/errors → 各功能页返回回三卡页；
- curl 验证错题数与 `/api/training/error-book?subjectId=1` 数组长度一致；
- 回归：run 页空题单踢回、考试续考、错题清零链路不受影响。
