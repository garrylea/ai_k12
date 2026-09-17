import { useState } from 'react';
import type { MeaningSentenceItem } from '@/services/api';
import type { MeaningAnswerPayload } from './types';

interface Props {
  sentence: MeaningSentenceItem;
  onSubmit: (payload: MeaningAnswerPayload) => void;
}

/**
 * 当前这一句的作答区。三个输入区：重点字词（该句没有则整行不渲染）、
 * 本句深层含义、作者情感。
 *
 * 父组件用 `key={sentence.index}` 挂载 —— 换句时状态自然重置，不用 useEffect 清。
 */
export function AnswerBlock({ sentence, onSubmit }: Props) {
  const [terms, setTerms] = useState<Record<string, string>>({});
  const [meaning, setMeaning] = useState('');
  const [emotion, setEmotion] = useState('');
  const empty = meaning.trim() === '' && emotion.trim() === ''
    && sentence.terms.every((t) => (terms[t.term] ?? '').trim() === '');

  return (
    <div
      className="rounded-2xl bg-white p-5"
      style={{ border: '1px solid rgba(226, 232, 240, 0.8)' }}
    >
      <p className="text-lg leading-relaxed text-[var(--text-primary)]">{sentence.text}</p>

      {sentence.terms.length > 0 && (
        <div className="mt-4">
          <p className="text-sm font-bold text-[var(--text-primary)]">重点字词</p>
          <div className="mt-2 flex flex-wrap gap-3">
            {sentence.terms.map((t) => (
              <label key={t.term} className="flex items-center gap-2">
                <span className="text-sm text-[var(--text-secondary)]">〔{t.term}〕</span>
                <input
                  aria-label={`${t.term} 释义`}
                  value={terms[t.term] ?? ''}
                  onChange={(e) => setTerms((prev) => ({ ...prev, [t.term]: e.target.value }))}
                  className="h-9 w-40 rounded-xl px-3 text-sm"
                  style={{ border: '1px solid rgba(226, 232, 240, 0.8)' }}
                />
              </label>
            ))}
          </div>
        </div>
      )}

      <div className="mt-4">
        <p className="text-sm font-bold text-[var(--text-primary)]">本句深层含义</p>
        <textarea
          aria-label="本句深层含义"
          value={meaning}
          onChange={(e) => setMeaning(e.target.value)}
          rows={3}
          className="mt-2 w-full rounded-xl p-3 text-sm"
          style={{ border: '1px solid rgba(226, 232, 240, 0.8)' }}
        />
      </div>

      <div className="mt-4">
        <p className="text-sm font-bold text-[var(--text-primary)]">作者情感</p>
        <textarea
          aria-label="作者情感"
          value={emotion}
          onChange={(e) => setEmotion(e.target.value)}
          rows={2}
          className="mt-2 w-full rounded-xl p-3 text-sm"
          style={{ border: '1px solid rgba(226, 232, 240, 0.8)' }}
        />
      </div>

      <button
        onClick={() => onSubmit({
          terms: sentence.terms.map((t) => ({ term: t.term, answer: terms[t.term] ?? '' })),
          meaning,
          emotion,
        })}
        disabled={empty}
        className="mt-5 w-full h-12 rounded-2xl text-white font-bold transition-opacity disabled:opacity-50"
        style={{ backgroundColor: 'var(--brand-500)' }}
      >
        提交
      </button>
    </div>
  );
}
