import { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { BackButton, Button, Card, Modal, Skeleton, Tag } from '@/components/base';
import {
  createExamSession,
  getExamPaperDetail,
  getExamPapers,
  type ExamPaper,
} from '@/services/api';
import { useThemeStore } from '@/store/themeStore';

/** id 对应 subjects 表 seed（1=数学），与现有训练页一致。 */
const MATH_SUBJECT_ID = 1;

/** 时长档（分钟）；推荐时长四舍五入到最近档位。 */
const DURATION_OPTIONS = [60, 90, 120] as const;

const selectClassName =
  'h-10 px-3 rounded-[var(--radius-button)] border border-[var(--bg-subtle)] ' +
  'bg-[var(--bg-card)] text-[var(--text-primary)] text-sm ' +
  'focus:outline-none focus:ring-2 focus:ring-[var(--brand-100)]';

/** 推荐时长 -> 最近的时长档（用于「推荐」徽标与默认选中）。 */
function nearestDuration(recommended: number): number {
  return DURATION_OPTIONS.reduce((best, cur) =>
    Math.abs(cur - recommended) < Math.abs(best - recommended) ? cur : best,
  );
}

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
    <rect x="5" y="3" width="14" height="18" rx="2.5" />
    <path d="M9 7.5h6M9 11.5h6M9 15.5h3.5" />
  </svg>
);

/** 时长档 Chip（单选；推荐档带「推荐」徽标）。 */
function DurationChip({
  minutes,
  active,
  recommended,
  onClick,
}: {
  minutes: number;
  active: boolean;
  recommended: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={
        'h-10 px-4 rounded-full border text-sm font-medium transition-colors inline-flex items-center gap-2 ' +
        (active
          ? 'border-[var(--brand-500)] bg-[var(--brand-500)] text-[var(--text-on-brand)]'
          : 'border-[var(--bg-subtle)] bg-[var(--bg-card)] text-[var(--text-secondary)] hover:border-[var(--brand-500)]')
      }
    >
      {minutes} 分钟
      {recommended && (
        <span
          className={
            'px-1.5 py-0.5 rounded-[var(--radius-pill)] text-[10px] font-semibold leading-none ' +
            (active
              ? 'bg-[var(--bg-card)] text-[var(--brand-600)]'
              : 'bg-[var(--brand-100)] text-[var(--brand-600)]')
          }
        >
          推荐
        </span>
      )}
    </button>
  );
}

/** 时长选择弹层的选中试卷（列表条目 + 详情补全的推荐时长）。 */
interface SelectedPaper {
  id: number;
  title: string;
  questionCount: number;
  durationMinutes: number;
}

