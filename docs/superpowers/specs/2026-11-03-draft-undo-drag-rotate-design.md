# 草稿白板：题图拖入 / 撤销重做 / 旋转 — 设计文档

日期：2026-11-03
状态：已确认（2026-11-03 用户拍板三项范围：鼠标+iPad 手指拖拽、只用 `Ctrl+Shift+Z` 做重做、旋转只作用于笔迹与图形）

关联：

- PRD §7.12（草稿白板）——本设计**修订**该节，原文「不做撤销/重做」删除
- `docs/superpowers/specs/2026-09-08-draft-paste-image-design.md`——其「不做旋转」由本设计取代（该文件是历史记录，不回改）
- `docs/superpowers/plans/2026-09-09-draft-shape-tools.md` §2.1——图形落笔即拍平为点列，本设计沿用它（不引入形状对象）

## 1. 背景与目标

草稿白板（`DraftWhiteboard`）已具备：手写 / 点 / 橡皮 / 选中（点选·框选·拖动·Delete）/ 圆规 / 直线 / 矩形 / 椭圆 / 三角形、清空、剪贴板粘贴图片、拖入图片文件、贴图的移动 / 四角等比缩放 / 删除。三个缺口：

1. **题图只能截图再粘贴**：真题、训练题里的几何图/电路图是题干自带的，学生要把图拖进草稿照着标注；iPad 上先截图再粘贴非常折腾。
2. **画错只能擦**：一笔画歪得整条擦掉重画；误触「清空」直接全丢，没有任何找回路径。
3. **图形没有方向**：矩形/椭圆/三角形只能轴对齐，画斜置的矩形只能手描。

目标：

- 题干/材料图片用鼠标或手指直接拖进草稿，落在松手位置。
- 每一次内容变更都可撤销、可重做，含误触清空。
- 选中的笔迹/图形可绕选区中心旋转，Shift 吸附 15°。

非目标（本次不做）：贴图旋转、裁剪、草稿导出图片、localStorage 持久化、形状对象模型（事后改顶点/半径）、`Ctrl+R` 快捷键（见 §5.4）。

## 2. 方案选型

### 2.1 历史记录：快照 + 结构共享 + 写时复制（选定）

| 方案 | 结论 | 理由 |
|---|---|---|
| **快照列表 + 结构共享** | 选定 | 快照只复制 `strokes[]` / `images[]` 两个数组，元素对象共享；50 步的额外内存是数组槽位（KB 级） |
| 每次全量深拷贝 | 否决 | 一份 3 万点的草稿单步 ≈ 2MB，50 步 ≈ 100MB，iPad 上不可接受 |
| 命令模式（正/逆操作） | 否决 | 移动、旋转、橡皮整段、批量删除、清空都要写逆运算；分支多、漏一个就是静默数据损坏 |

结构共享的前提是**只读不变量**（§3.2）：进了历史快照的 `Stroke` 不能再被原地改。

### 2.2 旋转：点列绕选区中心旋转（选定）

| 方案 | 结论 | 理由 |
|---|---|---|
| **点列整体旋转** | 选定 | 笔迹本就是点列，旋转点列精确且不改数据结构；手写、圆规弧、三角形一并获得旋转能力 |
| 引入 Shape 对象模型 | 否决 | 要重写渲染 / 橡皮命中 / 选中 / 持久化四条管道，且发明了「图形可再编辑」这类本期没要求的能力 |
| 重新采样（按角度重算几何） | 否决 | 只对参数化图形成立，手写笔迹无法重采样 |

### 2.3 题图拖入：统一指针拖拽（选定）

| 方案 | 结论 | 理由 |
|---|---|---|
| **指针事件自绘幽灵图** | 选定 | 一套代码同时覆盖鼠标、触屏、手写笔；iPad 横屏是本项目主断点 |
| HTML5 原生拖拽（dragstart/drop） | 否决 | iPad Safari 触摸不触发原生拖拽（手指拖 `<img>` 只会滚动/弹系统菜单） |

## 3. 数据模型

