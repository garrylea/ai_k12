import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { PageHeader, PlusMinusIcon } from '@/components/base';
import {
  fetchInterpretationPassages,
  startInterpretation,
  type InterpretationPassageItem,
} from '@/services/api';

/** 篇数档：解释专项每篇逐句判，3 篇已是长会话（与默写的 3/5/8/10 不同）。 */
const COUNT_OPTIONS = [1, 2, 3];

/** 范围档：value 即传给后端的 semester；'全部' 传 null。 */
const RANGE_OPTIONS: Array<{ label: string; value: string | null }> = [
  { label: '全部', value: null },
  { label: '上册', value: '上册' },
  { label: '下册', value: '下册' },
];

const PILL_BASE = 'px-5 py-2.5 rounded-full text-sm font-medium transition-colors';
const CARD_BORDER = { border: '1px solid rgba(226, 232, 240, 0.8)' } as const;

/**
 * 古诗文解释配置页：范围（全部/上册/下册）+ 篇数（1/2/3）+ 可选指定篇目。
 *
 * 与默写配置页的差别只有「篇数档」和「勾选上限 = 篇数」——勾选数超过篇数会让
 * 后端不得不截断，语义含糊（到底是随机还是指定？），所以在 UI 上就挡住。
 */
export default function InterpretationConfigPage() {
  const navigate = useNavigate();
  const [passages, setPassages] = useState<InterpretationPassageItem[]>([]);
  const [range, setRange] = useState<string | null>(null);
  const [count, setCount] = useState<number>(1);
  const [picked, setPicked] = useState<number[]>([]);
  const [listOpen, setListOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetchInterpretationPassages()
      .then((res) => { if (!cancelled) setPassages(res.passages); })
      .catch(() => { if (!cancelled) setError('篇目加载失败，请稍后重试'); });
    return () => { cancelled = true; };
  }, []);

  const visible = useMemo(
    () => (range == null ? passages : passages.filter((p) => p.semester === range)),
    [passages, range],
  );

  const atLimit = picked.length >= count;

  const togglePick = (passageId: number) => {
    setPicked((prev) => {
      if (prev.includes(passageId)) return prev.filter((x) => x !== passageId);
      if (prev.length >= count) return prev;   // 上限即篇数，超了不勾
      return [...prev, passageId];
    });
  };

  const handleStart = async () => {
    setLoading(true);
    setError(null);
    try {
      const usePicked = picked.length > 0;
      const res = await startInterpretation({
        semester: usePicked ? null : range,
        passageIds: usePicked ? picked : null,
        count,
      });
      if (res.passages.length === 0) {
        setError('这个范围内暂时没有可练的篇目');
        setLoading(false);
        return;
      }
      sessionStorage.setItem('training:interpretation', JSON.stringify(res.passages));
      navigate('/student/training/chinese/interpretation/run');
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
          caption="返回"
          title="古诗文解释"
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

        {/* 篇数 */}
        <section className="mt-8">
          <h2 className="text-lg font-bold text-[var(--text-primary)]">练几篇</h2>
          <div className="flex flex-wrap gap-3 mt-3">
            {COUNT_OPTIONS.map((n) => {
              const active = count === n;
              return (
                <button
                  key={n}
                  onClick={() => {
                    setCount(n);
                    // 篇数调小后已勾选可能超额，直接截断（比留着让它静默失效清楚）
                    setPicked((prev) => prev.slice(0, n));
                  }}
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
            <PlusMinusIcon open={listOpen} className="text-[var(--brand-500)]" />
          </button>

          {listOpen && (
            <div className="mt-3 rounded-2xl bg-white p-4" style={CARD_BORDER}>
              {visible.length === 0 ? (
                <p className="text-sm text-[var(--text-secondary)]">该范围内暂无篇目</p>
              ) : (
                <>
                  <p className="mb-2 text-xs text-[var(--text-secondary)]">
                    最多选 {count} 篇（已选 {picked.length} 篇）
                  </p>
                  <ul className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                    {visible.map((p) => {
                      const checked = picked.includes(p.passageId);
                      return (
                        <li key={p.passageId}>
                          <label
                            className={`flex items-center gap-3 px-3 py-2 rounded-xl ${
                              !checked && atLimit
                                ? 'opacity-40 cursor-not-allowed'
                                : 'cursor-pointer hover:bg-[var(--bg-subtle)]'
                            }`}
                          >
                            <input
                              type="checkbox"
                              checked={checked}
                              disabled={!checked && atLimit}
                              onChange={() => togglePick(p.passageId)}
                              className="w-4 h-4"
                            />
                            <span className="text-sm text-[var(--text-primary)]">
                              《{p.workTitle}》
                            </span>
                          </label>
                        </li>
                      );
                    })}
                  </ul>
                </>
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
          {loading
            ? '正在抽题…'
            : picked.length > 0
              ? `开始练习（指定 ${picked.length} 篇）`
              : `开始练习（随机 ${count} 篇）`}
        </button>
      </div>
    </div>
  );
}
