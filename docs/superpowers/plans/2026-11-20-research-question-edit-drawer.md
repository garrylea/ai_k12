# 教研编辑抽屉 X 关闭图标 + 拖拽调宽 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use subagent-driven-development (recommended) or executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把教研试卷编辑抽屉右上角的文字「关闭抽屉」换成线性 SVG X 图标，并让抽屉宽度可通过左缘拖拽条连续调整（会话内记忆）。

**Architecture:** 单组件改动 `ResearchQuestionEditDrawer.tsx`，分两步落地：先把关闭按钮图标化（不改行为，仍走 `requestCancel` 的 dirty 确认），再把 `<aside>` 拆成「固定外壳 + 内层滚动容器」两层，在外壳左缘挂 Pointer Events 拖拽条，用增量式像素计算 + 夹紧更新内联 `width`，宽度落模块级 `lastWidthPx` 实现会话记忆。配套新增一个渲染测试文件。

**Tech Stack:** React 19 + TypeScript + Tailwind + Vitest / @testing-library/react（`apps/web`）。

## Global Constraints

- UI 不用 emoji；图标必须是线性 SVG（`viewBox="0 0 24 24"`、`stroke="currentColor"`、两条交叉 `<line>`，与 `ConfirmDialog.tsx:63` 同款）。
- 关闭行为不变：X 仍调用 `requestCancel()`，dirty / 有在途上传时弹「丢弃未保存的修改？」；底部「取消」按钮不动。
- 默认宽度不变：未拖动时**不注入内联 width**，保留 class `w-[min(92vw,32rem)]`。
- 宽度夹紧：`[Math.min(360, innerWidth*0.92), innerWidth*0.92]`；不加 width 过渡动画（跟手）。
- 会话记忆只放模块级 `let lastWidthPx`，**不引入 localStorage**。
- 不改抽屉的状态机 / 上传 / 保存逻辑；不改 `ResearchPaperDetailPage` 与其 stub 测试；不改后端 / API / openapi.yaml。
- 测试文件必须手动 `afterEach(() => cleanup())`（仓库 `globals:false`）。
- 每一步的命令都在 `apps/web` 目录执行（除 git 命令可在仓库根执行）。

---

### Task 1: X 关闭图标按钮（测试 + 实现）

**Files:**
- Modify: `apps/web/src/pages/research/ResearchQuestionEditDrawer.tsx:420-426`
- Create: `apps/web/src/pages/research/__tests__/ResearchQuestionEditDrawer.test.tsx`

**Interfaces:**
- Consumes: 组件既有 `requestCancel()`（不改）、`question: ResearchQuestionDetail`、`onClose`、`onSaved`。
- Produces: 一个可被 `getByRole('button', { name: '关闭抽屉' })` 找到、内含 `svg`、无文字内容的图标按钮。

- [ ] **Step 1: 新建测试文件，只写关闭按钮的 3 个用例**