### 3.1 `DraftImage.dataUrl` → `DraftImage.src`

贴图来源从「只有本地文件」变成「本地文件 + 题干图片地址」，字段名要能表达 URL：

```ts
export interface DraftImage {
  id: string;
  src: string;   // 原 dataUrl；现在可以是 data: 或 /assets/... 或 http(s)
  x: number; y: number;
  w: number; h: number;   // 显示宽高（CSS px）
}
```

不改结构、只改字段名。草稿不落盘（内存 Map），**无数据迁移**；改所有引用点（`DraftImageLayer`、`draft-image-utils`、测试）。

### 3.2 历史快照与只读不变量

```ts
export interface DraftState {
  strokes: Stroke[];
  images: DraftImage[];
}
```

- 快照复制数组、**共享元素对象**。
- **不变量**：已经被推进历史的状态里的 `Stroke` / `DraftImage` 对象一律只读。
  - `Stroke.points` 的点对象同样只读。
  - 违反点只有两个：**选中移动**、**旋转**（这两个手势原本就原地改坐标）。它们必须在**起手时先克隆**选中的笔迹（点对象逐个新建 + `center` 新建），把克隆替换进 `strokesRef` 与选区，之后只改克隆。
  - 其余操作天然产新对象/新数组：落笔追加、图形提交（push 新 Stroke）、橡皮（`filter` 产新数组）、Delete（`filter`）、清空（换空数组）、贴图插入/移动/缩放/删除（`map`/`filter` 产新对象）。
- 因此「是否变化」可用**元素引用比较**判定（同下标对象同一引用即未变），不需要深比较。

### 3.3 `draft-history.ts`（新增模块）

```ts
const MAX_STATES = 51;            // 1 个初始态 + 最多 50 步撤销

getHistory(key): { states: DraftState[]; index: number } | undefined
initHistory(key, initial: DraftState): void   // 已有历史则不动（关面板再开要保留）
pushState(key, state: DraftState): boolean    // 返回是否真的入栈
undo(key): DraftState | null
redo(key): DraftState | null
canUndo(key): boolean
canRedo(key): boolean
clearHistory(key): void
```

`pushState` 语义（顺序不可换）：

1. 与 `states[index]` 比较：`strokes` 长度与逐项引用全同、`images` 同样全同 → 视为无变化，返回 `false`，不入栈。
2. 截断 `states`：`states.length = index + 1`（撤销后做新操作，重做栈作废）。
3. `states.push(state)`；`index = states.length - 1`。
4. 超过 `MAX_STATES`：`states.shift()`、`index -= 1`（丢最旧，不影响当前内容）。

`undo`：`index > 0` → `index -= 1`，返回 `states[index]`；否则 `null`。
`redo`：`index < states.length - 1` → `index += 1`，返回 `states[index]`；否则 `null`。

### 3.4 历史生命周期

- 按 `questionId` 存在模块级 Map（与 `draft-store` 同键），**关面板再开保留**、切题天然隔离。
- `draft-store.clearDraft(key)` 追加调用 `clearHistory(key)`：提交答案后历史随草稿一起清。否则同一题重做时，撤销会复活上一轮已提交的草稿。
- 不落 localStorage：刷新即丢（与草稿本体一致）。
- `persist=false` 的本地模式同样有历史（纯内存），只是不写 store。

## 4. 撤销 / 重做行为规范

### 4.1 记一步的时机（粒度 = 一次手势）

