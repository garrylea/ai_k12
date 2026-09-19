import { useEffect } from 'react';

/**
 * 图片大图预览：点击图片后在**原比例**下按视口铺满查看，点关闭按钮 / 点背景 / 按 Esc 关闭。
 *
 * 为什么抽成 base 原语：学生端辅线答疑（`AuxChatPanel`）与家长端 AI 对话回放
 * （`ParentChatLogsPage`）都要它。原先它是 `AuxChatPanel` 里的私有函数——家长端再用就
 * 得抄第二份，而这类组件（Esc 监听、`overflow: hidden` 的成对清理）最怕抄漏一处。
 *
 * ⚠️ 关闭按钮是**线性 SVG**、不用 emoji（仓库 UI 硬规则）。
 */
const CloseIcon = () => (
  <svg
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    strokeLinecap="round"
    strokeLinejoin="round"
    className="w-5 h-5"
  >
    <line x1="18" y1="6" x2="6" y2="18" />
    <line x1="6" y1="6" x2="18" y2="18" />
  </svg>
);

export interface ImageLightboxProps {
  src: string;
  onClose: () => void;
  /** 无障碍与破图时的替代文案。 */
  alt?: string;
}

export function ImageLightbox({ src, onClose, alt = '图片预览' }: ImageLightboxProps) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    // 锁定背景滚动，关闭时**必须**复位——漏了它会让整页再也滚不动
    document.body.style.overflow = 'hidden';
    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = '';
    };
  }, [onClose]);

  return (
    <div
      data-testid="image-lightbox"
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 p-4"
      onClick={(e) => {
        // 只在点背景（而非图片本身）时关闭
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <img
        src={src}
        alt={alt}
        className="max-w-[90vw] max-h-[90vh] object-contain rounded-lg shadow-xl"
      />
      <button
        type="button"
        onClick={onClose}
        aria-label="关闭"
        className="absolute top-4 right-4 w-10 h-10 flex items-center justify-center rounded-full bg-white/10 text-white hover:bg-white/20 transition"
      >
        <CloseIcon />
      </button>
    </div>
  );
}
