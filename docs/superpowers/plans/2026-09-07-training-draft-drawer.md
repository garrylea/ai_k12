# 训练轨草稿抽屉实现计划（专项/考试/错题）

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

> **修订记录（2026-09-09）**：本计划原文「草稿不持久化（切题/关闭即清空）」与 PRD §7.12「随题存在：关开保留、提交后清空」冲突，已按用户反馈修正——`DraftDrawer` 改 `persist` 落 draft-store，store key 与同页 `QuestionRunner` 提交清理同键（`${draftKeyPrefix}-${q.n}`，新增 `draftKeyPrefix` prop：tp / errp / exam-${sid}）。行为变为：**关抽屉再开内容保留；提交答案时 QuestionRunner 既有 `clearDraft` 一并清空；切题换 key 天然隔离**（回退上一题会恢复该题未提交草稿）。下文涉及 persist=false / 关抽屉即丢 的描述均为历史方案，以本修订为准。

**Goal:** 在三个训练轨答题页（专项/考试/错题）页面背景层右上角加一个始终显示的不起眼草稿图标，点击弹出右侧草稿抽屉（手写笔/橡皮/清空 + 纵向滚动 + 两档宽度 + X 关闭），草稿不持久化（切题/关闭即清空）；同时下线 QuestionRunner 内嵌草稿（PreviewDraftPanel `enabled=false`）。

**Architecture:** 草稿图标用 `absolute` 挂在每个 run 页 `relative` 容器右上角（页面背景层，不塞进 QuestionRunner 插槽）；抽屉 `DraftDrawer` 复用 `DiscussDrawer` 的右侧 absolute 抽屉样式，内含改造成支持 `scrollMode`/`persist` 的 `DraftWhiteboard`。`QuestionRunner` 新增 `onQuestionChange` 回调，run 页用 `currentQ` 追踪当前题并把 `currentQ.n` 传给抽屉做 `key`——切题即 remount 清空画布。现有 `PreviewDraftPanel` 草稿 tab 通过把传给它的 `enabled` 改 `false` 下线（组件本身不动，将来恢复翻回即可）。

**Tech Stack:** React + TypeScript + Tailwind CSS（CSS 变量主题体系，线性 SVG 图标，无 UI 库）。画布为原生 HTML5 `<canvas>` + `perfect-freehand`。

**Spec:** `docs/superpowers/specs/2026-09-07-training-draft-drawer-design.md`

## Global Constraints

- **无测试框架**：`apps/web` 未配置测试；每个任务以 `npm run build`（tsc 类型检查）+ `npm run lint` 为自动验证，最终按 spec §5 手测清单人工验收。所有命令在 `apps/web/` 下执行。
- **无 emoji**：UI/组件/copy 一律不用 emoji，图标必须是线性 SVG。
- **CSS 变量主题**：所有颜色用 `var(--...)`（如 `--learn-card-bg`、`--bg-page`、`--text-primary`、`--text-tertiary`、`--bg-subtle`、`--brand-500`），不硬编码色值。
- **不引入新依赖**：画布继续用 `perfect-freehand`（现有），无新库。
- **TypeScript 严格模式**、2 空格缩进、组件 PascalCase、函数/变量 camelCase。
- **不改**：`draft-store.ts`、`DiscussDrawer.tsx`、`PreviewDraftPanel.tsx` 组件本身、后端/API/openapi.yaml。
- 分支：在 `feat/training-module` 上开发（spec commit 所在分支）。

---

### Task 1: `DraftWhiteboard` 加 `scrollMode` + `persist` 两个可选 prop

**Files:**
- Modify: `apps/web/src/components/business/DraftWhiteboard.tsx`

**Interfaces:**
- Produces:
  - `export function DraftWhiteboard({ questionId, scrollMode = 'fit', persist = true }: { questionId: string; scrollMode?: 'fit' | 'scroll-y'; persist?: boolean })`
  - `scrollMode='scroll-y'`：canvas 包在固定高度画板 div 内，外层容器 `overflow-y-auto overflow-x-hidden`，画板高 = 容器高 × 1.6（实现里常量 `SCROLL_Y_FACTOR = 1.6`）。
  - `persist=false`：不读写 `draft-store`，`strokesRef` 纯本地；`questionId` 变化时清空笔迹。

