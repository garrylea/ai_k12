import { useNavigate } from 'react-router-dom';
import { motion, useReducedMotion } from 'framer-motion';
import { LogoutButton } from '@/components/base';

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

const HelpCircleIcon = ({ className = 'w-8 h-8' }: { className?: string }) => (
  <svg
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.5"
    strokeLinecap="round"
    strokeLinejoin="round"
    className={className}
  >
    <circle cx="12" cy="12" r="10" />
    <path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3" />
    <line x1="12" y1="17" x2="12.01" y2="17" />
  </svg>
);

export default function EntrySelectPage() {
  const navigate = useNavigate();
  const reduceMotion = useReducedMotion();
  const username = localStorage.getItem('username') ?? '同学';

  return (
    <div
      data-theme="student-day"
      className="min-h-screen flex flex-col items-center justify-between p-6 md:p-10"
      style={{ backgroundColor: 'var(--bg-page)' }}
    >
      {/* 1. 顶栏：左侧品牌标识 / 右侧用户信息 + 退出；下边框为分割线 */}
      <header className="w-full max-w-5xl flex items-center justify-between border-b border-slate-200/80 pb-4">
        <div className="flex items-center gap-3">
          <div
            className="w-10 h-10 rounded-xl flex items-center justify-center text-[var(--brand-500)]"
            style={{ backgroundColor: 'var(--brand-100)' }}
            aria-hidden="true"
          >
            <BookIcon className="w-6 h-6" />
          </div>
          <h1 className="text-lg font-bold tracking-tight text-[var(--text-primary)]">
            K12 智学系统
          </h1>
        </div>

        <LogoutButton username={username} />
      </header>

      {/* 2. 中部：双入口大卡（两卡视觉一致，靠文字「学习/答疑」区分） */}
      <main className="w-full max-w-3xl my-auto py-10 flex flex-col items-center">
        <div className="grid grid-cols-1 md:grid-cols-2 gap-8 w-full">
          {/* 学习：主入口 */}
          <motion.button
            initial={reduceMotion ? false : { opacity: 0, y: 12 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.25, ease: 'easeOut' }}
            whileHover={reduceMotion ? undefined : { y: -4 }}
            onClick={() => navigate('/student/subjects')}
            className="h-64 rounded-3xl bg-white flex flex-col items-center justify-center gap-5 transition-shadow duration-300 focus:outline-none focus:ring-4 focus:ring-[var(--brand-500)]/20"
            style={{
              border: '1px solid rgba(226, 232, 240, 0.8)',
              boxShadow: 'var(--shadow-card)',
            }}
            onMouseEnter={(e) => {
              e.currentTarget.style.boxShadow = 'var(--shadow-elevated)';
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.boxShadow = 'var(--shadow-card)';
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
          </motion.button>

          {/* 答疑：辅入口（蓝色徽章，与主线橘红区分） */}
          <motion.button
            initial={reduceMotion ? false : { opacity: 0, y: 12 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.25, ease: 'easeOut', delay: 0.08 }}
            whileHover={reduceMotion ? undefined : { y: -4 }}
            onClick={() => navigate('/student/auxiliary')}
            className="h-64 rounded-3xl bg-white flex flex-col items-center justify-center gap-5 transition-shadow duration-300 focus:outline-none focus:ring-4 focus:ring-blue-500/20"
            style={{
              border: '1px solid rgba(226, 232, 240, 0.8)',
              boxShadow: 'var(--shadow-card)',
            }}
            onMouseEnter={(e) => {
              e.currentTarget.style.boxShadow = 'var(--shadow-elevated)';
              e.currentTarget.style.borderColor = 'rgba(59, 130, 246, 0.4)';
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.boxShadow = 'var(--shadow-card)';
              e.currentTarget.style.borderColor = 'rgba(226, 232, 240, 0.8)';
            }}
            aria-label="进入答疑"
          >
            <div
              className="w-20 h-20 rounded-2xl flex items-center justify-center text-white shadow-sm"
              style={{
                background: 'linear-gradient(to top right, #2563EB, #6366F1)',
              }}
              aria-hidden="true"
            >
              <HelpCircleIcon />
            </div>
            <span className="text-3xl font-black tracking-tight text-[var(--text-primary)]">
              答疑
            </span>
          </motion.button>
        </div>
      </main>

      {/* 3. 底部脚注 */}
      <footer className="w-full max-w-5xl text-center pt-4">
        <p className="text-xs text-[var(--text-tertiary)]">
          K12 智学系统 · 保护心流，助您独立掌控学习进度
        </p>
      </footer>
    </div>
  );
}
