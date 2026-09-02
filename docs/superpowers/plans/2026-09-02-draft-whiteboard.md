# 草稿白板 Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** 数学答题右半区增加「预览 / 草稿」tab，草稿白板支持手写笔（压感平滑）/ 笔画级橡皮 / 清空，随题存在。

**Architecture:** 新增 `perfect-freehand` 依赖；`draft-store.ts` 模块级 Map 缓存草稿（弹窗卸载不丢）；`DraftWhiteboard.tsx` canvas 手写组件（Pointer Events + DPR 适配 + 主题自适应重绘）；`PreviewDraftPanel.tsx` tab 容器分时复用右半区；接入 `AnswerModal` 与 `CleanupPhase`。

**Tech Stack:** React 18 + TypeScript + Tailwind + CSS 变量主题 + perfect-freehand + Pointer Events API。

**设计文档:** `docs/superpowers/plans/2026-09-02-draft-whiteboard-design.md`（含已确认的交互决策）

**测试说明:** apps/web 无测试框架，每任务以 `npm run lint` + `npm run build` 验证，最后人工验收（Task 8 清单）。

---

### Task 1: 安装 perfect-freehand

**Files:** Modify `apps/web/package.json`（经 npm 自动）

**Step 1:** 在 `apps/web/` 执行：

```bash
npm install perfect-freehand
```

**Step 2:** 确认 package.json dependencies 出现 `perfect-freehand`（^1.2.x，无传递依赖）。

**Step 3:** Commit

```bash
git add apps/web/package.json apps/web/package-lock.json
git commit -m "feat(web): add perfect-freehand dependency for draft whiteboard"
```

---

### Task 2: draft-store 模块级草稿缓存

**Files:** Create `apps/web/src/components/business/draft-store.ts`

**Step 1:** 写实现（React state 之外的内存缓存，弹窗卸载不丢数据）：

```ts
/** 草稿白板内存缓存：模块级 Map，随题（key）隔离。
 *  生命周期约定（PRD §7.12）：切 tab / 关开弹窗保留；提交后由父组件调 clearDraft；切题天然隔离。 */

export interface DraftPoint {
  x: number;
  y: number;
  pressure: number;
}

export interface Stroke {
  points: DraftPoint[];
  /** 基准笔画宽（CSS px），压感 0.5x~1.5x 映射 */
  size: number;
}

const store = new Map<string, Stroke[]>();

export function getDraft(key: string): Stroke[] {
  return store.get(key) ?? [];
}

export function setDraft(key: string, strokes: Stroke[]): void {
  store.set(key, strokes);
}

export function clearDraft(key: string): void {
  store.delete(key);
}
```

**Step 2:** Run: `cd apps/web && npm run lint && npm run build`
Expected: 均通过。

**Step 3:** Commit

```bash
git add apps/web/src/components/business/draft-store.ts
git commit -m "feat(web): add draft-store in-memory cache keyed by question"
```

---

### Task 3: DraftWhiteboard 手写白板组件

**Files:** Create `apps/web/src/components/business/DraftWhiteboard.tsx`

核心要点（完整实现见下）：

- **数据流**：strokes 存 `useRef`（绘制不走 React 渲染保 60fps），每次变更后同步 `setDraft(questionId, strokes)`；`questionId` 变化（切题）时重载 + 重绘。
- **绘制**：`pointerdown` 开新笔画（`setPointerCapture`）；`pointermove` push 点并增量画当前笔画；`pointerup` 固化。鼠标 `pointerType==='mouse'` 时 pressure 恒 0.5。
- **橡皮**：笔画级——点到各笔画折线的最近距离 < `size/2 + 8` 则删整条，全量重绘。
- **清空**：清 strokes + `clearDraft` + 重绘。
- **DPR**：canvas 尺寸 = 容器 × devicePixelRatio，`ctx.scale(dpr, dpr)`；ResizeObserver 监听容器变化重设并重绘。
- **主题**：颜色绘制时 `getComputedStyle` 读 `--text-primary`（日间深/夜间浅）；订阅 `useThemeStore(s => s.mode)`，变化时全量重绘。
- **样式**：`touch-action: none`（iPad 书写不滚动页面）；工具条三个线性 SVG 按钮（笔/橡皮互斥高亮，`--brand-500` 选中态；清空为动作按钮）；图标规范 `fill="none" stroke="currentColor" strokeWidth="2"`。

完整代码：