- [ ] **Step 1: 读文件确认现状**

Run: `cat apps/web/src/components/business/DraftWhiteboard.tsx` 阅读全文件（当前 222 行）。确认要改的 4 处：函数签名（:75）、画布尺寸 effect（:92-109）、切题加载 effect（:114-118）、三个写 store 的调用点（`eraseAt` :129-136 / `handlePointerUp` :163-167 / `handleClear` :169-173）。

- [ ] **Step 2: 改签名与常量**

将函数签名（:75）与顶部常量区改为：

```tsx
const PEN_BASE_SIZE = 3;
/** scroll-y 模式画板高 = 容器可视高 × 该系数（纵向滚动条由此产生） */
const SCROLL_Y_FACTOR = 1.6;
```

```tsx
export function DraftWhiteboard({
  questionId,
  scrollMode = 'fit',
  persist = true,
}: {
  questionId: string;
  scrollMode?: 'fit' | 'scroll-y';
  persist?: boolean;
}) {
```

- [ ] **Step 3: 改 ref 声明**（:79-80 处，在 `wrapRef`/`canvasRef` 后加 `boardRef`）

```tsx
  const wrapRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const boardRef = useRef<HTMLDivElement>(null);
```

- [ ] **Step 4: 改画布尺寸 effect（支持两种模式）**

将 :92-109 的尺寸 effect 整体替换为：

```tsx
  // 尺寸：DPR 适配 + ResizeObserver。fit：canvas 贴合容器；scroll-y：画板高 = 容器高 × 1.6（纵向滚动）
  useEffect(() => {
    const wrap = wrapRef.current;
    const canvas = canvasRef.current;
    const board = boardRef.current;
    if (!wrap || !canvas) return;
    const resize = () => {
      const dpr = window.devicePixelRatio || 1;
      const w = Math.max(1, Math.round(wrap.clientWidth));
      const h = Math.max(1, Math.round(wrap.clientHeight));
      if (scrollMode === 'scroll-y') {
        const boardH = Math.round(h * SCROLL_Y_FACTOR);
        if (board) board.style.height = `${boardH}px`;
        canvas.width = Math.round(w * dpr);
        canvas.height = Math.round(boardH * dpr);
      } else {
        canvas.width = Math.round(w * dpr);
        canvas.height = Math.round(h * dpr);
      }
      const ctx = canvas.getContext('2d');
      ctx?.setTransform(dpr, 0, 0, dpr, 0, 0);
      redraw();
    };
    resize();
    const ro = new ResizeObserver(resize);
    ro.observe(wrap);
    return () => ro.disconnect();
  }, [redraw, scrollMode, boardRef]);
```

- [ ] **Step 5: 改切题加载 effect（persist 分支）**

将 :114-118 的 effect 替换为：

```tsx
  // 切题：persist 时加载该题草稿；persist=false 时清空本地笔迹（草稿不保存，切题即空）
  useEffect(() => {
    strokesRef.current = persist ? getDraft(questionId) : [];
    redraw();
  }, [questionId, persist, redraw]);
```

- [ ] **Step 6: 三个写 store 调用点加 `persist` 守卫**

在 `eraseAt`（:129-136）中把 `setDraft` 包一层：

```tsx
  const eraseAt = (x: number, y: number) => {
    const before = strokesRef.current.length;
    strokesRef.current = strokesRef.current.filter((s) => !hitStroke(s, x, y));
    if (strokesRef.current.length !== before) {
      if (persist) setDraft(questionId, strokesRef.current);
      redraw();
    }
  };
```

在 `handlePointerUp`（:163-167）中把 `setDraft` 包一层：

```tsx
  const handlePointerUp = () => {
    if (!drawingRef.current) return;
    drawingRef.current = false;
    if (persist) setDraft(questionId, strokesRef.current);
  };
```

在 `handleClear`（:169-173）中把 `clearDraft` 包一层：

