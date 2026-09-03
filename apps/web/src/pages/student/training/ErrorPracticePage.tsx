import { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { BackButton, Button, Card, Skeleton, Tag } from '@/components/base';
import { getKnowledgePoints, getTrainingErrorBook, type TrainingErrorBookEntry } from '@/services/api';
import { useThemeStore } from '@/store/themeStore';

/** id 对应 subjects 表 seed（1=数学），与现有页一致。 */
const MATH_SUBJECT_ID = 1;

/** 题型枚举与后端 questions.type 一致（见 ai-core/types.ts QuestionType）。 */
const TYPE_OPTIONS = [
  { value: '', label: '全部' },
  { value: 'choice', label: '选择' },
  { value: 'fill_blank', label: '填空' },
  { value: 'true_false', label: '判断' },
  { value: 'short_answer', label: '解答' },
  { value: 'proof', label: '证明' },
] as const;

const typeLabelMap: Record<string, string> = {
  choice: '选择',
  fill_blank: '填空',
  true_false: '判断',
  short_answer: '解答',
  proof: '证明',
};

/** level 圆点配色与 ErrorBookCard 一致（L1-L5 绿→深红）。 */
const levelColor = ['#4A9B6E', '#D89844', '#C44A3F', '#A03020', '#7B1F1F'];

const EmptyStateIcon = () => (
  <svg
    className="w-14 h-14 text-[var(--text-tertiary)]"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.5"
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
  >
    <rect x="4" y="3" width="16" height="18" rx="2.5" />
    <path d="M8.5 3v3.5a1.5 1.5 0 0 0 1.5 1.5h4a1.5 1.5 0 0 0 1.5-1.5V3" />
    <path d="M9 12.5l2 2 4-4.5" />
  </svg>
);

const selectClassName =
  'h-10 px-3 rounded-[var(--radius-button)] border border-[var(--bg-subtle)] ' +
  'bg-[var(--bg-card)] text-[var(--text-primary)] text-sm ' +
  'focus:outline-none focus:ring-2 focus:ring-[var(--brand-100)]';

const dateInputClassName =
  'h-10 px-3 rounded-[var(--radius-button)] border border-[var(--bg-subtle)] ' +
  'bg-[var(--bg-card)] text-[var(--text-primary)] text-sm ' +
  'focus:outline-none focus:ring-2 focus:ring-[var(--brand-100)]';

function formatDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

export default function ErrorPracticePage() {
  const navigate = useNavigate();
  const { mode, autoToggleNightMode } = useThemeStore();

  // 沉浸层夜间模式：挂一次 + 每分钟检查（镜像 CourseDetailPage 的用法）
  useEffect(() => {
    autoToggleNightMode();
    const t = setInterval(autoToggleNightMode, 60000);
    return () => clearInterval(t);
  }, [autoToggleNightMode]);

  // 筛选条件
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [type, setType] = useState('');
  const [kpId, setKpId] = useState('');
  // 专项下拉：二级 KP 平铺（label 为「一级名 / 二级名」）
  const [kpOptions, setKpOptions] = useState<Array<{ value: string; label: string }>>([]);

  const [entries, setEntries] = useState<TrainingErrorBookEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  // 已勾选的 errorBookId 集合
  const [selected, setSelected] = useState<Set<number>>(new Set());

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await getTrainingErrorBook({
        subjectId: MATH_SUBJECT_ID,
        from: from || undefined,
        to: to || undefined,
        type: type || undefined,
        kpId: kpId ? Number(kpId) : undefined,
      });
      setEntries(data);
      setSelected(new Set());
    } catch (err) {
      setError(err instanceof Error ? err.message : '加载错题列表失败');
      setEntries([]);
      setSelected(new Set());
    } finally {
      setLoading(false);
    }
  }, [from, to, type, kpId]);

  // mount 时拉默认列表（全部数学错题；仅 mount 一次，筛选由「查询」按钮触发）
  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // mount 时拉 KP 树填专项下拉：只列二级 KP（parentKpId 非空），
  // label 为「一级名 / 二级名」（一级自身是分组概念，不做筛选项）；失败静默（下拉退化为「全部」）。
  useEffect(() => {
    let cancelled = false;
    getKnowledgePoints(MATH_SUBJECT_ID)
      .then((kps) => {
        if (cancelled) return;
        const nameById = new Map(kps.map((k) => [k.id, k.name]));
        const secondLevel = kps
          .filter((k) => k.parentKpId != null)
          .map((k) => ({
            value: String(k.id),
            label: `${nameById.get(k.parentKpId!) ?? '其他'} / ${k.name}`,
          }));
        setKpOptions(secondLevel);
      })
      .catch(() => {
        // KP 拉取失败不阻断错题列表：专项下拉保持「全部」占位
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const toggle = (entry: TrainingErrorBookEntry) => {
    if (entry.questionId == null) return; // 孤儿题禁选
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(entry.errorBookId)) next.delete(entry.errorBookId);
      else next.add(entry.errorBookId);
      return next;
    });
  };

  const selectedCount = useMemo(
    () => entries.filter((e) => selected.has(e.errorBookId)).length,
    [entries, selected],
  );

  const startPractice = () => {
    if (selectedCount === 0) return;
    const chosen = entries.filter((e) => selected.has(e.errorBookId));
    // 题单交给 run 页（读后即删），避免 URL 超长
    sessionStorage.setItem('training:errors', JSON.stringify(chosen));
    navigate('/student/training/errors/run');
  };

  return (
    <div className="student-theme-container" data-theme={mode} data-school="junior">
      <div className="min-h-screen bg-[var(--bg-page)] text-[var(--text-primary)]">
        <div className="mx-auto w-full max-w-[64rem] px-4 sm:px-8 pb-32">
          {/* 顶栏 */}
          <header className="flex items-center gap-4 border-b border-[var(--bg-subtle)] py-5">
            <BackButton to="/student/training" label="返回训练" />
            <h1 className="text-2xl font-bold tracking-tight">错题练习</h1>
          </header>

          {/* 筛选区 */}
          <Card className="mt-6">
            <div className="flex flex-wrap items-end gap-4">
              <label className="flex flex-col gap-1.5">
                <span className="text-xs font-medium text-[var(--text-secondary)]">错题时间从</span>
                <input
                  type="date"
                  value={from}
                  max={to || undefined}
                  onChange={(e) => setFrom(e.target.value)}
                  className={dateInputClassName}
                  aria-label="错题时间从"
                />
              </label>
              <label className="flex flex-col gap-1.5">
                <span className="text-xs font-medium text-[var(--text-secondary)]">到</span>
                <input
                  type="date"
                  value={to}
                  min={from || undefined}
                  onChange={(e) => setTo(e.target.value)}
                  className={dateInputClassName}
                  aria-label="错题时间到"
                />
              </label>
              <label className="flex flex-col gap-1.5">
                <span className="text-xs font-medium text-[var(--text-secondary)]">题型</span>
                <select
                  value={type}
                  onChange={(e) => setType(e.target.value)}
                  className={selectClassName}
                  aria-label="题型筛选"
                >
                  {TYPE_OPTIONS.map((opt) => (
                    <option key={opt.value} value={opt.value}>{opt.label}</option>
                  ))}
                </select>
              </label>
              <label className="flex flex-col gap-1.5">
                <span className="text-xs font-medium text-[var(--text-secondary)]">专项</span>
                <select
                  value={kpId}
                  onChange={(e) => setKpId(e.target.value)}
                  className={selectClassName}
                  aria-label="专项筛选"
                >
                  <option value="">全部</option>
                  {kpOptions.map((opt) => (
                    <option key={opt.value} value={opt.value}>{opt.label}</option>
                  ))}
                </select>
              </label>
              <Button variant="primary" size="md" loading={loading} onClick={() => void load()}>
                查询
              </Button>
            </div>
          </Card>

          {/* 列表 */}
          <div className="mt-6 space-y-3">
            {loading ? (
              // 加载骨架
              Array.from({ length: 4 }).map((_, i) => (
                <Card key={i} className="space-y-3 py-5">
                  <Skeleton width="30%" height={14} />
                  <Skeleton height={40} />
                  <Skeleton width="20%" height={12} />
                </Card>
              ))
            ) : error ? (
              <div className="flex flex-col items-center gap-4 py-16">
                <p className="text-[var(--text-secondary)]">{error}</p>
                <Button variant="secondary" size="md" onClick={() => void load()}>重试</Button>
              </div>
            ) : entries.length === 0 ? (
              // 空态
              <div className="flex flex-col items-center gap-4 py-16">
                <EmptyStateIcon />
                <p className="text-[var(--text-secondary)]">当前筛选下没有待练错题</p>
              </div>
            ) : (
              entries.map((entry) => {
                const isSelected = selected.has(entry.errorBookId);
                const isOrphan = entry.questionId == null;
                return (
                  <Card
                    key={entry.errorBookId}
                    className={isOrphan ? 'opacity-70' : 'cursor-pointer hover:shadow-[var(--shadow-elevated)]'}
                    onClick={isOrphan ? undefined : () => toggle(entry)}
                  >
                    <div className="flex items-start gap-4">
                      <input
                        type="checkbox"
                        checked={isSelected}
                        disabled={isOrphan}
                        onChange={() => toggle(entry)}
                        onClick={(e) => e.stopPropagation()}
                        aria-label={isOrphan ? '该题未入库，不可选择' : `选择错题 ${entry.errorBookId}`}
                        className="mt-1 w-5 h-5 shrink-0 accent-[var(--brand-500)] cursor-pointer disabled:cursor-not-allowed"
                      />
                      <div className="flex-1 min-w-0 space-y-2">
                        <div className="flex items-center gap-2 flex-wrap">
                          <Tag variant="knowledge">{entry.type ? (typeLabelMap[entry.type] ?? entry.type) : '未分类'}</Tag>
                          {entry.level >= 1 && entry.level <= 5 && (
                            <span
                              className="inline-flex items-center justify-center w-6 h-6 rounded-full text-white text-[10px] font-bold"
                              style={{ backgroundColor: levelColor[entry.level - 1] }}
                              title={`错题级别 L${entry.level}`}
                            >
                              L{entry.level}
                            </span>
                          )}
                          <span className="ml-auto text-xs text-[var(--text-tertiary)]">
                            {formatDate(entry.createdAt)}
                          </span>
                        </div>
                        {/* 题面是 Markdown：用 CSS line-clamp 截断两行，避免 JS 截断破坏语法 */}
                        <div className="text-sm text-[var(--text-primary)] line-clamp-2 whitespace-pre-wrap">
                          {entry.questionText}
                        </div>
                        {isOrphan && (
                          <p className="text-xs text-[var(--text-tertiary)]">
                            该题未入库，暂不支持线上重做
                          </p>
                        )}
                      </div>
                    </div>
                  </Card>
                );
              })
            )}
          </div>
        </div>

        {/* 底部操作栏（固定） */}
        {entries.length > 0 && (
          <div className="fixed bottom-0 left-0 right-0 border-t border-[var(--bg-subtle)] bg-[var(--bg-card)] shadow-[var(--shadow-card)]">
            <div className="mx-auto w-full max-w-[64rem] px-4 sm:px-8 py-4 flex items-center justify-between">
              <span className="text-sm text-[var(--text-secondary)]">
                已选 {selectedCount} / {entries.length} 题
              </span>
              <Button
                variant="primary"
                size="lg"
                disabled={selectedCount === 0}
                onClick={startPractice}
              >
                开始练习（{selectedCount} 题）
              </Button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
