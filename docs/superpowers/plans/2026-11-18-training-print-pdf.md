# 专项练习导出 PDF 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use subagent-driven-development (recommended) or executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让学生在四个训练轨答题页把当前题单导出成 A4 PDF（只含题干与选项、留白作答），保存位置由系统打印面板选择。

**Architecture:** 新增纯展示组件 `PrintPaper`（`RunnerQuestion[]` → A4 纸面）+ `PrintPreview`（portal 到 body 的预览层）+ `usePdfPrint`（等图片 decode 后调 `window.print()`）+ 全局 `print.css`。四个页面共用同一套组件；结果弹窗 `AnswerResultList` 加可选 `onExport`。

**Tech Stack:** React 18、TypeScript、Vite、Vitest + @testing-library/react（jsdom，`globals: false`）、原生 CSS `@media print` / `@page`。

**依据 spec：** `docs/superpowers/specs/2026-11-18-training-print-pdf-design.md`（下称 spec）。

## Global Constraints

- **不改后端、不加依赖**：无 API 变更，不引 jspdf / html2canvas / puppeteer。
- **只用题干 + 选项**：不渲染答案、解析、学生作答内容。
- **UI 用 token 与线性 SVG**：页面内按钮沿用现有 `var(--*)` token；纸面在 `#root` 外，必须自带颜色变量（spec §5.3）。
- **不用 emoji、不加装饰元素**；工具栏提示只保留可操作的一句（spec §6.3）。
- **组件改动必须补渲染测试**；`globals: false`，多用例文件自行 `afterEach(() => cleanup())`。
- **导出恒用 `questions`（`RunnerQuestion[]`）**，不用 `resultQuestions`（缺 options，spec §4.1）。
- **每任务一提交**；在当前分支直接提交，不 push、不新建分支。

## 文件结构

| 文件 | 动作 | 职责 |
|---|---|---|
| `apps/web/src/styles/print.css` | 新建 | 屏幕预览 + `@media print` + `@page` |
| `apps/web/src/main.tsx` | 修改 | `global.css` 之后引入 `print.css` |
| `apps/web/src/components/business/print/PrintPaper.tsx` | 新建 | 纯展示 A4 纸面 |
| `apps/web/src/components/business/print/PrintPaper.test.tsx` | 新建 | 纸面渲染测试 |
| `apps/web/src/components/business/print/usePrint.ts` | 新建 | `usePdfPrint()`：等图片 → `window.print()` |
| `apps/web/src/components/business/print/PrintPreview.tsx` | 新建 | portal 预览层、Esc/关闭、body 滚动锁 |
| `apps/web/src/components/business/print/PrintPreview.test.tsx` | 新建 | 预览层交互测试 |
| `apps/web/src/components/business/print/PrintIconButton.tsx` | 新建 | 32px 线性 SVG 打印机按钮 |
| `apps/web/src/components/business/print/PrintIconButton.test.tsx` | 新建 | 按钮渲染/点击测试 |
| `apps/web/src/components/business/AnswerResultList.tsx` | 修改 | 新增可选 `onExport`，底部次级按钮 |
| `apps/web/src/components/business/AnswerResultList.test.tsx` | 修改 | 补导出入口用例 |
| `apps/web/src/pages/student/training/TargetedRunPage.tsx` | 修改 | 动作组 + 结果弹窗 + 挂预览层 |
| `apps/web/src/pages/student/training/ErrorPracticeRunPage.tsx` | 修改 | 同上 |
| `apps/web/src/pages/student/training/VariationRunPage.tsx` | 修改 | 动作组 + 挂预览层（无结果弹窗） |
| `apps/web/src/pages/student/training/RemediationRunPage.tsx` | 修改 | 同上 |
| `docs/UX-UI设计文档.md` | 修改 | 增补 §5.14 |
| `docs/constraints/专项子系统.md` | 修改 | 增补一条「导出 PDF 口径」 |

---

### Task 1: 打印纸面（`PrintPaper` + `print.css`）

**Files:**
- Create: `apps/web/src/styles/print.css`
- Create: `apps/web/src/components/business/print/PrintPaper.tsx`
- Create: `apps/web/src/components/business/print/PrintPaper.test.tsx`
- Modify: `apps/web/src/main.tsx:4`

**Interfaces:**
- Consumes: `RunnerQuestion`（`@/components/business/answer/types`）、`markdownComponents` / `markdownRemarkPlugins` / `markdownRehypePlugins` / `preprocessMarkdown` / `preprocessMaterialMarkdown`（`@/components/markdown`）。
- Produces:
  ```ts
  export interface PrintMeta { subject?: string; title?: string; date?: string }
  export const PrintPaper: React.ForwardRefExoticComponent<
    { questions: RunnerQuestion[]; meta?: PrintMeta } & React.RefAttributes<HTMLDivElement>
  >;
  ```
  CSS 契约：`.print-sheet` / `.print-head` / `.print-q` / `.print-material` / `.print-options` / `.print-option` / `.print-answer-blank--short|medium|long`。

- [ ] **Step 1: 写失败的渲染测试**

创建 `apps/web/src/components/business/print/PrintPaper.test.tsx`：

