import { useEffect, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkMath from 'remark-math';
import remarkGfm from 'remark-gfm';
import remarkBreaks from 'remark-breaks';
import rehypeKatex from 'rehype-katex';
import 'katex/dist/katex.min.css';

export function LatexPreview({ value }: { value: string }) {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setDebounced(value), 150);
    return () => clearTimeout(t);
  }, [value]);

  return (
    <div className="h-full overflow-auto p-4 text-[var(--text-primary)]">
      {debounced.trim() ? (
        <div className="prose prose-sm max-w-none">
          <ReactMarkdown remarkPlugins={[remarkMath, remarkGfm, remarkBreaks]} rehypePlugins={[rehypeKatex]}>
            {debounced}
          </ReactMarkdown>
        </div>
      ) : (
        <p className="text-[var(--text-secondary)] text-sm">预览区（输入后实时渲染）</p>
      )}
    </div>
  );
}
