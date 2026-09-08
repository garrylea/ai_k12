# 草稿白板粘贴图片 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 草稿组件（DraftWhiteboard）支持粘贴/拖入图片，图片作为 div 显示、可移动、可等比缩放、可删除，笔迹恒在图片上方可标注。

**Architecture:** DOM 图片层（新组件 DraftImageLayer）渲染在 canvas 之下；工具条新增「移动」档，该档下 canvas 穿透、图片可交互。图片数据并行存入 draft-store 内存 Map（与 Stroke 既有 API 互不影响），持久化跟随现有 persist 约定。规格见 `docs/superpowers/specs/2026-09-08-draft-paste-image-design.md`。

**Tech Stack:** React 19 + TypeScript + Tailwind（apps/web）。无测试框架（CLAUDE.md 明确），每任务验证 = `npx tsc -b` + `npm run lint`（apps/web 目录），最后人工走查清单。

**关键背景（执行者必读）：**
- `DraftWhiteboard.tsx` 现有结构：工具条（笔/橡皮/清空）+ wrap 容器（fit 模式 relative 直贴 / scroll-y 模式内含 board div）+ canvas（absolute inset-0，pointer 事件全套）
- `draft-store.ts`：模块级 `Map<string, Stroke[]>`，`getDraft/setDraft/clearDraft` 三 API
- 调用方：`DraftDrawer`（scroll-y、persist=false、key=questionId 条件挂载）、`PreviewDraftPanel`（fit、persist=true）；`QuestionRunner` 提交时调 `clearDraft`。本次所有调用方**零改动**
- 样式铁律：无 emoji、线性 SVG 图标、配色走 CSS 变量（`var(--brand-500)` 等）

---

### Task 1: draft-store 扩展 DraftImage 存储

**Files:**
- Modify: `apps/web/src/components/business/draft-store.ts`

- [ ] **Step 1: 追加 DraftImage 类型与并行存储 API**

在 `draft-store.ts` 末尾追加（不动既有 `Stroke`/`store`/`getDraft`/`setDraft`）：

```ts
/** 草稿贴图：坐标/尺寸相对 board（与笔迹同坐标系；scroll-y 模式 y 可超一屏） */
export interface DraftImage {
  id: string;      // crypto.randomUUID()
  dataUrl: string; // 压缩后的 data URL（最大边 ≤1600，见 draft-image-utils）
  x: number;
  y: number;
  w: number; // 显示宽（CSS px）
  h: number; // 显示高（CSS px）
}

const imageStore = new Map<string, DraftImage[]>();

export function getDraftImages(key: string): DraftImage[] {
  return imageStore.get(key) ?? [];
}

export function setDraftImages(key: string, images: DraftImage[]): void {
  imageStore.set(key, images);
}
```

- [ ] **Step 2: clearDraft 改为双清**

把既有：

```ts
export function clearDraft(key: string): void {
  store.delete(key);
}
```

改为：

```ts
export function clearDraft(key: string): void {
  store.delete(key);
  imageStore.delete(key);
}
```

同时把文件头注释第 1 行补一句贴图说明（`草稿白板内存缓存：模块级 Map，随题（key）隔离。` 后追加 `笔迹与贴图两个并行 Map，clearDraft 同时清两者。`）。

- [ ] **Step 3: 类型检查**

Run: `cd apps/web && npx tsc -b`
Expected: 无输出（通过）

- [ ] **Step 4: Commit**

```bash
git add apps/web/src/components/business/draft-store.ts
git commit -m "feat(web): draft-store 扩展贴图存储——DraftImage 并行 Map，clearDraft 双清"
```

---

### Task 2: 图片工具函数（压缩 + 初始尺寸 + 可编辑目标判定）

**Files:**
- Create: `apps/web/src/components/business/draft-image-utils.ts`

- [ ] **Step 1: 写入完整文件**

