import { useState, useRef } from 'react';

interface Props {
  onSend: (text: string) => void;
  onUpload?: (file: File) => void;
  isStreaming?: boolean;
}

export default function AuxInputBar({ onSend, onUpload, isStreaming = false }: Props) {
  const [text, setText] = useState('');
  const fileRef = useRef<HTMLInputElement>(null);
  const canSend = !!text.trim() && !isStreaming;

  return (
    <div className="p-4 border-t border-[var(--bg-subtle)] bg-[var(--bg-card)]">
      <div className="flex items-center gap-3">
        <input
          type="text"
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && canSend) {
              onSend(text.trim());
              setText('');
            }
          }}
          placeholder="输入问题..."
          aria-label="输入问题"
          className="flex-1 px-4 py-3 rounded-xl bg-[var(--bg-form)] text-[var(--text-primary)] outline-none focus:ring-2 focus:ring-[var(--aux)]/30"
        />
        <button
          onClick={() => fileRef.current?.click()}
          aria-label="拍照上传"
          className="px-3 py-3 rounded-xl border border-[var(--bg-subtle)] text-[var(--text-secondary)]"
        >
          拍照
        </button>
        <button
          disabled={!canSend}
          onClick={() => {
            onSend(text.trim());
            setText('');
          }}
          aria-label="发送"
          className="px-5 py-3 rounded-xl bg-[var(--aux)] text-white font-bold disabled:opacity-50"
        >
          发送
        </button>
      </div>
      <input
        ref={fileRef}
        type="file"
        accept="image/*"
        aria-label="上传照片"
        className="hidden"
        onChange={(e) => {
          const file = e.target.files?.[0];
          if (file && onUpload) onUpload(file);
        }}
      />
    </div>
  );
}
