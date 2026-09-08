# 草稿抽屉鼠标拖拽调宽 — 设计文档

- 日期：2026-09-09
- 范围：`apps/web/src/components/business/DraftDrawer.tsx`（仅此一个文件）
- 关联：`2026-09-07-training-draft-drawer-design.md`（草稿抽屉初版）、`2026-09-08-draft-paste-image-design.md`（贴图）

## 1. 背景与动机

训练轨答题页（ErrorPracticeRunPage / ExamRunPage / TargetedRunPage）的页面级草稿抽屉
（DraftDrawer）当前只有两个固定宽度档位：`w-[45%]` ↔ `w-[70%]`，靠右上「放大/缩小」按钮切换。

学生需要更细的宽度控制：白板画布在 45% 时偏窄、70% 时又可能盖住太多题面。改为支持鼠标
拖拽左边缘连续调宽，同时保留两档快照按钮作为快捷入口。

## 2. 需求

1. 鼠标按住抽屉左边缘的竖向拖拽条左右拖动 → 抽屉宽度连续变化。
2. 宽度范围夹紧在 **[40%, 85%]**（% 相对抽屉定位容器——训练页 `relative flex h-screen flex-col p-4 sm:p-6` 的 padding box 宽度）。
3. 右上「放大/缩小」按钮保留，行为以按钮态（`expanded` 布尔）为基准：点一次在 45%/70% 间快照切换；拖拽后按钮仍按按钮态快照（可预测，不与当前宽度比较）。
4. 拖拽后的宽度**会话内记忆**：模块级变量，开关抽屉、跨三个训练页切换都保持；刷新/新会话回到默认 45%。
5. 拖拽中无宽度过渡动画（避免拖慢）；落定后有（与现状一致）。

## 3. 方案

原生 Pointer Events + 百分比 inline style。不引库、不依赖 CSS `resize`（与 absolute 定位/夹紧/记忆/按钮联动均不合）。

### 3.1 状态与渲染

- 模块级会话记忆：`let lastWidthPct: number | null = null;`（文件顶部）。
- 组件内 `const [widthPct, setWidthPct] = useState<number>(() => lastWidthPct ?? 45);`
  —— 初值取自会话记忆；三个页面的抽屉各挂载一次，因共享模块级变量，后挂载者继承前者的宽度。
- 抽屉 div：去掉 `widthClass` 三元，改 `style={{ width: `${widthPct}%` }}`；className 保留
  `transition-[width] duration-200`，拖拽中（`dragging` state 为 true）追加 `transition-none`。
- 右上按钮：`expanded` 逻辑不变，点击时 `setWidthPct(expanded ? 45 : 70)`、翻转 expanded、
  同步 `lastWidthPct = 新宽度`。

### 3.2 拖拽条

- JSX：抽屉内 `absolute left-0 top-0 bottom-0 w-[6px]` 的 div：
  - `cursor: col-resize`、`touchAction: 'none'`、`role="separator"`、`aria-orientation="vertical"`、`aria-label="调整草稿宽度"`。
  - 握把视觉：居中一条 2px 圆角细竖线（`bg-[var(--bg-subtle)]`，hover 加深）——功能性提示，非装饰。
- 交互：
  - `onPointerDown`（仅左键/主键）：`e.currentTarget.setPointerCapture(e.pointerId)`；记录
    `dragging = true`；容器 rect 取 `e.currentTarget.offsetParent?.getBoundingClientRect()`。
  - `onPointerMove`：`widthPct = clamp(((rect.right - e.clientX) / rect.width) * 100, 40, 85)`，写 state。
  - `onPointerUp` / `onLostPointerCapture`：`dragging = false`，`lastWidthPct = widthPct`。
- 拖拽期间给抽屉加 `select-none`（`user-select: none`），防文本/图片被选中；拖拽条自身
  `draggable={false}` 兜底。
- 触屏：同一套 Pointer Events 天然可用（`touchAction: none` 已防滚动抢占），但本需求以鼠标为主。

### 3.3 边界与错误处理

- 越界：clamp 到 [40, 85]（夹紧由计算承担，UI 不越界）。
- pointer capture 丢失：`onLostPointerCapture` 落定收尾，不残留 dragging。
- 拖出抽屉外：capture 使 move 事件持续送达，宽度照常实时更新。
- 多指：抽屉内无多指语义，只认单指（后续指针被 capture 机制接管，行为等同单指）。

### 3.4 不改动

- `DraftWhiteboard`、`DraftImageLayer`、三个训练页、QuestionRunner：零改动。
- DraftDrawer 对外 props（`questionId` / `onClose`）不变。

## 4. 验证

- `apps/web`：`npm run build`（tsc 类型检查 + 构建）与 `npm run lint`。
- 浏览器实测（dev 或 preview 需重新构建，见 memory `preview-mode-requires-rebuild`）：
  1. 拖左边缘到 40% / 85% 极限夹紧；
  2. 拖到中间值后关闭再开抽屉，宽度保持；
  3. 三页之间切路由，宽度保持；
  4. 「放大/缩小」按钮在拖拽后仍按按钮态快照 45/70；
  5. 拖拽过程无过渡动画、落定无跳动。