| 操作 | 打点时机 | 备注 |
|---|---|---|
| 手写笔 / 点 | `handlePointerUp`（`drawingRef` 由 true 转 false 后） | 一笔一步；点按单点也是一步 |
| 圆规弧 / 整圆按钮 / 直线 / 矩形 / 椭圆 | `commitShapeStroke` 内（提交后） | 三角形「确认」、圆规扫满一周都走这里 |
| 橡皮 | 橡皮手势 `pointerup` 时，若本次划过至少擦掉一条 | 一次划过擦 5 条 = 一步，撤销一起回来 |
| 选中移动 | `selectUp` / `cancelSelect`，若总位移 ≠ 0 | 圈内空腔拖动也算 |
| 旋转 | 旋转手势抬手，或手势被系统打断按当前角度落定时，若角变 ≠ 0 | |
| 贴图插入 | 一次粘贴/一次拖入/一次拖拽插入完成后 | 一次粘 3 张 = 一步（批量粘贴在插入循环结束后 push 一次） |
| 贴图移动 | 走选中移动，同上 | |
| 贴图缩放 | `DraftImageLayer` 缩放手势 `pointerup`，若尺寸变 | 新增 `onCommit` 回调 |
| 贴图删除 | 删除钮点击后 / Delete 键批量删后 | |
| 清空 | 清空按钮点击后 | **可撤销** |

### 4.2 快捷键

| 键 | 行为 |
|---|---|
| `Ctrl+Z` / `Cmd+Z` | 撤销 |
| `Ctrl+Shift+Z` / `Cmd+Shift+Z` | 重做 |
| `Ctrl+Y` | 重做（Windows 习惯） |
| `Ctrl+R` / `Cmd+R` | **不绑定**，保持浏览器/Electron 的刷新 |

- 监听在 `document` 的 `keydown`，组件挂载期生效（组件随草稿面板/草稿 tab 条件挂载，不会在不可见时偷按键）。
- `isEditableTarget(e.target)` 为真时全部放行（在题目输入框里按 Ctrl+Z 要撤销文字）。
- 手势进行中忽略：`drawingRef`、`selectGestureRef`、`shapeGestureRef`、`triDragRef !== null`、`compass.phase` 为 `placing`/`resizing`/`drawing` 时不响应，避免把半截手势写进历史。
- 命中时 `preventDefault()`。

### 4.3 执行撤销/重做

1. `snap = undo(key)`；为 `null` 直接返回。
2. `strokesRef.current = snap.strokes`；`imagesRef.current = snap.images`；`setImages(snap.images)`。
3. **清空选区**（笔画按对象引用、贴图按 id 两套都清）——撤销后旧引用已失效。
4. `persist` 为真时写回 store：`setDraft(key, snap.strokes)` + `setDraftImages(key, snap.images)`。
5. `redraw()`。
6. 工具不变；圆规 / 三角形的**工具态**不重置（它们不是草稿内容）。

### 4.4 按钮

工具栏右端、清空按钮左侧新增「撤销 / 重做」两个 38×38 线性图标按钮：

- 不可用时 `disabled` + `opacity-40` + `cursor-not-allowed`。
- `title`/`aria-label` 写明快捷键（「撤销（Ctrl+Z）」）。
- 按钮状态由组件内的 `historyVersion` 计数器驱动（每次 push/undo/redo 自增），渲染时现算 `canUndo/canRedo`。

### 4.5 清空改为可撤销

`handleClear` 不再调 `clearDraft`（那会连历史一起清），改为：

```ts
strokesRef.current = [];
imagesRef.current = []; setImages([]);
if (persist) { setDraft(key, []); setDraftImages(key, []); }
// 圆规/三角形/选区重置（现状保留）
pushState(key, { strokes: [], images: [] });
```

`clearDraft`（父组件提交答案 / 换题清理）保持「内容 + 历史」双清。

## 5. 题干图片拖入

### 5.1 拖源：`MarkdownImg` 新增 `dragToDraft`

- 只有 `QuestionRunner` 的**题干**与**材料**启用；提示、解析、参考答案里的图不启用（避免误拖）。
- 启用时该 `<img>`：
  - `draggable={false}`（否则桌面浏览器先起原生拖拽，指针事件被抢）
  - `style={{ touchAction: 'pan-y', WebkitTouchCallout: 'none', userSelect: 'none' }}`
  - `onPointerDown` 记录起点（忽略 `!e.isPrimary`），`setPointerCapture`，不改 `zoomable` 的点击放大行为
  - 传给 `beginImageDrag` 的 `src` 是 `resolveAsset(src)` 后的地址（与显示同源，与 §5.3 落库一致）
