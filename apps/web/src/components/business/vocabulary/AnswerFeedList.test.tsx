import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, fireEvent } from '@testing-library/react';
import AnswerFeedList, { type FeedEntry } from './AnswerFeedList';
import WordFamilyTree from './WordFamilyTree';
import SpellingDiffView from './SpellingDiffView';
import type { VocabularyJudgeResult, VocabularyQuestionItem } from '@/services/api';

// globals:false → 必须自己写 cleanup（同 SentenceBlock.test / QuestionRunner.test）
afterEach(() => cleanup());

const question = (over: Partial<VocabularyQuestionItem> = {}): VocabularyQuestionItem => ({
  wordId: 1,
  senseIndex: 0,
  promptKind: 'en2cn',
  prompt: 'address',
  phonetic: '/əˈdres/',
  context: null,
  isExtendedSense: false,
  hasFamily: false,
  ...over,
});

const judgeResult = (over: Partial<VocabularyJudgeResult> = {}): VocabularyJudgeResult => ({
  wordId: 1,
  senseIndex: 0,
  verdict: 'wrong',
  method: 'exact',
  standard: {
    word: 'address',
    phonetic: '/əˈdres/',
    meanings: [
      { pos: 'n.', gloss: '地址', extended: false },
      { pos: 'v.', gloss: '处理；对付（问题）', extended: true, context: 'address the problem' },
    ],
    target: { pos: 'n.', gloss: '地址', extended: false },
  },
  spellingDiff: null,
  comment: null,
  familyAvailable: false,
  progress: { learned: false, wrongCount: 1 },
  ...over,
});

const entry = (over: Partial<FeedEntry> = {}): FeedEntry => ({
  question: question(),
  answer: '住址',
  submitted: true,
  ...over,
});

// ==================== AnswerFeedList ====================