export default function ExamListPage() {
  const navigate = useNavigate();
  const { mode, autoToggleNightMode } = useThemeStore();

  // 沉浸层夜间模式：挂一次 + 每分钟检查（镜像 ErrorPracticePage 用法）
  useEffect(() => {
    autoToggleNightMode();
    const t = setInterval(autoToggleNightMode, 60000);
    return () => clearInterval(t);
  }, [autoToggleNightMode]);

  // 筛选条件
  const [year, setYear] = useState('');
  const [district, setDistrict] = useState('');
  const [examType, setExamType] = useState('');

  // 列表数据 + 全量数据（筛选项下拉来源，避免筛选后选项收窄）
  const [papers, setPapers] = useState<ExamPaper[]>([]);
  const [allPapers, setAllPapers] = useState<ExamPaper[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await getExamPapers({
        subjectId: MATH_SUBJECT_ID,
        year: year ? Number(year) : undefined,
        district: district || undefined,
        examType: examType || undefined,
      });
      setPapers(data);
      // 无筛选时同步全量数据（筛选项下拉的来源）
      if (!year && !district && !examType) setAllPapers(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : '加载试卷列表失败');
      setPapers([]);
    } finally {
      setLoading(false);
    }
  }, [year, district, examType]);

  // mount 时拉默认列表（仅一次，筛选由「查询」按钮触发）
  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 筛选下拉选项：从全量数据去重（年份倒序，其余按字典序）
  const yearOptions = useMemo(
    () =>
      [...new Set(allPapers.map((p) => p.year).filter((y): y is number => y != null))].sort(
        (a, b) => b - a,
      ),
    [allPapers],
  );
  const districtOptions = useMemo(
    () => [...new Set(allPapers.map((p) => p.district).filter((d): d is string => d != null))].sort(),
    [allPapers],
  );
  const examTypeOptions = useMemo(
    () => [...new Set(allPapers.map((p) => p.examType).filter((t): t is string => t != null))].sort(),
    [allPapers],
  );

  // 点卡片 -> 拉详情（推荐时长）-> 弹时长选择层
  const [detailLoadingId, setDetailLoadingId] = useState<number | null>(null);
  const [detailError, setDetailError] = useState<string | null>(null);
  const [selectedPaper, setSelectedPaper] = useState<SelectedPaper | null>(null);
  const [duration, setDuration] = useState<number>(DURATION_OPTIONS[0]);

  // 开考状态
  const [starting, setStarting] = useState(false);
  const [startError, setStartError] = useState<string | null>(null);

  const openDurationModal = async (paper: ExamPaper) => {
    if (detailLoadingId != null) return; // 防重：上一个详情未返回前忽略新点击
    setDetailError(null);
    setDetailLoadingId(paper.id);
    try {
      const detail = await getExamPaperDetail(paper.id);
      setSelectedPaper({
        id: paper.id,
        title: paper.title,
        questionCount: paper.questionCount,
        durationMinutes: detail.durationMinutes,
      });
      setDuration(nearestDuration(detail.durationMinutes));
    } catch (err) {
      setDetailError(err instanceof Error ? err.message : '加载试卷详情失败');
    } finally {
      setDetailLoadingId(null);
    }
  };

  const closeDurationModal = () => {
    setSelectedPaper(null);
    setStartError(null);
  };

  const startExam = async () => {
    if (!selectedPaper || starting) return;
    setStarting(true);
    setStartError(null);
    try {
      const session = await createExamSession(selectedPaper.id, duration);
      // 会话交给 run 页（Task 5 实现），避免 URL 传参
      sessionStorage.setItem('exam:session', JSON.stringify(session));
      navigate(`/student/training/exam/run/${session.sessionId}`);
    } catch (err) {
      setStartError(err instanceof Error ? err.message : '开考失败，请重试');
      setStarting(false);
    }
  };

  return (
    <div className="student-theme-container" data-theme={mode} data-school="junior">
      <div className="min-h-screen bg-[var(--bg-page)] text-[var(--text-primary)]">
        <div className="mx-auto w-full max-w-[64rem] px-4 sm:px-8 pb-16">
          {/* 顶栏 */}
          <header className="flex items-center gap-4 border-b border-[var(--bg-subtle)] py-5">
            <BackButton to="/student/training/home" label="返回训练" />
            <h1 className="text-2xl font-bold tracking-tight">考试</h1>
          </header>

          {/* 筛选区 */}
          <Card className="mt-6">
            <div className="flex flex-wrap items-end gap-4">
              <label className="flex flex-col gap-1.5">
                <span className="text-xs font-medium text-[var(--text-secondary)]">年份</span>
                <select
                  value={year}
                  onChange={(e) => setYear(e.target.value)}
                  className={selectClassName}
                  aria-label="年份筛选"
                >
                  <option value="">全部</option>
                  {yearOptions.map((y) => (
                    <option key={y} value={y}>{y}</option>
                  ))}
                </select>
              </label>
              <label className="flex flex-col gap-1.5">
                <span className="text-xs font-medium text-[var(--text-secondary)]">地区</span>
                <select
                  value={district}
                  onChange={(e) => setDistrict(e.target.value)}
                  className={selectClassName}
                  aria-label="地区筛选"
                >
                  <option value="">全部</option>
                  {districtOptions.map((d) => (
                    <option key={d} value={d}>{d}</option>
                  ))}
                </select>
              </label>
              <label className="flex flex-col gap-1.5">
                <span className="text-xs font-medium text-[var(--text-secondary)]">考试类型</span>
                <select
                  value={examType}
                  onChange={(e) => setExamType(e.target.value)}
                  className={selectClassName}
                  aria-label="考试类型筛选"
                >
                  <option value="">全部</option>
                  {examTypeOptions.map((t) => (
                    <option key={t} value={t}>{t}</option>
                  ))}
                </select>
              </label>
              <Button variant="primary" size="md" loading={loading} onClick={() => void load()}>
                查询
              </Button>
            </div>
          </Card>

          {/* 详情拉取失败的提示（点卡片场景） */}
          {detailError && (
            <p className="mt-4 text-sm text-[var(--error)]">{detailError}</p>
          )}

          {/* 试卷列表 */}
          <div className="mt-6 space-y-3">
            {loading ? (
              // 加载骨架
              Array.from({ length: 4 }).map((_, i) => (
                <Card key={i} className="space-y-3 py-5">
                  <Skeleton width="50%" height={14} />
                  <Skeleton width="30%" height={12} />
                </Card>
              ))
            ) : error ? (
              <div className="flex flex-col items-center gap-4 py-16">
                <p className="text-[var(--text-secondary)]">{error}</p>
                <Button variant="secondary" size="md" onClick={() => void load()}>重试</Button>
              </div>
            ) : papers.length === 0 ? (
              // 空态
              <div className="flex flex-col items-center gap-4 py-16">
                <EmptyStateIcon />
                <p className="text-[var(--text-secondary)]">暂无试卷</p>
              </div>
            ) : (
              papers.map((paper) => (
                <Card
                  key={paper.id}
                  className="cursor-pointer hover:shadow-[var(--shadow-elevated)]"
                  onClick={() => void openDurationModal(paper)}
                >
                  <div className="flex items-start justify-between gap-4">
                    <div className="min-w-0 space-y-2">
                      <h2 className="text-base font-medium text-[var(--text-primary)] truncate">
                        {paper.title}
                      </h2>
                      <div className="flex flex-wrap items-center gap-2">
                        {paper.year != null && <Tag variant="neutral">{paper.year} 年</Tag>}
                        {paper.district != null && <Tag variant="source">{paper.district}</Tag>}
                        {paper.examType != null && <Tag variant="knowledge">{paper.examType}</Tag>}
                      </div>
                    </div>
                    <span className="shrink-0 text-sm text-[var(--text-secondary)]">
                      {detailLoadingId === paper.id ? '加载中…' : `${paper.questionCount} 题`}
                    </span>
                  </div>
                </Card>
              ))
            )}
          </div>
        </div>
      </div>

      {/* 时长选择弹层 */}
      <Modal
        open={selectedPaper != null}
        onClose={() => {
          if (!starting) closeDurationModal();
        }}
        title={selectedPaper?.title}
      >
        {selectedPaper && (
          <div className="space-y-5">
            <p className="text-sm text-[var(--text-secondary)]">
              共 {selectedPaper.questionCount} 题 · 推荐时长 {selectedPaper.durationMinutes} 分钟
            </p>
            <div className="flex flex-col gap-1.5">
              <span className="text-xs font-medium text-[var(--text-secondary)]">考试时长</span>
              <div className="flex flex-wrap gap-2">
                {DURATION_OPTIONS.map((d) => (
                  <DurationChip
                    key={d}
                    minutes={d}
                    active={duration === d}
                    recommended={nearestDuration(selectedPaper.durationMinutes) === d}
                    onClick={() => setDuration(d)}
                  />
                ))}
              </div>
            </div>
            {startError && (
              <p className="text-sm text-[var(--error)]">{startError}</p>
            )}
            <div className="flex justify-end gap-3">
              <Button variant="secondary" size="md" disabled={starting} onClick={closeDurationModal}>
                取消
              </Button>
              <Button
                variant="primary"
                size="md"
                loading={starting}
                onClick={() => void startExam()}
              >
                开始考试
              </Button>
            </div>
          </div>
        )}
      </Modal>
    </div>
  );
}
