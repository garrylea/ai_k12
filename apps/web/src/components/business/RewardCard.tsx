import { Card, Tag, Button } from '@/components/base';

interface RewardCardProps {
  type: 'virtual' | 'material';
  title: string;
  description?: string;
  iconText: string;
  status?: 'pending' | 'redeemed' | 'used';
  onRedeem?: () => void;
}

export function RewardCard({ type, title, description, iconText, status = 'pending', onRedeem }: RewardCardProps) {
  if (type === 'virtual') {
    return (
      <Card elevation="raised" className="text-center space-y-2">
        <div className="mx-auto w-16 h-16 rounded-full bg-[var(--brand-100)] flex items-center justify-center text-[var(--brand-600)] text-xl font-bold">
          {iconText}
        </div>
        <div className="text-base font-semibold text-[var(--text-primary)]">{title}</div>
        {description && <div className="text-xs text-[var(--text-tertiary)]">{description}</div>}
      </Card>
    );
  }

  const statusMap = {
    pending: { label: '家长待兑现', variant: 'medium' as const },
    redeemed: { label: '已兑现', variant: 'easy' as const },
    used: { label: '已使用', variant: 'neutral' as const },
  };

  return (
    <Card elevation="raised" className="space-y-3">
      <div className="flex items-start gap-3">
        <div className="w-14 h-14 rounded-[var(--radius-button)] bg-[var(--brand-100)] flex items-center justify-center text-[var(--brand-600)] text-lg font-bold shrink-0">
          {iconText}
        </div>
        <div className="flex-1">
          <div className="text-base font-semibold text-[var(--text-primary)]">{title}</div>
          {description && <div className="text-sm text-[var(--text-secondary)] mt-1">{description}</div>}
        </div>
        <Tag variant={statusMap[status].variant}>{statusMap[status].label}</Tag>
      </div>
      {status === 'pending' && onRedeem && (
        <Button variant="primary" size="sm" onClick={onRedeem} className="w-full">
          家长确认已兑现
        </Button>
      )}
    </Card>
  );
}