```ts
// apps/web/src/components/business/draft-image-utils.ts
// 草稿贴图工具：File → 压缩 data URL → DraftImage（初始尺寸/落点）。
// 内存保护：data URL 全程在内存，最大边 >1600px 先等比缩再转，避免大图撑爆页面。
import type { DraftImage } from './draft-store';

/** 压缩上限（px）：图片最大边超过该值先等比缩到该值 */
const MAX_EDGE = 1600;
/** 贴图初始宽 = board 宽 × 该系数（等比；原图更小则按原图） */
const INIT_WIDTH_FACTOR = 0.6;

/** 事件目标是输入框/可编辑元素时返回 true（粘贴/删除键此时必须放行，不拦截） */
export function isEditableTarget(t: EventTarget | null): boolean {
  const el = t as HTMLElement | null;
  if (!el || typeof el.tagName !== 'string') return false;
  const tag = el.tagName.toLowerCase();
  return tag === 'input' || tag === 'textarea' || tag === 'select' || el.isContentEditable;
}

/** 图片文件 → 压缩 data URL + 尺寸。FileReader 读出后经 Image 解码取自然尺寸，超限走离屏 canvas。 */
async function loadImage(file: File): Promise<{ dataUrl: string; w: number; h: number }> {
  const rawDataUrl = await new Promise<string>((resolve, reject) => {
    const fr = new FileReader();
    fr.onload = () => resolve(fr.result as string);
    fr.onerror = () => reject(fr.error);
    fr.readAsDataURL(file);
  });
  const img = await new Promise<HTMLImageElement>((resolve, reject) => {
    const el = new Image();
    el.onload = () => resolve(el);
    el.onerror = () => reject(new Error('image decode failed'));
    el.src = rawDataUrl;
  });
  const w = img.naturalWidth;
  const h = img.naturalHeight;
  if (Math.max(w, h) <= MAX_EDGE) return { dataUrl: rawDataUrl, w, h };
  const scale = MAX_EDGE / Math.max(w, h);
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(w * scale);
  canvas.height = Math.round(h * scale);
  canvas.getContext('2d')!.drawImage(img, 0, 0, canvas.width, canvas.height);
  const type = ['image/png', 'image/jpeg', 'image/webp'].includes(file.type) ? file.type : 'image/png';
  return { dataUrl: canvas.toDataURL(type), w: canvas.width, h: canvas.height };
}

/** 图片文件 → 待插入 DraftImage：初始宽 board 宽 × 0.6（原图更小按原图），等比，
 *  落在可视区域中央（scroll-y 模式 viewport.top = wrap.scrollTop；负坐标夹到 0）。 */
export async function fileToDraftImage(
  file: File,
  boardW: number,
  viewport: { left: number; top: number; width: number; height: number },
): Promise<DraftImage> {
  const { dataUrl, w: nw, h: nh } = await loadImage(file);
  const w = Math.min(Math.round(boardW * INIT_WIDTH_FACTOR), nw);
  const h = Math.round((w / nw) * nh);
  const x = Math.max(0, Math.round(viewport.left + (viewport.width - w) / 2));
  const y = Math.max(0, Math.round(viewport.top + (viewport.height - h) / 2));
  return { id: crypto.randomUUID(), dataUrl, x, y, w, h };
}
```

- [ ] **Step 2: 类型检查**

Run: `cd apps/web && npx tsc -b`
Expected: 无输出（通过）

- [ ] **Step 3: Commit**

```bash
git add apps/web/src/components/business/draft-image-utils.ts
git commit -m "feat(web): 草稿贴图工具——压缩(≤1600)/初始尺寸(60%板宽)/可编辑目标判定"
```

---

### Task 3: DraftImageLayer 组件（渲染/拖动/缩放/删除）

**Files:**
- Create: `apps/web/src/components/business/DraftImageLayer.tsx`

- [ ] **Step 1: 写入完整文件**