```tsx
import { useEffect, useRef, useState, useCallback } from 'react';
import getStroke from 'perfect-freehand';
import { useThemeStore } from '@/store/themeStore';
import { getDraft, setDraft, clearDraft, type Stroke } from './draft-store';

type Tool = 'pen' | 'eraser';

/** perfect-freehand 轮廓 -> canvas 填充路径 */
function strokePath(ctx: CanvasRenderingContext2D, stroke: Stroke): void {
  const outline = getStroke(stroke.points, {
    size: stroke.size * 2,
    thinning: 0.5,
    smoothing: 0.5,
    streamline: 0.5,
  });
  if (outline.length === 0) return;
  ctx.beginPath();
  outline.forEach(([x, y], i) => (i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y)));
  ctx.closePath();
  ctx.fill();
}

/** 点到线段距离平方（避免开方） */
function distToSegmentSq(px: number, py: number, x1: number, y1: number, x2: number, y2: number): number {
  const dx = x2 - x1;
  const dy = y2 - y1;
  const lenSq = dx * dx + dy * dy;
  let t = lenSq === 0 ? 0 : ((px - x1) * dx + (py - y1) * dy) / lenSq;
  t = Math.max(0, Math.min(1, t));
  const ex = x1 + t * dx - px;
  const ey = y1 + t * dy - py;
  return ex * ex + ey * ey;
}

/** 橡皮命中：点到某笔画折线的最近距离是否在阈值内 */
function hitStroke(stroke: Stroke, x: number, y: number): boolean {
  const threshold = stroke.size + 8;
  const pts = stroke.points;
  if (pts.length === 1) {
    const d = (pts[0].x - x) ** 2 + (pts[0].y - y) ** 2;
    return d <= threshold * threshold;
  }
  for (let i = 1; i < pts.length; i++) {
    if (distToSegmentSq(x, y, pts[i - 1].x, pts[i - 1].y, pts[i].x, pts[i].y) <= threshold * threshold) {
      return true;
    }
  }
  return false;
}

const PEN_BASE_SIZE = 3;

const PenIcon = () => (
  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M12 19l7-7 3 3-7 7-3-3z" />
    <path d="M18 13l-1.5-7.5L2 2l3.5 14.5L13 18l5-5z" />
    <path d="M2 2l7.586 7.586" />
    <circle cx="11" cy="11" r="2" />
  </svg>
);

const EraserIcon = () => (
  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M20 20H7L3 16a1 1 0 0 1 0-1.4L13.6 4a1 1 0 0 1 1.4 0l5 5a1 1 0 0 1 0 1.4L12 18" />
  </svg>
);

const TrashIcon = () => (
  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <polyline points="3 6 5 6 21 6" />
    <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
  </svg>
);

export function DraftWhiteboard({ questionId }: { questionId: string }) {
  const [tool, setTool] = useState<Tool>('pen');
  const strokesRef = useRef<Stroke[]>([]);
  const drawingRef = useRef(false);
  const wrapRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const themeMode = useThemeStore((s) => s.mode);

  const redraw = useCallback(() => {
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext('2d');
    if (!canvas || !ctx) return;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.fillStyle = (getComputedStyle(canvas).getPropertyValue('--text-primary') || '#333').trim();
    for (const s of strokesRef.current) strokePath(ctx, s);
  }, []);

  // 尺寸：DPR 适配 + ResizeObserver
  useEffect(() => {
    const wrap = wrapRef.current;
    const canvas = canvasRef.current;
    if (!wrap || !canvas) return;
    const resize = () => {
      const dpr = window.devicePixelRatio || 1;
      canvas.width = Math.max(1, Math.round(wrap.clientWidth * dpr));
      canvas.height = Math.max(1, Math.round(wrap.clientHeight * dpr));
      const ctx = canvas.getContext('2d');
      ctx?.setTransform(dpr, 0, 0, dpr, 0, 0);
      redraw();
    };
    resize();
    const ro = new ResizeObserver(resize);
    ro.observe(wrap);
    return () => ro.disconnect();
  }, [redraw]);

  // 主题变化：笔迹颜色自适应（不存色值，重绘时读 CSS 变量）
  useEffect(() => { redraw(); }, [themeMode, redraw]);

  // 切题：加载新题草稿并重绘
  useEffect(() => {
    strokesRef.current = getDraft(questionId);
    redraw();
  }, [questionId, redraw]);

  const pointFromEvent = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    return {
      x: e.clientX - rect.left,
      y: e.clientY - rect.top,
      pressure: e.pointerType === 'mouse' ? 0.5 : e.pressure || 0.5,
    };
  };

  const eraseAt = (x: number, y: number) => {
    const before = strokesRef.current.length;
    strokesRef.current = strokesRef.current.filter((s) => !hitStroke(s, x, y));
    if (strokesRef.current.length !== before) {
      setDraft(questionId, strokesRef.current);
      redraw();
    }
  };

  const handlePointerDown = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    const p = pointFromEvent(e);
    if (tool === 'eraser') {
      eraseAt(p.x, p.y);
      return;
    }
    drawingRef.current = true;
    strokesRef.current.push({ points: [p], size: PEN_BASE_SIZE });
  };

  const handlePointerMove = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const p = pointFromEvent(e);
    if (tool === 'eraser') {
      if (e.buttons === 0) return; // 未按下不擦
      eraseAt(p.x, p.y);
      return;
    }
    if (!drawingRef.current) return;
    const stroke = strokesRef.current[strokesRef.current.length - 1];
    stroke.points.push(p);
    // 增量重绘（简单可靠：当前笔画少，全量重绘开销可忽略）
    redraw();
  };

  const handlePointerUp = () => {
    if (!drawingRef.current) return;
    drawingRef.current = false;
    setDraft(questionId, strokesRef.current);
  };

  const handleClear = () => {
    strokesRef.current = [];
    clearDraft(questionId);
    redraw();
  };

  const toolBtn = (t: Tool, label: string, icon: JSX.Element) => (
    <button
      onClick={() => setTool(t)}
      title={label}
      aria-label={label}
      aria-pressed={tool === t}
      className={`w-[38px] h-[38px] rounded-xl border flex items-center justify-center transition-colors ${
        tool === t
          ? 'border-[var(--brand-500)] bg-[var(--brand-100)] text-[var(--brand-500)]'
          : 'border-[var(--bg-subtle)] bg-[var(--learn-card-bg)] text-[var(--text-tertiary)] hover:bg-[var(--bg-subtle)]'
      }`}
    >
      {icon}
    </button>
  );

  return (
    <div className="h-full flex flex-col">
      {/* 工具条 */}
      <div className="shrink-0 flex items-center gap-2 px-3 py-2 border-b border-[var(--bg-subtle)]">
        {toolBtn('pen', '手写笔', <PenIcon />)}
        {toolBtn('eraser', '橡皮', <EraserIcon />)}
        <div className="flex-1" />
        <button
          onClick={handleClear}
          title="清空草稿"
          aria-label="清空草稿"
          className="w-[38px] h-[38px] rounded-xl border border-[var(--bg-subtle)] bg-[var(--learn-card-bg)] flex items-center justify-center text-[var(--text-tertiary)] hover:bg-[var(--bg-subtle)] transition-colors"
        >
          <TrashIcon />
        </button>
      </div>
      {/* 手写画布 */}
      <div ref={wrapRef} className="flex-1 min-h-0 relative">
        <canvas
          ref={canvasRef}
          className="absolute inset-0 w-full h-full"
          style={{ touchAction: 'none', cursor: tool === 'eraser' ? 'cell' : 'crosshair' }}
          onPointerDown={handlePointerDown}
          onPointerMove={handlePointerMove}
          onPointerUp={handlePointerUp}
          onPointerLeave={handlePointerUp}
        />
      </div>
    </div>
  );
}
```

