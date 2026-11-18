import { Button, Card, Skeleton } from '@/components/base';
import type {
  PointRuleTier,
  TrainingPaperPosition,
  TrainingPaperPositionOption,
  TrainingSemester,
} from '@/services/api';
import { tierStatus } from './point-tiers';
import { TierChip } from './TierChip';

export const SEMESTER_LABELS: Record<TrainingSemester, string> = {
  first: '上学期',
  second: '下学期',
};

export interface PaperPositionPanelProps {
  options: TrainingPaperPositionOption[];
  optionsStatus: 'idle' | 'loading' | 'ok' | 'error';
  optionsError: string | null;
  grade: string | null;
  semester: TrainingSemester | null;
  onSelectGrade: (grade: string) => void;
  onSelectSemester: (semester: TrainingSemester) => void;
  positionsStatus: 'idle' | 'loading' | 'ok' | 'error';
  positionsError: string | null;
  positions: TrainingPaperPosition[];
  typicalQuestionCount: number | null;
  selectedQuestionNo: number | null;
  onSelectQuestionNo: (questionNo: number) => void;
  tiers: PointRuleTier[] | null;
  tiersError: string | null;
  eligibleTiers: PointRuleTier[];
  tierKey: string | null;
  starting: boolean;
  startError: string | null;
  emptyHint: boolean;
  onRetryOptions: () => void;
  onRetryPositions: () => void;
  onRetryTiers: () => void;
  onSelectTier: (key: string) => void;
  onStart: () => void;
}

const selectClassName =
  'h-10 px-3 rounded-[var(--radius-button)] border border-[var(--learn-card-border)] ' +
  'bg-[var(--learn-card-bg)] text-[var(--learn-text-primary)] text-sm ' +
  'focus:outline-none focus:ring-2 focus:ring-[var(--brand-100)]';