```tsx
// apps/web/src/pages/research/__tests__/ResearchQuestionEditDrawer.test.tsx
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import ResearchQuestionEditDrawer from '../ResearchQuestionEditDrawer';
import type { ResearchQuestionDetail } from '@/services/api';

vi.mock('@/services/api', () => ({
  uploadResearchImage: vi.fn(),
  deleteResearchImages: vi.fn().mockResolvedValue(undefined),
  updateResearchQuestion: vi.fn().mockResolvedValue(undefined),
}));

const question: ResearchQuestionDetail = {
  id: 9,
  questionNo: 1,
  type: 'choice',
  content: '题干原文',
  options: [{ label: 'A', text: '甲' }],
  answer: 'A',
  explanation: '解析',
  approach: '思路',
  source: '汇文中学',
  sourceYear: 2026,
  answerVerified: true,
  isActive: true,
};

function renderDrawer() {
  const onClose = vi.fn();
  const onSaved = vi.fn();
  const result = render(
    <ResearchQuestionEditDrawer question={question} onClose={onClose} onSaved={onSaved} />,
  );
  return { ...result, onClose, onSaved };
}

afterEach(() => {
  cleanup();
});

describe('ResearchQuestionEditDrawer 关闭按钮', () => {
  it('右上角是带 aria-label 的 X 图标按钮，不是文字按钮', () => {
    renderDrawer();
    const btn = screen.getByRole('button', { name: '关闭抽屉' });
    expect(btn.querySelector('svg')).not.toBeNull();
    expect(btn.textContent).toBe('');
  });

  it('干净态点 X → 关闭', () => {
    const { onClose } = renderDrawer();
    fireEvent.click(screen.getByRole('button', { name: '关闭抽屉' }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('dirty 态点 X → 弹丢弃确认框，不直接关闭', () => {
    const { onClose } = renderDrawer();
    fireEvent.change(screen.getByRole('textbox', { name: '题干' }), {
      target: { value: '改过的题干' },
    });
    fireEvent.click(screen.getByRole('button', { name: '关闭抽屉' }));
    expect(screen.getByText('丢弃未保存的修改？')).toBeInTheDocument();
    expect(onClose).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: 运行测试，确认第一个用例失败**

Run: `cd apps/web && npm test -- ResearchQuestionEditDrawer`
Expected: FAIL——`btn.querySelector('svg')` 为 `null`（当前是文字按钮「关闭抽屉」，无 SVG）。后两个用例应已 PASS（如果 dirty 用例失败说明 dirty 判定被破坏，先停下排查）。

- [ ] **Step 3: 把 header 的文字按钮换成 X 图标按钮**

`apps/web/src/pages/research/ResearchQuestionEditDrawer.tsx`，把这段：

```tsx
        <button
          type="button"
          onClick={requestCancel}
          className="px-3 py-1.5 rounded-lg border border-gray-200 text-sm"
        >
          关闭抽屉
        </button>
```

替换为：

```tsx
        <button
          type="button"
          onClick={requestCancel}
          title="关闭抽屉"
          aria-label="关闭抽屉"
          className="w-8 h-8 rounded-lg flex items-center justify-center text-[var(--text-secondary)] hover:bg-gray-100 transition-colors"
        >
          <svg
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            className="w-5 h-5"
            aria-hidden="true"
          >
            <line x1="18" y1="6" x2="6" y2="18" />
            <line x1="6" y1="6" x2="18" y2="18" />
          </svg>
        </button>
```

其余代码（包括 footer 的「取消」与 `<ConfirmDialog>`）一律不动。

- [ ] **Step 4: 运行测试，确认 3 个用例全过**

Run: `cd apps/web && npm test -- ResearchQuestionEditDrawer`
Expected: PASS（3 passed）。

- [ ] **Step 5: 提交**

```bash
git add apps/web/src/pages/research/ResearchQuestionEditDrawer.tsx apps/web/src/pages/research/__tests__/ResearchQuestionEditDrawer.test.tsx
git commit -m "feat(web): 教研编辑抽屉关闭按钮改为 X 图标（保留 dirty 确认）"
```

---

### Task 2: 左缘拖拽调宽（测试 + 实现）

**Files:**
- Modify: `apps/web/src/pages/research/ResearchQuestionEditDrawer.tsx`（模块级常量/state/handlers + return 的 DOM 结构）
- Modify: `apps/web/src/pages/research/__tests__/ResearchQuestionEditDrawer.test.tsx`（追加拖拽用例，完整内容见 Step 1）

**Interfaces:**
- Consumes: Task 1 的组件与测试文件现状。
- Produces: `role="separator" aria-label="调整抽屉宽度" aria-orientation="vertical"` 的拖拽条；拖拽后 `<aside>` 出现内联 `width`（如 `612px`）；模块级 `lastWidthPx` 供重挂载读取。

- [ ] **Step 1: 用下面的完整内容覆盖测试文件（含 Task 1 用例 + 新增拖拽用例）**

```tsx
// apps/web/src/pages/research/__tests__/ResearchQuestionEditDrawer.test.tsx
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import ResearchQuestionEditDrawer from '../ResearchQuestionEditDrawer';
import type { ResearchQuestionDetail } from '@/services/api';

vi.mock('@/services/api', () => ({
  uploadResearchImage: vi.fn(),
  deleteResearchImages: vi.fn().mockResolvedValue(undefined),
  updateResearchQuestion: vi.fn().mockResolvedValue(undefined),
}));