- 移动超过 **10px** 才算拖拽并调用 `beginImageDrag`；不超过 → 松手仍是点击 → 原放大浮层照常打开。
- 拖拽结束后 300ms 内的 `click` 被吞掉（模块级 `wasJustDragged()`），避免松手顺带触发放大。

### 5.2 拖拽模块 `draft-image-drag.ts`（新增）

```ts
interface DropTarget {
  el: HTMLElement;                                   // 命中判定用其 getBoundingClientRect（= canvas）
  onHover: (over: boolean) => void;                  // 草稿区高亮
  onDrop: (src: string, pt: { x: number; y: number }) => void;  // pt = board 坐标
}
registerDropTarget(t: DropTarget): () => void        // 返回注销函数
beginImageDrag(opts: { src: string; pointerId: number; clientX: number; clientY: number }): void
wasJustDragged(): boolean
```

实现要点：

- 幽灵图：`document.body` 下 `position: fixed` 的 `<div>`（`pointer-events:none; z-index:9999`），内含 `<img>`，宽 96px、等比、`opacity:.75`、圆角+阴影，居中于指针（`translate(-50%,-50%)`）。`aria-hidden="true"`。
- 监听 `window` 上的 `pointermove` / `pointerup` / `pointercancel`（capture）。拖动源元素已经 `setPointerCapture`，事件仍会冒泡到 window。
- 指针进入某目标矩形 → 调 `onHover(true)` 并记住当前目标；离开 → `onHover(false)`。多个目标重叠时取**最后注册**的（后挂载的在上层）。
- `pointerup`：命中目标则调 `onDrop(src, {x: clientX - rect.left, y: clientY - rect.top})`；先清幽灵图与 hover 态，再回调。
- `pointercancel`（触摸被系统手势/滚动接管）→ 取消，不插入。
- `Escape` → 取消。
- 模块内只保留一个进行中的拖拽；再次 `beginImageDrag` 先取消旧的。

### 5.3 落点与新贴图

- `DraftWhiteboard` 在挂载期注册 drop target：`el = canvasRef.current`（canvas 就是画板坐标原点，`scroll-y` 模式下它的 `getBoundingClientRect()` 已含滚动偏移，与 `pointFromEvent` 同口径）。
- 新增 `draftImageFromSrc(src, boardW, boardH, at)`：
  - `new Image()` 解码取自然尺寸；失败 `console.warn` 且不插入（与现有文件插入同策略，不弹 toast）。
  - `w = min(round(boardW * 0.6), naturalWidth)`，`h = round(w / naturalWidth * naturalHeight)`。
  - `x = clamp(round(at.x - w / 2), 0, max(0, boardW - w))`，`y` 同理用 `boardH`。
  - `src` 存 `resolveAsset` 后的地址（`/assets/...` 或原 `http`/`data`），**不复制成 base64**。
- 落点在画板外（例如松手在工具栏上）：不插入。
- 解码期间切题（`questionIdRef` 变化）→ 放弃插入（沿用现有贴图插入的竞态防护）。
- 插入后 `pushState` 一次（一次拖入 = 一步）。

### 5.4 与既有行为的冲突点

| 冲突 | 处理 |
|---|---|
| 图片点击放大 | 10px 阈值内仍是点击；拖拽后 300ms 吞 click |
| 页面纵向滚动 | `touch-action: pan-y` 只拦横向拖拽；纵向滑动仍滚页面 |
| iPad 长按系统菜单 | `-webkit-touch-callout: none` |
| 桌面原生图片拖拽 | `draggable={false}` |
| `Ctrl+R` 是刷新 | 不绑定，重做用 `Ctrl+Shift+Z` / `Ctrl+Y` |

## 6. 旋转

### 6.1 手柄几何

- 仅在 `tool === 'select'` 且 `selectedStrokesRef.size > 0` 时绘制。
- 旋转中心：
  - 默认 = 选中笔迹包围盒的**并集**中心 `(cx, cy)`（`strokeBounds` 逐个求并集）；
  - **单选一条直线（恰好 2 个点的笔迹）**时改用 §6.4 选中的候选点（默认中点；单选一条直线时中点 = 包围盒中心，行为与默认一致）。
