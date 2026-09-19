import { useEffect, useState, useMemo } from 'react';
import { useNavigate, useLocation } from 'react-router-dom';
import { motion, AnimatePresence } from 'framer-motion';
import { fetchStarMap, type SectionData, type StarMapData } from '@/services/api';
import { PageHeader } from '@/components/base';
import { useLearnContextStore } from '@/store/learnContextStore';

// --- Loading skeleton ---
function LoadingSkeleton() {
  return (
    <div className="min-h-screen bg-[#FDFBF7] flex items-center justify-center">
      <div className="space-y-6 animate-pulse">
        <div className="h-10 w-64 bg-slate-200 rounded-lg mx-auto" />
        <div className="h-[30rem] w-[50rem] bg-slate-100 rounded-3xl" />
      </div>
    </div>
  );
}

// --- Error state ---
function ErrorState({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <div className="min-h-screen bg-[#FDFBF7] flex flex-col items-center justify-center gap-4">
      <p className="text-slate-500 text-lg">{message}</p>
      <button onClick={onRetry} className="px-6 py-2.5 bg-[#ff6b35] text-white rounded-xl font-medium hover:bg-[#e85d28] transition-colors">
        重试
      </button>
    </div>
  );
}

// --- Helpers ---
// Split a section title into an optional leading label (chapter/section number
// or a column name) and the concept name. Titles carry a prefix separated by a
// space, e.g. "21.1 一元二次方程" -> {prefix: "21.1", name: "一元二次方程"};
// "阅读与思考 黄金分割数" -> {prefix: "阅读与思考", name: "黄金分割数"}.
// order === 0 is the 章综述 (chapter-intro), shown as a fixed label.
function splitSectionTitle(title: string, order: number): { prefix: string; name: string } {
  if (order === 0) return { prefix: '', name: '章综述' };
  const parts = title.trim().split(/\s+/).filter(Boolean);
  if (parts.length <= 1) return { prefix: '', name: title.trim() };
  return { prefix: parts[0], name: parts.slice(1).join(' ') };
}

// Chapter titles carry the same "第二十一章 一元二次方程" prefix; the bottom bar
// already shows a "第N章" badge, so drop the prefix and keep the concept name.
function chapterDisplayName(title: string): string {
  return splitSectionTitle(title, 1).name;
}

// Insert zero-width break opportunities after Chinese conjunctions so long
// names wrap at a natural boundary (e.g. "实际问题与|一元二次方程") rather than
// at an arbitrary character. Used with word-break: keep-all on the render span.
const BREAK_AFTER = /([与和及且或、])/g;
function insertBreaks(name: string): string {
  return name.replace(BREAK_AFTER, '$1​');
}

// --- Planet types ---
interface PlanetPosition {
  id: string;
  num: string;
  title: string;
  order: number;
  status: 'completed' | 'current' | 'locked';
  progress: number;
  x: number;
  y: number;
  sections: SectionData[];
}

// --- Toast ---
function Toast({ message, onDismiss }: { message: string; onDismiss: () => void }) {
  useEffect(() => {
    const t = setTimeout(onDismiss, 3000);
    return () => clearTimeout(t);
  }, [onDismiss]);

  return (
    <motion.div
      initial={{ opacity: 0, y: 40 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: 40 }}
      className="fixed bottom-8 left-1/2 -translate-x-1/2 z-50 px-5 py-3 bg-rose-900/90 backdrop-blur-sm text-rose-200 rounded-xl text-sm font-medium border border-rose-800/50 shadow-xl"
    >
      {message}
    </motion.div>
  );
}

// --- Icons ---
const LockIcon = () => (
  <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
    <rect x="3" y="11" width="18" height="11" rx="2" />
    <path d="M7 11V7a5 5 0 0 1 10 0v4" />
  </svg>
);

const CheckIcon = () => (
  <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
    <polyline points="20 6 9 17 4 12" />
  </svg>
);

