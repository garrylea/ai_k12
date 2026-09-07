# 训练轨草稿抽屉设计（专项/考试/错题）

日期：2026-09-07 ｜ 分支：`feat/training-draft-drawer` ｜ 状态：已与用户对齐（2026-09-07 二次澄清）

## 背景与目标

训练轨三个答题页（`TargetedRunPage` / `ExamRunPage` / `ErrorPracticeRunPage`）当前只在「计算答题窗口」（`QuestionRunner` 内嵌的 `PreviewDraftPanel`）里有草稿手绘功能，且仅数学填空/解答题有（选择题/判断题无草稿，见 `QuestionRunner.tsx:323-343` 作答区分支）。

用户要求：

1. 三个答题页**页面背景层右上角**（不是答题框组件内）放一个**小且不起眼**的草稿图标，**始终显示**（作答态可见，不随答题框渲染与否变化）。
2. 点图标调出**右侧抽屉**草稿，功能与现有「计算答题窗口」草稿一致：手写笔 / 橙皮 / 清空 三按钮。
3. 抽屉内画布**纵向可滚动**（上下滚，左右不滚）。
4. 抽屉**两档宽度预设**切换 + **X 手动关闭**。
5. **草稿不保存**：纯内存，切题即清空。关闭抽屉再开也是空的。不写 `draft-store`。
6. **隐藏现有内嵌草稿**：`PreviewDraftPanel` 的草稿 tab 下线（`enabled=false`），抽屉草稿替代。将来恢复翻回 `enabled` 即可。
7. **全题型覆盖**：图标在页面背景层，与 `QuestionRunner` 的作答区分支无关，选择/判断/填空/解答**所有题型**作答态都可见可用。

## 已确认的决策

| 决策点 | 结论 |
|---|---|
| 图标位置 | 页面背景层右上角 `absolute top-4 right-4`，不进 `QuestionRunner` 的 `headerExtra` |
| 图标样式 | 小尺寸（32×32）、低对比（`text-[var(--text-tertiary)]`）、不抢答题区视觉焦点 |
| 图标可见性 | 始终显示（answering + result 阶段都可见；result 阶段无当前题，抽屉作纯草稿本用） |
| 草稿持久化 | 不持久化：`DraftWhiteboard` 加 `persist?: boolean`（默认 `true` 保留原行为），抽屉用 `persist={false}`，不写 `draft-store` |
| 切题清空 | 抽屉内 `<DraftWhiteboard key={questionId} persist={false} ... />`，questionId 变即 remount → 空白画布 |
| 关闭抽屉 | 抽屉条件渲染（`{draftOpen && ...}`），unmount 即丢笔迹；再开为空（"不保存"） |
| 隐藏内嵌草稿 | `QuestionRunner.tsx:339` `PreviewDraftPanel` 的 `enabled` 改 `false`（一行改动，`PreviewDraftPanel` 退化为 `<LatexPreview>` 无草稿 tab） |
| 画布滚动 | `DraftWhiteboard` 加 `scrollMode?: 'fit' \| 'scroll-y'`（默认 `'fit'`，内嵌草稿——虽隐藏但保留原行为）；抽屉用 `'scroll-y'` |
| 宽度调整 | 两档预设 `w-[45%]` ↔ `w-[70%]`，点按切换，与 `DiscussDrawer` `card` 模式一致 |
| 当前题追踪 | `QuestionRunner` 新增 `onQuestionChange?: (q: RunnerQuestion, idx: number) => void`；页存 `currentQ`，传 `currentQ.n` 给抽屉做 key |

## 1. 组件改造

