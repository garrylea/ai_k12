import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, renderHook } from '@testing-library/react';
import {
  createConversation,
  recognizeFreeform,
  streamFreeformJudge,
  streamTutorEvents,
} from '@/services/api';
import { useChatStore } from '@/store/chatStore';
import { useAuxiliaryStore } from '@/store/auxiliaryStore';
import { useFreeformRecognize } from './useFreeformRecognize';
import { JUDGE_INACTIVITY_MS, useFreeformJudge } from './useFreeformJudge';
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
    streamTutorEvents: vi.fn(),
    createConversation: vi.fn(),
  };
});

const recognizeMock = vi.mocked(recognizeFreeform);
const judgeStreamMock = vi.mocked(streamFreeformJudge);
const tutorStreamMock = vi.mocked(streamTutorEvents);
const createConversationMock = vi.mocked(createConversation);

/** SSE 响应体桩：按原始文本块顺序吐出，用于验证解析器的尾块处理。 */
function rawBody(chunks: string[]) {
  const encoder = new TextEncoder();
  let i = 0;
  return {
    getReader: () => ({
      read: async () =>
        i < chunks.length
          ? { done: false, value: encoder.encode(chunks[i++]) }
          : { done: true, value: undefined },
    }),
  };
}

function stubFetch(chunks: string[]) {
  const fetchMock = vi.fn().mockResolvedValue({ ok: true, body: rawBody(chunks) });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

beforeEach(() => {
  useChatStore.getState().reset();
  useAuxiliaryStore.setState({ currentDialogueId: null, conversations: [], auxErrorCount: 0 });
  recognizeMock.mockReset();
  judgeStreamMock.mockReset();
  tutorStreamMock.mockReset();
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

  it('学生停止：标记 stopped、不报错、复位移流状态', async () => {
    judgeStreamMock.mockImplementation(async function* (_b: unknown, signal?: AbortSignal) {
      yield { type: 'start', dialogueId: '1', questionId: null };
      await new Promise((_, reject) => {
        const abort = () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
        if (signal?.aborted) abort();
        else signal?.addEventListener('abort', abort, { once: true });
      });
    });

    const { result } = renderHook(() => useFreeformJudge());
    await act(async () => {
      const pending = result.current.submit(body);
      await Promise.resolve();
      result.current.stop();
      await pending;
    });

    expect(result.current.stopped).toBe(true);
    expect(result.current.submitting).toBe(false);
    expect(useChatStore.getState().messages.at(-1)?.error).toBeUndefined();
    expect(useChatStore.getState().isStreaming).toBe(false);
  });

  it('reset：清空 questionId/lastResult/消息，且不再复用旧 body', async () => {
    judgeStreamMock.mockImplementation(async function* () {
      yield { type: 'result', questionId: 7, totalScore: 7, maxScore: 10, verdict: 'partial', correctAnswer: 'x=1' };
    });

    const { result } = renderHook(() => useFreeformJudge());
    await act(() => result.current.submit(body));
    expect(result.current.lastResult).toBeTruthy();
    expect(useChatStore.getState().messages.length).toBeGreaterThan(0);

    act(() => result.current.reset());
    expect(result.current.questionId).toBeNull();
    expect(result.current.lastResult).toBeNull();
    expect(result.current.submitting).toBe(false);
    expect(result.current.stopped).toBe(false);
    expect(useChatStore.getState().messages).toEqual([]);

    // 旧 body 已清：retry 不会偷偷重发上一题
    await act(() => result.current.retry());
    expect(judgeStreamMock).toHaveBeenCalledTimes(1);
  });

  it('reset 在流中：中断旧流、不落错误、消息清空', async () => {
    judgeStreamMock.mockImplementation(async function* (_b: unknown, signal?: AbortSignal) {
      yield { type: 'reasoning', delta: '想' };
      await new Promise((_, reject) => {
        const abort = () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
        if (signal?.aborted) abort();
        else signal?.addEventListener('abort', abort, { once: true });
      });
    });

    const { result } = renderHook(() => useFreeformJudge());
    await act(async () => {
      const pending = result.current.submit(body);
      await Promise.resolve();
      result.current.reset();
      await pending;
    });

    expect(result.current.submitting).toBe(false);
    expect(useChatStore.getState().messages).toEqual([]);
    expect(useChatStore.getState().isStreaming).toBe(false);
  });

  it('判题流长时间没有任何事件 → 超时报错，不无限转圈', async () => {
    vi.useFakeTimers();
    try {
      judgeStreamMock.mockImplementation(async function* (_b: unknown, signal?: AbortSignal) {
        yield { type: 'start', dialogueId: '1', questionId: null };
        await new Promise((_, reject) => {
          signal?.addEventListener('abort', () =>
            reject(Object.assign(new Error('aborted'), { name: 'AbortError' })),
          );
        });
      });

      const { result } = renderHook(() => useFreeformJudge());
      await act(async () => {
        const pending = result.current.submit(body);
        await vi.advanceTimersByTimeAsync(JUDGE_INACTIVITY_MS + 10);
        await pending;
      });

      expect(useChatStore.getState().messages.at(-1)?.error).toMatchObject({
        code: 1009,
        stage: 'judge',
        retryable: true,
      });
      expect(result.current.submitting).toBe(false);
      expect(result.current.stopped).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it('追加用户/助手消息，消费 reasoning/content/result 并记住 questionId', async () => {
    judgeStreamMock.mockImplementation(async function* () {
      yield { type: 'start', dialogueId: '1', questionId: null };
      yield { type: 'reasoning', delta: '想' };
      yield { type: 'content', delta: '报告' };
      yield { type: 'result', questionId: 7, totalScore: 7, maxScore: 10, verdict: 'partial', correctAnswer: 'x=1' };
      yield { type: 'done' };
    });

    const { result } = renderHook(() => useFreeformJudge());
    await act(() => result.current.submit(body, { images: ['/a.png'], answerMarkdown: '**答**' }));

    // 展示层用 markdown，但上行 body 必须是原始答案串，不能被 display 污染
    expect(judgeStreamMock).toHaveBeenCalledWith(body, expect.any(AbortSignal));

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
    expect(last.error).toEqual({
      code: 1005,
      message: '额度用尽',
      retryable: false,
      stage: 'judge',
    });
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

  it('错误气泡重试：复用上一次的 body，不再追加用户气泡', async () => {
    judgeStreamMock
      .mockImplementationOnce(async function* () {
        yield { type: 'error', code: 5000, message: '判题失败', retryable: true };
      })
      .mockImplementationOnce(async function* () {
        yield { type: 'content', delta: '重试后的报告' };
        yield { type: 'done' };
      });

    const { result } = renderHook(() => useFreeformJudge());
    await act(() => result.current.submit(body, { images: ['/a.png'], answerMarkdown: '**答**' }));

    expect(useChatStore.getState().messages).toHaveLength(2);

    await act(() => result.current.retry());

    // 重发的是同一条判题请求：不重新上传/不重发首问，用户气泡仍只有一条
    expect(judgeStreamMock).toHaveBeenCalledTimes(2);
    expect(judgeStreamMock.mock.calls[1][0]).toEqual(body);

    const messages = useChatStore.getState().messages;
    expect(messages).toHaveLength(2);
    expect(messages[0].role).toBe('user');
    expect(messages[1]).toMatchObject({
      role: 'assistant',
      content: '重试后的报告',
    });
    expect(messages[1].error).toBeUndefined();
    expect(result.current.submitting).toBe(false);
  });

  it('没有可重试的判题时 retry 是空操作', async () => {
    const { result } = renderHook(() => useFreeformJudge());
    await act(() => result.current.retry());

    expect(judgeStreamMock).not.toHaveBeenCalled();
    expect(useChatStore.getState().messages).toHaveLength(0);
  });

  it('重新判题时先清空上一轮的 questionId / lastResult', async () => {
    judgeStreamMock.mockImplementation(async function* () {
      yield { type: 'result', questionId: 7, totalScore: 7, maxScore: 10, verdict: 'partial', correctAnswer: 'x=1' };
      yield { type: 'done' };
    });

    const { result } = renderHook(() => useFreeformJudge());
    await act(() => result.current.submit(body));
    expect(result.current.questionId).toBe(7);
    expect(result.current.lastResult?.totalScore).toBe(7);

    // 第二次提交：流停在半路（尚未出 result）—— 上一轮的分数/错题 id 必须已经不在了
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    judgeStreamMock.mockImplementation(async function* () {
      yield { type: 'start', dialogueId: '1', questionId: null };
      yield { type: 'reasoning', delta: '再看' };
      await gate;
      yield { type: 'error', code: 1005, message: '额度用尽', retryable: false };
    });

    let pending: Promise<void> = Promise.resolve();
    await act(async () => {
      pending = result.current.submit(body);
      await Promise.resolve();
    });

    expect(result.current.submitting).toBe(true);
    expect(result.current.questionId).toBeNull();
    expect(result.current.lastResult).toBeNull();

    await act(async () => {
      release();
      await pending;
    });
    // 中途失败也不该回填旧结果
    expect(result.current.questionId).toBeNull();
    expect(result.current.lastResult).toBeNull();
    expect(useChatStore.getState().messages[3].error?.code).toBe(1005);
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
    tutorStreamMock.mockImplementation(async function* () {
      yield { type: 'reasoning', delta: '想' };
      yield { type: 'content', delta: '先' };
      yield { type: 'content', delta: '先算', replace: true };
      yield { type: 'done' };
    });
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

    // 走共享的 streamTutorEvents（尾部 flush 已在那里实现），hook 只做事件 → store 映射
    expect(tutorStreamMock).toHaveBeenCalledTimes(1);
    expect(tutorStreamMock).toHaveBeenCalledWith(
      {
        mode: 'auxiliary',
        dialogueId: '42',
        message: '这题怎么做',
        attachments: [{ type: 'image', fileId: 'f1' }],
      },
      expect.any(AbortSignal),
    );

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

  it('带学科时下发 subjectId（学习档案由服务端从 DB 取，前端不上报）', async () => {
    tutorStreamMock.mockImplementation(async function* () {
      yield { type: 'done' };
    });

    const { result } = renderHook(() => useFreeformTutor());
    await act(() => result.current.send('42', '这题怎么做', undefined, undefined, { subjectId: 4 }));

    expect(tutorStreamMock).toHaveBeenCalledWith(
      { mode: 'auxiliary', dialogueId: '42', message: '这题怎么做', subjectId: 4 },
      expect.any(AbortSignal),
    );
  });

  it('纯图片提问时 message 兜底非空串，附件原样上行', async () => {
    tutorStreamMock.mockImplementation(async function* () {
      yield { type: 'done' };
    });

    const { result } = renderHook(() => useFreeformTutor());
    await act(() => result.current.send('42', '  ', [{ type: 'image', fileId: 'f1' }]));

    expect(tutorStreamMock).toHaveBeenCalledWith(
      {
        mode: 'auxiliary',
        dialogueId: '42',
        message: '帮我看一下这道题',
        attachments: [{ type: 'image', fileId: 'f1' }],
      },
      expect.any(AbortSignal),
    );
    expect(useChatStore.getState().messages[0].content).toBe('');
  });

  it('error 事件写成错误气泡，code/retryable 缺省时兜底', async () => {
    tutorStreamMock
      .mockImplementationOnce(async function* () {
        yield { type: 'error', code: 1005, message: '额度用尽', retryable: false };
      })
      .mockImplementationOnce(async function* () {
        yield { type: 'error' };
      });

    const { result } = renderHook(() => useFreeformTutor());
    await act(() => result.current.send('42', '这题怎么做'));
    expect(useChatStore.getState().messages[1].error).toEqual({
      code: 1005,
      message: '额度用尽',
      retryable: false,
      stage: 'tutor',
    });

    await act(() => result.current.send('42', '再说一次'));
    expect(useChatStore.getState().messages[3].error).toEqual({
      code: 5000,
      message: 'AI 服务异常',
      retryable: true,
      stage: 'tutor',
    });
    expect(useChatStore.getState().isStreaming).toBe(false);
  });

  it('空文本且无附件时直接返回，不发起请求也不写消息', async () => {
    const { result } = renderHook(() => useFreeformTutor());

    await act(() => result.current.send('42', '   '));

    expect(tutorStreamMock).not.toHaveBeenCalled();
    expect(useChatStore.getState().messages).toHaveLength(0);
  });

  it('流抛错时落 1012 错误而不是抛出', async () => {
    tutorStreamMock.mockImplementation(() => ({
      [Symbol.asyncIterator]: () => ({
        next: () => Promise.reject(new TypeError('Failed to fetch')),
      }),
    }));
    const { result } = renderHook(() => useFreeformTutor());

    await act(() => result.current.send('42', '这题怎么做'));

    expect(useChatStore.getState().messages[1].error?.code).toBe(1012);
    expect(useChatStore.getState().isStreaming).toBe(false);
  });

  it('stop() 中断进行中的请求（AbortError 不弹错误）', async () => {
    let seenSignal: AbortSignal | undefined;
    tutorStreamMock.mockImplementation(async function* (_req, signal) {
      seenSignal = signal;
      yield { type: 'content', delta: '已流出' };
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
    // 学生主动停止不算错误，不该冒出网络失败气泡；已流出的内容保留
    expect(useChatStore.getState().messages[1].content).toBe('已流出');
    expect(useChatStore.getState().messages[1].error).toBeUndefined();
    expect(useChatStore.getState().isStreaming).toBe(false);
  });

  it('末尾没有换行的 data 行也被消费（复用 streamTutorEvents 的尾部 flush）', async () => {
    // 用真实实现跑一遍：hook 不再自带解析器，尾块丢事件的问题由 api.ts 兜住
    const { streamTutorEvents: actualStreamTutorEvents } =
      await vi.importActual<typeof import('@/services/api')>('@/services/api');
    tutorStreamMock.mockImplementation(actualStreamTutorEvents);

    const fetchMock = stubFetch([
      'data: {"type":"content","delta":"前半"}\n\n',
      'data: {"type":"content","delta":"尾巴"}',
    ]);

    const { result } = renderHook(() => useFreeformTutor());
    await act(() => result.current.send('42', '这题怎么做'));

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(useChatStore.getState().messages[1].content).toBe('前半尾巴');
  });
});
