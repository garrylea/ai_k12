import ReactMarkdown from 'react-markdown';
import {
  draggableQuestionMarkdownComponents,
  markdownComponents,
  markdownRehypePlugins,
  markdownRemarkPlugins,
  preprocessMaterialMarkdown,
} from '@/components/markdown';
import { useMaterialDoc } from '@/hooks/useMaterialDoc';

interface MaterialBlockProps {
  url?: string | null;
  text?: string | null;
  variant?: 'answer' | 'result' | 'history' | 'print';
  /** 作答页：材料图可拖进草稿（沿用 QuestionRunner 旧行为） */
  draggable?: boolean;
  testId?: string;
  className?: string;
}

const SIZE: Record<NonNullable<MaterialBlockProps['variant']>, string> = {
  answer: 'mb-3 rounded-lg border px-3 py-2.5 text-sm',
  result: 'mb-2 max-h-[32vh] overflow-y-auto rounded-lg border px-3 py-2 text-[13px]',
  history: 'mb-3 max-h-[32vh] overflow-y-auto rounded-lg border px-3 py-2 text-[13px]',
  print: '',
};

/**
 * 材料区：先渲染文章文档（按 url 取文），再渲染题中素材（materialText）。
 * url 是文章的唯一入口；text 为题目自带的补充材料。两者都缺省时不渲染。
 */
export function MaterialBlock({
  url, text, variant = 'answer', draggable = false, testId, className = '',
}: MaterialBlockProps) {
  const { text: doc, status, retry } = useMaterialDoc(url);
  const docFailed = status === 'error' && !doc;
  const body = [doc, text].filter((s): s is string => Boolean(s && s.trim())).join('\n\n');
  const components = draggable ? draggableQuestionMarkdownComponents : markdownComponents;
  if (!body) {
    if (docFailed) return (
      <button type="button" data-testid={testId} onClick={retry} className="text-xs text-[var(--brand-500)] underline">
        材料加载失败，点击重试
      </button>
    );
    if (status === 'loading') return <div data-testid={testId} className="text-xs text-[var(--text-tertiary)]">材料加载中…</div>;
    return null;
  }
  return (
    <div
      data-testid={testId}
      data-material-url={url ?? undefined}
      className={`md-prose border-[var(--learn-card-border)] bg-[var(--bg-base)] text-[var(--text-primary)] leading-[1.7] ${SIZE[variant]} ${className}`}
    >
      <ReactMarkdown
        remarkPlugins={markdownRemarkPlugins}
        rehypePlugins={markdownRehypePlugins}
        components={components}
      >
        {preprocessMaterialMarkdown(body)}
      </ReactMarkdown>
      {docFailed && (
        <button type="button" onClick={retry} className="mt-1 text-xs text-[var(--brand-500)] underline">
          材料加载失败，点击重试
        </button>
      )}
    </div>
  );
}