const question: ResearchQuestionDetail = {
  id: 9,
  questionNo: 1,
  type: 'choice',
  content: '题干原文',
  options: [{ label: 'A', text: '甲' }],
  answer: 'A',
  explanation: '解析',
  approach: '思路',
  source: '汇文中学',
  sourceYear: 2026,
  answerVerified: true,
  isActive: true,
};

/** jsdom 无 PointerEvent 实现、getBoundingClientRect 恒 0：拖拽测试需要这两个桩。 */
const MOCK_RECT = {
  width: 512, height: 800, x: 0, y: 0, top: 0, left: 0,
  right: 512, bottom: 800, toJSON: () => ({}),
} as DOMRect;

function renderDrawer() {
  const onClose = vi.fn();
  const onSaved = vi.fn();
  const result = render(
    <ResearchQuestionEditDrawer question={question} onClose={onClose} onSaved={onSaved} />,
  );
  return { ...result, onClose, onSaved };
}

function dragSeparator(fromX: number, toX: number) {
  const sep = screen.getByRole('separator', { name: '调整抽屉宽度' });
  fireEvent.pointerDown(sep, { clientX: fromX, pointerId: 1, button: 0, pointerType: 'mouse' });
  fireEvent.pointerMove(sep, { clientX: toX, pointerId: 1 });
  fireEvent.pointerUp(sep, { clientX: toX, pointerId: 1 });
}

