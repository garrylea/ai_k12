import { useRef, useState, type ClipboardEvent } from 'react';
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

export function SolveSourceInput({ busy, error, onRetry, onManual, onRecognize }: Props) {
  const [text, setText] = useState('');
  const [images, setImages] = useState<SourceImage[]>([]);
  const [dragging, setDragging] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const addFiles = async (files: File[]) => {
    const imageFiles = files.filter((f) => f.type.startsWith('image/'));
    const room = MAX_IMAGES - images.length;
    if (room <= 0) {
      toast('error', '最多 6 张题图');
      return;
    }
    const picked = imageFiles.slice(0, room);
    if (picked.length < imageFiles.length) toast('error', '最多 6 张题图');

    for (const file of picked) {
      if (file.size > MAX_IMAGE_BYTES) {
        toast('error', '图片过大（最大 5MB）');
        continue;
      }
      const localId = crypto.randomUUID?.() ?? `img-${Date.now()}-${Math.random()}`;
      setImages((prev) => [
        ...prev,
        {
          localId,
          fileName: file.name,
          previewUrl: URL.createObjectURL(file),
          status: 'converting',
        },
      ]);
      try {
        const jpeg = await ensureJpeg(file);
        setImages((prev) =>
          prev.map((x) =>
            x.localId === localId
              ? {
                  ...x,
                  status: 'uploading',
                  fileName: jpeg.name,
                  // 浏览器（Safari 除外）不能直接渲染 HEIC，转换完成后换用 JPEG 预览。
                  previewUrl: jpeg === file ? x.previewUrl : URL.createObjectURL(jpeg),
                }
              : x,
          ),
        );
        const { fileId, url } = await uploadFile(jpeg, undefined, 'freeform');
        setImages((prev) =>
          prev.map((x) =>
            x.localId === localId ? { ...x, status: 'ready', fileId: String(fileId), url } : x,
          ),
        );
      } catch {
        setImages((prev) =>
          prev.map((x) =>
            x.localId === localId ? { ...x, status: 'error', error: '上传失败' } : x,
          ),
        );
      }
    }
  };

  const remove = (localId: string) =>
    setImages((prev) => prev.filter((x) => x.localId !== localId));

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
      void addFiles(files);
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
          void addFiles(Array.from(e.dataTransfer.files));
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
                <span className="absolute left-0.5 top-0.5 px-1 rounded bg-black/60 text-white text-[10px]">
                  {index + 1}
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
          placeholder="输入题目文字，或拖入/粘贴题目图片（HEIC、JPG、PNG）"
          className="w-full bg-transparent outline-none resize-none text-[#1D1D1F] placeholder-[#86868B]"
        />

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
            accept="image/png,image/jpeg,image/heic,.heic"
            className="hidden"
            onChange={(e) => {
              void addFiles(Array.from(e.target.files ?? []));
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

      {error && (
        <div className="mt-3 text-sm text-[#C44A3F]">
          {error}
          <button onClick={onRetry} className="ml-2 underline">
            重试
          </button>
          <button onClick={onManual} className="ml-2 underline">
            手动输入题目
          </button>
        </div>
      )}
    </div>
  );
}
