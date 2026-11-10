// apps/web/src/pages/student/solve/SolveJudgeResult.tsx
// 提交后的判题结果卡：结论 / 得分 / 我的答案 / 正确答案 / 完整判题报告。
// 刻意不把判题报告塞回聊天区 —— 学生要的是「我错在哪、正确答案是什么」，
// 聊天区只留给【答疑】。
import { useEffect, useRef, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import { useChatStore } from '@/store/chatStore';
import {
  preprocessMarkdown,
  markdownRemarkPluginsWithBreaks,
  markdownRehypePlugins,
  markdownComponents,
  MarkdownImg,
} from '@/components/markdown';
import type { FreeformJudgeResult } from './useFreeformJudge';

const answerComponents = {
  ...markdownComponents,
  img: (props: { src?: string; alt?: string }) => (
    <MarkdownImg {...props} className="inline-block my-2 max-w-full max-h-[220px] object-contain rounded-lg align-middle" />
  ),
};

const VERDICT_TEXT: Record<FreeformJudgeResult['verdict'], string> = {
  correct: '回答正确',
  partial: '部分正确',
  incorrect: '回答错误',
};

function VerdictIcon({ verdict }: { verdict: FreeformJudgeResult['verdict'] }) {
  const common = {
    width: 22,
    height: 22,
    viewBox: '0 0 24 24',
    fill: 'none',
    stroke: 'currentColor',
    strokeWidth: 2.2,
    strokeLinecap: 'round' as const,
    strokeLinejoin: 'round' as const,
    'aria-hidden': true,
  };
  if (verdict === 'correct') {
    return (
      <svg {...common}>
        <path d="M20 6L9 17l-5-5" />
      </svg>
    );
  }
  if (verdict === 'partial') {
    return (
      <svg {...common}>
        <circle cx="12" cy="12" r="9" />
        <path d="M8 12h8" />
      </svg>
    );
  }
  return (
    <svg {...common}>
      <path d="M18 6L6 18M6 6l12 12" />
    </svg>
  );
}

function MarkdownBlock({ content, emptyText }: { content: string; emptyText?: string }) {
  if (!content.trim()) {
    return <p className="text-sm text-[var(--text-tertiary)]">{emptyText ?? '（空）'}</p>;
  }
  return (
    <div className="md-prose text-sm text-[var(--text-primary)]">
      <ReactMarkdown
        remarkPlugins={markdownRemarkPluginsWithBreaks}
        rehypePlugins={markdownRehypePlugins}
        components={answerComponents}
      >
        {preprocessMarkdown(content)}
      </ReactMarkdown>
    </div>
  );
}

/**
 * 判题进行中：把模型的思考过程与报告增量实时摊开，并显示已等待秒数。
 *
 * 只订阅最后一条 assistant 消息的两个字符串（不订阅整个 messages 数组），
 * 流式增量只重渲染这个面板，不带动整页（含编辑器/草稿）重渲染。
 */
function JudgeLivePanel({ onStop }: { onStop?: () => void }) {
  const reasoning = useChatStore((s) => {
    const last = s.messages[s.messages.length - 1];
    return last?.role === 'assistant' ? (last.reasoning ?? '') : '';
  });
  const content = useChatStore((s) => {
    const last = s.messages[s.messages.length - 1];
    return last?.role === 'assistant' ? last.content : '';
  });

  const [seconds, setSeconds] = useState(0);
  useEffect(() => {
    const timer = setInterval(() => setSeconds((v) => v + 1), 1000);
    return () => clearInterval(timer);
  }, []);

  const reasoningRef = useRef<HTMLDivElement>(null);
  const normalized = reasoning.replace(/\\n/g, '\n');
  useEffect(() => {
    const el = reasoningRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [normalized]);

  const timeText = seconds < 60 ? `${seconds} 秒` : `${Math.floor(seconds / 60)} 分 ${seconds % 60} 秒`;

  return (
    <div className="h-full min-h-0 rounded-xl border border-[var(--learn-card-border)] bg-[var(--learn-card-bg)] flex flex-col">
      <div className="shrink-0 flex items-center gap-3 px-5 py-4 border-b border-[var(--bg-subtle)]">
        <svg
          className="animate-spin text-[var(--brand-500)] shrink-0"
          width="22"
          height="22"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          aria-hidden="true"
        >
          <path d="M21 12a9 9 0 1 1-6.219-8.56" />
        </svg>
        <div className="min-w-0">
          <div className="text-sm font-medium text-[var(--text-primary)]">
            AI 正在判题… 已等待 {timeText}
          </div>
          <div className="text-xs text-[var(--text-tertiary)]">
            先独立解题再批改，通常 30–90 秒；下面的思考过程与报告会实时更新
          </div>
        </div>
        {onStop && (
          <button
            type="button"
            onClick={onStop}
            className="ml-auto h-8 px-3 rounded-lg border border-[var(--bg-subtle)] text-xs text-[var(--text-secondary)] shrink-0"
          >
            停止
          </button>
        )}
      </div>

      <div className="flex-1 min-h-0 flex flex-col gap-3 px-5 py-4 overflow-hidden">
        {normalized.trim() ? (
          <section className="flex flex-col min-h-0 flex-1">
            <h3 className="shrink-0 text-xs font-semibold text-[var(--text-tertiary)] mb-1">思考过程（实时）</h3>
            <div
              ref={reasoningRef}
              className="flex-1 min-h-0 overflow-auto rounded-lg border border-[var(--bg-subtle)] bg-[var(--bg-subtle)]/40 px-3 py-2 text-xs leading-relaxed whitespace-pre-wrap text-[var(--text-secondary)]"
            >
              {normalized}
            </div>
          </section>
        ) : (
          <div className="text-sm text-[var(--text-tertiary)]">模型正在思考，还没有输出…</div>
        )}

        {content.trim() && (
          <section className="flex flex-col min-h-0 flex-1">
            <h3 className="shrink-0 text-xs font-semibold text-[var(--text-tertiary)] mb-1">判题报告（生成中）</h3>
            <div className="flex-1 min-h-0 overflow-auto">
              <MarkdownBlock content={content} />
            </div>
          </section>
        )}
      </div>
    </div>
  );
}

export interface SolveJudgeResultProps {
  /** null = 还在判题（显示等待态） */
  result: FreeformJudgeResult | null;
  submitting: boolean;
  /** 学生主动停止过判题（不算失败，给继续/返回） */
  stopped?: boolean;
  onStop?: () => void;
  /** 重练队列：下一题 / 返回错题本 */
  nextLabel?: string;
  onNext?: () => void;
  /** 本次提交的作答快照（不是编辑器当前值） */
  myAnswer: string;
  /** 完整判题报告（流结束后从消息里取一次） */
  report: string;
  /** 判题失败信息（有值时显示重试） */
  error?: string | null;
  onRetry?: () => void;
  onAskHelp: () => void;
  onEditAgain: () => void;
}

export function SolveJudgeResult(props: SolveJudgeResultProps) {
  const { result, submitting, error } = props;

  if (!result) {
    if (submitting) return <JudgeLivePanel onStop={props.onStop} />;
    return (
      <div className="h-full rounded-xl border border-[var(--learn-card-border)] bg-[var(--learn-card-bg)] flex flex-col items-center justify-center gap-3 px-6">
        <div className="text-sm text-[var(--text-primary)]">
          {props.stopped ? '已停止判题' : error ?? '判题没有完成'}
        </div>
        {props.stopped && (
          <div className="text-xs text-[var(--text-tertiary)]">已生成的报告不会保存，继续判题会重新开始。</div>
        )}
        <div className="flex items-center gap-3">
          {props.onRetry && (
            <button
              type="button"
              onClick={props.onRetry}
              className="h-9 px-4 rounded-lg bg-[var(--brand-500)] text-white text-sm"
            >
              {props.stopped ? '继续判题' : '重试'}
            </button>
          )}
          <button
            type="button"
            onClick={props.onEditAgain}
            className="h-9 px-4 rounded-lg border border-[var(--bg-subtle)] text-sm text-[var(--text-secondary)]"
          >
            返回作答
          </button>
          {props.nextLabel && props.onNext && (
            <button
              type="button"
              onClick={props.onNext}
              className="h-9 px-4 rounded-lg bg-[var(--brand-500)] text-white text-sm"
            >
              {props.nextLabel}
            </button>
          )}
        </div>
      </div>
    );
  }

  const tone =
    result.verdict === 'correct'
      ? 'var(--success, #2E7D32)'
      : result.verdict === 'partial'
        ? 'var(--brand-500)'
        : 'var(--error)';

  return (
    <div className="h-full min-h-0 rounded-xl border border-[var(--learn-card-border)] bg-[var(--learn-card-bg)] flex flex-col">
      <div className="shrink-0 flex items-center gap-3 px-5 py-4 border-b border-[var(--bg-subtle)]">
        <span
          className="w-9 h-9 rounded-full flex items-center justify-center shrink-0"
          style={{ color: tone, backgroundColor: 'var(--bg-subtle)' }}
        >
          <VerdictIcon verdict={result.verdict} />
        </span>
        <div className="min-w-0">
          <div className="text-base font-semibold" style={{ color: tone }}>
            {VERDICT_TEXT[result.verdict]}
          </div>
          <div className="text-xs text-[var(--text-tertiary)]">
            得分 {result.totalScore} / {result.maxScore}
          </div>
        </div>
        <div className="ml-auto flex items-center gap-2">
          <button
            type="button"
            onClick={props.onEditAgain}
            className="h-9 px-4 rounded-lg border border-[var(--bg-subtle)] text-sm text-[var(--text-secondary)]"
          >
            再答一次
          </button>
          <button
            type="button"
            onClick={props.onAskHelp}
            className="h-9 px-4 rounded-lg border border-[var(--brand-500)] text-[var(--brand-500)] text-sm"
          >
            答疑
          </button>
          {props.nextLabel && props.onNext && (
            <button
              type="button"
              onClick={props.onNext}
              className="h-9 px-4 rounded-lg bg-[var(--brand-500)] text-white text-sm"
            >
              {props.nextLabel}
            </button>
          )}
        </div>
      </div>

      <div className="flex-1 min-h-0 overflow-auto px-5 py-4 space-y-5">
        <section>
          <h3 className="text-sm font-semibold text-[var(--text-primary)] mb-2">我的答案</h3>
          <MarkdownBlock content={props.myAnswer} emptyText="（本次只提交了草稿）" />
        </section>

        <section>
          <h3 className="text-sm font-semibold text-[var(--text-primary)] mb-2">正确答案</h3>
          <div className="rounded-lg border border-[var(--bg-subtle)] bg-[var(--bg-subtle)]/40 px-4 py-3">
            <MarkdownBlock content={result.correctAnswer} emptyText="（模型未给出标准答案）" />
          </div>
        </section>

        {props.report.trim() && (
          <section>
            <h3 className="text-sm font-semibold text-[var(--text-primary)] mb-2">完整判题报告</h3>
            <MarkdownBlock content={props.report} />
          </section>
        )}
      </div>
    </div>
  );
}
