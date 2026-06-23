import { Card, Tag, Button } from '@/components/base';
import { ErrorBookItem } from '@/types';

interface ErrorBookCardProps {
  item: ErrorBookItem;
  onRedo: () => void;
  onSeeAnalysis: () => void;
  onVariant: () => void;
}

const sourceLabelMap = {
  homework: '作业',
  'unit-test': '单元测',
  midterm: '期中',
  final: '期末',
  auxiliary: '辅线',
} as const;

const levelColor = ['#4A9B6E', '#D89844', '#C44A3F', '#A03020', '#7B1F1F'];

export function ErrorBookCard({ item, onRedo, onSeeAnalysis, onVariant }: ErrorBookCardProps) {
  const isAux = item.question.track === 'auxiliary';
  return (
    <Card elevation="raised" className="space-y-3">
      <div className="flex items-center gap-2 flex-wrap">
        <Tag variant={isAux ? 'auxiliary' : 'mainline'}>
          {isAux ? '辅线' : '主线'}
        </Tag>
        <Tag variant="source">来源：{sourceLabelMap[item.question.source]}</Tag>
        <Tag variant={item.question.difficulty}>
          {item.question.difficulty === 'easy' ? '易' : item.question.difficulty === 'medium' ? '中' : '难'}
        </Tag>
        <span
          className="ml-auto inline-flex items-center justify-center w-7 h-7 rounded-full text-white text-xs font-bold"
          style={{ backgroundColor: levelColor[item.level - 1] }}
          title={`错题级别 L${item.level}`}
        >
          L{item.level}
        </span>
      </div>
      <div className="text-[var(--text-primary)] text-base line-clamp-2">
        {item.question.content}
      </div>
      <div className="flex items-center gap-2 flex-wrap">
        {item.question.knowledgePoints.map((kp) => (
          <Tag key={kp} variant="knowledge">{kp}</Tag>
        ))}
      </div>
      <div className="text-xs text-[var(--text-tertiary)]">
        上次错误：{new Date(item.lastErrorTime).toLocaleString('zh-CN')} · 已错 {item.timesErrored} 次
      </div>
      <div className="flex gap-2">
        <Button variant="primary" size="sm" onClick={onRedo}>重做</Button>
        <Button variant="secondary" size="sm" onClick={onSeeAnalysis}>看解析</Button>
        <Button variant="ghost" size="sm" onClick={onVariant}>同类变式</Button>
      </div>
    </Card>
  );
}