describe('AnswerFeedList', () => {
  it('没答过题就不渲染（不占屏幕）', () => {
    const { container } = render(
      <AnswerFeedList
        entries={[entry({ submitted: false })]}
        collapsed={false}
        onToggleCollapsed={vi.fn()}
        onClearMark={vi.fn()}
        cleared={{}}
      />,
    );
    expect(container).toBeEmptyDOMElement();
  });

  it('三个结论各有自己的标记与文案（off_target 单独一档）', () => {
    render(
      <AnswerFeedList
        entries={[
          entry({ question: question({ wordId: 1, prompt: 'care' }), result: judgeResult({ verdict: 'correct' }) }),
          entry({ question: question({ wordId: 2, prompt: 'address' }), result: judgeResult({ wordId: 2, verdict: 'off_target' }) }),
          entry({ question: question({ wordId: 3, prompt: 'book' }), result: judgeResult({ wordId: 3, verdict: 'wrong' }) }),
        ]}
        collapsed={false}
        onToggleCollapsed={vi.fn()}
        onClearMark={vi.fn()}
        cleared={{}}
      />,
    );
    expect(screen.getByText('答对了')).toBeInTheDocument();
    expect(screen.getByText('未答到考点')).toBeInTheDocument();
    expect(screen.getByText('答错了')).toBeInTheDocument();
    // 汇总条上的三档计数
    expect(screen.getByText(/对 1 · 未答到考点 1 · 错 1/)).toBeInTheDocument();
  });

  it('判题结果里带标准释义，学生判完就能看见', () => {
    render(
      <AnswerFeedList
        entries={[entry({ result: judgeResult() })]}
        collapsed={false}
        onToggleCollapsed={vi.fn()}
        onClearMark={vi.fn()}
        cleared={{}}
      />,
    );
    expect(screen.getByText(/n\.地址/)).toBeInTheDocument();
    expect(screen.getByText(/v\.处理；对付（问题）/)).toBeInTheDocument();
  });

  it('熟词僻义题有标记', () => {
    render(
      <AnswerFeedList
        entries={[
          entry({
            question: question({ isExtendedSense: true, context: 'address the problem' }),
            result: judgeResult({ verdict: 'off_target' }),
          }),
        ]}
        collapsed={false}
        onToggleCollapsed={vi.fn()}
        onClearMark={vi.fn()}
        cleared={{}}
      />,
    );
    expect(screen.getByText('熟词僻义')).toBeInTheDocument();
  });

  it('「移除易错标记」只出现在答错的词上（答对/未答到考点没有可清的错次）', () => {
    render(
      <AnswerFeedList
        entries={[
          entry({ question: question({ wordId: 1, prompt: 'care' }), result: judgeResult({ wordId: 1, verdict: 'correct' }) }),
          entry({ question: question({ wordId: 3, prompt: 'book' }), result: judgeResult({ wordId: 3, verdict: 'wrong' }) }),
        ]}
        collapsed={false}
        onToggleCollapsed={vi.fn()}
        onClearMark={vi.fn()}
        cleared={{}}
      />,
    );
    // 按钮现在只显示图标（线性 SVG），靠 aria-label 找而不是文本
    expect(screen.getAllByLabelText('移除易错标记')).toHaveLength(1);
    expect(screen.getByTestId('clear-mark-3')).toBeInTheDocument();
  });

  it('图标是线性 SVG（项目硬规则：禁 emoji）', () => {
    render(
      <AnswerFeedList
        entries={[entry({ question: question({ wordId: 3 }), result: judgeResult({ wordId: 3, verdict: 'wrong' }) })]}
        collapsed={false}
        onToggleCollapsed={vi.fn()}
        onClearMark={vi.fn()}
        cleared={{}}
      />,
    );
    const btn = screen.getByTestId('clear-mark-3');
    const svg = btn.querySelector('svg');
    expect(svg).not.toBeNull();
    expect(svg?.getAttribute('fill')).toBe('none');       // 线性而非实心
    expect(svg?.querySelector('circle')).not.toBeNull();  // 对勾在圆内
  });

  it('行按**倒序**显示：最近答的在最前，最早的在最后', () => {
    // 数据本身是时间顺序，组件负责倒序展示 —— 学生刚答完最关心刚才那条。
    render(
      <AnswerFeedList
        entries={[
          entry({ question: question({ wordId: 1, prompt: 'aaa' }), result: judgeResult({ wordId: 1, verdict: 'correct' }) }),
          entry({ question: question({ wordId: 2, prompt: 'bbb' }), result: judgeResult({ wordId: 2, verdict: 'correct' }) }),
          entry({ question: question({ wordId: 3, prompt: 'ccc' }), result: judgeResult({ wordId: 3, verdict: 'correct' }) }),
        ]}
        collapsed={false}
        onToggleCollapsed={vi.fn()}
        onClearMark={vi.fn()}
        cleared={{}}
      />,
    );
    const rows = screen.getAllByTestId(/^feed-row-/);
    expect(rows.map((r) => r.getAttribute('data-testid'))).toEqual([
      'feed-row-3',
      'feed-row-2',
      'feed-row-1',
    ]);
  });

  it('点「移除易错标记」回调 wordId', () => {
    const onClearMark = vi.fn();
    render(
      <AnswerFeedList
        entries={[entry({ question: question({ wordId: 7 }), result: judgeResult({ wordId: 7, verdict: 'wrong' }) })]}
        collapsed={false}
        onToggleCollapsed={vi.fn()}
        onClearMark={onClearMark}
        cleared={{}}
      />,
    );
    fireEvent.click(screen.getByTestId('clear-mark-7'));
    expect(onClearMark).toHaveBeenCalledWith(7);
  });

  it('已清过标记的词：换成绿色图标 + 悬停说明，不再给可点按钮（防重复请求）', () => {
    render(
      <AnswerFeedList
        entries={[entry({ question: question({ wordId: 7 }), result: judgeResult({ wordId: 7, verdict: 'wrong' }) })]}
        collapsed={false}
        onToggleCollapsed={vi.fn()}
        onClearMark={vi.fn()}
        cleared={{ 7: true }}
      />,
    );
    const done = screen.getByTestId('mark-cleared-7');
    expect(done.getAttribute('title')).toBe('已移除易错标记');   // 悬停能看到功能
    expect(done.querySelector('svg')).not.toBeNull();            // 是图标而非文字
    expect(screen.queryByTestId('clear-mark-7')).toBeNull();     // 不再可点
  });

  it('判题失败/未作答也列出（让学生知道那道题没判成），但不进错误统计', () => {
    render(
      <AnswerFeedList
        entries={[
          entry({ question: question({ wordId: 5 }), failed: true }),
          entry({ question: question({ wordId: 6 }), answer: '', result: judgeResult({ wordId: 6, verdict: 'unanswered' }) }),
        ]}
        collapsed={false}
        onToggleCollapsed={vi.fn()}
        onClearMark={vi.fn()}
        cleared={{}}
      />,
    );
    expect(screen.getByText('判题请求失败，这道题没判成')).toBeInTheDocument();
    expect(screen.getByText('未作答')).toBeInTheDocument();
    expect(screen.getByText(/对 0 · 未答到考点 0 · 错 0/)).toBeInTheDocument();
  });

  it('中→英答错时显示拼写差异', () => {
    render(
      <AnswerFeedList
        entries={[
          entry({
            answer: 'adress',
            result: judgeResult({
              verdict: 'wrong',
              spellingDiff: [
                { type: 'equal', text: 'ad' },
                { type: 'wrong', actual: '', expected: 'd' },
                { type: 'equal', text: 'ress' },
              ],
            }),
          }),
        ]}
        collapsed={false}
        onToggleCollapsed={vi.fn()}
        onClearMark={vi.fn()}
        cleared={{}}
      />,
    );
    expect(screen.getByTestId('spelling-diff')).toBeInTheDocument();
  });

  it('收起时只留汇总条，不列出各行', () => {
    render(
      <AnswerFeedList
        entries={[entry()]}
        collapsed
        onToggleCollapsed={vi.fn()}
        onClearMark={vi.fn()}
        cleared={{}}
      />,
    );
    expect(screen.getByText(/本轮 1 \/ 1/)).toBeInTheDocument();
    expect(screen.queryByTestId('feed-row-1')).toBeNull();
  });
});

