import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  ApiError,
  endStudySession,
  getMyPoints,
  getParentChatLogDetail,
  getParentChatLogs,
  getParentDashboard,
  getParentErrors,
  getParentPointLedger,
  getParentReport,
  getParentStudyTime,
  heartbeatStudySession,
  redeemParentPoints,
  saveParentPointRules,
  setRedemptionStatus,
  startStudySession,
} from './api';

/**
 * `fetchApi` 把 HTTP 状态码带进 `ApiError.status`（终审修复 Finding 6 的地基）。
 *
 * 为什么必须有这条：会话页靠 `err.status` 区分「客户端 4xx，重试也不会好」与
 * 「网络/5xx，可重试」。若 `fetchApi` 忘了传 `res.status`，分类永远走不到 4xx 分支，
 * 而页面测试里手搓 `ApiError` 是发现不了的——那会是一条假装覆盖了的回归。
 */

afterEach(() => {
  vi.unstubAllGlobals();
});

function stubFetch(status: number, body: unknown) {
  const fn = vi.fn().mockResolvedValue({
    status,
    json: async () => body,
  });
  vi.stubGlobal('fetch', fn);
  return fn;
}

function requestUrl(fetchMock: ReturnType<typeof vi.fn>, call = 0): string {
  return fetchMock.mock.calls[call]![0] as string;
}

function requestInit(fetchMock: ReturnType<typeof vi.fn>, call = 0): RequestInit {
  return fetchMock.mock.calls[call]![1] as RequestInit;
}

/** 断言必须落在**解析后**的 body 上：`JSON.stringify` 会保留 `null`，字符串包含判断分辨不出「丢了字段」。 */
function requestBody(fetchMock: ReturnType<typeof vi.fn>, call = 0): Record<string, unknown> {
  return JSON.parse(requestInit(fetchMock, call).body as string) as Record<string, unknown>;
}

describe('fetchApi 错误形状', () => {
  it('业务码非 0 时抛 ApiError，且带上 HTTP status（401 → 1003）', async () => {
    stubFetch(401, { code: 1003, message: '未登录', data: null });

    await expect(getMyPoints()).rejects.toBeInstanceOf(ApiError);
    await expect(getMyPoints()).rejects.toMatchObject({ code: 1003, status: 401 });
  });

  it('404（会话不存在）同样带回 status，供调用方判定不可重试', async () => {
    stubFetch(404, { code: 1002, message: '训练会话不存在', data: null });

    await expect(getMyPoints()).rejects.toMatchObject({ code: 1002, status: 404 });
  });

  it('成功响应不抛错，正常返回 data', async () => {
    stubFetch(200, { code: 0, message: 'ok', data: { balance: 120 } });

    await expect(getMyPoints()).resolves.toMatchObject({ balance: 120 });
  });
});

