import { forwardRef } from 'react';
import ReactMarkdown from 'react-markdown';
import {
  markdownComponents,
  markdownRehypePlugins,
  markdownRemarkPlugins,
  preprocessMarkdown,
} from '@/components/markdown';
import { MaterialBlock } from '@/components/business/answer/MaterialBlock';
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

  let lastUrl: string | null = null;
  let lastText: string | null = null;

  return (
    <div ref={ref} className="print-sheet" data-testid="print-sheet">
      <div className="print-head">
        <span>{title}</span>
        <span>{date}</span>
      </div>

      {questions.map((q, i) => {
        const url = q.materialUrl ?? null;
        const text = q.material?.trim() ? q.material : null;
        const showDoc = url !== null && url !== lastUrl;
        const showText = text !== null && text !== lastText;
        lastUrl = url;
        lastText = text;
        const options = optionsOf(q);
        const blank = answerSpaceClass(q.type);

        return (
          <section className="print-q" data-testid="print-question" key={q.n}>
            {/* 材料位置固定规则：文章（material_url）在题干上方 */}
            {showDoc && (
              <div className="print-material md-prose" data-testid="print-material">
                <MaterialBlock url={url} text={null} variant="print" />
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

            {/* 题中素材（material_text）在题干下方 */}
            {showText && (
              <div className="print-material md-prose" data-testid="print-material-text">
                <MaterialBlock url={null} text={text} variant="print" />
              </div>
            )}

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
