import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ApiError,
  cancelBillingOrder,
  confirmBillingOrderPaid,
  createBillingOrder,
  endStudySession,
  getAiUsage,
  getBillingOrder,
  getMyPoints,
  getParentChatLogDetail,
  getParentChatLogs,
  getParentDashboard,
  getParentErrors,
  getParentPointLedger,
  getParentReport,
  getParentStudyTime,
  getSubscriptionPlans,
  getSubscriptionStatus,
  heartbeatStudySession,
  listAdminPapers,
  listBillingOrders,
  redeemParentPoints,
  saveParentPointRules,
  setRedemptionStatus,
  startStudySession,
} from './api';

import { clearSessionRevoked, isSessionRevoked } from './authStorage';

/**
 * `fetchApi` 把 HTTP 状态码带进 `ApiError.status`（终审修复 Finding 6 的地基）。
 *
 * 为什么必须有这条：会话页靠 `err.status` 区分「客户端 4xx，重试也不会好」与
 * 「网络/5xx，可重试」。若 `fetchApi` 忘了传 `res.status`，分类永远走不到 4xx 分支，
 * 而页面测试里手搓 `ApiError` 是发现不了的——那会是一条假装覆盖了的回归。
 */

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
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

  it('错误体额外字段 claimStatus 透传到 ApiError（2004 转人工三态的地基）', async () => {
    stubFetch(400, {
      code: 2004,
      message: '渠道尚未确认，已转人工核实',
      data: null,
      claimStatus: 'pending_review',
    });

    await expect(getBillingOrder('NO1')).rejects.toMatchObject({
      code: 2004,
      claimStatus: 'pending_review',
    });
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

describe('订阅/计费 API：路径与 body', () => {
  it('getSubscriptionStatus / getSubscriptionPlans → GET /api/quota/*', async () => {
    const f = stubData({ status: 'trialing', daysRemaining: 7 });

    await getSubscriptionStatus();
    expect(f.mock.calls[0][0]).toBe('/api/quota/subscription');
    expect(f.mock.calls[0][1]?.method).toBeUndefined();

    await getSubscriptionPlans();
    expect(f.mock.calls[1][0]).toBe('/api/quota/plans');
  });

  it('createBillingOrder → POST /api/billing/orders，body 恰好 {planCode,channel}；manual 渠道原样发出', async () => {
    const f = stubFetch(201, { code: 0, message: 'ok', data: { orderNo: 'NO1' } });

    await createBillingOrder('monthly', 'wechat');

    expect(f.mock.calls[0][0]).toBe('/api/billing/orders');
    expect(f.mock.calls[0][1]?.method).toBe('POST');
    expect(requestBody(f)).toEqual({ planCode: 'monthly', channel: 'wechat' });

    await createBillingOrder('monthly', 'manual');
    expect(requestBody(f, 1)).toEqual({ planCode: 'monthly', channel: 'manual' });
  });

  it('listBillingOrders → query 带分页', async () => {
    const f = stubData({ items: [], total: 0, page: 2, pageSize: 10 });

    await listBillingOrders(2, 10);

    expect(f.mock.calls[0][0]).toBe('/api/billing/orders?page=2&pageSize=10');
  });

  it('getBillingOrder / cancelBillingOrder / confirmBillingOrderPaid → 路径与方法', async () => {
    const f = stubData({ orderNo: 'NO1', paymentStatus: 'pending' });

    await getBillingOrder('NO1');
    expect(f.mock.calls[0][0]).toBe('/api/billing/orders/NO1');

    await cancelBillingOrder('NO1');
    expect(f.mock.calls[1][0]).toBe('/api/billing/orders/NO1/cancel');
    expect(f.mock.calls[1][1]?.method).toBe('POST');

    await confirmBillingOrderPaid('NO1');
    expect(f.mock.calls[2][0]).toBe('/api/billing/orders/NO1/confirm-paid');
    expect(f.mock.calls[2][1]?.method).toBe('POST');
    // 不带 note：不带 body（与既有 wire 一致）
    expect(requestInit(f, 2).body).toBeUndefined();
  });

  it('confirmBillingOrderPaid 带 note → body 恰好 {note}（线下转账备注透传）', async () => {
    const f = stubData({ orderNo: 'NO1', paymentStatus: 'paid' });

    await confirmBillingOrderPaid('NO1', '微信号 xx 已转账 198 元');

    expect(requestBody(f)).toEqual({ note: '微信号 xx 已转账 198 元' });
  });
});

describe('管理端试卷列表：query 契约', () => {
  it('仅给 page/pageSize 时，query 只有这两项（可选键缺席不生成空条目）', async () => {
    const f = stubData({ items: [], total: 0, page: 2, pageSize: 20 });

    await listAdminPapers({ page: 2, pageSize: 20 });

    expect(f.mock.calls[0][0]).toBe('/api/admin/papers?page=2&pageSize=20');
  });

  it('可选参数按固定顺序拼接，未传的键不出现（也不出现 undefined/null）', async () => {
    const f = stubData({ items: [], total: 0, page: 1, pageSize: 10 });

    await listAdminPapers({ subjectId: 3, year: 2025, gradeBand: 'junior', page: 1, pageSize: 10 });

    const url = f.mock.calls[0][0] as string;
    expect(url).toBe(
      '/api/admin/papers?subjectId=3&year=2025&gradeBand=junior&page=1&pageSize=10',
    );
    expect(url).not.toContain('keyword');
    expect(url).not.toContain('undefined');
    expect(url).not.toContain('null');
  });

  it('中文关键词带空格走 URL 编码（不能裸拼进 query）', async () => {
    const f = stubData({ items: [], total: 0, page: 1, pageSize: 10 });

    await listAdminPapers({ keyword: '二次 函数', page: 1, pageSize: 10 });

    const url = f.mock.calls[0][0] as string;
    expect(url).toContain('keyword=%E4%BA%8C%E6%AC%A1+%E5%87%BD%E6%95%B0');
    // 分页参数始终在（keyword 存在时也不例外）
    expect(url).toContain('page=1');
    expect(url).toContain('pageSize=10');
  });
});

describe('2001 全局拦截（订阅失效硬门禁）', () => {
  function stubLocationAssign() {
    // jsdom 的 Location 成员（含 assign）是实例上的不可配置属性，spy 不动；
    // 但 window.location 本身可配置，用 vi.stubGlobal 整只替换。
    const assign = vi.fn();
    vi.stubGlobal('location', { assign });
    return assign;
  }

  it('code=2001 → window.location.assign 到 /student/locked，且 Promise 永不 resolve（不抛 ApiError）', async () => {
    const assign = stubLocationAssign();
    stubFetch(403, { code: 2001, message: '订阅已失效', data: null });

    let outcome: 'resolved' | 'rejected' | 'pending' = 'pending';
    void getMyPoints().then(
      () => { outcome = 'resolved'; },
      () => { outcome = 'rejected'; },
    );

    await vi.waitFor(() => expect(assign).toHaveBeenCalledWith('/student/locked'));
    // 给微/宏任务留出窗口，确认确实挂起而不是悄悄 settle
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(outcome).toBe('pending');
  });

  it('其他业务码不触发跳转，仍抛 ApiError', async () => {
    const assign = stubLocationAssign();
    stubFetch(403, { code: 1005, message: '无权访问', data: null });

    await expect(getAiUsage()).rejects.toMatchObject({ code: 1005 });
    expect(assign).not.toHaveBeenCalled();
  });

  /**
   * 回归钉子（2026-11-02 用户报「锁定页反复横跳」）：已经在锁定页时**不要**再 assign。
   *
   * 锁定页自身会发请求（PC App 的 `device-commands` 轮询 / 无本地会话时的
   * `learning-sessions`）。若这些请求回 2001 后仍 `assign('/student/locked')`，
   * 浏览器会把**当前页整页重载** → 重载后又发同一个请求 → 再 2001 → 再重载，
   * 形成无限刷新（实测 10 秒 389 次主 frame 导航），页面上「本账号未订阅」与
   * 「订阅已过期」两个标题随之闪个不停。后端豁免清单是主修，这里是第二道闸。
   */
  it('已在 /student/locked 时 2001 不再 assign（防整页重载死循环），Promise 仍挂起', async () => {
    const assign = vi.fn();
    vi.stubGlobal('location', { pathname: '/student/locked', assign });
    stubFetch(403, { code: 2001, message: '订阅已失效', data: null });

    let outcome: 'resolved' | 'rejected' | 'pending' = 'pending';
    void getMyPoints().then(
      () => { outcome = 'resolved'; },
      () => { outcome = 'rejected'; },
    );

    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(assign).not.toHaveBeenCalled();
    expect(outcome).toBe('pending');
  });
});

describe('1013 全局拦截（单点登录互踢）', () => {
  function stubLocationAssign() {
    // jsdom 的 Location 成员（含 assign）是实例上的不可配置属性，spy 不动；
    // 但 window.location 本身可配置，用 vi.stubGlobal 整只替换。
    const assign = vi.fn();
    vi.stubGlobal('location', { assign });
    return assign;
  }

  // 标记是模块级单例：上一个用例置过位会影响下一个用例。
  beforeEach(() => clearSessionRevoked());

  it('code=1013 → 置「已被踢」标记 + 清登录态 + window.location.assign 到 /login?kicked=1，Promise 永不 resolve', async () => {
    const assign = stubLocationAssign();
    localStorage.setItem('token', 't');
    sessionStorage.setItem('userRole', 'student');
    stubFetch(401, { code: 1013, message: '账号已在其他设备登录', data: null });

    let outcome: 'resolved' | 'rejected' | 'pending' = 'pending';
    void getMyPoints().then(
      () => { outcome = 'resolved'; },
      () => { outcome = 'rejected'; },
    );

    await vi.waitFor(() => expect(assign).toHaveBeenCalledWith('/login?kicked=1'));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(outcome).toBe('pending');
    // 页面退出守卫（考试页 beforeunload）据此让路，否则 Electron 会静默吞掉整页跳转
    expect(isSessionRevoked()).toBe(true);
    // 两个 storage 的鉴权键都被清掉
    expect(localStorage.getItem('token')).toBeNull();
    expect(sessionStorage.getItem('userRole')).toBeNull();
  });

  it('code=1003（token 过期）→ 行为不变，仍抛 ApiError，也不置「已被踢」标记', async () => {
    const assign = stubLocationAssign();
    stubFetch(401, { code: 1003, message: '未登录或 token 已过期', data: null });
    await expect(getMyPoints()).rejects.toMatchObject({ code: 1003 });
    expect(assign).not.toHaveBeenCalled();
    expect(isSessionRevoked()).toBe(false);
  });
});
