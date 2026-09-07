# 训练轨草稿抽屉设计（专项/考试/错题）

日期：2026-09-07 ｜ 分支：`feat/training-draft-drawer` ｜ 状态：已与用户对齐

## 背景与目标

训练轨三个答题页（`TargetedRunPage` / `ExamRunPage` / `ErrorPracticeRunPage`）当前只在「计算答题窗口」（`QuestionRunner` 内嵌的 `PreviewDraftPanel`）里有草稿手绘功能，且该草稿是 fit-to-viewport、不可滚动。用户希望：

1. 三个答题页**右上角**新增一个草稿图标入口（页面级，始终可见，区别于「讲一讲」的题面右侧按钮）。
2. 点击后以**右侧抽屉**形式展开，可在抽屉里手绘。
3. 功能与「计算答题窗口」内嵌草稿**一模一样**：手写笔 / 橡皮 / 清空 三按钮。
4. 抽屉内画布**纵向可滚动**（上下滚，左右不滚）。
5. 抽屉**可手动关闭**（X 按钮）+ **两档宽度预设**切换。
6. 草稿与同题内嵌草稿**双向可见**（同一题的笔迹）。

## 已确认的决策

| 决策点 | 结论 |
|---|---|
| 抽屉渲染位置 | 方案 A：抽屉作为 `QuestionRunner` 的兄弟节点（与现有 `DiscussDrawer` 在训练轨的渲染模式一致），由页容器的 `relative` 锚定 |
| 当前题传递 | `QuestionRunner` 新增可选回调 `onQuestionChange?: (q: RunnerQuestion, idx: number) => void`；父页用 state 追踪当前题并传给抽屉 |
| 画布滚动 | 改造 `DraftWhiteboard` 支持 `scrollMode?: 'fit' \| 'scroll-y'`（默认 `'fit'`，向后兼容）；抽屉启用 `'scroll-y'`，内嵌草稿维持 `'fit'` 不变 |
| 宽度调整 | 两档预设（`w-[45%]` ↔ `w-[70%]`），点按切换，与 `DiscussDrawer` `card` 模式一致；不引入拖拽连续调宽 |
| 草稿持久化 | 复用 `draft-store.ts`（`Map<questionId, Stroke[]>`），抽屉与内嵌草稿共用同一 `questionId` 键（`${draftKeyPrefix}-${q.n}`），双向可见 |
| 跟随当前题 | 抽屉的 `questionId` 跟随当前题切换（非"打开时锚定"）。`DraftWhiteboard` 既有 `useEffect([questionId])` 自动重载该题笔迹，切题不丢草稿 |

## 1. 组件改造

### 1.1 `DraftWhiteboard` —— 新增 `scrollMode` prop

**文件**：`apps/web/src/components/business/DraftWhiteboard.tsx`

当前签名：
```tsx
export function DraftWhiteboard({ questionId }: { questionId: string })
```

改为：
```tsx
export function DraftWhiteboard({
  questionId,
  scrollMode = 'fit',
}: {
  questionId: string;
  scrollMode?: 'fit' | 'scroll-y';
})
```

**`'fit'` 模式（现有行为，不动）**：
- wrap div（`wrapRef`）：`flex-1 min-h-0 relative`。
- canvas：`absolute inset-0 w-full h-full`。
- `ResizeObserver`：canvas 尺寸 = wrap 的 clientWidth × clientHeight × DPR。

**`'scroll-y'` 模式（新增）**：
- wrap div：`flex-1 min-h-0 overflow-y-auto overflow-x-hidden`（纵向滚动条出现条件：内容高于容器）。
- canvas 外层包一个固定高度的"画板"div（高度 = 容器高 × 1.6，宽度 = 容器宽），canvas 仍 `absolute inset-0 w-full h-full` 贴合该画板。
- `ResizeObserver` 监听 wrap 容器（滚动区）尺寸变化：重算画板宽（= 容器宽）+ 画板高（= 容器高 × 1.6），同步 canvas 像素尺寸 + DPR transform + 重绘。
- **滚动后坐标正确性**：`pointFromEvent` 现有实现用 `e.currentTarget.getBoundingClientRect()`，滚动后 canvas 的 `rect.top` 随滚动位移变化，`e.clientY - rect.top` 自动得到 canvas 内坐标。无需改 `pointFromEvent`。
- 笔迹存储坐标系不变：仍是 canvas 像素空间（DPR-aware），滚动只是改视口，不影响存储。
- 工具条（手写笔 / 橪皮 / 清空）结构与样式完全不变。

