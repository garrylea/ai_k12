import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { PageHeader } from '@/components/base';
import { getTrainingErrorBook } from '@/services/api';

/** id 对应 subjects 表 seed（1=数学），与训练轨各页一致。 */
const MATH_SUBJECT_ID = 1;

/** 专项练习：靶心（线性 SVG）。 */
const TargetIcon = ({ className = 'w-8 h-8' }: { className?: string }) => (
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
    <circle cx="12" cy="12" r="6" />
    <circle cx="12" cy="12" r="2" />
  </svg>
);

/** 真题考试：试卷。 */
const PaperIcon = ({ className = 'w-8 h-8' }: { className?: string }) => (
  <svg
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.5"
    strokeLinecap="round"
    strokeLinejoin="round"
    className={className}
  >
    <path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z" />
    <path d="M14 2v4a2 2 0 0 0 2 2h4" />
    <path d="M16 13H8" />
    <path d="M16 17H8" />
  </svg>
);

/** 错题练习：循环重做。 */
const RedoIcon = ({ className = 'w-8 h-8' }: { className?: string }) => (
  <svg
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.5"
    strokeLinecap="round"
    strokeLinejoin="round"
    className={className}
  >
    <path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8" />
    <path d="M3 3v5h5" />
  </svg>
);

/**
 * 训练三卡选择页（PRD §6.3 三类训练并列）：选完学科后的落地页，
 * 专项/考试/错题三个并列入口，卡片语言复刻入口选择页（style.md §2.7）。
 * 错题卡是唯一「有状态」的入口——实时拉未清零错题数（失败/载入中显示「--」，
 * 不阻塞；0 显示「暂无未清零错题」，仍可点入看空列表）。
 */
export default function TrainingHomePage() {
  const navigate = useNavigate();
  // null = 载入中/失败（显示「--」），不阻塞三卡导航
  const [unclearedCount, setUnclearedCount] = useState<number | null>(null);

  useEffect(() => {
    let cancelled = false;
    getTrainingErrorBook({ subjectId: MATH_SUBJECT_ID })
      .then((entries) => {
        if (!cancelled) setUnclearedCount(entries.length);
      })
      .catch(() => {
        // 失败保持「--」，不阻塞页面
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const errorCountText =
    unclearedCount == null
      ? '未清零 -- 题'
      : unclearedCount === 0
        ? '暂无未清零错题'
        : `未清零 ${unclearedCount} 题`;

  return (
    <div
      data-theme="student-day"
      className="min-h-screen flex flex-col items-center justify-center p-4"
      style={{ backgroundColor: 'var(--bg-page)' }}
    >
      <div className="w-full max-w-4xl px-4 sm:px-8">
        {/* 返回选学科页 + 标题（上下结构，StarMapPage header 同款模式） */}
        <PageHeader
          to="/student/training"
          caption="返回选学科"
          title="数学 · 训练"
          titleClassName="text-4xl font-extrabold"
        />

        <div className="grid grid-cols-1 md:grid-cols-3 gap-6 mt-12">
          {/* 专项练习 */}
          <button
            onClick={() => navigate('/student/training/targeted')}
            className="h-64 rounded-3xl bg-white p-8 flex flex-col items-center justify-center gap-4 transition-all duration-300 hover:-translate-y-1 focus:outline-none focus:ring-4 focus:ring-[var(--brand-500)]/20"
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
            aria-label="进入专项练习"
          >
            <div
              className="w-20 h-20 rounded-2xl flex items-center justify-center text-white shadow-sm"
              style={{
                background: 'linear-gradient(to top right, #FF6B35, #FFB25A)',
              }}
              aria-hidden="true"
            >
              <TargetIcon />
            </div>
            <span className="text-3xl font-black tracking-tight text-[var(--text-primary)]">
              专项练习
            </span>
          </button>

          {/* 真题考试 */}
          <button
            onClick={() => navigate('/student/training/exam')}
            className="h-64 rounded-3xl bg-white p-8 flex flex-col items-center justify-center gap-4 transition-all duration-300 hover:-translate-y-1 focus:outline-none focus:ring-4 focus:ring-[var(--brand-500)]/20"
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
            aria-label="进入真题考试"
          >
            <div
              className="w-20 h-20 rounded-2xl flex items-center justify-center text-white shadow-sm"
              style={{
                background: 'linear-gradient(to top right, #FF6B35, #FFB25A)',
              }}
              aria-hidden="true"
            >
              <PaperIcon />
            </div>
            <span className="text-3xl font-black tracking-tight text-[var(--text-primary)]">
              真题考试
            </span>
          </button>

          {/* 错题练习（唯一带状态徽标的入口） */}
          <button
            onClick={() => navigate('/student/training/errors')}
            className="h-64 rounded-3xl bg-white p-8 flex flex-col items-center justify-center gap-4 transition-all duration-300 hover:-translate-y-1 focus:outline-none focus:ring-4 focus:ring-[var(--brand-500)]/20"
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
            aria-label={`进入错题练习，${errorCountText}`}
          >
            <div
              className="w-20 h-20 rounded-2xl flex items-center justify-center text-white shadow-sm"
              style={{
                background: 'linear-gradient(to top right, #FF6B35, #FFB25A)',
              }}
              aria-hidden="true"
            >
              <RedoIcon />
            </div>
            <span className="text-3xl font-black tracking-tight text-[var(--text-primary)]">
              错题练习
            </span>
            {/* 功能性文案（非装饰副标题）：未清零错题数 */}
            <span className="text-sm text-[var(--text-secondary)]">
              {errorCountText}
            </span>
          </button>
        </div>
      </div>
    </div>
  );
}
