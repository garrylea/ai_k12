# 草稿白板粘贴图片 — 设计文档

日期：2026-09-08
状态：已确认（方案 A + 默认交互五条，用户拍板）

## 需求

在草稿组件（`DraftWhiteboard`）中支持插入图片：

- **入口**：剪贴板粘贴（Cmd/Ctrl+V）+ 拖拽图片文件到草稿区域
- **展示**：图片作为绝对定位 div 显示在草稿画布中
- **操作**：可移动、可缩放（四角控制点等比）、可删除
- **初始尺寸**：宽 = 画板宽 × 60%（等比，原图更小则按原图），落在当前可视区域中央
- **核心场景**：学生把题目配图贴进草稿，在图上标注演算（笔迹永远画在图片上方）

## 方案选型

选定 **方案 A：DOM 图片层 + 新增「移动」工具**（备选方案 B「图片画进 canvas」被否，理由：手写命中检测/缩放手柄工作量大、DPR 细节多，且 MVP 无导出草稿需求）。

要点：canvas（笔迹）在上、图片层在下，笔迹自然覆盖图片可标注；交互冲突（点的是图还是笔）用工具切换解决，对 iPad 触屏可靠。

## 组件结构

```
wrap（滚动容器，现结构不变）
  board（relative）
    ├─ 图片层 div（absolute inset-0，z 较低）          ← 新增
    │    └─ 每张图：absolute div（x/y/w/h 定位，含 <img>）
    └─ canvas（笔迹，absolute inset-0，z 更高）        ← 现有
```

- 工具条扩为 **笔 / 橡皮 / 移动** 三档，默认笔（现状不变）
- 笔 / 橡皮档：图片层 `pointer-events: none`，canvas 行为与现在完全一致
- 移动档：canvas `pointer-events: none`（scroll-y 模式两指滚动交还浏览器原生滚动），图片可交互

## 交互细节

| 操作 | 行为 |
|---|---|
| 粘贴 | `document` 级 `paste` 监听，挂载期生效（DraftWhiteboard 随抽屉/面板条件挂载，生命周期 = 草稿可见期）；目标为输入框/可编辑元素时放行；从 `clipboardData.items` 取图片文件 |
| 拖入 | wrap 上 `onDragOver`（preventDefault）+ `onDrop`，读 `dataTransfer.files` 中的图片 |
| 初始尺寸 | 宽 = board 宽 × 60%，等比（原图更小按原图）；位置 = 当前可视区域中央（scroll-y 模式含 scrollTop 偏移）；可叠多张 |
| 压缩 | 最大边 > 1600px 先在离屏 canvas 缩到 1600 再转 data URL（内存保护） |
| 移动 | 按住图片拖动（`setPointerCapture`，支持触屏） |
| 缩放 | 选中后四角控制点对角拖拽，等比，最小 40px |
| 删除 | 选中图片右上角 × 按钮 + Delete/Backspace（keydown 同样检查非输入态） |
| 橡皮 | 只擦笔迹，不删图片 |
| 清空草稿 | 笔迹 + 图片一起清 |

图片 id 用 `crypto.randomUUID()`。

## 数据模型（draft-store.ts）

不动 `Stroke` 既有签名，并行扩展：

```ts
export interface DraftImage {
  id: string;      // crypto.randomUUID()
  dataUrl: string; // 压缩后的 data URL
  x: number; y: number;   // 相对 board（与笔迹同坐标系；scroll-y 模式 y 可超一屏）
  w: number; h: number;   // 显示尺寸（CSS px）
}
// 新增 getDraftImages / setDraftImages；clearDraft 同时清两个 map
```

- 持久化跟随现有约定（PRD §7.12）：
  - `persist=true`（PreviewDraftPanel）：拖动/缩放**结束时**写 store（与笔迹"落笔画、抬笔存"节奏一致），切题加载，提交后由父组件 `clearDraft` 一并清
  - `persist=false`（DraftDrawer）：纯本地 state，`key=questionId` remount 即清
- 图片渲染用 React state（拖动实时更新），不进 canvas 重绘路径

## 视觉

- 图片容器 `rounded-lg` + 细边框；选中态边框 `var(--brand-500)` + 四角控制点（10px，同色）；× 删除钮随选中态出现
- 移动工具图标：四向箭头线性 SVG；无 emoji；配色全走 CSS 变量（暗色主题自动适配）

## 边界与不做

- 图片与笔迹 Z 序固定（笔迹恒在上）；多图之间 Z 序 = 粘贴顺序，不做图层调整
- 不做旋转、裁剪
- 不做草稿导出为图片
- 不持久化到 localStorage（与现有草稿一致，刷新即丢）

## 涉及文件

| 文件 | 变更 |
|---|---|
| `apps/web/src/components/business/draft-store.ts` | 新增 `DraftImage` 类型 + `getDraftImages`/`setDraftImages`；`clearDraft` 清双 map |
| `apps/web/src/components/business/DraftWhiteboard.tsx` | 图片层、移动工具、粘贴/拖入/拖动/缩放/删除交互、清空含图片 |

调用方（DraftDrawer / PreviewDraftPanel / QuestionRunner 的 clearDraft）接口不变，无适配成本。

## 测试

`apps/web` 暂无测试框架（CLAUDE.md）；人工验证清单：

1. 答题页开草稿抽屉 → 截图 Cmd+V → 图片落在可视区中央、宽 60%
2. 移动工具拖动图片、四角缩放（等比、最小 40px）、× 删除、Delete 键删除
3. 切回笔工具在图片上写字 → 笔迹覆盖图片
4. 橡皮只擦笔迹；清空按钮笔迹图片一起清
5. 拖图片文件进草稿区域
6. PreviewDraftPanel 场景：切 tab 回来图片还在；提交后清空
7. 暗色主题下边框/控制点配色正常
