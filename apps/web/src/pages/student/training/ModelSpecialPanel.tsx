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
  const groups = new Map<string, TrainingModelSpecial[]>();
  for (const s of specials) {
    const list = groups.get(s.categoryName) ?? [];
    list.push(s);
    groups.set(s.categoryName, list);
  }
  const currentKey = `${special.category}::${special.model}`;
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
      <label className="flex flex-col gap-1.5">
        <span className="text-xs font-medium text-[var(--learn-text-secondary)]">模型</span>
        <select
          aria-label="模型"
          value={currentKey}
          onChange={(e) => {
            const next = specials.find(
              (s) => `${s.category}::${s.model}` === e.target.value,
            );
            if (next) onSelectModel(next);
          }}
          className="h-10 px-3 rounded-[var(--radius-button)] border border-[var(--learn-card-border)] bg-[var(--learn-card-bg)] text-[var(--learn-text-primary)] text-sm focus:outline-none focus:ring-2 focus:ring-[var(--brand-100)]"
        >
          {Array.from(groups.entries()).map(([categoryName, models]) => (
            <optgroup key={categoryName} label={categoryName}>
              {models.map((s) => (
                <option key={`${s.category}::${s.model}`} value={`${s.category}::${s.model}`}>
                  {s.modelName}
                </option>
              ))}
            </optgroup>
          ))}
        </select>
      </label>

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