```tsx
  const handleClear = () => {
    strokesRef.current = [];
    if (persist) clearDraft(questionId);
    redraw();
  };
```

- [ ] **Step 7: 改渲染 JSX（两种画布结构）**

将 :207-218 的 wrap+canvas 块替换为：

```tsx
      {/* 手写画布：fit 直接贴容器；scroll-y 包定高画板 div，外层 overflow-y-auto（仅纵向可滚） */}
      {scrollMode === 'scroll-y' ? (
        <div ref={wrapRef} className="flex-1 min-h-0 overflow-y-auto overflow-x-hidden">
          <div ref={boardRef} className="relative" style={{ width: '100%' }}>
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
      ) : (
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
      )}
```

- [ ] **Step 8: 类型检查**

Run: `npm run build`
Expected: tsc 通过、vite 打包成功。若报 `boardRef` 或常量未使用等错误，检查上一步替换是否完整。

- [ ] **Step 9: Lint**

Run: `npm run lint`
Expected: 无 error。

- [ ] **Step 10: Commit**

```bash
git add apps/web/src/components/business/DraftWhiteboard.tsx
git commit -m "feat(web): DraftWhiteboard 支持 scrollMode(fit/scroll-y) 与 persist 选项

- scrollMode=scroll-y：画板高 = 容器高 × 1.6，外层 overflow-y-auto 仅纵向滚动
- persist=false：不读写 draft-store，切题即清空本地笔迹（草稿不保存语义）
- 两 prop 均默认值向后兼容（fit + persist=true），既有调用行为不变"
```

---

### Task 2: 新建 `DraftDrawer.tsx`（草稿抽屉 + 草稿图标按钮）

**Files:**
- Create: `apps/web/src/components/business/DraftDrawer.tsx`

**Interfaces:**
- Consumes: `DraftWhiteboard`（Task 1）：`{ questionId, scrollMode = 'fit', persist = true }`。
- Produces:
  - `export function DraftDrawer({ questionId, onClose }: { questionId: string; onClose: () => void })`
  - `export function DraftIconButton({ onClick }: { onClick: () => void })`

- [ ] **Step 1: 写文件**

创建 `apps/web/src/components/business/DraftDrawer.tsx`，内容如下（样式抄 `DiscussDrawer.tsx` 抽屉外壳，宽度两档 `45%↔70%` 与它 card 模式一致）：

