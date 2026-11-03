# 草稿白板：题图拖入 / 撤销重做 / 旋转 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use subagent-driven-development (recommended) or executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让草稿白板支持「题干/材料图片拖入」「每一笔操作可撤销/重做」「选中笔迹与图形绕选区中心旋转」，全部改在现有 `DraftWhiteboard` 上，不新建白板。

**Architecture:** 历史用「快照列表 + 结构共享 + 写时复制」——快照只复制 `strokes[]`/`images[]` 两个数组，元素对象共享；唯一会原地改坐标的两个手势（选中移动、旋转）起手先克隆选中笔迹。题图拖入用指针事件自绘幽灵图（不用 HTML5 原生拖拽，iPad 触摸不触发）。旋转把笔迹点列绕选区包围盒中心做旋转矩阵变换，不引入形状对象。

**Tech Stack:** React 18 + TypeScript + Vite + Tailwind（全 token 配色）、vitest + React Testing Library（`globals: false`）、Canvas 2D。

## Global Constraints

- **只动 `apps/web/src/components/**` 与 `docs/`**：不改后端、不改 schema、不改 API 文档。
- **测试纪律**：`globals: false`，每个测试文件自写 `afterEach(() => cleanup())`；组件改动必须补渲染测试，不能只靠 `tsc + lint + build`。测试与 spec 冲突时改测试。
- **UI 硬规则**：不用 emoji；图标用线性 SVG（`stroke="currentColor"`、`strokeWidth={2}`）；配色只走 CSS 变量（`var(--brand-500)` 等），不写死色值。
- **iPad 横屏是主断点**：触摸拖拽、20px 手柄命中半径、`touch-action: pan-y` 都是硬要求，别按桌面鼠标的精度做。
- **`Ctrl+R` 不绑定任何功能**：它是浏览器/Electron 刷新，绑成重做会丢草稿。
- **注释写「为什么」**：写时复制不变量、10px 拖拽阈值、`Ctrl+R` 取舍这类非显然决定必须留一行原因。
- **命令一律在 `apps/web` 下执行**：`npx vitest run <file>` / `npm test` / `npm run lint` / `npm run build`。
- **本机已有 dev server 时不要重启或杀进程**（用户自己开着 :5173/:3001）。
- 参考 spec：`docs/superpowers/specs/2026-11-03-draft-undo-drag-rotate-design.md`。

---

### Task 1: 贴图字段改名 + 按地址建贴图 + 图层 commit 回调

**Files:**
- Modify: `apps/web/src/components/business/draft-store.ts:34-42`
- Modify: `apps/web/src/components/business/draft-image-utils.ts`
- Modify: `apps/web/src/components/business/DraftImageLayer.tsx`
- Create: `apps/web/src/components/business/draft-image-utils.test.ts`
- Create: `apps/web/src/components/business/DraftImageLayer.test.tsx`

**Interfaces:**
- Produces: `DraftImage.src: string`（原 `dataUrl`，值的形态从「必是 data URL」放宽为「data: / /assets/… / http(s)」）
- Produces: `draftImageFromSrc(src: string, boardW: number, boardH: number, at: { x: number; y: number }): Promise<DraftImage>`
- Produces: `DraftImageLayer` 新 prop `onCommit?: () => void`（缩放手势结束 / 删除后各调一次，供上层记历史）

- [ ] **Step 1: 写失败测试（工具函数）**

Create `apps/web/src/components/business/draft-image-utils.test.ts`：

```ts
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { draftImageFromSrc } from './draft-image-utils';

/** jsdom 不会真的解码图片：用一个立即 onload 的假 Image 顶替，只验证尺寸/落点数学 */
class FakeImage {
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  naturalWidth = 800;
  naturalHeight = 600;
  set src(_v: string) { queueMicrotask(() => this.onload?.()); }
}

beforeEach(() => { vi.stubGlobal('Image', FakeImage as unknown as typeof Image); });
afterEach(() => { vi.unstubAllGlobals(); });

describe('draftImageFromSrc', () => {
  it('宽取画板 60%，以落点为中心，保留原地址', async () => {
    const img = await draftImageFromSrc('/assets/q.png', 400, 600, { x: 200, y: 300 });
    expect(img.src).toBe('/assets/q.png');
    expect(img.w).toBe(240);   // min(400*0.6, 800)
    expect(img.h).toBe(180);   // 240 / 800 * 600
    expect(img.x).toBe(80);    // 200 - 120
    expect(img.y).toBe(210);   // 300 - 90
    expect(img.id).toBeTruthy();
  });

  it('宽度取「画板 60%」与「原图宽」的较小值', async () => {
    const img = await draftImageFromSrc('/assets/q.png', 2000, 600, { x: 1000, y: 300 });
    expect(img.w).toBe(800);   // 2000*0.6 = 1200 > 原图 800 → 用原图宽
  });

  it('靠近左上角时落点夹回画板内', async () => {
    const img = await draftImageFromSrc('/assets/q.png', 400, 600, { x: 5, y: 5 });
    expect(img.x).toBe(0);
    expect(img.y).toBe(0);
  });

  it('解码失败时 reject', async () => {
    class Broken extends FakeImage {
      set src(_v: string) { queueMicrotask(() => this.onerror?.()); }
    }
    vi.stubGlobal('Image', Broken as unknown as typeof Image);
    await expect(draftImageFromSrc('/assets/bad.png', 400, 600, { x: 10, y: 10 })).rejects.toThrow();
  });
});
```

- [ ] **Step 2: 写失败测试（贴图层）**

Create `apps/web/src/components/business/DraftImageLayer.test.tsx`：

```tsx
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { cleanup, render, fireEvent } from '@testing-library/react';
import { DraftImageLayer } from './DraftImageLayer';

const IMG = { id: 'i1', src: '/assets/x.png', x: 10, y: 20, w: 100, h: 60 };

beforeEach(() => {
  Object.defineProperty(Element.prototype, 'setPointerCapture', { value: () => {}, configurable: true });
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

describe('DraftImageLayer', () => {
  it('用 src 渲染贴图', () => {
    const { container } = render(
      <DraftImageLayer images={[IMG]} onImagesChange={() => {}} selectedIds={new Set()} handlesEnabled={false} />,
    );
    expect(container.querySelector('img')!.getAttribute('src')).toBe('/assets/x.png');
  });

  it('删除贴图后回调 onCommit', () => {
    const onChange = vi.fn();
    const onCommit = vi.fn();
    const { container } = render(
      <DraftImageLayer images={[IMG]} onImagesChange={onChange} selectedIds={new Set(['i1'])} handlesEnabled onCommit={onCommit} />,
    );
    fireEvent.click(container.querySelector('button[aria-label="删除图片"]')!);
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onCommit).toHaveBeenCalledTimes(1);
  });

  it('缩放手势结束后回调 onCommit（未拖动也只在结束后调一次）', () => {
    const onCommit = vi.fn();
    const { container } = render(
      <DraftImageLayer images={[IMG]} onImagesChange={() => {}} selectedIds={new Set(['i1'])} handlesEnabled onCommit={onCommit} />,
    );
    const handle = container.querySelector('[data-corner="se"]')!;
    fireEvent.pointerDown(handle, { pointerId: 1, clientX: 100, clientY: 100 });
    expect(onCommit).not.toHaveBeenCalled();
    fireEvent.pointerUp(handle, { pointerId: 1, clientX: 100, clientY: 100 });
    expect(onCommit).toHaveBeenCalledTimes(1);
  });
});
```

- [ ] **Step 3: 跑测试确认失败**

```bash
cd apps/web && npx vitest run src/components/business/draft-image-utils.test.ts src/components/business/DraftImageLayer.test.tsx
```

Expected: FAIL —— `draftImageFromSrc is not a function`、`img.getAttribute('src')` 为 `null`、`onCommit` 未被调用。

- [ ] **Step 4: 改数据模型与工具函数**

`draft-store.ts` 的 `DraftImage`：

```ts
/** 草稿贴图：坐标/尺寸相对 board（与笔迹同坐标系；scroll-y 模式 y 可超一屏） */
export interface DraftImage {
  id: string;      // 前端唯一标识，见 draft-image-utils.newImageId()
  /** 图片来源：粘贴/文件是压缩后的 data:；题干图拖入是 resolveAsset 后的地址（/assets/… 或 http(s)）。
   *  用地址而不是再复制一份 base64 —— 同一张题干图拖两次也只有一份数据在内存里。 */
  src: string;
  x: number;
  y: number;
  w: number; // 显示宽（CSS px）
  h: number; // 显示高（CSS px）
}
```

`draft-image-utils.ts`：

1. `fileToDraftImage` 的返回改为 `{ id: newImageId(), src: dataUrl, x, y, w, h }`（`loadImage` 内部变量名保持不动）。
2. 文件末尾追加：

```ts
/** 图片地址（题干图拖入）→ 待插入 DraftImage。
 *  尺寸/落点口径与 fileToDraftImage 一致：以落点为中心、宽取画板 60%（原图更小按原图）、越界夹回画板内。
 *  与文件插入的差别只有 src 来源：这里直接用地址，不做压缩转码。 */
export async function draftImageFromSrc(
  src: string,
  boardW: number,
  boardH: number,
  at: { x: number; y: number },
): Promise<DraftImage> {
  const img = await new Promise<HTMLImageElement>((resolve, reject) => {
    const el = new Image();
    el.onload = () => resolve(el);
    el.onerror = () => reject(new Error('image decode failed'));
    el.src = src;
  });
  const nw = img.naturalWidth;
  const nh = img.naturalHeight;
  if (!nw || !nh) throw new Error('image has no natural size');
  const w = Math.min(Math.round(boardW * INIT_WIDTH_FACTOR), nw);
  const h = Math.max(1, Math.round((w / nw) * nh));
  // 以落点为中心；超出画板则夹回（夹上界用 max(0, …)：图比画板宽时只能贴左边）
  const x = Math.min(Math.max(0, Math.round(at.x - w / 2)), Math.max(0, boardW - w));
  const y = Math.min(Math.max(0, Math.round(at.y - h / 2)), Math.max(0, boardH - h));
  return { id: newImageId(), src, x, y, w, h };
}
```

