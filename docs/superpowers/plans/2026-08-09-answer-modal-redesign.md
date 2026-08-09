# AnswerModal & AnswerResultList Redesign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Redesign the AnswerModal (three-section layout with Socratic hint/discuss icons, circular icon buttons) and AnswerResultList (expandable list with no text labels) per the design spec.

**Architecture:** Pure frontend changes to 3 business components. AnswerModal gets a new three-section layout (question+icons / editor+preview / close+submit) with toast-based auto-advance. AnswerResultList becomes an expandable list with stats header. SymbolPalette drops Chinese labels for thin dividers. No backend changes - judging and error-book insertion are already wired.

**Tech Stack:** React + TypeScript + Tailwind CSS + ReactMarkdown + KaTeX + Framer Motion + Zustand

**Spec:** `docs/superpowers/specs/2026-08-09-answer-modal-redesign-design.md`

**Testing note:** `apps/web` has no test framework. Verification = `npm run lint` + `npm run build` (tsc type-check) + manual check via `npm run dev`. All commands run from `apps/web/`.

---

## File Structure

| File | Responsibility | Change |
|------|---------------|--------|
| `apps/web/src/components/business/SymbolPalette.tsx` | LaTeX symbol toolbar | Modify: remove Chinese group labels, add thin vertical dividers between groups |
| `apps/web/src/components/business/AnswerModal.tsx` | Answer input modal | Rewrite: three-section layout, hint/discuss icons, toast auto-advance, circular buttons |
| `apps/web/src/components/business/AnswerResultList.tsx` | Post-practice results | Rewrite: stats header, status icons (no text labels), expandable analysis |
| `apps/web/src/pages/student/CourseDetailPage.tsx` | Page hosting the modal | Modify: pass `cardId` + `lessonId` props to AnswerModal (lines ~875-892) |

---

## Task 1: SymbolPalette - Remove Chinese Labels, Add Dividers

**Files:**
- Modify: `apps/web/src/components/business/SymbolPalette.tsx`

- [ ] **Step 1: Rewrite SymbolPalette with dividers, no group labels**

Replace the entire contents of `apps/web/src/components/business/SymbolPalette.tsx` with:

```tsx
import { clsx } from 'clsx';

export interface SymbolDef { label: string; latex: string; group: string; }

const SYMBOLS: SymbolDef[] = [
  { group: '运算', label: '÷', latex: '\\div' },
  { group: '运算', label: '×', latex: '\\times' },
  { group: '运算', label: '±', latex: '\\pm' },
  { group: '运算', label: '≤', latex: '\\leq' },
  { group: '运算', label: '≥', latex: '\\geq' },
  { group: '运算', label: '≠', latex: '\\neq' },
  { group: '幂根', label: '√', latex: '\\sqrt{}' },
  { group: '幂根', label: '½', latex: '\\frac{}{}' },
  { group: '几何', label: '∵', latex: '\\because' },
  { group: '几何', label: '∴', latex: '\\therefore' },
  { group: '几何', label: '△', latex: '\\triangle' },
  { group: '几何', label: '∠', latex: '\\angle' },
  { group: '几何', label: '∥', latex: '\\parallel' },
  { group: '几何', label: '⊥', latex: '\\perp' },
  { group: '几何', label: '°', latex: '^{\\circ}' },
  { group: '其它', label: '→', latex: '\\rightarrow' },
  { group: '其它', label: 'π', latex: '\\pi' },
  { group: '其它', label: '$', latex: '$$' },
];

const GROUPS = ['运算', '幂根', '几何', '其它'];

export function SymbolPalette({ onInsert }: { onInsert: (latex: string) => void }) {
  return (
    <div className="flex flex-wrap items-center gap-1.5 p-2 border-b border-[var(--bg-subtle)]">
      {GROUPS.map((g, gi) => (
        <div key={g} className="flex items-center gap-1">
          {gi > 0 && <div className="w-px h-[22px] bg-[var(--bg-subtle)] mx-0.5" />}
          {SYMBOLS.filter(s => s.group === g).map(s => (
            <button
              key={s.label}
              type="button"
              onClick={() => onInsert(s.latex)}
              className={clsx(
                'min-w-[32px] h-8 px-2 rounded-md text-sm',
                'bg-[var(--bg-subtle)] hover:bg-[var(--brand-500)] hover:text-white',
                'border border-[var(--bg-subtle)] transition-colors',
              )}
              title={s.latex}
            >
              {s.label}
            </button>
          ))}
        </div>
      ))}
    </div>
  );
}
```