```tsx
// apps/web/src/components/business/DraftDrawer.tsx
// 训练轨答题页页面级草稿抽屉：右侧 absolute 滑出，内含 DraftWhiteboard（scroll-y 纵向可滚 + persist=false 不保存）。
// 草稿不持久化：key=questionId 切题即 remount 清空；关抽屉 unmount 即丢。仅手动关闭（X），不点外部收起。
import { useState } from 'react';
import { DraftWhiteboard } from './DraftWhiteboard';

interface Props {
  /** 当前题 q.n：作 DraftWhiteboard 的 key，切题即 remount 清空画布 */
  questionId: string;
  onClose: () => void;
}

export function DraftDrawer({ questionId, onClose }: Props) {
  const [expanded, setExpanded] = useState(false);
  // 宽度两档：45% ↔ 70%（不盖左侧栏）；过渡与 DiscussDrawer 一致
  const widthClass = expanded ? 'w-[70%]' : 'w-[45%]';

  return (
    <div
      className={`absolute top-0 right-0 bottom-0 flex flex-col bg-[var(--learn-card-bg)] border-l border-[var(--bg-subtle)] transition-[width] duration-200 ${widthClass}`}
      style={{ boxShadow: 'var(--shadow-drawer)' }}
      role="dialog"
      aria-label="草稿"
    >
      {/* 头部：标题 + 放大/缩小 + 关闭（与 DiscussDrawer 同款） */}
      <div className="shrink-0 flex items-center gap-2 px-4 py-3 border-b border-[var(--bg-subtle)]">
        <svg viewBox="0 0 24 24" fill="none" stroke="var(--text-secondary)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="w-4 h-4 flex-shrink-0">
          <path d="M12 19l7-7 3 3-7 7-3-3z" />
          <path d="M18 13l-1.5-7.5L2 2l3.5 14.5L13 18l5-5z" />
        </svg>
        <span className="text-sm font-bold text-[var(--text-primary)] flex-1">草稿</span>
        <button
          onClick={() => setExpanded((v) => !v)}
          className="w-8 h-8 rounded-lg flex items-center justify-center text-[var(--text-tertiary)] hover:bg-[var(--bg-base)] transition-colors"
          title={expanded ? '缩小' : '放大'}
          aria-label={expanded ? '缩小' : '放大'}
        >
          {expanded ? (
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="w-4 h-4">
              <polyline points="15 3 21 3 21 9" />
              <polyline points="9 21 3 21 3 15" />
              <line x1="21" y1="3" x2="14" y2="10" />
              <line x1="3" y1="21" x2="10" y2="14" />
            </svg>
          ) : (
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="w-4 h-4">
              <polyline points="9 3 3 3 3 9" />
              <polyline points="15 21 21 21 21 15" />
              <line x1="3" y1="3" x2="10" y2="10" />
              <line x1="21" y1="21" x2="14" y2="14" />
            </svg>
          )}
        </button>
        <button
          onClick={onClose}
          className="w-8 h-8 rounded-lg flex items-center justify-center text-[var(--text-tertiary)] hover:bg-[var(--bg-base)] transition-colors"
          title="收起"
          aria-label="收起"
        >
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" className="w-4 h-4">
            <line x1="18" y1="6" x2="6" y2="18" />
            <line x1="6" y1="6" x2="18" y2="18" />
          </svg>
        </button>
      </div>

      {/* 画布：scroll-y + persist=false；key=questionId 切题即 remount 清空 */}
      <div className="flex-1 min-h-0">
        <DraftWhiteboard key={questionId} questionId={questionId} scrollMode="scroll-y" persist={false} />
      </div>
    </div>
  );
}

/** 草稿入口按钮（页面背景层右上角，absolute 定位由调用方包装；小尺寸低对比，不起眼） */
export function DraftIconButton({ onClick }: { onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      className="w-8 h-8 rounded-lg border border-[var(--bg-subtle)] bg-[var(--learn-card-bg)] flex items-center justify-center text-[var(--text-tertiary)] hover:bg-[var(--bg-base)] transition-colors"
      title="草稿"
      aria-label="草稿"
    >
      {/* 笔 + 纸（线性 SVG，草稿入口语义；与 DraftWhiteboard 内部 PenIcon 略作区分） */}
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <path d="M12 20h9" />
        <path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z" />
      </svg>
    </button>
  );
}
```

- [ ] **Step 2: 类型检查**

Run: `npm run build`
Expected: tsc 通过、打包成功。

- [ ] **Step 3: Lint**

Run: `npm run lint`
Expected: 无 error。

- [ ] **Step 4: Commit**

```bash
git add apps/web/src/components/business/DraftDrawer.tsx
git commit -m "feat(web): 新增 DraftDrawer 草稿抽屉与 DraftIconButton 入口

- 右侧 absolute 抽屉，两档宽度 45↔70%，X 手动关闭，与 DiscussDrawer 同款外壳
- 内含 DraftWhiteboard(questionId, scroll-y, persist=false)，key=questionId 切题即 remount 清空
- DraftIconButton：32×32 低对比小按钮，供 run 页背景层右上角使用"
```

---

### Task 3: `QuestionRunner` 下线内嵌草稿 + 新增 `onQuestionChange` 回调

**Files:**
- Modify: `apps/web/src/components/business/answer/QuestionRunner.tsx`

**Interfaces:**
- Produces:
  - `QuestionRunnerProps.onQuestionChange?: (q: RunnerQuestion, idx: number) => void`
  - mount 与每次 `idx` 变化时调用 `onQuestionChange(q, idx)`。
- Consumes: 无（纯新增 prop + 一行 `enabled` 改动）。

- [ ] **Step 1: 加 prop 到接口**

在 `QuestionRunnerProps`（`QuestionRunner.tsx:47` 起）的 `modalExtras?: ReactNode;`（:81）附近追加：