### 1.1 `DraftWhiteboard` —— 新增 `scrollMode` + `persist` 两个可选 prop

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
  persist = true,
}: {
  questionId: string;
  scrollMode?: 'fit' | 'scroll-y';
  persist?: boolean;
})
```

**`persist` 选项**（默认 `true`，保留现有行为）：
- `true`：现有行为——`getDraft`/`setDraft`/`clearDraft` 读写 `draft-store`，`useEffect([questionId])` 加载该题草稿。
- `false`：**不**读写 `draft-store`。`strokesRef` 纯本地：
  - `useEffect([questionId])`：`strokesRef.current = []; redraw();`（切题清空本地笔迹）。
  - `handlePointerUp` / `eraseAt` / `handleClear`：跳过 `setDraft` / `clearDraft` 调用，只更新 `strokesRef` + `redraw`。
  - unmount 即丢全部笔迹（不写 store）。

**`'fit'` 模式（现有行为，不动）**：
- wrap div（`wrapRef`）：`flex-1 min-h-0 relative`。
- canvas：`absolute inset-0 w-full h-full`。
- `ResizeObserver`：canvas 尺寸 = wrap 的 clientWidth × clientHeight × DPR。

**`'scroll-y'` 模式（新增）**：
- wrap div：`flex-1 min-h-0 overflow-y-auto overflow-x-hidden`（纵向滚动条出现条件：内容高于容器）。
- canvas 外层包一个固定高度的"画板"div（高度 = 容器高 × 1.6，宽度 = 容器宽），canvas 仍 `absolute inset-0 w-full h-full` 贴合该画板。
- `ResizeObserver` 监听 wrap 容器（滚动区）尺寸变化：重算画板宽（= 容器宽）+ 画板高（= 容器高 × 1.6），同步 canvas 像素尺寸 + DPR transform + 重绘。
- **滚动后坐标正确性**：`pointFromEvent` 现有实现用 `e.currentTarget.getBoundingClientRect()`，滚动后 canvas 的 `rect.top` 随滚动位移变化，`e.clientY - rect.top` 自动得到 canvas 内坐标。无需改 `pointFromEvent`。
- 笔迹存储坐标系不变：仍是 canvas 像素空间（DPR-aware），滚动只是改视口，不影响存储/重绘。
- 工具条（手写笔 / 橪皮 / 清空）结构与样式完全不变。

**关键不变量**：
- `persist` 默认 `true`，现有 `PreviewDraftPanel` 调用（虽 `enabled=false` 已隐藏，但代码保留）行为不变。
- `scrollMode` 默认 `'fit'`，现有调用行为不变。
- 主题切换（日/夜）笔迹颜色自适应：`redraw` 读 `--text-primary` CSS 变量，两模式一致。

### 1.2 新组件 `DraftDrawer.tsx`

**文件**：`apps/web/src/components/business/DraftDrawer.tsx`（新建）

参考 `DiscussDrawer.tsx` 结构（不含 chat），导出两个符号：

```tsx
export function DraftDrawer({
  questionId,
  onClose,
}: {
  questionId: string;   // 当前题 q.n，用作 key 触发 remount 清空
  onClose: () => void;
})

export function DraftIconButton({ onClick }: { onClick: () => void })
```

**抽屉外壳**（与 `DiscussDrawer` 同款样式）：
- 根 div：`absolute top-0 right-0 bottom-0 flex flex-col bg-[var(--learn-card-bg)] border-l border-[var(--bg-subtle)] transition-[width] duration-200 ${widthClass}`，`style={{ boxShadow: 'var(--shadow-drawer)' }}`，`role="dialog"` `aria-label="草稿"`。
- 父级需 `relative` 定位容器（三个 run 页容器，ExamRunPage 需补 `relative`）。
- 仅手动关闭，不点外部收起（与 `DiscussDrawer` 一致）。

**头部**（标题 + 放大/缩小 + 关闭，与 `DiscussDrawer` 完全同款 SVG）：
- 标题"草稿"。
- `expanded` useState：`false` → `w-[45%]`，`true` → `w-[70%]`。
- 放大/缩小按钮：复用 `DiscussDrawer.tsx:77-98` 同款两箭头 SVG（按 `expanded` 切换）。
- 关闭按钮：复用 `DiscussDrawer.tsx:100-110` 同款 X 图标。

**body**：
```tsx
<div className="flex-1 min-h-0">
  <DraftWhiteboard key={questionId} questionId={questionId} scrollMode="scroll-y" persist={false} />
</div>
```
- `key={questionId}`：切题即 remount，加上 `persist={false}` 的 `useEffect([questionId])` 清空本地笔迹——双保险确保切题后画布是空的。
- 不显示「当前题目」上下文条（草稿不依赖题面文本）。

**`DraftIconButton`**（页面背景层右上角用）：
- 32×32 圆角边框按钮（比 `DiscussIconButton` 的 38×38 更小、更不起眼）。
- `bg-[var(--learn-card-bg)]`，`text-[var(--text-tertiary)]`（低对比，不抢焦点）。
- `hover:bg-[var(--bg-base)]` 悬停反馈。
- 线性 SVG 图标：笔 + 纸组合（参考 `DraftWhiteboard.tsx:53-60` PenIcon 但加一条横线表示纸，作"草稿入口"语义）。
- `title="草稿"` `aria-label="草稿"`。

### 1.3 `QuestionRunner` —— 新增 `onQuestionChange` 回调 + 隐藏内嵌草稿

**文件**：`apps/web/src/components/business/answer/QuestionRunner.tsx`

**改动 A：隐藏内嵌草稿**（`QuestionRunner.tsx:339`）：
```tsx
// 改前
<PreviewDraftPanel
  answer={answer}
  questionId={`${draftKeyPrefix}-${q.n}`}
  enabled={subjectId === MATH_SUBJECT_ID}