Key changes: `分式` label → `½`, `->` → `→`, group name labels removed from render, `gi > 0` inserts a `1px` vertical divider (`w-px h-[22px] bg-[var(--bg-subtle)]`) between groups.

- [ ] **Step 2: Run lint to verify no errors**

Run: `cd apps/web && npm run lint`
Expected: PASS (no errors in SymbolPalette.tsx)

- [ ] **Step 3: Run build to verify type-check passes**

Run: `cd apps/web && npm run build`
Expected: PASS (tsc + vite build succeeds)

- [ ] **Step 4: Commit**

```bash
git add apps/web/src/components/business/SymbolPalette.tsx
git commit -m "refactor(web): SymbolPalette remove Chinese labels, add group dividers

- Replace 分式 label with ½ symbol, -> with →
- Remove 运算/幂根/几何/其它 group name labels from render
- Add 1px vertical dividers between symbol groups
- Group data model preserved for internal grouping only

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

## Task 2: AnswerModal - Three-Section Layout Rewrite

**Files:**
- Modify: `apps/web/src/components/business/AnswerModal.tsx`

- [ ] **Step 1: Rewrite AnswerModal with new layout, hint drawer, toast auto-advance**

Replace the entire contents of `apps/web/src/components/business/AnswerModal.tsx` with:

```tsx
import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import ReactMarkdown from 'react-markdown';
import remarkMath from 'remark-math';
import remarkGfm from 'remark-gfm';
import rehypeKatex from 'rehype-katex';
import 'katex/dist/katex.min.css';
import { LatexEditor } from './LatexEditor';
import { LatexPreview } from './LatexPreview';
import { toast } from '@/components/base';

export interface PracticeQuestion { n: string; text: string; }

interface Props {
  questions: PracticeQuestion[];
  startIndex: number;
  cardId: number;
  lessonId: number;
  onSubmit: (questionText: string, studentAnswer: string) => Promise<{
    isCorrect: boolean; method: string; analysis: string | null; errorType?: string | null;
  }>;
  onFinish: () => void;
  onClose: () => void;
}

