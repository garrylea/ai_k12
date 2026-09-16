import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, fireEvent } from '@testing-library/react';
import WordPromptCard from './WordPromptCard';
import type { VocabularyQuestionItem, WordFamilyResult } from '@/services/api';

// vitest globals:false 下 @testing-library/react 不会自动注册 afterEach cleanup，
// 需手动清理，否则上个用例的 DOM 泄漏导致选择器重复命中（同 SentenceBlock.test）。
afterEach(() => cleanup());

/**
 * 题面卡的渲染契约测试。
 *
 * **最重要的一条是防泄漏**：词根族树里必然包含单词本身（care 是 careful 的族中心），
 * 而中→英题的答案就是英文单词——「+」号一旦在中→英题上出现，点开就等于把答案递给学生。
 * 这是设计评审时专门挖出来的坑，用渲染测试钉住（只测服务层字段是不够的，
 * 组件完全可以在 hasFamily=false 时也把按钮画出来）。
 */

const question = (over: Partial<VocabularyQuestionItem> = {}): VocabularyQuestionItem => ({
  wordId: 1,
  senseIndex: 0,
  promptKind: 'en2cn',
  prompt: 'care',
  phonetic: '/keə(r)/',
  context: null,
  isExtendedSense: false,
  hasFamily: true,
  ...over,
});

const FAMILY: WordFamilyResult = {
  root: { word: 'care', phonetic: '/keə(r)/', gloss: '照顾；小心' },
  members: [
    { word: 'care', phonetic: '/keə(r)/', gloss: '照顾；小心', pos: 'n.', affixes: [], isHead: true, level: 'junior' },
    {
      word: 'careful',
      phonetic: '/ˈkeəfl/',
      gloss: '仔细的',
      pos: 'adj.',
      affixes: [{ type: 'suffix', code: '-ful', gloss: '充满…的', posHint: '→ 形容词' }],
      isHead: false,
      level: 'junior',
    },
  ],
};

function renderCard(over: Partial<React.ComponentProps<typeof WordPromptCard>> = {}) {
  const props = {
    question: question(),
    value: '',
    onChange: vi.fn(),
    onSubmit: vi.fn(),
    onSkip: vi.fn(),
    familyOpen: false,
    family: null,
    familyLoading: false,
    familyFailed: false,
    onToggleFamily: vi.fn(),
    ...over,
  };
  const { unmount } = render(<WordPromptCard {...props} />);
  return { ...props, unmount };
}

describe('WordPromptCard — 防泄漏（「+」号的显示条件）', () => {
  it('英→中 + 有词根族 → 渲染「+」号', () => {
    renderCard({ question: question({ promptKind: 'en2cn', hasFamily: true }) });
    expect(screen.getByTestId('family-toggle')).toBeInTheDocument();
  });

  it('英→中 + 无词根族 → 不渲染「+」号', () => {
    renderCard({ question: question({ promptKind: 'en2cn', hasFamily: false }) });
    expect(screen.queryByTestId('family-toggle')).toBeNull();
  });

  it('中→英 **即使 hasFamily=true 也不渲染**「+」号（点开等于直接看答案）', () => {
    // 后端的 cn2en 题本来就不返回 hasFamily；这条是前端第二道闸门 ——
    // 只要有人「顺手」把条件写成 `hasFamily && ...`，这个用例就会红。
    renderCard({
      question: question({ promptKind: 'cn2en', prompt: '照顾；小心', hasFamily: true }),
    });
    expect(screen.queryByTestId('family-toggle')).toBeNull();
  });

  it('中→英题不渲染音标位（音标也足以提示答案）', () => {
    renderCard({
      question: question({ promptKind: 'cn2en', prompt: '照顾；小心', phonetic: null }),
    });
    expect(screen.queryByText('/keə(r)/')).toBeNull();
  });
});

describe('WordPromptCard — 题面与作答', () => {
  it('英→中：显示单词、音标与「写中文意思」提示', () => {
    renderCard();
    expect(screen.getByTestId('prompt-text')).toHaveTextContent('care');
    expect(screen.getByText('/keə(r)/')).toBeInTheDocument();
    expect(screen.getByText('写出它的中文意思')).toBeInTheDocument();
  });

  it('中→英：显示中文释义与「写英文单词」提示', () => {
    renderCard({ question: question({ promptKind: 'cn2en', prompt: '照顾；小心', phonetic: null }) });
    expect(screen.getByTestId('prompt-text')).toHaveTextContent('照顾；小心');
    expect(screen.getByText('写出对应的英文单词')).toBeInTheDocument();
  });

  it('熟词僻义题显示徽标与语境搭配', () => {
    renderCard({
      question: question({ isExtendedSense: true, context: 'address the problem', prompt: 'address' }),
    });
    expect(screen.getByTestId('extended-badge')).toHaveTextContent('熟词僻义');
    expect(screen.getByTestId('context-line')).toHaveTextContent('address the problem');
  });

  it('普通题不显示僻义徽标与语境行', () => {
    renderCard();
    expect(screen.queryByTestId('extended-badge')).toBeNull();
    expect(screen.queryByTestId('context-line')).toBeNull();
  });

  it('输入变化回调 onChange', () => {
    const props = renderCard();
    fireEvent.change(screen.getByTestId('answer-input'), { target: { value: '照顾' } });
    expect(props.onChange).toHaveBeenCalledWith('照顾');
  });

  it('回车即提交（背单词不该要求每词都去点按钮）', () => {
    const props = renderCard();
    fireEvent.keyDown(screen.getByTestId('answer-input'), { key: 'Enter' });
    expect(props.onSubmit).toHaveBeenCalledOnce();
  });

  it('点「不认识」走 onSkip（服务端记 unanswered，不计对错）', () => {
    const props = renderCard();
    fireEvent.click(screen.getByTestId('skip-button'));
    expect(props.onSkip).toHaveBeenCalledOnce();
  });

  it('词根族展开时渲染树，收起时不渲染', () => {
    const first = renderCard({ familyOpen: true, family: FAMILY });
    expect(screen.getByTestId('word-family-tree')).toBeInTheDocument();
    first.unmount();
    renderCard({ familyOpen: false, family: FAMILY });
    expect(screen.queryByTestId('word-family-tree')).toBeNull();
  });

  it('词根族加载中/失败都有兜底文案，不空白', () => {
    const first = renderCard({ familyOpen: true, familyLoading: true });
    expect(screen.getByText('正在展开词根…')).toBeInTheDocument();
    first.unmount();
    renderCard({ familyOpen: true, familyFailed: true });
    expect(screen.getByText('这个词暂时没有词根关系可展开')).toBeInTheDocument();
  });
});