**关键不变量**：
- `draft-store` 的 `questionId` 键在 `'fit'` 与 `'scroll-y'` 间**通用**——同一题在抽屉（scroll-y）画了几笔，切回内嵌草稿（fit）能看到同样笔迹，反之亦然。
  - 注意：`'fit'` 模式 canvas 高度随容器自适应，`'scroll-y'` 模式画板高度 = 容器高 × 1.6。若学生在抽屉里画到画板下半部分（超出内嵌草稿可视区），切回内嵌草稿时这些笔迹仍存在但可能落在视口外（看不见但不丢）。这是可接受行为——学生回到抽屉即可看到全图。
- 主题切换（日/夜）笔迹颜色自适应：`redraw` 读 `--text-primary` CSS 变量，两模式一致。

### 1.2 新组件 `DraftDrawer.tsx`

**文件**：`apps/web/src/components/business/DraftDrawer.tsx`（新建）

参考 `DiscussDrawer.tsx` 结构（不含 chat 相关），导出两个符号：

```tsx
export function DraftDrawer({
  questionId,
  onClose,
}: {
  questionId: string;   // 父层拼好的完整键（含 draftKeyPrefix），与内嵌草稿同键
  onClose: () => void;
})

export function DraftIconButton({ onClick }: { onClick: () => void })
```

**questionId 传递**：父页（run 页）持有 `currentQ: RunnerQuestion | null` 与本地 `draftKeyPrefix` 常量（即传给 `QuestionRunner` 的那个），渲染抽屉时传 `questionId={\`${draftKeyPrefix}-${currentQ.n}\`}`，与 `QuestionRunner` 内部 `PreviewDraftPanel` 用的键完全一致（见 `QuestionRunner.tsx:335-341`）。

**抽屉外壳**（与 `DiscussDrawer` 同款样式）：
- 根 div：`absolute top-0 right-0 bottom-0 flex flex-col bg-[var(--learn-card-bg)] border-l border-[var(--bg-subtle)] transition-[width] duration-200 ${widthClass}`，`style={{ boxShadow: 'var(--shadow-drawer)' }}`，`role="dialog"` `aria-label="草稿"`。
- 父级需 `relative` 定位容器（三个 run 页已满足，见 §3）。
- 仅手动关闭，不点外部收起（与 `DiscussDrawer` 一致）。

**头部**（标题 + 放大/缩小 + 关闭，与 `DiscussDrawer` 完全同款）：
- 标题"草稿"。
- `expanded` useState：`false` → `w-[45%]`，`true` → `w-[70%]`。
- 放大/缩小按钮：复用 `DiscussDrawer.tsx:77-98` 同款 SVG（两箭头图标按 `expanded` 切换）。
- 关闭按钮：复用 `DiscussDrawer.tsx:100-110` 同款 X 图标。

**body**：
```tsx
<div className="flex-1 min-h-0">
  <DraftWhiteboard questionId={questionId} scrollMode="scroll-y" />
</div>
```

**不显示「当前题目」上下文条**（`DiscussDrawer` 有而本抽屉不画）——草稿不依赖题面文本，只依赖 `questionId`。

**`DraftIconButton`**（与 `DiscussIconButton` 同族样式）：
- 38×38 圆角边框按钮，`bg-[var(--learn-card-bg)]`，`text-[var(--text-secondary)]`（视觉权重低于"提示"warning 与"讲一讲"info，区别于二者）。
- 线性 SVG 图标：笔 + 纸的组合（避开与 `DraftWhiteboard` 内部 `PenIcon` 完全相同，作"草稿入口"语义）。可参考 `DraftWhiteboard.tsx:53-60` 的 PenIcon 但稍作区分（如加一条横线表示纸）。
- `title="草稿"` `aria-label="草稿"`。

### 1.3 `QuestionRunner` —— 新增 `onQuestionChange` 回调

**文件**：`apps/web/src/components/business/answer/QuestionRunner.tsx`

在 `QuestionRunnerProps`（约 line 50-82）新增可选属性：
```tsx
/** 当前题变化时回调（父层追踪当前题，供页面级浮层如草稿抽屉使用）；首次 mount 也会触发 */
onQuestionChange?: (q: RunnerQuestion, idx: number) => void;
```