- 手柄位置：
  - 默认在包围盒上方 26px：`(cx, y0 - 26)`；
  - 若 `y0 < 48`（上方空间不足）→ 改到下方 `(cx, y1 + 26)`。
- 手柄本体：半径 6px 实心圆（`--brand-500`）+ 中心小孔（背景色）→ 观感是「可抓的旋钮」；一条 1px `--brand-500` 竖线从框边连到旋钮。
- 命中半径 **20px**（iPad 手指）；命中优先于元素命中（先判手柄，再判笔画/贴图）。
- 光标：悬停手柄 `grab`，拖动中 `grabbing`，其余沿用现有 `grab`/`default` 规则。
- 拖动中在手柄旁显示角度读数 `${Math.round(total * 180 / Math.PI)}°`（12px，`--text-tertiary`），与圆规的半径读数同风格。

### 6.2 手势状态机

```
select 且 有选中笔迹 → 按在手柄命中区 → rotate(旋转)
  move：total = 指针极角 - 起手极角（Shift → 吸附 15°）→ 从原始点列重算 → redraw
  up  ：|total| < 0.5° → 不记历史、不落盘；否则落盘 + 记一步，选区保留
  cancel/lostcapture/两指平移接管：按当前角度落定——落盘 + 记一步（|total| < 0.5° 则不记），行为与选中移动的 cancel 一致
```

```ts
type RotateGesture = {
  kind: 'rotate';
  cx: number; cy: number;
  a0: number;                        // 起手极角
  total: number;                     // 当前累计角（rad）
  items: Array<{
    stroke: Stroke;                  // 克隆后的笔迹
    ox: number[]; oy: number[];      // 克隆前的点坐标快照（每帧从它重算，避免逐帧累积误差）
    oc?: { x: number; y: number };   // 圆心标记原始位置
  }>;
};
```

起手时：按 §3.2 克隆选中笔迹 → 替换 `strokesRef` 中对应下标 → 用克隆重建选区 → 记录原始点列。

每帧：

```
p.x' = cx + (ox - cx) * cos(θ) - (oy - cy) * sin(θ)
p.y' = cy + (ox - cx) * sin(θ) + (oy - cy) * cos(θ)
```

`center` 标记同样旋转；`size` 不变。

### 6.3 交互边界

- 旋转后笔迹仍是普通 `Stroke`：可继续移动、擦除、再旋转（从当前点列再算）。
- 混合选区（笔迹 + 贴图）：旋钮只转笔迹，贴图原地不动（本次范围）；贴图仍可移动/缩放/删除。
- 纯贴图选区：不出现旋钮。
- 包围盒退化（水平/竖直线）：中心落在线上，仍可旋转。
- 选中框的虚线包围盒、框选、拖动移动、Delete 的现有行为不变。

### 6.4 旋转中心（直线 / 矩形，可调）

只有**单选一条笔迹**时提供；其它图形仍绕包围盒中心（后续按图形逐个补齐），多选时不出现候选点。

| 图形 | 判定 | 候选点 |
|---|---|---|
| 直线 | 恰好 2 个点的笔迹 | 起点、中点、终点（3 个） |
| 矩形 | 凸包恰好 4 个角点 + 四角均为直角 + 所有点贴在四条边 + **每条边都有连续的点**（最大空隙 ≤ 35% 边长） | 中心 + 四角（5 个） |

矩形判定写在 `draft-shape-pivots.ts`（纯几何、可单测）：笔迹是采样点列没有形状对象，只能反推。
`<= 0` 的共线剔除让工具画的矩形凸包正好是 4 个角；已旋转过的矩形同样成立（凸包随图形转）。
开口图形（U 形缺一条边）凸包也是 4 点，靠"每条边的最大空隙"排除；椭圆/三角形/手写凸包顶点数不对，直接出局。

