import type { DragEvent, ReactNode } from 'react';

interface Props {
  /** 输入区上方的附件栏（答疑=单文件条；做题=多图缩略条） */
  preview?: ReactNode;
  /** 文本域（各页自己控制 rows/className/事件） */
  children: ReactNode;
  /** 右下角操作区（+ 号与发送/识别按钮）；位置/间距是外壳的一部分，别在调用方另摆 */
  actions: ReactNode;
  /** 拖入文件时的高亮环 */
  dragging?: boolean;
  onDragEnter?: (e: DragEvent<HTMLDivElement>) => void;
  onDragOver?: (e: DragEvent<HTMLDivElement>) => void;
  onDragLeave?: (e: DragEvent<HTMLDivElement>) => void;
  onDrop?: (e: DragEvent<HTMLDivElement>) => void;
}

/**
 * 学生端「对话式输入框」的共用外观（答疑 / 做题）。
 *
 * 只统一**视觉与几何**：圆角、浅灰底、聚焦品牌环、拖拽高亮、附件栏分隔线，
 * 以及操作按钮固定在右下角。业务状态机（单文件 / 多图、上传来源、PDF 提取）
 * 仍留在各自组件里 —— 答疑的 `AuxInputBar` 是单附件 + PDF/文本提取，
 * 做题是 1–6 张图 + `source=freeform`，两套逻辑不能硬塞进一个 state。
 *
 * 抽出来的原因：这两页并排看必须一模一样；class 抄两份迟早会漂。
 */
export function ComposerSurface({
  preview,
  children,
  actions,
  dragging = false,
  onDragEnter,
  onDragOver,
  onDragLeave,
  onDrop,
}: Props) {
  return (
    <div
      className={`rounded-xl bg-[#F9F9FB] border border-[#E5E5E5] focus-within:ring-2 focus-within:ring-[#FF6B00]/30 focus-within:border-[#FF6B00] transition ${
        dragging ? 'ring-2 ring-[#FF6B00]' : ''
      }`}
      onDragEnter={onDragEnter}
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
    >
      {preview}
      <div className="relative">
        {children}
        <div className="absolute right-2 bottom-2 flex items-center gap-2">{actions}</div>
      </div>
    </div>
  );
}
