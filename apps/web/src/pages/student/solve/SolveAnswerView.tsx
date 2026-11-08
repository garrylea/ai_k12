// apps/web/src/pages/student/solve/SolveAnswerView.tsx
// 状态 C · 作答：自由出题页的作答卡片，骨架照考试第 9 题（题干在上、左输入右预览、
// 底部「答疑 / 提交」）。页面级草稿面板由 SolvePage 组合（本组件只提供「附上草稿」开关），
// 提交前校验（答案非空、图片上传中等）也归父层——本组件只负责 submitting 的按钮态，
// 并把 LatexEditor 的「上传中」经 onUploadingChange 透给父层（父层 OR 进提交禁用态）。
import { useRef } from 'react';
import ReactMarkdown from 'react-markdown';
import {
  preprocessMarkdown,
  markdownRemarkPluginsWithBreaks,
  markdownRehypePlugins,
  markdownComponents,
  MarkdownImg,
  ANSWER_IMG_CLASS,
} from '@/components/markdown';
import { LatexEditor } from '@/components/business/LatexEditor';
import { LatexPreview } from '@/components/business/LatexPreview';
import type { PreviewScrollSync } from '@/components/business/preview-scroll-sync';

// 题干图：与 QuestionRunner 题面图同口径——bucketHeight 按宽高比分桶定高，
// dragToDraft 允许拖进页面级草稿面板（学生要照着图标注）。
// 必须模块级常量：img 组件类型每次渲染都变会让 React 卸载重挂 <img>（重新下载）。
const questionComponents = {
  ...markdownComponents,
  img: (props: { src?: string; alt?: string }) => (
    <MarkdownImg {...props} bucketHeight dragToDraft className="block mx-auto my-4 max-w-full object-contain rounded-lg" />
  ),
};

export interface SolveAnswerViewProps {
  /** 题干 Markdown（含 LaTeX / 图片） */
  questionContent: string;
  answer: string;
  onAnswerChange: (v: string) => void;
  /** 底部「附上草稿」勾选态；草稿内容由页面级 DraftPanel 持有 */
  includeDraft: boolean;
  onIncludeDraftChange: (v: boolean) => void;
  submitting: boolean;
  onAskHelp: () => void;
  onSubmit: () => void;
  /** 作答区图片上传中（LatexEditor 透传）；父层把它并进「提交」禁用态（spec §8.5） */
  onUploadingChange?: (v: boolean) => void;
}

export function SolveAnswerView(props: SolveAnswerViewProps) {
  // 左输入区 → 右预览区的滚动跟随通道：ref 而非 state，滚动不触发整树重渲染
  const scrollSync = useRef<PreviewScrollSync>({ ratio: 0 });

  return (
    // h-full：max-h-[33%] / flex-[2] 与内部 LatexEditor/LatexPreview 的 h-full 都依赖
    // 父层给出的确定高度；本卡片不自带高度时的百分比/弹性分配会静默失效。
    <div className="h-full rounded-xl border border-[var(--learn-card-border)] bg-[var(--learn-card-bg)] flex flex-col min-h-0">
      <div className="shrink-0 max-h-[33%] overflow-auto px-5 py-4 border-b border-[var(--bg-subtle)] md-prose text-[var(--text-primary)]">
        <ReactMarkdown
          remarkPlugins={markdownRemarkPluginsWithBreaks}
          rehypePlugins={markdownRehypePlugins}
          components={questionComponents}
        >
          {preprocessMarkdown(props.questionContent)}
        </ReactMarkdown>
      </div>

      <div className="flex-[2] min-h-[280px] flex">
        <div className="w-1/2 min-w-0 border-r border-[var(--bg-subtle)] flex flex-col">
          <LatexEditor
            value={props.answer}
            onChange={props.onAnswerChange}
            scrollSync={scrollSync}
            onUploadingChange={props.onUploadingChange}
          />
        </div>
        <div className="w-1/2 min-w-0">
          <LatexPreview value={props.answer} scrollSync={scrollSync} imgClassName={ANSWER_IMG_CLASS} />
        </div>
      </div>

      <div className="shrink-0 grid grid-cols-3 items-center gap-3 px-4 py-3 border-t border-[var(--bg-subtle)]">
        <label className="flex items-center gap-2 text-sm text-[var(--text-secondary)]">
          <input
            type="checkbox"
            className="w-4 h-4 accent-[var(--brand-500)]"
            checked={props.includeDraft}
            onChange={(e) => props.onIncludeDraftChange(e.target.checked)}
          />
          附上草稿
        </label>
        <div className="flex items-center justify-center gap-3">
          <button
            type="button"
            onClick={props.onAskHelp}
            disabled={props.submitting}
            className="h-10 px-5 rounded-lg border border-[var(--brand-500)] text-[var(--brand-500)] text-sm disabled:opacity-50"
          >
            答疑
          </button>
          <button
            type="button"
            onClick={props.onSubmit}
            disabled={props.submitting}
            className="h-10 px-6 rounded-lg bg-[var(--brand-500)] text-white text-sm disabled:opacity-50 inline-flex items-center gap-2"
          >
            {props.submitting && (
              <svg
                className="animate-spin"
                width="16"
                height="16"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                aria-hidden="true"
              >
                <path d="M21 12a9 9 0 1 1-6.219-8.56" />
              </svg>
            )}
            {props.submitting ? '提交中…' : '提交'}
          </button>
        </div>
        <div />
      </div>
    </div>
  );
}
