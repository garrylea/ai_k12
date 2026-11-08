import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import SolvePage from './SolvePage';
import {
  createConversation,
  getMyPoints,
  recognizeFreeform,
  streamFreeformJudge,
  streamTutorEvents,
  uploadFile,
  type FreeformRecognizeResult,
  type MyPoints,
} from '@/services/api';
import { useChatStore } from '@/store/chatStore';

/**
 * 自由出题页（Task 20）：录入 → 选题 → 作答 → 答疑 的状态机。
 *
 * 三个 hook 不 mock，mock 它们的 API 底层 —— 这样「ensureDialogue 先建会话」
 * 「judge.submit 带 dialogueId / questionContent / figureUrls」「二次提交带
 * questionId」这些跨模块契约是真的跑过的，不是桩之间互相点头。
 *
 * 白板换成桩：jsdom 无 canvas；桩同时钉住 DraftPanel 的 snapshotRef 透传
 * （SolvePage 只挂一个白板，快照出口必须经面板转进来）。
 */

const draftStub = vi.hoisted(() => ({
  receivedRef: null as { current: (() => Promise<string | null>) | null } | null,
  snapshotValue: null as string | null,
}));

vi.mock('@/services/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/services/api')>();
  return {
    ...actual,
    recognizeFreeform: vi.fn(),
    streamFreeformJudge: vi.fn(),
    streamTutorEvents: vi.fn(),
    createConversation: vi.fn(),
    getMyPoints: vi.fn(),
    uploadFile: vi.fn(),
  };
});

vi.mock('@/components/base/Toast', () => ({
  toast: vi.fn(),
  ToastContainer: () => null,
}));

vi.mock('@/components/business/DraftWhiteboard', () => ({
  DraftWhiteboard: ({
    snapshotRef,
  }: {
    snapshotRef?: { current: (() => Promise<string | null>) | null };
  }) => {
    draftStub.receivedRef = snapshotRef ?? null;
    if (snapshotRef) {
      snapshotRef.current = async () => draftStub.snapshotValue;
    }
    return <div data-testid="whiteboard" />;
  },
}));

vi.mock('@/components/business/LatexEditor', () => ({
  LatexEditor: ({ value, onChange }: { value: string; onChange: (v: string) => void }) => (
    <textarea
      aria-label="作答输入"
      value={value}
      onChange={(e) => onChange(e.target.value)}
    />
  ),
}));

const recognizeMock = vi.mocked(recognizeFreeform);
const judgeStreamMock = vi.mocked(streamFreeformJudge);
const tutorStreamMock = vi.mocked(streamTutorEvents);
const createConversationMock = vi.mocked(createConversation);
const uploadFileMock = vi.mocked(uploadFile);
const getMyPointsMock = vi.mocked(getMyPoints);

const POINTS: MyPoints = {
  balance: 120,
  totalEarned: 520,
  todayEarned: 10,
  level: { code: 'zhutie', name: '铸铁', index: 1, threshold: 500 },
  nextLevel: { code: 'qingtong', name: '青铜', index: 2, threshold: 1500 },
  pointsToNextLevel: 980,
  progressPercent: 13,
};

const RECOGNIZED: FreeformRecognizeResult = {
  candidates: [
    {
      id: 'c1',
      no: '1',
      // 题干已含配图：确认时不会追加 ![配图]，picked.content 即下文断言值
      content: '求 $1+1$ 的值\n\n![图](/uploads/fig-1.jpg)',
      figureUrls: ['/uploads/fig-1.jpg'],
      suggestedSubject: 'math',
      confidence: 0.9,
    },
  ],
  figures: [{ url: '/uploads/fig-1.jpg', name: '图1', page: 1 }],
};

const PICKED_CONTENT = '求 $1+1$ 的值\n\n![图](/uploads/fig-1.jpg)';

