import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
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
import { FREEFORM_REDO_KEY, saveRedoQueue } from './training/freeformRedoQueue';

const STUDENT_ID = 7;
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
  // jsdom 也未实现 createObjectURL：录入页的题图预览要用（仅「答疑带图」用例会触发）。
  if (typeof URL.createObjectURL !== 'function') {
    (URL as unknown as Record<string, unknown>).createObjectURL = vi.fn(() => 'blob:preview');
  }
  if (typeof URL.revokeObjectURL !== 'function') {
    (URL as unknown as Record<string, unknown>).revokeObjectURL = vi.fn();
  }
  useChatStore.getState().reset();
  sessionStorage.clear();
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
      correctAnswer: '$x=1$',
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
  localStorage.setItem('userId', String(STUDENT_ID));
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  useChatStore.getState().reset();
  sessionStorage.clear();
  vi.clearAllMocks();
});

function renderPage() {
  return render(
    <MemoryRouter>
      <SolvePage />
    </MemoryRouter>,
  );
}

function renderPageAt(path: string) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <SolvePage />
    </MemoryRouter>,
  );
}

const REDO_QUEUE = {
  subjectId: 1,
  items: [
    {
      errorBookId: 440,
      questionId: 7091,
      questionText: '已知 $x+1=2$，求 $x$。',
      type: 'short_answer',
      fullScore: 10,
    },
    {
      errorBookId: 441,
      questionId: 7092,
      questionText: '第二题：求 $1+1$。',
      type: 'calculation',
      fullScore: null,
    },
  ],
  index: 0,
};

/** 上传一张 jpg（不点按钮）：纯图片识题路径的公共前置。 */
async function addImageOnly() {
  fireEvent.change(screen.getByTestId('source-file-input'), {
    target: { files: [new File(['x'], 'q.jpg', { type: 'image/jpeg' })] },
  });
  await waitFor(() => expect(uploadFileMock).toHaveBeenCalled());
  // ready 后「处理中」角标消失（图片一多会稍慢，等它落定再点）
  await waitFor(() => expect(screen.queryByText('处理中')).toBeNull());
}

/** 文字题：输入文字 → 直接进作答，不调用识题。 */
async function goToAnswerStage() {
  fireEvent.change(screen.getByPlaceholderText('输入题目文字直接作答；只放图片则自动识别'), {
    target: { value: '求 1+1' },
  });
  // 有文字时按钮是「开始作答」；识别只发生在纯图片输入
  fireEvent.click(screen.getByRole('button', { name: '开始作答' }));
  await screen.findByLabelText('作答输入');
}

/** 纯图片：上传图片 → 开始识题 → 选题页。 */
async function goToSelectViaImage() {
  renderPage();
  await addImageOnly();
  fireEvent.click(screen.getByRole('button', { name: '开始识题' }));
  await screen.findByText('识别到 1 道题');
}

/** 纯图片：识题 → 选题确认 → 作答区（题干/配图走识别结果）。 */
async function goToAnswerStageViaImage() {
  await goToSelectViaImage();
  fireEvent.click(screen.getByRole('button', { name: '开始作答' }));
  await screen.findByLabelText('作答输入');
}

