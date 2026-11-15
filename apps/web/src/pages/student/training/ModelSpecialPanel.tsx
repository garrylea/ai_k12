import { Button, Card, Skeleton } from '@/components/base';
import type { PointRuleTier, TrainingModelSpecial } from '@/services/api';
import { tierStatus } from './point-tiers';
import { TierChip } from './TierChip';

export interface ModelSpecialPanelProps {
  specials: TrainingModelSpecial[];
  selectedModel: TrainingModelSpecial | null;
  onSelectModel: (special: TrainingModelSpecial) => void;
  status: 'idle' | 'loading' | 'ok' | 'error';
  error: string | null;
  tiers: PointRuleTier[] | null;
  tiersError: string | null;
  eligibleTiers: PointRuleTier[];
  tierKey: string | null;
  starting: boolean;
  startError: string | null;
  emptyHint: boolean;
  onRetry: () => void;
  onRetryTiers: () => void;
  onSelectTier: (key: string) => void;
  onStart: () => void;
}

function ModelChip({
  label,
  active,
  onClick,
}: {
  label: string;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={
        'h-10 px-4 rounded-full border text-sm font-medium transition-colors ' +
        (active
          ? 'border-[var(--brand-500)] bg-[var(--brand-500)] text-[var(--text-on-brand)]'
          : 'border-[var(--learn-card-border)] bg-[var(--learn-card-bg)] text-[var(--learn-text-secondary)] hover:border-[var(--brand-500)]')
      }
    >
      {label}
    </button>
  );
}

export function ModelSpecialPanel({
  specials, selectedModel, onSelectModel, status, error, tiers, tiersError,
  eligibleTiers, tierKey, starting, startError, emptyHint,
  onRetry, onRetryTiers, onSelectTier, onStart,
}: ModelSpecialPanelProps) {
  if (status === 'idle' || status === 'loading') {
    return (
      <Card className="mt-6 space-y-4 bg-[var(--learn-card-bg)] border border-[var(--learn-card-border)]">
        <Skeleton width="40%" height={18} />
        <Skeleton height={44} />
      </Card>
    );
  }
  if (status === 'error') {
    return (
      <Card className="mt-6 space-y-4 bg-[var(--learn-card-bg)] border border-[var(--learn-card-border)]">
        <p className="text-sm text-[var(--learn-text-secondary)]">
          {error ?? '模型专项加载失败'}
        </p>
        <Button variant="secondary" size="sm" onClick={onRetry}>重试</Button>
      </Card>
    );
  }
  if (!selectedModel) {
    return (
      <Card className="mt-6 space-y-4 bg-[var(--learn-card-bg)] border border-[var(--learn-card-border)]">
        <p className="text-sm text-[var(--learn-text-secondary)]">暂无可用模型。</p>
        <Button variant="primary" size="lg" disabled>
          开始练习
        </Button>
      </Card>
    );
  }

  const special = selectedModel;
  const noTier = special.questionCount >= 3
    ? '家长未开启可用题量档位，暂不能开练。'
    : special.questionCount === 2
      ? '家长未开启 1 或 2 题档位，暂不能开练。'
      : '家长未开启 1 题档位，暂不能开练。';
  const canStart = special.questionCount > 0
    && tierKey != null
    && eligibleTiers.some((t) => t.tierKey === tierKey)
    && !starting;

  return (
    <Card className="mt-6 space-y-6 bg-[var(--learn-card-bg)] border border-[var(--learn-card-border)]">
      <section aria-label="模型选择" className="flex flex-wrap gap-2">
        {specials.map((s) => (
          <ModelChip
            key={`${s.category}:${s.model}`}
            label={s.modelName}
            active={s.category === special.category && s.model === special.model}
            onClick={() => onSelectModel(s)}
          />
        ))}
      </section>

      {special.questionCount === 0 ? (
        <p className="text-sm text-[var(--learn-text-secondary)]">暂无可练题目。</p>
      ) : tiersError ? (
        <div className="flex items-center gap-3">
          <p className="text-sm text-[var(--learn-text-secondary)]">{tiersError}</p>
          <Button variant="secondary" size="sm" onClick={onRetryTiers}>重试</Button>
        </div>
      ) : tiers == null ? (
        <div className="flex flex-wrap gap-2" data-testid="model-tier-skeleton">
          <Skeleton width={72} height={44} rounded />
          <Skeleton width={72} height={44} rounded />
        </div>
      ) : eligibleTiers.length === 0 ? (
        <p className="text-sm text-[var(--learn-text-secondary)]">{noTier}</p>
      ) : (
        <section aria-label="题量选择">
          <span className="text-xs font-medium text-[var(--learn-text-secondary)]">题量</span>
          <div className="mt-2 flex flex-wrap gap-2">
            {eligibleTiers.map((tier) => {
              const { text, capped } = tierStatus(tier);
              return (
                <TierChip
                  key={tier.tierKey}
                  label={tier.tierLabel}
                  points={tier.points}
                  status={text}
                  active={tierKey === tier.tierKey}
                  capped={capped}
                  onClick={() => onSelectTier(tier.tierKey)}
                />
              );
            })}
          </div>
        </section>
      )}

      <section className="flex flex-col gap-3">
        {startError && <p className="text-sm text-[var(--error)]">{startError}</p>}
        <Button
          variant="primary"
          size="lg"
          loading={starting}
          disabled={!canStart}
          onClick={onStart}
        >
          {starting ? '开练中…' : '开始练习'}
        </Button>
        {emptyHint && (
          <p className="text-sm text-[var(--learn-text-secondary)]">
            这个模型暂时没有可练的题。
          </p>
        )}
      </section>
    </Card>
  );
}
