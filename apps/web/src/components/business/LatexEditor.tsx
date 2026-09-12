import { useRef } from 'react';
import { SymbolPalette } from './SymbolPalette';

interface Props {
  value: string;
  onChange: (v: string) => void;
}

/** 模板光标标记：插入后光标落在此处，标记本身不写入文本框。
 *  用于「插入位置不在末尾」的多行模板（如 SymbolPalette 的分类讨论模板）。 */
const CARET_MARKER = '$0';

export function LatexEditor({ value, onChange }: Props) {
  const ref = useRef<HTMLTextAreaElement>(null);

  const insertAtCursor = (template: string) => {
    // 先摘掉光标标记，再算落点——标记位置即模板内偏移，与插入位置相加得绝对光标位。
    const markerAt = template.indexOf(CARET_MARKER);
    const latex = markerAt >= 0 ? template.replace(CARET_MARKER, '') : template;
    const ta = ref.current;
    if (!ta) {
      onChange(value + latex);
      return;
    }
    const start = ta.selectionStart ?? value.length;
    const end = ta.selectionEnd ?? value.length;
    // 左侧始终存放裸 LaTeX（不含 $）；预览侧按需自动补 $...$
    const next = value.slice(0, start) + latex + value.slice(end);
    onChange(next);
    requestAnimationFrame(() => {
      // 光标落点优先级：$0 标记 > 首个 {} 占位内（如 \frac{}{}）> 插入末尾
      const ph = latex.indexOf('{}');
      const pos = markerAt >= 0 ? start + markerAt : ph >= 0 ? start + ph + 1 : start + latex.length;
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
        placeholder="在此用 LaTeX 作答，数学公式无需输入 $，直接写 LaTeX 即可"
        className="flex-1 w-full p-3 resize-none outline-none bg-transparent text-[var(--text-primary)] font-mono text-sm leading-relaxed"
      />
    </div>
  );
}