```tsx
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { PrintPaper } from './PrintPaper';
import type { RunnerQuestion } from '@/components/business/answer/types';

afterEach(() => cleanup());

const q = (over: Partial<RunnerQuestion>): RunnerQuestion => ({ n: '1', text: '题面', ...over });

describe('PrintPaper', () => {
  it('题号按顺序连续 1..N，忽略 n 字段', () => {
    render(
      <PrintPaper
        meta={{ subject: '数学', date: '2026-11-18' }}
        questions={[q({ n: '101' }), q({ n: '205' }), q({ n: '309' })]}
      />,
    );
    const nos = [...document.querySelectorAll('.print-q-no')].map((el) => el.textContent);
    expect(nos).toEqual(['1.', '2.', '3.']);
    expect(screen.getByText('数学专项 · 3 题')).toBeTruthy();
    expect(screen.getByText('2026-11-18')).toBeTruthy();
  });

  it('相邻同材料只印一次，不相邻同材料各印一次', () => {
    render(
      <PrintPaper
        questions={[
          q({ n: '1', material: '共享文段' }),
          q({ n: '2', material: '共享文段' }),
          q({ n: '3' }),
          q({ n: '4', material: '共享文段' }),
        ]}
      />,
    );
    // 2026-11-21 修订：material_text 单独成块，在题干下方
    expect(screen.getAllByTestId('print-material-text')).toHaveLength(2);
  });

  it('选择题打印选项且不留作答空白；填空题短空白、主观题长空白', () => {
    render(
      <PrintPaper
        questions={[
          q({ n: '1', type: 'choice', options: [{ label: 'A', text: '选项甲' }, { label: 'B', text: '选项乙' }] }),
          q({ n: '2', type: 'fill_blank' }),
          q({ n: '3', type: 'short_answer' }),
        ]}
      />,
    );
    expect(screen.getByText('选项甲')).toBeTruthy();
    expect(screen.getByText('选项乙')).toBeTruthy();
    const blanks = screen.getAllByTestId('answer-space');
    expect(blanks).toHaveLength(2);
    expect(blanks[0].className).toContain('print-answer-blank--short');
    expect(blanks[1].className).toContain('print-answer-blank--long');
  });

  it('true_false 不带选项时补「对 / 错」', () => {
    render(<PrintPaper questions={[q({ type: 'true_false' })]} />);
    expect(screen.getByText('对')).toBeTruthy();
    expect(screen.getByText('错')).toBeTruthy();
  });

  it('不渲染答案与解析', () => {
    render(<PrintPaper questions={[q({ n: '1', text: '题面文字' })]} />);
    expect(screen.queryByText(/参考答案/)).toBeNull();
    expect(screen.queryByText(/解析/)).toBeNull();
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

```bash
cd apps/web && npx vitest run src/components/business/print/PrintPaper.test.tsx
```

Expected: FAIL（`Failed to resolve import "./PrintPaper"`）。

- [ ] **Step 3: 写 `print.css`**

创建 `apps/web/src/styles/print.css`：

```css
/* 专项练习导出 PDF：屏幕预览 + A4 打印。
   纸面 portal 到 body（#root 之外），拿不到主题 token，必须自带一套颜色变量。 */

.print-portal {
  position: fixed;
  inset: 0;
  z-index: 60;
  overflow: auto;
  background: rgba(15, 23, 42, 0.45);
  padding-bottom: 12mm;
}

.print-toolbar {
  position: sticky;
  top: 0;
  z-index: 1;
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: 8px 16px;
  padding: 10px 16px;
  background: #fff;
  border-bottom: 1px solid #e5e7eb;
}

.print-toolbar-hint {
  margin: 0;
  font-size: 12px;
  color: #4b5563;
}

.print-toolbar-actions { display: flex; gap: 8px; }

