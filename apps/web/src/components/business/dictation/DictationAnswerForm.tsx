import { useState } from 'react';
import HandwritingInputModal from '../handwriting/HandwritingInputModal';

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

const FIELD_TITLE: Record<Field, string> = {
  author: '手写输入：作者',
  dynasty: '手写输入：朝代',
  body: '手写输入：正文',
};

const FIELD_BORDER = { border: '1px solid rgba(226, 232, 240, 0.8)' } as const;

/** 三字段作答（作者 / 朝代 / 正文）——设计 spec §3 决策 5；每字段带手写入口（spec 2026-10-08 §4.3）。 */
export default function DictationAnswerForm({ value, onChange, disabled = false }: Props) {
  const shortInputClass =
    'w-full h-12 px-4 rounded-xl bg-white text-[var(--text-primary)] outline-none focus:ring-2 focus:ring-[var(--brand-500)]/30 disabled:opacity-70';
  const [padField, setPadField] = useState<Field | null>(null);

  const padButton = (field: Field) => (
    <button
      type="button"
      onClick={() => setPadField(field)}
      disabled={disabled}
      className="self-start rounded-[var(--radius-button)] bg-[var(--bg-subtle)] px-3 py-1 text-xs font-bold text-[var(--text-primary)] disabled:opacity-50"
    >
      手写
    </button>
  );

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
          {padButton('author')}
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
          {padButton('dynasty')}
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
        {padButton('body')}
      </label>

      <HandwritingInputModal
        open={padField !== null}
        title={padField ? FIELD_TITLE[padField] : ''}
        onConfirm={(v) => {
          if (padField) onChange({ ...value, [padField]: v });
          setPadField(null);
        }}
        onClose={() => setPadField(null)}
      />
    </div>
  );
}
