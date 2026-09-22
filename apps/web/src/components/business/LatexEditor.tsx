import { useRef } from 'react';
import { SymbolPalette } from './SymbolPalette';
import type { PreviewScrollSync } from './preview-scroll-sync';

interface Props {
  value: string;
  onChange: (v: string) => void;
  /** 左输入区 → 右预览区的滚动跟随通道（QuestionRunner 传入同一实例，见 PreviewScrollSync 注释） */
  scrollSync?: { current: PreviewScrollSync };
}

/** 模板光标标记：插入后光标落在此处，标记本身不写入文本框。
 *  用于「插入位置不在末尾」的多行模板（如 SymbolPalette 的分类讨论模板）。 */
const CARET_MARKER = '$0';

export function LatexEditor({ value, onChange, scrollSync }: Props) {
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
      // 光标落在末尾、或模板整体插在内容末尾（光标在模板内占位符上）：钉到底部让插入点可见
      if (ta.scrollHeight > ta.clientHeight && (pos === ta.value.length || start + latex.length === ta.value.length)) {
        ta.scrollTop = ta.scrollHeight;
      }
    });
  };

  /** 光标在末尾且内容溢出时把视口钉到底部。
   *  Chrome 只对「逐键打字」做光标跟随；粘贴 / IME 一次性提交长文本（insertText 路径）
   *  与程序化 setSelectionRange 都不滚动（2026-09-22 实测：底部粘贴 16 行后 scrollTop
   *  停在旧值，插入点在可视区外 300+px）。光标不在末尾的编辑不干预——浏览器原生跟随。 */
  const pinToBottomIfCaretAtEnd = (ta: HTMLTextAreaElement, caret: number) => {
    if (caret === ta.value.length && ta.scrollHeight > ta.clientHeight) {
      ta.scrollTop = ta.scrollHeight;
    }
  };

  return (
    <div className="flex flex-col h-full">
      <SymbolPalette onInsert={insertAtCursor} />
      <textarea
        ref={ref}
        value={value}
        onChange={e => {
          onChange(e.target.value);
          // 粘贴 / IME 提交走 onChange（input 事件），打完钉底（见 pinToBottomIfCaretAtEnd 注释）
          pinToBottomIfCaretAtEnd(e.currentTarget, e.currentTarget.selectionStart ?? 0);
        }}
        onScroll={e => {
          if (!scrollSync) return;
          const el = e.currentTarget;
          const max = el.scrollHeight - el.clientHeight;
          if (max <= 0) return; // 输入区无滚动条：没有「跟随」语义，不动预览
          scrollSync.current.ratio = el.scrollTop / max;
          scrollSync.current.apply?.();
        }}
        placeholder="在此用 LaTeX 作答，数学公式无需输入 $，直接写 LaTeX 即可"
        className="flex-1 w-full p-3 resize-none outline-none bg-transparent text-[var(--text-primary)] font-mono text-sm leading-relaxed"
      />
    </div>
  );
}