```tsx
// apps/web/src/components/business/DraftImageLayer.tsx
// 草稿贴图层：渲染在 canvas 之下（DOM 序在前，笔迹恒覆盖图片可标注）。
// interactive=false（笔/橡皮档）整层穿透，canvas 行为与无本层时完全一致；
// interactive=true（移动档）图片可拖动/四角等比缩放/删除。
import { useEffect, useRef, useState } from 'react';
import type { DraftImage } from './draft-store';
import { isEditableTarget } from './draft-image-utils';

/** 四角拖拽宽度下限（px） */
const MIN_SIZE = 40;

type Corner = 'nw' | 'ne' | 'sw' | 'se';

interface Props {
  images: DraftImage[];
  /** 全量更新（updater 形式，父级持 ref 镜像避免异步闭包拿到旧数组）；父级负责 persist 落库 */
  onImagesChange: (updater: (prev: DraftImage[]) => DraftImage[]) => void;
  /** true = 移动工具（可交互）；false 时整层 pointer-events:none 穿透 */
  interactive: boolean;
}

export function DraftImageLayer({ images, onImagesChange, interactive }: Props) {
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const layerRef = useRef<HTMLDivElement>(null);
  // 拖动：pointer 起点与图片原位置的偏移（client 坐标，拖动中无滚动，无漂移）
  const dragRef = useRef<{ id: string; dx: number; dy: number } | null>(null);
  // 缩放：corner 决定锚定对角（nw 锚 se、ne 锚 sw、sw 锚 ne、se 锚 nw）
  const resizeRef = useRef<{
    id: string; corner: Corner; startX: number;
    origX: number; origY: number; origW: number; origH: number;
  } | null>(null);

  // 离开移动工具即取消选中（控制点/删除钮不残留）
  useEffect(() => { if (!interactive) setSelectedId(null); }, [interactive]);

  // Delete/Backspace 删除选中图（焦点在输入框时放行不拦截）
  useEffect(() => {
    if (!interactive || !selectedId) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Delete' && e.key !== 'Backspace') return;
      if (isEditableTarget(e.target)) return;
      e.preventDefault();
      onImagesChange((prev) => prev.filter((im) => im.id !== selectedId));
      setSelectedId(null);
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [interactive, selectedId, onImagesChange]);

  const patchImage = (id: string, patch: Partial<DraftImage>) =>
    onImagesChange((prev) => prev.map((im) => (im.id === id ? { ...im, ...patch } : im)));

  const removeImage = (id: string) => {
    onImagesChange((prev) => prev.filter((im) => im.id !== id));
    setSelectedId(null);
  };

  // ---- 拖动 ----
  const startDrag = (e: React.PointerEvent<HTMLDivElement>, img: DraftImage) => {
    e.currentTarget.setPointerCapture(e.pointerId);
    setSelectedId(img.id);
    dragRef.current = { id: img.id, dx: e.clientX - img.x, dy: e.clientY - img.y };
  };
  const onDragMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const d = dragRef.current;
    if (!d) return;
    const img = images.find((im) => im.id === d.id);
    if (!img) return;
    // 夹在板内（负方向不允许拖出；右侧/下侧超界交给 board overflow 裁切）
    const boardW = layerRef.current?.clientWidth ?? Infinity;
    const boardH = layerRef.current?.clientHeight ?? Infinity;
    const x = Math.max(0, Math.round(e.clientX - d.dx));
    const y = Math.max(0, Math.round(e.clientY - d.dy));
    void boardW; void boardH; void img;
    patchImage(d.id, { x, y });
  };
  const endDrag = () => { dragRef.current = null; };

  // ---- 缩放 ----
  const startResize = (e: React.PointerEvent<HTMLDivElement>, img: DraftImage, corner: Corner) => {
    e.stopPropagation(); // 不触发图片主体的拖动
    e.currentTarget.setPointerCapture(e.pointerId);
    resizeRef.current = {
      id: img.id, corner, startX: e.clientX,
      origX: img.x, origY: img.y, origW: img.w, origH: img.h,
    };
  };
  const onResizeMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const r = resizeRef.current;
    if (!r) return;
    const dxTotal = e.clientX - r.startX;
    const east = r.corner === 'ne' || r.corner === 'se';
    const boardW = layerRef.current?.clientWidth ?? Infinity;
    const w = Math.min(Math.max(MIN_SIZE, Math.round(east ? r.origW + dxTotal : r.origW - dxTotal)), boardW);
    const h = Math.round((w / r.origW) * r.origH); // 等比
    const x = east ? r.origX : r.origX + (r.origW - w);
    const y = r.corner[0] === 'n' ? r.origY + (r.origH - h) : r.origY;
    patchImage(r.id, { x, y, w, h });
  };
  const endResize = () => { resizeRef.current = null; };

  const handleStyle = (corner: Corner): React.CSSProperties => {
    const pos: Record<Corner, React.CSSProperties> = {
      nw: { left: -5, top: -5, cursor: 'nwse-resize' },
      ne: { right: -5, top: -5, cursor: 'nesw-resize' },
      sw: { left: -5, bottom: -5, cursor: 'nesw-resize' },
      se: { right: -5, bottom: -5, cursor: 'nwse-resize' },
    };
    return { position: 'absolute', width: 10, height: 10, borderRadius: 2, background: 'var(--brand-500)', ...pos[corner] };
  };

  return (
    <div ref={layerRef} className="absolute inset-0" style={{ pointerEvents: 'none' }}>
      {images.map((img) => {
        const selected = interactive && img.id === selectedId;
        return (
          <div
            key={img.id}
            style={{
              position: 'absolute', left: img.x, top: img.y, width: img.w, height: img.h,
              pointerEvents: interactive ? 'auto' : 'none',
              cursor: interactive ? 'move' : 'default',
            }}
            className={`rounded-lg ${selected ? 'border-2 border-[var(--brand-500)]' : 'border border-[var(--bg-subtle)]'}`}
            onPointerDown={(e) => { if (interactive) startDrag(e, img); }}
            onPointerMove={(e) => { if (interactive) { onDragMove(e); } }}
            onPointerUp={endDrag}
            onPointerCancel={endDrag}
          >
            <img
              src={img.dataUrl}
              alt="草稿贴图"
              draggable={false}
              className="w-full h-full object-fill rounded-[inherit] pointer-events-none select-none"
            />
            {selected && (
              <>
                {/* 四角等比缩放控制点 */}
                {(['nw', 'ne', 'sw', 'se'] as Corner[]).map((c) => (
                  <div
                    key={c}
                    style={{ ...handleStyle(c), touchAction: 'none' }}
                    onPointerDown={(e) => startResize(e, img, c)}
                    onPointerMove={onResizeMove}
                    onPointerUp={endResize}
                    onPointerCancel={endResize}
                  />
                ))}
                {/* 删除钮（右上角；阻止冒泡避免触发拖动） */}
                <button
                  type="button"
                  title="删除图片"
                  aria-label="删除图片"
                  onPointerDown={(e) => e.stopPropagation()}
                  onClick={() => removeImage(img.id)}
                  className="absolute -top-3 -right-3 w-6 h-6 rounded-full bg-[var(--learn-card-bg)] border border-[var(--bg-subtle)] flex items-center justify-center text-[var(--text-tertiary)] hover:text-[var(--brand-500)] transition-colors"
                  style={{ touchAction: 'none' }}
                >
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
                    <line x1="18" y1="6" x2="6" y2="18" />
                    <line x1="6" y1="6" x2="18" y2="18" />
                  </svg>
                </button>
              </>
            )}
          </div>
        );
      })}
    </div>
  );
}
```

