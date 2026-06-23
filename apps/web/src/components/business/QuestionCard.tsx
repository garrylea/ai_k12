import { useState } from 'react';
import { Button, Tag } from '@/components/base';
import { Difficulty } from '@/types';

interface QuestionCardProps {
  questionNumber: number;
  totalQuestions: number;
  difficulty: Difficulty;
  questionContent: string;
  questionType: 'single' | 'multiple' | 'fill' | 'solve';
  options?: string[];
  onSubmit: (answer: string) => void;
  onHint: () => void;
  onAskAI: () => void;
}

const difficultyMap = { easy: '易', medium: '中', hard: '难' } as const;

export function QuestionCard({
  questionNumber,
  totalQuestions,
  difficulty,
  questionContent,
  questionType,
  options = [],
  onSubmit,
  onHint,
  onAskAI,
}: QuestionCardProps) {
  const [answer, setAnswer] = useState('');
  const [selected, setSelected] = useState<string[]>([]);

  const handleSubmit = () => {
    const finalAnswer =
      questionType === 'single' || questionType === 'multiple' ? selected.join(',') : answer;
    if (finalAnswer.trim()) onSubmit(finalAnswer);
  };

  return (
    <div className="flex flex-col h-full bg-[var(--bg-card)] rounded-[var(--radius-card)]">
      {/* 顶部 */}
      <div className="flex items-center justify-between px-6 py-3 border-b border-[var(--bg-subtle)]">
        <span className="text-sm text-[var(--text-secondary)]">
          第 {questionNumber} / {totalQuestions} 题
        </span>
        <Tag variant={difficulty}>{difficultyMap[difficulty]}</Tag>
      </div>

      {/* 题干 */}
      <div className="flex-1 overflow-y-auto p-6">
        <div
          className="text-[var(--text-primary)] text-lg leading-relaxed mb-6"
          dangerouslySetInnerHTML={{ __html: questionContent }}
        />

        {/* 作答区 */}
        {(questionType === 'single' || questionType === 'multiple') && (
          <div className="space-y-3">
            {options.map((opt, i) => {
              const letter = String.fromCharCode(65 + i);
              const isSelected = selected.includes(letter);
              return (
                <button
                  key={i}
                  onClick={() => {
                    if (questionType === 'single') setSelected([letter]);
                    else
                      setSelected((prev) =>
                        isSelected ? prev.filter((x) => x !== letter) : [...prev, letter],
                      );
                  }}
                  className={`w-full flex items-center gap-3 px-4 py-3 rounded-[var(--radius-button)] border-2 transition-all text-left
                    ${
                      isSelected
                        ? 'border-[var(--brand-500)] bg-[var(--brand-100)]'
                        : 'border-[var(--bg-subtle)] hover:border-[var(--brand-400)]'
                    }`}
                >
                  <span
                    className={`w-8 h-8 rounded-full flex items-center justify-center font-semibold
                    ${
                      isSelected
                        ? 'bg-[var(--brand-500)] text-white'
                        : 'bg-[var(--bg-subtle)] text-[var(--text-secondary)]'
                    }`}
                  >
                    {letter}
                  </span>
                  <span className="text-[var(--text-primary)]">{opt}</span>
                </button>
              );
            })}
          </div>
        )}

        {questionType === 'fill' && (
          <input
            value={answer}
            onChange={(e) => setAnswer(e.target.value)}
            placeholder="在此填写答案..."
            className="w-full px-4 py-3 bg-[var(--bg-subtle)] rounded-[var(--radius-button)] outline-none focus:ring-2 focus:ring-[var(--brand-500)] placeholder:text-[var(--text-placeholder)]"
          />
        )}

        {questionType === 'solve' && (
          <textarea
            value={answer}
            onChange={(e) => setAnswer(e.target.value)}
            placeholder="请写出解题过程..."
            rows={6}
            className="w-full px-4 py-3 bg-[var(--bg-subtle)] rounded-[var(--radius-button)] outline-none focus:ring-2 focus:ring-[var(--brand-500)] resize-none placeholder:text-[var(--text-placeholder)]"
          />
        )}
      </div>

      {/* 操作栏 */}
      <div className="flex items-center gap-3 px-6 py-4 border-t border-[var(--bg-subtle)]">
        <Button variant="secondary" size="md" onClick={onHint} className="border-[var(--warning)] text-[var(--warning)]">
          提示
        </Button>
        <Button variant="primary" size="md" onClick={onAskAI}>
          让 AI 讲一讲
        </Button>
        <div className="flex-1" />
        <Button variant="primary" size="lg" onClick={handleSubmit}>
          提交
        </Button>
      </div>
    </div>
  );
}
