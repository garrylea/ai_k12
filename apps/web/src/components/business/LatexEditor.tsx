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
    // 光标在 $...$ 数学模式内时光标前 $ 为奇数个；
    // $ 按钮直接插入裸 $；其余符号在数学模式外时自动用 $...$ 包裹，让预览的 KaTeX 能渲染
    const isDollar = latex === '$';
    const inMath = (value.slice(0, start).match(/\$/g) || []).length % 2 === 1;
    const wrapped = !isDollar && !inMath;
    const insertText = wrapped ? `$${latex}$` : latex;
    const next = value.slice(0, start) + insertText + value.slice(end);
    onChange(next);
    requestAnimationFrame(() => {
      const lead = wrapped ? 1 : 0; // 包裹时前面多一个 $
      const ph = latex.indexOf('{}');
      const pos = ph >= 0 ? start + lead + ph + 1 : start + lead + latex.length;
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
