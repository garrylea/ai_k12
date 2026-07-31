import { useEffect, useState, useMemo } from 'react';
import { useNavigate, useLocation, useSearchParams } from 'react-router-dom';
import { motion, AnimatePresence } from 'framer-motion';
import ReactMarkdown from 'react-markdown';
import remarkMath from 'remark-math';
import remarkGfm from 'remark-gfm';
import rehypeKatex from 'rehype-katex';
import 'katex/dist/katex.min.css';
import { useThemeStore } from '@/store/themeStore';
import { fetchLessonCards, type LessonCard, type LessonCardsData } from '@/services/api';

const ASSET_BASE = (import.meta.env.VITE_ASSET_BASE_URL as string) || '/assets/';
const resolveAsset = (p: string) =>
  /^https?:\/\//.test(p) ? p : `${ASSET_BASE}${p.replace(/^\/+/, '')}`;

// --- Icons ---
const ArrowLeftIcon = () => (
  <svg className="w-5 h-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
    <polyline points="15 18 9 12 15 6" />
  </svg>
);
const ChatIcon = () => (
  <svg className="w-6 h-6" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
  </svg>
);
const SunIcon = () => (
  <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <circle cx="12" cy="12" r="4" />
    <path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M4.93 19.07l1.41-1.41M17.66 6.34l1.41-1.41" />
  </svg>
);
const MoonIcon = () => (
  <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z" />
  </svg>
);

const CARD_TYPE_LABEL: Record<LessonCard['cardType'], string> = {
  concept: '概念',
  example: '例题',
  practice: '练习',
  explore: '探究',
  summary: '小结',
  reading: '阅读',
};

function LoadingSkeleton() {
  return (
    <div className="min-h-screen flex items-center justify-center bg-[var(--bg-base)]">
      <div className="space-y-6 animate-pulse">
        <div className="h-8 w-48 bg-[var(--bg-subtle)] rounded-lg mx-auto" />
        <div className="h-[24rem] w-[46rem] max-w-[90vw] bg-[var(--bg-subtle)] rounded-[var(--radius-card)]" />
      </div>
    </div>
  );
}

function ErrorState({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <div className="min-h-screen flex flex-col items-center justify-center gap-4 bg-[var(--bg-base)]">
      <p className="text-[var(--text-secondary)] text-lg">{message}</p>
      <button onClick={onRetry} className="px-6 py-2.5 bg-[var(--brand-500)] text-white rounded-[var(--radius-button)] font-medium">
        重试
      </button>
    </div>
  );
}