beforeEach(() => {
  Object.defineProperty(HTMLElement.prototype, 'setPointerCapture', {
    configurable: true,
    value: vi.fn(),
  });
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue(MOCK_RECT);
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('ResearchQuestionEditDrawer 关闭按钮', () => {
  it('右上角是带 aria-label 的 X 图标按钮，不是文字按钮', () => {
    renderDrawer();
    const btn = screen.getByRole('button', { name: '关闭抽屉' });
    expect(btn.querySelector('svg')).not.toBeNull();
    expect(btn.textContent).toBe('');
  });

  it('干净态点 X → 关闭', () => {
    const { onClose } = renderDrawer();
    fireEvent.click(screen.getByRole('button', { name: '关闭抽屉' }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('dirty 态点 X → 弹丢弃确认框，不直接关闭', () => {
    const { onClose } = renderDrawer();
    fireEvent.change(screen.getByRole('textbox', { name: '题干' }), {
      target: { value: '改过的题干' },
    });
    fireEvent.click(screen.getByRole('button', { name: '关闭抽屉' }));
    expect(screen.getByText('丢弃未保存的修改？')).toBeInTheDocument();
    expect(onClose).not.toHaveBeenCalled();
  });
});

describe('ResearchQuestionEditDrawer 拖拽调宽', () => {
  it('左缘有竖向拖拽条', () => {
    renderDrawer();
    const sep = screen.getByRole('separator', { name: '调整抽屉宽度' });
    expect(sep).toHaveAttribute('aria-orientation', 'vertical');
  });

  it('向左拖变宽、向右拖变窄，并夹紧到 360..92vw', () => {
    renderDrawer();
    dragSeparator(500, 400); // 512 + (500-400) = 612
    expect(screen.getByRole('dialog', { name: /编辑题目/ }).style.width).toBe('612px');
    dragSeparator(500, 900); // 512 + (500-900) = -388 → 夹紧到下限 360
    expect(screen.getByRole('dialog', { name: /编辑题目/ }).style.width).toBe('360px');
  });

  it('会话记忆：拖拽后卸载再挂载仍保留宽度', () => {
    const first = renderDrawer();
    dragSeparator(500, 420); // 512 + 80 = 592
    expect(screen.getByRole('dialog', { name: /编辑题目/ }).style.width).toBe('592px');
    first.unmount();
    renderDrawer();
    // 模块级 lastWidthPx 在单文件内共享，重挂载读回上次宽度
    expect(screen.getByRole('dialog', { name: /编辑题目/ }).style.width).toBe('592px');
  });
});
```

- [ ] **Step 2: 运行测试，确认新增拖拽用例失败**

Run: `cd apps/web && npm test -- ResearchQuestionEditDrawer`
Expected: FAIL——`getByRole('separator', ...)` 找不到元素（3 个关闭按钮用例仍 PASS）。

- [ ] **Step 3: 在组件顶部加模块级宽度常量与会话记忆**

在 `ResearchQuestionEditDrawer.tsx` 的 `import` 块之后、`export interface ResearchQuestionEditDrawerProps` 之前插入：

```ts
/** 抽屉宽度会话记忆：模块级，本会话内跨开关 / 跨试卷保持，刷新归 null。 */
let lastWidthPx: number | null = null;
/** 宽度上限：视口 92%（与原 class 的 92vw 一致）；下限保书写空间，窄屏时等于上限=禁调。 */
const WIDTH_MAX_PX = () => window.innerWidth * 0.92;
const WIDTH_MIN_PX = () => Math.min(360, WIDTH_MAX_PX());
```

- [ ] **Step 4: 在组件内加宽度 state / ref / 拖拽 handlers**

在 `const [uploadCount, setUploadCount] = useState(0);` 之后插入：

```tsx
  const [widthPx, setWidthPx] = useState<number | null>(() => lastWidthPx);
  const [dragging, setDragging] = useState(false);
  const drawerRef = useRef<HTMLElement>(null);
  const widthPxRef = useRef(widthPx);
  const resizeStartRef = useRef<{ startX: number; startPx: number } | null>(null);

  const applyWidth = useCallback((px: number) => {
    const clamped = Math.min(WIDTH_MAX_PX(), Math.max(WIDTH_MIN_PX(), px));
    widthPxRef.current = clamped;
    setWidthPx(clamped);
  }, []);

  const handleResizePointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    const startPx =
      drawerRef.current?.getBoundingClientRect().width ||
      widthPxRef.current ||
      Math.min(512, WIDTH_MAX_PX());
    resizeStartRef.current = { startX: e.clientX, startPx };
    setDragging(true);
  };

  const handleResizePointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const start = resizeStartRef.current;
    if (!start) return;
    // 向左拖 clientX 变小 → 变宽；向右拖变窄（右侧抽屉的直觉方向）
    applyWidth(start.startPx + (start.startX - e.clientX));
  };

  const endResize = () => {
    if (!resizeStartRef.current) return; // pointerup / lostpointercapture 各触发一次，幂等收尾
    resizeStartRef.current = null;
    setDragging(false);
    lastWidthPx = widthPxRef.current; // 落定即写会话记忆
  };
```

`useCallback` / `useRef` / `useState` 已在文件首行 import，`React.PointerEvent` 用法与 `DraftDrawer.tsx` 一致，无需新增 import。

- [ ] **Step 5: 把 return 的 `<aside>` 拆成「外壳 + 滚动容器」两层，并挂拖拽条**

把当前 return 的开头（约 409–416 行）：

```tsx
  return (
    <aside
      role="dialog"
      aria-label={`编辑题目 #${question.questionNo}`}
      data-status={status}
      className="fixed inset-y-0 right-0 z-50 w-[min(92vw,32rem)] overflow-y-auto bg-white shadow-2xl border-l border-gray-200 p-6"
    >
      <header className="flex items-center justify-between">
```

替换为（注意 `<aside>` 上**不要**再加 `relative`——`fixed` 已是 absolute 子元素的包含块）：

```tsx
  return (
    <aside
      ref={drawerRef}
      role="dialog"
      aria-label={`编辑题目 #${question.questionNo}`}
      data-status={status}
      style={{ width: widthPx !== null ? `${widthPx}px` : undefined }}
      className="fixed inset-y-0 right-0 z-50 w-[min(92vw,32rem)] bg-white shadow-2xl border-l border-gray-200"
    >
      {/* 左缘拖拽条：10px 命中区 + z-10，避免内容区抢指针事件；跟手即时，无 width 过渡 */}
      <div
        role="separator"
        aria-orientation="vertical"
        aria-label="调整抽屉宽度"
        draggable={false}
        className={`absolute left-0 top-0 bottom-0 w-[10px] z-10 cursor-col-resize touch-none flex items-center justify-center group ${dragging ? 'select-none' : ''}`}
        onPointerDown={handleResizePointerDown}
        onPointerMove={handleResizePointerMove}
        onPointerUp={endResize}
        onPointerCancel={endResize}
        onLostPointerCapture={endResize}
      >
        <span className="w-[2px] h-14 rounded-full bg-gray-200 group-hover:bg-gray-400 transition-colors" />
      </div>

      <div className={`h-full overflow-y-auto p-6 ${dragging ? 'select-none' : ''}`}>
        <header className="flex items-center justify-between">
```

然后在原 `</header>` 之后、原 `</aside>` 之前，把**所有原 aside 直接子内容**（`<p className="static-notice ...">` 到 `<ConfirmDialog ... />`）整体保留在原缩进即可——它们现在自然成为新内层 div 的子节点。最后把文件末尾的收尾：

```tsx
      <ConfirmDialog
        open={status === 'closing'}
        message="丢弃未保存的修改？"
        onCancel={() => setStatus('editing')}
        onConfirm={() => void discard()}
      />
    </aside>
  );
```

改为（只追加一个内层 div 的闭合标签，ConfirmDialog 内容不变）：

```tsx
      <ConfirmDialog
        open={status === 'closing'}
        message="丢弃未保存的修改？"
        onCancel={() => setStatus('editing')}
        onConfirm={() => void discard()}
      />
      </div>
    </aside>
  );
```

> 关键：`overflow-y-auto` 与 `p-6` 已从 `<aside>` 移到内层 div；拖拽条留在不滚动的外壳上，内容滚动时握把不会滚走。`ConfirmDialog` 自身是 `fixed inset-0 z-50`，放在内层 div 内不受滚动影响。

- [ ] **Step 6: 运行测试，确认 6 个用例全过**

Run: `cd apps/web && npm test -- ResearchQuestionEditDrawer`
Expected: PASS（6 passed）。若拖拽用例失败，优先检查：`setPointerCapture` 桩是否生效、`getBoundingClientRect` 桩是否返回 width=512、`window.innerWidth` 是否为 1024（jsdom 默认）。

- [ ] **Step 7: 提交**

```bash
git add apps/web/src/pages/research/ResearchQuestionEditDrawer.tsx apps/web/src/pages/research/__tests__/ResearchQuestionEditDrawer.test.tsx
git commit -m "feat(web): 教研编辑抽屉左缘拖拽调宽（夹紧 + 会话记忆）"
```

---

### Task 3: 全量验证与文档同步

**Files:** 无代码改动（验证用）。

- [ ] **Step 1: 类型检查 + 构建**

Run: `cd apps/web && npm run build`
Expected: 退出码 0，无 tsc 报错。

- [ ] **Step 2: lint**

Run: `cd apps/web && npm run lint`
Expected: 退出码 0，无 ESLint 报错（重点确认测试文件无未使用 import）。

- [ ] **Step 3: 全量单测**

Run: `cd apps/web && npm test`
Expected: PASS，尤其 `ResearchPaperDetailPage.test.tsx` 的 drawer stub 用例不受影响（stub 不渲染真实抽屉）。

- [ ] **Step 4: 设计/计划文档同步检查**

本计划未改任何 API / 数据流，无需同步 `openapi.yaml` 或 API 设计文档。若实现偏离 spec（夹紧值、记忆方式、DOM 结构），回到 `docs/superpowers/specs/2026-11-20-research-question-edit-drawer-design.md` 同步修订后再收尾。

---

## Self-Review（写完计划后已执行）

- **Spec 覆盖**：§1 关闭按钮 → Task 1；§2.1 DOM 两层 → Task 2 Step 5；§2.2 状态/记忆 → Task 2 Step 3-4；§2.3 拖拽交互 → Task 2 Step 4-5；§3 边界（窄屏夹紧 / 刷新归默认 / 确认框层级 / 无障碍）→ Task 2 Step 3-5 与测试；§4 测试 → Task 1 Step 1 与 Task 2 Step 1（6 用例全覆盖）；§5 不在范围 → Global Constraints 显式排除。无遗漏。
- **Placeholder 扫描**：无 TBD / TODO / "implement later" / "similar to Task N"；每个代码步骤均给出完整代码。
- **类型一致性**：`ResearchQuestionDetail` 字段、`renderDrawer()` 返回 `{ ...result, onClose, onSaved }`、`dragSeparator(fromX,toX)`、`applyWidth`/`endResize`/`WIDTH_MIN_PX`/`WIDTH_MAX_PX`/`lastWidthPx` 在定义与使用处名称一致；`widthPx` 为 `number | null`，`widthPxRef` 为 `number | null`，`endResize` 写 `lastWidthPx = widthPxRef.current`（落定时必为 number）。
