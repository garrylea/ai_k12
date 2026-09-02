# 数学答题草稿白板 · 设计文档

日期：2026-09-02
状态：已与用户逐节确认
需求来源：PRD §7.12（本次同步新增）、§8、§15 远期方向
关联计划：`2026-09-02-draft-whiteboard.md`（实施计划）

## 1. 背景与目标

学生做数学题需要演算草稿。最终答案仍以 LaTeX 文本提交，草稿白板仅作演算辅助，**不参与判题、不依赖手写识别**。

核心用户旅程：读题 → 手写演算 → 得出结果 → **一边看草稿、一边打字输入 LaTeX** → 看预览确认 → 提交。

由此推出核心设计约束：**草稿必须与输入框同屏可见**（照着抄），因此草稿不覆盖输入框，而是与右侧预览区分时复用。

## 2. 交互设计（已确认）

### 2.1 右侧 tab 化

答题区右半区（原 LatexPreview）顶部加 tab 栏，「预览 | 草稿」分时复用同一内容区：

```
┌────────────┬──────────────┐
│            │ [预览] 草稿   │ ← tab 栏（新增）
│ LatexEditor│ ┌──────────┐ │
│ (保持不变)  │ │ 内容区    │ │ ← 预览=原LatexPreview / 草稿=DraftWhiteboard
│            │ └──────────┘ │
└────────────┴──────────────┘
```

- tab 状态为组件局部 useState，默认「预览」。
- 切换 tab 不清空草稿；LatexPreview 原样保留（切回即渲染当前 answer）。

### 2.2 白板工具条

三个线性 SVG 图标按钮（遵循项目图标规范：`fill="none" stroke="currentColor"`，禁 emoji）：

- **手写笔**：默认选中，radio 行为，与橡皮互斥；选中态用 `--brand-500` 边框/背景高亮。
- **橡皮**：仅当草稿图层存在（即草稿 tab 激活）时可用——在本方案中天然成立（工具条只在草稿 tab 内渲染），无需禁用态逻辑。橡皮划过某条笔画任意位置，该笔画整条消失（笔画级）。
- **清空**：即时动作，一键清除当前题全部草稿，无确认弹窗（草稿重写成本低）。

### 2.3 行为规则（已确认）

| 规则 | 行为 |
|---|---|
| 随题存在 | 切 tab、关/开答题弹窗均保留；**提交后清空**；切题后不保留（各题隔离） |
| 笔迹颜色 | 不存具体色值，渲染时读当前主题 CSS 变量（日间深色 / 夜间浅色），主题切换自动重绘换色 |
| 输入源 | 鼠标、触屏、硬件手写笔统一走 Pointer Events；`e.pressure` 传入平滑库实现笔锋 |
| 学科范围 | 仅数学显示草稿 tab；其它学科右半区保持纯预览 |

## 3. 技术方案

### 3.1 依赖

新增 `perfect-freehand`（MIT，无传递依赖）——输入点序列（含 pressure）输出平滑笔画轮廓多边形，业界标准手写方案。压感映射：`thinning` 参数 + 逐点 pressure，硬件笔产生粗细渐变笔锋；鼠标/触屏 pressure 恒 0.5，输出均匀粗细。

### 3.2 数据结构

```ts
interface DraftPoint { x: number; y: number; pressure: number; }  // CSS 像素坐标，左上原点
interface Stroke { points: DraftPoint[]; size: number; }          // size 基准 ~3，压感 0.5x~1.5x
type Draft = Stroke[];
```

### 3.3 草稿存储（模块级缓存）

`draft-store.ts`：模块级 `Map<string, Draft>`（React state 之外，弹窗卸载不丢数据）。

- key（questionId）构造：
  - AnswerModal：`card-{cardId}-q-{q.n}`（跨弹窗实例稳定，关/开保留）
  - CleanupPhase：`err-{errorBookId}`（错题唯一）
