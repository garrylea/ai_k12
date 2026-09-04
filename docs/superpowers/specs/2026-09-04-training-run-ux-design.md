# 训练轨答题页体验修复设计（专项/考试/错题）

日期：2026-09-04 ｜ 分支：`feat/training-module` ｜ 状态：已与用户对齐

## 背景与问题

训练轨三个答题页（`TargetedRunPage` / `ExamRunPage` / `ErrorPracticeRunPage`）进入答题模块后存在五个体验问题：

1. **顶底留白不足**：run 页外壳 `h-screen flex flex-col` 无任何 padding，`QuestionRunner` embedded 外壳只做水平居中，标题行贴屏幕顶、答题卡贴底。
2. **题面观感又大又挤**：题面 `text-xl` (20px) 是 2026-08-09 commit `444e830` 为课堂练习**弹窗**确认的参数，被共享组件带进全屏页后观感偏大；更严重的根因是题面区 `shrink-0` 不限高，长题干把答题区挤到几乎不可用。
3. **训练轨只有「提示」没有「讲一讲」**：课堂练习有提示 + AI 讨论两个入口，训练轨只有提示（且两者都不是渐进式——学生可跳过提示直接讨论/看解析）。
4. **退出逻辑缺失**：专项/错题无任何页内退出入口，浏览器返回键会静默丢进度；考试页设计上无返回，但浏览器返回/刷新也能直接离开且服务端倒计时不暂停。
5. **列表/配置页 `PageHeader` 顶部无留白**：容器只有 `px-4 pb-16` 无 pt，圆形返回按钮贴顶。

## 已确认的决策

| 决策点 | 结论 |
|---|---|
| 题面字号 | 弹窗（课堂练习）维持 `text-xl` 20px；训练轨全屏 embedded 降为 `text-lg` 18px，按 variant 区分 |
| 提示/讲一讲交互 | 渐进式状态机：初始只有「提示」，看过提示后浮现「讲一讲」按钮（提示视觉上更显著——苏格拉底原则）；**课堂练习与训练轨全端统一** |
| 专项/错题退出 | 可退出 + 确认弹窗（已答 X/Y，未答不保留）；已答部分判题/错题 bump 后端已实时落库 |
| 考试退出 | 保持无页内退出；浏览器返回/刷新拦截 + 确认（计时不停、可续考） |
| 「讲一讲」实现 | 不新增后端接口/不改 ai-core：训练轨走既有辅线辅导链路（`createConversation({track:'auxiliary'})` + `/ai/tutor/stream` mode auxiliary）；原计划的「解析」按钮方案废弃（用户决策：不是看答案式解析，而是苏格拉底讨论） |

## 1. 留白与题面区（三个 run 页）

- 页面容器：`h-screen flex flex-col` → 加 `p-4 sm:p-6`；内容维持 maxWidth `--learn-card-max-w` (896px) 居中。
- `QuestionRunner` 题面区：`shrink-0` → 加最大高度（约视口 45%）+ 内部 `overflow-auto`；答题区加保底高度（`min-h-[280px]` 左右），长题时答题区始终可用。
- 题面字号按 variant 区分：embedded → `text-lg`；modal → `text-xl`（不改）。

## 2. 列表/配置页顶部留白

`TrainingHomePage` / `ExamListPage` / `ErrorPracticePage` / `TargetedConfigPage` 容器统一加 `pt-6 sm:pt-8`。StarMapPage 为风格基准页，不动。

## 3. 提示→讲一讲 渐进式（全端统一，后端零改动）

### 交互（QuestionRunner）

- 每题状态：初始只有「提示」按钮（现有 warning 色圆钮）；提示内容成功展示后（`hints[q.n]` 有值即视为已看过，含缓存回看），浮现「讲一讲」按钮（现有 info 色聊天气泡圆钮，样式取自 AnswerModal）——体现「提示 > 讲一讲」的苏格拉底引导层级。
- 实现为 `QuestionRunner` 内对 `headerActions` 插槽的 gate：`enableHint` 开启时，`headerActions` 仅在 `hints[q.n]` 有值后渲染。课堂练习（AnswerModal 已传 headerActions=讲一讲）自动获得同一行为，全端统一，无需改 AnswerModal 的按钮代码。
- 考试不挂提示/讲一讲（现状不变）。

### 训练轨「讲一讲」实现（复用既有辅线辅导链路，无新端点）

不复用 `/practice/discuss`：它必填 `cardId`+`lessonId`、打开即写主线错题本（会污染主线错题清零门禁）、对话上下文靠 cardId 解析——训练轨三者皆无。改走 AuxiliaryHomePage 同款链路：

1. `useDiscussChat` 新增 `training` 模式：首次打开 `createConversation({ track: 'auxiliary' })` 拿 dialogueId（session 级缓存，键 `training-q:${questionText}`）；后续消息走 `streamTutorEvents({ mode: 'auxiliary', dialogueId, message })`。
2. 每条用户消息前缀题面（镜像既有题目级模式 `这道题目是：\n\n{题面}\n\n我的问题：…`），AI 始终有上下文，无需种子消息。
3. `DiscussDrawer` props 联合类型新增 `training` 变体（`questionText` + `onClose`），宽度/标题对齐题目级模式。

### 对 API 文档的影响

无接口变更，openapi.yaml / API 设计文档不需要同步。

## 4. 退出逻辑

- **专项/错题**：左下角「X」关闭按钮（复用 `QuestionRunner.onClose` 已有渲染位）。`onClose` 签名扩展为 `(answered: number) => void`（answered = runner 内 `resultsRef` 已判题数；现有 AnswerModal 调用方忽略参数，不受影响）。点击后页面级确认弹窗：「已答 X/Y 题，退出后未作答的题目不再保留。确定退出吗？」，确认 → navigate 回配置/列表页。
- **浏览器返回拦截**：三个 run 页统一用 react-router 6.27 `useBlocker` 拦截路由内返回，弹同款确认弹窗；考试页额外挂 `beforeunload` 防刷新误触。实现为共享 hook（如 `useRunExitGuard`）。
- **考试**：无页内退出按钮；拦截文案：「离开后计时不会暂停，可从考试列表续考返回。确认离开？」

## 5. 不做的事（YAGNI）

- 不新增后端接口、不改 ai-core（讲一讲走既有辅线辅导链路）。
- 不做练习中断续做（需会话持久化，超出本次范围）。
- 讲一讲讨论不记错题本（训练轨错题由 judge 实时落库，讨论≠答错）。
- 看过讲一讲/提示再提交不做惩罚标记。

## 6. 验证

- apps/web：`npm run lint` + `npm run build` + 浏览器走查（长题挤压、留白、提示→讲一讲渐进式（课堂练习 + 训练轨两处）、退出确认、返回拦截、考试防刷新）。
- apps/server：无改动，`npm test` 回归确认全绿即可。

## 待办记录

- 训练轨讨论跨刷新不续接（dialogueId 为 session 级缓存）；将来可平移主线 B 方案（错题本 dialogue_id 锚定 find-or-create 续接）。
- 辅线对话列表会累积训练讨论会话（auxiliary 对话本就统一管理，属正常）。