export function AnswerModal({ questions, startIndex, cardId, lessonId, onSubmit, onFinish, onClose }: Props) {
  const navigate = useNavigate();
  const [idx, setIdx] = useState(startIndex);
  const [answer, setAnswer] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [showHint, setShowHint] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const q = questions[idx];

  const handleSubmit = async () => {
    if (!answer.trim() || submitting) return;
    setSubmitting(true);
    setError(null);
    try {
      const res = await onSubmit(q.text, answer);
      if (res.isCorrect) {
        toast('success', '正确');
      } else {
        toast('error', '错误，已加入错题本');
      }
      setAnswer('');
      setShowHint(false);
      // 1.5s 后自动切题
      setTimeout(() => {
        if (idx + 1 < questions.length) {
          setIdx(idx + 1);
        } else {
          onFinish();
        }
      }, 1500);
    } catch (e: any) {
      setError(e?.message || '判对错失败，请重试');
    } finally {
      setSubmitting(false);
    }
  };

  const handleDiscuss = () => {
    onClose();
    navigate('/student/ai-discuss', { state: { cardId, lessonId } });
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40" role="dialog" aria-modal="true">
      <div className="w-[92vw] max-w-5xl h-[88vh] bg-[var(--bg-card)] rounded-2xl shadow-xl flex flex-col overflow-hidden">

        {/* ═══ 顶部：题面 + 提示/讨论图标 ═══ */}
        <div className="shrink-0 p-4 border-b border-[var(--bg-subtle)]">
          <div className="flex gap-3">
            {/* 题目区 */}
            <div className="flex-1 min-w-0">
              <div className="text-xs text-[var(--text-tertiary)] font-medium mb-2">
                第 {idx + 1} / {questions.length} 题
              </div>
              <div className="text-[15px] font-bold text-[var(--text-primary)] leading-[1.7]">
                <ReactMarkdown remarkPlugins={[remarkMath, remarkGfm]} rehypePlugins={[rehypeKatex]}>
                  {q.text}
                </ReactMarkdown>
              </div>
            </div>
            {/* 右侧图标按钮列 */}
            <div className="flex flex-col gap-2 shrink-0">
              {/* 提示 */}
              <button
                onClick={() => setShowHint(!showHint)}
                className="w-[38px] h-[38px] rounded-xl border border-[var(--bg-subtle)] bg-[var(--bg-card)] flex items-center justify-center text-[var(--warning)] shadow-sm hover:bg-[#FFF8F0] transition-colors"
                title="提示"
                aria-label="提示"
              >
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <circle cx="12" cy="12" r="10" />
                  <path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3" />
                  <line x1="12" y1="17" x2="12.01" y2="17" />
                </svg>
              </button>
              {/* 让 AI 讲一讲 */}
              <button
                onClick={handleDiscuss}
                className="w-[38px] h-[38px] rounded-xl border border-[var(--bg-subtle)] bg-[var(--bg-card)] flex items-center justify-center text-[var(--info)] shadow-sm hover:bg-[#F0F5FA] transition-colors"
                title="让 AI 讲一讲"
                aria-label="让 AI 讲一讲"
              >
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
                </svg>
              </button>
            </div>
          </div>
          {/* 提示抽屉 */}
          {showHint && (
            <div className="mt-3 p-3 rounded-lg bg-[#FFF8F0] border-l-[3px] border-[var(--warning)]">
              <p className="text-sm text-[var(--text-primary)] leading-relaxed">
                仔细审题，从已知条件出发，逐步推理。如果需要更多帮助，可以点击右侧「让 AI 讲一讲」。
              </p>
            </div>
          )}
        </div>

        {/* ═══ 中部：左编辑 右预览 ═══ */}
        <div className="flex-1 min-h-0 flex">
          <div className="w-1/2 border-r border-[var(--bg-subtle)] flex flex-col">
            <LatexEditor value={answer} onChange={setAnswer} />
          </div>
          <div className="w-1/2">
            <LatexPreview value={answer} />
          </div>
        </div>

        {/* ═══ 底部：关闭（左）+ 提交（右） ═══ */}
        <div className="shrink-0 flex items-center justify-between p-3 border-t border-[var(--bg-subtle)]">
          {/* 关闭 */}
          <button
            onClick={onClose}
            className="w-10 h-10 rounded-full border border-[var(--bg-subtle)] bg-[var(--bg-card)] flex items-center justify-center text-[var(--text-tertiary)] hover:bg-[var(--bg-base)] transition-colors"
            title="关闭"
            aria-label="关闭"
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
              <line x1="18" y1="6" x2="6" y2="18" />
              <line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </button>
          {/* 错误提示 */}
          {error && <span className="text-sm text-[var(--error)]">{error}</span>}
          {/* 提交 */}
          <button
            onClick={handleSubmit}
            disabled={!answer.trim() || submitting}
            className="w-12 h-12 rounded-full bg-[var(--brand-500)] text-white flex items-center justify-center disabled:opacity-40 hover:bg-[var(--brand-600)] transition-all shadow-md"
            title="提交"
            aria-label="提交"
          >
            {submitting ? (
              <svg className="animate-spin" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                <path d="M21 12a9 9 0 1 1-6.219-8.56" />
              </svg>
            ) : (
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <line x1="22" y1="2" x2="11" y2="13" />
                <polygon points="22 2 15 22 11 13 2 9 22 2" />
              </svg>
            )}
          </button>
        </div>
      </div>
    </div>
  );
}
```

Key changes from old version:
- **Props**: Added `cardId: number` and `lessonId: number` (needed for Discuss navigation)
- **Top section**: Question rendered via ReactMarkdown (bold `text-[15px] font-bold`), right-side vertical icon stack (Hint `text-[var(--warning)]` + Discuss `text-[var(--info)]`), collapsible hint drawer
- **Bottom section**: Close (X, 40px circle, left) + Submit (paper-plane, 48px circle, Brand-500, right), `justify-between` layout
- **Submit flow**: Calls `toast('success'|'error', ...)` from `@/components/base`, auto-advances after 1500ms via `setTimeout`
- **Discuss**: Closes modal then navigates to `/student/ai-discuss` with `{ cardId, lessonId }` state
- **Removed**: Old "退出" text button, old "提交" text button, old `idx+1` auto-advance without toast

- [ ] **Step 2: Run lint to verify no errors**

Run: `cd apps/web && npm run lint`
Expected: PASS (no errors in AnswerModal.tsx)

- [ ] **Step 3: Run build to verify type-check passes**

Run: `cd apps/web && npm run build`
Expected: **FAIL** - `CourseDetailPage.tsx` will error because it doesn't pass the new `cardId` and `lessonId` props yet. This is expected; Task 3 fixes it.

- [ ] **Step 4: Commit (despite expected build failure - will be fixed in Task 3)**

```bash
git add apps/web/src/components/business/AnswerModal.tsx
git commit -m "feat(web): rewrite AnswerModal with three-section layout