**Step 2:** Run: `cd apps/web && npm run lint && npm run build`
Expected: 通过（注意 TS 对 `getStroke` 入参类型的兼容；perfect-freehand 类型定义 `PerfectFreehandOptions`，若报错将 options 显式标注）。

**Step 3:** Commit

```bash
git add apps/web/src/components/business/DraftWhiteboard.tsx
git commit -m "feat(web): add DraftWhiteboard canvas with pressure-smooth pen, stroke eraser, clear"
```

---

### Task 4: PreviewDraftPanel tab 容器

**Files:** Create `apps/web/src/components/business/PreviewDraftPanel.tsx`

右半区 tab 化：「预览 | 草稿」分时复用。`enabled=false`（非数学）时保持现状纯预览。

```tsx
import { useState } from 'react';
import { LatexPreview } from './LatexPreview';
import { DraftWhiteboard } from './DraftWhiteboard';

type Tab = 'preview' | 'draft';

interface Props {
  answer: string;
  questionId: string;
  /** 仅数学学科启用草稿白板（PRD §7.12） */
  enabled: boolean;
}

export function PreviewDraftPanel({ answer, questionId, enabled }: Props) {
  const [tab, setTab] = useState<Tab>('preview');

  if (!enabled) {
    return <LatexPreview value={answer} />;
  }

  const tabBtn = (t: Tab, label: string) => (
    <button
      onClick={() => setTab(t)}
      aria-pressed={tab === t}
      className={`px-3 h-9 text-sm rounded-lg transition-colors ${
        tab === t
          ? 'bg-[var(--brand-100)] text-[var(--brand-500)] font-medium'
          : 'text-[var(--text-tertiary)] hover:bg-[var(--bg-subtle)]'
      }`}
    >
      {label}
    </button>
  );

  return (
    <div className="h-full flex flex-col">
      <div className="shrink-0 flex items-center gap-1 px-3 pt-2 border-b border-[var(--bg-subtle)]">
        {tabBtn('preview', '预览')}
        {tabBtn('draft', '草稿')}
      </div>
      <div className="flex-1 min-h-0">
        {tab === 'preview' ? <LatexPreview value={answer} /> : <DraftWhiteboard questionId={questionId} />}
      </div>
    </div>
  );
}
```