// ==================== WordFamilyTree ====================

describe('WordFamilyTree', () => {
  it('渲染中心词 + 派生词 + 词缀注记', () => {
    render(
      <WordFamilyTree
        loading={false}
        failed={false}
        family={{
          root: { word: 'care', phonetic: '/keə(r)/', gloss: '照顾；小心' },
          members: [
            { word: 'care', phonetic: '/keə(r)/', gloss: '照顾；小心', pos: 'n.', affixes: [], isHead: true, level: 'junior' },
            {
              word: 'careless',
              phonetic: '/ˈkeələs/',
              gloss: '粗心的',
              pos: 'adj.',
              affixes: [{ type: 'suffix', code: '-less', gloss: '无…的', posHint: '→ 形容词' }],
              isHead: false,
              level: 'junior',
            },
          ],
        }}
      />,
    );
    expect(screen.getByTestId('word-family-tree')).toBeInTheDocument();
    expect(screen.getByText('careless')).toBeInTheDocument();
    // 词缀注记把「词缀 + 含义 + 词性提示」都带上，学生才学得到构词规律
    expect(screen.getByText(/-less 无…的 → 形容词/)).toBeInTheDocument();
  });

  it('中心词不重复列在派生词里', () => {
    render(
      <WordFamilyTree
        loading={false}
        failed={false}
        family={{
          root: { word: 'care', phonetic: null, gloss: '照顾' },
          members: [
            { word: 'care', phonetic: null, gloss: '照顾', pos: 'n.', affixes: [], isHead: true, level: 'junior' },
            { word: 'careful', phonetic: null, gloss: '仔细的', pos: 'adj.', affixes: [], isHead: false, level: 'junior' },
          ],
        }}
      />,
    );
    expect(screen.getAllByText('care')).toHaveLength(1);
    expect(screen.getByText('careful')).toBeInTheDocument();
  });

  it('族里只有中心词时给一句说明，不留空白', () => {
    render(
      <WordFamilyTree
        loading={false}
        failed={false}
        family={{
          root: { word: 'care', phonetic: null, gloss: '照顾' },
          members: [
            { word: 'care', phonetic: null, gloss: '照顾', pos: 'n.', affixes: [], isHead: true, level: 'junior' },
          ],
        }}
      />,
    );
    expect(screen.getByText('这个词还没有登记同族词')).toBeInTheDocument();
  });

  it('加载中 / 失败（含后端 404 无族）都有兜底文案', () => {
    const first = render(<WordFamilyTree loading family={null} failed={false} />);
    expect(screen.getByText('正在展开词根…')).toBeInTheDocument();
    first.unmount();
    render(<WordFamilyTree loading={false} family={null} failed />);
    expect(screen.getByText('这个词暂时没有词根关系可展开')).toBeInTheDocument();
  });
});

// ==================== SpellingDiffView ====================

describe('SpellingDiffView', () => {
  it('漏字母：正确拼写里把漏掉的字母标出来', () => {
    render(
      <SpellingDiffView
        ops={[
          { type: 'equal', text: 'ad' },
          { type: 'wrong', actual: '', expected: 'd' },
          { type: 'equal', text: 'ress' },
        ]}
        expected="address"
      />,
    );
    expect(screen.getByText('你的拼写：')).toBeInTheDocument();
    expect(screen.getByText('正确拼写：')).toBeInTheDocument();
    const highlighted = screen.getByText('d');
    expect(highlighted.className).toContain('text-[var(--success)]');
  });

  it('错字母：学生的错字划掉、正确字母高亮', () => {
    render(
      <SpellingDiffView
        ops={[
          { type: 'equal', text: 'chine' },
          { type: 'wrong', actual: 'z', expected: 's' },
          { type: 'equal', text: 'e' },
        ]}
        expected="chinese"
      />,
    );
    const wrong = screen.getByText('z');
    expect(wrong.className).toContain('line-through');
    const right = screen.getByText('s');
    expect(right.className).toContain('text-[var(--success)]');
  });

  it('差异为空时兜底显示标准答案（至少让学生看到正确形式）', () => {
    render(<SpellingDiffView ops={[]} expected="address" />);
    expect(screen.getByText('应为 address')).toBeInTheDocument();
  });
});
