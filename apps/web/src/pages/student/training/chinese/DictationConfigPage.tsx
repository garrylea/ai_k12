import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { PageHeader } from '@/components/base';
import { fetchDictationPassages, startDictation, type DictationPassageItem } from '@/services/api';

/** 题量档（与数学专项一致）。 */
const COUNT_OPTIONS = [3, 5, 8, 10];

/** 范围档：value 即传给后端的 semester；'全部' 传 null。 */
const RANGE_OPTIONS: Array<{ label: string; value: string | null }> = [
  { label: '全部', value: null },
  { label: '上册', value: '上册' },
  { label: '下册', value: '下册' },
];

const PILL_BASE = 'px-5 py-2.5 rounded-full text-sm font-medium transition-colors';
const CARD_BORDER = { border: '1px solid rgba(226, 232, 240, 0.8)' } as const;

/**
 * 古诗文默写配置页：范围（上册/下册/全部）+ 题量 + 可选指定篇目。
 * 选题方式为「随机抽 + 可指定篇目」（设计 spec §3 决策 8）。
 */
export default function DictationConfigPage() {
  const navigate = useNavigate();
  const [passages, setPassages] = useState<DictationPassageItem[]>([]);
  const [range, setRange] = useState<string | null>(null);
  const [count, setCount] = useState<number>(5);
  const [picked, setPicked] = useState<number[]>([]);
  const [listOpen, setListOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetchDictationPassages()
      .then((res) => { if (!cancelled) setPassages(res.passages); })
      .catch(() => { if (!cancelled) setError('篇目加载失败，请稍后重试'); });
    return () => { cancelled = true; };
  }, []);

  const visible = useMemo(
    () => (range == null ? passages : passages.filter((p) => p.semester === range)),
    [passages, range],
  );

  const togglePick = (questionId: number) => {
    setPicked((prev) =>
      prev.includes(questionId) ? prev.filter((x) => x !== questionId) : [...prev, questionId],
    );
  };

  const handleStart = async () => {
    setLoading(true);
    setError(null);
    try {
      const usePicked = picked.length > 0;
      const res = await startDictation({
        semester: usePicked ? null : range,
        questionIds: usePicked ? picked : null,
        count,
      });
      if (res.questions.length === 0) {
        setError('这个范围内暂时没有可练的篇目');
        setLoading(false);
        return;
      }
      sessionStorage.setItem('training:dictation', JSON.stringify(res.questions));
      navigate('/student/training/chinese/dictation/run');
    } catch {
      setError('开练失败，请稍后重试');
      setLoading(false);
    }
  };

  return (
    <div
      data-theme="student-day"
      data-school="junior"
      className="student-theme-container min-h-screen flex flex-col items-center p-4"
      style={{ backgroundColor: 'var(--bg-page)' }}
    >
      <div className="w-full max-w-3xl px-4 sm:px-8 py-10">
        <PageHeader
          to="/student/training/chinese/special"
          caption="返回语文专项"
          title="古诗文默写"
          titleClassName="text-4xl font-extrabold"
        />

        {/* 范围 */}
        <section className="mt-10">
          <h2 className="text-lg font-bold text-[var(--text-primary)]">选择范围</h2>
          <div className="flex flex-wrap gap-3 mt-3">
            {RANGE_OPTIONS.map((opt) => {
              const active = range === opt.value;
              return (
                <button
                  key={opt.label}
                  onClick={() => { setRange(opt.value); setPicked([]); }}
                  className={`${PILL_BASE} ${active ? 'text-white' : 'bg-white text-[var(--text-secondary)]'}`}
                  style={active ? { backgroundColor: 'var(--brand-500)' } : CARD_BORDER}
                >
                  {opt.label}
                </button>
              );
            })}
          </div>
        </section>

        {/* 题量 */}
        <section className="mt-8">
          <h2 className="text-lg font-bold text-[var(--text-primary)]">练几篇</h2>
          <div className="flex flex-wrap gap-3 mt-3">
            {COUNT_OPTIONS.map((n) => {
              const active = count === n;
              return (
                <button
                  key={n}
                  onClick={() => setCount(n)}
                  className={`w-16 h-11 rounded-xl text-sm font-medium transition-colors ${
                    active ? 'text-white' : 'bg-white text-[var(--text-secondary)]'
                  }`}
                  style={active ? { backgroundColor: 'var(--brand-500)' } : CARD_BORDER}
                >
                  {n} 篇
                </button>
              );
            })}
          </div>
        </section>

        {/* 指定篇目（可折叠） */}
        <section className="mt-8">
          <button
            onClick={() => setListOpen((v) => !v)}
            className="flex items-center gap-2 text-lg font-bold text-[var(--text-primary)]"
            aria-expanded={listOpen}
          >
            指定篇目（不选则随机抽）
            <span className="text-sm font-normal text-[var(--text-secondary)]">
              {listOpen ? '收起' : '展开'}
            </span>
          </button>

          {listOpen && (
            <div className="mt-3 rounded-2xl bg-white p-4" style={CARD_BORDER}>
              {visible.length === 0 ? (
                <p className="text-sm text-[var(--text-secondary)]">该范围内暂无篇目</p>
              ) : (
                <ul className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                  {visible.map((p) => (
                    <li key={p.questionId}>
                      <label className="flex items-center gap-3 px-3 py-2 rounded-xl cursor-pointer hover:bg-[var(--bg-subtle)]">
                        <input
                          type="checkbox"
                          checked={picked.includes(p.questionId)}
                          onChange={() => togglePick(p.questionId)}
                          className="w-4 h-4"
                        />
                        <span className="text-sm text-[var(--text-primary)]">
                          《{p.workTitle}》
                        </span>
                      </label>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}
        </section>

        {error && <p className="mt-6 text-sm text-[var(--error)]">{error}</p>}

        <button
          onClick={handleStart}
          disabled={loading}
          className="mt-10 w-full h-14 rounded-2xl text-white text-lg font-bold transition-opacity disabled:opacity-60"
          style={{ backgroundColor: 'var(--brand-500)' }}
        >
          {loading ? '正在抽题…' : picked.length > 0 ? `开始默写（指定 ${picked.length} 篇）` : `开始默写（随机 ${count} 篇）`}
        </button>
      </div>
    </div>
  );
}
