import { describe, it, expect, vi, beforeEach } from 'vitest';
import { JudgmentCapability } from './judgment.capability.js';
import type { ModelClient } from '../infra/model-client/index.js';
import type { ModelRouter } from '../infra/model-router.js';
import type { RoutedModel } from '../types.js';

const mockChat = vi.fn();
const mockModelClient = { chat: mockChat } as unknown as ModelClient;

const primaryModel: RoutedModel = {
  provider: 'local', modelId: 'Qwen3.8-27B', baseUrl: 'http://192.168.1.8:12345', apiKey: 'local',
  contextWindow: 32768, maxOutputTokens: 4096, costPer1K: { input: 0, output: 0 }, supportsStreaming: true,
};
const fallbackModel: RoutedModel = {
  provider: 'deepseek', modelId: 'deepseek-v4-flash', baseUrl: 'https://api.deepseek.com', apiKey: 'sk-x',
  contextWindow: 131072, maxOutputTokens: 65536, costPer1K: { input: 0.001, output: 0.004 }, supportsStreaming: true,
};

function routerWith(primary: RoutedModel, fallback?: RoutedModel): ModelRouter {
  return { route: () => ({ primary, fallback, reason: 'test' }) } as unknown as ModelRouter;
}

const judgeRequest = {
  questionContent: '解方程 $x^2-4=0$',
  standardAnswer: '$x=\\pm 2$',
  reference: '',
  studentAnswer: '$x=2$',
  subject: 'math' as const,
  questionType: 'calculation' as const,
};

beforeEach(() => mockChat.mockReset());

describe('JudgmentCapability', () => {
  it('答错返回 isCorrect=false + errorType（不再生成 analysis）', async () => {
    mockChat.mockResolvedValueOnce({
      content: '{"isCorrect":false,"errorType":"calculation"}',
      reasoningContent: '',
    });
    const cap = new JudgmentCapability({ modelClient: mockModelClient });
    const r = await cap.judge(judgeRequest);
    expect(r.isCorrect).toBe(false);
    expect(r.analysis ?? null).toBeNull();
    expect(r.errorType).toBe('calculation');
  });

  it('答对返回 isCorrect=true', async () => {
    mockChat.mockResolvedValueOnce({
      content: '{"isCorrect":true,"errorType":null}',
      reasoningContent: '',
    });
    const r = await new JudgmentCapability({ modelClient: mockModelClient }).judge({
      questionContent: 'q',
      standardAnswer: 'a',
      reference: '',
      studentAnswer: 'a',
      subject: 'math',
      questionType: 'calculation',
    });
    expect(r.isCorrect).toBe(true);
  });

  it('本地模型失败时回退到 ds v4 flash', async () => {
    mockChat
      .mockRejectedValueOnce(new Error('connect ECONNREFUSED 192.168.1.8:12345'))
      .mockResolvedValueOnce({ content: '{"isCorrect":true}', reasoningContent: '' });
    const cap = new JudgmentCapability({ modelClient: mockModelClient, modelRouter: routerWith(primaryModel, fallbackModel) });
    const r = await cap.judge(judgeRequest);
    expect(r.isCorrect).toBe(true);
    expect(mockChat).toHaveBeenCalledTimes(2);
    expect(mockChat.mock.calls[0][0].model.modelId).toBe('Qwen3.8-27B');
    expect(mockChat.mock.calls[1][0].model.modelId).toBe('deepseek-v4-flash');
  });

  it('primary 返回不可解析内容时也回退（任何失败都回退）', async () => {
    mockChat
      .mockResolvedValueOnce({ content: '这不是 JSON', reasoningContent: '' })
      .mockResolvedValueOnce({ content: '{"isCorrect":true}', reasoningContent: '' });
    const cap = new JudgmentCapability({ modelClient: mockModelClient, modelRouter: routerWith(primaryModel, fallbackModel) });
    const r = await cap.judge(judgeRequest);
    expect(r.isCorrect).toBe(true);
    expect(mockChat).toHaveBeenCalledTimes(2);
    expect(mockChat.mock.calls[1][0].model.modelId).toBe('deepseek-v4-flash');
  });

  it('primary 成功时不调用 fallback', async () => {
    mockChat.mockResolvedValueOnce({ content: '{"isCorrect":false,"errorType":"calculation"}', reasoningContent: '' });
    const cap = new JudgmentCapability({ modelClient: mockModelClient, modelRouter: routerWith(primaryModel, fallbackModel) });
    const r = await cap.judge(judgeRequest);
    expect(r.isCorrect).toBe(false);
    expect(mockChat).toHaveBeenCalledTimes(1);
    expect(mockChat.mock.calls[0][0].model.modelId).toBe('Qwen3.8-27B');
  });

  it('无 fallback 时 primary 失败直接抛错', async () => {
    mockChat.mockRejectedValueOnce(new Error('local down'));
    const cap = new JudgmentCapability({ modelClient: mockModelClient, modelRouter: routerWith(primaryModel) });
    await expect(cap.judge(judgeRequest)).rejects.toThrow('local down');
    expect(mockChat).toHaveBeenCalledTimes(1);
  });

  it('primary 与 fallback 都失败时抛组合错误（点名两个模型）', async () => {
    mockChat
      .mockRejectedValueOnce(new Error('local down'))
      .mockRejectedValueOnce(new Error('ds down'));
    const cap = new JudgmentCapability({ modelClient: mockModelClient, modelRouter: routerWith(primaryModel, fallbackModel) });
    await expect(cap.judge(judgeRequest)).rejects.toThrow(/primary\(Qwen3\.8-27B\).*fallback\(deepseek-v4-flash\)/s);
    expect(mockChat).toHaveBeenCalledTimes(2);
  });
});
