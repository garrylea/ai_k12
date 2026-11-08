import { useState } from 'react';
import type { FreeformCandidate, FreeformFigure } from '@/services/api';

/**
 * 状态 B · 选题（spec §8.4）。
 *
 * - 默认选中第一道题；配图默认预选该题的 `figureUrls`，可多选；
 * - 切题把题干 / 配图 / 学科一起重置为该题的建议值；
 * - 确认时按「勾选结果」重整题干 Markdown：未勾选的图连 Markdown 一起删掉，
 *   勾选但题干里没有的图追加到末尾；figureUrls 按配图展示顺序返回；
 * - 学科按识别建议预选（math=1 / physics=4 / chemistry=5），满分默认 10、限 1–100。
 */

interface Props {
  candidates: FreeformCandidate[];
  figures: FreeformFigure[];
  onBack: () => void;
  onConfirm: (input: {
    content: string;
    figureUrls: string[];
    subjectId: number;
    maxScore: number;
  }) => void;
}

const SUBJECTS: [number, string][] = [
  [1, '数学'],
  [4, '物理'],
  [5, '化学'],
];

export function SolveCandidatePicker({ candidates, figures, onBack, onConfirm }: Props) {
  const [selectedId, setSelectedId] = useState(candidates[0]?.id ?? '');
  const selected = candidates.find((c) => c.id === selectedId) ?? candidates[0];
  const [checked, setChecked] = useState<Set<string>>(new Set(selected?.figureUrls ?? []));
  const [content, setContent] = useState(selected?.content ?? '');
  const [editing, setEditing] = useState(false);
  const [subjectId, setSubjectId] = useState(subjectIdOf(selected?.suggestedSubject));
  const [maxScore, setMaxScore] = useState(10);

  const pick = (c: FreeformCandidate) => {
    setSelectedId(c.id);
    setChecked(new Set(c.figureUrls));
    setContent(c.content);
    setSubjectId(subjectIdOf(c.suggestedSubject));
  };

  const confirm = () => {
    let out = content;
    for (const f of figures) {
      if (checked.has(f.url)) {
        if (!out.includes(f.url)) out += `\n\n![配图](${f.url})`;
      } else {
        out = out.replace(
          new RegExp(`!\\[[^\\]]*\\]\\(${escapeRegExp(f.url)}\\)`, 'g'),
          '',
        );
      }
    }
    onConfirm({
      content: out.trim(),
      figureUrls: figures.filter((f) => checked.has(f.url)).map((f) => f.url),
      subjectId,
      maxScore,
    });
  };

  return (
    <div className="w-full max-w-4xl">
      <h2 className="text-xl font-bold mb-4">识别到 {candidates.length} 道题</h2>
      <div className="grid gap-3">
        {candidates.map((c) => (
          <label
            key={c.id}
            className={`rounded-xl border p-3 cursor-pointer ${
              c.id === selectedId
                ? 'border-[#FF6B00] bg-[#FFF7F2]'
                : 'border-[#E5E5E5]'
            }`}
          >
            <input
              type="radio"
              checked={c.id === selectedId}
              onChange={() => pick(c)}
              className="sr-only"
            />
            <div className="font-medium mb-1">第 {c.no || '?'} 题</div>
            <div className="text-sm text-[#86868B] line-clamp-3">
              {stripMdImages(c.content).slice(0, 120)}
            </div>
          </label>
        ))}
      </div>

      <div className="mt-4">
        <div className="text-sm font-medium mb-2">配图（多选）</div>
        <div className="flex flex-wrap gap-3">
          {figures.map((f) => (
            <label key={f.url} className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={checked.has(f.url)}
                onChange={(e) => {
                  setChecked((prev) => {
                    const next = new Set(prev);
                    if (e.target.checked) next.add(f.url);
                    else next.delete(f.url);
                    return next;
                  });
                }}
                aria-label={f.name}
              />
              <img
                src={f.url}
                alt={f.name}
                className="w-12 h-12 object-cover rounded border border-[#E5E5E5]"
              />
            </label>
          ))}
        </div>
      </div>

      <div className="mt-4 flex flex-wrap items-end gap-4">
        <div>
          <div className="text-sm font-medium mb-1">学科</div>
          <div className="flex gap-2">
            {SUBJECTS.map(([id, label]) => (
              <button
                key={id}
                type="button"
                onClick={() => setSubjectId(id)}
                aria-pressed={subjectId === id}
                className={`px-3 h-9 rounded-lg text-sm ${
                  subjectId === id
                    ? 'bg-[#FF6B00] text-white'
                    : 'bg-[#F5F5F7] text-[#1D1D1F]'
                }`}
              >
                {label}
              </button>
            ))}
          </div>
        </div>
        <label className="text-sm">
          满分
          <input
            type="number"
            min={1}
            max={100}
            value={maxScore}
            onChange={(e) => setMaxScore(Number(e.target.value))}
            className="ml-2 w-20 h-9 rounded-lg border border-[#E5E5E5] px-2"
          />
        </label>
        <button
          type="button"
          onClick={() => setEditing((v) => !v)}
          className="h-9 px-3 rounded-lg border border-[#E5E5E5] text-sm"
        >
          {editing ? '完成编辑' : '编辑题干'}
        </button>
      </div>

      {editing && (
        <div className="mt-3">
          <textarea
            value={content}
            onChange={(e) => setContent(e.target.value)}
            rows={6}
            aria-label="题干"
            className="w-full rounded-lg border border-[#E5E5E5] p-3 text-sm font-mono"
          />
          <button
            type="button"
            onClick={() => setContent(selected?.content ?? '')}
            className="mt-1 text-xs underline text-[#86868B]"
          >
            恢复识别结果
          </button>
        </div>
      )}

      <div className="mt-5 flex justify-between">
        <button
          type="button"
          onClick={onBack}
          className="h-10 px-4 rounded-lg border border-[#E5E5E5] text-sm"
        >
          返回重新上传
        </button>
        <button
          type="button"
          onClick={confirm}
          disabled={!content.trim() || maxScore < 1 || maxScore > 100}
          className="h-10 px-5 rounded-lg bg-[#FF6B00] text-white text-sm disabled:opacity-50"
        >
          开始作答
        </button>
      </div>
    </div>
  );
}

function subjectIdOf(subject: FreeformCandidate['suggestedSubject'] | undefined): number {
  if (subject === 'physics') return 4;
  if (subject === 'chemistry') return 5;
  return 1;
}

function stripMdImages(md: string): string {
  return md.replace(/!\[[^\]]*\]\([^)]*\)/g, '').replace(/\s+/g, ' ').trim();
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