- [ ] **Step 5: 改贴图层（src + onCommit + data-corner）**

`DraftImageLayer.tsx`：

1. Props 增加 `onCommit?: () => void`。
2. `src={img.dataUrl}` → `src={img.src}`。
3. `endResize` 改为：

```ts
const endResize = () => {
  if (!resizeRef.current) return;
  resizeRef.current = null;
  onCommit?.();   // 缩放逐帧落 store，历史只在手势结束记一步
};
```

4. 四角控制点的 `div` 增加 `data-corner={c}`（测试锚点，也便于将来做自动化）。
5. 删除钮 `onClick`：

```tsx
onClick={() => {
  onImagesChange((prev) => prev.filter((im) => im.id !== img.id));
  onCommit?.();
}}
```

- [ ] **Step 6: 跑测试确认通过**

```bash
cd apps/web && npx vitest run src/components/business/draft-image-utils.test.ts src/components/business/DraftImageLayer.test.tsx
```

Expected: PASS（8 个用例）。

- [ ] **Step 7: 提交**

```bash
git add apps/web/src/components/business/draft-store.ts \
        apps/web/src/components/business/draft-image-utils.ts \
        apps/web/src/components/business/DraftImageLayer.tsx \
        apps/web/src/components/business/draft-image-utils.test.ts \
        apps/web/src/components/business/DraftImageLayer.test.tsx
git commit -m "refactor(draft): 贴图字段 dataUrl→src，补按地址建贴图与图层 commit 回调"
```

---

### Task 2: 历史模块 `draft-history`

**Files:**
- Create: `apps/web/src/components/business/draft-history.ts`
- Create: `apps/web/src/components/business/draft-history.test.ts`
- Modify: `apps/web/src/components/business/draft-store.ts`（`clearDraft` 同时清历史）

**Interfaces:**
- Produces: `DraftState { strokes: Stroke[]; images: DraftImage[] }`
- Produces: `initHistory(key, initial)`, `pushState(key, state): boolean`, `undo(key): DraftState | null`, `redo(key): DraftState | null`, `canUndo(key): boolean`, `canRedo(key): boolean`, `clearHistory(key)`, `getHistory(key)`

- [ ] **Step 1: 写失败测试**

Create `apps/web/src/components/business/draft-history.test.ts`：

```ts
import { describe, it, expect, beforeEach } from 'vitest';
import {
  initHistory, pushState, undo, redo, canUndo, canRedo, clearHistory, getHistory,
} from './draft-history';
import type { Stroke } from './draft-store';
import { setDraft, getDraft, clearDraft } from './draft-store';

const stroke = (x: number): Stroke => ({ points: [{ x, y: 0, pressure: 0.5 }], size: 2 });
const st = (n: number) => ({ strokes: [stroke(n)], images: [] });

beforeEach(() => { clearHistory('k'); });

describe('draft-history', () => {
  it('初始态不能撤销/重做', () => {
    initHistory('k', st(0));
    expect(canUndo('k')).toBe(false);
    expect(canRedo('k')).toBe(false);
    expect(undo('k')).toBeNull();
  });

  it('push 后撤销回上一步，重做回来', () => {
    initHistory('k', st(0));
    expect(pushState('k', st(1))).toBe(true);
    expect(pushState('k', st(2))).toBe(true);
    expect(undo('k')!.strokes[0].points[0].x).toBe(1);
    expect(undo('k')!.strokes[0].points[0].x).toBe(0);
    expect(redo('k')!.strokes[0].points[0].x).toBe(1);
  });

  it('内容没变（数组元素引用全同）时不入栈', () => {
    const a = st(0);
    initHistory('k', a);
    expect(pushState('k', { strokes: [...a.strokes], images: [...a.images] })).toBe(false);
    expect(canUndo('k')).toBe(false);
  });

  it('撤销后再 push 会截断重做栈', () => {
    initHistory('k', st(0));
    pushState('k', st(1));
    pushState('k', st(2));
    undo('k');
    expect(canRedo('k')).toBe(true);
    pushState('k', st(3));
    expect(canRedo('k')).toBe(false);
    expect(getHistory('k')!.states).toHaveLength(3);
  });

  it('超过 51 个状态时丢最旧', () => {
    initHistory('k', st(0));
    for (let i = 1; i <= 60; i++) pushState('k', st(i));
    const h = getHistory('k')!;
    expect(h.states).toHaveLength(51);
    expect(h.index).toBe(50);
  });

  it('clearDraft 连历史一起清', () => {
    initHistory('k', st(0));
    pushState('k', st(1));
    setDraft('k', [stroke(1)]);
    clearDraft('k');
    expect(getDraft('k')).toEqual([]);
    expect(canUndo('k')).toBe(false);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

```bash
cd apps/web && npx vitest run src/components/business/draft-history.test.ts
```

Expected: FAIL —— 模块不存在。

- [ ] **Step 3: 实现 `draft-history.ts`**

```ts
/** 草稿历史：按题（key）保存「操作后的完整快照」列表 + 游标，支持撤销/重做。
 *
 *  为什么用快照而不是逆操作：移动、旋转、橡皮整段擦除、批量删除的逆运算分支太多，
 *  漏一个就是静默数据损坏；快照只要保证「旧对象不被改」即可。
 *  为什么只复制数组：Stroke/DraftImage 元素对象在历史里共享（结构共享），
 *  50 步的额外内存只是数组槽位。前提是**已进历史的元素对象只读**——
 *  唯一会原地改坐标的「选中移动」「旋转」必须在起手时先克隆（见 DraftWhiteboard.startRotate / selectDown）。 */

import type { Stroke, DraftImage } from './draft-store';

export interface DraftState {
  strokes: Stroke[];
  images: DraftImage[];
}

/** 1 个初始态 + 最多 50 步撤销 */
const MAX_STATES = 51;

interface Entry {
  states: DraftState[];
  index: number;
}

const store = new Map<string, Entry>();

/** 数组逐项引用比较：元素对象只读且共享，所以引用全同 = 内容没变 */
function sameArray<T>(a: T[], b: T[]): boolean {
  return a.length === b.length && a.every((v, i) => v === b[i]);
}

export function getHistory(key: string): { states: DraftState[]; index: number } | undefined {
  return store.get(key);
}

/** 挂载时登记初始态；已有历史则不动（关面板再开要保留撤销栈） */
export function initHistory(key: string, initial: DraftState): void {
  if (store.has(key)) return;
  store.set(key, { states: [initial], index: 0 });
}

/** 记录一次操作后的状态；内容与当前态相同则不入栈，返回是否真的入栈 */
export function pushState(key: string, state: DraftState): boolean {
  const entry = store.get(key);
  if (!entry) {
    store.set(key, { states: [state], index: 0 });
    return true;
  }
  const current = entry.states[entry.index];
  if (sameArray(current.strokes, state.strokes) && sameArray(current.images, state.images)) return false;

  entry.states.length = entry.index + 1; // 撤销后做新操作：重做栈作废
  entry.states.push(state);
  entry.index = entry.states.length - 1;
  if (entry.states.length > MAX_STATES) {
    entry.states.shift();  // 丢最旧，不影响当前内容
    entry.index -= 1;
  }
  return true;
}

export function undo(key: string): DraftState | null {
  const entry = store.get(key);
  if (!entry || entry.index === 0) return null;
  entry.index -= 1;
  return entry.states[entry.index];
}

export function redo(key: string): DraftState | null {
  const entry = store.get(key);
  if (!entry || entry.index >= entry.states.length - 1) return null;
  entry.index += 1;
  return entry.states[entry.index];
}

export function canUndo(key: string): boolean {
  const entry = store.get(key);
  return !!entry && entry.index > 0;
}

export function canRedo(key: string): boolean {
  const entry = store.get(key);
  return !!entry && entry.index < entry.states.length - 1;
}

export function clearHistory(key: string): void {
  store.delete(key);
}
```

- [ ] **Step 4: `clearDraft` 联动**

`draft-store.ts` 顶部加 `import { clearHistory } from './draft-history';`，`clearDraft` 内追加一行：

```ts
export function clearDraft(key: string): void {
  store.delete(key);
  imageStore.delete(key);
  // 提交答案/换题时草稿与撤销栈必须一起清：否则同一题重做时，撤销会复活上一轮已提交的草稿
  clearHistory(key);
}
```

> 说明：`draft-history.ts` 只用 `import type` 引 `draft-store`，所以运行时依赖是单向的（store → history），不会成环。

- [ ] **Step 5: 跑测试确认通过**

```bash
cd apps/web && npx vitest run src/components/business/draft-history.test.ts
```

Expected: PASS（6 个用例）。

- [ ] **Step 6: 提交**

```bash
git add apps/web/src/components/business/draft-history.ts \
        apps/web/src/components/business/draft-history.test.ts \
        apps/web/src/components/business/draft-store.ts