在组件内（`idx` state 声明后）加：
```tsx
useEffect(() => {
  if (q && onQuestionChange) onQuestionChange(q, idx);
}, [idx, q, onQuestionChange]);
```

**注意**：`onQuestionChange` 进依赖数组会因父层每次渲染传新函数引用而触发循环——父层用 `useCallback` 包裹回调，或本 effect 内对 `onQuestionChange` 用 ref 持有最新引用避免重跑。实现时择一，spec 不强制。建议：父层 `useCallback`，与 `headerActions` 等现有 render-prop 的调用约定一致。

其余 `QuestionRunner` API 不动。`headerExtra` 维持 `ReactNode` 类型（不改成 render-prop），草稿图标作为 `ReactNode` 由父层组装进 `headerExtra`。

## 2. 三个 run 页改造

### 2.1 `TargetedRunPage` / `ErrorPracticeRunPage`

两页现状：`headerExtra` 未传（空）；页容器已有 `relative`（`TargetedRunPage.tsx:157`、`ErrorPracticeRunPage.tsx:156`）。

改造：
- 新增 state：
  ```tsx
  const [draftOpen, setDraftOpen] = useState(false);
  const [currentQ, setCurrentQ] = useState<RunnerQuestion | null>(null);
  ```
- `QuestionRunner` 新增：
  ```tsx
  onQuestionChange={setCurrentQ}  // 或 useCallback 包裹
  headerExtra={<DraftIconButton onClick={() => setDraftOpen(true)} />}
  ```
- `QuestionRunner` 兄弟节点渲染抽屉（仅作答态，与 `DiscussDrawer` 同 gate）：
  ```tsx
  {draftOpen && currentQ && phase === 'answering' && (
    <DraftDrawer
      questionId={`${draftKeyPrefix}-${currentQ.n}`}
      onClose={() => setDraftOpen(false)}
    />
  )}
  ```
- `ErrorPracticeRunPage` 多阶段（cleanup phase）：`currentQ` 在 cleanup 阶段无 `q.n`，抽屉不渲染（`currentQ && ...` 已覆盖）。

### 2.2 `ExamRunPage`

现状：`headerExtra` 已有「已答 X/N + 倒计时」（`ExamRunPage.tsx:230-243`）；页容器**缺 `relative`**（line 223）。

改造：
- 页容器加 `relative`：`flex h-screen flex-col` → `relative flex h-screen flex-col`。
- `headerExtra` 在现有 flex 容器内**前置** `DraftIconButton`（草稿按钮在倒计时左侧，避免遮挡倒计时）：
  ```tsx
  headerExtra={
    <div className="flex shrink-0 items-center gap-4">
      <DraftIconButton onClick={() => setDraftOpen(true)} />
      <span className="text-sm text-[var(--text-secondary)]">已答 {answeredNs.size}/{questions.length}</span>
      <span ...倒计时...>{...}</span>
    </div>
  }
  ```
- 其余同 §2.1（state + onQuestionChange + 兄弟抽屉渲染）。
- 抽屉仅作答态渲染（交卷后 `phase` 转 result/submitting，不渲染）。

## 3. 数据流与状态

```
QuestionRunner (idx 变化)
  └─ onQuestionChange(q, idx) ─→ run 页 setCurrentQ
                                      │
run 页 draftOpen=true ─────────────→ <DraftDrawer questionId={`${draftKeyPrefix}-${currentQ.n}`}>
                                      │
                                  <DraftWhiteboard questionId={...} scrollMode="scroll-y">
                                      │
                                  draft-store.getDraft(questionId) ─→ 重绘
```

- 切题：`QuestionRunner` 内 `setIdx` → 触发 `onQuestionChange` → 父页 `setCurrentQ` → 抽屉 `questionId` prop 变化 → `DraftWhiteboard` 的 `useEffect([questionId])` 自动 `getDraft` + 重绘。
- 抽屉与内嵌草稿（`PreviewDraftPanel` → `DraftWhiteboard`）共用同一 `questionId` 键：A 处画笔 → `setDraft` → B 处下次 `getDraft`（切题来回切换或重开抽屉时）即可见。
  - 实时双向可见性：当前 `DraftWhiteboard` 不监听 `draft-store` 变化（只在 `questionId` 变化时 `getDraft`）。同题内嵌草稿画的笔迹，切到抽屉需要关再开抽屉才能见到（`questionId` 不变就不 `getDraft`）。这是现有行为，本 spec 不改。如要实时同步需 `draft-store` 加订阅机制——不在本次范围。