- **候选点样式**：空心圆（半径 4.5px，1.5px `--brand-500` 描边、背景色填充）= 可选；实心 + 中心小孔 = 当前生效。默认生效的是选区包围盒中心 —— 对直线是线段中点，对矩形正好是矩形中心，与旧行为一致。
- **命中半径 16px**，多点重叠时取**最近**的那个（短线/小矩形上的点挨得近，不能永远命中排在前面的）。
- **点选 / 拖动分流**（关键）：候选点压在图形上，与"抓住图形拖走"争夺同一块区域。因此按下时**不立即换中心**，而是照常起移动手势并记下候选点坐标；抬手时若**完全没位移**才把它设为旋转中心，一旦位移就按普通移动处理。这样候选点上按一下 = 换中心，按住拖 = 移动图形。
- 点选中心**不记历史、不落盘**（它不是内容变更）。
- **用坐标记录中心，不用候选点编号**：矩形转过一次后角点的"名字"会换位，坐标不会（绕角点转时该点本来就不动）。记录里带笔迹对象做身份：
  - 换了另一条笔迹 → 自动失配，退回默认中心；
  - 移动 / 旋转会克隆笔迹（§3.2 写时复制），两个手势里把这份记录改挂到克隆上，否则转一次中心就丢；**移动时中心坐标跟着平移**（中心是空间点，不跟着走就落在旧位置）。
- 绕端点/角点旋转时该点坐标严格不变（它是旋转中心，公式里 `dx = dy = 0`）；绕中心旋转等价于旧行为。

## 7. 文件改动

| 文件 | 改动 |
|---|---|
| `apps/web/src/components/business/draft-history.ts` | 新增：快照栈、游标、上限、去重 |
| `apps/web/src/components/business/draft-image-drag.ts` | 新增：drop target 注册表、幽灵图、指针拖拽 |
| `apps/web/src/components/business/draft-shape-pivots.ts` | 新增：旋转中心候选点（直线 3 点 / 矩形 5 点），纯几何 + 单测 |
| `apps/web/src/components/business/draft-store.ts` | `DraftImage.dataUrl` → `src`；`clearDraft` 调 `clearHistory` |
| `apps/web/src/components/business/draft-image-utils.ts` | `fileToDraftImage` 字段改名；新增 `draftImageFromSrc` |
| `apps/web/src/components/business/DraftWhiteboard.tsx` | 历史打点、撤销/重做按钮与键盘、旋转手势与手柄、drop target 注册与落点插入、清空改为可撤销 |
| `apps/web/src/components/business/DraftImageLayer.tsx` | `src` 改名；新增 `onCommit`（缩放手势结束 / 删除后回调） |
| `apps/web/src/components/markdown.tsx` | `MarkdownImg` 新增 `dragToDraft`（指针拖源，不改其它渲染配置） |
| `apps/web/src/components/business/answer/QuestionRunner.tsx` | 题干 + 材料用带 `dragToDraft` 的 img 组件；提示/解析保持原样 |
| `docs/K12智学系统-产品需求文档.md` | §7.12 删「不做撤销/重做」，补三条功能（见 §10） |

不涉及后端、API 文档、数据库。

## 8. 边界与错误处理

| 场景 | 行为 |
|---|---|
| 历史为空 / 无可撤销 | 快捷键与按钮都 no-op |
| 撤销后再做新操作 | 重做栈作废（`pushState` 截断） |
| 超过 50 步 | 丢最旧，当前内容不受影响 |
| 切题 / 提交答案 | 切题换 key 天然隔离；`clearDraft` 连历史一起清 |
| 面板关闭再打开 | 内容与历史都保留（模块级 Map） |
| 手势进行中按快捷键 | 忽略，不写入历史 |
| 题图解码失败 | `console.warn`，不插入，不记历史 |
| 拖拽被系统手势打断 | `pointercancel` → 取消，不插入 |
| `persist=false` | 内容与历史都只在内存，切题即清 |
| 早退/卸载 | 幽灵图与 window 监听在 `pointerup`/`cancel`/`Escape` 时清理；`registerDropTarget` 返回的注销函数在 effect cleanup 调用 |