- API：`getDraft(key)` / `setDraft(key, draft)` / `clearDraft(key)`
- 提交后清空：父组件在 handleSubmit 里调 `clearDraft(questionId)`
- 切题隔离：不同 key 天然隔离，无需清理
- 不持久化到 localStorage / 后端（YAGNI，页面刷新丢失可接受）

### 3.4 组件

**`src/components/business/DraftWhiteboard.tsx`**

```
┌─────────────────────────────┐
│ [笔] [橡皮] [清空]           │ ← 工具条
│  ┌───────────────────────┐  │
│  │ canvas（DPR 适配）      │  │ ← touch-action:none; pointerdown/move/up
│  └───────────────────────┘  │
└─────────────────────────────┘
```

Props：`{ questionId: string }`。内部持有 strokes 状态（useRef + 强制重绘，绘制过程不走 React 渲染以保证 60fps）。

绘制流程：
1. `pointerdown`：setPointerCapture，开新 stroke。
2. `pointermove`：push 点（含 pressure），实时生成当前笔画路径直接画（增量）。
3. `pointerup`：固化 stroke，写回 draft-store。

橡皮：pointermove 时对每条 stroke 做点到折线距离检测（阈值 = size/2 + 8px），命中即删除该条并全量重绘。

渲染：
- canvas 尺寸 = 容器 clientWidth/Height × devicePixelRatio，ctx.scale(dpr)。
- ResizeObserver 监听容器尺寸变化 → 重设 canvas 并全量重绘（坐标用 CSS 像素存储，弹窗尺寸基本固定，不做归一化）。
- 颜色：绘制/重绘时 `getComputedStyle` 读 `--text-primary`；订阅 zustand themeStore，主题变化时全量重绘。
- 全量重绘策略：草稿通常 <100 条笔画，性能足够，不做脏矩形优化。

**`src/components/business/PreviewDraftPanel.tsx`**（tab 容器）

Props：`{ answer: string; questionId: string; enabled: boolean }`（enabled = 学科是否为数学）。
- enabled=false：直接渲染 `<LatexPreview value={answer} />`（现状不变）。
- enabled=true：渲染 tab 栏 + 内容区（预览 / 草稿）。

### 3.5 接入点（两处）

| 文件 | 变更 |
|---|---|
| `AnswerModal.tsx` L253-255 | 右半区改用 `<PreviewDraftPanel answer={answer} questionId={...} enabled={isMath} />`；`handleSubmit` 内调 `clearDraft` |
| `CleanupPhase.tsx` L189-191 | 同上；`handleSubmit` 内调 `clearDraft` |

isMath 判定：实现时从 `services/api.ts` / subjects 约定确认数学标识（subjectId 或 code），两处接入点均有 subjectId prop。

### 3.6 明确排除（YAGNI）

撤销/重做、颜色选择器、笔粗细调节、图形识别、手写转 LaTeX（PRD §15 远期）、草稿后端持久化、笔画像素级擦除、可拖动浮层。

## 4. 测试

apps/web 无测试框架，采用人工验收清单：

1. 鼠标绘制：笔画平滑、无锯齿、均匀粗细。
2. 触屏（iPad）：单指书写正常，画布不触发页面滚动。
3. 硬件笔（如有 Apple Pencil）：压感笔锋可见（轻重笔迹粗细不同）。
4. 橡皮：划过笔画整条消失；不误删邻近笔画。
5. 清空：一键清空全部。
6. 切 tab 保留：草稿 → 预览 → 草稿，笔迹还在。
7. 关/开弹窗保留：关闭 AnswerModal 重开，同题草稿还在。
8. 提交后清空：提交某题后该题草稿清空。
9. 切题隔离：题 A 草稿不影响题 B。
10. 日/夜主题：笔迹颜色自动切换，对比度正常。
11. iPad 横屏（>=1024px）主断点下布局正常。
12. 非数学学科：右半区无草稿 tab。