describe('家长端积分/奖励/兑换 API', () => {
  it('saveParentPointRules：dailyLimit=null 原样发出（不转 0、不丢字段）', async () => {
    const f = stubFetch(200, { code: 0, message: 'ok', data: null });

    await saveParentPointRules(7, [
      { taskCode: 'math_practice', tierKey: 't3', points: 5, dailyLimit: null, isActive: true },
    ]);

    expect(f).toHaveBeenCalledTimes(1);
    expect(requestUrl(f)).toBe('/api/parent/students/7/points/rules');
    expect(requestInit(f).method).toBe('PUT');

    const rules = requestBody(f).rules as Array<Record<string, unknown>>;
    expect(rules).toHaveLength(1);
    expect(Object.keys(rules[0]!).sort()).toEqual(['dailyLimit', 'isActive', 'points', 'taskCode', 'tierKey']);
    expect(rules[0]!.dailyLimit).toBeNull();
  });

  it('redeemParentPoints：cash body 恰好 {type,points}，不带 catalogId', async () => {
    const f = stubFetch(201, { code: 0, message: 'ok', data: null });

    await redeemParentPoints(7, { type: 'cash', points: 100 });

    expect(requestUrl(f)).toBe('/api/parent/students/7/points/redeem');
    expect(requestInit(f).method).toBe('POST');
    const body = requestBody(f);
    expect(Object.keys(body).sort()).toEqual(['points', 'type']);
    expect(body).toEqual({ type: 'cash', points: 100 });
  });

  it('redeemParentPoints：reward body 恰好 {type,catalogId}，不带 points', async () => {
    const f = stubFetch(201, { code: 0, message: 'ok', data: null });

    await redeemParentPoints(7, { type: 'reward', catalogId: 33 });

    const body = requestBody(f);
    expect(Object.keys(body).sort()).toEqual(['catalogId', 'type']);
    expect(body).toEqual({ type: 'reward', catalogId: 33 });
  });

  it('setRedemptionStatus：路径里没有 studentId（服务端按 id 反查归属）', async () => {
    const f = stubFetch(200, { code: 0, message: 'ok', data: null });

    await setRedemptionStatus(42, 'fulfilled');

    expect(requestUrl(f)).toBe('/api/parent/redemptions/42');
    expect(requestUrl(f)).not.toContain('students');
    expect(requestInit(f).method).toBe('PATCH');
    expect(requestBody(f)).toEqual({ status: 'fulfilled' });
  });

  it('getParentPointLedger：pageSize 省略时不硬编，让后端默认 20 生效', async () => {
    const f = stubFetch(200, { code: 0, message: 'ok', data: { items: [], total: 0, page: 1, pageSize: 20 } });

    await getParentPointLedger(7, 1);
    expect(requestUrl(f)).toBe('/api/parent/students/7/points/ledger?page=1');

    await getParentPointLedger(7, 2, 50);
    expect(requestUrl(f, 1)).toBe('/api/parent/students/7/points/ledger?page=2&pageSize=50');
  });
});

/**
 * 复用本文件既有的 `stubFetch(status, body)`——它包的信封就是 `fetchApi` 解析的
 * `{code, message, data}`，再定义第二个同名 helper 会直接编译不过。
 */
function stubData(data: unknown) {
  return stubFetch(200, { code: 0, message: 'ok', data });
}

describe('家长端学情端点：路径与 query', () => {
  it('getParentDashboard → GET /api/parent/dashboard', async () => {
    const fetchMock = stubData({ students: [], unreadAlerts: 0 });

    await getParentDashboard();

    expect(fetchMock.mock.calls[0][0]).toBe('/api/parent/dashboard');
    expect(fetchMock.mock.calls[0][1]?.method).toBeUndefined(); // GET 不写 method
  });

  it('getParentReport → 路径 + period query', async () => {
    const fetchMock = stubData({});

    await getParentReport(11, 'monthly');

    expect(fetchMock.mock.calls[0][0]).toBe('/api/parent/students/11/reports?period=monthly');
  });

  it('getParentErrors → 只拼有值的 query，page 省略时也不出现', async () => {
    const fetchMock = stubData({ items: [], page: 1, pageSize: 20, total: 0 });

    await getParentErrors({ studentId: 11, track: 'main', cleared: 'uncleared' });

    const url = fetchMock.mock.calls[0][0] as string;
    expect(url.startsWith('/api/parent/students/11/errors?')).toBe(true);
    expect(url).toContain('track=main');
    expect(url).toContain('cleared=uncleared');
    expect(url).not.toContain('page=');
    expect(url).not.toContain('undefined');
    expect(url).not.toContain('null');
  });

  it('getParentChatLogs → q 走 URL 编码（中文与空格不能裸拼）', async () => {
    const fetchMock = stubData({ items: [], page: 1, pageSize: 20, total: 0 });

    await getParentChatLogs({ studentId: 11, q: '二次 函数', page: 2 });

    const url = fetchMock.mock.calls[0][0] as string;
    expect(url).toContain('q=%E4%BA%8C%E6%AC%A1+%E5%87%BD%E6%95%B0');
    expect(url).toContain('page=2');
  });

  it('getParentChatLogDetail → 两级路径', async () => {
    const fetchMock = stubData({});

    await getParentChatLogDetail(11, 55);

    expect(fetchMock.mock.calls[0][0]).toBe('/api/parent/students/11/chat-logs/55');
  });
});

