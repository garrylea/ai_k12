import { useNavigate } from 'react-router-dom';
import clsx from 'clsx';
import { Card } from '@/components/base';
import { Subject } from '@/types';

interface SubjectConfig {
  key: Subject;
  name: string;
  description: string;
  available: boolean;
  gradient: string;
  iconText: string;
}

const subjects: SubjectConfig[] = [
  {
    key: 'chinese',
    name: '语文',
    description: '阅读 · 写作 · 文学',
    available: false,
    gradient: 'from-[#E55A2B] to-[#C94A1F]',
    iconText: '文',
  },
  {
    key: 'math',
    name: '数学',
    description: '代数 · 几何 · 函数',
    available: true,
    gradient: 'from-[#E55A2B] to-[#C94A1F]',
    iconText: '数',
  },
  {
    key: 'english',
    name: '英语',
    description: '听说 · 读写 · 语法',
    available: false,
    gradient: 'from-[#E55A2B] to-[#C94A1F]',
    iconText: 'EN',
  },
];

export default function SubjectSelectPage() {
  const navigate = useNavigate();

  const handleSelect = (subject: SubjectConfig) => {
    if (!subject.available) return;
    navigate('/student/star-map');
  };

  return (
    <div
      data-theme="student-day"
      className="min-h-screen bg-[var(--bg-base)] p-8"
    >
      <div className="max-w-5xl mx-auto">
        {/* 顶部 */}
        <div className="mb-10">
          <h1
            className="font-bold text-[var(--text-primary)] mb-2"
            style={{ fontSize: 'var(--fs-h1)' }}
          >
            选择学科
          </h1>
          <p
            className="text-[var(--text-secondary)]"
            style={{ fontSize: 'var(--fs-body)' }}
          >
            三年级 · 第一学期 · 人教版
          </p>
        </div>

        {/* 学科卡片网格 */}
        <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
          {subjects.map((subject) => (
            <Card
              key={subject.key}
              elevation="raised"
              interactive={subject.available}
              onClick={() => handleSelect(subject)}
              className={clsx(
                'relative overflow-hidden p-8 cursor-default',
                subject.available && 'cursor-pointer hover:-translate-y-1',
              )}
            >
              {/* 学科图标 */}
              <div
                className={clsx(
                  'w-20 h-20 rounded-[var(--radius-card)] flex items-center justify-center text-white text-3xl font-bold mb-6',
                  'bg-gradient-to-br',
                  subject.gradient,
                  !subject.available && 'opacity-40',
                )}
              >
                {subject.iconText}
              </div>

              {/* 学科名 */}
              <div
                className={clsx(
                  'font-bold mb-2',
                  subject.available ? 'text-[var(--text-primary)]' : 'text-[var(--text-tertiary)]',
                )}
                style={{ fontSize: 'var(--fs-h2)' }}
              >
                {subject.name}
              </div>

              {/* 描述 */}
              <div
                className={clsx(
                  'mb-6',
                  subject.available ? 'text-[var(--text-secondary)]' : 'text-[var(--text-tertiary)]',
                )}
                style={{ fontSize: 'var(--fs-caption)' }}
              >
                {subject.description}
              </div>

              {/* 状态 */}
              {subject.available ? (
                <div className="flex items-center gap-2 text-sm text-[var(--brand-600)] font-medium">
                  <span>进入学习</span>
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M5 12h14M12 5l7 7-7 7" />
                  </svg>
                </div>
              ) : (
                <div className="absolute inset-0 bg-[var(--bg-base)]/60 backdrop-blur-[2px] flex flex-col items-center justify-center gap-2">
                  <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="var(--text-tertiary)" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                    <rect x="3" y="11" width="18" height="11" rx="2" />
                    <path d="M7 11V7a5 5 0 0 1 10 0v4" />
                  </svg>
                  <div className="text-sm text-[var(--text-tertiary)] font-medium">敬请期待</div>
                </div>
              )}
            </Card>
          ))}
        </div>

        {/* 说明 */}
        <div className="mt-12 p-6 bg-[var(--bg-card)] rounded-[var(--radius-card)] shadow-[var(--shadow-card)]">
          <div className="text-sm text-[var(--text-secondary)] leading-relaxed">
            <div className="font-semibold text-[var(--text-primary)] mb-2">关于 MVP 阶段学科范围</div>
            当前版本仅开放数学学科。语文、英语学科将在后续版本中陆续开放。
            我们将通过数学学科的深度体验，验证苏格拉底式 AI 辅导的有效性，再逐步扩展到其他学科。
          </div>
        </div>
      </div>
    </div>
  );
}