注意：`onDragMove` 里的 `boardW/boardH/img` 暂未用于夹取（void 掉防 lint 未用告警），夹取只做了负方向——图片右侧/下侧允许超界由 board 裁切，这是有意的（spec 未约束，YAGNI）。

- [ ] **Step 2: 类型检查**

Run: `cd apps/web && npx tsc -b`
Expected: 无输出（通过）

- [ ] **Step 3: Commit**

```bash
git add apps/web/src/components/business/DraftImageLayer.tsx
git commit -m "feat(web): DraftImageLayer 贴图层——拖动/四角等比缩放(≥40px)/删除钮+Delete键"
```

---

### Task 4: DraftWhiteboard 集成（移动工具/粘贴/拖入/清空）

**Files:**
- Modify: `apps/web/src/components/business/DraftWhiteboard.tsx`

- [ ] **Step 1: 导入与类型**

文件顶部 import 区追加：

```ts
import { getDraftImages, setDraftImages, type DraftImage } from './draft-store';
import { DraftImageLayer } from './DraftImageLayer';
import { fileToDraftImage, isEditableTarget } from './draft-image-utils';
```

`type Tool = 'pen' | 'eraser';` 改为：

```ts
type Tool = 'pen' | 'eraser' | 'move';
```

- [ ] **Step 2: MoveIcon（四向箭头线性 SVG）**