describe('学习会话与学习时长端点：路径、编码与 body', () => {
  it('getParentStudyTime：不给 from/to 时路径以 id 收尾，不拖尾 ?', async () => {
    const fetchMock = stubData({});

    await getParentStudyTime(11);

    expect(fetchMock.mock.calls[0][0]).toBe('/api/parent/students/11/study-time');
    expect(fetchMock.mock.calls[0][0]).not.toContain('?');
  });

  it('getParentStudyTime：给了 from/to 就带上两个 query', async () => {
    const fetchMock = stubData({});

    await getParentStudyTime(11, '2026-09-13', '2026-09-19');

    const url = fetchMock.mock.calls[0][0] as string;
    expect(url.startsWith('/api/parent/students/11/study-time?')).toBe(true);
    expect(url).toContain('from=2026-09-13');
    expect(url).toContain('to=2026-09-19');
  });

  it('heartbeatStudySession → PATCH .../heartbeat，body 恰好 {state}', async () => {
    const fetchMock = stubData({ activeSeconds: 12 });

    await heartbeatStudySession('uid-1', 'hidden');

    expect(fetchMock.mock.calls[0][0]).toBe('/api/study-sessions/uid-1/heartbeat');
    expect(fetchMock.mock.calls[0][1]?.method).toBe('PATCH');
    expect(requestBody(fetchMock)).toEqual({ state: 'hidden' });
  });

  it('heartbeatStudySession 带 subjectId + reason → 两者都进 body（走神两口径的唯一 wire 入口）', async () => {
    const fetchMock = stubData({ activeSeconds: 12 });

    await heartbeatStudySession('uid-1', 'hidden', 7, 'away');

    expect(requestBody(fetchMock)).toEqual({ state: 'hidden', subjectId: 7, reason: 'away' });
  });

  it('heartbeatStudySession 的 reason=null → body 里不出现 reason（后端按可选处理）', async () => {
    const fetchMock = stubData({ activeSeconds: 12 });

    await heartbeatStudySession('uid-1', 'visible', 7, null);

    expect(requestBody(fetchMock)).toEqual({ state: 'visible', subjectId: 7 });
  });

  it('endStudySession → PATCH .../end，body 恰好 {reason}', async () => {
    const fetchMock = stubData({ activeSeconds: 30, endedAt: null });

    await endStudySession('uid-1', 'pagehide');

    expect(fetchMock.mock.calls[0][0]).toBe('/api/study-sessions/uid-1/end');
    expect(fetchMock.mock.calls[0][1]?.method).toBe('PATCH');
    expect(requestBody(fetchMock)).toEqual({ reason: 'pagehide' });
  });

  it('startStudySession → POST /api/study-sessions，body 原样发出', async () => {
    const fetchMock = stubData({ sessionUid: 'uid-1', startedAt: '2026-09-19T00:00:00.000Z' });

    await startStudySession({ sessionUid: 'uid-1', module: 'mainline', scene: 'course_detail' });

    expect(fetchMock.mock.calls[0][0]).toBe('/api/study-sessions');
    expect(fetchMock.mock.calls[0][1]?.method).toBe('POST');
    expect(requestBody(fetchMock)).toEqual({
      sessionUid: 'uid-1',
      module: 'mainline',
      scene: 'course_detail',
    });
  });

  it('sessionUid 里的保留字符会被 URL 编码（a/b?c 不能裸拼进路径）', async () => {
    const fetchMock = stubData({ activeSeconds: null });

    await endStudySession('a/b?c', 'pagehide');

    const url = fetchMock.mock.calls[0][0] as string;
    expect(url).toBe('/api/study-sessions/a%2Fb%3Fc/end');
  });
});