describe('SolvePage 状态机', () => {
  it('初始停在录入态', () => {
    renderPage();
    // 首屏标题/副文案与答疑同一套层级（h2 + 一行说明），输入框居中 max-w-2xl
    expect(screen.getByRole('heading', { name: '把题目发给我' })).toBeInTheDocument();
    expect(screen.getByText('输入题目文字直接作答；只放图片则自动识别')).toBeInTheDocument();
    expect(screen.getByPlaceholderText('输入题目文字直接作答；只放图片则自动识别')).toBeInTheDocument();
    expect(screen.queryByLabelText('作答输入')).toBeNull();
  });

  it('顶栏显示用户药丸与独立的退出按钮', () => {
    renderPage();
    expect(screen.getByTestId('user-badge')).toBeInTheDocument();
    expect(screen.getByLabelText('退出登录')).toBeInTheDocument();
  });

  it('整页复用答疑外壳：内容在 max-w-6xl / h-[80vh] 的同一张卡里', () => {
    renderPage();
    const shell = document.querySelector('.max-w-6xl');
    expect(shell).not.toBeNull();
    expect(shell?.className).toContain('h-[80vh]');
    // 做题页没有侧栏，卡片里只有内容区
    expect(shell?.querySelector('aside')).toBeNull();
    // 页面内容确实嵌在这张卡里，而不是另起全屏布局
    expect(shell?.contains(screen.getByPlaceholderText('输入题目文字直接作答；只放图片则自动识别'))).toBe(true);
  });

  it('纯图片才走识题：识别成功 → 选题 → 作答，tab 条在未答疑/提交前隐藏', async () => {
    await goToSelectViaImage();

    expect(recognizeMock).toHaveBeenCalledWith(
      expect.objectContaining({
        text: '',
        attachments: [{ type: 'image', fileId: '99' }],
      }),
    );
    fireEvent.click(screen.getByRole('button', { name: '开始作答' }));
    await screen.findByLabelText('作答输入');

    expect(screen.queryByRole('button', { name: 'AI 答疑' })).toBeNull();
    // 题干原样交给作答卡片（不在页面里再 preprocess 一次）：题干图能正常渲染
    expect(document.querySelector('img[alt="图"]')).toBeTruthy();
  });

  it('文字题不走识题：按钮是「开始作答」，直接进作答区', async () => {
    renderPage();
    fireEvent.change(screen.getByPlaceholderText('输入题目文字直接作答；只放图片则自动识别'), {
      target: { value: '求 $x^2-4x+3$ 的顶点' },
    });

    const btn = screen.getByRole('button', { name: '开始作答' });
    fireEvent.click(btn);

    expect(await screen.findByLabelText('作答输入')).toBeInTheDocument();
    expect(recognizeMock).not.toHaveBeenCalled();
    // 直接进作答时学科/满分就在顶部，可改（默认数学 10 分）
    expect(screen.getByLabelText('学科')).toHaveValue('1');
    expect(screen.getByLabelText('满分')).toHaveValue(10);
  });

  it('文字 + 配图：不调识题，图片物化成 Markdown 附在题干末尾', async () => {
    renderPage();
    fireEvent.change(screen.getByPlaceholderText('输入题目文字直接作答；只放图片则自动识别'), {
      target: { value: '求下图的阴影面积' },
    });
    // 文字已有，再加图 —— 图只作配图，不能触发 MinerU
    await addImageOnly();

    fireEvent.click(screen.getByRole('button', { name: '开始作答' }));
    await screen.findByLabelText('作答输入');

    expect(recognizeMock).not.toHaveBeenCalled();
    const figure = document.querySelector('img[alt="配图1"]') as HTMLImageElement | null;
    expect(figure).toBeTruthy();
    expect(figure?.getAttribute('src')).toContain('/uploads/draft.jpg');
    // 题干文字仍在，图是追加而不是替换
    expect(screen.getByText('求下图的阴影面积', { exact: false })).toBeInTheDocument();
  });

  it('识别失败 → 手动输入走单候选选题（空题干就地写）', async () => {
    recognizeMock.mockRejectedValueOnce(new Error('识别失败'));
    renderPage();
    await addImageOnly();
    fireEvent.click(screen.getByRole('button', { name: '开始识题' }));
    fireEvent.click(await screen.findByRole('button', { name: '手动输入题目' }));

    await screen.findByText(/识别到 1 道题/);
    fireEvent.click(screen.getByTestId('stem-render'));
    fireEvent.change(screen.getByLabelText('题干'), { target: { value: '手写题干' } });
    expect((screen.getByLabelText('题干') as HTMLTextAreaElement).value).toBe('手写题干');
  });

  it('识别出 0 道题时留在录入页，给提示与手动输入，不进空选题页', async () => {
    recognizeMock.mockResolvedValueOnce({ candidates: [], figures: [] });
    renderPage();
    await addImageOnly();

    fireEvent.click(screen.getByRole('button', { name: '开始识题' }));

    expect(await screen.findByText(/没有识别到题目/)).toBeInTheDocument();
    expect(screen.getByPlaceholderText('输入题目文字直接作答；只放图片则自动识别')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '手动输入题目' })).toBeInTheDocument();
    expect(screen.queryByText(/识别到 0 道题/)).toBeNull();
  });

  it('识别出 0 道题 → 手动输入：选题页是录入的那一道，不是「识别到 0 道题」', async () => {
    recognizeMock.mockResolvedValueOnce({ candidates: [], figures: [] });
    renderPage();
    await addImageOnly();

    fireEvent.click(screen.getByRole('button', { name: '开始识题' }));
    fireEvent.click(await screen.findByRole('button', { name: '手动输入题目' }));

    // 空的识别结果必须被清掉：否则第一个选题分支按 candidates.length=0 渲染空列表
    expect(await screen.findByText('识别到 1 道题')).toBeInTheDocument();
    expect(screen.queryByText(/识别到 0 道题/)).toBeNull();
    fireEvent.click(screen.getByTestId('stem-render'));
    fireEvent.change(screen.getByLabelText('题干'), { target: { value: '手写题干' } });
    expect(screen.getByRole('button', { name: '开始作答' })).toBeEnabled();

    fireEvent.click(screen.getByRole('button', { name: '开始作答' }));
    expect(await screen.findByLabelText('作答输入')).toBeInTheDocument();
  });

  it('选题页「返回重新上传」真的回到录入页（不被识别结果弹回）', async () => {
    await goToSelectViaImage();

    fireEvent.click(screen.getByRole('button', { name: '返回重新上传' }));
    // 冲掉 effect：若 reset 漏了，自动进选题的 effect 会在这里把页面弹回
    await act(async () => {
      await Promise.resolve();
    });

    expect(screen.getByPlaceholderText('输入题目文字直接作答；只放图片则自动识别')).toBeInTheDocument();
    expect(screen.queryByText(/识别到 1 道题/)).toBeNull();
  });

  it('白板快照出口经 DraftPanel 透传（只挂一个白板）', async () => {
    renderPage();
    await goToAnswerStage();

    fireEvent.click(screen.getByRole('button', { name: '草稿' }));
    expect(screen.getAllByTestId('whiteboard')).toHaveLength(1);
    await waitFor(() => expect(draftStub.receivedRef?.current).toBeTypeOf('function'));
  });

  it('草稿默认收起：先看到草稿入口，展开后才附上草稿', async () => {
    renderPage();
    await goToAnswerStage();

    expect(screen.queryByRole('dialog', { name: '草稿' })).toBeNull();
    expect(screen.queryByRole('checkbox')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: '草稿' }));
    expect(await screen.findByRole('dialog', { name: '草稿' })).toBeInTheDocument();
    expect((screen.getByRole('checkbox') as HTMLInputElement).checked).toBe(true);
  });

  it('答疑：先建 aux_freeform 会话再发首问，并切到 AI tab', async () => {
    await goToAnswerStageViaImage();

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
    // 学科随请求下发（决定用哪个学科模块模板）；学习档案由服务端从 DB 取
    expect(body.subjectId).toBe(1);
    expect(body).not.toHaveProperty('learningProfile');

    // tab 条出现且默认落在 AI 态
    expect(await screen.findByRole('button', { name: 'AI 答疑' })).toBeInTheDocument();
    expect(screen.getByPlaceholderText(/输入问题或粘贴/)).toBeInTheDocument();
  });

  it('答疑只发学生原话：不加「我的尝试是」模板、不附原题照片', async () => {
    renderPage();
    await goToAnswerStage();

    fireEvent.change(screen.getByLabelText('作答输入'), { target: { value: '我不会' } });
    fireEvent.click(screen.getByRole('button', { name: '答疑' }));

    await waitFor(() => expect(tutorStreamMock).toHaveBeenCalledTimes(1));
    const [body] = tutorStreamMock.mock.calls[0];
    expect(body.message).toBe('我不会');
    expect(body.attachments).toBeUndefined();
    expect(body.subjectId).toBe(1);
    expect(body).not.toHaveProperty('learningProfile');

    const userMsg = useChatStore.getState().messages.find((m) => m.role === 'user');
    expect(userMsg?.content).toBe('我不会');
    expect(userMsg?.images).toBeUndefined();
  });

  it('答疑未写作答时发一句最短的默认提问', async () => {
    renderPage();
    await goToAnswerStage();

    fireEvent.click(screen.getByRole('button', { name: '答疑' }));

    await waitFor(() => expect(tutorStreamMock).toHaveBeenCalledTimes(1));
    expect(tutorStreamMock.mock.calls[0][0].message).toBe('这题怎么做？');
  });

  it('提交：带 dialogueId / questionContent / figureUrls / answer；再次提交带 questionId', async () => {
    await goToAnswerStageViaImage();

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
    // 判题不再附原题照片：题干（含勾选配图）已是识别后的结果
    expect(first.questionImages).toBeUndefined();
    const judgeUserMsg = useChatStore.getState().messages.find((m) => m.role === 'user');
    expect(judgeUserMsg?.images).toBeUndefined();

    // 提交后留在作答 tab 看结果卡（不自动跳聊天），「再答一次」才回到编辑器
    expect(await screen.findByText('部分正确')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '再答一次' }));
    const editor = (await screen.findByLabelText('作答输入')) as HTMLTextAreaElement;
    expect(editor.value).toBe('答案是 2');

    fireEvent.click(screen.getByRole('button', { name: '提交' }));
    await waitFor(() => expect(judgeStreamMock).toHaveBeenCalledTimes(2));
    expect(judgeStreamMock.mock.calls[1][0].questionId).toBe(42);
    expect(judgeStreamMock.mock.calls[1][0].dialogueId).toBe('7');
  });

  it('提交结果卡：直接给结论、我的答案与正确答案（不跳聊天）', async () => {
    judgeStreamMock.mockReset();
    judgeStreamMock.mockImplementation(async function* () {
      yield { type: 'start', dialogueId: '7', questionId: null };
      yield { type: 'content', delta: '## 判题结果\n\n**得分：8 / 10**' };
      yield {
        type: 'result',
        questionId: 42,
        totalScore: 8,
        maxScore: 10,
        verdict: 'partial',
        correctAnswer: '$x=1$',
      };
    });
    renderPage();
    await goToAnswerStage();

    fireEvent.change(screen.getByLabelText('作答输入'), { target: { value: '我的答案是 2' } });
    fireEvent.click(screen.getByRole('button', { name: '提交' }));

    expect(await screen.findByText('部分正确')).toBeInTheDocument();
    expect(screen.getByText('得分 8 / 10')).toBeInTheDocument();
    expect(screen.getByText('我的答案')).toBeInTheDocument();
    // 结果卡与（隐藏的）聊天区各有一份，取全部确认至少渲染了一处
    expect(screen.getAllByText('我的答案是 2').length).toBeGreaterThan(0);
    expect(screen.getByText('正确答案')).toBeInTheDocument();
    expect(screen.getByText('完整判题报告')).toBeInTheDocument();
    // 判题不抢聊天：tab 条也未出现
    expect(screen.queryByRole('button', { name: 'AI 答疑' })).toBeNull();
  });

  it('提交后点答疑才进聊天，且不把学生答案原样重发', async () => {
    renderPage();
    await goToAnswerStage();
    fireEvent.change(screen.getByLabelText('作答输入'), { target: { value: '我的答案是 2' } });
    fireEvent.click(screen.getByRole('button', { name: '提交' }));
    expect(await screen.findByText('部分正确')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: '答疑' }));

    await waitFor(() => expect(tutorStreamMock).toHaveBeenCalledTimes(1));
    expect(tutorStreamMock.mock.calls[0][0].message).not.toBe('我的答案是 2');
    expect(tutorStreamMock.mock.calls[0][0].message).toContain('没太懂');
    expect(await screen.findByRole('button', { name: 'AI 答疑' })).toBeInTheDocument();
  });

  it('草稿展开但内容为空时不判题，并提示', async () => {
    const { toast } = await import('@/components/base/Toast');
    renderPage();
    await goToAnswerStage();

    fireEvent.click(screen.getByRole('button', { name: '草稿' }));
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
    fireEvent.click(screen.getByRole('button', { name: '草稿' }));

    fireEvent.click(screen.getByRole('button', { name: '提交' }));

    await waitFor(() => expect(uploadFileMock).toHaveBeenCalledTimes(1));
    expect(uploadFileMock.mock.calls[0][2]).toBe('freeform');
    await waitFor(() => expect(judgeStreamMock).toHaveBeenCalledTimes(1));
    expect(judgeStreamMock.mock.calls[0][0].draftFileId).toBe('99');
    expect(judgeStreamMock.mock.calls[0][0].answer).toBe('');
  });

  it('点【答疑】自动收起草稿（AI 屏整宽），回作答页草稿仍是收起态', async () => {
    renderPage();
    await goToAnswerStage();
    fireEvent.click(screen.getByRole('button', { name: '草稿' }));
    expect(await screen.findByRole('dialog', { name: '草稿' })).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: '答疑' }));

    // 答疑要整屏看对话：草稿面板收起且不显示（也不占右栏宽度）
    expect(screen.queryByRole('dialog', { name: '草稿' })).toBeNull();

    fireEvent.click(await screen.findByRole('button', { name: '作答' }));
    expect(screen.queryByRole('dialog', { name: '草稿' })).toBeNull();
    // 回到作答页后入口图标还在，可以再展开（笔迹由白板 store 保留）
    expect(screen.getByRole('button', { name: '草稿' })).toBeInTheDocument();
  });

  it('收起草稿面板会取消「附上草稿」；空答案提交回到首条提示', async () => {
    const { toast } = await import('@/components/base/Toast');
    renderPage();
    await goToAnswerStage();
    fireEvent.click(screen.getByRole('button', { name: '草稿' }));

    expect((screen.getByRole('checkbox') as HTMLInputElement).checked).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: '收起' }));
    // 收起后没有草稿可附，勾选框整体隐藏（不是留在那里显示未勾选）
    expect(screen.queryByRole('checkbox')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: '提交' }));
    await waitFor(() => expect(toast).toHaveBeenCalledWith('error', '请先写答案或在草稿上作答'));
    expect(judgeStreamMock).not.toHaveBeenCalled();
  });

  it('作答页不再提供「编辑题干」入口', async () => {
    renderPage();
    await goToAnswerStage();

    expect(screen.queryByRole('button', { name: '编辑题干' })).toBeNull();
    expect(screen.queryByLabelText('编辑题干内容')).toBeNull();
  });

  it('题干在选题页修正后进入作答，判题用修正后的 questionContent', async () => {
    await goToSelectViaImage();

    // 题干就地编辑：点题干（渲染态）→ 变源码框，改完直接点「开始作答」
    fireEvent.click(screen.getByTestId('stem-render'));
    fireEvent.change(screen.getByLabelText('题干'), {
      target: { value: '选题页改过的题干' },
    });
    fireEvent.click(screen.getByRole('button', { name: '开始作答' }));
    await screen.findByLabelText('作答输入');

    fireEvent.change(screen.getByLabelText('作答输入'), { target: { value: '答案是 2' } });
    fireEvent.click(screen.getByRole('button', { name: '提交' }));

    await waitFor(() => expect(judgeStreamMock).toHaveBeenCalledTimes(1));
    expect(judgeStreamMock.mock.calls[0][0].questionContent).toContain('选题页改过的题干');
  });

  it('判题失败 → 错误气泡的「重试」只重发判题流，不重复发首问', async () => {
    judgeStreamMock
      .mockImplementationOnce(async function* () {
        yield { type: 'error', code: 5000, message: '判题失败', retryable: true };
      })
      .mockImplementationOnce(async function* () {
        yield { type: 'content', delta: '重试后成功' };
      });

    renderPage();
    await goToAnswerStage();
    fireEvent.change(screen.getByLabelText('作答输入'), { target: { value: '答案是 2' } });
    fireEvent.click(screen.getByRole('button', { name: '提交' }));

    fireEvent.click(await screen.findByRole('button', { name: '重试' }));

    await waitFor(() => expect(judgeStreamMock).toHaveBeenCalledTimes(2));
    // 同一份判题 body（含已上传的草稿/题图），没有第二次上传或首问
    expect(judgeStreamMock.mock.calls[1][0]).toEqual(judgeStreamMock.mock.calls[0][0]);
    expect(uploadFileMock).not.toHaveBeenCalled();

    const messages = useChatStore.getState().messages;
    expect(messages.filter((m) => m.role === 'user')).toHaveLength(1);
    expect(messages[messages.length - 1].content).toBe('重试后成功');
    expect(messages[messages.length - 1].error).toBeUndefined();
  });

  it('答疑网络失败 → 错误气泡的「重试」重发答疑流，不重复用户气泡', async () => {
    tutorStreamMock
      .mockImplementationOnce(async function* () {
        yield* [];
        throw new Error('network down');
      })
      .mockImplementationOnce(async function* () {
        yield { type: 'content', delta: '重试后的讲解' };
      });

    renderPage();
    await goToAnswerStage();
    fireEvent.click(screen.getByRole('button', { name: '答疑' }));

    // 失败阶段是 tutor：气泡里必须有可点的「重试」（此前只有判题失败才有）
    fireEvent.click(await screen.findByRole('button', { name: '重试' }));

    await waitFor(() => expect(tutorStreamMock).toHaveBeenCalledTimes(2));
    // 同一场会话、同一条提问：不新建会话、不再追加用户气泡
    expect(createConversationMock).toHaveBeenCalledTimes(1);
    expect(tutorStreamMock.mock.calls[1][0]).toEqual(tutorStreamMock.mock.calls[0][0]);

    const messages = useChatStore.getState().messages;
    expect(messages.filter((m) => m.role === 'user')).toHaveLength(1);
    expect(messages[messages.length - 1].content).toBe('重试后的讲解');
    expect(messages[messages.length - 1].error).toBeUndefined();
  });

  it('连点「答疑」只建一场会话、只发一次首问', async () => {
    let releaseConversation!: () => void;
    const gate = new Promise<void>((resolve) => {
      releaseConversation = resolve;
    });
    createConversationMock.mockImplementationOnce(async () => {
      await gate;
      return {
        id: 7,
        track: 'auxiliary',
        scene: 'aux_freeform',
        title: null,
        status: 'active',
        created_at: '2026-11-08T00:00:00.000Z',
      };
    });

    renderPage();
    await goToAnswerStage();

    const help = screen.getByRole('button', { name: '答疑' });
    fireEvent.click(help);
    fireEvent.click(help);

    await act(async () => {
      releaseConversation();
      await gate;
    });

    await waitFor(() => expect(tutorStreamMock).toHaveBeenCalledTimes(1));
    expect(createConversationMock).toHaveBeenCalledTimes(1);
  });

  it('卸载页面会中断进行中的判题流', async () => {
    let seenSignal: AbortSignal | undefined;
    judgeStreamMock.mockImplementation(async function* (_body, signal) {
      seenSignal = signal;
      yield { type: 'start', dialogueId: '7', questionId: null };
      await new Promise<void>((_resolve, reject) => {
        const abort = () => {
          const err = new Error('aborted');
          err.name = 'AbortError';
          reject(err);
        };
        if (signal?.aborted) abort();
        else signal?.addEventListener('abort', abort, { once: true });
      });
    });

    const { unmount } = renderPage();
    await goToAnswerStage();
    fireEvent.change(screen.getByLabelText('作答输入'), { target: { value: '答案是 2' } });
    fireEvent.click(screen.getByRole('button', { name: '提交' }));
    await waitFor(() => expect(seenSignal).toBeDefined());

    await act(async () => {
      unmount();
      await Promise.resolve();
    });

    expect(seenSignal?.aborted).toBe(true);
    expect(useChatStore.getState().isStreaming).toBe(false);
  });
});

