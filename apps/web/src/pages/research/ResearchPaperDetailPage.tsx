import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useParams } from 'react-router-dom';
import ReactMarkdown from 'react-markdown';
import {
  markdownComponents,
  markdownRehypePlugins,
  markdownRemarkPluginsWithBreaks,
  preprocessMarkdown,
} from '@/components/markdown';
import {
  getResearchPaper,
  type ResearchPaperDetailResult,
  type ResearchQuestionDetail,
} from '@/services/api';
import { Skeleton } from '@/components/base';
import ResearchQuestionEditDrawer from './ResearchQuestionEditDrawer';

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : '操作失败';
}

/** 与题干 / 编辑抽屉 / 学生端同一套富文本管线（Markdown + LaTeX + 原生 HTML + SVG）。 */
function MarkdownBody({ text }: { text: string }) {
  return (
    <ReactMarkdown
      remarkPlugins={markdownRemarkPluginsWithBreaks}
      rehypePlugins={markdownRehypePlugins}
      components={markdownComponents}
    >
      {preprocessMarkdown(text)}
    </ReactMarkdown>
  );
}

/**
 * 表格里的答案 / 解析 / 思路单元格：内容铺满整个单元格（宽高随格子），
 * 超出可视区域时末尾补「……」；悬停用浮层展示完整富文本（表格列宽固定，全展开会把行撑得非常高）。
 */