- Top: rendered question + vertical hint/discuss icon stack
- Middle: editor + preview (unchanged structure)
- Bottom: circular Close (X, left) + Submit (paper-plane, right)
- Submit triggers toast feedback + 1500ms auto-advance
- Hint button toggles inline Socratic nudge drawer
- Discuss button navigates to /student/ai-discuss
- Props: add cardId + lessonId for Discuss navigation

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

## Task 3: CourseDetailPage - Pass cardId + lessonId Props

**Files:**
- Modify: `apps/web/src/pages/student/CourseDetailPage.tsx` (lines ~875-892, the `<AnswerModal>` invocation)

- [ ] **Step 1: Add cardId and lessonId props to AnswerModal invocation**

In `apps/web/src/pages/student/CourseDetailPage.tsx`, find the `<AnswerModal>` JSX block (around line 875). It currently looks like:

```tsx
          <AnswerModal
            questions={questions}
            startIndex={modalStart}
            onSubmit={async (questionText, studentAnswer) => {
```

Change it to add the two new props after `startIndex={modalStart}`:

```tsx
          <AnswerModal
            questions={questions}
            startIndex={modalStart}
            cardId={card.id}
            lessonId={lessonId}
            onSubmit={async (questionText, studentAnswer) => {
```

The rest of the `<AnswerModal>` block (`onSubmit`, `onFinish`, `onClose`) stays unchanged.

- [ ] **Step 2: Run lint to verify no errors**

Run: `cd apps/web && npm run lint`
Expected: PASS

- [ ] **Step 3: Run build to verify type-check passes**

Run: `cd apps/web && npm run build`
Expected: PASS (tsc + vite build succeeds - the prop mismatch from Task 2 is now resolved)

- [ ] **Step 4: Commit**