```tsx
  /** 当前题变化时回调（父层追踪当前题，供页面级草稿抽屉做 key 触发清空）；首次 mount 也触发 */
  onQuestionChange?: (q: RunnerQuestion, idx: number) => void;
```

- [ ] **Step 2: 解构新 prop**

在 `QuestionRunner({ ... })` 解构（:84-105）里加：

```tsx
  onQuestionChange,
```

- [ ] **Step 3: 加调用 effect**

在 `const q = questions[idx];`（:123）之后加：

```tsx
  // 当前题变化通知父层（页面级草稿抽屉依赖它拿 key 触发清空）；父层应 useCallback 稳定引用避免重跑
  const onQuestionChangeRef = useRef(onQuestionChange);
  onQuestionChangeRef.current = onQuestionChange;
  useLayoutEffect(() => {
    if (q) onQuestionChangeRef.current?.(q, idx);
  }, [idx, q]);
```

> 用 ref 持有最新回调 + `useLayoutEffect([idx, q])`，避免父层回调引用不稳定导致重复触发。已 import `useLayoutEffect`（:7）与 `useRef`（:7），无需新增 import。注意需在 `q` 非空判断（`if (!q) return null;` :199）之前定义。

- [ ] **Step 4: 下线内嵌草稿（enabled 改 false）**

将 `PreviewDraftPanel` 的 `enabled`（:339）改为：

```tsx
                  enabled={false}   // 草稿 tab 下线（2026-09-07），页面级草稿抽屉替代；恢复时改回 subjectId === MATH_SUBJECT_ID
```

> `PreviewDraftPanel` 收到 `enabled=false` 走它自己的 `if (!enabled) return <LatexPreview value={answer} />;` 分支（纯预览，无草稿 tab）。组件本身不改。

- [ ] **Step 5: 清理不再使用的 MATH_SUBJECT_ID 相关**

若 `MATH_SUBJECT_ID`（:23）在此文件中仅剩 :339 一处使用（改后已无使用处），删除该常量定义与注释，避免 lint 未使用告警。

- [ ] **Step 6: 类型检查 + Lint**

Run: `npm run build && npm run lint`
Expected: tsc 通过、无 lint error。若 `MATH_SUBJECT_ID` 仍在别处使用则不要删（搜索确认）。

- [ ] **Step 7: Commit**

```bash
git add apps/web/src/components/business/answer/QuestionRunner.tsx
git commit -m "feat(web): QuestionRunner 下线内嵌草稿并新增 onQuestionChange 回调

- PreviewDraftPanel enabled=false：草稿 tab 下线（纯预览），由页面级草稿抽屉替代
- 新增可选 onQuestionChange(q, idx)：mount 与切题时触发，父层追踪当前题
- ref 持有回调避免父层引用不稳定导致 effect 重跑"
```

---

### Task 4: `TargetedRunPage` 接入草稿图标 + 抽屉

**Files:**
- Modify: `apps/web/src/pages/student/training/TargetedRunPage.tsx`

**Interfaces:**
- Consumes: `DraftDrawer` + `DraftIconButton`（Task 2）、`QuestionRunner.onQuestionChange`（Task 3）。
- Produces: run 页接入模式（Task 5/6 照抄）：`draftOpen` + `currentQ` state；`onQuestionChange`；图标 wrapper + `{draftOpen && currentQ && <DraftDrawer questionId={currentQ.n} />}`。

- [ ] **Step 1: 加 import**

在 import 区（:6 附近 `DiscussDrawer` 那行后）加：

```tsx
import { DraftDrawer, DraftIconButton } from '@/components/business/DraftDrawer';
```

- [ ] **Step 2: 加 state**

在 `discussQ` state（:34）附近加：

```tsx
  // 页面级草稿抽屉：始终可见图标，切题即清空（草稿不保存）；currentQ 由 QuestionRunner.onQuestionChange 喂
  const [draftOpen, setDraftOpen] = useState(false);
  const [currentQ, setCurrentQ] = useState<RunnerQuestion | null>(null);
```

- [ ] **Step 3: `QuestionRunner` 加 prop**

在 `onFinish={handleFinish}`（:199）附近加：

