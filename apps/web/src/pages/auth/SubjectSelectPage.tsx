import { useNavigate } from 'react-router-dom';
import { useEffect, useState } from 'react';
import { Subject } from '@/types';
import { fetchSubjects } from '@/services/api';

interface SubjectConfig {
  key: Subject;
  name: string;
  available: boolean;
}

const subjects: SubjectConfig[] = [
  { key: 'chinese', name: '语文', available: false },
  { key: 'math', name: '数学', available: true },
  { key: 'english', name: '英语', available: false },
];

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

export default function SubjectSelectPage() {
  const navigate = useNavigate();
  const [username, setUsername] = useState('同学');
  // Map subject code -> numeric id from the server, so we pass a real subjectId
  // to the star map instead of a hardcoded value.
  const [subjectIdByCode, setSubjectIdByCode] = useState<Record<string, number>>({});

  useEffect(() => {
    const stored = localStorage.getItem('username');
    if (stored) setUsername(stored);
    fetchSubjects()
      .then((list) => {
        const map: Record<string, number> = {};
        for (const s of list) map[s.code] = s.id;
        setSubjectIdByCode(map);
      })
      .catch(() => {
        // leave empty; handleSelect guards against missing id
      });
  }, []);

  const handleSelect = (subject: SubjectConfig) => {
    if (!subject.available) return;
    const subjectId = subjectIdByCode[subject.key];
    if (!subjectId) return; // subjects not loaded yet
    navigate('/student/star-map', { state: { subjectId } });
  };

  return (
    <div
      data-theme="student-day"
      className="min-h-screen flex flex-col items-center justify-center p-4"
      style={{ backgroundColor: 'var(--bg-page)' }}
    >
      <div className="w-full max-w-4xl px-4 sm:px-8 space-y-12">
        <h1 className="text-4xl font-extrabold tracking-tight text-[var(--text-primary)]">
          你好，{username}！
        </h1>

        <div className="grid grid-cols-1 md:grid-cols-3 gap-8">
          {subjects.map((subject) =>
            subject.available ? (
              <button
                key={subject.key}
                onClick={() => handleSelect(subject)}
                className="h-64 rounded-3xl bg-white p-8 flex flex-col items-center justify-center gap-6 transition-all duration-300 hover:-translate-y-1 focus:outline-none focus:ring-4 focus:ring-[var(--brand-500)]/20"
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
                aria-label={`选择${subject.name}`}
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
                  {subject.name}
                </span>
              </button>
            ) : (
              <div
                key={subject.key}
                className="h-64 rounded-3xl bg-white p-8 flex flex-col items-center justify-center gap-6 cursor-not-allowed"
                style={{
                  border: '1px solid rgb(241, 245, 249)',
                  backgroundColor: 'rgba(248, 250, 252, 0.3)',
                  opacity: 0.55,
                }}
                aria-label={`${subject.name}暂未开放`}
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
                  {subject.name}
                </span>
              </div>
            ),
          )}
        </div>
      </div>
    </div>
  );
}
