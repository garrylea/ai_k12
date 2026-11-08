import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, renderHook } from '@testing-library/react';
import { createConversation, recognizeFreeform, streamFreeformJudge } from '@/services/api';
import { useChatStore } from '@/store/chatStore';
import { useAuxiliaryStore } from '@/store/auxiliaryStore';
import { useFreeformRecognize } from './useFreeformRecognize';
import { useFreeformJudge } from './useFreeformJudge';
import { useFreeformTutor } from './useFreeformTutor';

/**
 * 自由作答页（solve）三个 hook：识别 / 判题 / 答疑。
 *
 * 这些 hook 是 Task 20 `SolvePage` 的唯一行为承载，页面本身只排 UI —— 所以
 * 「往 chatStore 里写了什么」「什么时候不许起流」「stop 有没有真的 abort」
 * 必须钉在测试里，靠人眼看页面是看不出来的。
 *
 * vitest globals:false：显式 import + 自己 afterEach(cleanup)；
 * chatStore / auxiliaryStore 是模块级单例，用例之间必须清空。
 */

vi.mock('@/services/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/services/api')>();
  return {
    ...actual,
    recognizeFreeform: vi.fn(),
    streamFreeformJudge: vi.fn(),
    createConversation: vi.fn(),
  };
});

const recognizeMock = vi.mocked(recognizeFreeform);
const judgeStreamMock = vi.mocked(streamFreeformJudge);
const createConversationMock = vi.mocked(createConversation);

/** SSE 响应体桩：按事件顺序逐块吐出，避开 jsdom 里 ReadableStream 的兼容问题。 */
function sseBody(events: unknown[]) {
  const encoder = new TextEncoder();
  let i = 0;
  return {
    getReader: () => ({
      read: async () =>
        i < events.length
          ? { done: false, value: encoder.encode(`data: ${JSON.stringify(events[i++])}\n\n`) }
          : { done: true, value: undefined },
    }),
  };
}