function MarkdownPreviewCell({ text, label }: { text: string | null; label: string }) {
  const bodyRef = useRef<HTMLDivElement | null>(null);
  const contentRef = useRef<HTMLDivElement | null>(null);
  const panelRef = useRef<HTMLDivElement | null>(null);
  const closeTimer = useRef<number | null>(null);
  const [clipped, setClipped] = useState(false);
  const [anchor, setAnchor] = useState<{ left: number; top: number; bottom: number } | null>(null);

  const measure = useCallback(() => {
    const el = bodyRef.current;
    if (!el) return;
    // jsdom 里两者都是 0，判定为未截断（不影响现有渲染断言）
    setClipped(el.scrollHeight > el.clientHeight + 1);
  }, []);

  useLayoutEffect(measure, [measure, text]);

  // 图片 / KaTeX 是异步撑高的，高度变化后要重新判定是否还有内容被裁掉
  useEffect(() => {
    const el = contentRef.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, [measure, text]);

  const cancelHide = useCallback(() => {
    if (closeTimer.current !== null) {
      window.clearTimeout(closeTimer.current);
      closeTimer.current = null;
    }
  }, []);

  const scheduleHide = useCallback(() => {
    cancelHide();
    closeTimer.current = window.setTimeout(() => {
      setAnchor(null);
      closeTimer.current = null;
    }, 120);
  }, [cancelHide]);

  useEffect(() => cancelHide, [cancelHide]);

  // 表格横向滚动 / 窗口变化时浮层会跟丢，直接收起；浮层内部滚动不算（要能滚着读长解析）
  useEffect(() => {
    if (!anchor) return;
    const hide = (event: Event) => {
      if (panelRef.current?.contains(event.target as Node)) return;
      setAnchor(null);
    };
    window.addEventListener('scroll', hide, true);
    window.addEventListener('resize', hide);
    return () => {
      window.removeEventListener('scroll', hide, true);
      window.removeEventListener('resize', hide);
    };
  }, [anchor]);

  if (!text || !text.trim()) {
    return (
      <span className="block px-4 py-3" style={{ color: 'var(--text-tertiary)' }}>
        —
      </span>
    );
  }
  const body = text;

  const handleEnter = (event: React.MouseEvent<HTMLDivElement>) => {
    if (!clipped) return;
    cancelHide();
    const rect = event.currentTarget.getBoundingClientRect();
    setAnchor({ left: rect.left, top: rect.top, bottom: rect.bottom });
  };

  const panel = (() => {
    if (!anchor) return null;
    const width = Math.min(440, window.innerWidth - 24);
    const left = Math.max(8, Math.min(anchor.left, window.innerWidth - width - 8));
    const below = window.innerHeight - anchor.bottom - 14;
    const above = anchor.top - 14;
    const placeBelow = below >= 200 || below >= above;
    const maxHeight = Math.max(160, Math.min(window.innerHeight * 0.6, placeBelow ? below : above));
    return createPortal(
      <div
        ref={panelRef}
        role="tooltip"
        data-testid="markdown-hover-preview"
        onMouseEnter={cancelHide}
        onMouseLeave={scheduleHide}
        className="overflow-auto rounded-xl border border-gray-200 bg-white p-3 text-xs shadow-xl"
        style={{
          position: 'fixed',
          left,
          width,
          maxHeight,
          zIndex: 60,
          ...(placeBelow
            ? { top: anchor.bottom + 6 }
            : { bottom: window.innerHeight - anchor.top + 6 }),
        }}
      >
        <div className="mb-1 text-[11px] font-medium" style={{ color: 'var(--text-tertiary)' }}>
          {label}
        </div>
        <MarkdownBody text={body} />
      </div>,
      document.body,
    );
  })();

  return (
    <div
      className="absolute inset-x-4 inset-y-3"
      data-testid="markdown-preview-cell"
      onMouseEnter={handleEnter}
      onMouseLeave={scheduleHide}
    >
      <div
        ref={bodyRef}
        data-testid="markdown-preview-body"
        className="h-full overflow-hidden"
        style={{ color: 'var(--text-primary)' }}
      >
        <div ref={contentRef}>
          <MarkdownBody text={body} />
        </div>
      </div>
      {clipped && (
        <span
          className="pointer-events-none absolute bottom-0 right-0 select-none pl-2"
          style={{
            color: 'var(--text-secondary)',
            background: 'linear-gradient(to right, rgba(255,255,255,0), #fff 40%)',
          }}
        >
          ……
        </span>
      )}
      {panel}
    </div>
  );
}

/**
 * 教研试卷详情：按路由 id 拉题目明细，表格给出每题的编辑入口。
 * 点击「编辑」把完整 question（含五字段原值）交给抽屉；抽屉实现属 Task 10，
 * 通过 ResearchQuestionEditDrawer 的 props 契约挂载。
 */
export default function ResearchPaperDetailPage() {
  const { id } = useParams<{ id: string }>();
  const paperId = Number(id);
  const [data, setData] = useState<ResearchPaperDetailResult | null>(null);
  const [error, setError] = useState('');
  const [editingQuestion, setEditingQuestion] = useState<ResearchQuestionDetail | null>(null);

  const load = useCallback(() => {
    if (!Number.isInteger(paperId) || paperId <= 0) {
      setError('试卷编号无效');
      setData(null);
      return;
    }
    setError('');
    getResearchPaper(paperId)
      .then(setData)
      .catch((err: unknown) => {
        setData(null);
        setError(errMessage(err));
      });
  }, [paperId]);

  useEffect(() => {
    load();
  }, [load]);

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-black tracking-tight" style={{ color: 'var(--text-primary)' }}>
        {data ? data.paper.title : '试卷题目明细'}
      </h1>

      {error ? (
        <div data-testid="detail-error" className="bg-white rounded-2xl border border-dashed border-gray-200 p-10 text-center text-sm" style={{ color: 'var(--text-secondary)' }}>
          试卷详情加载失败，请稍后重试
        </div>
      ) : data === null ? (
        <div data-testid="detail-loading" className="bg-white rounded-2xl border border-gray-200 p-5 space-y-3">
          <Skeleton width={180} height={16} />
          <Skeleton width="80%" height={14} />
          <Skeleton width="60%" height={14} />
        </div>
      ) : data.questions.length === 0 ? (
        <div data-testid="detail-empty" className="bg-white rounded-2xl border border-dashed border-gray-200 p-10 text-center text-sm" style={{ color: 'var(--text-secondary)' }}>
          该试卷暂无题目
        </div>
      ) : (
        <div data-testid="detail-table" className="bg-white rounded-2xl border border-gray-200 overflow-x-auto">
          <table className="w-full min-w-[1270px] table-fixed text-sm">
            <colgroup>
              <col className="w-16" />
              <col className="w-20" />
              <col />
              <col className="w-[10.5rem]" />
              <col className="w-56" />
              <col className="w-48" />
              <col className="w-28" />
              <col className="w-[6.5rem]" />
            </colgroup>
            <thead className="bg-gray-50" style={{ color: 'var(--text-secondary)' }}>
              <tr>
                <th className="text-left px-4 py-3 font-medium">题号</th>
                <th className="text-left px-4 py-3 font-medium">题型</th>
                <th className="text-left px-4 py-3 font-medium">题干</th>
                <th className="text-left px-4 py-3 font-medium">答案</th>
                <th className="text-left px-4 py-3 font-medium">解析</th>
                <th className="text-left px-4 py-3 font-medium">思路</th>
                <th className="text-left px-4 py-3 font-medium">来源</th>
                <th className="text-right px-4 py-3 font-medium whitespace-nowrap">操作</th>
              </tr>
            </thead>
            <tbody style={{ color: 'var(--text-primary)' }}>
              {data.questions.map((q) => (
                <tr key={q.id} className="border-t border-gray-100">
                  <td className="px-4 py-3">{q.questionNo}{q.subNo ? `(${q.subNo})` : ''}</td>
                  <td className="px-4 py-3">{q.type}</td>
                  <td className="px-4 py-3">
                    <MarkdownBody text={q.content} />
                  </td>
                  {/* 答案与解析/思路同口径渲染富文本；格子高度随行高，超出才裁掉并在悬停时看全文 */}
                  <td className={`relative p-0 align-top ${q.answer.trim() ? 'h-20' : ''}`}>
                    <MarkdownPreviewCell text={q.answer} label="答案" />
                  </td>
                  {/* 显示正文而不是「有/无」：教研改完解析/思路要能在列表里立刻看到变化（PRD §7.14 的明细含这两列） */}
                  <td className={`relative p-0 align-top text-xs ${q.explanation?.trim() ? 'h-28' : ''}`}>
                    <MarkdownPreviewCell text={q.explanation} label="解析" />
                  </td>
                  <td className={`relative p-0 align-top text-xs ${q.approach?.trim() ? 'h-28' : ''}`}>
                    <MarkdownPreviewCell text={q.approach} label="思路" />
                  </td>
                  <td className="px-4 py-3">
                    <div
                      className="max-w-[9rem] truncate"
                      title={q.source ? `${q.source}${q.sourceYear ? ` ${q.sourceYear}` : ''}` : ''}
                    >
                      {q.source ? `${q.source}${q.sourceYear ? ` ${q.sourceYear}` : ''}` : '—'}
                    </div>
                  </td>
                  {/* whitespace-nowrap + 最小宽度：列被挤压时「编辑」不再竖排折行，也留得下 4 个字的按钮 */}
                  <td className="px-4 py-3 text-right whitespace-nowrap min-w-[6.5rem]">
                    <button
                      type="button"
                      data-testid={`question-edit-${q.id}`}
                      onClick={() => setEditingQuestion(q)}
                      className="px-3 py-1.5 rounded-lg text-xs font-semibold whitespace-nowrap bg-[var(--brand-500)] text-white hover:opacity-90"
                    >
                      编辑
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {editingQuestion && (
        <ResearchQuestionEditDrawer
          question={editingQuestion}
          onClose={() => setEditingQuestion(null)}
          onSaved={() => {
            setEditingQuestion(null);
            load();
          }}
        />
      )}
    </div>
  );
}