export default function CourseDetailPage() {
  const navigate = useNavigate();
  const location = useLocation();
  const [searchParams] = useSearchParams();
  const { mode, setMode, autoToggleNightMode } = useThemeStore();

  const lessonId =
    (location.state as { lessonId?: number } | null)?.lessonId ??
    Number(searchParams.get('lessonId')) ??
    0;
  const breadcrumb = (location.state as { breadcrumb?: string } | null)?.breadcrumb ?? '';

  const [data, setData] = useState<LessonCardsData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [page, setPage] = useState(0);

  useEffect(() => {
    autoToggleNightMode();
    const t = setInterval(autoToggleNightMode, 60000);
    return () => clearInterval(t);
  }, [autoToggleNightMode]);

  const fetchData = async () => {
    setLoading(true);
    setError(null);
    try {
      if (!lessonId) throw new Error('缺少课程信息，请从星图选择小节进入');
      const result = await fetchLessonCards(lessonId);
      if (result.cards.length === 0) throw new Error('本节暂无卡片内容');
      setData(result);
      setPage(0);
    } catch (err: any) {
      setError(err.message || '加载失败');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { fetchData(); }, [lessonId]);

  const total = data?.cards.length ?? 0;
  const card = useMemo(() => data?.cards[page] ?? null, [data, page]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'ArrowLeft') setPage(p => Math.max(0, p - 1));
      if (e.key === 'ArrowRight') setPage(p => Math.min(total - 1, p + 1));
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [total]);

  if (loading) return <LoadingSkeleton />;
  if (error) return <ErrorState message={error} onRetry={fetchData} />;
  if (!data || !card) return <ErrorState message="暂无课程数据" onRetry={fetchData} />;

  return (
    <div className="student-theme-container" data-theme={mode} data-school="junior">
      <div className="h-screen flex bg-[var(--bg-base)] text-[var(--text-primary)] overflow-hidden">
        {/* 左侧阶段栏 */}
        <aside
          className="hidden md:flex flex-col shrink-0 bg-[var(--bg-page)] border-r border-[var(--bg-subtle)]"
          style={{ width: 'var(--learn-sidebar-width)' }}
        >
          <div className="p-5">
            <button
              onClick={() => navigate('/student/level-map')}
              className="flex items-center gap-2 text-sm text-[var(--text-secondary)] hover:text-[var(--text-primary)] transition-colors mb-4"
            >
              <ArrowLeftIcon />
              <span>返回关卡星地图</span>
            </button>
            <h2 className="text-sm text-[var(--text-tertiary)] mb-1">今日任务</h2>
            <h1 className="text-lg font-bold text-[var(--text-primary)]">数学 · 初二上</h1>
          </div>

          <nav className="flex-1 px-4 space-y-2 overflow-y-auto">
            {/* 阶段列表 — 由后端接口返回，此处静态占位 */}
            <div className="flex items-start gap-3 p-3 rounded-lg bg-[var(--bg-subtle)]/50">
              <div className="w-2 h-2 rounded-full bg-[var(--text-tertiary)] mt-1.5 shrink-0" />
              <div>
                <p className="text-sm font-medium text-[var(--text-secondary)]">错题清零（前一课）</p>
                <p className="text-xs text-[var(--text-tertiary)]">有 2 道错题未清</p>
              </div>
            </div>
            <div className="flex items-start gap-3 p-3 rounded-lg">
              <div className="w-2 h-2 rounded-full bg-[var(--brand-500)] mt-1.5 shrink-0" />
              <div>
                <p className="text-sm font-medium text-[var(--text-primary)]">12.2 一元二次方程的解法</p>
                <p className="text-xs text-[var(--text-tertiary)]">核心知识</p>
              </div>
            </div>
            <div className="flex items-start gap-3 p-3 rounded-lg opacity-50">
              <div className="w-2 h-2 rounded-full bg-[var(--text-tertiary)] mt-1.5 shrink-0" />
              <div>
                <p className="text-sm font-medium text-[var(--text-secondary)]">课堂练习</p>
                <p className="text-xs text-[var(--text-tertiary)]">思路提示</p>
              </div>
            </div>
            <div className="flex items-start gap-3 p-3 rounded-lg opacity-50">
              <div className="w-2 h-2 rounded-full bg-[var(--text-tertiary)] mt-1.5 shrink-0" />
              <div>
                <p className="text-sm font-medium text-[var(--text-secondary)]">第十二章 单元检测</p>
                <p className="text-xs text-[var(--text-tertiary)]">闭卷测试</p>
              </div>
            </div>
          </nav>

          <div className="p-4 border-t border-[var(--bg-subtle)]">
            <div className="flex items-center gap-3">
              <div className="w-9 h-9 rounded-full bg-[var(--bg-subtle)] flex items-center justify-center text-sm font-bold text-[var(--text-secondary)]">
                小
              </div>
              <div>
                <p className="text-sm font-medium text-[var(--text-primary)]">小明</p>
                <p className="text-xs text-[var(--text-tertiary)]">专注学习中…</p>
              </div>
            </div>
          </div>
        </aside>

        {/* 主内容区 */}
        <main className="flex-1 min-w-0 flex flex-col">
          {/* Header */}
          <header className="flex items-center justify-between gap-4 px-6 py-4 shrink-0">
            <div className="flex items-center gap-3 min-w-0">
              <span className="text-sm text-[var(--text-secondary)] truncate">
                {breadcrumb ? `${breadcrumb} · ` : ''}{data.lessonName}
              </span>
            </div>
            <div className="flex items-center gap-4 shrink-0">
              <span className="text-sm font-medium text-[var(--text-tertiary)] tabular-nums">
                {page + 1} / {total}
              </span>
              <button
                onClick={() => setMode(mode === 'student-day' ? 'student-night' : 'student-day')}
                className="flex items-center gap-1.5 px-3 py-1.5 rounded-[var(--radius-pill)] text-xs text-[var(--text-secondary)] bg-[var(--bg-subtle)] hover:bg-[var(--bg-card)] transition-colors"
                title="切换护眼模式"
              >
                {mode === 'student-day' ? <SunIcon /> : <MoonIcon />}
                <span>护眼</span>
              </button>
            </div>
          </header>

          {/* Card area */}
          <div className="flex-1 min-h-0 flex flex-col items-center px-4 md:px-8 py-2">
            <AnimatePresence mode="wait">
              <motion.div
                key={card.id}
                initial={{ opacity: 0, y: 12 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -12 }}
                transition={{ duration: 0.2 }}
                className="relative flex-1 min-h-0 w-full flex flex-col"
                style={{ maxWidth: 'var(--learn-card-max-w)' }}
              >
                {/* 小节标题（H1） */}
                <div className="shrink-0 mb-3">
                  <h1
                    className="font-bold"
                    style={{
                      fontSize: 'var(--fs-learn-h1)',
                      lineHeight: '1.75rem',
                      color: 'var(--learn-heading-1)',
                    }}
                  >
                    {data.lessonName} 知识自学与概念理解
                  </h1>
                </div>

                {/* 白卡 */}
                <div
                  className="flex-1 min-h-0 flex flex-col rounded-xl overflow-hidden"
                  style={{ backgroundColor: 'var(--learn-card-bg)' }}
                >
                  {/* 卡片内容 — 垂直居中 */}
                  <div className="flex-1 min-h-0 flex flex-col justify-center px-8 md:px-12 py-6 overflow-y-auto">
                    <div className="mx-auto" style={{ width: '100%', maxWidth: 'var(--learn-prose-w)' }}>
                      {/* 卡片类型标签 */}
                      <div className="flex items-center gap-2 mb-3">
                        <span className="text-xs font-bold px-2 py-0.5 rounded bg-[var(--brand-100)] text-[var(--brand-600)]">
                          {CARD_TYPE_LABEL[card.cardType] ?? card.cardType}
                        </span>
                        {card.textbookPage && (
                          <span className="text-xs text-[var(--text-tertiary)]">{card.textbookPage}</span>
                        )}
                      </div>

                      {/* 卡片内容标题（H2） */}
                      {card.title && (
                        <h2
                          className="font-black leading-snug mb-4"
                          style={{
                            fontSize: 'var(--fs-learn-h2)',
                            color: 'var(--learn-heading-2)',
                          }}
                        >
                          {card.title}
                        </h2>
                      )}

                      {/* Markdown body */}
                      <div className="learn-prose">
                        <ReactMarkdown
                          remarkPlugins={[remarkMath, remarkGfm]}
                          rehypePlugins={[rehypeKatex]}
                          components={{
                            img: ({ src, alt }) => (
                              <img
                                src={src ? resolveAsset(src) : ''}
                                alt={alt ?? ''}
                                className="block mx-auto my-4 max-w-full h-auto rounded-lg"
                                onError={(e) => { (e.currentTarget as HTMLImageElement).style.display = 'none'; }}
                              />
                            ),
                          }}
                        >
                          {card.content}
                        </ReactMarkdown>
                      </div>
                    </div>
                  </div>

                  {/* 悬浮答疑按钮 */}
                  <button
                    onClick={() => navigate('/student/ai-discuss', { state: { cardId: card.id, lessonId } })}
                    className="absolute right-6 bottom-20 w-14 h-14 rounded-full bg-[var(--brand-500)] text-white shadow-lg flex items-center justify-center hover:bg-[var(--brand-600)] transition-colors z-10"
                    title="思辨答疑"
                  >
                    <ChatIcon />
                  </button>
                </div>
              </motion.div>
            </AnimatePresence>
          </div>

          {/* 底部操作栏 */}
          <footer className="shrink-0 flex items-center justify-between gap-4 px-6 md:px-8 py-4">
            <button
              onClick={() => setPage(p => Math.max(0, p - 1))}
              disabled={page <= 0}
              className="px-5 py-2.5 rounded-[var(--radius-button)] text-[var(--text-secondary)] font-medium disabled:opacity-40 disabled:cursor-not-allowed hover:bg-[var(--bg-subtle)] transition-colors"
            >
              上一页
            </button>

            {page < total - 1 ? (
              <button
                onClick={() => setPage(p => Math.min(total - 1, p + 1))}
                className="px-5 py-2.5 rounded-[var(--radius-button)] bg-[var(--brand-500)] text-white font-medium hover:bg-[var(--brand-600)] transition-colors"
              >
                下一页
              </button>
            ) : (
              <button
                onClick={() => navigate('/student/homework', { state: { lessonId } })}
                className="px-5 py-2.5 rounded-[var(--radius-button)] bg-[var(--brand-500)] text-white font-medium hover:bg-[var(--brand-600)] transition-colors"
              >
                开始作业
              </button>
            )}
          </footer>
        </main>
      </div>
    </div>
  );
}
