import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import ReactMarkdown from 'react-markdown';
import { Card, Skeleton } from '@/components/base';
import {
  markdownRemarkPlugins,
  markdownRehypePlugins,
  markdownComponents,
  preprocessMarkdown,
} from '@/components/markdown';
import {
  getPracticeHistoryDetail,
  type PracticeHistoryDetail,
  type PracticeHistoryQuestion,
} from '@/services/api';
import { TRAINING_SUBJECTS } from '@/subjectConfig';

/**
 * 练习记录详情（2026-11-01）——逐题回放：题面 + 我的答案 + 正确答案 + 解析 + 对错。
 *
 * 只读，**不做「再做一遍」**（一期刻意不加，避免与错题本/训练轨入口混淆）。
 * 语文三专项的 questionId 为 null：answerText 是 JSON，题面改为「篇名 + 句原文」。
 * Markdown 一律走 `@/components/markdown` 共享配置（图片 resolveAsset / HTML / 表格带线）。
 */

const SUBJECT_NAME = new Map<number, string>(TRAINING_SUBJECTS.map((s) => [s.id, s.name]));

function formatDateTime(iso: string): string {
  const d = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function MarkdownBlock({ text, className }: { text: string; className?: string }) {
  return (
    <div className={className}>
      <ReactMarkdown
        remarkPlugins={markdownRemarkPlugins}
        rehypePlugins={markdownRehypePlugins}
        components={markdownComponents}
      >
        {preprocessMarkdown(text)}
      </ReactMarkdown>
    </div>
  );
}

/** 语文专项的结构化作答 JSON → 可读键值行。解析失败返回 null（退化为原文展示）。 */
function parseStructured(answerText: string | null): Array<{ label: string; value: string }> | null {
  if (!answerText) return null;
  try {
    const obj = JSON.parse(answerText) as Record<string, unknown>;
    if (obj === null || typeof obj !== 'object') return null;
    const rows: Array<{ label: string; value: string }> = [];
    if (typeof obj.author === 'string') rows.push({ label: '作者', value: obj.author });
    if (typeof obj.dynasty === 'string') rows.push({ label: '朝代', value: obj.dynasty });
    if (typeof obj.body === 'string') rows.push({ label: '正文', value: obj.body });
    if (typeof obj.translation === 'string') rows.push({ label: '整句翻译', value: obj.translation });
    if (typeof obj.meaning === 'string') rows.push({ label: '深层含义', value: obj.meaning });
    if (typeof obj.emotion === 'string') rows.push({ label: '作者情感', value: obj.emotion });
    if (Array.isArray(obj.terms)) {
      const terms = (obj.terms as Array<{ term?: unknown; answer?: unknown }>)
        .filter((t) => t && typeof t.term === 'string')
        .map((t) => `${String(t.term)}：${typeof t.answer === 'string' ? t.answer : ''}`)
        .join('；');
      if (terms) rows.push({ label: '重点字词', value: terms });
    }
    return rows.length > 0 ? rows : null;
  } catch {
    return null;
  }
}

function StatusBadge({ isCorrect }: { isCorrect: boolean | null }) {
  if (isCorrect === true) {
    return (
      <span className="inline-flex items-center gap-1 rounded-[var(--radius-pill)] bg-[var(--bg-subtle)] px-2 py-0.5 text-xs text-[var(--success)]">
        <svg aria-hidden="true" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
          <polyline points="20 6 9 17 4 12" />
        </svg>
        答对
      </span>
    );
  }
  if (isCorrect === false) {
    return (
      <span className="inline-flex items-center gap-1 rounded-[var(--radius-pill)] bg-[var(--bg-subtle)] px-2 py-0.5 text-xs text-[var(--error)]">
        <svg aria-hidden="true" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round">
          <line x1="6" y1="6" x2="18" y2="18" />
          <line x1="18" y1="6" x2="6" y2="18" />
        </svg>
        答错
      </span>
    );
  }
  return (
    <span className="inline-flex items-center rounded-[var(--radius-pill)] bg-[var(--bg-subtle)] px-2 py-0.5 text-xs text-[var(--text-tertiary)]">
      未判定
    </span>
  );
}

function QuestionCard({ q }: { q: PracticeHistoryQuestion }) {
  const structured = parseStructured(q.answerText);
  const isChineseSpecial = q.questionId === null;

  return (
    <li className="rounded-[var(--radius-md)] border border-[var(--bg-subtle)] bg-[var(--bg-card)] p-4">
      <div className="mb-3 flex items-center gap-2">
        <span className="text-sm text-[var(--text-tertiary)]">{`第 ${q.questionOrder} 题`}</span>
        <StatusBadge isCorrect={q.isCorrect} />
      </div>

      {/* 题面：考试取 questionContent；语文专项取篇名 + 句原文 */}
      {q.questionContent ? (
        <MarkdownBlock text={q.questionContent} className="mb-3 text-sm text-[var(--text-primary)]" />
      ) : isChineseSpecial ? (
        <div className="mb-3 text-sm text-[var(--text-primary)]">
          {q.passageTitle && <p className="font-semibold">{q.passageTitle}</p>}
          {q.passageSentence && <p className="mt-1 text-[var(--text-secondary)]">{q.passageSentence}</p>}
        </div>
      ) : null}

      {/* 我的答案 */}
      <div className="mb-2 text-sm">
        <span className="text-[var(--text-tertiary)]">我的答案：</span>
        {structured ? (
          <div className="mt-1 space-y-0.5 pl-1">
            {structured.map((r) => (
              <div key={r.label} className="text-[var(--text-primary)]">
                <span className="text-[var(--text-tertiary)]">{`${r.label}：`}</span>
                {r.value}
              </div>
            ))}
          </div>
        ) : q.answerText ? (
          <MarkdownBlock text={q.answerText} className="mt-1 text-[var(--text-primary)]" />
        ) : (
          <span className="text-[var(--text-tertiary)]">（未作答）</span>
        )}
      </div>

      {/* 正确答案 */}
      {q.questionAnswer ? (
        <div className="mb-2 text-sm">
          <span className="text-[var(--text-tertiary)]">正确答案：</span>
          <MarkdownBlock text={q.questionAnswer} className="mt-1 text-[var(--success)]" />
        </div>
      ) : null}

      {/* 解析 */}
      {q.analysis || q.questionAnalysis ? (
        <div className="mt-3 border-t border-[var(--bg-subtle)] pt-3">
          <p className="mb-1 text-xs text-[var(--text-tertiary)]">解析</p>
          <MarkdownBlock
            text={q.analysis ?? q.questionAnalysis ?? ''}
            className="text-sm text-[var(--text-secondary)]"
          />
        </div>
      ) : (
        <p className="mt-2 text-xs text-[var(--text-tertiary)]">解析未生成</p>
      )}
    </li>
  );
}

export default function PracticeHistoryDetailPage() {
  const { source, sessionId } = useParams<{ source: string; sessionId: string }>();
  const [data, setData] = useState<PracticeHistoryDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [notFound, setNotFound] = useState(false);

  useEffect(() => {
    if (source !== 'exam' && source !== 'special') {
      setNotFound(true);
      setLoading(false);
      return;
    }
    const sid = Number(sessionId);
    if (!Number.isInteger(sid) || sid < 1) {
      setNotFound(true);
      setLoading(false);
      return;
    }
    let cancelled = false;
    setLoading(true);
    setNotFound(false);
    getPracticeHistoryDetail(source, sid)
      .then((d) => {
        if (!cancelled) setData(d);
      })
      .catch(() => {
        if (!cancelled) setNotFound(true);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [source, sessionId]);

  if (loading) {
    return (
      <div className="mx-auto max-w-3xl space-y-3 px-6 py-8" data-testid="history-detail-skeleton">
        <Skeleton width="60%" height={28} rounded />
        <Skeleton width="100%" height={140} rounded />
        <Skeleton width="100%" height={140} rounded />
      </div>
    );
  }

  if (notFound || !data) {
    return (
      <div className="mx-auto max-w-3xl space-y-4 px-6 py-8">
        <Card className="p-6">
          <p className="text-sm text-[var(--text-secondary)]">这条练习记录不存在，或不属于你。</p>
          <Link
            to="/student/practice-history"
            className="mt-3 inline-block text-sm text-[var(--brand-500)] underline"
          >
            返回练习记录
          </Link>
        </Card>
      </div>
    );
  }

  const { session, questions } = data;
  const inProgress = session.completedAt === null;

  return (
    <div className="mx-auto max-w-3xl space-y-6 px-6 py-8">
      <div>
        <Link
          to="/student/practice-history"
          className="inline-flex items-center gap-1 text-sm text-[var(--text-tertiary)] hover:text-[var(--text-primary)]"
        >
          <svg aria-hidden="true" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <polyline points="15 18 9 12 15 6" />
          </svg>
          返回练习记录
        </Link>
      </div>

      <Card className="p-5">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <span className="rounded-[var(--radius-pill)] bg-[var(--bg-subtle)] px-2 py-0.5 text-xs text-[var(--text-secondary)]">
                {SUBJECT_NAME.get(session.subjectId) ?? '学科'}
              </span>
              <h1 className="text-xl font-black tracking-tight text-[var(--text-primary)]">
                {session.title ?? (session.source === 'exam' ? '考试' : '专项练习')}
              </h1>
              {inProgress && (
                <span className="text-xs text-[var(--text-tertiary)]">进行中</span>
              )}
            </div>
            <p className="mt-2 text-xs text-[var(--text-tertiary)] tabular-nums">
              {formatDateTime(session.startedAt)}
              {session.completedAt ? ` — ${formatDateTime(session.completedAt)}` : ''}
            </p>
          </div>
          <div className="text-right">
            <p className="text-2xl font-bold tabular-nums text-[var(--text-primary)]">
              {`${session.correctCount}/${session.totalCount}`}
            </p>
            <p className="text-xs text-[var(--text-tertiary)]">答对</p>
          </div>
        </div>
      </Card>

      {questions.length === 0 ? (
        <Card className="p-6">
          <p className="text-sm text-[var(--text-secondary)]">这套卷子还没有作答记录。</p>
        </Card>
      ) : (
        <ol className="space-y-3">
          {questions.map((q) => (
            <QuestionCard key={`${q.questionOrder}-${q.refType ?? 'q'}-${q.refId ?? q.questionId}`} q={q} />
          ))}
        </ol>
      )}
    </div>
  );
}