function stubMatchMedia() {
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addEventListener: () => {},
    removeEventListener: () => {},
    addListener: () => {},
    removeListener: () => {},
    dispatchEvent: () => false,
  }));
}

beforeEach(() => {
  stubMatchMedia();
  // jsdom 未实现 scrollIntoView（AuxChatPanel 滚动到底部用）
  Object.defineProperty(Element.prototype, 'scrollIntoView', {
    value: () => {},
    configurable: true,
  });
  useChatStore.getState().reset();
  draftStub.receivedRef = null;
  draftStub.snapshotValue = null;

  recognizeMock.mockReset();
  recognizeMock.mockResolvedValue(RECOGNIZED);
  judgeStreamMock.mockReset();
  judgeStreamMock.mockImplementation(async function* () {
    yield { type: 'start', dialogueId: '7', questionId: null };
    yield {
      type: 'result',
      questionId: 42,
      totalScore: 8,
      maxScore: 10,
      verdict: 'partial',
    };
  });
  tutorStreamMock.mockReset();
  tutorStreamMock.mockImplementation(async function* () {
    yield { type: 'content', delta: '先想想加法交换律。' };
  });
  createConversationMock.mockReset();
  createConversationMock.mockResolvedValue({
    id: 7,
    track: 'auxiliary',
    scene: 'aux_freeform',
    title: null,
    status: 'active',
    created_at: '2026-11-08T00:00:00.000Z',
  });
  uploadFileMock.mockReset();
  uploadFileMock.mockResolvedValue({ fileId: 99, url: '/uploads/draft.jpg' });
  getMyPointsMock.mockReset();
  getMyPointsMock.mockResolvedValue(POINTS);
  localStorage.setItem('username', '小明');
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  useChatStore.getState().reset();
  vi.clearAllMocks();
});

function renderPage() {
  return render(
    <MemoryRouter>
      <SolvePage />
    </MemoryRouter>,
  );
}

async function goToAnswerStage() {
  fireEvent.change(screen.getByPlaceholderText(/输入题目文字/), {
    target: { value: '求 1+1' },
  });
  fireEvent.click(screen.getByRole('button', { name: '开始识题' }));
  await screen.findByText('识别到 1 道题');
  fireEvent.click(screen.getByRole('button', { name: '开始作答' }));
  await screen.findByLabelText('作答输入');
}

