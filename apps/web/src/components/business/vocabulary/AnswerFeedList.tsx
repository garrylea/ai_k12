import type { VocabularyJudgeResult, VocabularyQuestionItem } from '@/services/api';
import SpellingDiffView from './SpellingDiffView';

/** 一道题的作答与判定状态。 */
export interface FeedEntry {
  question: VocabularyQuestionItem;
  /** 学生提交的原文（用于回显） */
  answer: string;
  /** 已提交（判题中或已判完）。false = 还没答到这道题 */
  submitted: boolean;
  /** 判定结果；判题请求在途时为 undefined */
  result?: VocabularyJudgeResult;
  /** 判题请求失败了（网络/500） */
  failed?: boolean;
}

interface Props {
  entries: FeedEntry[];
  collapsed: boolean;
  onToggleCollapsed: () => void;
  /** 「移除易错标记」：只清学生自己的错次 */
  onClearMark: (wordId: number) => void;
  /** 已清过标记的词（本地状态，避免重复请求） */
  cleared: Record<number, boolean>;
}

/** 结论 → 标记与配色。`off_target` 单独一档：学生答的没错，只是没答到考点。 */
const MARK: Record<string, { icon: string; className: string; label: string }> = {
  correct: { icon: '✓', className: 'text-[var(--success)]', label: '答对了' },
  off_target: { icon: '△', className: 'text-[var(--warning)]', label: '未答到考点' },
  wrong: { icon: '✗', className: 'text-[var(--error)]', label: '答错了' },
  unanswered: { icon: '—', className: 'text-[var(--text-secondary)]', label: '未作答' },
  undetermined: { icon: '?', className: 'text-[var(--text-secondary)]', label: '判题失败' },
};

/**
 * 底部累积清单：异步判定的落点。
 *
 * 提交后**立刻**翻到下一个词（不等判定回来），判定回来再往这里追加一行；
 * 所以这张清单同时承担「上一题答得怎么样」和「本轮成绩单」两个职责。
 * 可收起——iPad 竖屏下要收起才够位置出题面。
 *
 * 判题失败/未作答**不显示**错误统计口径的标记（它们不计错，见服务端口径），
 * 但仍列出，让学生知道那道题没判成。
 */
/**
 * 「移除易错标记」图标：圆形对勾（线性 SVG —— 项目硬规则禁 emoji、图标必须线性 SVG）。
 *
 * 用**对勾**而不是叉：这个动作的语义是「这个词我已掌握，别再算我易错」，
 * **不是删除数据**（全局错次与学生自己的 learned 都不动），叉会让人以为在删记录。
 * 圆形把它与行首那个纯字符状态标记（✓ / △ / ✗）区分开。
 */
const ClearMarkIcon = () => (
  <svg
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.8"
    strokeLinecap="round"
    strokeLinejoin="round"
    className="h-4 w-4"
    aria-hidden="true"
  >
    <circle cx="12" cy="12" r="9" />
    <path d="M8 12.5l2.5 2.5L16 9.5" />
  </svg>
);

export default function AnswerFeedList({
  entries,
  collapsed,
  onToggleCollapsed,
  onClearMark,
  cleared,
}: Props) {
  const answered = entries.filter((e) => e.submitted);
  if (answered.length === 0) return null;

  const counts = answered.reduce(
    (acc, e) => {
      const v = e.result?.verdict;
      if (v === 'correct') acc.correct += 1;
      else if (v === 'off_target') acc.offTarget += 1;
      else if (v === 'wrong') acc.wrong += 1;
      return acc;
    },
    { correct: 0, offTarget: 0, wrong: 0 },
  );

  return (
    <div
      className="mt-8 rounded-2xl bg-white"
      style={{ border: '1px solid rgba(226, 232, 240, 0.8)' }}
      data-testid="answer-feed"
    >
      <button
        onClick={onToggleCollapsed}
        aria-expanded={!collapsed}
        className="flex w-full items-center justify-between px-4 py-3 text-sm"
      >
        <span className="font-bold text-[var(--text-primary)]">
          本轮 {answered.length} / {entries.length}
          <span className="ml-3 font-normal text-[var(--text-secondary)]">
            对 {counts.correct} · 未答到考点 {counts.offTarget} · 错 {counts.wrong}
          </span>
        </span>
        <span className="text-[var(--text-secondary)]">{collapsed ? '展开' : '收起'}</span>
      </button>

      {!collapsed && (
        <ul className="border-t border-[var(--bg-subtle)] px-4 py-2">
          {/* **倒序显示**：最近答的排最前（刚答完最关心的就是刚才那条），最早的在最后。
              数据本身仍是时间顺序 —— 汇总计数与「本轮 N/M」都不受显示顺序影响。 */}
          {answered.slice().reverse().map((e) => {
            const m = e.result ? MARK[e.result.verdict] : null;
            return (
              <li
                key={`${e.question.wordId}-${e.question.senseIndex}`}
                className="flex flex-col gap-1 border-b border-[var(--bg-subtle)] py-2.5 last:border-b-0"
                data-testid={`feed-row-${e.question.wordId}`}
              >
                <div className="flex items-baseline gap-2">
                  <span className={`w-4 text-center ${m?.className ?? 'text-[var(--text-secondary)]'}`}>
                    {m?.icon ?? '…'}
                  </span>
                  {/* 题面：英→中是单词、中→英是中文释义，两者都直接回显学生看到的题面 */}
                  <span className="font-medium text-[var(--text-primary)]">{e.question.prompt}</span>
                  {e.question.isExtendedSense && (
                    <span className="rounded bg-[var(--bg-subtle)] px-1.5 py-0.5 text-xs text-[var(--warning)]">
                      熟词僻义
                    </span>
                  )}
                  {m && <span className="text-xs text-[var(--text-secondary)]">{m.label}</span>}

                  {/* 「移除易错标记」只对答错的词显示：它清的是上一轮累计的错次 */}
                  {e.result?.verdict === 'wrong' && !cleared[e.question.wordId] && (
                    <button
                      onClick={() => onClearMark(e.question.wordId)}
                      aria-label="移除易错标记"
                      title="移除易错标记"
                      className="ml-auto text-[var(--text-secondary)] transition-colors hover:text-[var(--brand-500)]"
                      data-testid={`clear-mark-${e.question.wordId}`}
                    >
                      <ClearMarkIcon />
                    </button>
                  )}
                  {cleared[e.question.wordId] && (
                    <span className="ml-auto text-xs text-[var(--text-secondary)]">已移除标记</span>
                  )}
                </div>

                {/* 标准释义：判完就该让学生看见 */}
                {e.result && (
                  <div className="ml-6 text-sm text-[var(--text-secondary)]">
                    <span className="text-[var(--text-primary)]">
                      {e.result.standard.meanings
                        .map((mm) => `${mm.pos}${mm.gloss}`)
                        .join(' / ')}
                    </span>
                    {e.result.verdict === 'off_target' && e.result.comment && (
                      <span className="ml-2 text-[var(--warning)]">{e.result.comment}</span>
                    )}
                  </div>
                )}

                {/* 中→英答错：拼写差异高亮 */}
                {e.result?.spellingDiff && e.result.spellingDiff.length > 0 && (
                  <div className="ml-6">
                    <SpellingDiffView
                      ops={e.result.spellingDiff}
                      expected={e.result.standard.word}
                    />
                  </div>
                )}

                {e.failed && (
                  <div className="ml-6 text-xs text-[var(--error)]">判题请求失败，这道题没判成</div>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
