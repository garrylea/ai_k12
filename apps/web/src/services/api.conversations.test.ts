import { afterEach, describe, expect, it, vi } from 'vitest';
import { listConversations } from './api';

afterEach(() => vi.unstubAllGlobals());

function stubFetch(data: unknown) {
  const fetchMock = vi.fn().mockResolvedValue({
    json: () => Promise.resolve({ code: 0, message: 'ok', data }),
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

describe('listConversations query', () => {
  it('多 scene 逗号拼接 + hasChat=1（钉全串，含 /api 前缀）', async () => {
    const fetchMock = stubFetch([]);

    await listConversations('auxiliary', ['aux_qna', 'aux_freeform'], undefined, { hasChat: true });

    expect(fetchMock.mock.calls[0][0]).toBe(
      '/api/conversations?track=auxiliary&scene=aux_qna%2Caux_freeform&hasChat=1',
    );
  });
});
