import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { PageHeader } from '@/components/base';
import {
  fetchVocabularyOptions,
  startVocabulary,
  type VocabularyDirection,
  type VocabularyLevelPool,
  type VocabularyOptions,
  type VocabularyOrder,
} from '@/services/api';

/** 背几个词：用户口径是「每天 10-20 个」，取三个预设覆盖区间。 */
const COUNT_OPTIONS = [10, 15, 20];

const ORDER_OPTIONS: Array<{ label: string; value: VocabularyOrder }> = [
  { label: '随机', value: 'random' },
  { label: '字母序', value: 'alpha' },
  { label: '倒序', value: 'alpha_desc' },
  { label: '指定字母开头', value: 'letter' },
];

const DIRECTION_OPTIONS: Array<{ label: string; value: VocabularyDirection }> = [
  { label: '英 → 中', value: 'en2cn' },
  { label: '中 → 英', value: 'cn2en' },
  { label: '看音标写单词', value: 'ph2en' },
  { label: '随机', value: 'random' },
];

const ALPHABET = 'abcdefghijklmnopqrstuvwxyz'.split('');

const PILL_BASE = 'px-5 py-2.5 rounded-full text-sm font-medium transition-colors';
const CARD_BORDER = { border: '1px solid rgba(226, 232, 240, 0.8)' } as const;

/**
 * 背单词配置页。
 *
 * 与语文两个配置页的差别：
 * - 多了「范围/顺序/方向」这类按词库特征出的选项（语文是册次 + 篇数）
 * - 勾「只出熟词僻义」时**方向必须置灰**：三档判题口径（含「答成常见义」那一档）
 *   建立在「题面给单词 + 语境、学生答中文」之上，中→英下这一档失去意义。
 *   后端也会强制改方向，前端置灰只是把这个约束讲清楚。
 */
