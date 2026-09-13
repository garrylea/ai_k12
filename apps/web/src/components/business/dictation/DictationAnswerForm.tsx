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

const FIELD_BORDER = { border: '1px solid rgba(226, 232, 240, 0.8)' } as const;

/** 三字段作答（作者 / 朝代 / 正文）——设计 spec §3 决策 5。 */
export default function DictationAnswerForm({ value, onChange, disabled = false }: Props) {
  const shortInputClass =
    'w-full h-12 px-4 rounded-xl bg-white text-[var(--text-primary)] outline-none focus:ring-2 focus:ring-[var(--brand-500)]/30 disabled:opacity-70';

  return (
    <div className="flex flex-col gap-5">
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-5">
        <label className="flex flex-col gap-2">
          <span className="text-sm font-bold text-[var(--text-primary)]">作者</span>
          <input
            className={shortInputClass}
            style={FIELD_BORDER}
            value={value.author}
            disabled={disabled}
            onChange={(e) => onChange({ ...value, author: e.target.value })}
            placeholder="例如：范仲淹"
          />
        </label>
        <label className="flex flex-col gap-2">
          <span className="text-sm font-bold text-[var(--text-primary)]">朝代</span>
          <input
            className={shortInputClass}
            style={FIELD_BORDER}
            value={value.dynasty}
            disabled={disabled}
            onChange={(e) => onChange({ ...value, dynasty: e.target.value })}
            placeholder="例如：宋"
          />
        </label>
      </div>

      <label className="flex flex-col gap-2">
        <span className="text-sm font-bold text-[var(--text-primary)]">正文</span>
        <textarea
          className="w-full min-h-[220px] p-4 rounded-xl bg-white text-[var(--text-primary)] leading-loose outline-none focus:ring-2 focus:ring-[var(--brand-500)]/30 disabled:opacity-70"
          style={FIELD_BORDER}
          value={value.body}
          disabled={disabled}
          onChange={(e) => onChange({ ...value, body: e.target.value })}
          placeholder="默写整篇正文（标点与空格不计）"
        />
      </label>
    </div>
  );
}
