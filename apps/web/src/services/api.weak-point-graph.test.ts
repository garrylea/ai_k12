import { afterEach, describe, expect, it, vi } from 'vitest';
import { getKnowledgeGraphMastery, getWeakPoints } from './api';

/**
 * 只钉 URL 拼装：路径段 + 查询串必须与后端 `@Controller('api/knowledge-graph')` 逐字对上，
 * 拼错（少 `/api`、把 subjectId 写成 path 段）在本仓是静默 404，只有这个用例能拦住。
 */
afterEach(() => {
  vi.unstubAllGlobals();
});

function stubFetch(data: unknown) {
  const fetchMock = vi.fn().mockResolvedValue({
    json: () => Promise.resolve({ code: 0, message: 'ok', data }),
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

describe('getKnowledgeGraphMastery', () => {
  it('打 /knowledge-graph/students/:id/mastery?subjectId=1', async () => {
    const fetchMock = stubFetch({ subjectId: 1, nodes: [], coverage: {} });

    await getKnowledgeGraphMastery(7, 1);

    expect(fetchMock.mock.calls[0][0]).toContain('/knowledge-graph/students/7/mastery?subjectId=1');
  });
});

describe('getWeakPoints', () => {
  it('默认 limit=1，写在查询串里', async () => {
    const fetchMock = stubFetch({ subjectId: 1, candidates: [], recommendation: null, reason: 'no_qualified_candidate' });

    await getWeakPoints(7, 1);

    expect(fetchMock.mock.calls[0][0]).toContain('/knowledge-graph/students/7/weak-points?subjectId=1&limit=1');
  });

  it('显式 limit 透传', async () => {
    const fetchMock = stubFetch({ subjectId: 1, candidates: [], recommendation: null, reason: 'ok' });

    await getWeakPoints(7, 1, 5);

    expect(fetchMock.mock.calls[0][0]).toContain('limit=5');
  });
});