```tsx
              onQuestionChange={setCurrentQ}
```

> `setCurrentQ` 是 `useState` 的 setter，React 保证引用稳定，不会让 Task 3 的 effect 重跑。

- [ ] **Step 4: 渲染图标 + 抽屉**

在 `QuestionRunner` 的兄弟节点区（`{discussQ && phase === 'answering' && (...DiscussDrawer...)}` :202-209 之后，`</>` 之前）加：

```tsx
            {/* 草稿入口：页面背景层右上角，absolute 定位；DOM 排在抽屉前，抽屉打开时自然盖住图标 */}
            <div className="absolute top-4 right-4">
              <DraftIconButton onClick={() => setDraftOpen(true)} />
            </div>
            {draftOpen && currentQ && (
              <DraftDrawer
                questionId={currentQ.n}
                onClose={() => setDraftOpen(false)}
              />
            )}
```

- [ ] **Step 5: 类型检查 + Lint**

Run: `npm run build && npm run lint`
Expected: 通过。

- [ ] **Step 6: Commit**

```bash
git add apps/web/src/pages/student/training/TargetedRunPage.tsx
git commit -m "feat(web): 专项答题页右上角草稿图标与抽屉

页面背景层 absolute 图标（始终显示，不随答题框渲染与否）+ DraftDrawer（key=currentQ.n 切题清空）"
```

---

### Task 5: `ErrorPracticeRunPage` 接入草稿图标 + 抽屉

**Files:**
- Modify: `apps/web/src/pages/student/training/ErrorPracticeRunPage.tsx`

**Interfaces:**
- Consumes: 同 Task 4。
- Produces: 同 Task 4（照抄）。

- [ ] **Step 1: 加 import**

:6（DiscussDrawer import）后加：

```tsx
import { DraftDrawer, DraftIconButton } from '@/components/business/DraftDrawer';
```

- [ ] **Step 2: 加 state**

在 `discussQ` state（:33）附近加：

```tsx
  // 页面级草稿抽屉：始终可见图标，切题即清空（草稿不保存）
  const [draftOpen, setDraftOpen] = useState(false);
  const [currentQ, setCurrentQ] = useState<RunnerQuestion | null>(null);
```

- [ ] **Step 3: `QuestionRunner` 加 prop**

在 `onFinish={handleFinish}`（:177）附近加：

```tsx
              onQuestionChange={setCurrentQ}
```

- [ ] **Step 4: 渲染图标 + 抽屉**

在 `{discussQ && phase === 'answering' && (...DiscussDrawer...)}`（:180-188）之后、`</>` 之前加：

```tsx
            {/* 草稿入口：页面背景层右上角，absolute 定位 */}
            <div className="absolute top-4 right-4">
              <DraftIconButton onClick={() => setDraftOpen(true)} />
            </div>
            {draftOpen && currentQ && (
              <DraftDrawer
                questionId={currentQ.n}
                onClose={() => setDraftOpen(false)}
              />
            )}
```

- [ ] **Step 5: 类型检查 + Lint**

Run: `npm run build && npm run lint`
Expected: 通过。

- [ ] **Step 6: Commit**

```bash
git add apps/web/src/pages/student/training/ErrorPracticeRunPage.tsx
git commit -m "feat(web): 错题答题页右上角草稿图标与抽屉"
```

---

### Task 6: `ExamRunPage` 接入草稿图标 + 抽屉

**Files:**
- Modify: `apps/web/src/pages/student/training/ExamRunPage.tsx`

**Interfaces:**
- Consumes: 同 Task 4 + 页容器需补 `relative`。
- Produces: 同 Task 4。

- [ ] **Step 1: 加 import**

在 import 区（:4 `RunExitGuard` 后）加：

```tsx
import { DraftDrawer, DraftIconButton } from '@/components/business/DraftDrawer';
```

- [ ] **Step 2: 加 state**

在 `answeredNs` state（:57）附近加：

```tsx
  // 页面级草稿抽屉：考试中始终可见图标；交卷后（currentQ 不再更新）不渲染抽屉
  const [draftOpen, setDraftOpen] = useState(false);
  const [currentQ, setCurrentQ] = useState<RunnerQuestion | null>(null);
```

