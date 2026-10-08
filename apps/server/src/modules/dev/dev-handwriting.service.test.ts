import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../../ai-core/infra/model-config-registry.js', () => ({
  getModelConfigRegistry: vi.fn(),
}));

import { getModelConfigRegistry } from '../../ai-core/infra/model-config-registry.js';
import {
  DevHandwritingService,
  HANDWRITING_SYSTEM_PROMPT,
} from './dev-handwriting.service.js';

const fakeModelConfig = {
  modelId: 'qwen3.8-max',
  provider: 'qwen',
  baseUrl: 'https://dashscope.example/compatible-mode/v1',
  contextWindow: 8192,
  maxOutputTokens: 2048,
  costPer1K: { input: 0, output: 0 },
  supportsStreaming: true,
  apiKey: 'sk-test',
};

function mockRegistry(models: Record<string, object>) {
  vi.mocked(getModelConfigRegistry).mockReturnValue({
    getSnapshot: () => ({ models, routes: {}, default: { primary: '', fallback: '' } }),
  } as never);
}

function makeService(chatImpl?: (req: unknown) => Promise<unknown>) {
  const chat = vi.fn<(req: unknown) => Promise<unknown>>(
    chatImpl ?? (async () => ({ content: '  天空很蓝 ' })),
  );
  const service = new DevHandwritingService({
    modelClient: { chat } as never,
  });
  return { service, chat };
}

const PNG = 'data:image/png;base64,iVBORw0KGgo=';

beforeEach(() => {
  vi.clearAllMocks();
  mockRegistry({ 'qwen-test': fakeModelConfig });
});

describe('listModels', () => {
  it('只暴露 key/provider/modelId，绝不带 apiKey', () => {
    const { service } = makeService();
    const res = service.listModels();
    expect(res.models).toEqual([
      { key: 'qwen-test', provider: 'qwen', modelId: 'qwen3.8-max' },
    ]);
    expect(JSON.stringify(res)).not.toContain('sk-test');
  });

  it('registry 未初始化 → 503', () => {
    vi.mocked(getModelConfigRegistry).mockReturnValue(undefined);
    const { service } = makeService();
    expect(() => service.listModels()).toThrowError(
      expect.objectContaining({ status: 503 }),
    );
  });
});

describe('recognize', () => {
  it('正常路径：system+user 消息、image_url 部件、meta 不归属学生、返回 trim 后文本', async () => {
    const { service, chat } = makeService();
    const res = await service.recognize(PNG, 'qwen-test');
    expect(res).toMatchObject({ text: '天空很蓝', modelKey: 'qwen-test' });
    expect(typeof res.elapsedMs).toBe('number');
    const req = chat.mock.calls[0][0] as { messages: unknown[]; meta: unknown };
    expect(req.messages[0]).toEqual({ role: 'system', content: HANDWRITING_SYSTEM_PROMPT });
    expect(req.messages[1]).toEqual({
      role: 'user',
      content: [
        { type: 'text', text: '转写' },
        { type: 'image_url', image_url: { url: PNG } },
      ],
    });
    expect(req.meta).toEqual({ studentId: null, capability: 'handwriting_demo' });
  });

  it('image 前缀非法 → 400', async () => {
    const { service } = makeService();
    await expect(service.recognize('data:text/html;base64,xxx', 'qwen-test')).rejects.toMatchObject({ status: 400 });
    await expect(service.recognize('not-a-url', 'qwen-test')).rejects.toMatchObject({ status: 400 });
  });

  it('解码后 >4MB → 400', async () => {
    const { service } = makeService();
    const big = 'data:image/png;base64,' + Buffer.alloc(4 * 1024 * 1024 + 1).toString('base64');
    await expect(service.recognize(big, 'qwen-test')).rejects.toMatchObject({ status: 400 });
  });

  it('modelKey 不存在 → 404', async () => {
    const { service } = makeService();
    await expect(service.recognize(PNG, 'nope')).rejects.toMatchObject({ status: 404 });
  });

  it('上游模型失败 → 502', async () => {
    const { service } = makeService(async () => { throw new Error('upstream boom'); });
    await expect(service.recognize(PNG, 'qwen-test')).rejects.toMatchObject({ status: 502 });
  });
});
