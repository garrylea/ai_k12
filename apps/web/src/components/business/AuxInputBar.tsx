import { useState, useRef, useCallback, useEffect } from 'react';
import { uploadFile, streamExtraction, type AttachmentRequest } from '@/services/api';
import { ensureJpeg } from '@/utils/image-convert';
import { toast } from '@/components/base/Toast';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface FileState {
  status: 'converting' | 'uploading' | 'extracting' | 'ready' | 'error';
  fileId: string;
  url: string;
  fileName: string;
  fileType: 'image' | 'text' | 'pdf';
  taskId?: number;
  errorMsg?: string;
}

interface Props {
  onSend: (text: string, attachments?: AttachmentRequest[], images?: string[]) => void;
  onStop?: () => void;
  isStreaming?: boolean;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** 5 MB – match backend ai.service.ts image size limit (#4). */
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;

/** PDF extraction timeout matches MinerU CLI timeout (120 s). */
const PDF_EXTRACTION_TIMEOUT_MS = 120_000;

/** Accepted file types for the hidden <input>. */
const FILE_ACCEPT = 'image/png,image/jpeg,image/heic,.txt,.md,.pdf';

// ---------------------------------------------------------------------------
// Helpers (hoisted out of component)
// ---------------------------------------------------------------------------

function getFileCategory(file: File): 'image' | 'text' | 'pdf' {
  if (file.type.startsWith('image/')) return 'image';
  if (file.type === 'application/pdf') return 'pdf';
  if (file.type === 'text/plain' || file.name.endsWith('.md') || file.name.endsWith('.txt'))
    return 'text';
  throw new Error('不支持的文件格式');
}

/**
 * Lightweight check whether a DataTransferItem *could* be a supported file.
 * Used for drag-enter to show the drop indicator without actually classifying.
 */
function couldBeSupportedFile(item: DataTransferItem): boolean {
  if (item.kind !== 'file') return false;
  const t = item.type.toLowerCase();
  if (t.startsWith('image/')) return true;
  if (t === 'application/pdf') return true;
  if (t === 'text/plain' || t === 'text/markdown') return true;
  // Some platforms report md/txt as empty or octet-stream – let them through
  if (t === '' || t === 'application/octet-stream') return true;
  return false;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export default function AuxInputBar({ onSend, onStop, isStreaming = false }: Props) {
  const [text, setText] = useState('');
  const [fileState, setFileState] = useState<FileState | null>(null);
  const [isDragging, setIsDragging] = useState(false);

  // ---- Refs (avoid stale closures in async callbacks) ----
  const dragCounter = useRef(0);
  const requestRef = useRef(0);
  const uploadAbortRef = useRef<AbortController | null>(null);
  const extractAbortRef = useRef<AbortController | null>(null);
  const extractTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  /** Always-current mirror of `fileState` for doSend / async checks. */
  const fileStateRef = useRef<FileState | null>(null);

  // ---- Cleanup on unmount ----
  useEffect(() => {
    return () => {
      uploadAbortRef.current?.abort();
      extractAbortRef.current?.abort();
      if (extractTimeoutRef.current) clearTimeout(extractTimeoutRef.current);
    };
  }, []);

  // ---- Helpers ----
  const clearExtractTimeout = useCallback(() => {
    if (extractTimeoutRef.current) {
      clearTimeout(extractTimeoutRef.current);
      extractTimeoutRef.current = null;
    }
  }, []);

  /** Update both React state and the always-current ref in one call. */
  const updateFileState = useCallback((fs: FileState | null) => {
    fileStateRef.current = fs;
    setFileState(fs);
  }, []);

  // ---- PDF extraction via SSE ----
  const startExtraction = useCallback(
    async (taskId: number, requestId: number, fileName: string, fileId: string, url: string) => {
      const controller = new AbortController();
      extractAbortRef.current = controller;

      extractTimeoutRef.current = setTimeout(() => {
        controller.abort();
        if (requestRef.current === requestId) {
          updateFileState({
            status: 'error',
            fileId,
            url,
            fileName,
            fileType: 'pdf',
            taskId,
            errorMsg: '提取超时，请重试',
          });
          toast('error', '提取超时，请重试');
        }
      }, PDF_EXTRACTION_TIMEOUT_MS);

      try {
        for await (const event of streamExtraction(taskId, controller.signal)) {
          if (requestRef.current !== requestId) return;
          if (event.type === 'done') {
            clearExtractTimeout();
            updateFileState({ status: 'ready', fileId, url, fileName, fileType: 'pdf', taskId });
            return;
          }
          if (event.type === 'error') {
            clearExtractTimeout();
            const msg = event.message || '文件处理失败，请重试';
            updateFileState({ status: 'error', fileId, url, fileName, fileType: 'pdf', taskId, errorMsg: msg });
            toast('error', msg);
            return;
          }
        }
      } catch {
        if (requestRef.current !== requestId) return;
        clearExtractTimeout();
        updateFileState({
          status: 'error',
          fileId,
          url,
          fileName,
          fileType: 'pdf',
          taskId,
          errorMsg: '文件处理失败，请重试',
        });
        toast('error', '文件处理失败，请重试');
      }
    },
    [clearExtractTimeout, updateFileState],
  );

  // ---- Handle a file (drag / paste / file-input) ----
  const handleFile = useCallback(
    async (file: File) => {
      // 1. Classify file type
      let fileType: 'image' | 'text' | 'pdf';
      try {
        fileType = getFileCategory(file);
      } catch {
        toast('error', '不支持的文件格式，请选择 PNG/JPG/HEIC/TXT/MD/PDF');
        return;
      }

      // 2. Image size validation only – text/PDF use upload endpoint's 20 MB limit
      if (fileType === 'image' && file.size > MAX_IMAGE_BYTES) {
        toast('error', '图片过大（最大 5MB）');
        return;
      }

      // 3. Abort any in-flight upload / extraction from a previous file
      uploadAbortRef.current?.abort();
      extractAbortRef.current?.abort();
      clearExtractTimeout();

      // 4. Reset previous state
      updateFileState(null);

      const myId = ++requestRef.current;

      // 5. Convert HEIC → JPEG for images only
      let uploadTarget = file;
      if (fileType === 'image') {
        updateFileState({ status: 'converting', fileId: '', url: '', fileName: file.name, fileType });
        try {
          uploadTarget = await ensureJpeg(file);
        } catch {
          if (requestRef.current !== myId) return;
          updateFileState({
            status: 'error',
            fileId: '',
            url: '',
            fileName: file.name,
            fileType,
            errorMsg: '图片格式不支持，请改用 JPG/PNG',
          });
          return;
        }
        if (requestRef.current !== myId) return;
      }

      // 6. Upload
      updateFileState({ status: 'uploading', fileId: '', url: '', fileName: uploadTarget.name, fileType });

      const controller = new AbortController();
      uploadAbortRef.current = controller;
      try {
        const { fileId, url, taskId } = await uploadFile(uploadTarget, controller.signal);
        if (requestRef.current !== myId) return;

        if (fileType === 'pdf' && taskId != null) {
          // Kick off PDF extraction SSE (non-blocking)
          updateFileState({
            status: 'extracting',
            fileId: String(fileId),
            url,
            fileName: uploadTarget.name,
            fileType,
            taskId,
          });
          startExtraction(taskId, myId, uploadTarget.name, String(fileId), url);
        } else {
          updateFileState({
            status: 'ready',
            fileId: String(fileId),
            url,
            fileName: uploadTarget.name,
            fileType,
          });
        }
      } catch {
        if (requestRef.current !== myId) return;
        updateFileState({
          status: 'error',
          fileId: '',
          url: '',
          fileName: uploadTarget.name,
          fileType,
          errorMsg: '上传失败，请检查网络',
        });
      }
    },
    [clearExtractTimeout, startExtraction, updateFileState],
  );

  // ---- Remove currently selected file ----
  const clearFile = useCallback(() => {
    uploadAbortRef.current?.abort();
    extractAbortRef.current?.abort();
    clearExtractTimeout();
    updateFileState(null);
  }, [clearExtractTimeout, updateFileState]);

  // ---- Send message ----
  const doSend = useCallback(() => {
    const trimmed = text.trim();
    const fs = fileStateRef.current;
    const ready = fs?.status === 'ready';
    if (!trimmed && !ready) return;
    if (isStreaming) return;

    const attachments: AttachmentRequest[] | undefined =
      ready && fs
        ? [
            {
              type: fs.fileType === 'image' ? 'image' : 'file',
              fileId: fs.fileId,
              ...(fs.taskId != null ? { taskId: fs.taskId } : {}),
            },
          ]
        : undefined;

    const images: string[] | undefined =
      ready && fs?.fileType === 'image' ? [fs.url] : undefined;

    onSend(trimmed, attachments, images);

    // Clear after send
    setText('');
    updateFileState(null);
  }, [text, isStreaming, onSend, updateFileState]);

  // ---- Paste handler ----
  const handlePaste = useCallback(
    (e: React.ClipboardEvent<HTMLTextAreaElement>) => {
      const items = e.clipboardData?.items;
      if (!items) return;
      for (let i = 0; i < items.length; i++) {
        if (items[i].kind === 'file') {
          const file = items[i].getAsFile();
          if (file) {
            try {
              getFileCategory(file); // validate before consuming the paste event
              e.preventDefault();
              handleFile(file);
              return;
            } catch {
              /* unsupported type – keep scanning items */
            }
          }
        }
      }
    },
    [handleFile],
  );

  // ---- Drag handlers ----
  const handleDragEnter = useCallback((e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    e.stopPropagation();
    dragCounter.current += 1;
    if (e.dataTransfer?.items) {
      for (let i = 0; i < e.dataTransfer.items.length; i++) {
        if (couldBeSupportedFile(e.dataTransfer.items[i])) {
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

  const handleDrop = useCallback(
    (e: React.DragEvent<HTMLDivElement>) => {
      e.preventDefault();
      e.stopPropagation();
      dragCounter.current = 0;
      setIsDragging(false);
      const files = e.dataTransfer?.files;
      if (!files) return;
      for (let i = 0; i < files.length; i++) {
        try {
          getFileCategory(files[i]);
          handleFile(files[i]);
          return; // single file – first supported file wins
        } catch {
          /* unsupported – skip */
        }
      }
    },
    [handleFile],
  );

  // ---- File input onChange ----
  const handleInputChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0];
      if (file) handleFile(file);
      // Reset so the same file can be re-selected after removal
      e.target.value = '';
    },
    [handleFile],
  );

  // ---- Computed booleans ----
  const fs = fileState;
  const hasText = !!text.trim();
  const isBusy =
    isStreaming ||
    fs?.status === 'converting' ||
    fs?.status === 'uploading' ||
    fs?.status === 'extracting';
  const canSend = (hasText || fs?.status === 'ready') && !isBusy;

  // ---- Render: file preview bar ----
  const renderFilePreview = () => {
    if (!fs) return null;

    return (
      <div className="flex items-center gap-3 p-2 border-b border-[#E5E5E5]">
        {/* Icon / thumbnail */}
        {fs.fileType === 'image' && fs.url ? (
          <img
            src={fs.url}
            alt={fs.fileName}
            className="w-12 h-12 object-cover rounded-lg flex-shrink-0"
          />
        ) : fs.fileType === 'pdf' ? (
          <svg
            viewBox="0 0 24 24"
            fill="none"
            stroke="#FF6B00"
            strokeWidth="1.5"
            className="w-6 h-6 flex-shrink-0 ml-3"
          >
            <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
            <path d="M14 2v6h6" />
            <path d="M8 13h8M8 17h8" />
          </svg>
        ) : (
          /* text files (TXT/MD) and images without URL (uploading/converting) */
          <svg
            viewBox="0 0 24 24"
            fill="none"
            stroke="#86868B"
            strokeWidth="1.5"
            className="w-6 h-6 flex-shrink-0 ml-3"
          >
            <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
            <path d="M14 2v6h6M16 13H8M16 17H8" />
          </svg>
        )}

        {/* File name + status */}
        <span className="text-sm text-[#86868B] flex-1 min-w-0">
          <span className="font-medium text-[#1D1D1F] truncate inline-block max-w-[180px] align-bottom">
            {fs.fileName}
          </span>{' '}
          {fs.status === 'converting' && '转换中...'}
          {fs.status === 'uploading' && '上传中...'}
          {fs.status === 'extracting' && '提取中...'}
          {fs.status === 'ready' && '已就绪'}
          {fs.status === 'error' && (fs.errorMsg || '失败')}
        </span>

        {/* Remove button – hidden during extraction so the SSE isn't interrupted */}
        {fs.status !== 'extracting' && (
          <button
            onClick={clearFile}
            aria-label="移除文件"
            className="px-2 py-1 rounded-lg text-sm text-[#86868B] hover:text-[#1D1D1F] transition flex-shrink-0"
          >
            移除
          </button>
        )}
      </div>
    );
  };

  // ---- Render: send / stop / spinner button ----
  const renderActionButton = () => {
    // Streaming – show stop button
    if (isStreaming) {
      return (
        <button
          type="button"
          onClick={onStop}
          aria-label="停止生成"
          className="w-9 h-9 flex items-center justify-center rounded-lg bg-[#86868B] text-white hover:opacity-90 transition"
        >
          <svg viewBox="0 0 24 24" fill="currentColor" className="w-4 h-4">
            <rect x="6" y="6" width="12" height="12" rx="1" />
          </svg>
        </button>
      );
    }

    // PDF extraction in progress – show spinner
    if (fs?.status === 'extracting') {
      return (
        <div className="w-9 h-9 flex items-center justify-center rounded-lg bg-[#FF6B00] text-white">
          <svg viewBox="0 0 24 24" fill="none" className="w-5 h-5 animate-spin">
            <circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="3" opacity="0.25" />
            <path d="M12 2a10 10 0 0 1 10 10" stroke="currentColor" strokeWidth="3" strokeLinecap="round" />
          </svg>
        </div>
      );
    }

    // Normal – send button
    return (
      <button
        type="button"
        disabled={!canSend}
        onClick={doSend}
        aria-label="发送"
        className="w-9 h-9 flex items-center justify-center rounded-lg bg-[#FF6B00] text-white disabled:opacity-50 hover:opacity-90 transition"
      >
        <svg
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          className="w-5 h-5"
        >
          <path d="M22 2L11 13" />
          <path d="M22 2L15 22L11 13L2 9L22 2Z" />
        </svg>
      </button>
    );
  };

  // ---- Render ----
  return (
    <div
      className={`rounded-xl bg-[#F9F9FB] border border-[#E5E5E5] focus-within:ring-2 focus-within:ring-[#FF6B00]/30 focus-within:border-[#FF6B00] transition ${isDragging ? 'ring-2 ring-[#FF6B00]' : ''}`}
      onDragEnter={handleDragEnter}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
      {/* File preview bar */}
      {renderFilePreview()}

      {/* Error text when no preview is shown (e.g. conversion failed before upload) */}
      {fs?.status === 'error' && !fs.url && (
        <div className="px-3 pt-2">
          <span className="text-sm text-[#86868B]">{fs.errorMsg}</span>
        </div>
      )}

      {/* Input area */}
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
          placeholder={isDragging ? '拖放文件到此处...' : '输入问题或粘贴/拖拽文件...'}
          aria-label="输入问题"
          className="w-full px-4 py-3 pr-20 bg-transparent text-[#1D1D1F] placeholder-[#86868B] outline-none resize-none"
        />

        {/* Action buttons (right side) */}
        <div className="absolute right-2 bottom-2 flex items-center gap-2">
          {/* + button – triggers hidden file input */}
          <button
            type="button"
            onClick={() => fileInputRef.current?.click()}
            aria-label="添加文件"
            className="w-7 h-7 flex items-center justify-center rounded-full border border-[#E5E5E5] text-[#86868B] hover:border-[#FF6B00] hover:text-[#FF6B00] transition flex-shrink-0"
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="w-4 h-4">
              <path d="M12 5v14M5 12h14" />
            </svg>
          </button>

          <input
            ref={fileInputRef}
            type="file"
            accept={FILE_ACCEPT}
            className="hidden"
            onChange={handleInputChange}
          />

          {/* Send / Stop / Spinner */}
          {renderActionButton()}
        </div>
      </div>
    </div>
  );
}
