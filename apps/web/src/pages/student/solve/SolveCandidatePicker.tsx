import { useEffect, useRef, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import { ImageLightbox } from '@/components/base';
import {
  preprocessMarkdown,
  markdownRemarkPluginsWithBreaks,
  markdownRehypePlugins,
  markdownComponents,
} from '@/components/markdown';
import type { FreeformCandidate, FreeformFigure } from '@/services/api';

/**
 * 状态 B · 选题（spec §8.4）。
 *
 * - 默认选中第一道题；配图默认预选该题的 `figureUrls`，可多选；
 * - 题干是**可编辑字段**：点选中卡片里的题干 → 就地变 Markdown/LaTeX 源码框（自动聚焦），
 *   点框外（blur）或按 Esc → 回到渲染态；渲染的就是「开始作答」交给判题的内容；
 * - 切题把题干 / 配图 / 学科一起重置为该题的建议值（并退出编辑态）；
 * - 确认时按「勾选结果」重整题干 Markdown：未勾选的图连 Markdown 一起删掉，
 *   勾选但题干里没有的图追加到末尾；figureUrls 按配图展示顺序返回；
 *   该结果同时决定「开始作答」是否可点（空则禁用），避免按钮与提交内容错位；
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
  // 就地编辑：点题干框进入源码编辑，点框外（blur）回到渲染。只对「当前选中」的题生效，
  // 点别的卡片 = 换题（渲染态），避免换题时被动进入编辑。
  const [editingId, setEditingId] = useState<string | null>(null);
  const stemRef = useRef<HTMLTextAreaElement | null>(null);
  const [subjectId, setSubjectId] = useState(subjectIdOf(selected?.suggestedSubject));
  const [maxScore, setMaxScore] = useState(10);
  const [previewSrc, setPreviewSrc] = useState<string | null>(null);

  // 进入编辑后自动聚焦并把光标放到末尾：学生点题干就是要改字，不该再点一次。
  useEffect(() => {
    const el = stemRef.current;
    if (!editingId || !el) return;
    el.focus();
    el.setSelectionRange(el.value.length, el.value.length);
  }, [editingId]);

  const pick = (c: FreeformCandidate) => {
    setSelectedId(c.id);
    setChecked(new Set(c.figureUrls));
    setContent(c.content);
    setSubjectId(subjectIdOf(c.suggestedSubject));
    setEditingId(null);
  };

  // 提交内容与 disabled 判定必须同源：只看原始 content 会漏掉「唯一内容是未勾选的图」。
  const out = buildContent(content, figures, checked);
  const canConfirm =
    Boolean(out) &&
    Number.isInteger(maxScore) &&
    maxScore >= 1 &&
    maxScore <= 100;

  const confirm = () => {
    onConfirm({
      content: out,
      figureUrls: figures.filter((f) => checked.has(f.url)).map((f) => f.url),
      subjectId,
      maxScore,
    });
  };

  return (
    <div className="w-full max-w-4xl">
      <h2 className="text-xl font-bold mb-4">识别到 {candidates.length} 道题</h2>
      <div className="grid gap-3">
        {candidates.map((c) => {
          const isSelected = c.id === selectedId;
          const isEditing = editingId === c.id;
          const shown = isSelected ? content : c.content;
          return (
            <div
              key={c.id}
              role="radio"
              aria-checked={isSelected}
              tabIndex={0}
              onClick={() => (isSelected ? setEditingId(c.id) : pick(c))}
              onKeyDown={(e) => {
                if (e.key !== 'Enter' && e.key !== ' ') return;
                e.preventDefault();
                if (isSelected) setEditingId(c.id);
                else pick(c);
              }}
              className={`group rounded-xl border p-3 ${
                isSelected ? 'border-[#FF6B00] bg-[var(--brand-100)]' : 'border-[#E5E5E5] cursor-pointer'
              }`}
            >
              <div className="flex items-center justify-between mb-1">
                <div className="font-medium">第 {c.no || '?'} 题</div>
                {/* 可点即改的提示：只在选中卡片上、悬停时出现一支笔，不占常驻空间 */}
                {isSelected && !isEditing && (
                  <svg
                    aria-hidden="true"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="1.8"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    className="w-4 h-4 text-[var(--brand-500)] opacity-0 group-hover:opacity-100 transition"
                  >
                    <path d="M4 20h4l10-10a2.83 2.83 0 10-4-4L4 16v4z" />
                  </svg>
                )}
              </div>

              {/* 题干 = 可编辑字段：点它变 Markdown/LaTeX 源码框，点框外 blur 回渲染。
                  MinerU 的 $...$ / \[...\] 直接显示原文看不清，所以渲染态走全站同一套 renderer；
                  配图另在下方的「配图（多选）」里选。 */}
              {isEditing ? (
                <div onClick={(e) => e.stopPropagation()}>
                  <textarea
                    ref={stemRef}
                    value={content}
                    onChange={(e) => setContent(e.target.value)}
                    onBlur={() => setEditingId(null)}
                    onKeyDown={(e) => {
                      if (e.key === 'Escape') e.currentTarget.blur();
                    }}
                    rows={8}
                    aria-label="题干"
                    className="w-full max-h-48 min-h-[7rem] resize-y rounded-lg border border-[#FF6B00] bg-white p-3 text-sm font-mono outline-none"
                  />
                  <div className="mt-1 flex justify-end">
                    {/* onMouseDown 阻止默认：点「恢复」时别先 blur 回渲染态，否则按钮点了个空 */}
                    <button
                      type="button"
                      onMouseDown={(e) => e.preventDefault()}
                      onClick={() => setContent(selected?.content ?? '')}
                      className="text-xs underline text-[#86868B]"
                    >
                      恢复识别结果
                    </button>
                  </div>
                </div>
              ) : (
                <div
                  data-testid="stem-render"
                  className={`md-prose text-sm text-[var(--text-primary)] max-h-48 overflow-y-auto ${
                    isSelected ? 'cursor-text' : ''
                  }`}
                >
                  {shown.trim() ? (
                    <ReactMarkdown
                      remarkPlugins={markdownRemarkPluginsWithBreaks}
                      rehypePlugins={markdownRehypePlugins}
                      components={markdownComponents}
                    >
                      {preprocessMarkdown(stripMdImages(shown))}
                    </ReactMarkdown>
                  ) : (
                    <span className="text-[#86868B]">题干为空，点击填写</span>
                  )}
                </div>
              )}
            </div>
          );
        })}
      </div>

      {figures.length > 0 && (
        <div className="mt-4">
          <div className="text-sm font-medium mb-2">配图（多选）</div>
          <div className="flex flex-wrap gap-3">
            {figures.map((f) => (
              <div
                key={f.url}
                className="relative w-24 h-24 rounded-lg border border-[#E5E5E5] overflow-hidden"
              >
                {/* 图片是独立 button：点图放大，不碰勾选态（若整块是 label，
                    点图会连带切 checkbox，学生想看清图却把配图取消了）。 */}
                <button
                  type="button"
                  aria-label={`放大 ${f.name}`}
                  onClick={() => setPreviewSrc(f.url)}
                  className="block w-full h-full"
                >
                  <img src={f.url} alt={f.name} className="w-full h-full object-cover" />
                </button>
                <label className="absolute top-1 left-1 z-10 flex items-center justify-center p-0.5 rounded bg-white/90">
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
                    className="w-4 h-4 accent-[var(--brand-500)]"
                  />
                </label>
              </div>
            ))}
          </div>
        </div>
      )}

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
      </div>

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
          disabled={!canConfirm}
          className="h-10 px-5 rounded-lg bg-[#FF6B00] text-white text-sm disabled:opacity-50"
        >
          开始作答
        </button>
      </div>

      {previewSrc && (
        <ImageLightbox src={previewSrc} onClose={() => setPreviewSrc(null)} />
      )}
    </div>
  );
}

