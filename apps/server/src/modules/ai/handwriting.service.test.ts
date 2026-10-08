import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../../ai-core/infra/model-config-registry.js', () => ({
  getModelConfigRegistry: vi.fn(),
}));

import { getModelConfigRegistry } from '../../ai-core/infra/model-config-registry.js';
import type { ModelRouter } from '../../ai-core/infra/model-router.js';
import { HandwritingService, HANDWRITING_TRANSCRIBE_PROMPT } from './handwriting.service.js';

const PNG = 'data:image/png;base64,iVBORw0KGgo=';
const ROUTED = {
  modelId: 'Qwen3.8-27B', provider: 'local', baseUrl: 'http://localhost:8080',
  contextWindow: 32768, maxOutputTokens: 4096,
  costPer1K: { input: 0, output: 0 }, supportsStreaming: true,
  apiKey: 'sk-test', scene: 'handwriting', subject: 'chinese', modelKey: 'local',
} as const;

function makeService(opts: { route?: typeof ROUTED; chat?: (req: unknown) => Promise<unknown> } = {}) {
  const chat = vi.fn(opts.chat ?? (async () => ({ content: '  庆历四年春  ' })));
  const route = vi.fn(() => ({ primary: opts.route ?? ROUTED, reason: 'test' }));
  const service = new HandwritingService({
    modelRouter: { route } as unknown as ModelRouter,
    modelClient: { chat } as never,
  });
  return { service, chat, route };
}

beforeEach(() => {
  vi.mocked(getModelConfigRegistry).mockReturnValue({ getSnapshot: () => ({ models: {}, routes: {}, default: { primary: '', fallback: '' } }) } as never);
});

describe('HandwritingService.transcribe', () => {
  it('走 ModelRouter(scene handwriting, subject chinese)，system prompt + image_url 部件，thinking:false，meta 无 studentId', async () => {
    const { service, chat, route } = makeService();
    const res = await service.transcribe(PNG);
    expect(res).toMatchObject({ text: '庆历四年春', modelKey: 'local' });
    expect(route).toHaveBeenCalledWith({ scene: 'handwriting', subject: 'chinese' });
    const req = chat.mock.calls[0][0] as Record<string, any>;
    expect(req.model).toBe(ROUTED);
    expect(req.messages[0]).toEqual({ role: 'system', content: HANDWRITING_TRANSCRIBE_PROMPT });
    expect(req.messages[1]).toEqual({
      role: 'user',
      content: [
        { type: 'text', text: '转写' },
        { type: 'image_url', image_url: { url: PNG } },
      ],
    });
    expect(req.thinking).toBe(false);
    expect(req.meta).toEqual({ capability: 'handwriting_transcribe' });
  });

  it('image 前缀非法 → 400；解码 >4MB → 400', async () => {
    const { service } = makeService();
    await expect(service.transcribe('not-a-url')).rejects.toMatchObject({ status: 400 });
    const big = 'data:image/png;base64,' + Buffer.alloc(4 * 1024 * 1024 + 1).toString('base64');
    await expect(service.transcribe(big)).rejects.toMatchObject({ status: 400 });
  });

  it('上游失败 → 502', async () => {
    const { service } = makeService({ chat: async () => { throw new Error('boom'); } });
    await expect(service.transcribe(PNG)).rejects.toMatchObject({ status: 502 });
  });
});