function stubFetch(events: unknown[]) {
  const fetchMock = vi.fn().mockResolvedValue({ ok: true, body: sseBody(events) });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

beforeEach(() => {
  useChatStore.getState().reset();
  useAuxiliaryStore.setState({ currentDialogueId: null, conversations: [], auxErrorCount: 0 });
  recognizeMock.mockReset();
  judgeStreamMock.mockReset();
  createConversationMock.mockReset();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('useFreeformRecognize', () => {
  it('成功写入 result，失败写入 error，reset 清空两者', async () => {
    recognizeMock
      .mockResolvedValueOnce({
        candidates: [
          { id: 'c1', no: '1', content: '题', figureUrls: [], suggestedSubject: null, confidence: 1 },
        ],
        figures: [],
      })
      .mockRejectedValueOnce(new Error('boom'));

    const { result } = renderHook(() => useFreeformRecognize());
    expect(result.current.busy).toBe(false);

    await act(() => result.current.run({ text: '题', attachments: [] }));
    expect(result.current.result?.candidates).toHaveLength(1);
    expect(result.current.error).toBeNull();
    expect(result.current.busy).toBe(false);

    await act(() => result.current.run({ text: '题', attachments: [] }));
    expect(result.current.error).toContain('boom');
    expect(result.current.result).toBeNull();

    act(() => result.current.reset());
    expect(result.current.error).toBeNull();
    expect(result.current.result).toBeNull();
  });

  it('把附件 fileId 原样交给 recognizeFreeform', async () => {
    recognizeMock.mockResolvedValueOnce({ candidates: [], figures: [] });
    const { result } = renderHook(() => useFreeformRecognize());

    await act(() =>
      result.current.run({ text: '题', attachments: [{ type: 'image', fileId: 'f1' }] }),
    );

    expect(recognizeMock).toHaveBeenCalledWith({
      text: '题',
      attachments: [{ type: 'image', fileId: 'f1' }],
    });
  });
});

describe('useFreeformJudge', () => {
  const body = { subjectId: 1, maxScore: 10, questionContent: '题', answer: '答' };

  it('追加用户/助手消息，消费 reasoning/content/result 并记住 questionId', async () => {
    judgeStreamMock.mockImplementation(async function* () {
      yield { type: 'start', dialogueId: '1', questionId: null };
      yield { type: 'reasoning', delta: '想' };
      yield { type: 'content', delta: '报告' };
      yield { type: 'result', questionId: 7, totalScore: 7, maxScore: 10, verdict: 'partial' };
      yield { type: 'done' };
    });

    const { result } = renderHook(() => useFreeformJudge());
    await act(() => result.current.submit(body, { images: ['/a.png'], answerMarkdown: '**答**' }));

    const messages = useChatStore.getState().messages;
    expect(messages).toHaveLength(2);
    expect(messages[0]).toEqual({
      role: 'user',
      content: '**答**',
      images: ['/a.png'],
      markdown: true,
    });
    expect(messages[1].role).toBe('assistant');
    expect(messages[1].reasoning).toBe('想');
    expect(messages[1].content).toBe('报告');

    expect(result.current.questionId).toBe(7);
    expect(result.current.lastResult?.totalScore).toBe(7);
    expect(result.current.submitting).toBe(false);
    expect(useChatStore.getState().isStreaming).toBe(false);
  });

  it('没有 display 时用 body.answer 作为用户气泡，仍标 markdown', async () => {
    judgeStreamMock.mockImplementation(async function* () {
      yield { type: 'done' };
    });

    const { result } = renderHook(() => useFreeformJudge());
    await act(() => result.current.submit(body));

    const user = useChatStore.getState().messages[0];
    expect(user).toEqual({ role: 'user', content: '答', images: undefined, markdown: true });
  });

  it('content 带 replace 时整段覆盖，不带时累加', async () => {
    judgeStreamMock.mockImplementation(async function* () {
      yield { type: 'content', delta: '旧内容' };
      yield { type: 'content', delta: '新内容', replace: true };
      yield { type: 'content', delta: '尾巴' };
      yield { type: 'done' };
    });

    const { result } = renderHook(() => useFreeformJudge());
    await act(() => result.current.submit(body));

    expect(useChatStore.getState().messages[1].content).toBe('新内容尾巴');
  });

  it('error 事件写成可重试的错误气泡', async () => {
    judgeStreamMock.mockImplementation(async function* () {
      yield { type: 'reasoning', delta: '想' };
      yield { type: 'error', code: 1005, message: '额度用尽', retryable: false };
    });

    const { result } = renderHook(() => useFreeformJudge());
    await act(() => result.current.submit(body));

    const last = useChatStore.getState().messages[1];
    expect(last.error).toEqual({ code: 1005, message: '额度用尽', retryable: false });
    expect(last.streaming).toBe(false);
    expect(result.current.questionId).toBeNull();
  });

  it('流抛错时落 1012 网络失败错误', async () => {
    // 流根本没起来（网络/无 body）：第一次 next() 就 reject
    judgeStreamMock.mockImplementation(() => ({
      [Symbol.asyncIterator]: () => ({
        next: () => Promise.reject(new Error('socket closed')),
      }),
    }));

    const { result } = renderHook(() => useFreeformJudge());
    await act(() => result.current.submit(body));

    expect(useChatStore.getState().messages[1].error?.code).toBe(1012);
    expect(result.current.submitting).toBe(false);
  });

  it('isStreaming 为真时 submit 直接返回，不追加消息也不起流', async () => {
    useChatStore.setState({ isStreaming: true });

    const { result } = renderHook(() => useFreeformJudge());
    await act(() => result.current.submit(body));

    expect(judgeStreamMock).not.toHaveBeenCalled();
    expect(useChatStore.getState().messages).toHaveLength(0);
  });

  it('stop() 中断进行中的流、保留已流出内容且不弹错误', async () => {
    let seenSignal: AbortSignal | undefined;
    judgeStreamMock.mockImplementation(async function* (_body, signal) {
      seenSignal = signal;
      yield { type: 'start', dialogueId: '1', questionId: null };
      yield { type: 'reasoning', delta: '想' };
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

    const { result } = renderHook(() => useFreeformJudge());
    let pending: Promise<void> = Promise.resolve();
    await act(async () => {
      pending = result.current.submit(body);
      await Promise.resolve();
    });

    expect(seenSignal?.aborted).toBe(false);
    await act(async () => {
      result.current.stop();
      await pending;
    });

    expect(seenSignal?.aborted).toBe(true);
    expect(useChatStore.getState().messages[1].reasoning).toBe('想');
    expect(useChatStore.getState().messages[1].error).toBeUndefined();
    expect(result.current.submitting).toBe(false);
    expect(useChatStore.getState().isStreaming).toBe(false);
  });
});

describe('useFreeformTutor', () => {
  it('ensureDialogue 建 aux_freeform 会话并返回字符串 id', async () => {
    createConversationMock.mockResolvedValueOnce({
      id: 42,
      track: 'auxiliary',
      scene: 'aux_freeform',
      title: null,
      status: 'active',
      created_at: '2026-11-08T00:00:00.000Z',
    });

    const { result } = renderHook(() => useFreeformTutor());
    let id = '';
    await act(async () => {
      id = await result.current.ensureDialogue('题面', 3);
    });

    expect(createConversationMock).toHaveBeenCalledWith({
      track: 'auxiliary',
      scene: 'aux_freeform',
      subjectId: 3,
      questionText: '题面',
    });
    expect(id).toBe('42');
  });

  it('send 写 chatStore 并消费答疑 SSE，不碰 useAuxiliaryStore', async () => {
    const fetchMock = stubFetch([
      { type: 'reasoning', delta: '想' },
      { type: 'content', delta: '先' },
      { type: 'content', delta: '先算', replace: true },
      { type: 'done' },
    ]);
    const before = {
      currentDialogueId: useAuxiliaryStore.getState().currentDialogueId,
      conversations: useAuxiliaryStore.getState().conversations,
    };
    const prependSpy = vi.spyOn(useAuxiliaryStore.getState(), 'prependConversation');
    const dialogueSpy = vi.spyOn(useAuxiliaryStore.getState(), 'setCurrentDialogueId');
    const fetchSpy = vi.spyOn(useAuxiliaryStore.getState(), 'fetchConversations');

    const { result } = renderHook(() => useFreeformTutor());
    await act(() =>
      result.current.send('42', '这题怎么做', [{ type: 'image', fileId: 'f1' }], ['/a.png']),
    );

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('/api/ai/tutor/stream');
    expect(JSON.parse(String(init.body))).toMatchObject({
      mode: 'auxiliary',
      dialogueId: '42',
      message: '这题怎么做',
      attachments: [{ type: 'image', fileId: 'f1' }],
    });

    const messages = useChatStore.getState().messages;
    expect(messages).toHaveLength(2);
    expect(messages[0]).toEqual({ role: 'user', content: '这题怎么做', images: ['/a.png'] });
    expect(messages[1].reasoning).toBe('想');
    expect(messages[1].content).toBe('先算');
    expect(useChatStore.getState().isStreaming).toBe(false);

    expect(prependSpy).not.toHaveBeenCalled();
    expect(dialogueSpy).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(useAuxiliaryStore.getState().currentDialogueId).toBe(before.currentDialogueId);
    expect(useAuxiliaryStore.getState().conversations).toBe(before.conversations);
  });

  it('空文本且无附件时直接返回，不发起请求也不写消息', async () => {
    const fetchMock = stubFetch([]);
    const { result } = renderHook(() => useFreeformTutor());

    await act(() => result.current.send('42', '   '));

    expect(fetchMock).not.toHaveBeenCalled();
    expect(useChatStore.getState().messages).toHaveLength(0);
  });

  it('fetch 失败时落 1012 错误而不是抛出', async () => {
    const fetchMock = vi.fn().mockRejectedValue(new TypeError('Failed to fetch'));
    vi.stubGlobal('fetch', fetchMock);
    const { result } = renderHook(() => useFreeformTutor());

    await act(() => result.current.send('42', '这题怎么做'));

    expect(useChatStore.getState().messages[1].error?.code).toBe(1012);
    expect(useChatStore.getState().isStreaming).toBe(false);
  });

  it('stop() 中断进行中的请求', async () => {
    let seenSignal: AbortSignal | undefined;
    const fetchMock = vi.fn().mockImplementation((_url: string, init: RequestInit) => {
      seenSignal = init.signal as AbortSignal;
      return new Promise((_resolve, reject) => {
        seenSignal?.addEventListener('abort', () => {
          const err = new Error('aborted');
          err.name = 'AbortError';
          reject(err);
        }, { once: true });
      });
    });
    vi.stubGlobal('fetch', fetchMock);

    const { result } = renderHook(() => useFreeformTutor());
    let pending: Promise<void> = Promise.resolve();
    await act(async () => {
      pending = result.current.send('42', '这题怎么做');
      await Promise.resolve();
    });

    expect(seenSignal?.aborted).toBe(false);
    await act(async () => {
      result.current.stop();
      await pending;
    });

    expect(seenSignal?.aborted).toBe(true);
    // 学生主动停止不算错误，不该冒出网络失败气泡
    expect(useChatStore.getState().messages[1].error).toBeUndefined();
    expect(useChatStore.getState().isStreaming).toBe(false);
  });
});