/>
// 改后
<PreviewDraftPanel
  answer={answer}
  questionId={`${draftKeyPrefix}-${q.n}`}
  enabled={false}   // 草稿 tab 下线，抽屉草稿替代（2026-09-07）；恢复时改回 subjectId === MATH_SUBJECT_ID
/>
```
`PreviewDraftPanel` 的 `enabled=false` 分支返回 `<LatexPreview value={answer} />`（无草稿 tab，纯预览）。

**改动 B：新增 `onQuestionChange` 可选 prop**（`QuestionRunnerProps` 约 line 50-82）：
```tsx
/** 当前题变化时回调（父层追踪当前题，供页面级草稿抽屉做 key 触发清空）；首次 mount 也触发 */
onQuestionChange?: (q: RunnerQuestion, idx: number) => void;
```

组件内（`idx` state 声明后）加：
```tsx
useEffect(() => {
  if (q && onQuestionChange) onQuestionChange(q, idx);
}, [idx, q, onQuestionChange]);
```

**注意**：`onQuestionChange` 进依赖数组会因父层每次渲染传新函数引用而触发循环——父层用 `useCallback` 包裹，或本 effect 内对 `onQuestionChange` 用 ref 持有最新引用避免重跑。建议父层 `useCallback`，与 `headerActions` 等现有 render-prop 的调用约定一致。

其余 `QuestionRunner` API 不动。`headerExtra` 维持 `ReactNode` 类型不变（草稿图标不再走它，改走页面背景层 absolute）。

## 2. 三个 run 页改造

### 2.1 `TargetedRunPage` / `ErrorPracticeRunPage`

两页现状：页容器已有 `relative`（`TargetedRunPage.tsx:157`、`ErrorPracticeRunPage.tsx:156`）；`headerExtra` 未传（保持不传）。

改造（在 `student-theme-container > relative h-screen` 容器内，`QuestionRunner` 之后加兄弟节点）：
- 新增 state：
  ```tsx
  const [draftOpen, setDraftOpen] = useState(false);
  const [currentQ, setCurrentQ] = useState<RunnerQuestion | null>(null);
  ```
- `QuestionRunner` 新增 prop：
  ```tsx
  onQuestionChange={setCurrentQ}  // 或 useCallback 包裹
  ```
- `QuestionRunner` 之后渲染图标（始终显示）+ 抽屉（open 时）：
  ```tsx
  {/* 草稿入口（页面背景层右上角，始终显示） */}
  <DraftIconButton onClick={() => setDraftOpen(true)} />

  {/* 草稿抽屉 */}
  {draftOpen && currentQ && (
    <DraftDrawer
      questionId={currentQ.n}
      onClose={() => setDraftOpen(false)}
    />
  )}
  ```
- `DraftIconButton` 的定位样式：`absolute top-4 right-4 z-20`（z-index 高于答题卡，低于 Modal/抽屉）。
- 抽屉 `questionId={currentQ.n}`——切题时 `currentQ.n` 变，`DraftWhiteboard key` 变即 remount 清空。
- `ErrorPracticeRunPage` 多阶段（cleanup phase）：`currentQ` 为 null 时抽屉不渲染（`currentQ && ...` gate）；图标仍显示（始终可见，cleanup 阶段点击无 currentQ 则抽屉不开——`currentQ &&` gate 保护）。

### 2.2 `ExamRunPage`

现状：页容器**缺 `relative`**（`ExamRunPage.tsx:223`）；`headerExtra` 有倒计时（保持不动）。

改造：
- 页容器加 `relative`：`flex h-screen flex-col` → `relative flex h-screen flex-col`。
- `headerExtra` 不动（草稿图标不进 headerExtra，改走页面背景层）。
- 其余同 §2.1：state + `onQuestionChange` + 图标 + 抽屉渲染。
- 抽屉仅作答态有 currentQ 时可开（交卷后无 currentQ，图标仍可见但点击不开——`currentQ &&` gate）。

## 3. 数据流与状态

```
QuestionRunner (idx 变化)
  └─ onQuestionChange(q, idx) ─→ run 页 setCurrentQ
                                      │
run 页 draftOpen=true ─────────────→ <DraftDrawer questionId={currentQ.n}>
                                      │
                                  <DraftWhiteboard key={questionId} persist={false} scrollMode="scroll-y">
                                      │
                                  纯本地 strokesRef（不写 draft-store）
