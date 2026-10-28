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

/** 含义：镜/心意（线性 SVG）。 */
const MeaningIcon = ({ className = 'w-8 h-8' }: { className?: string }) => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5"
    strokeLinecap="round" strokeLinejoin="round" className={className}>
    <path d="M12 20.5s-7-4.35-7-9.5a4 4 0 0 1 7-2.6 4 4 0 0 1 7 2.6c0 5.15-7 9.5-7 9.5Z" />
    <path d="M9 11h6" />
  </svg>
);

/** 真题考试：试卷 + 计时（线性 SVG）。 */
const ExamIcon = ({ className = 'w-8 h-8' }: { className?: string }) => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5"
    strokeLinecap="round" strokeLinejoin="round" className={className}>
    <path d="M5 3h11a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2Z" />
    <path d="M7 8h6M7 12h4" />
    <circle cx="15.5" cy="16.5" r="3" />
    <path d="M15.5 15v1.7l1.2.8" />
  </svg>
);

/** 专项练习：靶心（线性 SVG）。 */
const TargetIcon = ({ className = 'w-8 h-8' }: { className?: string }) => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5"
    strokeLinecap="round" strokeLinejoin="round" className={className}>
    <circle cx="12" cy="12" r="8.5" />
    <circle cx="12" cy="12" r="4.5" />
    <circle cx="12" cy="12" r="1" />
  </svg>
);

/** 错题练习：带叉的清单（线性 SVG）。 */
const ErrorIcon = ({ className = 'w-8 h-8' }: { className?: string }) => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5"
    strokeLinecap="round" strokeLinejoin="round" className={className}>
    <path d="M8 4h8v3H8Z" />
    <path d="M6 5H5a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V7a2 2 0 0 0-2-2h-1" />
    <path d="M9 13l2 2 4-4.5" />
  </svg>
);

interface TrainingCard {
  key: string;
  title: string;
  subtitle: string;
  ariaLabel: string;
  path: string;
  icon: typeof ScrollIcon;
  tone: 'brand' | 'blue';
}

/** 语文训练六卡：三个古诗文专项 + 真题考试 / 专项练习 / 错题练习（2026-10-28）。 */
const CARDS: TrainingCard[] = [
  { key: 'dictation', title: '古诗文默写', subtitle: '整篇默写 · 自动判对错', ariaLabel: '进入古诗文默写', path: '/student/training/chinese/dictation', icon: ScrollIcon, tone: 'brand' },
  { key: 'interpretation', title: '古诗文解释', subtitle: '重点字词 · 逐句翻译', ariaLabel: '进入古诗文解释', path: '/student/training/chinese/interpretation', icon: AnnotateIcon, tone: 'blue' },
  { key: 'meaning', title: '古诗含义', subtitle: '深层含义 · 作者情感', ariaLabel: '进入古诗含义', path: '/student/training/chinese/meaning', icon: MeaningIcon, tone: 'brand' },
  { key: 'exam', title: '真题考试', subtitle: '限时整卷 · 交卷看得分', ariaLabel: '进入语文真题考试', path: '/student/training/exam?subjectId=2', icon: ExamIcon, tone: 'blue' },
  { key: 'targeted', title: '专项练习', subtitle: '按知识点 · 自选题量', ariaLabel: '进入语文专项练习', path: '/student/training/targeted?subjectId=2', icon: TargetIcon, tone: 'brand' },
  { key: 'errors', title: '错题练习', subtitle: '语文错题 · 答对清零', ariaLabel: '进入语文错题练习', path: '/student/training/errors?subjectId=2', icon: ErrorIcon, tone: 'blue' },
];

const TONE_GRADIENT: Record<TrainingCard['tone'], string> = {
  brand: 'linear-gradient(to top right, #FF6B35, #FFB25A)',
  blue: 'linear-gradient(to top right, #3B82F6, #7CB3FF)',
};

const CARD_CLASS =
  'h-56 rounded-3xl bg-white p-7 flex flex-col items-center justify-center gap-3 transition-all duration-300';

/**
 * 语文训练页：六张卡并列（古诗文三专项 + 真题考试 / 专项练习 / 错题练习）。
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
      <div className="w-full max-w-5xl px-4 sm:px-8">
        <PageHeader
          to="/student/training"
          caption="返回选学科"
          title="语文 · 训练"
          titleClassName="text-4xl font-extrabold"
        />

        <div className="grid grid-cols-1 md:grid-cols-3 gap-6 mt-10">
          {CARDS.map((card) => {
            const Icon = card.icon;
            return (
              <button
                key={card.key}
                onClick={() => navigate(card.path)}
                className={`${CARD_CLASS} hover:-translate-y-1 focus:outline-none focus:ring-4 focus:ring-[var(--brand-500)]/20`}
                style={{ border: '1px solid rgba(226, 232, 240, 0.8)', boxShadow: 'var(--shadow-card)' }}
                onMouseEnter={(e) => { e.currentTarget.style.boxShadow = 'var(--shadow-elevated)'; }}
                onMouseLeave={(e) => { e.currentTarget.style.boxShadow = 'var(--shadow-card)'; }}
                aria-label={card.ariaLabel}
              >
                <div
                  className="w-20 h-20 rounded-2xl flex items-center justify-center text-white shadow-sm"
                  style={{ background: TONE_GRADIENT[card.tone] }}
                  aria-hidden="true"
                >
                  <Icon />
                </div>
                <span className="text-2xl font-black tracking-tight text-[var(--text-primary)]">{card.title}</span>
                <span className="text-sm text-[var(--text-secondary)]">{card.subtitle}</span>
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
}
