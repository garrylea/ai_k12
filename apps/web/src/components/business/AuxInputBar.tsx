import { useState, useRef, useCallback, useEffect } from 'react';
import { uploadFile, type AttachmentRequest } from '@/services/api';
import { ensureJpeg } from '@/utils/image-convert';

interface Props {
  onSend: (text: string, attachments?: AttachmentRequest[], images?: string[]) => void;
  onStop?: () => void;
  isStreaming?: boolean;
}

type ImageStatus = 'converting' | 'uploading' | 'ready' | 'error';

interface PendingAttachment {
  fileId: string;
  url: string;  // server URL (/uploads/xxx.jpg) - durable, also used for history replay
}

// Hoisted out of component to avoid re-creation every render (#8).
const STATUS_TEXT: Record<ImageStatus, string> = {
  converting: '转换中...',
  uploading: '上传中...',
  ready: '已就绪',
  error: '失败',
};

// Match backend ai.service.ts image size limit (#4).
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;

export default function AuxInputBar({ onSend, onStop, isStreaming = false }: Props) {
  const [text, setText] = useState('');
  const [imageStatus, setImageStatus] = useState<ImageStatus | null>(null);
  const [pendingAttachment, setPendingAttachment] = useState<PendingAttachment | null>(null);
  const [errorMsg, setErrorMsg] = useState('');
  const [isDragging, setIsDragging] = useState(false);

  // Refs to avoid stale closures in async callbacks (#1) and cleanup (#2).
  const dragCounter = useRef(0);
  const requestRef = useRef(0);
  const abortRef = useRef<AbortController | null>(null);
  const pendingRef = useRef<PendingAttachment | null>(null);

  // Cleanup on unmount: abort in-flight upload (#2). No object URL to revoke -
  // preview uses the durable server URL returned by uploadFile.
  useEffect(() => {
    return () => {
      abortRef.current?.abort();
    };
  }, []);

  const hasText = !!text.trim();
  const hasReadyImage = !!pendingAttachment && imageStatus === 'ready';
  const isBusy = isStreaming || imageStatus === 'converting' || imageStatus === 'uploading';
  const canSend = (hasText || hasReadyImage) && !isBusy;

  const handleImageFile = useCallback(async (file: File) => {
    // File-size validation (#4) - matches backend /ai/tutor 5MB limit.
    if (file.size > MAX_IMAGE_BYTES) {
      setImageStatus('error');
      setErrorMsg('图片过大（最大 5MB）');
      return;
    }

    // Abort any in-flight upload from a previous image (#2).
    abortRef.current?.abort();

    // Reset previous pending state (#1).
    pendingRef.current = null;
    setPendingAttachment(null);
    setErrorMsg('');

    // Race-condition guard: each invocation gets a unique ID (#1).
    const myId = ++requestRef.current;

    // Conversion step - separate try/catch for distinct error message (#9).
    setImageStatus('converting');
    let jpeg: File;
    try {
      jpeg = await ensureJpeg(file);
    } catch {
      if (requestRef.current !== myId) return; // superseded
      setImageStatus('error');
      setErrorMsg('图片格式不支持，请改用 JPG/PNG');
      return;
    }
    if (requestRef.current !== myId) return; // superseded

    // Upload step - pass AbortSignal so unmount/supersede can cancel (#2).
    setImageStatus('uploading');
    const controller = new AbortController();
    abortRef.current = controller;
    try {
      const { fileId, url } = await uploadFile(jpeg, controller.signal);
      if (requestRef.current !== myId) return; // superseded
      pendingRef.current = { fileId: String(fileId), url };
      setPendingAttachment({ fileId: String(fileId), url });
      setImageStatus('ready');
    } catch {
      if (requestRef.current !== myId) return; // superseded
      setImageStatus('error');
      setErrorMsg('上传失败，请检查网络');
    }
  }, []);

  const clearAttachment = useCallback(() => {
    pendingRef.current = null;
    setPendingAttachment(null);
    setImageStatus(null);
    setErrorMsg('');
  }, []);

  const doSend = useCallback(() => {
    const trimmed = text.trim();
    const ready = !!pendingRef.current && imageStatus === 'ready';
    if (!trimmed && !ready) return;
    if (isStreaming) return;

    const attachments: AttachmentRequest[] | undefined = ready
      ? [{ type: 'image', fileId: pendingRef.current!.fileId }]
      : undefined;
    // Pass the server URL so the chat renders the image the user just sent.
    // The same URL is persisted by the backend, so history replay is consistent.
    const images: string[] | undefined = ready
      ? [pendingRef.current!.url]
      : undefined;

    onSend(trimmed, attachments, images);

    // Clear after send.
    setText('');
    pendingRef.current = null;
    setPendingAttachment(null);
    setImageStatus(null);
    setErrorMsg('');
  }, [text, imageStatus, isStreaming, onSend]);

  const handlePaste = useCallback((e: React.ClipboardEvent<HTMLTextAreaElement>) => {
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

  return (
    <div
      className={`rounded-xl bg-[#F9F9FB] border border-[#E5E5E5] focus-within:ring-2 focus-within:ring-[#FF6B00]/30 focus-within:border-[#FF6B00] transition ${isDragging ? 'ring-2 ring-[#FF6B00]' : ''}`}
      onDragEnter={handleDragEnter}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
      {pendingAttachment && (
        <div className="flex items-center gap-3 p-2 border-b border-[#E5E5E5]">
          <img
            src={pendingAttachment.url}
            alt="待发送图片"
            className="w-12 h-12 object-cover rounded-lg flex-shrink-0"
          />
          <span className="text-sm text-[#86868B] flex-1">
            {imageStatus && STATUS_TEXT[imageStatus]}
          </span>
          <button
            onClick={clearAttachment}
            aria-label="移除图片"
            className="px-2 py-1 rounded-lg text-sm text-[#86868B] hover:text-[#1D1D1F] transition"
          >
            移除
          </button>
        </div>
      )}
      {imageStatus === 'error' && !pendingAttachment && (
        <div className="px-3 pt-2">
          <span className="text-sm text-[#86868B]">{errorMsg}</span>
        </div>
      )}
      <div className="relative">
        <textarea
          rows={3}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey && canSend) {
              e.preventDefault();
              doSend();
            }
          }}
          onPaste={handlePaste}
          placeholder={isDragging ? '拖放图片到此处...' : '输入问题或粘贴/拖拽图片...'}
          aria-label="输入问题"
          className="w-full px-4 py-3 pr-16 bg-transparent text-[#1D1D1F] placeholder-[#86868B] outline-none resize-none"
        />
        {isStreaming ? (
          <button
            type="button"
            onClick={onStop}
            aria-label="停止生成"
            className="absolute right-2 bottom-2 px-4 py-2 rounded-lg bg-[#86868B] text-white font-bold hover:opacity-90 transition flex items-center gap-1.5"
          >
            <svg viewBox="0 0 24 24" fill="none" className="w-4 h-4 animate-spin">
              <circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="3" opacity="0.25" />
              <path d="M12 2a10 10 0 0 1 10 10" stroke="currentColor" strokeWidth="3" strokeLinecap="round" />
            </svg>
            停止
          </button>
        ) : (
          <button
            type="button"
            disabled={!canSend}
            onClick={doSend}
            aria-label="发送"
            className="absolute right-2 bottom-2 px-4 py-2 rounded-lg bg-[#FF6B00] text-white font-bold disabled:opacity-50 hover:opacity-90 transition"
          >
            发送
          </button>
        )}
      </div>
    </div>
  );
}
