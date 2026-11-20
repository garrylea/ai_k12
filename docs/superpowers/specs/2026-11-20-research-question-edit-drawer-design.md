# 教研试卷编辑抽屉：X 关闭图标 + 拖拽调宽设计

日期：2026-11-20 ｜ 状态：已与用户对齐（三项决策均选推荐值）

## 背景与目标

教研试卷详情页（`ResearchPaperDetailPage`）点某道题的「编辑」后，右侧弹出
`ResearchQuestionEditDrawer`（编辑题目抽屉）。当前两个体验问题：

1. 右上角关闭控件是**文字按钮「关闭抽屉」**，占空间且不像常规关闭入口；用户要求改为 **X 图标**。
2. 宽度写死为 `w-[min(92vw,32rem)]`，不能调；用户要求**宽度可调**。

目标：只做这两点 UI 改进，不改抽屉的草稿状态机、保存校验、图片上传逻辑，不改表格与后端。

## 已确认的决策

| 决策点 | 结论 |
|---|---|
| 关闭控件形态 | 文字按钮 → 32×32 线性 SVG X 图标按钮（不用 emoji），带 `title`/`aria-label="关闭抽屉"` |
| 关闭行为 | **保持现状**：X 仍走 `requestCancel()`——有未保存修改 / 在途上传时弹「丢弃未保存的修改？」确认框；底部「取消」按钮不动 |
| 调宽方式 | 左缘竖向拖拽条，Pointer Events 连续调宽（增量式），设上下限；不放宽/窄两档按钮 |
| 宽度记忆 | 模块级 `lastWidthPx`，会话内跨开关、跨试卷保持；刷新回默认 |
| 默认宽度 | 未拖动时**不注入内联宽度**，仍由 class `w-[min(92vw,32rem)]` 决定，保持现有外观 |

## 1. 关闭按钮改造

**文件**：`apps/web/src/pages/research/ResearchQuestionEditDrawer.tsx`（header，约 420–426 行）

改前：`button` 内是文字 `关闭抽屉`。

改后：
- 按钮容器 `w-8 h-8 rounded-lg flex items-center justify-center text-[var(--text-secondary)] hover:bg-gray-100 transition-colors`，`type="button"`。
- `onClick={requestCancel}` 不变。
- `title="关闭抽屉"` `aria-label="关闭抽屉"`（图标按钮必须留读屏可访问名）。
- 图标复用仓库统一的线性 SVG X（`ConfirmDialog.tsx:63`、`ImageLightbox.tsx:12` 同款，`viewBox="0 0 24 24"`，两条交叉 `<line>`，`stroke="currentColor"`，`w-5 h-5`），`aria-hidden="true"`。

底部「取消」按钮与 `ConfirmDialog` 完全不动。

## 2. 拖拽调宽

### 2.1 DOM 结构调整（关键）

当前根 `<aside>` 同时是 `fixed` 定位和 `overflow-y-auto` 滚动容器。若把拖拽条直接做成 `<aside>` 的 `absolute` 子元素，内容滚动时握把会跟着滚走。

改成两层：

```
<aside fixed inset-y-0 right-0 z-50 w-[min(92vw,32rem)] bg-white shadow-2xl border-l border-gray-200
       style={{ width: widthPx !== null ? `${widthPx}px` : undefined }}>
  <div 左缘拖拽条 absolute left-0 top-0 bottom-0 w-[10px] z-10 ... />
  <div className="h-full overflow-y-auto p-6">   {/* 原滚动内容整体内移 */}
    <header> ... X 按钮 ... </header>
    ... 原 notice / 五个 EditField / 已对照原卷 / 备注 / footer ...
    <ConfirmDialog ... />   {/* fixed 浮层，留在滚动容器内不受影响 */}
  </div>
</aside>
```

- `<aside>` 自带 `position: fixed`，已是其 `absolute` 子元素的包含块，**不要再叠加 `relative`**（两个定位 class 同元素会冲突）。
- `overflow-y-auto` 与 `p-6` 从 `<aside>` 移到内层滚动 div。
- 未拖动时无内联 `width`，class `w-[min(92vw,32rem)]` 生效；拖动后内联 px 覆盖 class。

### 2.2 状态与会话记忆

```ts
const WIDTH_DEFAULT_VW = 92;          // 上限：92vw，与原 class 的 92vw 一致
const WIDTH_MAX_PX = () => window.innerWidth * 0.92;
const WIDTH_MIN_PX = () => Math.min(360, WIDTH_MAX_PX()); // 窄屏时下限=上限，禁调
let lastWidthPx: number | null = null;                    // 模块级会话记忆，刷新归 null
```

组件内：
- `const [widthPx, setWidthPx] = useState<number | null>(() => lastWidthPx);`
- `const [dragging, setDragging] = useState(false);`
- `const drawerRef = useRef<HTMLElement>(null);`
- `const widthPxRef = useRef(widthPx);`
- `const resizeStartRef = useRef<{ startX: number; startPx: number } | null>(null);`

### 2.3 拖拽交互