.print-btn {
  height: 34px;
  padding: 0 14px;
  border-radius: 8px;
  border: 1px solid #d1d5db;
  background: #fff;
  color: #374151;
  font-size: 13px;
  font-weight: 600;
  cursor: pointer;
}
.print-btn:hover { background: #f9fafb; }
.print-btn--primary { border-color: #111827; background: #111827; color: #fff; }
.print-btn--primary:hover { background: #1f2937; }

.print-scroll { display: block; padding: 8mm 4mm; }

.print-sheet {
  --text-primary: #111;
  --text-secondary: #444;
  --bg-subtle: #d4d4d4;
  --bg-base: #fff;
  --bg-page: #fff;
  --brand-500: #111;
  --learn-card-bg: #fff;
  --learn-card-border: #ddd;

  box-sizing: border-box;
  width: 210mm;
  min-height: 297mm;
  margin: 0 auto;
  padding: 14mm 12mm;
  background: #fff;
  color: var(--text-primary);
  font-size: 10.5pt;
  line-height: 1.75;
  box-shadow: 0 6px 24px rgba(0, 0, 0, 0.18);
}

.print-sheet .md-prose { color: var(--text-primary); }
.print-sheet .md-prose img { max-width: 100%; height: auto; break-inside: avoid; }

.print-head {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 8mm;
  padding-bottom: 2mm;
  margin-bottom: 5mm;
  border-bottom: 0.5pt solid #999;
  font-size: 9pt;
  color: #333;
}

.print-q { margin: 0 0 6mm; break-inside: avoid; }
.print-q-body { display: flex; gap: 2mm; }
.print-q-no { flex: 0 0 7mm; text-align: right; font-weight: 600; }
.print-q-main { flex: 1 1 auto; min-width: 0; }

.print-material {
  margin: 0 0 2.5mm;
  padding-left: 3mm;
  border-left: 2px solid #bbb;
  color: #333;
}

.print-options { list-style: none; margin: 1.5mm 0 0; padding: 0 0 0 9mm; }
.print-option { display: flex; gap: 2mm; margin-bottom: 1mm; break-inside: avoid; }
.print-opt-label { flex: 0 0 5mm; font-weight: 600; }
.print-opt-text { flex: 1 1 auto; min-width: 0; }

.print-answer-blank { margin-left: 9mm; }
.print-answer-blank--short { height: 24mm; }
.print-answer-blank--medium { height: 40mm; }
.print-answer-blank--long { height: 52mm; }

.print-sheet table { width: 100%; border-collapse: collapse; }
.print-sheet th,
.print-sheet td { border: 0.5pt solid #999; padding: 1mm 2mm; }

/* 预览层打开时锁 body 滚动；打印时必须放开，否则多页会被裁成一页 */
body.print-open { overflow: hidden; }

@media print {
  /* 不只隐藏 #root：图片放大浮层等也 portal 到 body，漏掉会印到纸上 */
  body > *:not(.print-portal) { display: none !important; }
  body { overflow: visible !important; }
  .print-portal {
    position: static;
    padding: 0;
    background: #fff;
    overflow: visible;
  }
  .print-toolbar { display: none !important; }
  .print-scroll { display: block; padding: 0; }
  .print-sheet {
    width: auto;
    min-height: 0;
    margin: 0;
    padding: 0;
    box-shadow: none;
  }

  @page { size: A4; margin: 14mm 12mm; }
}
```

- [ ] **Step 4: 在 `main.tsx` 引入样式**

把 `apps/web/src/main.tsx` 里的：

```ts
import './styles/global.css';
```

改成：

```ts
import './styles/global.css';
import './styles/print.css';
```

- [ ] **Step 5: 写 `PrintPaper`**

创建 `apps/web/src/components/business/print/PrintPaper.tsx`：

```tsx
import { forwardRef } from 'react';
import ReactMarkdown from 'react-markdown';
import {
  markdownComponents,
  markdownRehypePlugins,
  markdownRemarkPlugins,
  preprocessMarkdown,
  preprocessMaterialMarkdown,
} from '@/components/markdown';
import type { RunnerQuestion } from '@/components/business/answer/types';

export interface PrintMeta {
  subject?: string;
  title?: string;
  date?: string;
}

interface PrintPaperProps {
  questions: RunnerQuestion[];
  meta?: PrintMeta;
}

const CHOICE_TYPES = new Set(['choice', 'multi_choice', 'true_false']);

/** 选择题只印选项；填空题留短空白；主观题留长空白；未知题型按中等留白。 */
function answerSpaceClass(type?: string): string | null {
  if (!type) return 'print-answer-blank--medium';
  if (CHOICE_TYPES.has(type)) return null;
  if (type === 'fill_blank') return 'print-answer-blank--short';
  if (type === 'short_answer' || type === 'proof' || type === 'calculation') {
    return 'print-answer-blank--long';
  }
  return 'print-answer-blank--medium';
}

/** true_false 允许不带 options：作答页会补「对 / 错」，纸面保持一致。 */
function optionsOf(q: RunnerQuestion): Array<{ label: string; text: string }> {
  if (q.options && q.options.length > 0) return q.options;
  if (q.type === 'true_false') {
    return [
      { label: 'A', text: '对' },
      { label: 'B', text: '错' },
    ];
  }
  return [];
}

function today(): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

export const PrintPaper = forwardRef<HTMLDivElement, PrintPaperProps>(function PrintPaper(
  { questions, meta },
  ref,
) {
  const subject = meta?.subject ?? '';
  const title = meta?.title ?? `${subject}专项 · ${questions.length} 题`;
  const date = meta?.date ?? today();

  let lastMaterial: string | null = null;

  return (
    <div ref={ref} className="print-sheet" data-testid="print-sheet">
      <div className="print-head">
        <span>{title}</span>
        <span>{date}</span>
      </div>

      {questions.map((q, i) => {
        const material = q.material && q.material.trim() ? q.material : null;
        const showMaterial = material !== null && material !== lastMaterial;
        lastMaterial = material;
        const options = optionsOf(q);
        const blank = answerSpaceClass(q.type);

        return (
          <section className="print-q" data-testid="print-question" key={q.n}>
            {/* 2026-11-21 修订：material_text 块移到题干下方、testId 改 print-material-text；
                此处为历史稿，现行实现见 2026-11-20-chinese-material-doc 计划与 PrintPaper.tsx */}
            {showMaterial && (
              <div className="print-material md-prose" data-testid="print-material">
                <ReactMarkdown
                  remarkPlugins={markdownRemarkPlugins}
                  rehypePlugins={markdownRehypePlugins}
                  components={markdownComponents}
                >
                  {preprocessMaterialMarkdown(material)}
                </ReactMarkdown>
              </div>
            )}

            <div className="print-q-body">
              <span className="print-q-no">{i + 1}.</span>
              <div className="print-q-main md-prose">
                <ReactMarkdown
                  remarkPlugins={markdownRemarkPlugins}
                  rehypePlugins={markdownRehypePlugins}
                  components={markdownComponents}
                >
                  {preprocessMarkdown(q.text)}
                </ReactMarkdown>

                {options.length > 0 && (
                  <ul className="print-options">
                    {options.map((o) => (
                      <li className="print-option" key={o.label}>
                        <span className="print-opt-label">{o.label}.</span>
                        <div className="print-opt-text md-prose">
                          <ReactMarkdown
                            remarkPlugins={markdownRemarkPlugins}
                            rehypePlugins={markdownRehypePlugins}
                            components={markdownComponents}
                          >
                            {preprocessMarkdown(o.text)}
                          </ReactMarkdown>
                        </div>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            </div>

            {blank && (
              <div
                className={`print-answer-blank ${blank}`}
                data-testid="answer-space"
                aria-hidden="true"
              />
            )}
          </section>
        );
      })}
    </div>
  );
});
```

- [ ] **Step 6: 跑测试确认通过**

```bash
cd apps/web && npx vitest run src/components/business/print/PrintPaper.test.tsx
```

Expected: 5 passed。

- [ ] **Step 7: 提交**

```bash
git add apps/web/src/styles/print.css apps/web/src/main.tsx \
  apps/web/src/components/business/print/PrintPaper.tsx \
  apps/web/src/components/business/print/PrintPaper.test.tsx
git commit -m "feat(web): 新增 A4 打印纸面组件与打印样式"
```

---

### Task 2: 预览层、打印动作与入口图标

**Files:**
- Create: `apps/web/src/components/business/print/usePrint.ts`
- Create: `apps/web/src/components/business/print/PrintPreview.tsx`
- Create: `apps/web/src/components/business/print/PrintIconButton.tsx`
- Create: `apps/web/src/components/business/print/PrintPreview.test.tsx`
- Create: `apps/web/src/components/business/print/PrintIconButton.test.tsx`

**Interfaces:**
- Consumes: `PrintPaper` / `PrintMeta`（Task 1）、`RunnerQuestion`。
- Produces:
  ```ts
  export function usePdfPrint(): (root: HTMLElement | null) => Promise<void>;
  export function PrintPreview(props: {
    open: boolean;
    questions: RunnerQuestion[];
    meta?: PrintMeta;
    onClose: () => void;
  }): JSX.Element | null;
  export function PrintIconButton(props: { onClick: () => void }): JSX.Element;
  ```

- [ ] **Step 1: 写失败的测试**

创建 `apps/web/src/components/business/print/PrintPreview.test.tsx`：

```tsx
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { PrintPreview } from './PrintPreview';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  document.body.classList.remove('print-open');
});

const questions = [{ n: '1', text: '题面' }];

describe('PrintPreview', () => {
  it('open=false 不渲染', () => {
    render(<PrintPreview open={false} questions={questions} onClose={() => {}} />);
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('打开后显示预览与按钮，Esc 触发 onClose', async () => {
    const onClose = vi.fn();
    render(<PrintPreview open questions={questions} onClose={onClose} />);
    expect(screen.getByRole('dialog')).toBeTruthy();
    expect(screen.getByRole('button', { name: '导出 PDF' })).toBeTruthy();
    expect(screen.getByRole('button', { name: '关闭' })).toBeTruthy();
    expect(document.body.classList.contains('print-open')).toBe(true);

    await userEvent.keyboard('{Escape}');
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('点「导出 PDF」调 window.print', async () => {
    const spy = vi.spyOn(window, 'print').mockImplementation(() => {});
    render(<PrintPreview open questions={questions} onClose={() => {}} />);

    await userEvent.click(screen.getByRole('button', { name: '导出 PDF' }));
    await waitFor(() => expect(spy).toHaveBeenCalledTimes(1));
  });
});
```

创建 `apps/web/src/components/business/print/PrintIconButton.test.tsx`：

```tsx
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { PrintIconButton } from './PrintIconButton';

afterEach(() => cleanup());

describe('PrintIconButton', () => {
  it('渲染可访问名称「导出 PDF」并触发点击', async () => {
    const onClick = vi.fn();
    render(<PrintIconButton onClick={onClick} />);
    await userEvent.click(screen.getByRole('button', { name: '导出 PDF' }));
    expect(onClick).toHaveBeenCalledTimes(1);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

```bash
cd apps/web && npx vitest run src/components/business/print/PrintPreview.test.tsx src/components/business/print/PrintIconButton.test.tsx
```

Expected: FAIL（模块不存在）。

- [ ] **Step 3: 写 `usePrint.ts`**

创建 `apps/web/src/components/business/print/usePrint.ts`：

```ts
import { useCallback } from 'react';

/** 图片最多等 3s：缺图不阻塞整份导出。 */
const IMAGE_TIMEOUT_MS = 3000;

/**
 * 返回一个打印动作：先等纸面内图片 decode（最长 3s），再调 window.print()。
 * 失败一律吞掉 —— 导出不该因为一张图抛错。
 */
export function usePdfPrint(): (root: HTMLElement | null) => Promise<void> {
  return useCallback(async (root: HTMLElement | null) => {
    if (root) {
      const imgs = Array.from(root.querySelectorAll('img'));
      if (imgs.length > 0) {
        const decoded = Promise.all(
          imgs.map((img) =>
            typeof img.decode === 'function' ? img.decode().catch(() => undefined) : Promise.resolve(),
          ),
        );
        await Promise.race([
          decoded,
          new Promise<void>((resolve) => {
            window.setTimeout(resolve, IMAGE_TIMEOUT_MS);
          }),
        ]);
      }
    }
    try {
      window.print();
    } catch {
      // jsdom / 受限环境不支持打印：不抛到 UI
    }
  }, []);
}
```

- [ ] **Step 4: 写 `PrintIconButton.tsx`**

创建 `apps/web/src/components/business/print/PrintIconButton.tsx`：

```tsx
/** 答题页右上角动作区的导出入口：与 DraftIconButton 同尺寸同风格（32px 线性 SVG）。 */
export function PrintIconButton({ onClick }: { onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="w-8 h-8 rounded-lg border border-[var(--bg-subtle)] bg-[var(--learn-card-bg)] flex items-center justify-center text-[var(--text-tertiary)] hover:bg-[var(--bg-base)] transition-colors"
      title="导出 PDF"
      aria-label="导出 PDF"
    >
      <svg
        width="16"
        height="16"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <path d="M6 9V2h12v7" />
        <path d="M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2" />
        <rect x="6" y="14" width="12" height="8" />
      </svg>
    </button>
  );
}
```

- [ ] **Step 5: 写 `PrintPreview.tsx`**

创建 `apps/web/src/components/business/print/PrintPreview.tsx`：

```tsx
import { useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import { PrintPaper, type PrintMeta } from './PrintPaper';
import { usePdfPrint } from './usePrint';
import type { RunnerQuestion } from '@/components/business/answer/types';

interface PrintPreviewProps {
  open: boolean;
  questions: RunnerQuestion[];
  meta?: PrintMeta;
  onClose: () => void;
}

export function PrintPreview({ open, questions, meta, onClose }: PrintPreviewProps) {
  const sheetRef = useRef<HTMLDivElement>(null);
  const print = usePdfPrint();

  useEffect(() => {
    if (!open) return;
    document.body.classList.add('print-open');
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => {
      document.body.classList.remove('print-open');
      window.removeEventListener('keydown', onKeyDown);
    };
  }, [open, onClose]);

  if (!open) return null;

  return createPortal(
    <div className="print-portal" role="dialog" aria-modal="true" aria-label="打印预览">
      <div className="print-toolbar">
        <p className="print-toolbar-hint">在打印面板中选择「另存为 PDF」，并关闭「页眉和页脚」</p>
        <div className="print-toolbar-actions">
          <button
            type="button"
            className="print-btn print-btn--primary"
            onClick={() => void print(sheetRef.current)}
          >
            导出 PDF
          </button>
          <button type="button" className="print-btn" onClick={onClose}>
            关闭
          </button>
        </div>
      </div>

      <div className="print-scroll">
        <PrintPaper ref={sheetRef} questions={questions} meta={meta} />
      </div>
    </div>,
    document.body,
  );
}
```

- [ ] **Step 6: 跑测试确认通过**

```bash
cd apps/web && npx vitest run src/components/business/print/PrintPreview.test.tsx src/components/business/print/PrintIconButton.test.tsx
```

Expected: 4 passed。

- [ ] **Step 7: 类型检查 + 提交**

```bash
cd apps/web && npx tsc -b
git add apps/web/src/components/business/print/
git commit -m "feat(web): 新增打印预览层、打印动作与导出图标"
```

---

### Task 3: 结果弹窗导出入口

**Files:**
- Modify: `apps/web/src/components/business/AnswerResultList.tsx`（`Props` 约 29-49 行；函数签名 64-74 行；Footer 约 362-371 行）
- Modify: `apps/web/src/components/business/AnswerResultList.test.tsx`

**Interfaces:**
- Produces: `AnswerResultList` 新增可选 prop `onExport?: () => void`；不传时底部布局与现在完全一致。

- [ ] **Step 1: 写失败的测试**

在 `apps/web/src/components/business/AnswerResultList.test.tsx` 顶部把 vitest 导入改为：

```ts
import { afterEach, describe, expect, it, vi } from 'vitest';
```

并在文件头部补：

```ts
import userEvent from '@testing-library/user-event';
```

在文件末尾追加：

```tsx
describe('AnswerResultList 导出入口', () => {
  it('传 onExport 时出现「导出 PDF」并可点击', async () => {
    const onExport = vi.fn();
    render(
      <AnswerResultList
        questions={[{ n: '1', text: '题面' }]}
        answers={{ '1': { isCorrect: true, method: 'exact', studentAnswer: 'A' } }}
        onClose={() => {}}
        onExport={onExport}
      />,
    );
    await userEvent.click(screen.getByRole('button', { name: '导出 PDF' }));
    expect(onExport).toHaveBeenCalledTimes(1);
  });

  it('不传 onExport 时不渲染「导出 PDF」', () => {
    render(
      <AnswerResultList
        questions={[{ n: '1', text: '题面' }]}
        answers={{ '1': { isCorrect: true, method: 'exact', studentAnswer: 'A' } }}
        onClose={() => {}}
      />,
    );
    expect(screen.queryByRole('button', { name: '导出 PDF' })).toBeNull();
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

```bash
cd apps/web && npx vitest run src/components/business/AnswerResultList.test.tsx
```

Expected: FAIL（`onExport` 不存在 / 找不到按钮）。

- [ ] **Step 3: 加 prop 与按钮**

在 `Props` 接口末尾（`onSelfAssess` 之后）加：

```ts
  /** 结果页导出当前题单为 PDF（专项/错题页传；考试结果页不传） */
  onExport?: () => void;
```

在函数参数解构里加 `onExport`：

```tsx
export function AnswerResultList({
  questions,
  answers,
  onClose,
  headerExtra,
  initialExplanations = {},
  questionIdOf,
  onWaitExplanation,
  referenceAnswers,
  onSelfAssess,
  onExport,
}: Props) {
```

把 Footer：

```tsx
        {/* ═══ Footer ═══ */}
        <div className="shrink-0 px-5 py-3 border-t border-[var(--bg-subtle)] flex justify-center">
          <button
            onClick={onClose}
            className="px-8 py-2.5 rounded-[10px] bg-[var(--brand-500)] text-white text-sm font-semibold hover:bg-[var(--brand-600)] transition-colors shadow-sm"
          >
            确认
          </button>
        </div>
```

改成：

```tsx
        {/* ═══ Footer ═══ */}
        <div className="shrink-0 px-5 py-3 border-t border-[var(--bg-subtle)] flex items-center justify-center gap-3">
          {onExport && (
            <button
              onClick={onExport}
              className="px-5 py-2.5 rounded-[10px] border border-[var(--bg-subtle)] text-sm font-semibold text-[var(--text-secondary)] hover:bg-[var(--bg-base)] transition-colors"
            >
              导出 PDF
            </button>
          )}
          <button
            onClick={onClose}
            className="px-8 py-2.5 rounded-[10px] bg-[var(--brand-500)] text-white text-sm font-semibold hover:bg-[var(--brand-600)] transition-colors shadow-sm"
          >
            确认
          </button>
        </div>
```

- [ ] **Step 4: 跑测试确认通过**

```bash
cd apps/web && npx vitest run src/components/business/AnswerResultList.test.tsx
```

Expected: 全部 passed（既有用例 + 2 个新用例）。

- [ ] **Step 5: 提交**

```bash
git add apps/web/src/components/business/AnswerResultList.tsx \
  apps/web/src/components/business/AnswerResultList.test.tsx
git commit -m "feat(web): 结果弹窗支持导出 PDF"
```

---

### Task 4: 专项答题页接线

**Files:**
- Modify: `apps/web/src/pages/student/training/TargetedRunPage.tsx`（导入区/`draftOpen` 状态附近/`AnswerResultList` props/右上角动作组/尾部）

**Interfaces:**
- Consumes: `PrintIconButton`、`PrintPreview`、`PrintPaper` 的 `PrintMeta`。
- Produces: 无对外导出；页面行为变化（顶栏与结果弹窗都能打开预览）。

- [ ] **Step 1: 引入组件并加状态**

在导入区加：

```tsx
import { PrintIconButton } from '@/components/business/print/PrintIconButton';
import { PrintPreview } from '@/components/business/print/PrintPreview';
```

在 `const [draftOpen, setDraftOpen] = useState(false);` 下一行加：

```tsx
  // 打印预览：答题态与结果态共用同一个入口
  const [printOpen, setPrintOpen] = useState(false);
```

- [ ] **Step 2: 结果弹窗加导出回调**

在 `AnswerResultList` 的 props 里、`onClose={...}` 之后加一行：

```tsx
            onExport={() => setPrintOpen(true)}
```

注意：传的是 `questions`（页面里的 `RunnerQuestion[]`），不要再加 `resultQuestions` 相关改动。

- [ ] **Step 3: 拆右上角动作组**

把：

```tsx
            {!draftOpen && (
              <div className="absolute top-4 right-4">
                <DraftIconButton onClick={() => setDraftOpen(true)} />
              </div>
            )}
```

改成：

```tsx
            {/* 导出常驻；草稿仍随面板开合（DOM 顺序说明见下方 DiscussDrawer） */}
            <div className="absolute top-4 right-4 flex items-center gap-2">
              <PrintIconButton onClick={() => setPrintOpen(true)} />
              {!draftOpen && <DraftIconButton onClick={() => setDraftOpen(true)} />}
            </div>
```

- [ ] **Step 4: 挂预览层**

在同级 `<RunExitGuard` 元素之前加：

```tsx
        <PrintPreview
          open={printOpen}
          questions={questions}
          meta={{ subject: subjectName(subjectId) }}
          onClose={() => setPrintOpen(false)}
        />
```

（`subjectName` 本页已导入，无需新增。）

- [ ] **Step 5: 类型检查 + 手工冒烟**

```bash
cd apps/web && npx tsc -b
```

手工：`npm run dev`，登录学生 → 数学专项 → 选 3 题 → 进入答题页 → 点右上角打印机图标 → 预览出现 3 道题 → 点「导出 PDF」→ 打印面板选「另存为 PDF」。答完题后在结果弹窗底部再点一次「导出 PDF」。

- [ ] **Step 6: 提交**

```bash
git add apps/web/src/pages/student/training/TargetedRunPage.tsx
git commit -m "feat(web): 专项答题页接入导出 PDF"
```

---

### Task 5: 错题答题页接线

**Files:**
- Modify: `apps/web/src/pages/student/training/ErrorPracticeRunPage.tsx`（导入区/`draftOpen` 附近/`AnswerResultList` props/右上角动作组/尾部）

**Interfaces:**
- Consumes: 同 Task 4。
- Produces: 无。

- [ ] **Step 1: 引入组件、状态与 `subjectName`**

把：

```tsx
import { parseSubjectId } from '@/constants';
```

改成：

```tsx
import { parseSubjectId, subjectName } from '@/constants';
```

在导入区加：

```tsx
import { PrintIconButton } from '@/components/business/print/PrintIconButton';
import { PrintPreview } from '@/components/business/print/PrintPreview';
```

在 `const [draftOpen, setDraftOpen] = useState(false);` 下一行加：

```tsx
  const [printOpen, setPrintOpen] = useState(false);
```

- [ ] **Step 2: 结果弹窗加导出回调**

在 `AnswerResultList` 的 `onClose={...}` 之后加：

```tsx
                onExport={() => setPrintOpen(true)}
```

- [ ] **Step 3: 拆右上角动作组**

把：

```tsx
            {!draftOpen && (
              <div className="absolute top-4 right-4">
                <DraftIconButton onClick={() => setDraftOpen(true)} />
              </div>
            )}
```

改成：

```tsx
            <div className="absolute top-4 right-4 flex items-center gap-2">
              <PrintIconButton onClick={() => setPrintOpen(true)} />
              {!draftOpen && <DraftIconButton onClick={() => setDraftOpen(true)} />}
            </div>
```

- [ ] **Step 4: 挂预览层**

在同级 `<RunExitGuard` 元素之前加：

```tsx
        <PrintPreview
          open={printOpen}
          questions={questions}
          meta={{ subject: subjectName(subjectId) }}
          onClose={() => setPrintOpen(false)}
        />
```

- [ ] **Step 5: 类型检查 + 手工冒烟**

```bash
cd apps/web && npx tsc -b
```

手工：数学错题本 → 进入错题练习 → 点导出 → 选项完整、无材料（预期缺失，spec §4.1.1）。

- [ ] **Step 6: 提交**

```bash
git add apps/web/src/pages/student/training/ErrorPracticeRunPage.tsx
git commit -m "feat(web): 错题答题页接入导出 PDF"
```

---

### Task 6: 变式与补偿相似题页接线

**Files:**
- Modify: `apps/web/src/pages/student/training/VariationRunPage.tsx`（导入区/`draftOpen` 附近/右上角动作组/尾部）
- Modify: `apps/web/src/pages/student/training/RemediationRunPage.tsx`（同上）

**Interfaces:**
- Consumes: 同 Task 4。
- Produces: 无。两页都没有结果弹窗，只在答题态提供导出。

- [ ] **Step 1: 变式页接线**

在 `VariationRunPage.tsx` 导入区加：

```tsx
import { PrintIconButton } from '@/components/business/print/PrintIconButton';
import { PrintPreview } from '@/components/business/print/PrintPreview';
```

在 `const [draftOpen, setDraftOpen] = useState(false);` 下一行加：

```tsx
  const [printOpen, setPrintOpen] = useState(false);
```

把：

```tsx
        {/* 草稿入口：背景层右上角 absolute（DOM 顺序说明同 RemediationRunPage） */}
        {!draftOpen && (
          <div className="absolute top-4 right-4">
            <DraftIconButton onClick={() => setDraftOpen(true)} />
          </div>
        )}
```

改成：

```tsx
        {/* 导出与草稿入口：背景层右上角 absolute（DOM 顺序说明同 RemediationRunPage） */}
        <div className="absolute top-4 right-4 flex items-center gap-2">
          <PrintIconButton onClick={() => setPrintOpen(true)} />
          {!draftOpen && <DraftIconButton onClick={() => setDraftOpen(true)} />}
        </div>
```

在同级 `<RunExitGuard` 元素之前加：

```tsx
        <PrintPreview
          open={printOpen}
          questions={questions}
          meta={{ subject: '数学' }}
          onClose={() => setPrintOpen(false)}
        />
```

- [ ] **Step 2: 补偿页接线**

在 `RemediationRunPage.tsx` 导入区加：

```tsx
import { PrintIconButton } from '@/components/business/print/PrintIconButton';
import { PrintPreview } from '@/components/business/print/PrintPreview';
```

在 `const [draftOpen, setDraftOpen] = useState(false);` 下一行加：

```tsx
  const [printOpen, setPrintOpen] = useState(false);
```

把：

```tsx
        {!draftOpen && (
          <div className="absolute top-4 right-4">
            <DraftIconButton onClick={() => setDraftOpen(true)} />
          </div>
        )}
```

改成：

```tsx
        <div className="absolute top-4 right-4 flex items-center gap-2">
          <PrintIconButton onClick={() => setPrintOpen(true)} />
          {!draftOpen && <DraftIconButton onClick={() => setDraftOpen(true)} />}
        </div>
```

在同级 `<RunExitGuard` 元素之前加：

```tsx
        <PrintPreview
          open={printOpen}
          questions={questions}
          meta={{ subject: '数学' }}
          onClose={() => setPrintOpen(false)}
        />
```

- [ ] **Step 3: 类型检查 + 手工冒烟**

```bash
cd apps/web && npx tsc -b
```

手工：错题本 → 变式练习（有 pending 变式时）→ 点导出；补偿套题（答错后点「补这个」）→ 点导出。

- [ ] **Step 4: 提交**

```bash
git add apps/web/src/pages/student/training/VariationRunPage.tsx \
  apps/web/src/pages/student/training/RemediationRunPage.tsx
git commit -m "feat(web): 变式与补偿页接入导出 PDF"
```

---

### Task 7: 文档同步与全量验证

**Files:**
- Modify: `docs/UX-UI设计文档.md`（在 `### 5.13` 与 `## 6` 之间插入 `### 5.14`）
- Modify: `docs/constraints/专项子系统.md`（末尾追加）

**Interfaces:**
- 无代码接口。

- [ ] **Step 1: 补 UX 文档**

在 `docs/UX-UI设计文档.md` 的 `### 5.13 训练轨：选科页六卡 + 物/化/道法参数化（2026-10-31）` 一节结束后、`## 6. 交互规范` 之前，插入：

```markdown
### 5.14 训练轨：答题页导出 PDF（2026-11-18）

**入口**
- 四个答题页（专项 / 错题 / 变式 / 补偿相似题）右上角动作组：`导出` 图标常驻，`草稿` 图标仍随面板开合。
- 专项与错题的结果弹窗底部：「导出 PDF」次级按钮 + 「确认」主按钮，居中并排。
- 变式与补偿答完直接离开，没有结果弹窗，只有答题态入口。

**预览层**
- 全屏遮罩 + 顶部工具栏（左：一行操作提示；右：「导出 PDF」主按钮、「关闭」）。
- 纸面按 A4 纵向 210mm 宽展示；窄屏横向滚动，不缩放。
- `Esc` 与「关闭」退出；打开时锁页面滚动。

**纸面**
- 页首一行小字：`{学科}专项 · {N} 题` + 日期。
- 题号连续 1..N；选择题印选项，填空留 24mm、主观题留 52mm、未知题型留 40mm 空白。
- 相邻同材料只印一次。
- 只印题干与选项，不印答案、解析、学生作答。
- 固定白底黑字，不随日夜模式变化。

**保存位置**
- 系统打印面板 → 目的地「另存为 PDF」→ 选择目录；Web 与 PC App 一致。
- 工具栏提示一行：在打印面板中选择「另存为 PDF」，并关闭「页眉和页脚」。
```

- [ ] **Step 2: 补约束文档**

在 `docs/constraints/专项子系统.md` 末尾追加：

```markdown

## 导出 PDF（2026-11-18）

- 四个答题页共用 `components/business/print/*`：`PrintPaper`（纸面）、`PrintPreview`（portal 预览）、`usePdfPrint`（等图片后 `window.print()`）、`print.css`。
- **导出恒传页面里的 `questions`（`RunnerQuestion[]`），不得传 `resultQuestions`**：后者是结果弹窗专用形状，缺 `options`，会导出没有选项的卷子。
- 错题 / 变式 / 补偿三个接口不返回材料字段，这三页的 PDF 没有共享材料；要补必须扩后端 DTO，不要在打印组件里假装有。
- 打印只隐藏 `body > *:not(.print-portal)`，不是只隐藏 `#root`：图片放大浮层也 portal 到 body。
- 纸面在 `#root` 外，拿不到主题 token，颜色由 `.print-sheet` 自带；不要改成继承页面主题。
```

- [ ] **Step 3: 全量验证**

```bash
cd apps/web && npx tsc -b && npm run lint && npm test
```

Expected: 0 error、所有测试 passed。

- [ ] **Step 4: 手工验收（必须真机）**

1. Chrome 里走一遍数学专项 3 题：预览公式、图片、分页、页眉是否正常。
2. 打印面板选「另存为 PDF」，确认可以选目录、生成文件可打开。
3. 夜间模式下再导一次：PDF 仍是白底黑字。
4. PC App（`bash tools/app-build.sh` 出的包或本机 Electron）点「导出 PDF」，确认打印面板能弹出。**若弹不出，停下来记录现象**，按 spec §9 与用户确认窄 IPC 兜底，不要自行改 `preload.js`。

- [ ] **Step 5: 提交**

```bash
git add docs/UX-UI设计文档.md docs/constraints/专项子系统.md
git commit -m "docs: 补充答题页导出 PDF 的交互与约束"
```

---

## 自检结果（写计划时已核对）

- **spec 覆盖**：§2.1 的 5 项 → Task 1/2/4/5/6；§4.1 输入口径 → Task 4 Step 2；§4.1.1 材料限制 → Task 5/7；§4.2 渲染规则 → Task 1；§4.3 页眉 → Task 1；§5 组件与样式 → Task 1/2；§6 交互 → Task 2/3；§7 边界 → Task 1/2；§8 测试 → Task 1/2/3；§9 PC App → Task 7 手工验收；§10 文档 → Task 7。
- **类型一致**：`PrintMeta` / `PrintPreview` props / `usePdfPrint` 签名在 Task 1 定义、Task 2 消费、Task 4-6 复用，名称一致。
- **无占位符**：所有步骤含完整代码或完整命令。
