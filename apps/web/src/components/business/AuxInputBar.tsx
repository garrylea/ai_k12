import { useState, useRef, useCallback } from 'react';
import { uploadFile, type AttachmentRequest } from '@/services/api';
import { ensureJpeg } from '@/utils/image-convert';

interface Props {
  onSend: (text: string, attachments?: AttachmentRequest[]) => void;
  isStreaming?: boolean;
}

type ImageStatus = 'converting' | 'uploading' | 'ready' | 'error';

interface PendingAttachment {
  fileId: string;
  previewUrl: string;
}

export default function AuxInputBar({ onSend, isStreaming = false }: Props) {
  const [text, setText] = useState('');
  const [imageStatus, setImageStatus] = useState<ImageStatus | null>(null);
  const [pendingAttachment, setPendingAttachment] = useState<PendingAttachment | null>(null);
  const [errorMsg, setErrorMsg] = useState('');
  const [isDragging, setIsDragging] = useState(false);
  const dragCounter = useRef(0);

  const hasText = !!text.trim();
  const hasReadyImage = !!pendingAttachment && imageStatus === 'ready';
  const isBusy = isStreaming || imageStatus === 'converting' || imageStatus === 'uploading';
  const canSend = (hasText || hasReadyImage) && !isBusy;

  const handleImageFile = useCallback(async (file: File) => {
    // Reset any previous pending attachment
    if (pendingAttachment?.previewUrl) {
      URL.revokeObjectURL(pendingAttachment.previewUrl);
    }
    setPendingAttachment(null);
    setErrorMsg('');

    try {
      setImageStatus('converting');
      const jpeg = await ensureJpeg(file);
      setImageStatus('uploading');
      const { fileId } = await uploadFile(jpeg);
      const previewUrl = URL.createObjectURL(jpeg);
      setPendingAttachment({ fileId: String(fileId), previewUrl });
      setImageStatus('ready');
    } catch {
      setImageStatus('error');
      setErrorMsg('图片处理失败，请重试');
    }
  }, [pendingAttachment]);

  const clearAttachment = useCallback(() => {
    if (pendingAttachment?.previewUrl) {
      URL.revokeObjectURL(pendingAttachment.previewUrl);
    }
    setPendingAttachment(null);
    setImageStatus(null);
    setErrorMsg('');
  }, [pendingAttachment]);

  const doSend = useCallback(() => {
    const trimmed = text.trim();
    if (!trimmed && !hasReadyImage) return;
    if (isStreaming) return;

    const attachments: AttachmentRequest[] | undefined = hasReadyImage
      ? [{ type: 'image', fileId: pendingAttachment!.fileId }]
      : undefined;

    onSend(trimmed, attachments);

    // Clear after send
    setText('');
    if (pendingAttachment?.previewUrl) {
      URL.revokeObjectURL(pendingAttachment.previewUrl);
    }
    setPendingAttachment(null);
    setImageStatus(null);
    setErrorMsg('');
  }, [text, hasReadyImage, pendingAttachment, isStreaming, onSend]);

  const handlePaste = useCallback((e: React.ClipboardEvent<HTMLInputElement>) => {
    const items = e.clipboardData?.items;
    if (!items) return;
    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      if (item.kind === 'file' && item.type.startsWith('image/')) {
        const file = item.getAsFile();
        if (file) {
          e.preventDefault();
          handleImageFile(file);
          return;
        }
      }
    }
  }, [handleImageFile]);

  const handleDragEnter = useCallback((e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    e.stopPropagation();
    dragCounter.current += 1;
    if (e.dataTransfer?.items) {
      for (let i = 0; i < e.dataTransfer.items.length; i++) {
        if (e.dataTransfer.items[i].kind === 'file' && e.dataTransfer.items[i].type.startsWith('image/')) {
          setIsDragging(true);
          return;
        }
      }
    }
  }, []);

  const handleDragLeave = useCallback((e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    e.stopPropagation();
    dragCounter.current -= 1;
    if (dragCounter.current <= 0) {
      dragCounter.current = 0;
      setIsDragging(false);
    }
  }, []);

  const handleDragOver = useCallback((e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    e.stopPropagation();
  }, []);

  const handleDrop = useCallback((e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    e.stopPropagation();
    dragCounter.current = 0;
    setIsDragging(false);
    const files = e.dataTransfer?.files;
    if (!files) return;
    for (let i = 0; i < files.length; i++) {
      if (files[i].type.startsWith('image/')) {
        handleImageFile(files[i]);
        return;
      }
    }
  }, [handleImageFile]);

  const statusText: Record<ImageStatus, string> = {
    converting: '转换中...',
    uploading: '上传中...',
    ready: '已就绪',
    error: '失败',
  };

  return (
    <div
      className={`p-4 border-t bg-[var(--bg-card)] ${isDragging ? 'border-2 border-[var(--aux)]' : 'border-[var(--bg-subtle)]'}`}
      onDragEnter={handleDragEnter}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
      {pendingAttachment && (
        <div className="mb-3 flex items-center gap-3 p-2 rounded-xl bg-[var(--bg-form)]">
          <img
            src={pendingAttachment.previewUrl}
            alt="待发送图片"
            className="w-12 h-12 object-cover rounded-lg flex-shrink-0"
          />
          <span className="text-sm text-[var(--text-secondary)] flex-1">
            {imageStatus && statusText[imageStatus]}
          </span>
          <button
            onClick={clearAttachment}
            aria-label="移除图片"
            className="px-2 py-1 rounded-lg text-sm text-[var(--text-secondary)] border border-[var(--bg-subtle)]"
          >
            移除
          </button>
        </div>
      )}
      {imageStatus === 'error' && !pendingAttachment && (
        <div className="mb-3 p-2 rounded-xl bg-[var(--bg-form)]">
          <span className="text-sm text-[var(--text-secondary)]">{errorMsg}</span>
        </div>
      )}
      <div className="flex items-center gap-3">
        <input
          type="text"
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && canSend) {
              doSend();
            }
          }}
          onPaste={handlePaste}
          placeholder={isDragging ? '拖放图片到此处...' : '输入问题或粘贴/拖拽图片...'}
          aria-label="输入问题"
          className="flex-1 px-4 py-3 rounded-xl bg-[var(--bg-form)] text-[var(--text-primary)] outline-none focus:ring-2 focus:ring-[var(--aux)]/30"
        />
        <button
          disabled={!canSend}
          onClick={doSend}
          aria-label="发送"
          className="px-5 py-3 rounded-xl bg-[var(--aux)] text-white font-bold disabled:opacity-50"
        >
          发送
        </button>
      </div>
    </div>
  );
}
