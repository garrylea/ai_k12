import { useState, useRef } from 'react';

interface Props {
  onSend: (text: string) => void;
  onUpload?: (file: File) => void;
}

export default function AuxInputBar({ onSend, onUpload }: Props) {
  const [text, setText] = useState('');
  const fileRef = useRef<HTMLInputElement>(null);

  return (
    <div className="p-4 border-t border-[var(--bg-subtle)] bg-[var(--bg-card)]">
      <div className="flex items-center gap-3">
        <input
          type="text"
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && text.trim()) {
              onSend(text.trim());
              setText('');
            }
          }}
          placeholder="输入问题..."
          className="flex-1 px-4 py-3 rounded-xl bg-[var(--bg-form)] text-[var(--text-primary)] outline-none focus:ring-2 focus:ring-[var(--aux)]/30"
        />
        <button
          onClick={() => fileRef.current?.click()}
          className="px-3 py-3 rounded-xl border border-[var(--bg-subtle)] text-[var(--text-secondary)]"
        >
          拍照
        </button>
        <button
          disabled={!text.trim()}
          onClick={() => {
            onSend(text.trim());
            setText('');
          }}
          className="px-5 py-3 rounded-xl bg-[var(--aux)] text-white font-bold disabled:opacity-50"
        >
          发送
        </button>
      </div>
      <input
        ref={fileRef}
        type="file"
        accept="image/*"
        className="hidden"
        onChange={(e) => {
          const file = e.target.files?.[0];
          if (file && onUpload) onUpload(file);
        }}
      />
    </div>
  );
}