git commit -m "feat(draft): 历史快照模块（结构共享，50 步）+ clearDraft 联动清历史"
```

---

### Task 3: 白板接入历史：打点 / 撤销重做按钮与快捷键 / 清空可撤销

**Files:**
- Modify: `apps/web/src/components/business/DraftWhiteboard.tsx`
- Modify: `apps/web/src/components/business/DraftWhiteboard.test.tsx`

**Interfaces:**
- Consumes: `draft-history` 的 `initHistory / pushState / undo / redo / canUndo / canRedo / DraftState`
- Produces: `DraftWhiteboard` 内部 `pushHistory()`；撤销/重做按钮 `aria-label="撤销（Ctrl+Z）"` / `"重做（Ctrl+Shift+Z）"`（Task 6 的旋转手势沿用 `pushHistory`）

- [ ] **Step 1: 写失败测试**

在 `DraftWhiteboard.test.tsx` 顶部把现有 `import { clearDraft } from './draft-store';` 改为：

```ts
import { clearDraft, getDraft } from './draft-store';
```

文件末尾追加：

```tsx
describe('草稿白板：撤销 / 重做', () => {
  const undoKey = () => fireEvent.keyDown(document, { key: 'z', ctrlKey: true });
  const redoKey = () => fireEvent.keyDown(document, { key: 'z', ctrlKey: true, shiftKey: true });

  it('Ctrl+Z 撤销一笔、Ctrl+Shift+Z 重做', () => {
    const { canvas } = setup();
    penLine(canvas, 100);
    penLine(canvas, 160);
    expect(getDraft('q1')).toHaveLength(2);

    undoKey();
    expect(getDraft('q1')).toHaveLength(1);
    redoKey();
    expect(getDraft('q1')).toHaveLength(2);
  });

  it('Ctrl+Y 也能重做', () => {
    const { canvas } = setup();
    penLine(canvas, 100);
    undoKey();
    fireEvent.keyDown(document, { key: 'y', ctrlKey: true });
    expect(getDraft('q1')).toHaveLength(1);
  });

  it('一次橡皮划过擦掉两条，撤销一次全部回来', () => {
    const { container, canvas } = setup();
    penLine(canvas, 100);
    penLine(canvas, 160);
    pickTool(container, '橡皮');

    fireEvent.pointerDown(canvas, { pointerId: 4, pointerType: 'mouse', button: 0, clientX: 150, clientY: 100 });
    fireEvent.pointerMove(canvas, { pointerId: 4, pointerType: 'mouse', buttons: 1, clientX: 150, clientY: 160 });
    fireEvent.pointerUp(canvas, { pointerId: 4, pointerType: 'mouse', clientX: 150, clientY: 160 });
    expect(getDraft('q1')).toHaveLength(0);

    undoKey();
    expect(getDraft('q1')).toHaveLength(2);
  });

  it('选中拖动后撤销，点坐标回到原位', () => {
    const { container, canvas } = setup();
    penLine(canvas, 100);
    pickTool(container, '选中');
    dragSelect(canvas, [50, 50], [300, 200]);

    fireEvent.pointerDown(canvas, { pointerId: 6, pointerType: 'mouse', button: 0, clientX: 150, clientY: 100 });
    fireEvent.pointerMove(canvas, { pointerId: 6, pointerType: 'mouse', buttons: 1, clientX: 250, clientY: 180 });
    fireEvent.pointerUp(canvas, { pointerId: 6, pointerType: 'mouse', clientX: 250, clientY: 180 });
    expect(getDraft('q1')[0].points[0].x).toBeCloseTo(200, 5);
    expect(getDraft('q1')[0].points[0].y).toBeCloseTo(180, 5);

    undoKey();
    expect(getDraft('q1')[0].points[0].x).toBeCloseTo(100, 5);
    expect(getDraft('q1')[0].points[0].y).toBeCloseTo(100, 5);
  });

  it('清空可撤销', () => {
    const { container, canvas } = setup();
    penLine(canvas, 100);
    fireEvent.click(container.querySelector('button[title="清空草稿"]')!);
    expect(getDraft('q1')).toHaveLength(0);
    undoKey();
    expect(getDraft('q1')).toHaveLength(1);
  });

  it('输入框里按 Ctrl+Z 不动草稿', () => {
    const { canvas } = setup();
    penLine(canvas, 100);
    const input = document.createElement('input');
    document.body.appendChild(input);
    fireEvent.keyDown(input, { key: 'z', ctrlKey: true });
    expect(getDraft('q1')).toHaveLength(1);
    input.remove();
  });

  it('撤销按钮初始禁用，画一笔后可用', () => {
    const { container, canvas } = setup();
    const btn = () => container.querySelector('button[aria-label^="撤销"]') as HTMLButtonElement;
    expect(btn().disabled).toBe(true);
    penLine(canvas, 100);
    expect(btn().disabled).toBe(false);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

```bash
cd apps/web && npx vitest run src/components/business/DraftWhiteboard.test.tsx
```

Expected: FAIL —— 撤销后仍是 2 条、找不到 `aria-label^="撤销"` 的按钮。

- [ ] **Step 3: 接入历史（状态 + 打点）**

`DraftWhiteboard.tsx`：

1. import 增加：

```ts
import {
  initHistory, pushState, undo as undoHistory, redo as redoHistory, canUndo, canRedo,
  type DraftState,
} from './draft-history';
```

2. 组件内、`questionIdRef` 之后加：

```ts
/** 只用第二个返回值触发重渲染：历史本体在模块级 Map，按钮可用态渲染时现算（canUndo/canRedo） */
const [, bumpHistory] = useState(0);

/** 记一步：内容与当前态相同（引用全同）时 pushState 返回 false，按钮不会误亮 */
const pushHistory = useCallback(() => {
  if (pushState(questionId, { strokes: strokesRef.current, images: imagesRef.current })) {
    bumpHistory((v) => v + 1);
  }
}, [questionId]);
```

3. 切题 effect 末尾（`redraw()` 之前）加：

```ts
initHistory(questionId, { strokes: strokesRef.current, images: imagesRef.current });
bumpHistory((v) => v + 1);
```

4. `commitShapeStroke`：`redraw()` 之后加 `pushHistory();`，依赖数组补 `pushHistory`。

5. 手写/点：`handlePointerUp` 末尾：

```ts
if (!drawingRef.current) return;
drawingRef.current = false;
if (persist) setDraft(questionId, strokesRef.current);
pushHistory();
```

先在 `drawingRef` 旁加橡皮脏标记：

```ts
/** 本次橡皮手势是否真的擦掉过笔画（一次划过擦多条只记一步历史） */
const eraserDirtyRef = useRef(false);
```

`eraseAt` 内「长度变了」的分支加 `eraserDirtyRef.current = true;`。
`handlePointerDown` 的橡皮分支第一行加 `eraserDirtyRef.current = false;`。

在 `pushHistory` 之后加：

```ts
const flushEraserHistory = useCallback(() => {
  if (!eraserDirtyRef.current) return;
  eraserDirtyRef.current = false;
  pushHistory();
}, [pushHistory]);
```

`handlePointerUp` 顶部加：

```ts
if (tool === 'eraser') { flushEraserHistory(); return; }
```

`handlePointerCancel` 与 `handleLostPointerCapture` 里各加一行 `flushEraserHistory();`（对无橡皮手势幂等）。

6. 选中移动：**必须先克隆再改坐标**（写时复制的核心，漏了会让历史快照里的旧对象被一起改掉，撤销看起来"没反应"）。

先在模块级（`strokeBounds` 之后）加：

```ts
/** 深拷贝单条笔迹（点对象与圆心标记都新建）。
 *  写时复制用：已经进了历史快照的 Stroke 视为只读，原地改坐标的手势必须先克隆。 */
function cloneStroke(s: Stroke): Stroke {
  return {
    ...s,
    points: s.points.map((p) => ({ ...p })),
    ...(s.center ? { center: { ...s.center } } : {}),
  };
}
```

`selectGestureRef` 的 `move` 变体加 `moved: boolean`：

```ts
| { kind: 'move'; startX: number; startY: number; lastX: number; lastY: number; moved: boolean; origImages: Map<string, { x: number; y: number }> }
```

`selectDown` 里「起移动手势」那段（设置 `cursor = 'grabbing'` 与 `origImages` 的地方）前后改成：

```ts
// 移动会原地改点坐标：起手先克隆选中笔迹，历史快照里的旧对象保持不动。
// 点选后没位移（g.moved 为 false）不记历史；克隆坐标与旧对象完全相同，视觉无差异。
const cloneOf = new Map<Stroke, Stroke>();
for (const s of selectedStrokesRef.current) cloneOf.set(s, cloneStroke(s));
if (cloneOf.size) {
  strokesRef.current = strokesRef.current.map((s) => cloneOf.get(s) ?? s);
  selectedStrokesRef.current = new Set(cloneOf.values());
}
const canvas = canvasRef.current;
if (canvas) canvas.style.cursor = 'grabbing';
const origImages = new Map(
  imagesRef.current
    .filter((im) => selectedImageIdsRef.current.has(im.id))
    .map((im) => [im.id, { x: im.x, y: im.y }] as const),
);
selectGestureRef.current = { kind: 'move', startX: x, startY: y, lastX: x, lastY: y, moved: false, origImages };
```

`selectMove` 在 `if (dx === 0 && dy === 0) return;` 之后加 `g.moved = true;`。

`selectUp` 的 `move` 分支改为：

```ts
if (g.kind === 'move') {
  if (g.moved) {
    if (persist) setDraft(questionId, strokesRef.current);
    pushHistory();
  }
  const canvas = canvasRef.current;
  if (canvas) canvas.style.cursor = insideSelectionBounds(x, y) ? 'grab' : 'default';
  redraw();
  return;
}
```

`cancelSelect` 的 `move` 分支改为：

```ts
if (g.kind === 'move' && g.moved) {
  if (persist) setDraft(questionId, strokesRef.current);
  pushHistory();
}
```

7. 贴图插入：`insertImages` 里计数，循环结束后记一步：

```ts
let inserted = 0;
for (let i = 0; i < files.length; i++) {
  const img = await fileToDraftImage(files[i], wrap.clientWidth, viewport);
  if (questionIdRef.current !== currentQ) return; // 切题了，放弃在途插入（不记历史，避免把新题状态写进旧题）
  if (i > 0) { img.x += i * 16; img.y += i * 16; }
  updateImages((prev) => [...prev, img]);
  inserted += 1;
}
if (inserted > 0) pushHistory();
```

依赖数组补 `pushHistory`。

8. Delete 键删除后（`setSelection` 之前）加 `pushHistory();`，依赖数组补 `pushHistory`。

9. 贴图层透传：两处 `<DraftImageLayer … />` 都加 `onCommit={pushHistory}`。

10. `handleClear` 改为（不再调 `clearDraft`，否则历史一起没了，清空就不能撤销）：

```ts
const handleClear = () => {
  strokesRef.current = [];
  imagesRef.current = [];
  setImages([]);
  if (persist) { setDraft(questionId, []); setDraftImages(questionId, []); }
  updateCompass({ phase: 'idle' }); // 圆规一并重置（含重绘）
  shapeGestureRef.current = null;
  resetTriangle();
  selectGestureRef.current = null;
  setSelection(new Set(), new Set());
  pushHistory();
};
```

同时从文件顶部 import 里移除 `clearDraft`（已无引用，lint 会报）。

- [ ] **Step 4: 实现撤销/重做（状态回填 + 快捷键 + 按钮）**

在 `setSelection` 定义之后加：

```ts
/** 有手势在进行时不响应撤销（否则会把半截手势写进历史） */
const gestureBusy = useCallback(() => (
  drawingRef.current
  || selectGestureRef.current !== null
  || shapeGestureRef.current !== null
  || triDragRef.current !== null
  || compassRef.current.phase === 'placing'
  || compassRef.current.phase === 'resizing'
  || compassRef.current.phase === 'drawing'
), []);

/** 把历史快照写回视图与 store；选区必须清空——快照里是另一批对象引用 */
const applyHistoryState = useCallback((snap: DraftState) => {
  strokesRef.current = snap.strokes;
  imagesRef.current = snap.images;
  setImages(snap.images);
  if (persist) {
    setDraft(questionId, snap.strokes);
    setDraftImages(questionId, snap.images);
  }
  setSelection(new Set(), new Set());
}, [persist, questionId, setSelection]);

const doUndo = useCallback(() => {
  if (gestureBusy()) return;
  const snap = undoHistory(questionId);
  if (!snap) return;
  applyHistoryState(snap);
  bumpHistory((v) => v + 1);
}, [gestureBusy, questionId, applyHistoryState]);

const doRedo = useCallback(() => {
  if (gestureBusy()) return;
  const snap = redoHistory(questionId);
  if (!snap) return;
  applyHistoryState(snap);
  bumpHistory((v) => v + 1);
}, [gestureBusy, questionId, applyHistoryState]);
```

快捷键 effect（放在 Delete 键 effect 附近，**不按工具门控**）：

```ts
// 撤销/重做全局快捷键：Ctrl/Cmd+Z、Ctrl/Cmd+Shift+Z、Ctrl+Y。
// 不绑 Ctrl+R —— 它是浏览器/Electron 的刷新，误触会整页重载、内存草稿全丢。
useEffect(() => {
  const onKey = (e: KeyboardEvent) => {
    if (isEditableTarget(e.target)) return;       // 在输入框里要撤销文字
    if (!(e.metaKey || e.ctrlKey) || e.altKey) return;
    const key = e.key.toLowerCase();
    if (key === 'z' && !e.shiftKey) { e.preventDefault(); doUndo(); return; }
    if ((key === 'z' && e.shiftKey) || key === 'y') { e.preventDefault(); doRedo(); }
  };
  document.addEventListener('keydown', onKey);
  return () => document.removeEventListener('keydown', onKey);
}, [doUndo, doRedo]);
```

图标（与现有 `TrashIcon` 同风格）：

```tsx
const UndoIcon = () => (
  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M9 14 4 9l5-5" />
    <path d="M4 9h9a6 6 0 0 1 0 12h-3" />
  </svg>
);

const RedoIcon = () => (
  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="m15 14 5-5-5-5" />
    <path d="M20 9h-9a6 6 0 0 0 0 12h3" />
  </svg>
);
```

工具条里、`<div className="flex-1" />` 与清空按钮之间插入：

```tsx
<button
  onClick={doUndo}
  disabled={!canUndo(questionId)}
  title="撤销（Ctrl+Z）"
  aria-label="撤销（Ctrl+Z）"
  className="w-[38px] h-[38px] rounded-xl border border-[var(--bg-subtle)] bg-[var(--learn-card-bg)] flex items-center justify-center text-[var(--text-tertiary)] hover:bg-[var(--bg-subtle)] transition-colors disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:bg-[var(--learn-card-bg)]"
>
  <UndoIcon />
</button>
<button
  onClick={doRedo}
  disabled={!canRedo(questionId)}
  title="重做（Ctrl+Shift+Z）"
  aria-label="重做（Ctrl+Shift+Z）"
  className="w-[38px] h-[38px] rounded-xl border border-[var(--bg-subtle)] bg-[var(--learn-card-bg)] flex items-center justify-center text-[var(--text-tertiary)] hover:bg-[var(--bg-subtle)] transition-colors disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:bg-[var(--learn-card-bg)]"
>
  <RedoIcon />
</button>
```

> `canUndo/canRedo` 在渲染期现算；`bumpHistory` 只用来触发重渲染，不参与计算。

- [ ] **Step 5: 跑测试确认通过**

```bash
cd apps/web && npx vitest run src/components/business/DraftWhiteboard.test.tsx
```

Expected: PASS（原 3 条 + 新 7 条）。

- [ ] **Step 6: 跑受影响的既有测试**

```bash
cd apps/web && npx vitest run src/components/business/DraftPanel.test.tsx src/components/business/PreviewDraftPanel.test.tsx src/components/business/answer/QuestionRunner.test.tsx
```

Expected: PASS。

- [ ] **Step 7: 提交**

```bash
git add apps/web/src/components/business/DraftWhiteboard.tsx apps/web/src/components/business/DraftWhiteboard.test.tsx
git commit -m "feat(draft): 每一笔操作记一步历史，Ctrl+Z/Ctrl+Shift+Z 与工具栏按钮撤销重做"
```

---

### Task 4: 拖拽模块 `draft-image-drag`

**Files:**
- Create: `apps/web/src/components/business/draft-image-drag.ts`
- Create: `apps/web/src/components/business/draft-image-drag.test.ts`

**Interfaces:**
- Produces: `registerDropTarget(t: DraftDropTarget): () => void`（注销）
- Produces: `beginImageDrag(opts: { src: string; pointerId: number; clientX: number; clientY: number }): void`
- Produces: `wasJustDragged(): boolean`（拖拽结束后 300ms 内为真）
- `DraftDropTarget = { el: HTMLElement; onHover(over: boolean): void; onDrop(src: string, pt: { x: number; y: number }): void }`

- [ ] **Step 1: 写失败测试**

Create `apps/web/src/components/business/draft-image-drag.test.ts`：

```ts
import { describe, it, expect, vi, afterEach } from 'vitest';
import { fireEvent } from '@testing-library/react';
import { beginImageDrag, registerDropTarget, wasJustDragged } from './draft-image-drag';

/** jsdom 所有 getBoundingClientRect 都是 0，这里给目标一个真矩形 */
function makeTarget(rect: { left: number; top: number; width: number; height: number }) {
  const el = document.createElement('div');
  el.getBoundingClientRect = () => ({
    left: rect.left, top: rect.top,
    right: rect.left + rect.width, bottom: rect.top + rect.height,
    width: rect.width, height: rect.height,
    x: rect.left, y: rect.top, toJSON: () => ({}),
  }) as DOMRect;
  document.body.appendChild(el);
  return el;
}

afterEach(() => { document.body.innerHTML = ''; vi.restoreAllMocks(); });

describe('draft-image-drag', () => {
  it('进入草稿区回调 hover，松手按本地坐标回调 drop 并清理幽灵图', () => {
    const el = makeTarget({ left: 100, top: 50, width: 200, height: 200 });
    const onHover = vi.fn();
    const onDrop = vi.fn();
    const off = registerDropTarget({ el, onHover, onDrop });

    beginImageDrag({ src: '/assets/q.png', pointerId: 1, clientX: 120, clientY: 60 });
    expect(document.querySelector('[data-draft-drag-ghost]')).toBeTruthy();

    fireEvent.pointerMove(window, { pointerId: 1, clientX: 150, clientY: 100 });
    expect(onHover).toHaveBeenLastCalledWith(true);

    fireEvent.pointerUp(window, { pointerId: 1, clientX: 150, clientY: 100 });
    expect(onDrop).toHaveBeenCalledWith('/assets/q.png', { x: 50, y: 50 });
    expect(onHover).toHaveBeenLastCalledWith(false);
    expect(document.querySelector('[data-draft-drag-ghost]')).toBeNull();
    off();
  });

  it('松手在草稿区外：不插入', () => {
    const el = makeTarget({ left: 100, top: 50, width: 100, height: 100 });
    const onDrop = vi.fn();
    const off = registerDropTarget({ el, onHover: () => {}, onDrop });
    beginImageDrag({ src: '/assets/q.png', pointerId: 1, clientX: 500, clientY: 500 });
    fireEvent.pointerUp(window, { pointerId: 1, clientX: 500, clientY: 500 });
    expect(onDrop).not.toHaveBeenCalled();
    off();
  });

  it('pointercancel / Escape 取消：不插入，幽灵图清理', () => {
    const el = makeTarget({ left: 0, top: 0, width: 300, height: 300 });
    const onDrop = vi.fn();
    const off = registerDropTarget({ el, onHover: () => {}, onDrop });

    beginImageDrag({ src: '/assets/q.png', pointerId: 1, clientX: 50, clientY: 50 });
    fireEvent.pointerCancel(window, { pointerId: 1, clientX: 50, clientY: 50 });
    expect(onDrop).not.toHaveBeenCalled();
    expect(document.querySelector('[data-draft-drag-ghost]')).toBeNull();

    beginImageDrag({ src: '/assets/q.png', pointerId: 2, clientX: 50, clientY: 50 });
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(onDrop).not.toHaveBeenCalled();
    expect(document.querySelector('[data-draft-drag-ghost]')).toBeNull();
    off();
  });

  it('拖拽结束后 300ms 内 wasJustDragged 为真', () => {
    beginImageDrag({ src: '/assets/q.png', pointerId: 1, clientX: 0, clientY: 0 });
    fireEvent.pointerCancel(window, { pointerId: 1, clientX: 0, clientY: 0 });
    expect(wasJustDragged()).toBe(true);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

```bash
cd apps/web && npx vitest run src/components/business/draft-image-drag.test.ts
```

Expected: FAIL —— 模块不存在。

- [ ] **Step 3: 实现 `draft-image-drag.ts`**

```ts
/** 题干图 → 草稿的拖拽（自绘幽灵图 + 目标注册表）。
 *
 *  为什么不用 HTML5 原生拖拽：iPad Safari 触摸不触发 dragstart/drop，而 iPad 横屏是本项目主断点。
 *  指针事件一套代码同时覆盖鼠标、触屏、手写笔。
 *  拖源只管「开始拖」；落点由草稿白板注册的 DropTarget 决定（canvas 矩形即画板坐标系）。 */

export interface DraftDropTarget {
  /** 命中判定用它的 getBoundingClientRect（草稿白板传 canvas） */
  el: HTMLElement;
  onHover: (over: boolean) => void;
  /** pt = 相对 el 的本地坐标（canvas 即 board 坐标） */
  onDrop: (src: string, pt: { x: number; y: number }) => void;
}

const targets = new Set<DraftDropTarget>();

/** 注册落点；返回注销函数（组件卸载时调用） */
export function registerDropTarget(t: DraftDropTarget): () => void {
  targets.add(t);
  return () => { targets.delete(t); };
}

/** 幽灵图宽度（CSS px）：够看清是哪张图，又不至于盖住落点 */
const GHOST_WIDTH = 96;
/** 拖拽结束后吞 click 的时间窗：松手位置若在图片上，避免顺带打开放大浮层 */
const CLICK_SUPPRESS_MS = 300;

let lastDragEndAt = 0;

export function wasJustDragged(): boolean {
  return Date.now() - lastDragEndAt < CLICK_SUPPRESS_MS;
}

interface DragState {
  src: string;
  pointerId: number;
  ghost: HTMLDivElement;
  hovered: DraftDropTarget | null;
}

let state: DragState | null = null;

/** 多个目标重叠时取最后注册的（后挂载的在视觉上层） */
function targetAt(x: number, y: number): DraftDropTarget | null {
  const list = Array.from(targets);
  for (let i = list.length - 1; i >= 0; i--) {
    const r = list[i].el.getBoundingClientRect();
    if (r.width > 0 && r.height > 0 && x >= r.left && x <= r.right && y >= r.top && y <= r.bottom) return list[i];
  }
  return null;
}

function setHover(next: DraftDropTarget | null): void {
  if (!state || state.hovered === next) return;
  state.hovered?.onHover(false);
  next?.onHover(true);
  state.hovered = next;
}

function moveGhost(x: number, y: number): void {
  if (!state) return;
  state.ghost.style.left = `${x}px`;
  state.ghost.style.top = `${y}px`;
}

function onMove(e: PointerEvent): void {
  if (!state || e.pointerId !== state.pointerId) return;
  moveGhost(e.clientX, e.clientY);
  setHover(targetAt(e.clientX, e.clientY));
}

function onUp(e: PointerEvent): void {
  if (!state || e.pointerId !== state.pointerId) return;
  const target = targetAt(e.clientX, e.clientY);
  if (!target) { cleanup(); return; }
  const r = target.el.getBoundingClientRect();
  const pt = { x: e.clientX - r.left, y: e.clientY - r.top };
  const src = state.src;
  cleanup();
  target.onDrop(src, pt);
}

function onCancel(): void {
  cleanup();
}

function onKey(e: KeyboardEvent): void {
  if (e.key === 'Escape') cleanup();
}

function cleanup(): void {
  if (!state) return;
  window.removeEventListener('pointermove', onMove, true);
  window.removeEventListener('pointerup', onUp, true);
  window.removeEventListener('pointercancel', onCancel, true);
  window.removeEventListener('keydown', onKey, true);
  state.hovered?.onHover(false);
  state.ghost.remove();
  state = null;
  lastDragEndAt = Date.now();
}

export function beginImageDrag(opts: {
  src: string;
  pointerId: number;
  clientX: number;
  clientY: number;
}): void {
  cleanup(); // 同时只允许一个拖拽
  const ghost = document.createElement('div');
  ghost.setAttribute('data-draft-drag-ghost', 'true');
  ghost.setAttribute('aria-hidden', 'true');
  ghost.style.cssText = [
    'position:fixed',
    `left:${opts.clientX}px`,
    `top:${opts.clientY}px`,
    `width:${GHOST_WIDTH}px`,
    'transform:translate(-50%,-50%)',
    'pointer-events:none',
    'z-index:9999',
    'opacity:.75',
    'border-radius:8px',
    'overflow:hidden',
    'background:#fff',
    'box-shadow:0 6px 20px rgba(0,0,0,.25)',
  ].join(';');
  const img = document.createElement('img');
  img.src = opts.src;
  img.alt = '';
  img.draggable = false;
  img.style.cssText = 'display:block;width:100%;height:auto';
  ghost.appendChild(img);
  document.body.appendChild(ghost);

  state = { src: opts.src, pointerId: opts.pointerId, ghost, hovered: null };
  window.addEventListener('pointermove', onMove, true);
  window.addEventListener('pointerup', onUp, true);
  window.addEventListener('pointercancel', onCancel, true);
  window.addEventListener('keydown', onKey, true);
}
```

> 注意函数顺序：`cleanup` 用 `function` 声明（提升），被 `onUp` 等引用时无需提前定义。

- [ ] **Step 4: 跑测试确认通过**

```bash
cd apps/web && npx vitest run src/components/business/draft-image-drag.test.ts
```

Expected: PASS（4 个用例）。

- [ ] **Step 5: 提交**

```bash
git add apps/web/src/components/business/draft-image-drag.ts apps/web/src/components/business/draft-image-drag.test.ts
git commit -m "feat(draft): 指针拖拽模块——幽灵图 + 落点注册表（鼠标/iPad 通用）"
```

---

### Task 5: 题图拖源与落点接入

**Files:**
- Modify: `apps/web/src/components/markdown.tsx`（`MarkdownImg` 加 `dragToDraft`）
- Create: `apps/web/src/components/markdown-drag.test.tsx`
- Modify: `apps/web/src/components/business/answer/QuestionRunner.tsx`
- Modify: `apps/web/src/components/business/DraftWhiteboard.tsx`
- Modify: `apps/web/src/components/business/DraftWhiteboard.test.tsx`

**Interfaces:**
- Consumes: Task 1 `draftImageFromSrc`；Task 3 `pushHistory`；Task 4 `registerDropTarget / beginImageDrag / wasJustDragged`
- Produces: `MarkdownImgProps.dragToDraft?: boolean`
- Produces: 白板落点高亮（`inset 0 0 0 2px var(--brand-500)`）

- [ ] **Step 1: 写失败测试（拖源阈值）**

Create `apps/web/src/components/markdown-drag.test.tsx`：

```tsx
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { cleanup, render, fireEvent } from '@testing-library/react';
import { MarkdownImg } from './markdown';
import { beginImageDrag, wasJustDragged } from './business/draft-image-drag';

vi.mock('./business/draft-image-drag', () => ({
  beginImageDrag: vi.fn(),
  wasJustDragged: vi.fn(() => false),
}));

beforeEach(() => {
  vi.mocked(beginImageDrag).mockClear();
  vi.mocked(wasJustDragged).mockReturnValue(false);
});
afterEach(() => { cleanup(); });

describe('MarkdownImg 拖源', () => {
  it('位移不超过 10px 不触发拖拽；超过才触发，且 src 走 resolveAsset', () => {
    const { container } = render(<MarkdownImg src="questions/a.png" alt="" dragToDraft />);
    const img = container.querySelector('img')!;

    fireEvent.pointerDown(img, { pointerId: 1, pointerType: 'touch', isPrimary: true, clientX: 0, clientY: 0 });
    fireEvent.pointerMove(img, { pointerId: 1, pointerType: 'touch', clientX: 5, clientY: 5 });
    expect(beginImageDrag).not.toHaveBeenCalled();

    fireEvent.pointerMove(img, { pointerId: 1, pointerType: 'touch', clientX: 20, clientY: 0 });
    expect(beginImageDrag).toHaveBeenCalledWith({
      src: '/assets/questions/a.png', pointerId: 1, clientX: 20, clientY: 0,
    });
  });

  it('未开 dragToDraft 的图片不参与拖拽', () => {
    const { container } = render(<MarkdownImg src="questions/a.png" alt="" />);
    const img = container.querySelector('img')!;
    fireEvent.pointerDown(img, { pointerId: 1, isPrimary: true, clientX: 0, clientY: 0 });
    fireEvent.pointerMove(img, { pointerId: 1, clientX: 40, clientY: 0 });
    expect(beginImageDrag).not.toHaveBeenCalled();
  });

  it('刚拖完的 click 不打开放大浮层', () => {
    vi.mocked(wasJustDragged).mockReturnValue(true);
    const { container } = render(<MarkdownImg src="questions/a.png" alt="" dragToDraft />);
    fireEvent.click(container.querySelector('img')!);
    expect(document.querySelector('[role="dialog"]')).toBeNull();
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

```bash
cd apps/web && npx vitest run src/components/markdown-drag.test.tsx
```

Expected: FAIL —— `beginImageDrag` 从未被调用（`dragToDraft` 还不存在）。

- [ ] **Step 3: 实现 `MarkdownImg.dragToDraft`**

`markdown.tsx`：

1. 文件首行的 React import 改为带上 `useRef`，并补充拖拽模块：

```ts
import { Children, isValidElement, useEffect, useRef, useState } from 'react';
import { beginImageDrag, wasJustDragged } from './business/draft-image-drag';
```

2. `MarkdownImgProps` 增加：

```ts
/** 可作为「拖进草稿」的图源（题干/材料启用）：移动 >10px 起拖，<=10px 仍是点击放大 */
dragToDraft?: boolean;
```

3. 常量：

```ts
/** 起拖阈值（CSS px）：小于它仍按点击处理（点图放大），避免轻触就拖走 */
const DRAFT_DRAG_THRESHOLD = 10;
```

4. 组件内加 ref 与三个处理器：

```tsx
const dragOriginRef = useRef<{ x: number; y: number } | null>(null);

const onImgPointerDown = (e: React.PointerEvent<HTMLImageElement>) => {
  if (!dragToDraft || !e.isPrimary) return;
  if (e.pointerType === 'mouse' && e.button !== 0) return;
  dragOriginRef.current = { x: e.clientX, y: e.clientY };
  e.currentTarget.setPointerCapture?.(e.pointerId);
};

const onImgPointerMove = (e: React.PointerEvent<HTMLImageElement>) => {
  const origin = dragOriginRef.current;
  if (!origin) return;
  if (Math.hypot(e.clientX - origin.x, e.clientY - origin.y) <= DRAFT_DRAG_THRESHOLD) return;
  dragOriginRef.current = null; // 一次按下只起一次拖
  beginImageDrag({ src: resolveAsset(src ?? ''), pointerId: e.pointerId, clientX: e.clientX, clientY: e.clientY });
};

const endImgDrag = (e: React.PointerEvent<HTMLImageElement>) => {
  dragOriginRef.current = null;
  if (e.currentTarget.hasPointerCapture?.(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId);
};
```

5. `<img>` 上挂：

```tsx
onPointerDown={dragToDraft ? onImgPointerDown : undefined}
onPointerMove={dragToDraft ? onImgPointerMove : undefined}
onPointerUp={dragToDraft ? endImgDrag : undefined}
onPointerCancel={dragToDraft ? endImgDrag : undefined}
draggable={dragToDraft ? false : undefined}
style={dragToDraft ? { touchAction: 'pan-y', WebkitTouchCallout: 'none', userSelect: 'none' } : undefined}
```

> `WebkitTouchCallout` 不是标准 CSS 属性，TS 会报错时改用 `style={{ touchAction: 'pan-y', WebkitTouchCallout: 'none', userSelect: 'none' } as React.CSSProperties}`。

6. `onClick` 改为：

```tsx
onClick={zoomable ? (e) => { e.stopPropagation(); if (wasJustDragged()) return; setZoom(true); } : undefined}
```

- [ ] **Step 4: 题干/材料启用拖源**

`QuestionRunner.tsx` 在 `questionMarkdownComponents` 之后新增一份（只有 img 不同）：

```tsx
// 题干与材料里的图允许拖进草稿（学生要照着图标注）；提示/解析/参考答案仍用不拖的版本，避免误拖
const draggableQuestionMarkdownComponents = {
  ...questionMarkdownComponents,
  img: (props: { src?: string; alt?: string }) => (
    <MarkdownImg {...props} bucketHeight dragToDraft className="block mx-auto my-4 max-w-full object-contain rounded-lg" />
  ),
};
```

把 `q.material`（`data-testid="question-material"` 内）与 `q.text` 两处 `components={questionMarkdownComponents}` 改为 `components={draggableQuestionMarkdownComponents}`。其余（提示、自评参考答案、解析）不动。

- [ ] **Step 5: 白板注册落点 + 落点插入 + 高亮**

`DraftWhiteboard.tsx`：

1. 把现有 `import { fileToDraftImage, isEditableTarget } from './draft-image-utils';` 改为带上新函数，并新增拖拽模块 import：

```ts
import { fileToDraftImage, draftImageFromSrc, isEditableTarget } from './draft-image-utils';
import { registerDropTarget } from './draft-image-drag';
```

2. 组件内加 hover state：

```ts
const [dropHover, setDropHover] = useState(false);
```

3. 在 `insertImages` 之后加：

```ts
/** 题干图拖入：按松手点插入一张贴图（落点是贴图中心），一次拖入记一步历史 */
const insertImageFromSrc = useCallback(async (src: string, at: { x: number; y: number }) => {
  const canvas = canvasRef.current;
  if (!canvas) return;
  const currentQ = questionIdRef.current;
  let img: DraftImage;
  try {
    img = await draftImageFromSrc(src, canvas.clientWidth, canvas.clientHeight, at);
  } catch {
    console.warn('[draft] 图片解码失败，已跳过', src);
    return;
  }
  if (questionIdRef.current !== currentQ) return; // 切题了：丢弃在途插入
  updateImages((prev) => [...prev, img]);
  pushHistory();
}, [updateImages, pushHistory]);
```

4. 注册落点（放在尺寸 effect 附近）：

```ts
// 拖拽落点 = canvas（画布坐标系原点）；注销函数随卸载调用
useEffect(() => {
  const canvas = canvasRef.current;
  if (!canvas) return;
  return registerDropTarget({
    el: canvas,
    onHover: setDropHover,
    onDrop: (src, pt) => { void insertImageFromSrc(src, pt); },
  });
}, [insertImageFromSrc]);
```

5. 画布区外层（`<div className="flex-1 min-h-0 relative">`）加高亮：

```tsx
style={dropHover ? { boxShadow: 'inset 0 0 0 2px var(--brand-500)' } : undefined}
```

- [ ] **Step 6: 写落点插入测试**

`DraftWhiteboard.test.tsx` 顶部把 testing-library 的 import 改为带上 `waitFor`，store 的 import 改为带上 `getDraftImages`（`vi` 文件顶部已经引入，不重复引）：

```ts
import { cleanup, render, fireEvent, waitFor } from '@testing-library/react';
import { clearDraft, getDraft, getDraftImages } from './draft-store';
import { beginImageDrag } from './draft-image-drag';
```

`afterEach` 改为 `afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); cleanup(); });`

文件末尾追加：

```tsx
describe('草稿白板：题干图拖入', () => {
  it('落在松手点、宽 60%、可撤销', async () => {
    class FakeImage {
      onload: (() => void) | null = null;
      onerror: (() => void) | null = null;
      naturalWidth = 400;
      naturalHeight = 300;
      set src(_v: string) { queueMicrotask(() => this.onload?.()); }
    }
    vi.stubGlobal('Image', FakeImage as unknown as typeof Image);

    const { container, canvas } = setup();
    Object.defineProperty(canvas, 'clientWidth', { value: 400, configurable: true });
    Object.defineProperty(canvas, 'clientHeight', { value: 600, configurable: true });
    canvas.getBoundingClientRect = () => ({
      left: 0, top: 0, right: 400, bottom: 600, width: 400, height: 600, x: 0, y: 0, toJSON: () => ({}),
    }) as DOMRect;

    beginImageDrag({ src: '/assets/q.png', pointerId: 7, clientX: 200, clientY: 300 });
    fireEvent.pointerUp(window, { pointerId: 7, clientX: 200, clientY: 300 });

    await waitFor(() => expect(getDraftImages('q1')).toHaveLength(1));
    const img = getDraftImages('q1')[0];
    expect(img.src).toBe('/assets/q.png');
    expect(img.w).toBe(240);
    expect(img.h).toBe(180);
    expect(img.x).toBe(80);
    expect(img.y).toBe(210);
    expect(container.querySelector('img[alt="草稿贴图"]')).toBeTruthy();

    fireEvent.keyDown(document, { key: 'z', ctrlKey: true });
    expect(getDraftImages('q1')).toHaveLength(0);
  });
});
```

- [ ] **Step 7: 跑测试确认通过**

```bash
cd apps/web && npx vitest run src/components/markdown-drag.test.tsx src/components/business/DraftWhiteboard.test.tsx
```

Expected: PASS。

- [ ] **Step 8: 跑题面渲染相关既有测试**

```bash
cd apps/web && npx vitest run src/components/markdown.test.tsx src/components/business/answer/QuestionRunner.test.tsx
```

Expected: PASS（`draggable={undefined}` 不改变原有 img 行为）。

- [ ] **Step 9: 提交**

```bash
git add apps/web/src/components/markdown.tsx apps/web/src/components/markdown-drag.test.tsx \
        apps/web/src/components/business/answer/QuestionRunner.tsx \
        apps/web/src/components/business/DraftWhiteboard.tsx \
        apps/web/src/components/business/DraftWhiteboard.test.tsx
git commit -m "feat(draft): 题干/材料图片可拖进草稿（指针拖拽，落点即放置点）"
```

---

### Task 6: 旋转

**Files:**
- Modify: `apps/web/src/components/business/DraftWhiteboard.tsx`
- Modify: `apps/web/src/components/business/DraftWhiteboard.test.tsx`

**Interfaces:**
- Consumes: Task 3 `pushHistory`、`selectGestureRef`、`drawSelectionOverlay`、现有 `strokeBounds`
- Produces: `RotateGesture`（`selectGestureRef` 第三态）；手柄命中半径 20px、默认高出包围盒 26px、Shift 吸附 15°

- [ ] **Step 1: 写失败测试**

`DraftWhiteboard.test.tsx` 末尾追加：

```tsx
describe('草稿白板：旋转', () => {
  /** 用直线工具画一条精确水平线 (100,100)-(200,100) */
  function horizontalLine(container: Element, canvas: Element) {
    pickTool(container, '直线');
    fireEvent.pointerDown(canvas, { pointerId: 5, pointerType: 'mouse', button: 0, clientX: 100, clientY: 100 });
    fireEvent.pointerMove(canvas, { pointerId: 5, pointerType: 'mouse', buttons: 1, clientX: 200, clientY: 100 });
    fireEvent.pointerUp(canvas, { pointerId: 5, pointerType: 'mouse', clientX: 200, clientY: 100 });
  }

  it('选中后拖旋转手柄 90°：水平线变竖直线，撤销复原', () => {
    const { container, canvas } = setup();
    horizontalLine(container, canvas);
    pickTool(container, '选中');
    dragSelect(canvas, [50, 50], [300, 200]);   // 包围盒 x 100..200 / y 100 → 手柄 (150, 74)

    fireEvent.pointerDown(canvas, { pointerId: 9, pointerType: 'mouse', button: 0, clientX: 150, clientY: 74 });
    fireEvent.pointerMove(canvas, { pointerId: 9, pointerType: 'mouse', buttons: 1, clientX: 250, clientY: 100 });
    fireEvent.pointerUp(canvas, { pointerId: 9, pointerType: 'mouse', clientX: 250, clientY: 100 });

    const pts = getDraft('q1')[0].points;
    expect(pts[0].x).toBeCloseTo(150, 0);
    expect(pts[0].y).toBeCloseTo(50, 0);
    expect(pts[1].x).toBeCloseTo(150, 0);
    expect(pts[1].y).toBeCloseTo(150, 0);

    fireEvent.keyDown(document, { key: 'z', ctrlKey: true });
    const back = getDraft('q1')[0].points;
    expect(back[0].y).toBeCloseTo(100, 5);
    expect(back[1].x).toBeCloseTo(200, 5);
  });

  it('按住 Shift 吸附 15°：拖到 20° 位置吸收到 15°', () => {
    const { container, canvas } = setup();
    horizontalLine(container, canvas);
    pickTool(container, '选中');
    dragSelect(canvas, [50, 50], [300, 200]);

    // 起手角 -90°，拖到相对 +20° 的位置（极角 -70°）
    const r = 60;
    const endX = 150 + r * Math.cos((-70 * Math.PI) / 180);
    const endY = 100 + r * Math.sin((-70 * Math.PI) / 180);
    fireEvent.pointerDown(canvas, { pointerId: 10, pointerType: 'mouse', button: 0, clientX: 150, clientY: 74 });
    fireEvent.pointerMove(canvas, { pointerId: 10, pointerType: 'mouse', buttons: 1, shiftKey: true, clientX: endX, clientY: endY });
    fireEvent.pointerUp(canvas, { pointerId: 10, pointerType: 'mouse', clientX: endX, clientY: endY });

    const a = getDraft('q1')[0].points[0];
    const b = getDraft('q1')[0].points[1];
    const deg = (Math.atan2(b.y - a.y, b.x - a.x) * 180) / Math.PI;
    // 起手角 -90°，拖到 -70° → 原始 20°，Shift 吸附 15° → 线的方向从 0° 变成 15°
    expect(deg).toBeCloseTo(15, 0);
  });
});
```

> 第二条用例验证 Shift 吸附确实按 15° 生效（不吸附的话方向会是 20°）。

- [ ] **Step 2: 跑测试确认失败**

```bash
cd apps/web && npx vitest run src/components/business/DraftWhiteboard.test.tsx -t "旋转"
```

Expected: FAIL —— 拖手柄被当成框选/移动，点坐标没变。

- [ ] **Step 3: 实现旋转几何与绘制**

`DraftWhiteboard.tsx` 模块级（放在 `strokeBounds` 之后）：

```ts
/** 选中笔迹的并集包围盒（null = 没有选中笔迹） */
function unionStrokeBounds(sel: Iterable<Stroke>): { x0: number; y0: number; x1: number; y1: number } | null {
  let out: { x0: number; y0: number; x1: number; y1: number } | null = null;
  for (const s of sel) {
    const b = strokeBounds(s);
    if (!out) out = { ...b };
    else {
      out.x0 = Math.min(out.x0, b.x0);
      out.y0 = Math.min(out.y0, b.y0);
      out.x1 = Math.max(out.x1, b.x1);
      out.y1 = Math.max(out.y1, b.y1);
    }
  }
  return out;
}

/** 旋转手柄：默认在选区上方 26px；上方空间不足（y0 < 48）时放到下方，避免顶出画布抓不到 */
const ROTATE_HANDLE_GAP = 26;
const ROTATE_HANDLE_R = 6;
/** 命中半径 20px：iPad 手指够得着（本体只有 12px 直径） */
const ROTATE_HANDLE_HIT = 20;
/** Shift 吸附步长 15° */
const ROTATE_SNAP = Math.PI / 12;
/** 小于 0.5° 视为没有旋转（不记历史、不落盘） */
const MIN_ROTATE_ANGLE = Math.PI / 360;

interface RotateHandle {
  x: number;
  y: number;
  /** 连线接在包围盒的哪条边（上方手柄接 y0，下方手柄接 y1） */
  edgeY: number;
  below: boolean;
}

function rotateHandleFor(b: { x0: number; y0: number; x1: number; y1: number }): RotateHandle {
  const cx = (b.x0 + b.x1) / 2;
  return b.y0 >= 48
    ? { x: cx, y: b.y0 - ROTATE_HANDLE_GAP, edgeY: b.y0 - 4, below: false }
    : { x: cx, y: b.y1 + ROTATE_HANDLE_GAP, edgeY: b.y1 + 4, below: true };
}

function hitRotateHandle(b: { x0: number; y0: number; x1: number; y1: number }, x: number, y: number): boolean {
  const h = rotateHandleFor(b);
  return Math.hypot(h.x - x, h.y - y) <= ROTATE_HANDLE_HIT;
}

interface RotateGesture {
  kind: 'rotate';
  cx: number;
  cy: number;
  /** 起手极角 */
  a0: number;
  /** 当前累计角（rad，已吸附） */
  total: number;
  items: Array<{
    stroke: Stroke;
    /** 起手时的点坐标（每帧从它重算，避免逐帧累积误差） */
    ox: number[];
    oy: number[];
    oc?: { x: number; y: number };
  }>;
}
```

`drawSelectionOverlay` 签名追加最后一个参数，并在 `ctx.restore()` 前画手柄：

```ts
function drawSelectionOverlay(
  ctx: CanvasRenderingContext2D,
  canvas: HTMLCanvasElement,
  selectedStrokes: ReadonlySet<Stroke>,
  images: DraftImage[],
  selectedImageIds: ReadonlySet<string>,
  marquee: { startX: number; startY: number; x: number; y: number } | null,
  rotate: { handle: RotateHandle; deg: number | null } | null,
): void {
  // …原有包围盒 / 框选逻辑不变…

  if (rotate) {
    const { handle, deg } = rotate;
    const bg = (getComputedStyle(canvas).getPropertyValue('--learn-card-bg') || '#fff').trim();
    ctx.strokeStyle = brand;
    ctx.lineWidth = 1;
    ctx.setLineDash([]);
    // 连线：从包围盒边缘接到旋钮
    ctx.beginPath();
    ctx.moveTo(handle.x, handle.edgeY);
    ctx.lineTo(handle.x, handle.below ? handle.y - ROTATE_HANDLE_R : handle.y + ROTATE_HANDLE_R);
    ctx.stroke();
    // 旋钮：实心圆 + 中心小孔（视觉上像可抓的把手，与普通控制点区分）
    ctx.beginPath();
    ctx.arc(handle.x, handle.y, ROTATE_HANDLE_R, 0, Math.PI * 2);
    ctx.fillStyle = brand;
    ctx.fill();
    ctx.beginPath();
    ctx.arc(handle.x, handle.y, 2, 0, Math.PI * 2);
    ctx.fillStyle = bg;
    ctx.fill();
    if (deg !== null) {
      ctx.fillStyle = (getComputedStyle(canvas).getPropertyValue('--text-tertiary') || '#999').trim();
      ctx.font = '12px system-ui, sans-serif';
      ctx.textAlign = 'left';
      ctx.textBaseline = 'bottom';
      ctx.fillText(`${Math.round(deg)}°`, handle.x + 10, handle.y - 10);
    }
  }
  ctx.restore();
}
```

`redraw` 里 select 分支改为：

```ts
if (toolRef.current === 'select') {
  const g = selectGestureRef.current;
  const selB = selectedStrokesRef.current.size ? unionStrokeBounds(selectedStrokesRef.current) : null;
  drawSelectionOverlay(
    ctx, canvas, selectedStrokesRef.current, imagesRef.current, selectedImageIdsRef.current,
    g && g.kind === 'marquee' ? g : null,
    selB
      ? { handle: rotateHandleFor(selB), deg: g && g.kind === 'rotate' ? (g.total * 180) / Math.PI : null }
      : null,
  );
}
```

- [ ] **Step 4: 实现旋转手势**

1. `selectGestureRef` 类型加第三态：`| RotateGesture`。
2. 在 `selectDown` 最前面加手柄判定：

```ts
const selBounds = selectedStrokesRef.current.size ? unionStrokeBounds(selectedStrokesRef.current) : null;
if (selBounds && hitRotateHandle(selBounds, x, y)) {
  startRotate(x, y, selBounds);
  return;
}
```

3. 在 `selectDown` 之前加 `startRotate`：

```ts
/** 起手旋转：先克隆选中笔迹（写时复制），再改克隆——历史快照里的旧对象必须保持不变 */
const startRotate = (x: number, y: number, b: { x0: number; y0: number; x1: number; y1: number }) => {
  const cx = (b.x0 + b.x1) / 2;
  const cy = (b.y0 + b.y1) / 2;
  const cloneOf = new Map<Stroke, Stroke>();
  const items: RotateGesture['items'] = [];
  for (const s of selectedStrokesRef.current) {
    const clone = cloneStroke(s);
    cloneOf.set(s, clone);
    items.push({
      stroke: clone,
      ox: s.points.map((p) => p.x),
      oy: s.points.map((p) => p.y),
      oc: s.center ? { x: s.center.x, y: s.center.y } : undefined,
    });
  }
  strokesRef.current = strokesRef.current.map((s) => cloneOf.get(s) ?? s);
  setSelection(new Set(items.map((it) => it.stroke)), new Set(selectedImageIdsRef.current));
  selectGestureRef.current = { kind: 'rotate', cx, cy, a0: angleAt(cx, cy, x, y), total: 0, items };
  const canvas = canvasRef.current;
  if (canvas) canvas.style.cursor = 'grabbing';
};
```

4. `selectMove` 改签名 `(x: number, y: number, shiftKey: boolean)`，`handlePointerMove` 的 select 分支改为 `selectMove(p.x, p.y, e.shiftKey);`。函数内：

```ts
if (!g) {
  const canvas = canvasRef.current;
  if (canvas) {
    const b = selectedStrokesRef.current.size ? unionStrokeBounds(selectedStrokesRef.current) : null;
    canvas.style.cursor = (b && hitRotateHandle(b, x, y)) || insideSelectionBounds(x, y) ? 'grab' : 'default';
  }
  return;
}
if (g.kind === 'marquee') { g.x = x; g.y = y; redraw(); return; }
if (g.kind === 'rotate') {
  const raw = normalizeAngle(angleAt(g.cx, g.cy, x, y) - g.a0);
  const total = shiftKey ? Math.round(raw / ROTATE_SNAP) * ROTATE_SNAP : raw;
  g.total = total;
  const cos = Math.cos(total);
  const sin = Math.sin(total);
  for (const it of g.items) {
    for (let i = 0; i < it.stroke.points.length; i++) {
      const dx = it.ox[i] - g.cx;
      const dy = it.oy[i] - g.cy;
      it.stroke.points[i].x = g.cx + dx * cos - dy * sin;
      it.stroke.points[i].y = g.cy + dx * sin + dy * cos;
    }
    if (it.stroke.center && it.oc) {
      const dx = it.oc.x - g.cx;
      const dy = it.oc.y - g.cy;
      it.stroke.center.x = g.cx + dx * cos - dy * sin;
      it.stroke.center.y = g.cy + dx * sin + dy * cos;
    }
  }
  redraw();
  return;
}
// 原有 move 分支…
```

5. `selectUp` 在 `move` 分支之前加：

```ts
if (g.kind === 'rotate') {
  if (Math.abs(g.total) >= MIN_ROTATE_ANGLE) {
    if (persist) setDraft(questionId, strokesRef.current);
    pushHistory();
  }
  const canvas = canvasRef.current;
  if (canvas) canvas.style.cursor = 'default';
  redraw();
  return;
}
```

6. `cancelSelect` 同样处理（手势被系统打断时按当前角度落定）：

```ts
if (g.kind === 'rotate') {
  if (Math.abs(g.total) >= MIN_ROTATE_ANGLE) {
    if (persist) setDraft(questionId, strokesRef.current);
    pushHistory();
  }
  redraw();
  return;
}
```

7. 选中工具按钮文案补充旋转：

```ts
{ toolBtn('select', '选中（点选/框选，拖动移动，上方手柄旋转，Delete 删除）', <SelectIcon />) }
```

- [ ] **Step 5: 跑测试确认通过**

```bash
cd apps/web && npx vitest run src/components/business/DraftWhiteboard.test.tsx
```

Expected: PASS（原有用例全过 + 旋转 2 条）。

- [ ] **Step 6: 提交**

```bash
git add apps/web/src/components/business/DraftWhiteboard.tsx apps/web/src/components/business/DraftWhiteboard.test.tsx
git commit -m "feat(draft): 选中后拖动旋转手柄，笔迹/图形绕选区中心旋转（Shift 吸附 15°）"
```

---

### Task 7: 收尾：全量验证 + 变更日志

**Files:**
- Modify: `docs/ai-core-changelog.md`（顶部新增一条）

**Interfaces:** 无新增。

- [ ] **Step 1: 全量前端测试**

```bash
cd apps/web && npm test
```

Expected: 全部 PASS。若有失败逐个修，不要跳过。

- [ ] **Step 2: lint + 构建**

```bash
cd apps/web && npm run lint && npm run build
```

Expected: 无 error。`build` 会覆盖 `dist/`（若用户正开着 dev server，仅在报告里说明，不回退）。

- [ ] **Step 3: 残留检查**

```bash
cd apps/web && grep -rn "\.dataUrl" src || echo "OK: 无 dataUrl 字段引用"
grep -rn "ctrlKey.*'r'\|key === 'r'" src || echo "OK: 未绑定 Ctrl+R"
```

Expected: 两条都输出 OK。

- [ ] **Step 4: 写变更日志**

在 `docs/ai-core-changelog.md` 的 `---` 之后（最新一条之前）插入：

```markdown
## 2026-11-03 新增：草稿白板——题图拖入 / 撤销重做 / 旋转

**需求**：真题与训练页的草稿只有粘贴/文件插入图片、画错只能擦、图形不能转方向。

**实现**：
1. **题图拖入**：`MarkdownImg.dragToDraft` 作拖源（题干与材料启用，提示/解析不启用），`draft-image-drag.ts` 用指针事件自绘幽灵图 + 草稿 canvas 注册落点；落点即贴图中心、宽取画板 60%，`DraftImage.src` 直接存 `resolveAsset` 后的地址（不复制 base64）。配合 `touch-action: pan-y` 只拦横向拖拽，纵向仍滚页面。
2. **撤销/重做**：`draft-history.ts` 按题保存「操作后的快照」列表 + 游标（上限 51 个状态 = 50 步），快照只复制 `strokes[]`/`images[]`、元素对象共享；已进快照的 `Stroke` 视为只读，唯一两个原地改坐标的手势（选中移动、旋转）起手先克隆。粒度 = 一次手势（橡皮一次划过擦多条算一步、一次粘多张算一步），清空也可撤销。`Ctrl/Cmd+Z` 撤销、`Ctrl/Cmd+Shift+Z` 与 `Ctrl+Y` 重做；**不绑 `Ctrl+R`**（刷新，误触会丢内存草稿），工具栏另有按钮给 iPad。
3. **旋转**：选中工具选区上方出现旋钮（上方空间不足改到下方），绕选区包围盒中心把点列做旋转矩阵变换，Shift 吸附 15°、手柄旁显示角度；贴图不参与旋转。

**测试**：`draft-history.test.ts`、`draft-image-utils.test.ts`、`DraftImageLayer.test.tsx`、`draft-image-drag.test.ts`、`markdown-drag.test.tsx`、`DraftWhiteboard.test.tsx`（撤销/重做/橡皮合并步/清空可撤销/输入框放行/拖入/旋转），前端全量通过。

**未做**：贴图旋转与裁剪、草稿导出、localStorage 持久化、形状对象模型、`Ctrl+R` 绑定。
```

- [ ] **Step 5: 人工验收（iPad 必测）**

按 spec §9 的 8 条走一遍，重点是 1/2/3/6/7：

1. 真题页开草稿 → 手指按住题干图横向拖到草稿 → 落点正确、宽约画板 60%，拖动中有幽灵图与草稿区高亮
2. 轻点题干图仍放大；纵向滑动图片仍能滚页面
3. 画 3 笔 → 撤销 2 次 → 重做 1 次，笔迹与顺序正确
4. 橡皮一次划过擦掉多条 → 一次撤销全部回来
5. 清空 → 撤销 → 全部回来
6. 画矩形 → 选中 → 拖旋钮旋转，Shift 吸附到 15° 整数倍、读数正确
7. 关面板再开：内容与撤销栈都在
8. 提交答案后重进同题：草稿与撤销栈都为空

- [ ] **Step 6: 提交**

```bash
git add docs/ai-core-changelog.md
git commit -m "docs(changelog): 草稿白板题图拖入 / 撤销重做 / 旋转"
```

---

## 附：任务依赖与并行度

- Task 1 → Task 2 可并行（互不依赖），但都在 `draft-store.ts` 上改动，建议串行避免冲突。
- Task 3 依赖 Task 2；Task 5 依赖 Task 1（`draftImageFromSrc`）、Task 3（`pushHistory`）、Task 4（拖拽模块）。
- Task 6 依赖 Task 3（`pushHistory`、选中手势结构）。
- Task 7 必须最后做。
