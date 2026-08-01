import { useNavigate } from 'react-router-dom';

const BookIcon = ({ className = 'w-8 h-8' }: { className?: string }) => (
  <svg
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.5"
    strokeLinecap="round"
    strokeLinejoin="round"
    className={className}
  >
    <path d="M10 2v8l3-3 3 3V2" />
    <path d="M4 19.5v-15A2.5 2.5 0 0 1 6.5 2H19a1 1 0 0 1 1 1v18a1 1 0 0 1-1 1H6.5a1 1 0 0 1 0-5H20" />
  </svg>
);

export default function EntrySelectPage() {
  const navigate = useNavigate();

  return (
    <div
      data-theme="student-day"
      className="min-h-screen flex items-center justify-center p-4"
      style={{ backgroundColor: 'var(--bg-page)' }}
    >
      <div className="w-full max-w-3xl px-4 sm:px-8">
        <div className="flex flex-col sm:flex-row gap-8 justify-center items-stretch">
          {/* 学习：可选主入口 */}
          <button
            onClick={() => navigate('/student/subjects')}
            className="flex-1 max-w-[17.5rem] min-w-[12.5rem] h-64 rounded-3xl bg-white flex flex-col items-center justify-center gap-5 transition-all duration-300 hover:-translate-y-1 focus:outline-none focus:ring-4 focus:ring-[var(--brand-500)]/20"
            style={{
              border: '1px solid rgba(226, 232, 240, 0.8)',
              boxShadow: 'var(--shadow-card)',
            }}
            aria-label="进入学习"
          >
            <div
              className="w-20 h-20 rounded-2xl flex items-center justify-center text-white shadow-sm"
              style={{
                background: 'linear-gradient(to top right, #FF6B35, #FF8C61)',
              }}
              aria-hidden="true"
            >
              <BookIcon />
            </div>
            <span className="text-3xl font-black tracking-tight text-[var(--text-primary)]">
              学习
            </span>
          </button>

          {/* 答疑：锁定入口 */}
          <div
            className="flex-1 max-w-[17.5rem] min-w-[12.5rem] h-64 rounded-3xl bg-white flex flex-col items-center justify-center gap-5 cursor-not-allowed"
            style={{
              border: '1px solid rgb(241, 245, 249)',
              backgroundColor: 'rgba(248, 250, 252, 0.3)',
              opacity: 0.55,
            }}
            aria-label="答疑暂未开放"
          >
            <div
              className="w-20 h-20 rounded-2xl flex items-center justify-center text-slate-500 shadow-sm"
              style={{
                background: 'linear-gradient(to top right, #f1f5f9, #e2e8f0)',
              }}
              aria-hidden="true"
            >
              <BookIcon />
            </div>
            <span className="text-3xl font-black tracking-tight text-slate-500">
              答疑
            </span>
          </div>
        </div>
      </div>
    </div>
  );
}