// --- Main Component ---
export default function StarMapPage() {
  const navigate = useNavigate();
  const location = useLocation();
  const [data, setData] = useState<StarMapData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selectedPlanetId, setSelectedPlanetId] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);

  // Identity from login; subject chosen on the subject-select page.
  // The server derives the trusted studentId from the JWT — studentId here is
  // only the URL resource locator and must match the logged-in user.
  const studentId = Number(localStorage.getItem('userId')) || 0;
  const subjectId = (location.state as { subjectId?: number } | null)?.subjectId ?? 0;

  const fetchData = async () => {
    setLoading(true);
    setError(null);
    try {
      if (!studentId || !subjectId) {
        throw new Error('缺少学生或学科信息，请重新从学科选择页进入');
      }
      const result = await fetchStarMap(studentId, subjectId);
      setData(result);
      useLearnContextStore.getState().setContext({
        subjectId,
        subjectName: result.subjectName,
        gradeName: result.gradeName,
        publisher: result.publisher || null,
      });
      const current = result.chapters.find(c => c.status === 'current');
      setSelectedPlanetId(current?.id ?? result.chapters[0]?.id ?? null);
    } catch (err: unknown) {
      setError(err instanceof Error ? (err.message || '加载失败') : '加载失败');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { fetchData(); }, [studentId, subjectId, location.key]);

  const selectedChapter = useMemo(
    () => data?.chapters.find(c => c.id === selectedPlanetId) ?? null,
    [data, selectedPlanetId],
  );

  // Compute planet positions
  const planets = useMemo<PlanetPosition[]>(() => {
    if (!data) return [];
    const chapters = data.chapters;
    const len = chapters.length;
    return chapters.map((ch, i) => {
      // Distribute evenly, slight Y stagger for visual interest
      const t = (i + 1) / (len + 1);
      const x = 8 + t * 84; // 8% to 92%
      const y = 35 + (i % 2 === 0 ? -5 : 10);
      return {
        ...ch,
        num: `第${ch.order}章`,
        x,
        y,
      };
    });
  }, [data]);

  // Build connection lines
  const lines = useMemo(() => {
    const result: { x1: number; y1: number; x2: number; y2: number; color: string; opacity: number; width: number; dash: string }[] = [];
    for (let i = 0; i < planets.length - 1; i++) {
      const a = planets[i];
      const b = planets[i + 1];
      const isActive = a.status === 'current' || (a.status === 'completed' && b.status === 'locked');
      const isCompleted = a.status === 'completed' && b.status === 'completed';
      result.push({
        x1: a.x, y1: a.y, x2: b.x, y2: b.y,
        color: isCompleted ? '#34d399' : isActive ? '#38bdf8' : '#475569',
        opacity: isCompleted ? 0.5 : isActive ? 0.6 : 0.2,
        width: isCompleted || isActive ? 2.5 : 2,
        dash: isActive || isCompleted ? '6 4' : '5 5',
      });
    }
    return result;
  }, [planets]);

  const handleSectionClick = (section: SectionData) => {
    if (section.status === 'locked') {
      setToast(`「${section.title}」尚未解锁，请先按顺序完成前面的学习！`);
      return;
    }
    // Enter the lesson reading page (P2.2). lessonId === section.id.
    navigate('/student/course-detail', {
      state: {
        lessonId: Number(section.id),
        breadcrumb: selectedChapter ? `${selectedChapter.title}` : undefined,
        subjectName: data?.subjectName,
        gradeName: data?.gradeName,
        subjectId,
      },
    });
  };

  const handlePlanetClick = (planet: PlanetPosition) => {
    if (planet.status === 'locked') {
      setToast('该关卡尚未解锁，请先完成前置章节的学习！');
      return;
    }
    setSelectedPlanetId(planet.id);
  };

  if (loading) return <LoadingSkeleton />;
  if (error) return <ErrorState message={error} onRetry={fetchData} />;
  if (!data || planets.length === 0) {
    return <ErrorState message="暂无课程数据" onRetry={fetchData} />;
  }

  return (
    <div className="min-h-screen bg-[#FDFBF7] text-slate-900 flex flex-col justify-between p-6 md:p-12 font-sans relative overflow-hidden">
      {/* Ambient background blurs */}
      <div className="absolute top-0 right-0 w-[28.125rem] h-[28.125rem] bg-[#F59E0B]/5 rounded-full blur-3xl pointer-events-none" />
      <div className="absolute -bottom-40 left-0 w-[25rem] h-[25rem] bg-[#2563EB]/5 rounded-full blur-3xl pointer-events-none" />

      <div className="max-w-6xl w-full mx-auto flex-1 flex flex-col justify-between">
        {/* Header */}
        <PageHeader
          to="/student/subjects"
          caption={data.subjectName}
          title={`${data.gradeName}${data.publisher ? ` · ${data.publisher}` : ''}`}
        />

        {/* Error toast */}
        <AnimatePresence>
          {toast && <Toast message={toast} onDismiss={() => setToast(null)} />}
        </AnimatePresence>

        {/* Galaxy canvas */}
        <main className="flex-1 my-6 flex flex-col items-stretch">
          <div className="w-full bg-[#0c1424] rounded-3xl relative p-6 border border-slate-800 shadow-inner overflow-hidden flex flex-col justify-between min-h-[28.75rem] md:min-h-[32.5rem]">
            {/* Radial gradient overlay */}
            <div className="absolute inset-0 bg-[radial-gradient(circle_at_center,_var(--tw-gradient-stops))] from-slate-900 via-[#0c1424] to-[#060a12] pointer-events-none" />

            {/* SVG connection lines */}
            <svg className="absolute inset-0 w-full h-full pointer-events-none z-0">
              {lines.map((line, i) => (
                <line
                  key={i}
                  x1={`${line.x1}%`}
                  y1={`${line.y1}%`}
                  x2={`${line.x2}%`}
                  y2={`${line.y2}%`}
                  stroke={line.color}
                  strokeWidth={line.width}
                  strokeDasharray={line.dash}
                  opacity={line.opacity}
                  strokeLinecap="round"
                />
              ))}
            </svg>

            {/* Planet nodes */}
            <div className="absolute inset-0 z-10">
              {planets.map((planet) => {
                const isSelected = selectedPlanetId === planet.id;
                const isCompleted = planet.status === 'completed';
                const isLocked = planet.status === 'locked';
                const isCurrent = planet.status === 'current';

                return (
                  <button
                    key={planet.id}
                    onClick={() => handlePlanetClick(planet)}
                    style={{ left: `${planet.x}%`, top: `${planet.y}%` }}
                    className="absolute -translate-x-1/2 -translate-y-1/2 group focus:outline-none"
                  >
                    {/* Glow ring behind node */}
                    <span
                      className={`absolute -inset-6 rounded-full blur-md transition-all opacity-45 ${
                        isCurrent
                          ? 'bg-amber-500 scale-125 animate-pulse'
                          : isSelected
                          ? 'bg-cyan-500 scale-110'
                          : isCompleted
                          ? 'bg-emerald-500/40 hover:scale-105'
                          : 'group-hover:bg-slate-700/20'
                      }`}
                    />

                    {/* Planet circle */}
                    <div
                      className={`rounded-full flex flex-col items-center justify-center border-2 shadow-lg transition-all transform duration-300 relative z-20 ${
                        isCurrent
                          ? 'w-16 h-16 bg-[#162238] border-amber-400 text-amber-300 scale-110 drop-shadow-[0_0_12px_rgba(245,158,11,0.5)]'
                          : isSelected
                          ? 'w-11 h-11 bg-[#1e293b] text-cyan-400 border-cyan-400'
                          : isCompleted
                          ? 'w-10 h-10 bg-[#064e3b] text-emerald-400 border-emerald-400 shadow-[0_0_10px_rgba(52,211,153,0.3)]'
                          : 'w-10 h-10 bg-[#182030] text-slate-600 border-slate-800'
                      }`}
                    >
                      {isLocked ? (
                        <LockIcon />
                      ) : (
                        <span className={`font-mono font-black ${isCurrent ? 'text-xl' : 'text-sm'}`}>
                          {planet.order}
                        </span>
                      )}

                      {isCompleted && (
                        <div className="absolute -bottom-1 -right-1 bg-emerald-500 rounded-full text-white p-0.5 shadow-sm border border-[#064e3b]">
                          <CheckIcon />
                        </div>
                      )}
                    </div>

                    {/* Title badge below */}
                    <div className="absolute pt-2 left-1/2 -translate-x-1/2 whitespace-nowrap pointer-events-none">
                      <div
                        className={`px-2 py-0.5 rounded text-[0.625rem] md:text-[0.6875rem] font-bold shadow transition-colors ${
                          isCurrent
                            ? 'bg-amber-950/90 text-amber-300 border border-amber-500/40'
                            : isSelected
                            ? 'bg-slate-900 text-cyan-400 border border-cyan-500/30'
                            : 'bg-[#151f32]/90 text-slate-400 border border-slate-800'
                        }`}
                      >
                        {planet.title.length > 10 ? planet.title.slice(0, 10) + '…' : planet.title}
                      </div>
                    </div>
                  </button>
                );
              })}
            </div>

            {/* Bottom sub-nav bar */}
            <AnimatePresence mode="wait">
              {selectedChapter && (
                <motion.div
                  key={selectedChapter.id}
                  initial={{ opacity: 0, y: 12 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0, y: 12 }}
                  transition={{ duration: 0.25 }}
                  className="relative z-20 mt-auto bg-slate-950/80 backdrop-blur-md rounded-2xl p-4 border border-slate-800/80 flex flex-col md:flex-row md:items-center justify-between gap-4"
                >
                  <div className="flex-shrink-0">
                    <span className="text-[0.625rem] font-bold tracking-tight bg-slate-800 text-slate-300 px-2 py-0.5 rounded">
                      第{selectedChapter.order}章
                    </span>
                    <h3 className="text-sm font-bold text-slate-200 mt-1">{chapterDisplayName(selectedChapter.title)}</h3>
                  </div>

                  <div className="flex flex-wrap md:flex-nowrap gap-2 items-stretch flex-1 justify-end">
                    {selectedChapter.sections.map((section) => {
                      const isTaskCompleted = section.status === 'completed';
                      const isTaskLocked = section.status === 'locked';
                      const { prefix, name } = splitSectionTitle(section.title, section.order);
                      return (
                        <button
                          key={section.id}
                          onClick={() => handleSectionClick(section)}
                          disabled={isTaskLocked}
                          title={section.title}
                          className={`text-xs px-3 py-2 rounded-xl border flex items-center gap-1.5 transition-all select-none font-medium ${
                            isTaskCompleted
                              ? 'bg-emerald-950/40 border-emerald-900/60 text-emerald-400 hover:bg-emerald-950/60'
                              : isTaskLocked
                              ? 'bg-slate-900/35 border-slate-900 text-slate-600 cursor-not-allowed opacity-35'
                              : 'bg-[#ff7b39] hover:bg-[#e46425] text-white border-transparent shadow shadow-orange-500/30 font-bold animate-pulse'
                          }`}
                        >
                          <span className="flex-shrink-0">
                            {isTaskCompleted ? (
                              <CheckIcon />
                            ) : isTaskLocked ? (
                              <LockIcon />
                            ) : (
                              <span className="block w-1.5 h-1.5 rounded-full bg-white" />
                            )}
                          </span>
                          <span className="flex flex-col items-start leading-tight text-left max-w-[7em]">
                            {prefix && (
                              <span className="text-[0.5625rem] font-normal opacity-70 tracking-tight">{prefix}</span>
                            )}
                            <span className="[word-break:keep-all] [overflow-wrap:anywhere]">
                              {insertBreaks(name)}
                            </span>
                          </span>
                        </button>
                      );
                    })}
                  </div>
                </motion.div>
              )}
            </AnimatePresence>
          </div>
        </main>
      </div>
    </div>
  );
}
