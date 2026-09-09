// apps/web/src/components/business/DraftImageLayer.tsx
// 草稿贴图层：渲染在 canvas 之下（DOM 序在前，笔迹恒覆盖图片可标注）。
// 图片本体 pointer-events:none —— 命中/选中/拖动由父级选中工具在 canvas 层统一处理；
// 选中图的四角等比缩放控制点与删除钮装在 z-10 覆盖层里压过 canvas（可点击），
// 选中态由父级 selectedIds 驱动（与笔画选区同一套）。
import { useRef } from 'react';
import type { DraftImage } from './draft-store';

/** 四角拖拽宽度下限（px） */
const MIN_SIZE = 40;

type Corner = 'nw' | 'ne' | 'sw' | 'se';

interface Props {
  images: DraftImage[];
  /** 全量更新（updater 形式，父级持 ref 镜像避免异步闭包拿到旧数组）；父级负责 persist 落库 */
  onImagesChange: (updater: (prev: DraftImage[]) => DraftImage[]) => void;
  /** 父级选中工具驱动的选中图 id 集（空 = 无选中） */
  selectedIds: ReadonlySet<string>;
  /** true = 选中工具激活：渲染控制点/删除钮（其余情况整层穿透） */
  handlesEnabled: boolean;
}

export function DraftImageLayer({ images, onImagesChange, selectedIds, handlesEnabled }: Props) {
  const layerRef = useRef<HTMLDivElement>(null);
  // 缩放：corner 决定锚定对角（nw 锚 se、ne 锚 sw、sw 锚 ne、se 锚 nw）
  const resizeRef = useRef<{
    id: string; corner: Corner; startX: number;
    origX: number; origY: number; origW: number; origH: number;
  } | null>(null);

  const patchImage = (id: string, patch: Partial<DraftImage>) =>
    onImagesChange((prev) => prev.map((im) => (im.id === id ? { ...im, ...patch } : im)));

  const startResize = (e: React.PointerEvent<HTMLDivElement>, img: DraftImage, corner: Corner) => {
    if (e.pointerType === 'mouse' && e.button !== 0) return;
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
    // 西/北角缩放会把 x/y 推向负值，夹到 0（只在右/下溢出由 board 裁切）
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
        const selected = handlesEnabled && selectedIds.has(img.id);
        return (
          <div
            key={img.id}
            style={{
              position: 'absolute', left: img.x, top: img.y, width: img.w, height: img.h,
              pointerEvents: 'none',
            }}
            className={`rounded-lg ${selected ? 'border-2 border-[var(--brand-500)]' : 'border border-[var(--bg-subtle)]'}`}
          >
            <img
              src={img.dataUrl}
              alt="草稿贴图"
              draggable={false}
              className="w-full h-full object-fill rounded-[inherit] pointer-events-none select-none"
            />
            {selected && (
              /* 控制点覆盖层：z-10 压过 canvas（本层 DOM 序在 canvas 前，无 z 会被盖住吃掉指针）；
                 覆盖层本体穿透，仅控制点/删除钮接事件 */
              <div className="absolute inset-0 z-10" style={{ pointerEvents: 'none' }}>
                {(['nw', 'ne', 'sw', 'se'] as Corner[]).map((c) => (
                  <div
                    key={c}
                    style={{ ...handleStyle(c), touchAction: 'none', pointerEvents: 'auto' }}
                    onPointerDown={(e) => startResize(e, img, c)}
                    onPointerMove={onResizeMove}
                    onPointerUp={endResize}
                    onPointerCancel={endResize}
                    onLostPointerCapture={endResize}
                  />
                ))}
                {/* 删除钮（右上角） */}
                <button
                  type="button"
                  title="删除图片"
                  aria-label="删除图片"
                  onClick={() => onImagesChange((prev) => prev.filter((im) => im.id !== img.id))}
                  className="absolute -top-3 -right-3 w-6 h-6 rounded-full bg-[var(--learn-card-bg)] border border-[var(--bg-subtle)] flex items-center justify-center text-[var(--text-tertiary)] hover:text-[var(--brand-500)] transition-colors"
                  style={{ touchAction: 'none', pointerEvents: 'auto' }}
                >
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
                    <line x1="18" y1="6" x2="6" y2="18" />
                    <line x1="6" y1="6" x2="18" y2="18" />
                  </svg>
                </button>
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
