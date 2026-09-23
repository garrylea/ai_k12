import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Banner, Button, PageHeader } from '@/components/base';
import { getRemediationOverview, getTrainingErrorBook, type RemediationOverview } from '@/services/api';

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

/** 薄弱点图谱：节点连线。 */
const GraphIcon = ({ className = 'w-8 h-8' }: { className?: string }) => (
  <svg
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.5"
    strokeLinecap="round"
    strokeLinejoin="round"
    className={className}
  >
    <circle cx="12" cy="5" r="2.5" />
    <circle cx="5" cy="18" r="2.5" />
    <circle cx="19" cy="18" r="2.5" />
    <path d="M10.8 7.2 6.2 15.8" />
    <path d="M13.2 7.2 17.8 15.8" />
  </svg>
);

/**
 * 训练四卡选择页（PRD §6.3 三类训练 + 薄弱点图谱）：选完学科后的落地页，
 * 专项/考试/错题三个并列入口，卡片语言复刻入口选择页（style.md §2.7）。
 * 错题卡是唯一「有状态」的入口——实时拉未清零错题数（失败/载入中显示「--」，
 * 不阻塞；0 显示「暂无未清零错题」，仍可点入看空列表）。
 */
export default function TrainingHomePage() {
  const navigate = useNavigate();
  // null = 载入中/失败（显示「--」），不阻塞三卡导航
  const [unclearedCount, setUnclearedCount] = useState<number | null>(null);
  // 相似题专项练习：null = 载入中/失败（不显示提示条）
  const [remediation, setRemediation] = useState<RemediationOverview | null>(null);
  const [remediationDismissed, setRemediationDismissed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    getRemediationOverview()
      .then((overview) => {
        if (!cancelled) setRemediation(overview);
      })
      .catch(() => {
        // 失败静默，不阻塞三卡页
      });
    return () => {
      cancelled = true;
    };
  }, []);

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

  // 待完成题数 = 总题数 - 已答对。差值 0 时不显示提示条：套题全对正常会被删除，
  // 但数据管线按卷 purge 可能留下 0 题的 active 套题，此处兜底避免「待完成 0 题」的荒谬文案。
  const remediationPending = remediation ? remediation.itemCount - remediation.correctCount : 0;
  const showRemediation = remediation?.active === true && !remediationDismissed && remediationPending > 0;

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

        {/* 待完成相似题专项练习（可关闭；用 warning 橘底，info 的蓝是家长端 brand 色） */}
        {showRemediation && remediation && (
          <div className="mt-6">
            <Banner
              type="warning"
              title={`相似题专项练习待完成：${remediationPending} 题 / ${remediation.groupCount} 组`}
              description="考试与专项的错题已按考点配好相似题，逐题作答，答对清零"
              onClose={() => setRemediationDismissed(true)}
              action={
                <Button
                  type="button"
                  variant="primary"
                  size="sm"
                  onClick={() => navigate('/student/training/remediation/run')}
                >
                  开始练习
                </Button>
              }
            />
          </div>
        )}

        {/*
          四卡排成 2×2（两行两列），**不要改成 `lg:grid-cols-4` 一排四个**：
          这是头脑风暴定稿的形状（`.superpowers/brainstorm/<批次>/content/entry-placement.html`
          里的「A · 第 4 张卡」选项——专项/考试在上、错题/薄弱点图谱在下），
          也是本页从三卡改四卡时用户确认过的样子。改成一排四个会让卡片被压扁。
        */}
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-6 mt-12">
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

          {/* 薄弱点图谱（第 4 张卡，2026-09-23）：纯导航，无状态徽标 */}
          <button
            onClick={() => navigate('/student/training/weak-points')}
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
            aria-label="进入薄弱点图谱"
          >
            <div
              className="w-20 h-20 rounded-2xl flex items-center justify-center text-white shadow-sm"
              style={{
                background: 'linear-gradient(to top right, #FF6B35, #FFB25A)',
              }}
              aria-hidden="true"
            >
              <GraphIcon />
            </div>
            <span className="text-3xl font-black tracking-tight text-[var(--text-primary)]">
              薄弱点图谱
            </span>
          </button>
        </div>
      </div>
    </div>
  );
}