**Step 2:** Run: `cd apps/web && npm run lint && npm run build`，Expected: 通过。

**Step 3:** Commit

```bash
git add apps/web/src/components/business/PreviewDraftPanel.tsx
git commit -m "feat(web): add PreviewDraftPanel with preview/draft tabs"
```

---

### Task 5: 接入 AnswerModal

**Files:** Modify `apps/web/src/components/business/AnswerModal.tsx`

**Step 1:**
1. 顶部 import：`import { PreviewDraftPanel } from './PreviewDraftPanel';` 和 `import { clearDraft } from './draft-store';`
2. 文件内加常量（数学学科 seed id，见 `tools/db/schema.sql` subjects 插入首行）：

```ts
/** 数学 subject_id（tools/db/schema.sql subjects seed 首行）——仅数学启用草稿白板 */
const MATH_SUBJECT_ID = 1;
```

3. `handleSubmit` 开头（`if (!answer.trim()...)` 校验之后、`setProgress` 之前）加：

```ts
clearDraft(`card-${cardId}-q-${q.n}`);
```

4. L253-255 右半区替换：

```tsx
{/* 右半区：预览 / 草稿 tab（仅数学启用草稿，PRD §7.12） */}
<div className="w-1/2">
  <PreviewDraftPanel
    answer={answer}
    questionId={`card-${cardId}-q-${q.n}`}
    enabled={subjectId === MATH_SUBJECT_ID}
  />
</div>
```

**Step 2:** Run: `cd apps/web && npm run lint && npm run build`，Expected: 通过。

**Step 3:** Commit

```bash
git add apps/web/src/components/business/AnswerModal.tsx
git commit -m "feat(web): wire draft whiteboard into AnswerModal right panel"
```

---

### Task 6: 接入 CleanupPhase

**Files:** Modify `apps/web/src/components/business/CleanupPhase.tsx`

**Step 1:**
1. import `PreviewDraftPanel` 与 `clearDraft`。
2. 同 Task 5 加 `MATH_SUBJECT_ID = 1` 常量。
3. `handleSubmit` 中 `setAnswer('')` 之后加（error 即当前题，key 用 errorBookId 唯一）：

```ts
clearDraft(`err-${currentError.errorBookId}`);
```

注意：`currentError` 在 `const error = currentError;` 已捕获，用 `error.errorBookId`。

4. L189-191 右半区替换：

```tsx
<div className="w-1/2">
  <PreviewDraftPanel
    answer={answer}
    questionId={`err-${currentError.errorBookId}`}
    enabled={subjectId === MATH_SUBJECT_ID}
  />
</div>
```

**Step 2:** Run: `cd apps/web && npm run lint && npm run build`，Expected: 通过。

**Step 3:** Commit

```bash
git add apps/web/src/components/business/CleanupPhase.tsx
git commit -m "feat(web): wire draft whiteboard into CleanupPhase"
```

---

### Task 7: 验证构建

**Step 1:** Run: `cd apps/web && npm run lint && npm run build`
Expected: 0 error 0 warning（warning 需排查）。

**Step 2:** Run `npm run dev`，浏览器打开 `http://localhost:5173/student/course-detail`（需登录学生账号并进入有练习的课）。

---

### Task 8: 人工验收清单

按设计文档 §4 逐项验证（鼠标/触屏/硬件笔、橡皮、清空、切 tab 保留、关开弹窗保留、提交后清空、切题隔离、日夜主题、iPad 横屏 >=1024px、非数学无 tab）。发现问题回到对应 Task 修复。

全部通过后提交文档：

```bash
git add docs/K12智学系统-产品需求文档.md docs/superpowers/plans/2026-09-02-draft-whiteboard-design.md docs/superpowers/plans/2026-09-02-draft-whiteboard.md
git commit -m "docs: PRD §7.12 draft whiteboard requirement + design/plan docs"
```