## 9. 测试

自动化（`apps/web` vitest + testing-library）：

1. `draft-history.test.ts`：push 去重、undo/redo 游标、撤销后 push 截断重做、上限丢最旧、clearHistory。
2. `DraftWhiteboard` 增补（沿用 canvas 2d stub 与 pointer 事件构造）：
   - 画两笔 → `Ctrl+Z` → store 只剩一笔；`Ctrl+Shift+Z` → 两笔回来
   - 一次橡皮划过擦两条 → 撤销一次两条都回来
   - 选中移动后撤销 → 点坐标回到原值
   - 画一条水平线 → 全选 → 拖旋转旋钮 90° → 点坐标变成竖直线（误差 < 1px），再撤销回到水平
   - 清空 → 撤销 → 笔迹与贴图都恢复
   - 输入框内按 `Ctrl+Z` 不触发草稿撤销
3. `draft-image-drag.test.ts`：注册/命中/未命中、hover 回调、pointercancel 不落、Escape 取消、`wasJustDragged` 时间窗。
4. `MarkdownImg` 拖源：10px 内不触发、超过触发、拖后 click 不放大（可用 mock `beginImageDrag` 验证调用）。
5. `DraftImageLayer`：`src` 改名后的渲染 + `onCommit` 在缩放结束/删除时触发。

人工验收（iPad 必测，**WebKit 实测**）：

1. 真题页开草稿 → 手指按住题干图横向拖到草稿 → 松手落点正确、宽度约画板 60%，草稿区拖动中出现高亮与幽灵图
2. 轻点题干图仍放大；纵向滑动图片仍滚页面
3. 画 3 笔 → 撤销 2 次 → 重做 1 次，笔迹与顺序正确
4. 橡皮一次划过擦掉多条 → 一次撤销全部回来
5. 清空 → 撤销 → 全部回来
6. 画矩形 → 选中 → 拖旋钮旋转，Shift 吸附到 15° 整数倍，读数正确
7. 关面板再开：内容与撤销栈都在
8. 提交答案后重进同题：草稿与撤销栈都是空的

## 10. PRD §7.12 修订（精确到句）

1. 第 291 行「选中」条目末尾补一句：`选中笔迹/图形后选区上方出现旋转手柄（拖动旋转、Shift 吸附 15°）。`
2. 第 293 行删除「、撤销/重做」，改为：
   `- 工具条以上述九项为基础（图形工具四阶段已全部落地，设计见 \`docs/superpowers/plans/2026-09-09-draft-shape-tools.md\`），不做颜色选择器、笔粗细调节。`
3. 其后新增三条：
   - **撤销/重做**：每一次操作记一步——手写一笔、橡皮一次划过、图形提交、选中移动/旋转、贴图插入/移动/缩放/删除、Delete 删除、清空。`Ctrl/Cmd+Z` 撤销，`Ctrl/Cmd+Shift+Z` 或 `Ctrl+Y` 重做（不占用 `Ctrl+R`，它是刷新）；工具栏同时提供按钮（iPad 无键盘）。历史上限 50 步、随题保存在内存，提交答案后随草稿一起清空。
   - **题干图片拖入**：题干与材料中的图片可用鼠标或手指直接拖入草稿，落点为放置位置、宽为画板宽 60%（等比，原图更小按原图）；拖入后与粘贴贴图同权（移动/四角等比缩放/删除）。提示与解析中的图片不提供拖入。
   - **旋转**：选中笔迹或图形后拖动选区上方的旋转手柄，绕选区中心旋转，按住 Shift 吸附 15°；旋转结果仍是普通笔迹（可继续擦除/移动/再旋转），贴图不参与旋转。

## 11. 不做 / 后续可开

- 贴图旋转（含整组旋转贴图 + 其上手写标注）
- 贴图裁剪、图层顺序调整
- 草稿导出为图片
- 草稿与历史落 localStorage / 服务端
- 形状对象模型（事后改顶点、改矩形宽高、改圆半径）
- 撤销粒度细化到「单个点」或「擦除其中一条」
