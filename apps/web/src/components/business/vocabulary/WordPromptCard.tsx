import { useEffect, useRef } from 'react';
import type { VocabularyQuestionItem, WordFamilyResult } from '@/services/api';
import WordFamilyTree from './WordFamilyTree';

interface Props {
  question: VocabularyQuestionItem;
  value: string;
  onChange: (next: string) => void;
  /** 提交并翻到下一个词（不等判定回来） */
  onSubmit: () => void;
  /** 显式「不认识」：服务端记 unanswered，不计对错 */
  onSkip: () => void;
  familyOpen: boolean;
  family: WordFamilyResult | null;
  familyLoading: boolean;
  familyFailed: boolean;
  onToggleFamily: () => void;
}

/**
 * 题面卡：题面 + 作答输入 + 词根族开关。
 *
 * **防泄漏铁律**：`+` 号只在 `promptKind === 'en2cn' && hasFamily` 时渲染。
 * 词根族树里必然包含单词本身（care 是 careful 的族中心），中→英题的答案是英文单词，
 * 点开 `+` 就等于直接把答案递给学生。后端在 cn2en 题上也不会返回 hasFamily，
 * 这里是第二道闸门。
 *
 * 回车即提交（背单词是快节奏过词，不该要求每词都去点按钮）。
 */
export default function WordPromptCard({
  question,
  value,
  onChange,
  onSubmit,
  onSkip,
  familyOpen,
  family,
  familyLoading,
  familyFailed,
  onToggleFamily,
}: Props) {
  const inputRef = useRef<HTMLInputElement>(null);

  // 翻到新题自动聚焦，省掉每词一次点击
  useEffect(() => {
    inputRef.current?.focus();
  }, [question.wordId, question.senseIndex]);

  const showFamilyToggle = question.promptKind === 'en2cn' && question.hasFamily;

  return (
    <div
      className="rounded-2xl bg-white p-5"
      style={{ border: '1px solid rgba(226, 232, 240, 0.8)' }}
      data-testid="word-prompt-card"
    >
      {question.isExtendedSense && (
        <span
          className="inline-block rounded bg-[var(--bg-subtle)] px-2 py-0.5 text-xs text-[var(--warning)]"
          data-testid="extended-badge"
        >
          熟词僻义
        </span>
      )}

      <div className="mt-2 flex items-baseline gap-3">
        <span
          className={
            question.promptKind === 'en2cn'
              ? 'text-3xl font-extrabold text-[var(--brand-500)]'
              : 'text-2xl font-bold text-[var(--text-primary)]'
          }
          data-testid="prompt-text"
        >
          {question.prompt}
        </span>
        {question.phonetic && (
          <span className="text-sm text-[var(--text-secondary)]">{question.phonetic}</span>
        )}
        {showFamilyToggle && (
          <button
            onClick={onToggleFamily}
            aria-label={familyOpen ? '收起词根关系' : '展开词根关系'}
            aria-expanded={familyOpen}
            data-testid="family-toggle"
            className="ml-auto flex h-7 w-7 items-center justify-center rounded-full text-lg font-bold leading-none text-[var(--brand-500)]"
            style={{ border: '1px solid rgba(226, 232, 240, 0.9)' }}
          >
            {familyOpen ? '−' : '+'}
          </button>
        )}
      </div>

      {/* 熟词僻义题的语境搭配：锁定「这题考的是哪个意思」 */}
      {question.context && (
        <p className="mt-2 text-sm text-[var(--text-secondary)]" data-testid="context-line">
          语境：{question.context}
        </p>
      )}

      <p className="mt-3 text-sm text-[var(--text-secondary)]">
        {question.promptKind === 'en2cn' ? '写出它的中文意思' : '写出对应的英文单词'}
      </p>

      <input
        ref={inputRef}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') onSubmit();
        }}
        placeholder={question.promptKind === 'en2cn' ? '中文意思' : '英文单词'}
        data-testid="answer-input"
        className="mt-2 w-full rounded-xl px-4 py-3 text-lg outline-none"
        style={{ border: '1px solid rgba(226, 232, 240, 0.9)' }}
      />

      <div className="mt-4 flex gap-3">
        <button
          onClick={onSubmit}
            data-testid="submit-button"
          className="h-12 flex-1 rounded-xl text-white font-bold transition-opacity"
          style={{ backgroundColor: 'var(--brand-500)' }}
        >
          提交并下一个
        </button>
        <button
          onClick={onSkip}
            data-testid="skip-button"
          className="h-12 rounded-xl px-5 text-sm text-[var(--text-secondary)]"
          style={{ border: '1px solid rgba(226, 232, 240, 0.9)' }}
        >
          不认识
        </button>
      </div>

      {familyOpen && (
        <WordFamilyTree family={family} loading={familyLoading} failed={familyFailed} />
      )}
    </div>
  );
}