```

- 切题：`QuestionRunner` 内 `setIdx` → `onQuestionChange` → 父页 `setCurrentQ` → `currentQ.n` 变 → `DraftWhiteboard key` 变 → React remount → `strokesRef` 重置为空 + `persist=false` 的 `useEffect([questionId])` 也清空 → 双保险空白画布。
- 关抽屉：`setDraftOpen(false)` → 抽屉 unmount → `DraftWhiteboard` unmount → `strokesRef` 销毁。再开为空（"不保存"）。
- 不写 `draft-store`：抽屉草稿与 `draft-store` 完全隔离，不影响隐藏的内嵌草稿的 store 数据（虽内嵌草稿已 `enabled=false` 下线）。

## 4. 边界与错误处理

- `currentQ` 为 null（mount 期 / cleanup 阶段 / 考试交卷后）：图标仍显示，但抽屉 `currentQ && ...` gate 不渲染，点击图标无效（不开抽屉）。可接受——无当前题时无草稿可言。
- `phase` 切换：图标始终显示（answering + result）。抽屉仅在 `draftOpen && currentQ` 时渲染。
- 草稿按钮与"讲一讲"渐进式门禁无关——草稿是基础作答工具，不 gate。
- 考试倒计时变红（< 5min）时草稿按钮不联动变色，保持自身中性低对比色。
- 夜间模式：训练轨三个 run 页强制 `data-theme="student-day"`，夜间模式在 run 页不生效——图标与抽屉只在 day 主题下展示，无需额外处理。

## 5. 测试

`apps/web` 无测试框架。手测清单：

1. **三页右上角图标可见**：专项 / 考试 / 错题三页背景层右上角草稿图标小且不起眼，始终显示（作答态 + 结果页）。
2. **点图标开抽屉**：右侧滑出，手写笔可画、橡皮可擦（点中笔画整笔删除）、清空可全清。
3. **纵向滚动**：抽屉内画布纵向超出视口时出现纵向滚动条；横向不滚。
4. **两档宽度**：放大/缩小按钮切换 `45% ↔ 70%`，过渡顺滑。
5. **手动关闭**：X 关闭抽屉。
6. **切题清空**：抽屉开 → 画几笔 → 切下一题 → 画布是空的；切回上一题 → 也是空的（不保存）。
7. **关抽屉再开同题**：关 → 再开 → 画布是空的（不保存）。
8. **全题型**：选择题 / 判断题 / 填空题 / 解答题 作答态都能看到图标、都能开抽屉画草稿。
9. **内嵌草稿已隐藏**：填空/解答题作答区右半只有预览（无"草稿"tab）。
10. **考试页布局**：草稿图标在页面右上角，不与倒计时重叠（倒计时在 `headerExtra` 标题行，图标在页面背景层 absolute，分层不冲突）。
11. **结果页**：图标仍可见，点击无 currentQ 不开抽屉（或开空白——由 `currentQ &&` gate 决定，本 spec 规定不开）。

## 6. 不在本次范围

- 不改 `draft-store.ts`（抽屉 `persist=false` 不用它；隐藏的内嵌草稿虽保留 `persist=true` 默认值但已 `enabled=false` 下线，不触发调用）。
- 不改 `DiscussDrawer`（独立组件，互不影响）。
- 不改 `PreviewDraftPanel` 组件本身（只改 `QuestionRunner` 传给它的 `enabled` 值）。
- 不引入拖拽连续调宽（用两档预设）。
- 不引入 `draft-store` 订阅同步（抽屉草稿不持久化，无同步需求）。
- 不改后端 / API / openapi.yaml。
- 不在结果页为草稿做特殊处理（图标可见但无 currentQ 不开抽屉）。

## 7. 涉及文件清单

新增：
- `apps/web/src/components/business/DraftDrawer.tsx`

修改：
- `apps/web/src/components/business/DraftWhiteboard.tsx`（加 `scrollMode` + `persist` 两个可选 prop）
- `apps/web/src/components/business/answer/QuestionRunner.tsx`（`PreviewDraftPanel enabled=false` + 加 `onQuestionChange` 可选 prop + effect）
- `apps/web/src/pages/student/training/TargetedRunPage.tsx`（state + onQuestionChange + 图标 + 抽屉渲染）
- `apps/web/src/pages/student/training/ExamRunPage.tsx`（state + onQuestionChange + 页容器加 `relative` + 图标 + 抽屉渲染）
- `apps/web/src/pages/student/training/ErrorPracticeRunPage.tsx`（state + onQuestionChange + 图标 + 抽屉渲染）

不动：
- `apps/web/src/components/business/draft-store.ts`
- `apps/web/src/components/business/DiscussDrawer.tsx`
- `apps/web/src/components/business/PreviewDraftPanel.tsx`（只改外部传入的 `enabled` 值，组件本身不动）
- 后端 / API / openapi.yaml