```bash
git add apps/web/src/pages/student/CourseDetailPage.tsx
git commit -m "fix(web): pass cardId + lessonId to AnswerModal

Required by AnswerModal's new Discuss button navigation.

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

## Task 4: AnswerResultList - Expandable List Rewrite

**Files:**
- Modify: `apps/web/src/components/business/AnswerResultList.tsx`

- [ ] **Step 1: Rewrite AnswerResultList with stats header, status icons, expandable analysis**

Replace the entire contents of `apps/web/src/components/business/AnswerResultList.tsx` with:

```tsx
import { useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkMath from 'remark-math';
import remarkGfm from 'remark-gfm';
import rehypeKatex from 'rehype-katex';
import 'katex/dist/katex.min.css';
import type { PracticeQuestion } from './AnswerModal';

interface AnswerRecord {
  isCorrect: boolean;
  method: string;
  analysis: string | null;
  errorType?: string | null;
  studentAnswer: string;
}

interface Props {
  questions: PracticeQuestion[];
  answers: Record<string, AnswerRecord>;
  onRetry: () => void;
}

export function AnswerResultList({ questions, answers, onRetry }: Props) {
  const [expandedN, setExpandedN] = useState<string | null>(null);

  const correctCount = questions.filter(q => answers[q.n]?.isCorrect).length;
  const wrongCount = questions.length - correctCount;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40">
      <div className="w-[92vw] max-w-2xl max-h-[80vh] flex flex-col bg-[var(--bg-card)] rounded-2xl shadow-xl overflow-hidden">

        {/* ═══ Header: title + stats ═══ */}
        <div className="shrink-0 px-5 py-4 border-b border-[var(--bg-subtle)] flex items-center justify-between">
          <h2 className="text-[17px] font-bold text-[var(--text-primary)]">答题结果</h2>
          <div className="flex gap-4">
            <div className="flex items-center gap-1.5">
              <span className="w-2 h-2 rounded-full bg-[var(--success)]" />
              <span className="text-[13px] text-[var(--text-secondary)]">对 {correctCount}</span>
            </div>
            <div className="flex items-center gap-1.5">
              <span className="w-2 h-2 rounded-full bg-[var(--error)]" />
              <span className="text-[13px] text-[var(--text-secondary)]">错 {wrongCount}</span>
            </div>
          </div>
        </div>

        {/* ═══ List ═══ */}
        <div className="flex-1 overflow-auto p-3">
          <div className="flex flex-col gap-2.5">
            {questions.map(q => {
              const a = answers[q.n];
              const correct = a?.isCorrect;
              const expanded = expandedN === q.n;
              return (
                <div key={q.n} className="bg-[var(--bg-card)] rounded-xl border border-[var(--bg-subtle)] overflow-hidden">
                  <div className="p-3.5 flex items-start gap-3">
                    {/* Status icon */}
                    <div className={`shrink-0 w-6 h-6 rounded-full flex items-center justify-center mt-0.5 ${correct ? 'bg-[#E8F5EE]' : 'bg-[#FCE8E6]'}`}>
                      {correct ? (
                        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="var(--success)" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
                          <polyline points="20 6 9 17 4 12" />
                        </svg>
                      ) : (
                        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="var(--error)" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
                          <line x1="18" y1="6" x2="6" y2="18" />
                          <line x1="6" y1="6" x2="18" y2="18" />
                        </svg>
                      )}
                    </div>
                    {/* Content */}
                    <div className="flex-1 min-w-0">
                      <div className="text-sm font-medium text-[var(--text-primary)] leading-[1.6]">
                        <ReactMarkdown remarkPlugins={[remarkMath, remarkGfm]} rehypePlugins={[rehypeKatex]}>
                          {q.text}
                        </ReactMarkdown>
                      </div>
                      <div className="mt-2 px-3 py-2 bg-[var(--bg-base)] rounded-lg">
                        <span className="text-xs text-[var(--text-tertiary)]">你的答案：</span>
                        <span className="text-[13px] text-[var(--text-primary)] font-mono">{a?.studentAnswer || '（未作答）'}</span>
                      </div>
                      {/* 查看解析 button (wrong only) */}
                      {!correct && a?.analysis && (
                        <button
                          onClick={() => setExpandedN(expanded ? null : q.n)}
                          className="mt-2.5 px-4 py-1.5 rounded-lg border border-[var(--warning)] bg-[#FFF8F0] text-[var(--warning)] text-xs font-medium hover:bg-[var(--warning)] hover:text-white transition-colors"
                        >
                          {expanded ? '收起解析' : '查看解析'}
                        </button>
                      )}
                    </div>
                  </div>
                  {/* Expanded analysis */}
                  {expanded && !correct && a?.analysis && (
                    <div className="px-4 pb-3.5 pl-[52px]">
                      <div className="p-3.5 bg-[#FFF8F0] rounded-[10px] border-l-[3px] border-[var(--warning)]">
                        {a.errorType && (
                          <div className="text-xs font-semibold text-[var(--warning)] mb-1.5">错因：{a.errorType}</div>
                        )}
                        <div className="text-[13px] text-[var(--text-primary)] leading-[1.7]">
                          <ReactMarkdown remarkPlugins={[remarkMath, remarkGfm]} rehypePlugins={[rehypeKatex]}>
                            {a.analysis}
                          </ReactMarkdown>
                        </div>
                      </div>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </div>

        {/* ═══ Footer ═══ */}
        <div className="shrink-0 px-5 py-3 border-t border-[var(--bg-subtle)] flex justify-center">
          <button
            onClick={onRetry}
            className="px-8 py-2.5 rounded-[10px] bg-[var(--brand-500)] text-white text-sm font-semibold hover:bg-[var(--brand-600)] transition-colors shadow-sm"
          >
            完成
          </button>
        </div>
      </div>
    </div>
  );
}
```

Key changes from old version:
- **Header**: Added stats row (对 N / 错 M with colored dots) - old version had none
- **Items**: Full question text via ReactMarkdown (old: `q.text.slice(0, 40)` truncated). Student answer shown in a pill. **No "✓ 对" / "✗ 错" text labels** - status icon (green check / red X in tinted circle) is the only indicator
- **Analysis**: Collapsed by default. Wrong items show 【查看解析】button. Click toggles `expandedN` state. Expanded view: 错因 type + Markdown+LaTeX rendered analysis in warm left-bordered box
- **Removed**: Old `openN` single-expand state, old "✓ 对"/"✗ 错" text, old "解析" button

- [ ] **Step 2: Run lint to verify no errors**

Run: `cd apps/web && npm run lint`
Expected: PASS

- [ ] **Step 3: Run build to verify type-check passes**

Run: `cd apps/web && npm run build`
Expected: PASS (tsc + vite build succeeds)

- [ ] **Step 4: Commit**

```bash
git add apps/web/src/components/business/AnswerResultList.tsx
git commit -m "feat(web): rewrite AnswerResultList as expandable list

- Header: title + 对N/错M stats with colored dots
- Items: full question (ReactMarkdown), answer pill, status icon
- No text labels - green ✓ / red ✗ icons indicate correctness
- Wrong items: 查看解析 button toggles expanded analysis
- Analysis: 错因 type + Markdown+LaTeX rendered, warm left-border box
- Collapsed by default per design spec

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

## Task 5: Integration Verification

**Files:**
- None (verification only)

- [ ] **Step 1: Start dev server**

Run: `cd apps/web && npm run dev`
Expected: Vite dev server starts at `http://localhost:5173`

- [ ] **Step 2: Manual verification - navigate to a practice card**

1. Open `http://localhost:5173` in a browser
2. Log in as a student (non-phone username)
3. Navigate to a lesson with practice cards (star map → select a lesson)
4. Page through cards until reaching a practice card
5. Click a question to open the AnswerModal

Verify:
- [ ] Top section shows rendered question (bold, math symbols rendered, NOT raw LaTeX)
- [ ] Right side has two stacked icon buttons (Hint = amber lightbulb, Discuss = blue chat bubble)
- [ ] Middle section: left has symbol toolbar (no Chinese labels, thin dividers between groups) + textarea; right has live preview
- [ ] Bottom section: Close (X circle) on LEFT, Submit (paper-plane orange circle) on RIGHT
- [ ] Type in textarea → right preview updates (debounced ~150ms)

- [ ] **Step 3: Manual verification - submit flow**

1. Type an answer in the editor
2. Click the Submit (paper-plane) button
3. Verify: button shows spinning loader, then a toast appears (green "正确" or red "错误，已加入错题本")
4. Verify: after ~1.5s, auto-advances to next question (or if last question, modal closes and result list appears)
5. Verify: answer field is cleared on the new question

- [ ] **Step 4: Manual verification - hint drawer**

1. Click the Hint (lightbulb) button
2. Verify: a warm-colored drawer slides in below the question with a Socratic nudge message
3. Click Hint again → drawer collapses

- [ ] **Step 5: Manual verification - result list**

1. Answer all questions in the practice card (some correct, some wrong)
2. Verify: AnswerResultList appears after the last question
3. Verify: header shows "答题结果" + 对 N / 错 M stats with colored dots
4. Verify: each item shows status icon (green ✓ / red ✗) + full question + answer pill
5. Verify: NO "正确"/"错误" text labels
6. Verify: wrong items have a 【查看解析】button; correct items do not
7. Click 【查看解析】→ verify analysis expands (错因 + rendered Markdown+LaTeX)
8. Click again → collapses
9. Click "完成" → result list closes, returns to CourseDetailPage

- [ ] **Step 6: Manual verification - close button**

1. Open AnswerModal
2. Click Close (X) button
3. Verify: modal closes, returns to CourseDetailPage (unsaved answer discarded)

- [ ] **Step 7: Final lint + build check**

Run: `cd apps/web && npm run lint && npm run build`
Expected: Both PASS

- [ ] **Step 8: Final commit (if any cleanup needed)**

If all checks pass, no additional commit needed. The feature is complete.

---

## Self-Review Notes

**Spec coverage:**
- ✅ §3.1 AnswerModal three-section structure → Task 2
- ✅ §3.2 Top question + hint/discuss icons → Task 2
- ✅ §3.3 Middle editor + preview → Task 2 (reuses existing LatexEditor/LatexPreview)
- ✅ §3.4 Bottom close (left) + submit (right) circular icons → Task 2
- ✅ §3.5 Submit → toast → auto-advance flow → Task 2
- ✅ §3.5 Hint drawer + Discuss navigation → Task 2
- ✅ §4 AnswerResultList expandable list, no text labels, 查看解析 → Task 4
- ✅ §5 SymbolPalette no Chinese labels, dividers → Task 1
- ✅ §6 File changes → Tasks 1-4

**Type consistency:**
- `Props.cardId` / `Props.lessonId` added in Task 2 → passed in Task 3 ✅
- `PracticeQuestion` interface unchanged (re-exported from AnswerModal, imported by AnswerResultList) ✅
- `AnswerRecord` interface in AnswerResultList matches practiceStore's `JudgeResult + studentAnswer` ✅
- `toast(type, message)` signature matches base/Toast.tsx ✅

**Known limitations (not in scope):**
- `/student/ai-discuss` is currently a Placeholder (P2.3). Discuss button navigates there correctly but the page itself is not yet built. Forward-compatible.
- Hint drawer shows a static Socratic nudge (no AI call) because no dedicated hint API exists. A future P1 task can wire it to a backend endpoint.
- Toast auto-dismisses at 3000ms (global setting); auto-advance happens at 1500ms. Toast may briefly overlap the next question - acceptable, non-blocking.
