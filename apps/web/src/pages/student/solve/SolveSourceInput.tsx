import { useCallback, useEffect, useRef, useState, type ClipboardEvent } from 'react';
import { uploadFile, type AttachmentRequest } from '@/services/api';
import { ensureJpeg } from '@/utils/image-convert';
import { toast } from '@/components/base/Toast';
import type { SourceImage } from './types';

/**
 * 状态 A · 录入：文字 + 多图（spec §3.2 / §8.3）。
 *
 * - 多图入口三选一：选图 / 拖拽 / 粘贴；顺序 = 选择顺序，删中间一张后续序号前移；
 * - HEIC 在客户端先转 JPEG 再上传，`source=freeform` 供后端登记题图来源；
 * - 提交条件：所有图片 ready，且「文字非空 或 ≥1 张图」。
 */

const MAX_IMAGES = 6;
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
/** 与后端识别/判题链路支持的格式一致：GIF 等动图不收（识题无收益且体积大）。 */
const ALLOWED_IMAGE_TYPES = new Set([
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/heic',
  'image/heif',
]);

interface Props {
  busy: boolean;
  error?: string | null;
  onRetry?: () => void;
  onManual?: () => void;
  onRecognize: (input: {
    text: string;
    attachments: AttachmentRequest[];
    imageUrls: string[];
  }) => void;
}

function makeLocalId() {
  return crypto.randomUUID?.() ?? `img-${Date.now()}-${Math.random()}`;
}

/** 只回收本组件自己造的 blob URL，外部传入的 data:/http: 不动。 */
function revokePreview(url: string) {
  if (url.startsWith('blob:') && typeof URL.revokeObjectURL === 'function') {
    URL.revokeObjectURL(url);
  }
}

