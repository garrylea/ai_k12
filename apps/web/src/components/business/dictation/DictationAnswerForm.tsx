import { useRef, useState } from 'react';
import InlineHandwritingPad from '../handwriting/InlineHandwritingPad';
import { PenIcon } from '../handwriting/icons';

export interface DictationAnswerValue {
  author: string;
  dynasty: string;
  body: string;
}

interface Props {
  value: DictationAnswerValue;
  onChange: (next: DictationAnswerValue) => void;
  /** 提交后锁定输入 */
  disabled?: boolean;
}

type Field = 'author' | 'dynasty' | 'body';

const FIELD_BORDER = { border: '1px solid rgba(226, 232, 240, 0.8)' } as const;

/** 三字段作答（作者 / 朝代 / 正文）——设计 spec §3 决策 5；每字段带手写入口（spec 2026-10-08 §4.3，交互 v2 内嵌式）。 */
export default function DictationAnswerForm({ value, onChange, disabled = false }: Props) {
  const shortInputClass =
    'w-full h-12 px-4 rounded-xl bg-white text-[var(--text-primary)] outline-none focus:ring-2 focus:ring-[var(--brand-500)]/30 disabled:opacity-70';
  const [padField, setPadField] = useState<Field | null>(null);
  // ref 镜像：识别是秒级异步，在途期间学生可能继续键入；onRecognized 触发时必须读
  // valueRef.current（最新值），读渲染闭包里的 value 会把键入内容覆盖丢失。
  const valueRef = useRef(value);
  valueRef.current = value;

  // 手写切换钮（笔形图标）内嵌在输入框内部右侧，只在收起态渲染；展开时靠手写板上的「键盘」图标收起
  const padToggle = (field: Field) =>
    padField === field ? null : (
      <button
        type="button"
        aria-label="切换到手写输入"
        title="切换到手写输入"
        onClick={() => setPadField(field)}
        disabled={disabled}
        className="absolute right-3 text-[var(--text-secondary)] hover:text-[var(--brand-500)] disabled:opacity-50"
      >
        <PenIcon />
      </button>
    );

  return (
    <div className="flex flex-col gap-5">
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-5">
        <label className="flex flex-col gap-2">
          <span className="text-sm font-bold text-[var(--text-primary)]">作者</span>
          <div className="relative">
            <input
              className={shortInputClass + ' pr-12'}
              style={FIELD_BORDER}
              value={value.author}
              disabled={disabled}
              onChange={(e) => onChange({ ...value, author: e.target.value })}
              placeholder="例如：范仲淹"
            />
            <div className="absolute right-3 top-1/2 -translate-y-1/2">{padToggle('author')}</div>
          </div>
        </label>
        <label className="flex flex-col gap-2">
          <span className="text-sm font-bold text-[var(--text-primary)]">朝代</span>
          <div className="relative">
            <input
              className={shortInputClass + ' pr-12'}
              style={FIELD_BORDER}
              value={value.dynasty}
              disabled={disabled}
              onChange={(e) => onChange({ ...value, dynasty: e.target.value })}
              placeholder="例如：宋"
            />
            <div className="absolute right-3 top-1/2 -translate-y-1/2">{padToggle('dynasty')}</div>
          </div>
        </label>
      </div>

      <label className="flex flex-col gap-2">
        <span className="text-sm font-bold text-[var(--text-primary)]">正文</span>
        <div className="relative">
          <textarea
            className="w-full min-h-[220px] p-4 pr-12 rounded-xl bg-white text-[var(--text-primary)] leading-loose outline-none focus:ring-2 focus:ring-[var(--brand-500)]/30 disabled:opacity-70"
            style={FIELD_BORDER}
            value={value.body}
            disabled={disabled}
            onChange={(e) => onChange({ ...value, body: e.target.value })}
            placeholder="默写整篇正文（标点与空格不计）"
          />
          <div className="absolute right-3 top-3">{padToggle('body')}</div>
        </div>
      </label>

      {/* key 随 padField 重挂载：切换字段时墨迹天然清零，不会把上个字段的笔迹识别进新字段 */}
      <InlineHandwritingPad
        key={padField ?? 'none'}
        open={padField !== null}
        disabled={disabled}
        onRecognized={(text) => {
          if (!padField) return;
          const current = valueRef.current;
          if (padField === 'body') {
            const prev = current.body;
            onChange({
              ...current,
              body: prev === '' || prev.endsWith('\n') ? prev + text : prev + '\n' + text,
            });
          } else {
            onChange({ ...current, [padField]: current[padField] + text });
          }
        }}
        onClose={() => setPadField(null)}
      />
    </div>
  );
}
