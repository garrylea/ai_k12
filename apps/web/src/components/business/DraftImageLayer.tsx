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
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    setSelectedId(img.id);
    dragRef.current = { id: img.id, dx: e.clientX - img.x, dy: e.clientY - img.y };
  };
  const onDragMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const d = dragRef.current;
    if (!d) return;
    // 负方向不允许拖出板外（右侧/下侧超界由 board overflow 裁切，spec 未约束，YAGNI）
    patchImage(d.id, {
      x: Math.max(0, Math.round(e.clientX - d.dx)),
      y: Math.max(0, Math.round(e.clientY - d.dy)),
    });
  };
  const endDrag = () => { dragRef.current = null; };

  // ---- 缩放 ----
  const startResize = (e: React.PointerEvent<HTMLDivElement>, img: DraftImage, corner: Corner) => {
    if (e.pointerType === 'mouse' && e.button !== 0) return;
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
    // 缩放只响应水平位移 dxTotal，垂直拖拽忽略——等比高度已由宽度决定，垂直位移只会造成抖动
    const dxTotal = e.clientX - r.startX;
    const east = r.corner === 'ne' || r.corner === 'se';
    const boardW = layerRef.current?.clientWidth ?? Infinity;
    const w = Math.min(Math.max(MIN_SIZE, Math.round(east ? r.origW + dxTotal : r.origW - dxTotal)), boardW);
    const h = Math.round((w / r.origW) * r.origH); // 等比
    // 西/北角缩放会把 x/y 推向负值，夹到 0（与拖动侧一致，只在右/下溢出由 board 裁切）
    const x = Math.max(0, east ? r.origX : r.origX + (r.origW - w));
    const y = Math.max(0, r.corner[0] === 'n' ? r.origY + (r.origH - h) : r.origY);
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
              touchAction: 'none',
            }}
            className={`rounded-lg ${selected ? 'border-2 border-[var(--brand-500)]' : 'border border-[var(--bg-subtle)]'}`}
            onPointerDown={(e) => { if (interactive) startDrag(e, img); }}
            onPointerMove={(e) => { if (interactive) { onDragMove(e); } }}
            onPointerUp={endDrag}
            onPointerCancel={endDrag}
            onLostPointerCapture={endDrag}
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
                    onLostPointerCapture={endResize}
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