function subjectIdOf(subject: FreeformCandidate['suggestedSubject'] | undefined): number {
  if (subject === 'physics') return 4;
  if (subject === 'chemistry') return 5;
  return 1;
}

/** 单张配图在题干里的 Markdown 写法；匹配与删除共用同一个形状，避免两处漂移。 */
function imgRefRegExp(url: string): RegExp {
  return new RegExp(`!\\[[^\\]]*\\]\\(${escapeRegExp(url)}\\)`, 'g');
}

function hasImgRef(text: string, url: string): boolean {
  return imgRefRegExp(url).test(text);
}

/**
 * 按勾选结果重整题干：未勾选的图连 Markdown 一起删掉，勾选但题干里没有的图追加到末尾。
 *
 * 返回值同时用于「开始作答」的 disabled 判定与提交内容 —— 两者若各算一遍，
 * 就会出现「题干唯一内容是未勾选的图」时按钮可点、提交却是空串的错位。
 */
function buildContent(content: string, figures: FreeformFigure[], checked: Set<string>): string {
  let out = content;
  for (const f of figures) {
    if (checked.has(f.url)) {
      if (!hasImgRef(out, f.url)) out += `\n\n![配图](${f.url})`;
    } else {
      out = out.replace(imgRefRegExp(f.url), '');
    }
  }
  return out.trim();
}

function stripMdImages(md: string): string {
  return md.replace(/!\[[^\]]*\]\([^)]*\)/g, '').replace(/\s+/g, ' ').trim();
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