- [ ] **Step 3: 页容器补 `relative`**

主渲染容器（:223）改 className：

```tsx
      <div className="relative flex h-screen flex-col p-4 sm:p-6 bg-[var(--bg-page)] text-[var(--text-primary)]">
```

> 注意 loading/error 分支的容器（:197）也要补 `relative`（保持结构一致，虽然该分支无答题无抽屉，加了无副作用）。

- [ ] **Step 4: `QuestionRunner` 加 prop**

在 `onFinish={handleFinish}`（:246）附近加：

```tsx
          onQuestionChange={setCurrentQ}
```

- [ ] **Step 5: 渲染图标 + 抽屉**

在 `QuestionRunner`（:224-246）之后、`RunExitGuard`（:249）之前加：

```tsx

        {/* 草稿入口：页面背景层右上角，absolute 定位；考试无「讲一讲」，仅本图标 + 倒计时在顶栏 */}
        <div className="absolute top-4 right-4">
          <DraftIconButton onClick={() => setDraftOpen(true)} />
        </div>
        {draftOpen && currentQ && (
          <DraftDrawer
            questionId={currentQ.n}
            onClose={() => setDraftOpen(false)}
          />
        )}
```

> 考试交卷即 `navigate` 到结果路由（`handleSubmitExam` :138-140），ExamRunPage 整体 unmount，不存在"结果页图标残留"问题。

- [ ] **Step 6: 类型检查 + Lint**

Run: `npm run build && npm run lint`
Expected: 通过。

- [ ] **Step 7: Commit**

```bash
git add apps/web/src/pages/student/training/ExamRunPage.tsx
git commit -m "feat(web): 考试答题页右上角草稿图标与抽屉（容器补 relative）"
```

---

### Task 7: 全量验证 + 手测

**Files:**
- 无代码改动；验收产物。

- [ ] **Step 1: 全量 build + lint**

Run: `npm run build && npm run lint`
Expected: tsc 通过、vite 打包成功、无 lint error。

- [ ] **Step 2: 手测（起 dev server 逐项过 spec §5 清单）**

Run: `npm run dev` 后浏览器打开三个 run 页（专项：`/student/training/targeted/run`；错题：配置好错题单后 `/student/training/errors/run`；考试：开一张数学卷后 `/student/training/exam/run/:sessionId`）。逐项确认：

| # | 检查项 | 预期 |
|---|---|---|
| 1 | 三页右上角图标 | 背景层右上角小且不起眼，作答态可见 |
| 2 | 点图标开抽屉、画/擦/清空 | 手写笔可画、橡皮点中整笔删、清空全清 |
| 3 | 纵向滚动 | 画到画板 1.6 倍高区域出现纵向滚动条；横向不滚 |
| 4 | 两档宽度 | 放大/缩小切 45↔70%，过渡顺滑 |
| 5 | X 关闭 | 点 X 收起 |
| 6 | 切题清空 | 开抽屉画几笔 → 切下一题 → 空；切回上一题 → 也空 |
| 7 | 关抽屉再开 | 同题关→开画布是空的（不保存） |
| 8 | 全题型 | 选择/判断/填空/解答作答态都能见图标、能开抽屉画 |
| 9 | 内嵌草稿仅训练轨隐藏 | 训练轨三页填空/解答右半只有预览无「草稿」tab；主线（AnswerModal 弹窗）数学题保留 tab |
| 10 | 考试页布局 | 图标在页面角，不与倒计时重叠（倒计时在 headerExtra 标题行内） |
| 11 | 结果态 | 专项/错题结果页无图标（作答分支外）；考试交卷自动跳结果路由，页面卸载无图标残留 |
| 12 | 画布尺寸随抽屉宽度 | 45↔70% 切换时画布不模糊不变形（ResizeObserver 重算） |
| 13 | 两指平移（iPad） | 触摸下两指上推/下拉可滚到画板 1.6× 底部；单指仍画不误触 |
| 14 | 抽屉叠放 | 讲一讲（DiscussDrawer）打开时盖住图标、其 X 可点关（DOM 序前移后） |

