# 草稿抽屉鼠标拖拽调宽 — 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** DraftDrawer 抽屉支持鼠标拖拽左边缘连续调宽（40–85%），保留「放大/缩小」两档快照按钮，宽度会话内记忆。

**Architecture:** 单文件改动 `apps/web/src/components/business/DraftDrawer.tsx`。把固定 `w-[45%]/w-[70%]` class 换成 `widthPct` 百分比 state + inline style；左缘加 6px 竖向拖拽条（Pointer Events + `setPointerCapture`），拖拽数学用增量式（起点快照 + 像素位移 / 容器 padding-box 宽 → %）；宽度落定写模块级 `lastWidthPct` 实现会话记忆。三个训练页父层零改动。

**Tech Stack:** React 19 + TypeScript + Tailwind（apps/web）；无测试框架，验证走 `npm run build` + `npm run lint` + 浏览器实测。

**设计依据：** `docs/superpowers/specs/2026-09-09-draft-drawer-width-resize-design.md`（已批准，commit `e3a7ae0`）。

---

### Task 1: 重写 DraftDrawer 支持拖拽调宽

**Files:**
- Modify: `apps/web/src/components/business/DraftDrawer.tsx`（整文件内容替换为下方代码）

- [ ] **Step 1: 用以下完整内容覆盖文件**