export default function VocabularyConfigPage() {
  const navigate = useNavigate();
  const [options, setOptions] = useState<VocabularyOptions | null>(null);
  const [levelPool, setLevelPool] = useState<VocabularyLevelPool>('junior');
  const [count, setCount] = useState<number>(10);
  const [order, setOrder] = useState<VocabularyOrder>('random');
  const [letter, setLetter] = useState<string>('a');
  const [direction, setDirection] = useState<VocabularyDirection>('en2cn');
  const [onlyNotLearned, setOnlyNotLearned] = useState(false);
  const [onlyMyWrong, setOnlyMyWrong] = useState(false);
  const [onlyCommonWrong, setOnlyCommonWrong] = useState(false);
  const [onlyExtendedSense, setOnlyExtendedSense] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetchVocabularyOptions()
      .then((res) => { if (!cancelled) setOptions(res); })
      .catch(() => { if (!cancelled) setError('词库信息加载失败，请稍后重试'); });
    return () => { cancelled = true; };
  }, []);

  const handleStart = async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await startVocabulary({
        levelPool,
        count,
        order,
        letter: order === 'letter' ? letter : null,
        direction,
        onlyNotLearned,
        onlyMyWrong,
        onlyCommonWrong,
        onlyExtendedSense,
      });
      if (res.questions.length === 0) {
        setError('当前筛选条件下没有可背的词，换个范围或取消几个筛选试试');
        setLoading(false);
        return;
      }
      sessionStorage.setItem('training:vocabulary', JSON.stringify(res.questions));
      navigate('/student/training/english/vocabulary/run');
    } catch {
      setError('开练失败，请稍后重试');
      setLoading(false);
    }
  };

  const poolCount = options?.pools.find((p) => p.key === levelPool)?.count ?? 0;

  return (
    <div
      data-theme="student-day"
      data-school="junior"
      className="student-theme-container min-h-screen flex flex-col items-center p-4"
      style={{ backgroundColor: 'var(--bg-page)' }}
    >
      <div className="w-full max-w-3xl px-4 sm:px-8 py-10">
        <PageHeader
          to="/student/training"
          caption="返回"
          title="背单词"
          titleClassName="text-4xl font-extrabold"
        />

        {options && (
          <p className="mt-3 text-sm text-[var(--text-secondary)]">
            今日已背 <span className="font-bold text-[var(--text-primary)]">{options.todayAnswered}</span> 个词
          </p>
        )}

        {/* 词库范围 */}
        <section className="mt-10">
          <h2 className="text-lg font-bold text-[var(--text-primary)]">背哪些词</h2>
          <div className="flex flex-wrap gap-3 mt-3">
            {(options?.pools ?? []).map((opt) => {
              const active = levelPool === opt.key;
              return (
                <button
                  key={opt.key}
                  onClick={() => setLevelPool(opt.key)}
                  className={`${PILL_BASE} ${active ? 'text-white' : 'bg-white text-[var(--text-secondary)]'}`}
                  style={active ? { backgroundColor: 'var(--brand-500)' } : CARD_BORDER}
                >
                  {opt.label}
                  <span className={`ml-2 text-xs ${active ? 'opacity-80' : 'opacity-60'}`}>
                    {opt.count} 词
                  </span>
                </button>
              );
            })}
          </div>
        </section>

        {/* 背几个 */}
        <section className="mt-8">
          <h2 className="text-lg font-bold text-[var(--text-primary)]">背几个</h2>
          <div className="flex flex-wrap gap-3 mt-3">
            {COUNT_OPTIONS.map((n) => {
              const active = count === n;
              return (
                <button
                  key={n}
                  onClick={() => setCount(n)}
                  className={`w-20 h-11 rounded-xl text-sm font-medium transition-colors ${
                    active ? 'text-white' : 'bg-white text-[var(--text-secondary)]'
                  }`}
                  style={active ? { backgroundColor: 'var(--brand-500)' } : CARD_BORDER}
                >
                  {n} 个
                </button>
              );
            })}
          </div>
        </section>

        {/* 出题顺序 */}
        <section className="mt-8">
          <h2 className="text-lg font-bold text-[var(--text-primary)]">出题顺序</h2>
          <div className="flex flex-wrap gap-3 mt-3">
            {ORDER_OPTIONS.map((opt) => {
              const active = order === opt.value;
              return (
                <button
                  key={opt.value}
                  onClick={() => setOrder(opt.value)}
                  className={`${PILL_BASE} ${active ? 'text-white' : 'bg-white text-[var(--text-secondary)]'}`}
                  style={active ? { backgroundColor: 'var(--brand-500)' } : CARD_BORDER}
                >
                  {opt.label}
                </button>
              );
            })}
          </div>

          {order === 'letter' && (
            <div className="mt-4 rounded-2xl bg-white p-4" style={CARD_BORDER}>
              <p className="mb-3 text-xs text-[var(--text-secondary)]">
                只出这个字母开头的词（按字母序）
              </p>
              {/* 用 flex-wrap 而非 grid-cols-*：默认 Tailwind 只到 grid-cols-12，
                  写 grid-cols-13 不会报错但也不生效（26 个字母会挤成一列）。 */}
              <div className="flex flex-wrap gap-2">
                {ALPHABET.map((ch) => {
                  const active = letter === ch;
                  return (
                    <button
                      key={ch}
                      onClick={() => setLetter(ch)}
                      aria-label={`字母 ${ch}`}
                      aria-pressed={active}
                      className={`w-9 h-9 rounded-lg text-sm font-medium uppercase transition-colors ${
                        active ? 'text-white' : 'bg-[var(--bg-subtle)] text-[var(--text-secondary)]'
                      }`}
                      style={active ? { backgroundColor: 'var(--brand-500)' } : undefined}
                    >
                      {ch}
                    </button>
                  );
                })}
              </div>
            </div>
          )}
        </section>

        {/* 出题方向 */}
        <section className="mt-8">
          <h2 className="text-lg font-bold text-[var(--text-primary)]">出题方向</h2>
          <div className="flex flex-wrap gap-3 mt-3">
            {DIRECTION_OPTIONS.map((opt) => {
              const active = direction === opt.value;
              const disabled = onlyExtendedSense;
              return (
                <button
                  key={opt.value}
                  onClick={() => setDirection(opt.value)}
                  disabled={disabled}
                  className={`${PILL_BASE} disabled:opacity-40 disabled:cursor-not-allowed ${
                    active ? 'text-white' : 'bg-white text-[var(--text-secondary)]'
                  }`}
                  style={active && !disabled ? { backgroundColor: 'var(--brand-500)' } : CARD_BORDER}
                >
                  {opt.label}
                </button>
              );
            })}
          </div>
          {onlyExtendedSense && (
            <p className="mt-3 text-xs text-[var(--text-secondary)]">
              勾了「只出熟词僻义」时固定为「英 → 中」：僻义题要给出单词和它所在的搭配，
              学生才能判断出那个不常见的意思，这正是中高考阅读完型考它的方式。
            </p>
          )}
        </section>

        {/* 筛选 */}
        <section className="mt-8">
          <h2 className="text-lg font-bold text-[var(--text-primary)]">筛选</h2>
          <div className="mt-3 rounded-2xl bg-white p-4" style={CARD_BORDER}>
            {[
              { label: '只出没背过的', checked: onlyNotLearned, set: setOnlyNotLearned, count: options?.counts.notLearned },
              { label: '我错过的词', checked: onlyMyWrong, set: setOnlyMyWrong, count: options?.counts.myWrong },
              {
                label: '易错词（全平台高频）',
                checked: onlyCommonWrong,
                set: setOnlyCommonWrong,
                count: options?.counts.commonWrong,
              },
              { label: '只出熟词僻义', checked: onlyExtendedSense, set: setOnlyExtendedSense, count: options?.counts.extended },
            ].map((item) => (
              <label
                key={item.label}
                className="flex items-center gap-3 px-1 py-2.5 cursor-pointer hover:bg-[var(--bg-subtle)] rounded-lg"
              >
                <input
                  type="checkbox"
                  checked={item.checked}
                  onChange={(e) => item.set(e.target.checked)}
                  className="w-4 h-4"
                />
                <span className="text-sm text-[var(--text-primary)]">{item.label}</span>
                {item.count != null && (
                  <span className="ml-auto text-xs text-[var(--text-secondary)]">
                    {item.count} 词
                  </span>
                )}
              </label>
            ))}
          </div>
          <p className="mt-3 text-xs text-[var(--text-secondary)]">
            多个筛选同时勾选时取交集；「易错词」按全平台答错次数统计，「我错过的词」只算你自己的。
          </p>
        </section>

        {error && <p className="mt-6 text-sm text-[var(--error)]">{error}</p>}

        <button
          onClick={handleStart}
          disabled={loading || !options}
          className="mt-10 w-full h-14 rounded-2xl text-white text-lg font-bold transition-opacity disabled:opacity-60"
          style={{ backgroundColor: 'var(--brand-500)' }}
        >
          {loading ? '正在抽词…' : `开始背词（${count} 个 · 池内 ${poolCount} 词）`}
        </button>
      </div>
    </div>
  );
}
