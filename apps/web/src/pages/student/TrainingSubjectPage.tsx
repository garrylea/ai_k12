import { useNavigate } from 'react-router-dom';
import { BackButton } from '@/components/base';

interface TrainingSubject {
  id: number;
  name: string;
  enabled: boolean;
  desc: string;
}

// id 对应 subjects 表 seed（1=数学, 2=语文, 3=英语）；语文已开放古诗文专项，英语已开放背单词
const SUBJECTS: TrainingSubject[] = [
  { id: 1, name: '数学', enabled: true, desc: '考试 / 专项练习 / 错题练习' },
  { id: 2, name: '语文', enabled: true, desc: '古诗文默写 / 古诗文解释' },
  { id: 3, name: '英语', enabled: true, desc: '背单词' },
];

const DumbbellIcon = ({ className = 'w-8 h-8' }: { className?: string }) => (
  <svg
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.5"
    strokeLinecap="round"
    strokeLinejoin="round"
    className={className}
  >
    <path d="M6.5 6.5v11M17.5 6.5v11M3 9v6M21 9v6M6.5 12h11" />
  </svg>
);

export default function TrainingSubjectPage() {
  const navigate = useNavigate();

  const handleSelect = (subject: TrainingSubject) => {
    if (!subject.enabled) return;
    // 数学 → 三卡选择页（专项/考试/错题，PRD §6.3）；语文 → 语文专项页；英语 → 背单词配置页
    if (subject.id === 2) {
      navigate('/student/training/chinese/special');
      return;
    }
    // 英语目前只有背单词一个功能，故不建二选一的 special 页（语文那页是因为有两个专项），
    // 直接进配置页；以后加了听写/语法再补。
    if (subject.id === 3) {
      navigate('/student/training/english/vocabulary');
      return;
    }
    navigate('/student/training/home');
  };

  return (
    <div
      data-theme="student-day"
      className="min-h-screen flex flex-col items-center justify-center p-4"
      style={{ backgroundColor: 'var(--bg-page)' }}
    >
      <div className="w-full max-w-4xl px-4 sm:px-8">
        {/* 返回按钮与标题，参照 SubjectSelectPage header 模式；
            底边框即分割线（贴近标题、远离下方选科卡片） */}
        <header className="flex items-center gap-4 border-b border-slate-200/80 pb-5">
          <BackButton to="/student/entry" />
          <h1 className="text-4xl font-extrabold tracking-tight text-[var(--text-primary)]">
            选择训练学科
          </h1>
        </header>

        <div className="grid grid-cols-1 md:grid-cols-3 gap-6 mt-12">
          {SUBJECTS.map((subject) =>
            subject.enabled ? (
              <button
                key={subject.id}
                onClick={() => handleSelect(subject)}
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
                aria-label={`选择${subject.name}训练`}
              >
                <div
                  className="w-20 h-20 rounded-2xl flex items-center justify-center text-white shadow-sm"
                  style={{
                    background: 'linear-gradient(to top right, #FF6B35, #FFB25A)',
                  }}
                  aria-hidden="true"
                >
                  <DumbbellIcon />
                </div>
                <span className="text-3xl font-black tracking-tight text-[var(--text-primary)]">
                  {subject.name}
                </span>
                <span className="text-sm text-[var(--text-secondary)]">
                  {subject.desc}
                </span>
              </button>
            ) : (
              <div
                key={subject.id}
                className="relative h-64 rounded-3xl bg-white p-8 flex flex-col items-center justify-center gap-4 opacity-50 cursor-not-allowed"
                style={{
                  border: '1px solid rgb(241, 245, 249)',
                  backgroundColor: 'rgba(248, 250, 252, 0.3)',
                }}
                aria-label={`${subject.name}训练暂未开放`}
              >
                {/* 角标：敬请期待 */}
                <span className="absolute top-4 right-4 px-2.5 py-1 text-xs font-medium rounded-full text-[var(--text-secondary)] bg-[var(--bg-subtle)]">
                  敬请期待
                </span>
                <div
                  className="w-20 h-20 rounded-2xl flex items-center justify-center text-slate-500 shadow-sm"
                  style={{
                    background: 'linear-gradient(to top right, #f1f5f9, #e2e8f0)',
                  }}
                  aria-hidden="true"
                >
                  <DumbbellIcon />
                </div>
                <span className="text-3xl font-black tracking-tight text-slate-500">
                  {subject.name}
                </span>
                <span className="text-sm text-slate-400">{subject.desc}</span>
              </div>
            ),
          )}
        </div>
      </div>
    </div>
  );
}