在 `TrashIcon` 定义之后追加：

```tsx
const MoveIcon = () => (
  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <polyline points="5 9 2 12 5 15" />
    <polyline points="9 5 12 2 15 5" />
    <polyline points="15 19 12 22 9 19" />
    <polyline points="19 9 22 12 19 15" />
    <line x1="2" y1="12" x2="22" y2="12" />
    <line x1="12" y1="2" x2="12" y2="22" />
  </svg>
);
```

- [ ] **Step 3: 图片状态 + ref 镜像 + updateImages/insertImages**

组件内（`themeMode` 声明之后）追加：

```ts
  // 贴图：React state 渲染 + ref 镜像（异步插入/连续更新不拿旧闭包）；persist 时同步落 draft-store
  const [images, setImages] = useState<DraftImage[]>([]);
  const imagesRef = useRef<DraftImage[]>([]);
  const updateImages = useCallback((updater: (prev: DraftImage[]) => DraftImage[]) => {
    const next = updater(imagesRef.current);
    imagesRef.current = next;
    setImages(next);
    if (persist) setDraftImages(questionId, next);
  }, [persist, questionId]);

  // 粘贴/拖入入口：可视区中央落点，多张级联偏移 16px 防完全重叠
  const insertImages = useCallback(async (files: File[]) => {
    const wrap = wrapRef.current;
    if (!wrap || files.length === 0) return;
    const viewport = {
      left: 0,
      top: scrollMode === 'scroll-y' ? wrap.scrollTop : 0,
      width: wrap.clientWidth,
      height: wrap.clientHeight,
    };
    for (let i = 0; i < files.length; i++) {
      const img = await fileToDraftImage(files[i], wrap.clientWidth, viewport);
      if (i > 0) { img.x += i * 16; img.y += i * 16; }
      updateImages((prev) => [...prev, img]);
    }
  }, [scrollMode, updateImages]);
```

- [ ] **Step 4: 粘贴监听（document 级，挂载期生效）**

在 `insertImages` 定义之后追加：

```ts
  // 剪贴板粘贴：组件随抽屉/面板条件挂载，监听生命周期 = 草稿可见期；
  // 焦点在输入框时放行（正常粘贴文本），只拦图片文件
  useEffect(() => {
    const onPaste = (e: ClipboardEvent) => {
      if (isEditableTarget(e.target)) return;
      const file = Array.from(e.clipboardData?.items ?? [])
        .find((it) => it.kind === 'file' && it.type.startsWith('image/'))
        ?.getAsFile();
      if (!file) return;
      e.preventDefault();
      void insertImages([file]);
    };
    document.addEventListener('paste', onPaste);
    return () => document.removeEventListener('paste', onPaste);
  }, [insertImages]);
```

- [ ] **Step 5: 切题加载贴图**

既有加载 effect：

```ts
  useEffect(() => {
    strokesRef.current = persist ? getDraft(questionId) : [];
    redraw();
  }, [questionId, persist, redraw]);
```

改为：

```ts
  useEffect(() => {
    strokesRef.current = persist ? getDraft(questionId) : [];
    imagesRef.current = persist ? getDraftImages(questionId) : [];
    setImages(imagesRef.current);
    redraw();
  }, [questionId, persist, redraw]);
```

- [ ] **Step 6: 清空含贴图**

`handleClear` 改为：

```ts
  const handleClear = () => {
    strokesRef.current = [];
    imagesRef.current = [];
    setImages([]);
    if (persist) clearDraft(questionId); // store 层双清笔迹 + 贴图
    redraw();
  };
```

- [ ] **Step 7: canvas 移动档穿透**