- **pointerdown**（左键 / 触摸）：`setPointerCapture`，快照 `startX = e.clientX`、
  `startPx = drawerRef.current?.getBoundingClientRect().width || widthPxRef.current || Math.min(512, WIDTH_MAX_PX())`，
  置 `resizeStartRef`，`setDragging(true)`。
- **pointermove**：`next = startPx + (startX - e.clientX)`（向左拖变宽，向右拖变窄——右侧抽屉的直觉方向），
  夹紧到 `[WIDTH_MIN_PX(), WIDTH_MAX_PX()]`，写 `widthPxRef` + `setWidthPx`。
  宽度没有预设档位、只由拖拽驱动，所以**不加 width 过渡动画**（跟手即时响应）；拖拽期加 `select-none` 防误选中文字。
- **pointerup / pointercancel / lostpointercapture**：统一 `endResize()`，靠 `resizeStartRef.current` 判空短路保证幂等；
  `lastWidthPx = widthPxRef.current` 写会话记忆，清 `select-none`。
- 拖拽条加 `role="separator" aria-orientation="vertical" aria-label="调整抽屉宽度"` `draggable={false}` `touch-none`，
  中间一条 2px 竖线握把（功能性提示，非装饰），`cursor-col-resize`，hover 加深。
- 拖拽条 `z-10` 且命中区 10px：避免内容区的 textarea/preview 抢走指针事件（参照 `DraftDrawer` 实测教训）。

## 3. 边界与错误处理

- 窄屏（`window.innerWidth * 0.92 < 360`）：下限=上限，拖拽无效，抽屉保持 92vw；不出现比视口还宽或比 360px 还窄的抽屉。
- 刷新页面：模块级 `lastWidthPx` 归 null，回默认 `min(92vw,32rem)`。
- 切题（父组件传另一道题）与切试卷（抽屉 unmount/remount）：宽度 state 留在组件内，但 `lastWidthPx` 模块级仍在——重新挂载时读回上次宽度，符合「会话内记忆」。
- 拖拽中触发关闭：X 按钮在 header 内层滚动区，拖拽条在外壳左缘，二者不重叠；确认框是 `fixed inset-0 z-50`，盖在抽屉之上，正常可用。
- 主题：教研页为固定日间，`border-gray-200` / `bg-white` 沿用现状；X 图标用 `currentColor`，无需额外主题分支。
- 无障碍：X 按钮与拖拽条都有 `aria-label`；图标 `aria-hidden="true"` 避免读屏重复。

## 4. 测试

新增 `apps/web/src/pages/research/__tests__/ResearchQuestionEditDrawer.test.tsx`（组件改动必须补渲染测试）。
需 `vi.mock('@/services/api')` 桩掉 `uploadResearchImage` / `deleteResearchImages` / `updateResearchQuestion`，
`afterEach(() => cleanup())`（`globals:false`，手动清理）。

覆盖：
1. X 按钮：`getByRole('button', { name: '关闭抽屉' })` 存在，且内含 `svg`（不是文字按钮）。
2. 干净态点 X → `onClose` 调用一次。
3. dirty 态（改题干中任意 textarea）点 X → 出现「丢弃未保存的修改？」确认框，`onClose` 未调用。
4. 拖拽条存在：`getByRole('separator', { name: '调整抽屉宽度' })`，方向 vertical。
5. 拖拽改宽：mock `drawerRef` 元素的 `getBoundingClientRect` 返回固定宽度，`fireEvent.pointerDown/Move/Up` 后断言 `<aside>` 的 inline `style.width` 变化且落在夹紧范围内。
6. 会话记忆（**单个用例内自包含**：拖拽 → 卸载 → 再挂载，断言宽度沿用上次值），避免模块级 `lastWidthPx` 跨用例污染导致顺序依赖。

验证命令（apps/web）：`npm run build` + `npm run lint` + `npm test -- ResearchQuestionEditDrawer`。

## 5. 不在本次范围

- 不改抽屉的字段草稿、上传、校验、保存状态机（`Status` 流转、`dirty` 判定、`saveDisabled` 四条件）。
- 不改 `ResearchPaperDetailPage` 表格与其测试里的 drawer stub（stub 只验证父组件传参契约，与真实抽屉内部无关）。
- 不加放大/缩小两档按钮、不加双击复位（用户只要拖拽）。
- 不引入 localStorage 持久化（会话内记忆足够）。
- 不改后端 / API / openapi.yaml。

## 6. 涉及文件

新增：
- `apps/web/src/pages/research/__tests__/ResearchQuestionEditDrawer.test.tsx`

修改：
- `apps/web/src/pages/research/ResearchQuestionEditDrawer.tsx`（X 按钮 + DOM 两层结构 + 拖拽调宽）

不动：
- `apps/web/src/pages/research/ResearchPaperDetailPage.tsx` 及其 stub 测试
- `apps/web/src/components/base/*`（X 图标就地复用线性 SVG 模式，不抽新组件——仅一处使用，YAGNI）
- 后端 / API / openapi.yaml