describe('SolvePage · 重练模式（2026-11-10）', () => {
  it('?redo=1 + 合法队列：直接进作答，不走识别，页头显示题号', async () => {
    saveRedoQueue(REDO_QUEUE);
    renderPageAt('/student/solve?redo=1');

    expect(await screen.findByRole('heading', { name: '错题重练' })).toBeInTheDocument();
    expect(screen.getByText('第 1/2 题')).toBeInTheDocument();
    expect(await screen.findByLabelText('作答输入')).toBeInTheDocument();
    expect(recognizeMock).not.toHaveBeenCalled();
    // 学科/满分锁定（来自 fullScore）
    expect(screen.getByLabelText('学科')).toBeDisabled();
    expect(screen.getByLabelText('满分')).toBeDisabled();
    expect(screen.getByLabelText('满分')).toHaveValue(10);
  });

  it('提交带 questionId / 题干 / 满分；下一题清空并换到第 2 题', async () => {
    saveRedoQueue(REDO_QUEUE);
    renderPageAt('/student/solve?redo=1');
    await screen.findByLabelText('作答输入');

    fireEvent.change(screen.getByLabelText('作答输入'), { target: { value: 'x=1' } });
    fireEvent.click(screen.getByRole('button', { name: '提交' }));

    await waitFor(() => expect(judgeStreamMock).toHaveBeenCalledTimes(1));
    expect(judgeStreamMock.mock.calls[0][0]).toMatchObject({
      questionId: 7091,
      questionContent: REDO_QUEUE.items[0].questionText,
      subjectId: 1,
      maxScore: 10,
      answer: 'x=1',
    });

    expect(await screen.findByText('部分正确')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '下一题' }));

    expect(await screen.findByText('第 2/2 题')).toBeInTheDocument();
    expect(screen.getByText(/第二题/)).toBeInTheDocument();
    expect((screen.getByLabelText('作答输入') as HTMLTextAreaElement).value).toBe('');
    // 第 2 题 fullScore=null → 满分按 10
    expect(screen.getByLabelText('满分')).toHaveValue(10);
    // 判题状态与消息已清（不会带着上一题的结果）
    expect(useChatStore.getState().messages).toEqual([]);
    expect(screen.queryByText('部分正确')).toBeNull();
  });

  it('最后一题结果卡显示「返回错题本」，点击清队列', async () => {
    saveRedoQueue({ ...REDO_QUEUE, index: 1 });
    renderPageAt('/student/solve?redo=1');
    await screen.findByLabelText('作答输入');

    expect(screen.getByText('第 2/2 题')).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('作答输入'), { target: { value: '2' } });
    fireEvent.click(screen.getByRole('button', { name: '提交' }));
    expect(await screen.findByText('部分正确')).toBeInTheDocument();

    // 页头也有「返回错题本」，结果卡的是最后一个
    const backs = screen.getAllByRole('button', { name: '返回错题本' });
    fireEvent.click(backs[backs.length - 1]);
    expect(sessionStorage.getItem(FREEFORM_REDO_KEY)).toBeNull();
  });

  it('队列失效：toast 并回错题本（不停在空作答页）', async () => {
    const { toast } = await import('@/components/base/Toast');
    renderPageAt('/student/solve?redo=1');

    await waitFor(() =>
      expect(toast).toHaveBeenCalledWith('error', '重练题单已失效，请回错题本重新选择'),
    );
  });
});