`canvasEl` 的 style 改为（追加 pointerEvents；cursor 移动档为 default）：

```ts
      style={{ touchAction: 'none', pointerEvents: tool === 'move' ? 'none' : 'auto', cursor: tool === 'move' ? 'default' : tool === 'eraser' ? 'cell' : 'crosshair' }}
```

- [ ] **Step 8: 渲染层挂载（两种模式都在 canvas 之前）+ 工具条 + 拖放**

(a) 工具条橡皮按钮之后追加：

```tsx
        {toolBtn('move', '移动', <MoveIcon />)}
```

(b) 根 div 追加拖放（替换现有 `<div className="h-full flex flex-col">`）：

```tsx
  return (
    <div
      className="h-full flex flex-col"
      onDragOver={(e) => { e.preventDefault(); }}
      onDrop={(e) => {
        e.preventDefault();
        const files = Array.from(e.dataTransfer.files).filter((f) => f.type.startsWith('image/'));
        void insertImages(files);
      }}
    >
```

(c) scroll-y 模式渲染块改为（层在 canvas 前，DOM 序即 z 序）：

```tsx
        <div ref={wrapRef} className="flex-1 min-h-0 overflow-y-auto overflow-x-hidden">
          <div ref={boardRef} className="relative" style={{ width: '100%' }}>
            <DraftImageLayer images={images} onImagesChange={updateImages} interactive={tool === 'move'} />
            {canvasEl}
          </div>
        </div>
```

(d) fit 模式渲染块改为：

```tsx
        <div ref={wrapRef} className="flex-1 min-h-0 relative">
          <DraftImageLayer images={images} onImagesChange={updateImages} interactive={tool === 'move'} />
          {canvasEl}
        </div>
```

- [ ] **Step 9: 类型检查 + lint**

Run: `cd apps/web && npx tsc -b && npm run lint 2>&1 | tail -3`
Expected: tsc 无输出；lint 0 error（既有 warning 不变）

- [ ] **Step 10: Commit**

```bash
git add apps/web/src/components/business/DraftWhiteboard.tsx
git commit -m "feat(web): 草稿白板贴图集成——移动工具/粘贴/拖入/清空双清/笔迹恒在图上"
```

---

### Task 5: 构建 + 人工验证

**Files:** 无新改动

- [ ] **Step 1: 生产构建**

Run: `cd apps/web && npm run build`
Expected: `✓ built in ...`（服务跑的是 vite preview，必须重建才可见——见 CLAUDE.md/记忆）

- [ ] **Step 2: 人工走查（用户在浏览器执行，spec §测试 7 条）**

1. 答题页开草稿抽屉 → 截图 Cmd+V → 图片落在可视区中央、宽约 60%，多贴几张级联偏移
2. 移动工具：拖动图片；四角缩放（等比、≥40px、北/西角锚定对角）；× 删除；Delete 键删除
3. 切回笔工具在图片上写字 → 笔迹覆盖图片
4. 橡皮只擦笔迹；清空按钮笔迹图片一起清
5. 拖图片文件进草稿区域
6. PreviewDraftPanel 场景：切 tab 回来图片还在；提交后清空
7. 暗色主题下边框/控制点配色正常

- [ ] **Step 3: 全量回归**

Run: `cd apps/web && npx tsc -b && npm run lint 2>&1 | tail -2`
Expected: 通过、0 error

---

## Self-Review 结论

- **Spec 覆盖**：粘贴✓ 拖入✓ 初始 60% 限宽✓ 压缩≤1600✓ 可视区中央落点✓ 移动✓ 四角等比缩放✓ ×/Delete 删除✓ 橡皮不删图✓ 清空双清✓ persist 双约定✓ 笔迹恒在上✓ CSS 变量配色/线性 SVG✓
- **占位符**：无
- **类型一致性**：`onImagesChange(updater)`（Task 3 定义 = Task 4 传入 `updateImages`）；`fileToDraftImage(file, boardW, viewport)`（Task 2 定义 = Task 4 调用）；`DraftImage` 字段 id/dataUrl/x/y/w/h 全程一致
