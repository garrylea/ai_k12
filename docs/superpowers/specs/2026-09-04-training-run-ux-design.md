# 训练轨答题页体验修复设计（专项/考试/错题）

日期：2026-09-04 ｜ 分支：`feat/training-module` ｜ 状态：已与用户对齐

## 背景与问题

训练轨三个答题页（`TargetedRunPage` / `ExamRunPage` / `ErrorPracticeRunPage`）进入答题模块后存在五个体验问题：

1. **顶底留白不足**：run 页外壳 `h-screen flex flex-col` 无任何 padding，`QuestionRunner` embedded 外壳只做水平居中，标题行贴屏幕顶、答题卡贴底。
2. **题面观感又大又挤**：题面 `text-xl` (20px) 是 2026-08-09 commit `444e830` 为课堂练习**弹窗**确认的参数，被共享组件带进全屏页后观感偏大；更严重的根因是题面区 `shrink-0` 不限高，长题干把答题区挤到几乎不可用。
3. **只有「提示」没有「解析」**：无法在作答前/卡住时看详细解析（判题返回的 `analysis` 只在结果列表出现）。
4. **退出逻辑缺失**：专项/错题无任何页内退出入口，浏览器返回键会静默丢进度；考试页设计上无返回，但浏览器返回/刷新也能直接离开且服务端倒计时不暂停。
5. **列表/配置页 `PageHeader` 顶部无留白**：容器只有 `px-4 pb-16` 无 pt，圆形返回按钮贴顶。

## 已确认的决策

| 决策点 | 结论 |
|---|---|
| 题面字号 | 弹窗（课堂练习）维持 `text-xl` 20px；训练轨全屏 embedded 降为 `text-lg` 18px，按 variant 区分 |
| 提示/解析交互 | 渐进式状态机：初始只有「提示」，看过提示后浮现「解析」按钮（提示视觉上更显著——苏格拉底原则） |
| 专项/错题退出 | 可退出 + 确认弹窗（已答 X/Y，未答不保留）；已答部分判题/错题 bump 后端已实时落库 |
| 考试退出 | 保持无页内退出；浏览器返回/刷新拦截 + 确认（计时不停、可续考） |
| 看解析是否惩罚 | MVP 不做惩罚标记，记待办 |

## 1. 留白与题面区（三个 run 页）

- 页面容器：`h-screen flex flex-col` → 加 `p-4 sm:p-6`；内容维持 maxWidth `--learn-card-max-w` (896px) 居中。
- `QuestionRunner` 题面区：`shrink-0` → 加最大高度（约视口 45%）+ 内部 `overflow-auto`；答题区加保底高度（`min-h-[280px]` 左右），长题时答题区始终可用。
- 题面字号按 variant 区分：embedded → `text-lg`；modal → `text-xl`（不改）。

## 2. 列表/配置页顶部留白

`TrainingHomePage` / `ExamListPage` / `ErrorPracticePage` / `TargetedConfigPage` 容器统一加 `pt-6 sm:pt-8`。StarMapPage 为风格基准页，不动。

## 3. 提示→解析渐进式（`QuestionRunner` + 后端新端点）

### 前端（QuestionRunner）

- 每题状态：初始只有「提示」按钮（现有 warning 色圆钮）；提示内容成功展示后（`hints[q.n]` 有值即视为已看过，含跨题缓存回看），下方浮现「解析」按钮——样式更淡（`text-tertiary` 边框线框钮），符合「提示 > 解析」的苏格拉底层级。
- 点解析 → 新增 prop `onRequestExplanation?: (q: RunnerQuestion) => Promise<string>`，在提示抽屉下方渲染解析抽屉（loading/错误态镜像 hint 抽屉实现；错误文案「解析生成失败，请稍后再试」）。
- 解析文本由父层持有（`Record<string, string>`，与 hints 同构），考试不挂（`onRequestExplanation` 不传即不渲染按钮）。

### 后端（training 模块）

新增 `POST /training/explanation`，body `{ questionId: number }` → `{ explanation: string }`，镜像 hint 端点模式：

1. `questionsRepo.findById` → 无题 404；
2. DB `explanation` 字段非空 → 直接返回（省 AI）；
3. 为空 → ai-core `ExplanationCapability.explain`（`knowledge_retry` 模式）生成，MVP **不缓存**（点解析场景罕见；待办：量大后再加缓存表）；
4. AI 失败 → 503 code 5001（镜像 hint 行为）。

### 文档同步（CLAUDE.md API 同步规则）

`docs/api/openapi.yaml` 与 `docs/API接口与数据流设计文档.md` 同步新增该端点（§4 端点清单 + 数据流说明）。

## 4. 退出逻辑

- **专项/错题**：左下角「X」关闭按钮（复用 `QuestionRunner.onClose` 已有渲染位）。`onClose` 签名扩展为 `(answered: number) => void`（answered = runner 内 `resultsRef` 已判题数；现有 AnswerModal 调用方忽略参数，不受影响）。点击后页面级确认弹窗：「已答 X/Y 题，退出后未作答的题目不再保留。确定退出吗？」，确认 → navigate 回配置/列表页。
- **浏览器返回拦截**：三个 run 页统一用 react-router 6.27 `useBlocker` 拦截路由内返回，弹同款确认弹窗；考试页额外挂 `beforeunload` 防刷新误触。实现为共享 hook（如 `useRunExitGuard`）。
- **考试**：无页内退出按钮；拦截文案：「离开后计时不会暂停，可从考试列表续考返回。确认离开？」

## 5. 不做的事（YAGNI）

- 解析查看不惩罚、不标记（结果页本就会展示解析）。
- 不做练习中断续做（需会话持久化，超出本次范围）。
- 课堂练习 AnswerModal 不加解析入口（已有「让 AI 讲一讲」讨论入口，训练轨场景才需要预答解析）。
- ExplanationCapability 结果不缓存。

## 6. 验证

- apps/web：`npm run lint` + `npm run build` + 浏览器走查（长题挤压、留白、按钮状态机、退出确认、返回拦截、考试防刷新）。
- apps/server：`training.service.test.ts` 补 explanation 单测（mock ExplanationCapability，覆盖 404 / DB 命中 / AI 回退三路径）。

## 待办记录

- 解析 AI 生成量大后加缓存（镜像 question_hints 模式）。
- 看过解析再提交是否标记「看过解析」，影响错题清零/掌握度统计——待产品决策。