describe('SolvePage 状态机', () => {
  it('初始停在录入态', () => {
    renderPage();
    expect(screen.getByText('把题目发给我')).toBeInTheDocument();
    expect(screen.queryByLabelText('作答输入')).toBeNull();
  });

  it('识别成功 → 选题；确认后进入作答，且 tab 条在未答疑/提交前隐藏', async () => {
    renderPage();
    await goToAnswerStage();

    expect(recognizeMock).toHaveBeenCalledWith(
      expect.objectContaining({ text: '求 1+1', attachments: [] }),
    );
    expect(screen.queryByRole('button', { name: 'AI 答疑' })).toBeNull();
    // 题干原样交给作答卡片（不在页面里再 preprocess 一次）：题干图能正常渲染
    expect(document.querySelector('img[alt="图"]')).toBeTruthy();
  });

  it('识别失败 → 手动输入走单候选选题', async () => {
    recognizeMock.mockRejectedValueOnce(new Error('识别失败'));
    renderPage();

    fireEvent.change(screen.getByPlaceholderText(/输入题目文字/), {
      target: { value: '手写题干' },
    });
    fireEvent.click(screen.getByRole('button', { name: '开始识题' }));
    fireEvent.click(await screen.findByRole('button', { name: '手动输入题目' }));

    await screen.findByText(/识别到 1 道题/);
    expect(screen.getByText('手写题干')).toBeInTheDocument();
  });

  it('白板快照出口经 DraftPanel 透传（只挂一个白板）', async () => {
    renderPage();
    await goToAnswerStage();

    expect(screen.getAllByTestId('whiteboard')).toHaveLength(1);
    await waitFor(() => expect(draftStub.receivedRef?.current).toBeTypeOf('function'));
  });

  it('答疑：先建 aux_freeform 会话再发首问，并切到 AI tab', async () => {
    renderPage();
    await goToAnswerStage();

    fireEvent.click(screen.getByRole('button', { name: '答疑' }));

    await waitFor(() => expect(tutorStreamMock).toHaveBeenCalledTimes(1));
    expect(createConversationMock).toHaveBeenCalledWith({
      track: 'auxiliary',
      scene: 'aux_freeform',
      subjectId: 1,
      questionText: PICKED_CONTENT,
    });
    const [body] = tutorStreamMock.mock.calls[0];
    expect(body.dialogueId).toBe('7');
    expect(body.message).toContain('这题怎么做');

    // tab 条出现且默认落在 AI 态
    expect(await screen.findByRole('button', { name: 'AI 答疑' })).toBeInTheDocument();
    expect(screen.getByPlaceholderText(/输入问题或粘贴/)).toBeInTheDocument();
  });

  it('提交：带 dialogueId / questionContent / figureUrls / answer；再次提交带 questionId', async () => {
    renderPage();
    await goToAnswerStage();

    fireEvent.change(screen.getByLabelText('作答输入'), { target: { value: '答案是 2' } });
    fireEvent.click(screen.getByRole('button', { name: '提交' }));

    await waitFor(() => expect(judgeStreamMock).toHaveBeenCalledTimes(1));
    const first = judgeStreamMock.mock.calls[0][0];
    expect(first).toMatchObject({
      dialogueId: '7',
      subjectId: 1,
      maxScore: 10,
      questionContent: PICKED_CONTENT,
      figureUrls: ['/uploads/fig-1.jpg'],
      answer: '答案是 2',
    });
    expect(first.questionId).toBeUndefined();

    // 回到作答 tab，编辑器内容保留
    fireEvent.click(screen.getByRole('button', { name: '作答' }));
    const editor = (await screen.findByLabelText('作答输入')) as HTMLTextAreaElement;
    expect(editor.value).toBe('答案是 2');

    fireEvent.click(screen.getByRole('button', { name: '提交' }));
    await waitFor(() => expect(judgeStreamMock).toHaveBeenCalledTimes(2));
    expect(judgeStreamMock.mock.calls[1][0].questionId).toBe(42);
    expect(judgeStreamMock.mock.calls[1][0].dialogueId).toBe('7');
  });

  it('答案与草稿都为空时不判题，并提示', async () => {
    const { toast } = await import('@/components/base/Toast');
    renderPage();
    await goToAnswerStage();

    fireEvent.click(screen.getByRole('button', { name: '提交' }));

    await waitFor(() => expect(toast).toHaveBeenCalledWith('error', '草稿为空，请先作答'));
    expect(judgeStreamMock).not.toHaveBeenCalled();
  });

  it('草稿有内容 → 上传快照并以 freeform 来源随判题提交', async () => {
    draftStub.snapshotValue = 'data:image/jpeg;base64,AAAA';
    const fetchMock = vi.fn().mockResolvedValue({
      blob: async () => new Blob(['x'], { type: 'image/jpeg' }),
    });
    vi.stubGlobal('fetch', fetchMock);

    renderPage();
    await goToAnswerStage();

    fireEvent.click(screen.getByRole('button', { name: '提交' }));

    await waitFor(() => expect(uploadFileMock).toHaveBeenCalledTimes(1));
    expect(uploadFileMock.mock.calls[0][2]).toBe('freeform');
    await waitFor(() => expect(judgeStreamMock).toHaveBeenCalledTimes(1));
    expect(judgeStreamMock.mock.calls[0][0].draftFileId).toBe('99');
    expect(judgeStreamMock.mock.calls[0][0].answer).toBe('');
  });
});
