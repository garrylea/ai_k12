import { afterEach, describe, expect, it, vi } from 'vitest';
import { getPaperPositions } from './api';

afterEach(() => vi.unstubAllGlobals());

function stubFetch(data: unknown) {
  const fetchMock = vi.fn().mockResolvedValue({
    json: () => Promise.resolve({ code: 0, message: 'ok', data }),
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

describe('getPaperPositions query', () => {
  it('只传学科：不带 grade/semester', async () => {
    const fetchMock = stubFetch({ options: [] });
    await getPaperPositions(1);
    expect(fetchMock.mock.calls[0][0]).toBe('/api/training/paper-positions?subjectId=1');
  });

  it('带年级学期：两者都拼进 query（中文编码）', async () => {
    const fetchMock = stubFetch({ options: [] });
    await getPaperPositions(1, '初三', 'first');
    expect(fetchMock.mock.calls[0][0]).toBe(
      '/api/training/paper-positions?subjectId=1&grade=%E5%88%9D%E4%B8%89&semester=first',
    );
  });
});