> 已知可接受行为（本次不做处理）：讲一讲与草稿两个抽屉可同时打开且后渲染者（DraftDrawer，DOM 最后）覆盖前者；DiscussDrawer 打开时盖住右上角草稿图标是预期叠放（图标 DOM 前移后其 X 可点）。若手测发现图标与答题内容在 <920px 宽屏重叠，属次要 UI 问题，记录后另行处理。

- [ ] **Step 3: 收尾提交（若手测有改动）**

若手测中发现并修复了问题，把改动单独提交：

```bash
git add -A apps/web/src
git commit -m "fix(web): 草稿抽屉手测问题修复"
```

---

## 实现修正记录（2026-09-07 最终审查后，取代上文 Task 3/4/5/6 相关片段）

以下决策在最终 whole-branch 审查后由用户裁决，代码已按其落地，**上文各 Task 步骤以本记录为准**：

1. **隐藏内嵌草稿范围修正（取代 Task 3 Step 4 的 `enabled={false}`）**：改为 `QuestionRunner` 新增可选 prop `draftDisabled?: boolean`（默认 `false`），`PreviewDraftPanel` 的 `enabled = !draftDisabled && subjectId === MATH_SUBJECT_ID`；**仅三个训练 run 页**传 `draftDisabled`。主线（AnswerModal `variant="modal"`、CleanupPhase）保留数学草稿 tab——原全线下线会误伤无抽屉替代的主线上下文。
2. **图标 DOM 序（修正 Task 4/5 的 Step 4 位置）**：图标 `<div className="absolute top-4 right-4">` 必须排在各抽屉条件**之前**（QuestionRunner 之后、DiscussDrawer 条件之前），DraftDrawer 条件保持最后。同层兄弟 z-index 均为 auto、DOM 靠后者绘制在上层——抽屉后渲染才能盖住图标，其关闭 X 才不被图标拦截。
3. **结果页图标**：图标与抽屉都只在作答分支渲染，专项/错题结果页（AnswerResultList）不显示图标（取代"始终显示"表述）。
4. **两指平移（补充 Task 1 scroll-y）**：`DraftWhiteboard` scroll-y 模式加两指平移滚动画板（canvas `touchAction:none` 保留，指针事件表跟踪多指、第二指落下进平移并打断进行中单笔）；fit 模式与单指画/擦不受影响。canvas JSX 去重为单元素、`boardRef` 移出 resize effect deps。
5. **DraftDrawer a11y**：装饰头部 SVG 加 `aria-hidden="true"`；全部按钮加 `type="button"`。

---

## Self-Review 备注

- **spec 覆盖**：图标位置（spec §2）→ Task 4/5/6；作答态显示 + 全题型 → 图标挂页面容器且不在 QuestionRunner 内（Task 4-6），作答区分支无关；草稿不保存/切题清空/关抽屉丢 → DraftWhiteboard `persist=false` + 抽屉 `key=questionId`（Task 1/2）；仅训练轨隐藏内嵌草稿 → Task 3 修正记录 1；两档宽度 + X 关闭 + 纵向滚动 + 两指平移 → Task 2 + Task 1 scroll-y + 修正记录 4；ExamRunPage 补 relative → Task 6 Step 3。
- **类型一致性**：`scrollMode`/`persist` 签名在 Task 1 定义、Task 2 消费处与 spec 一致；`onQuestionChange`/`draftDisabled` 在 Task 3 定义、Task 4-6 消费；`questionId={currentQ.n}` 在 Task 4-6 与 spec §2.1 一致。`DraftIconButton`/`DraftDrawer` 在 Task 2 定义、Task 4-6 消费，导出名一致。
- **无占位符**：每步含完整代码/命令/预期。

---

**2026-09-13 后续**：草稿已由「右侧浮层抽屉」改为「与答题区并排的占位面板」（`DraftDrawer` → `DraftPanel`，见 `plans/2026-09-13-training-draft-inline-panel.md`）；本文描述的外壳/宽度/持久化条目按当时实现记录保留，不再与现状一致。
