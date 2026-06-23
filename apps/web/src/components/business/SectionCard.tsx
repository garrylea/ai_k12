import clsx from 'clsx';
import { Card } from '@/components/base';
import { Section } from '@/types';

interface SectionCardProps {
  section: Section;
  onClick?: () => void;
}

const statusConfig: Record<Section['status'], { dot: string; label: string }> = {
  completed: { dot: 'var(--success)', label: '已完成' },
  current: { dot: 'var(--brand-500)', label: '进行中' },
  locked: { dot: 'var(--text-tertiary)', label: '未解锁' },
};

export function SectionCard({ section, onClick }: SectionCardProps) {
  const cfg = statusConfig[section.status];
  const clickable = section.status !== 'locked';

  return (
    <Card
      elevation="raised"
      interactive={clickable}
      onClick={clickable ? onClick : undefined}
      className={clsx('space-y-3', !clickable && 'opacity-60')}
    >
      <div className="flex items-start justify-between">
        <div className="flex items-center gap-2">
          <span
            className="inline-flex items-center justify-center w-8 h-8 rounded-[var(--radius-button)] text-sm font-semibold"
            style={{
              backgroundColor: section.status === 'current' ? 'var(--brand-100)' : 'var(--bg-subtle)',
              color: section.status === 'current' ? 'var(--brand-600)' : 'var(--text-secondary)',
            }}
          >
            {section.order}
          </span>
          <span className="text-xs text-[var(--text-tertiary)]">{cfg.label}</span>
        </div>
        <span
          className="inline-block w-2 h-2 rounded-full"
          style={{ backgroundColor: cfg.dot }}
          aria-label={cfg.label}
        />
      </div>

      <div className="text-base font-semibold text-[var(--text-primary)] line-clamp-2">
        {section.title}
      </div>

      <div className="flex items-center justify-between text-xs text-[var(--text-tertiary)]">
        <span>{section.knowledgePointCount} 个知识点</span>
        <span>{section.progress}%</span>
      </div>

      {/* 进度条 */}
      <div className="w-full h-1.5 bg-[var(--bg-subtle)] rounded-full overflow-hidden">
        <div
          className="h-full rounded-full transition-all duration-500"
          style={{
            width: `${section.progress}%`,
            backgroundColor: section.status === 'completed' ? 'var(--success)' : 'var(--brand-500)',
          }}
        />
      </div>
    </Card>
  );
}