export function SolveSourceInput({ busy, error, onRetry, onManual, onRecognize }: Props) {
  const [text, setText] = useState('');
  const [images, setImages] = useState<SourceImage[]>([]);
  const [dragging, setDragging] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  // 权威副本：选图 / 拖拽 / 粘贴三个入口可能在上一次 HEIC 转换还没结束时并发进入，
  // 若按 render 闭包里的 images.length 算余量，第二批会按旧长度再次占位而突破 6 张。
  // 所有写入都先改 ref 再 setState，读取余量一律取 ref。
  const imagesRef = useRef<SourceImage[]>([]);

  const commitImages = useCallback((next: SourceImage[]) => {
    imagesRef.current = next;
    setImages(next);
  }, []);

  const updateImages = useCallback(
    (updater: (prev: SourceImage[]) => SourceImage[]) => {
      commitImages(updater(imagesRef.current));
    },
    [commitImages],
  );

  // 卸载时回收全部预览 URL（含已被转换结果替换下来的 HEIC URL）。
  useEffect(
    () => () => {
      imagesRef.current.forEach((img) => revokePreview(img.previewUrl));
    },
    [],
  );

  const uploadOne = async (file: File, localId: string) => {
    try {
      const jpeg = await ensureJpeg(file);
      const current = imagesRef.current.find((x) => x.localId === localId);
      // 转换期间被用户移除：不再上传，也不复活占位。
      if (!current) return;
      const previewUrl = jpeg === file ? current.previewUrl : URL.createObjectURL(jpeg);
      if (previewUrl !== current.previewUrl) revokePreview(current.previewUrl);

      updateImages((prev) =>
        prev.map((x) =>
          x.localId === localId
            ? {
                ...x,
                status: 'uploading',
                fileName: jpeg.name,
                // 浏览器（Safari 除外）不能直接渲染 HEIC，转换完成后换用 JPEG 预览。
                previewUrl,
              }
            : x,
        ),
      );

      const { fileId, url } = await uploadFile(jpeg, undefined, 'freeform');
      updateImages((prev) =>
        prev.map((x) =>
          x.localId === localId ? { ...x, status: 'ready', fileId: String(fileId), url } : x,
        ),
      );
    } catch {
      updateImages((prev) =>
        prev.map((x) =>
          x.localId === localId ? { ...x, status: 'error', error: '上传失败' } : x,
        ),
      );
    }
  };

  const addFiles = (files: File[]) => {
    // 先按类型与大小剔除，再抢名额：否则被拒的文件会白占一格，合法文件反而进不来。
    const imageFiles = files.filter((f) => ALLOWED_IMAGE_TYPES.has(f.type));
    if (imageFiles.length === 0) return;
    if (imageFiles.length < files.length) toast('error', '仅支持图片文件');

    const withinSize = imageFiles.filter((f) => f.size <= MAX_IMAGE_BYTES);
    if (withinSize.length < imageFiles.length) toast('error', '图片过大（最大 5MB）');

    const room = MAX_IMAGES - imagesRef.current.length;
    if (room <= 0) {
      toast('error', '最多 6 张题图');
      return;
    }
    const accepted = withinSize.slice(0, room);
    if (accepted.length < withinSize.length) toast('error', '最多 6 张题图');
    if (accepted.length === 0) return;

    // 同步一次性占满本批名额（在任何 await 之前），并发批次的余量读数因此总是最新。
    const placeholders: SourceImage[] = accepted.map((file) => ({
      localId: makeLocalId(),
      fileName: file.name,
      previewUrl: URL.createObjectURL(file),
      status: 'converting',
    }));
    updateImages((prev) => [...prev, ...placeholders]);

    placeholders.forEach((placeholder, index) => {
      void uploadOne(accepted[index], placeholder.localId);
    });
  };

  const remove = (localId: string) => {
    const target = imagesRef.current.find((x) => x.localId === localId);
    if (target) revokePreview(target.previewUrl);
    updateImages((prev) => prev.filter((x) => x.localId !== localId));
  };

  const allReady = images.every((x) => x.status === 'ready');
  const canSend = !busy && allReady && (text.trim().length > 0 || images.length > 0);

  const submit = () => {
    if (!canSend) return;
    onRecognize({
      text: text.trim(),
      attachments: images.map((x) => ({ type: 'image' as const, fileId: x.fileId! })),
      imageUrls: images.map((x) => x.url!).filter(Boolean),
    });
  };

  const handlePaste = (e: ClipboardEvent<HTMLTextAreaElement>) => {
    const files = Array.from(e.clipboardData.items)
      .filter((item) => item.kind === 'file')
      .map((item) => item.getAsFile())
      .filter((file): file is File => file !== null);
    if (files.length > 0) {
      e.preventDefault();
      addFiles(files);
    }
  };

  return (
    <div className="w-full max-w-2xl">
      <div
        className={`rounded-xl bg-[#F9F9FB] border p-3 transition ${
          dragging ? 'ring-2 ring-[#FF6B00] border-[#FF6B00]' : 'border-[#E5E5E5]'
        }`}
        onDragEnter={(e) => {
          e.preventDefault();
          setDragging(true);
        }}
        onDragOver={(e) => e.preventDefault()}
        onDragLeave={() => setDragging(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDragging(false);
          addFiles(Array.from(e.dataTransfer.files));
        }}
      >
        {images.length > 0 && (
          <div className="flex flex-wrap gap-2 mb-2">
            {images.map((img, index) => (
              <div
                key={img.localId}
                data-testid="source-thumb"
                className="relative w-16 h-16 rounded-lg overflow-hidden border border-[#E5E5E5]"
              >
                <img src={img.previewUrl} alt={img.fileName} className="w-full h-full object-cover" />
                <span className="absolute left-0.5 top-0.5 px-1 rounded bg-black/60 text-white text-[10px] whitespace-nowrap">
                  第 {index + 1} 页
                </span>
                <button
                  type="button"
                  onClick={() => remove(img.localId)}
                  aria-label="移除图片"
                  className="absolute right-0.5 top-0.5 w-4 h-4 flex items-center justify-center rounded-full bg-black/60 text-white hover:bg-black/80 transition"
                >
                  <svg
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2.5"
                    strokeLinecap="round"
                    className="w-2.5 h-2.5"
                  >
                    <path d="M18 6L6 18M6 6l12 12" />
                  </svg>
                </button>
                {img.status !== 'ready' && (
                  <span className="absolute inset-x-0 bottom-0 bg-black/60 text-white text-[10px] text-center">
                    {img.status === 'error' ? '失败' : '处理中'}
                  </span>
                )}
              </div>
            ))}
          </div>
        )}

        <textarea
          rows={3}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onPaste={handlePaste}
          placeholder="输入题目，或拖入图片"
          className="w-full bg-transparent outline-none resize-none text-[#1D1D1F] placeholder:text-[var(--text-placeholder)]"
        />

        <p className="text-xs text-[var(--text-tertiary)]">请勿上传个人信息</p>

        <div className="flex items-center justify-between">
          <button
            type="button"
            onClick={() => inputRef.current?.click()}
            aria-label="添加图片"
            className="w-7 h-7 flex items-center justify-center rounded-full border border-[#E5E5E5] text-[#86868B] hover:border-[#FF6B00] hover:text-[#FF6B00] transition"
          >
            <svg
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              className="w-4 h-4"
            >
              <path d="M12 5v14M5 12h14" />
            </svg>
          </button>
          <input
            ref={inputRef}
            data-testid="source-file-input"
            type="file"
            multiple
            accept="image/png,image/jpeg,image/webp,image/heic,image/heif,.heic,.heif"
            className="hidden"
            onChange={(e) => {
              addFiles(Array.from(e.target.files ?? []));
              e.target.value = '';
            }}
          />
          <button
            type="button"
            onClick={submit}
            disabled={!canSend}
            className="px-4 h-9 rounded-lg bg-[#FF6B00] text-white text-sm disabled:opacity-50 hover:opacity-90 transition"
          >
            {busy ? '识别中…' : '开始识题'}
          </button>
        </div>
      </div>

      {busy && images.length > 0 && (
        <div
          role="dialog"
          aria-modal="true"
          aria-label="正在识别题目"
          data-testid="recognize-overlay"
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/40"
        >
          <div className="w-[280px] rounded-2xl bg-white p-6 flex flex-col items-center gap-3 shadow-xl">
            <svg
              className="animate-spin text-[var(--brand-500)]"
              width="36"
              height="36"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              aria-hidden="true"
            >
              <path d="M21 12a9 9 0 1 1-6.219-8.56" />
            </svg>
            <div className="text-sm font-medium text-[var(--text-primary)]">正在识别题目…</div>
            <div className="text-xs text-[var(--text-tertiary)]">图片较多时会稍慢</div>
          </div>
        </div>
      )}

      {error && (
        <div className="mt-3 text-sm text-[#C44A3F]">
          {error}
          {onRetry && (
            <button onClick={onRetry} disabled={busy} className="ml-2 underline disabled:opacity-50">
              重试
            </button>
          )}
          {onManual && (
            <button onClick={onManual} disabled={busy} className="ml-2 underline disabled:opacity-50">
              手动输入题目
            </button>
          )}
        </div>
      )}
    </div>
  );
}