```tsx
// apps/web/src/components/business/DraftDrawer.tsx
// 训练轨答题页页面级草稿抽屉：右侧 absolute 滑出，内含 DraftWhiteboard（scroll-y 纵向可滚 + persist=false 不保存）。
// 草稿不持久化：key=questionId 切题即 remount 清空；关抽屉 unmount 即丢。仅手动关闭（X），不点外部收起。
// 宽度：左缘拖拽条鼠标连续调宽（40–85%）+ 右上「放大/缩小」两档快照（45↔70%）。
// 拖拽宽度模块级会话记忆：本会话内跨页、跨开关抽屉保持，刷新回默认 45%。
import { useCallback, useRef, useState } from 'react';
import { DraftWhiteboard } from './DraftWhiteboard';

interface Props {
  /** 当前题 q.n：作 DraftWhiteboard 的 key，切题即 remount 清空画布 */
  questionId: string;
  onClose: () => void;
}

/** 模块级会话记忆：拖拽/快照后的宽度在本会话内跨页、跨开关抽屉保持（刷新归默认） */
let lastWidthPct: number | null = null;

/** 宽度夹紧范围（相对定位容器 padding-box 宽的 %）：下限保白板书写空间，上限不盖尽左侧栏 */
const WIDTH_MIN = 40;
const WIDTH_MAX = 85;
const WIDTH_DEFAULT = 45;
/** 放大/缩小两档快照（%），与 expanded 按钮态对应 */
const WIDTH_SMALL = 45;
const WIDTH_LARGE = 70;

export function DraftDrawer({ questionId, onClose }: Props) {
  // 放大/缩小按钮态：仅作两档快照基准；拖拽连续调宽不更新它（按钮行为保持可预测）
  const [expanded, setExpanded] = useState(false);
  const [widthPct, setWidthPct] = useState<number>(() => lastWidthPct ?? WIDTH_DEFAULT);
  // 拖拽中关宽度过渡（实时跟随不滞后），落定后恢复过渡动画
  const [dragging, setDragging] = useState(false);
  const drawerRef = useRef<HTMLDivElement>(null);
  const widthPctRef = useRef(widthPct);
  // 拖拽起点快照：鼠标起始 clientX + 起始宽度 + 容器 padding-box 宽（% 的计算基准）
  const resizeStartRef = useRef<{ startX: number; startPct: number; baseW: number } | null>(null);

  const applyWidth = useCallback((pct: number) => {
    const clamped = Math.min(WIDTH_MAX, Math.max(WIDTH_MIN, pct));
    widthPctRef.current = clamped;
    setWidthPct(clamped);
  }, []);

  const handleResizePointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    const host = drawerRef.current?.offsetParent;
    if (!host) return;
    const rect = host.getBoundingClientRect();
    const cs = getComputedStyle(host);
    const baseW = rect.width - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight);
    resizeStartRef.current = { startX: e.clientX, startPct: widthPctRef.current, baseW };
    setDragging(true);
  };

  const handleResizePointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const rs = resizeStartRef.current;
    if (!rs || rs.baseW <= 0) return;
    applyWidth(rs.startPct + ((rs.startX - e.clientX) / rs.baseW) * 100);
  };

  const endResize = () => {
    if (!resizeStartRef.current) return; // pointerup 与 lostpointercapture 各触发一次，幂等收尾
    resizeStartRef.current = null;
    setDragging(false);
    lastWidthPct = widthPctRef.current; // 落定即写会话记忆
  };

  const handleToggleExpand = () => {
    const next = !expanded;
    setExpanded(next);
    applyWidth(next ? WIDTH_LARGE : WIDTH_SMALL);
    lastWidthPct = widthPctRef.current;
  };

  return (
    <div
      ref={drawerRef}
      className={`absolute top-0 right-0 bottom-0 flex flex-col bg-[var(--learn-card-bg)] border-l border-[var(--bg-subtle)] transition-[width] duration-200 ${dragging ? 'transition-none select-none' : ''}`}
      style={{ boxShadow: 'var(--shadow-drawer)', width: `${widthPct}%` }}
      role="dialog"
      aria-label="草稿"
    >
      {/* 左缘拖拽条：鼠标按住左右拖动连续调宽（40–85%）；窄条 + 居中竖线握把（功能性提示，非装饰） */}
      <div
        role="separator"
        aria-orientation="vertical"
        aria-label="调整草稿宽度"
        draggable={false}
        className="absolute left-0 top-0 bottom-0 w-[10px] z-10 cursor-grab touch-none flex items-center justify-center group"
        onPointerDown={handleResizePointerDown}
        onPointerMove={handleResizePointerMove}
        onPointerUp={endResize}
        onPointerCancel={endResize}
        onLostPointerCapture={endResize}
      >
        <span className="w-[2px] h-14 rounded-full bg-[var(--bg-subtle)] group-hover:bg-[var(--text-tertiary)] transition-colors" />
      </div>

      {/* 头部：标题 + 放大/缩小 + 关闭（与 DiscussDrawer 同款） */}
      <div className="shrink-0 flex items-center gap-2 px-4 py-3 border-b border-[var(--bg-subtle)]">
        {/* 装饰性笔图标：旁有「草稿」文字标题，纯装饰故对读屏隐藏 */}
        <svg viewBox="0 0 24 24" fill="none" stroke="var(--text-secondary)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="w-4 h-4 flex-shrink-0" aria-hidden="true">
          <path d="M12 19l7-7 3 3-7 7-3-3z" />
          <path d="M18 13l-1.5-7.5L2 2l3.5 14.5L13 18l5-5z" />
        </svg>
        <span className="text-sm font-bold text-[var(--text-primary)] flex-1">草稿</span>
        <button
          type="button"
          onClick={handleToggleExpand}
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
          type="button"
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
      type="button"
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

> 执行修正：初版计划代码块漏掉了原文件末尾的 `DraftIconButton` 导出（三个训练页均 import 使用），已补回——TS 构建会以 TS2305 报错兜底此疏漏。

> 执行修正（浏览器实测发现）：拖拽条需 `z-10` 且命中区加到 10px——白板 canvas/贴图层同为 `absolute inset-0`、DOM 靠后，无 z 会绘制在拖拽条之上吃掉指针事件（`elementFromPoint` 实测落到 canvas，光标不变、拖拽无效）。光标按用户要求用 `cursor-grab` 抓手而非 `col-resize`。

关键点核对：
- 拖拽数学：`widthPct = startPct + (startX − clientX) / baseW × 100`，`baseW = offsetParent 的 border-box 宽 − paddingLeft − paddingRight`。三个训练页容器都是 `relative h-screen flex flex-col p-4 sm:p-6`（padding box = `width: X%` 的基准，与 CSS 百分比一致）。
- `endResize` 幂等：`pointerup` 与 `lostpointercapture` 都会触发一次，靠 `resizeStartRef.current` 判空短路。
- `group`/`group-hover`：Tailwind marker class，拖拽条 hover 时竖线加深。

- [ ] **Step 2: 确认改动只涉及这一个文件**

Run: `cd apps/web && git status --short`
Expected: 仅 `M apps/web/src/components/business/DraftDrawer.tsx`（如还有本任务前已在工作区的其他改动，跳过即可，勿动）。

### Task 2: 类型检查 + 构建 + lint

**Files:** 无改动（验证用）

- [ ] **Step 1: 类型检查 + 构建**

Run: `cd apps/web && npm run build`
Expected: 退出码 0，无 tsc 报错（Tailwind `group`、`touch-none`、`cursor-col-resize`、`select-none`、`transition-none` 均为合法工具类）。

- [ ] **Step 2: lint**

Run: `cd apps/web && npm run lint`
Expected: 退出码 0，无 ESLint 报错。

### Task 3: 浏览器实测

**Files:** 无改动（手动/浏览器验证）

前置：应用已运行（用户惯用 `tools/services.sh` 构建 + vite preview 5173；改代码后必须重建才生效，见 memory `preview-mode-requires-rebuild`）。实测清单（设计 §4）：

- [ ] **Step 1: 拖拽连续调宽 + 夹紧**
进入任一训练轨答题页（错题巩固 / 考试 / 定向练习），打开草稿抽屉，按住左缘拖拽条左右拖动：宽度应连续变化、无过渡动画滞后；拖到极左≈40%、极右≈85% 被夹紧。

- [ ] **Step 2: 关闭再开宽度保持（会话记忆）**
拖到中间值（如 60%），点 X 关闭抽屉，再点草稿入口重开：宽度回到 60%。

- [ ] **Step 3: 跨页保持**
当前宽度下切到另一个训练页并打开抽屉：宽度保持；刷新页面后回默认 45%。

- [ ] **Step 4: 按钮快照仍可用**
拖拽到 60% 后点「放大」→ 70%，再点「缩小」→ 45%（按按钮态快照，可预测）；拖拽后图标仍显示正确的「放大/缩小」。

- [ ] **Step 5: 拖拽不误触画布**
拖拽条下方无穿透：拖动过程中左缘竖线握把随 hover 变深，松开后无残留选中态。

### Task 4: 提交

- [ ] **Step 1: Commit**

```bash
cd apps/web && git add src/components/business/DraftDrawer.tsx
git commit -m "feat(web): 草稿抽屉左缘拖拽连续调宽（40-85%）+ 两档快照保留 + 会话内宽度记忆"
```

- [ ] **Step 2: 同步设计/计划文档（仓库铁律）**

设计文档已先于本计划提交；本计划不改任何 API/数据流，无需再同步 openapi.yaml 或 API 设计文档。若实现过程偏离设计文档（如夹紧范围/交互），回到 `docs/superpowers/specs/2026-09-09-draft-drawer-width-resize-design.md` 同步。

---

**2026-09-13 后续**：草稿抽屉已改为并排占位面板（宽度 25–55%/默认 35%、双击分割条复位、两档按钮移除、三页新增并排行），本文的「40–85% 拖拽」实现已被 `plans/2026-09-13-training-draft-inline-panel.md` 取代。