## 4. 边界与错误处理

- `currentQ` 为 null（mount 期或 cleanup 阶段无 `q`）：抽屉不渲染（`currentQ && ...` gate）。
- `phase !== 'answering'`（结果页 / 考试交卷态 / judging 等待态）：抽屉不渲染。
- 草稿按钮在 `headerExtra` 内始终可见（作答态），与"讲一讲"渐进式门禁无关——草稿是基础作答工具，不 gate。
- 考试倒计时变红（< 5min）时草稿按钮不联动变色，保持自身中性色。
- 夜间模式：`DraftWhiteboard` 已读 `--text-primary` 适配笔迹颜色；抽屉外壳用 `--learn-card-bg` / `--bg-subtle` 等 CSS 变量，自动跟随主题。但训练轨三个 run 页强制 `data-theme="student-day"`（见三页 `student-theme-container` 外壳），夜间模式在 run 页不生效——本抽屉同样只在 day 主题下展示，无需额外处理。

## 5. 测试

`apps/web` 无测试框架。手测清单：

1. **三页各开抽屉**：专项 / 考试 / 错题三页右上角草稿图标可见，点击展开抽屉。
2. **三按钮**：手写笔可画、橡皮可擦（点中笔画整笔删除）、清空可全清。
3. **纵向滚动**：抽屉内画布纵向超出视口时出现纵向滚动条；横向不滚（无论怎么画）。
4. **两档宽度**：放大/缩小按钮切换 `45% ↔ 70%`，过渡顺滑。
5. **手动关闭**：X 关闭抽屉。
6. **切题笔迹保留**：抽屉开 → 在当前题画几笔 → 切下一题 → 切回 → 笔迹仍在。
7. **抽屉与内嵌草稿双向可见**（仅数学题，`PreviewDraftPanel` 启用时）：抽屉画几笔 → 关抽屉 → 内嵌草稿切换题来回触发 `getDraft` → 笔迹可见；反向亦然。
8. **考试页布局**：草稿按钮与「已答 X/N」+ 倒计时并排不挤压；倒计时 < 5min 变红时草稿按钮不变色。
9. **三页退出/交卷后**：抽屉不渲染（`phase !== 'answering'`）。
10. **清理态（错题 cleanup phase）**：`currentQ` 为 null，抽屉不渲染。

## 6. 不在本次范围

- 不改 `draft-store.ts`（无新持久化层、无订阅机制）。
- 不改 `DiscussDrawer`（独立组件，互不影响）。
- 不动计算答题窗口内嵌草稿（`PreviewDraftPanel` → `DraftWhiteboard`）的 `'fit'` 行为——仅给 `DraftWhiteboard` 加可选 `scrollMode`，默认 `'fit'`。
- 不引入拖拽连续调宽（按确认用两档预设）。
- 不引入 `draft-store` 实时订阅同步（同题两处实时双向可见属未来增强）。
- 不改后端 / API / openapi.yaml。

## 7. 涉及文件清单

新增：
- `apps/web/src/components/business/DraftDrawer.tsx`

修改：
- `apps/web/src/components/business/DraftWhiteboard.tsx`（加 `scrollMode` prop + `'scroll-y'` 模式实现）
- `apps/web/src/components/business/answer/QuestionRunner.tsx`（加 `onQuestionChange` 可选 prop + effect）
- `apps/web/src/pages/student/training/TargetedRunPage.tsx`（state + headerExtra + 抽屉渲染）
- `apps/web/src/pages/student/training/ExamRunPage.tsx`（state + headerExtra 并排 + 页容器加 `relative` + 抽屉渲染）
- `apps/web/src/pages/student/training/ErrorPracticeRunPage.tsx`（state + headerExtra + 抽屉渲染）

不动：
- `apps/web/src/components/business/draft-store.ts`
- `apps/web/src/components/business/DiscussDrawer.tsx`
- `apps/web/src/components/business/PreviewDraftPanel.tsx`（间接通过 `DraftWhiteboard` 的新 prop 默认值保持原行为）
- 后端 / API / openapi.yaml
