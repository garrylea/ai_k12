import { useNavigate } from 'react-router-dom';
import { PageHeader } from '@/components/base';

/** 默写：书卷（线性 SVG）。 */
const ScrollIcon = ({ className = 'w-8 h-8' }: { className?: string }) => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5"
    strokeLinecap="round" strokeLinejoin="round" className={className}>
    <path d="M5 4h11a3 3 0 0 1 3 3v13H8a3 3 0 0 1-3-3Z" />
    <path d="M8 4v13a3 3 0 0 0 3 3" />
    <path d="M11 9h5M11 13h5" />
  </svg>
);

/** 解释：批注（线性 SVG）。 */
const AnnotateIcon = ({ className = 'w-8 h-8' }: { className?: string }) => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5"
    strokeLinecap="round" strokeLinejoin="round" className={className}>
    <path d="M4 5h16M4 10h10M4 15h7" />
    <path d="M14 19l5-5-2-2-5 5v2Z" />
  </svg>
);

const CARD_CLASS =
  'h-64 rounded-3xl bg-white p-8 flex flex-col items-center justify-center gap-4 transition-all duration-300';

/**
 * 语文专项页：两张卡并列，古诗文默写与古诗文解释均已开放。
 * 样式复刻 TrainingHomePage 的卡片语言（style.md §2.7）。
 */
export default function ChineseSpecialPage() {
  const navigate = useNavigate();

  return (
    <div
      data-theme="student-day"
      data-school="junior"
      className="student-theme-container min-h-screen flex flex-col items-center justify-center p-4"
      style={{ backgroundColor: 'var(--bg-page)' }}
    >
      <div className="w-full max-w-4xl px-4 sm:px-8">
        <PageHeader
          to="/student/training"
          caption="返回选学科"
          title="语文 · 专项"
          titleClassName="text-4xl font-extrabold"
        />

        <div className="grid grid-cols-1 md:grid-cols-2 gap-6 mt-12">
          <button
            onClick={() => navigate('/student/training/chinese/dictation')}
            className={`${CARD_CLASS} hover:-translate-y-1 focus:outline-none focus:ring-4 focus:ring-[var(--brand-500)]/20`}
            style={{ border: '1px solid rgba(226, 232, 240, 0.8)', boxShadow: 'var(--shadow-card)' }}
            onMouseEnter={(e) => { e.currentTarget.style.boxShadow = 'var(--shadow-elevated)'; }}
            onMouseLeave={(e) => { e.currentTarget.style.boxShadow = 'var(--shadow-card)'; }}
            aria-label="进入古诗文默写"
          >
            <div
              className="w-20 h-20 rounded-2xl flex items-center justify-center text-white shadow-sm"
              style={{ background: 'linear-gradient(to top right, #FF6B35, #FFB25A)' }}
              aria-hidden="true"
            >
              <ScrollIcon />
            </div>
            <span className="text-3xl font-black tracking-tight text-[var(--text-primary)]">古诗文默写</span>
            <span className="text-sm text-[var(--text-secondary)]">整篇默写 · 自动判对错</span>
          </button>

          <button
            onClick={() => navigate('/student/training/chinese/interpretation')}
            className={`${CARD_CLASS} hover:-translate-y-1 focus:outline-none focus:ring-4 focus:ring-[var(--brand-500)]/20`}
            style={{ border: '1px solid rgba(226, 232, 240, 0.8)', boxShadow: 'var(--shadow-card)' }}
            onMouseEnter={(e) => { e.currentTarget.style.boxShadow = 'var(--shadow-elevated)'; }}
            onMouseLeave={(e) => { e.currentTarget.style.boxShadow = 'var(--shadow-card)'; }}
            aria-label="进入古诗文解释"
          >
            <div
              className="w-20 h-20 rounded-2xl flex items-center justify-center text-white shadow-sm"
              style={{ background: 'linear-gradient(to top right, #3B82F6, #7CB3FF)' }}
              aria-hidden="true"
            >
              <AnnotateIcon />
            </div>
            <span className="text-3xl font-black tracking-tight text-[var(--text-primary)]">古诗文解释</span>
            <span className="text-sm text-[var(--text-secondary)]">重点字词 · 逐句翻译</span>
          </button>
        </div>
      </div>
    </div>
  );
}