export function PaperPositionPanel(props: PaperPositionPanelProps) {
  const {
    options, optionsStatus, optionsError, grade, semester,
    onSelectGrade, onSelectSemester,
    positionsStatus, positionsError, positions, typicalQuestionCount,
    selectedQuestionNo, onSelectQuestionNo,
    tiers, tiersError, eligibleTiers, tierKey,
    starting, startError, emptyHint,
    onRetryOptions, onRetryPositions, onRetryTiers, onSelectTier, onStart,
  } = props;

  if (optionsStatus === 'idle' || optionsStatus === 'loading') {
    return (
      <Card className="mt-6 space-y-4 bg-[var(--learn-card-bg)] border border-[var(--learn-card-border)]">
        <Skeleton width="40%" height={18} />
        <Skeleton height={44} />
      </Card>
    );
  }
  if (optionsStatus === 'error') {
    return (
      <Card className="mt-6 space-y-4 bg-[var(--learn-card-bg)] border border-[var(--learn-card-border)]">
        <p className="text-sm text-[var(--learn-text-secondary)]">
          {optionsError ?? '试卷题号加载失败'}
        </p>
        <Button variant="secondary" size="sm" onClick={onRetryOptions}>重试</Button>
      </Card>
    );
  }
  if (options.length === 0) {
    return (
      <Card className="mt-6 space-y-4 bg-[var(--learn-card-bg)] border border-[var(--learn-card-border)]">
        <p className="text-sm text-[var(--learn-text-secondary)]">暂无可用试卷。</p>
        <Button variant="primary" size="lg" disabled>开始练习</Button>
      </Card>
    );
  }

  const grades = Array.from(new Set(options.map((o) => o.grade)));
  const semesters = options.filter((o) => o.grade === grade);
  const allZero = positions.length === 0
    || positions.every((p) => p.wrongCount + p.untriedCount === 0);
  const canStart = selectedQuestionNo != null
    && tierKey != null
    && eligibleTiers.some((t) => t.tierKey === tierKey)
    && !starting;

  return (
    <Card className="mt-6 space-y-6 bg-[var(--learn-card-bg)] border border-[var(--learn-card-border)]">
      <div className="flex flex-wrap items-end gap-6">
        <label className="flex flex-col gap-1.5">
          <span className="text-xs font-medium text-[var(--learn-text-secondary)]">年级</span>
          <select
            aria-label="年级"
            value={grade ?? ''}
            onChange={(e) => onSelectGrade(e.target.value)}
            className={selectClassName}
          >
            {grades.map((g) => <option key={g} value={g}>{g}</option>)}
          </select>
        </label>
        <label className="flex flex-col gap-1.5">
          <span className="text-xs font-medium text-[var(--learn-text-secondary)]">学期</span>
          <select
            aria-label="学期"
            value={semester ?? ''}
            onChange={(e) => onSelectSemester(e.target.value as TrainingSemester)}
            className={selectClassName}
          >
            {semesters.map((o) => (
              <option key={o.semester} value={o.semester}>{SEMESTER_LABELS[o.semester]}</option>
            ))}
          </select>
        </label>
      </div>

      <section aria-label="题号选择">
        <div className="flex items-baseline gap-2 mb-3">
          <h2 className="text-sm font-semibold text-[var(--learn-text-secondary)]">题号</h2>
          {typicalQuestionCount != null && (
            <span className="text-xs text-[var(--learn-text-tertiary)]">共 {typicalQuestionCount} 题</span>
          )}
        </div>
        {positionsStatus === 'loading' || positionsStatus === 'idle' ? (
          <Skeleton height={96} />
        ) : positionsStatus === 'error' ? (
          <div className="flex items-center gap-4">
            <p className="text-sm text-[var(--learn-text-secondary)]">
              {positionsError ?? '试卷题号加载失败'}
            </p>
            <Button variant="secondary" size="sm" onClick={onRetryPositions}>重试</Button>
          </div>
        ) : allZero ? (
          <p className="text-sm text-[var(--learn-text-secondary)]">该年级学期暂无可练题目。</p>
        ) : (
          <div className="grid grid-cols-7 sm:grid-cols-10 gap-2">
            {positions.map((p) => {
              const available = p.wrongCount + p.untriedCount;
              const disabled = available === 0;
              const active = selectedQuestionNo === p.questionNo;
              return (
                <button
                  key={p.questionNo}
                  type="button"
                  disabled={disabled}
                  aria-pressed={active}
                  aria-label={`第${p.questionNo}题，可练${available}题`}
                  onClick={() => onSelectQuestionNo(p.questionNo)}
                  className={
                    'flex flex-col items-center justify-center gap-0.5 h-14 rounded-[var(--radius-button)] border transition-colors ' +
                    (disabled
                      ? 'cursor-not-allowed border-[var(--learn-card-border)] bg-[var(--bg-base)] text-[var(--learn-text-tertiary)] opacity-70'
                      : active
                        ? 'border-[var(--brand-500)] bg-[var(--brand-100)] text-[var(--learn-text-primary)]'
                        : 'border-[var(--learn-card-border)] bg-[var(--learn-card-bg)] text-[var(--learn-text-primary)] hover:border-[var(--brand-500)]')
                  }
                >
                  <span className="text-sm font-semibold leading-none">{p.questionNo}</span>
                  <span className="text-[10px] leading-none text-[var(--learn-text-tertiary)]">
                    {disabled ? '暂无' : `可练 ${available}`}
                  </span>
                </button>
              );
            })}
          </div>
        )}
      </section>

      {selectedQuestionNo != null && (
        <section aria-label="题量选择">
          <span className="text-xs font-medium text-[var(--learn-text-secondary)]">题量</span>
          {tiersError ? (
            <div className="mt-2 flex items-center gap-3">
              <p className="text-sm text-[var(--learn-text-secondary)]">{tiersError}</p>
              <Button variant="secondary" size="sm" onClick={onRetryTiers}>重试</Button>
            </div>
          ) : tiers == null ? (
            <div className="mt-2 flex flex-wrap gap-2" data-testid="paper-tier-skeleton">
              <Skeleton width={72} height={44} rounded />
              <Skeleton width={72} height={44} rounded />
            </div>
          ) : eligibleTiers.length === 0 ? (
            <p className="mt-2 text-sm text-[var(--learn-text-secondary)]">
              家长未开启可用题量档位，暂不能开练。
            </p>
          ) : (
            <div className="mt-2 flex flex-wrap gap-2">
              {eligibleTiers.map((t) => {
                const { text, capped } = tierStatus(t);
                return (
                  <TierChip
                    key={t.tierKey}
                    label={t.tierLabel}
                    points={t.points}
                    status={text}
                    active={tierKey === t.tierKey}
                    capped={capped}
                    onClick={() => onSelectTier(t.tierKey)}
                  />
                );
              })}
            </div>
          )}
        </section>
      )}

      <section className="flex flex-col gap-3">
        <div className="flex items-center gap-4">
          <Button
            variant="primary"
            size="lg"
            loading={starting}
            disabled={!canStart}
            onClick={onStart}
          >
            {starting ? '开练中…' : '开始练习'}
          </Button>
          {selectedQuestionNo == null && !starting && (
            <span className="text-xs text-[var(--learn-text-tertiary)]">请先选择题号</span>
          )}
        </div>
        {startError && <p className="text-sm text-[var(--error)]">{startError}</p>}
        {emptyHint && (
          <p className="text-sm text-[var(--learn-text-secondary)]">
            该题号暂时没有可练的题。
          </p>
        )}
      </section>
    </Card>
  );
}
