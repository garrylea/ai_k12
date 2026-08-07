import { useRef } from 'react';
import { SymbolPalette } from './SymbolPalette';

interface Props {
  value: string;
  onChange: (v: string) => void;
}

export function LatexEditor({ value, onChange }: Props) {
  const ref = useRef<HTMLTextAreaElement>(null);

  const insertAtCursor = (latex: string) => {
    const ta = ref.current;
    if (!ta) {
      onChange(value + latex);
      return;
    }
    const start = ta.selectionStart ?? value.length;
    const end = ta.selectionEnd ?? value.length;
    const next = value.slice(0, start) + latex + value.slice(end);
    onChange(next);
    // 光标移到首个 {} 内
    requestAnimationFrame(() => {
      const ph = latex.indexOf('{}');
      const pos = ph >= 0 ? start + ph + 1 : start + latex.length;
      ta.focus();
      ta.setSelectionRange(pos, pos);
    });
  };

  return (
    <div className="flex flex-col h-full">
      <SymbolPalette onInsert={insertAtCursor} />
      <textarea
        ref={ref}
        value={value}
        onChange={e => onChange(e.target.value)}
        placeholder="在此用 LaTeX 作答，用 $...$ 包裹数学公式"
        className="flex-1 w-full p-3 resize-none outline-none bg-transparent text-[var(--text-primary)] font-mono text-sm leading-relaxed"
      />
    </div>
  );
}
