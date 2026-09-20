import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { createMemoryRouter, RouterProvider } from 'react-router-dom';
import { routes } from './routeTable';
import { useThemeStore } from '@/store/themeStore';
import {
  getMyLedger,
  getMyPoints,
  getMyRewards,
  getParentAlerts,
  getParentGoalAttainment,
  getParentPointRules,
  getParentPoints,
  getUnreadMessageCount,
  listMyStudents,
  type MyPoints,
  type MyRewards,
  type MyStudentItem,
  type PointLedgerPage,
} from '@/services/api';
import { useParentStudentStore } from '@/store/parentStudentStore';

/**
 * 路由级回归（计划 §3 Task 8）。
 *
 * 目的：钉住「路径 → 真页面」这层映射，而不是只测页面组件本身。
 * Task 5 把 `/student/profile`、`/student/rewards` 的 `Placeholder` 换成了真页面；
 * 这两个页面各自有组件测试，但**没有任何测试证明路由表指向它们**——一个手误改回
 * `Placeholder` 或改错路径，组件测试全绿也发现不了，所以这里挂载**真实路由表**跑一遍。
 *
 * 挂载方式：`createMemoryRouter(routes)`——用的是 `routeTable.tsx` 导出的同一份
 * 真实路由表（不是另抄一棵等价子树），否则测的还是影子配置。
 * `index.tsx` 只是浏览器 router 引导层，唯一真源在 `routeTable.tsx`。
 *
 * 鉴权：`/student/*` 在 `RequireRole role="student"` 之下，测试**按真实口径 stub 登录态**
 * （localStorage 的 `token`/`userRole` + 未过期的 exp），并额外验证无 token / 角色不符
 * 会被挡回登录页——不为了好测而放宽守卫。
 */

vi.mock('@/services/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/services/api')>();
  return {
    ...actual,
    getMyPoints: vi.fn(),
    getMyLedger: vi.fn(),
    getMyRewards: vi.fn(),
    // 家长端：`ParentLayout` 的顶栏（学生切换器 + 未读数）与 `/parent/rewards` 概览
    getParentPoints: vi.fn(),
    getParentPointRules: vi.fn(),
    listMyStudents: vi.fn(),
    getUnreadMessageCount: vi.fn(),
    // `/parent/goals`（埋点 Phase 1B 从 Placeholder 换成真页）：页面自己拉四项目标
    getParentGoalAttainment: vi.fn(),
    // `/parent/alerts`（P6.9 从 Placeholder 换成真页）：列表页 + 顶栏 Banner 都会拉它
    getParentAlerts: vi.fn(),
  };
});

const getMyPointsMock = vi.mocked(getMyPoints);
const getMyLedgerMock = vi.mocked(getMyLedger);
const getMyRewardsMock = vi.mocked(getMyRewards);
const getParentPointsMock = vi.mocked(getParentPoints);
const getParentPointRulesMock = vi.mocked(getParentPointRules);
const listMyStudentsMock = vi.mocked(listMyStudents);
const getUnreadMessageCountMock = vi.mocked(getUnreadMessageCount);
const getParentGoalAttainmentMock = vi.mocked(getParentGoalAttainment);
const getParentAlertsMock = vi.mocked(getParentAlerts);

const PLACEHOLDER_TEXT = '原型占位：此页面正在设计中...';

const POINTS: MyPoints = {
  balance: 120,
  totalEarned: 520,
  todayEarned: 10,
  level: { code: 'zhutie', name: '铸铁', index: 1, threshold: 500 },
  nextLevel: { code: 'qingtong', name: '青铜', index: 2, threshold: 1200 },
  pointsToNextLevel: 680,
  progressPercent: 2,
};

const LEDGER: PointLedgerPage = {
  items: [
    {
      id: 1,
      kind: 'earn',
      title: '数学专项 · 3 题',
      points: 8,
      createdAt: '2026-09-17T10:30:00.000Z',
      refType: 'training_session',
    },
  ],
  total: 1,
  page: 1,
  pageSize: 20,
};

const REWARDS: MyRewards = {
  balance: 120,
  level: { code: 'zhutie', name: '铸铁', index: 1, threshold: 500 },
  items: [
    {
      id: 1,
      name: '看一集动画',
      description: null,
      pointsCost: 100,
      minLevelCode: null,
      minLevelName: null,
      affordable: true,
      levelOk: true,
      gap: 0,
    },
  ],
};

/** 家长端的顶栏孩子列表：至少一个孩子，页面的概览/面板才有 `studentId` 可取。 */
const PARENT_STUDENT: MyStudentItem = {
  id: 7,
  parentId: 1,
  username: 'xiaoming',
  name: '小明',
  age: 9,
  grade: '三年级',
  schoolLevel: 'primary',
  isActive: true,
};

/** 造一个 exp 在未来的假 JWT：`isSessionValid()` 解 payload 校 exp，不是只看字符串存在。 */
function validToken(): string {
  const payload = btoa(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 3600 }));
  return `header.${payload}.signature`;
}

function setStudentSession() {
  localStorage.setItem('token', validToken());
  localStorage.setItem('userRole', 'student');
}

function setParentSession() {
  localStorage.setItem('token', validToken());
  localStorage.setItem('userRole', 'parent');
}

function renderAt(path: string) {
  const router = createMemoryRouter(routes, { initialEntries: [path] });
  return render(<RouterProvider router={router} />);
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  // 主题是模块级单例：StudentLayout 挂载时会按挂钟把它切成 day/night，不复位会串到下一个用例
  useThemeStore.setState({ mode: 'student-day' });
  // 家长锚点是模块级单例，用例之间会串（下一个用例可能读到上个用例的孩子 id）
  useParentStudentStore.setState({ studentId: null });
});

beforeEach(() => {
  getMyPointsMock.mockReset();
  getMyLedgerMock.mockReset();
  getMyRewardsMock.mockReset();
  getParentPointsMock.mockReset();
  getParentPointsMock.mockResolvedValue(POINTS);
  getParentPointRulesMock.mockReset();
  getParentPointRulesMock.mockResolvedValue({ tasks: [] });
  listMyStudentsMock.mockReset();
  listMyStudentsMock.mockResolvedValue([PARENT_STUDENT]);
  getUnreadMessageCountMock.mockReset();
  getUnreadMessageCountMock.mockResolvedValue(0);
  getParentGoalAttainmentMock.mockReset();
  // P6.5：目标按学科（(学科, 指标) 二元组），响应必须带 subjectId/subjectName
  getParentGoalAttainmentMock.mockResolvedValue({
    items: [
      { metric: 'daily_study_minutes', subjectId: 1, subjectName: '数学', period: 'daily', title: '每日学习时长', target: 30, achieved: 15, rate: 50 },
      { metric: 'weekly_lessons', subjectId: 1, subjectName: '数学', period: 'weekly', title: '每周完课', target: 2, achieved: 1, rate: 50 },
      { metric: 'weekly_passages', subjectId: 2, subjectName: '语文', period: 'weekly', title: '每周古诗文篇目', target: 8, achieved: 2, rate: 25 },
      { metric: 'daily_words', subjectId: 3, subjectName: '英语', period: 'daily', title: '每日背单词', target: 20, achieved: 10, rate: 50 },
    ],
  });
  getParentAlertsMock.mockReset();
  // 顶栏 Banner 与列表页共用此端点：默认「无预警」→ Banner 不渲染
  getParentAlertsMock.mockResolvedValue({ items: [], total: 0, page: 1, pageSize: 1 });
  useParentStudentStore.setState({ studentId: null });
});

/**
 * 浅停留页外壳（UX §1.5 第 59 行）的承重断言。
 *
 * 个人中心 / 奖励册属「禁用夜间切换」一类：直接写死 `data-theme="student-day"`、
 * **不使用** `.student-theme-container`（第 58 行那一类才用）。它们此前挂在
 * `StudentLayout` 下，因而跟随 `themeStore.mode` 自动切夜、顶栏还挂了「日间/夜间」
 * 胶囊 —— 与第 59 行冲突。这里把新口径钉死：写死日间、无侧栏、无日夜切换控件。
 */
function expectStayPageShell() {
  // 写死日间：容器上必须有 data-theme="student-day"
  expect(document.querySelector('[data-theme="student-day"]')).not.toBeNull();
  // 且**不是**学习沉浸页：不得出现 .student-theme-container
  expect(document.querySelector('.student-theme-container')).toBeNull();
  // 无主轨侧栏（aside），因此侧栏的「星图导航/错题本」链接也不该在
  expect(document.querySelector('aside')).toBeNull();
  expect(screen.queryByRole('link', { name: '星图导航' })).not.toBeInTheDocument();
  expect(screen.queryByRole('link', { name: '错题本' })).not.toBeInTheDocument();
  // 核心钉子：页面上不存在日/夜切换控件
  expect(screen.queryByRole('button', { name: '日间' })).not.toBeInTheDocument();
  expect(screen.queryByRole('button', { name: '夜间' })).not.toBeInTheDocument();
  // 去掉侧栏后，顶栏「返回上一页」是离开这两页的出口。
  // 2026-09-18 改：原先是页内手写的 <Link to="/student/star-map">返回星图</Link>，
  // 按用户裁决改为统一 BackButton 的默认模式（返回上一页）——渲染成 <button> 而非 <a>，
  // 也没有固定 href；它真的会回退一格历史由 BackButton.test.tsx 用真路由断言钉住。
  expect(screen.getByRole('button', { name: '返回上一页' })).toBeInTheDocument();
  // 两页互跳入口
  expect(screen.getByRole('link', { name: '奖励册' })).toHaveAttribute('href', '/student/rewards');
  expect(screen.getByRole('link', { name: '个人中心' })).toHaveAttribute(
    'href',
    '/student/profile',
  );
  // 退出登录（此前这两页根本没有）
  expect(screen.getByRole('button', { name: '退出登录' })).toBeInTheDocument();
}

describe('路由表：积分相关页面', () => {
  it('/student/profile 渲染 ProfilePage，而非 Placeholder', async () => {
    setStudentSession();
    getMyPointsMock.mockResolvedValue(POINTS);
    getMyLedgerMock.mockResolvedValue(LEDGER);

    renderAt('/student/profile');

    // 真页面内容：段位大卡（标题与图标都来自 ProfilePage 自身，占位页不可能有）
    expect(await screen.findByRole('heading', { name: '个人中心' })).toBeInTheDocument();
    expect(await screen.findByTestId('profile-level-icon')).toBeInTheDocument();
    expect(screen.getByText('还差 680 分')).toBeInTheDocument();

    expect(screen.queryByText(PLACEHOLDER_TEXT)).not.toBeInTheDocument();
    // 换用浅停留页外壳：写死日间、无侧栏、无日夜切换（第 59 行）
    expectStayPageShell();
  });

  it('/student/rewards 渲染 RewardsPage（含「找家长兑换」），而非 Placeholder', async () => {
    setStudentSession();
    getMyRewardsMock.mockResolvedValue(REWARDS);

    renderAt('/student/rewards');

    expect(await screen.findByRole('heading', { name: '奖励册' })).toBeInTheDocument();
    expect(await screen.findByText('找家长兑换')).toBeInTheDocument();
    expect(screen.getByTestId('reward-card-1')).toBeInTheDocument();

    expect(screen.queryByText(PLACEHOLDER_TEXT)).not.toBeInTheDocument();
    expectStayPageShell();
  });

  it('其余占位路由仍渲染 Placeholder（证明 Placeholder 未被误删/误改）', () => {
    renderAt('/student/auxiliary/selector');

    expect(screen.getByText(PLACEHOLDER_TEXT)).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: '知识点选择器 P3.2' })).toBeInTheDocument();
  });

  /**
   * 学习设置（P5.3）已按用户裁决从学生端移除：路由与页面都不该存在。
   * 本仓路由表没有 404 兜底路由，未匹配路径由 React Router 默认错误分支接管；
   * 这里**只断言不渲染学习设置页**，不为好测而新增兜底路由。
   */
  it('/student/settings 已不存在，不再渲染学习设置页', () => {
    setStudentSession();

    renderAt('/student/settings');

    expect(screen.queryByRole('heading', { name: '学习设置 P5.3' })).not.toBeInTheDocument();
    expect(screen.queryByText('学习设置 P5.3')).not.toBeInTheDocument();
    expect(screen.queryByText('学习设置')).not.toBeInTheDocument();
  });

  /**
   * 硬规则钉子（UX §3.3 + CLAUDE.md）：主轨侧边导航「不含辅轨入口」，
   * 双轨物理隔离靠路由、**无跨轨链接**。曾经这里有两个违规项：
   * - 辅线 `/student/auxiliary`（跨轨链接，只能从入口选择页进）
   * - 主线 `/student/mainline`（只是重定向到星图，与「星图导航」重复）
   * 这条用例保证它们不会被顺手加回来。
   *
   * 挂载点是仍在 `StudentLayout`（带侧栏）下的 P2.4 占位页 ——
   * 2026-09-18 改：个人中心/奖励册已改用浅停留页外壳、不再有侧栏，
   * 原先拿它们当宿主会让这条守卫测到空的侧栏上。
   */
  it('主轨侧边导航不含辅轨入口，也没有与星图重复的「主线」项', () => {
    setStudentSession();

    renderAt('/student/homework');

    /**
     * ⚠️ 这里**不要断言 `data-theme="student-day"`**（原写法）：`StudentLayout` 挂载时会
     * `autoToggleNightMode()` 按挂钟切主题，于是本文件在 18:00–06:00 跑必红 —— 那是**依赖运行时刻**
     * 的假红（2026-09-19 记入 `docs/家长端学情批-完成情况与待办清单.md` §3.3 第 6 项，
     * 2026-09-20 按该文档的建议①修掉）。
     * 本用例真正要表达的是「宿主外壳是学生端主题容器」（下面的四项导航断言才有意义），
     * 所以只断言「学生端主题之一」，不锁日间。**别用 TZ 绕**——那只是把时间依赖藏起来。
     */
    expect(document.querySelector('[data-theme]')).toHaveAttribute(
      'data-theme',
      expect.stringMatching(/^student-(day|night)$/),
    );
    expect(screen.queryByRole('link', { name: '辅线' })).not.toBeInTheDocument();
    expect(document.querySelector('a[href="/student/auxiliary"]')).toBeNull();
    expect(screen.queryByRole('link', { name: '主线' })).not.toBeInTheDocument();
    expect(document.querySelector('a[href="/student/mainline"]')).toBeNull();

    // 文档清单里的四项仍在
    for (const [label, href] of [
      ['星图导航', '/student/star-map'],
      ['错题本', '/student/error-book'],
      ['奖励册', '/student/rewards'],
      ['个人中心', '/student/profile'],
    ] as const) {
      expect(screen.getByRole('link', { name: label })).toHaveAttribute('href', href);
    }
  });
});

/**
 * 计划三 Task 9：`/parent/rewards` 必须挂真页面。
 *
 * Task 4 已把 `routeTable.tsx` 里 `rewards` 那一行的 `Placeholder` 换成 `ParentPointsPage`。
 * 页面自己有组件测试，但那个测试挂的是**页面本身**、绕过了路由表——「路由确实指到这个
 * 页面」只有这里能证明（一个手误改回 `Placeholder` 或改错 path，组件测试全绿也发现不了）。
 */
describe('路由表：家长端「积分与奖励」', () => {
  it('/parent/rewards 渲染 ParentPointsPage（概览 + 四个 Tab），而非 Placeholder', async () => {
    setParentSession();

    renderAt('/parent/rewards');

    expect(await screen.findByRole('heading', { name: '积分与奖励' })).toBeInTheDocument();
    // 概览卡的数据来自 ParentPointsPage 自己的 getParentPoints；占位页不可能有
    expect(await screen.findByTestId('points-overview')).toBeInTheDocument();
    for (const label of ['积分规则', '奖励清单', '兑换', '兑换记录']) {
      expect(screen.getByRole('tab', { name: label })).toBeInTheDocument();
    }
    expect(screen.getByRole('tab', { name: '积分规则' })).toHaveAttribute('aria-selected', 'true');
    // 顶栏孩子切换器把 store 锚点落到唯一那个孩子上，页面按这个 id 取数
    expect(getParentPointsMock).toHaveBeenCalledWith(PARENT_STUDENT.id);

    // 占位页文案不许出现——这是「没被改回 Placeholder」的钉子
    expect(screen.queryByText(PLACEHOLDER_TEXT)).not.toBeInTheDocument();
    // 家长端仍是家长主题（商务白蓝，无日夜切换）
    expect(document.querySelector('[data-theme="parent"]')).not.toBeNull();
  });

  it('侧边导航「奖励管理」仍指向 /parent/rewards（路径不许改）', async () => {
    setParentSession();

    renderAt('/parent/rewards');

    // 只认 UX §家长端侧边清单里的「奖励管理」；路径是深链/书签的对外契约
    expect(await screen.findByRole('link', { name: '奖励管理' })).toHaveAttribute(
      'href',
      '/parent/rewards',
    );
  });

  it('无 token 访问 /parent/rewards → 回登录页，不发积分请求', async () => {
    localStorage.clear();

    renderAt('/parent/rewards');

    expect(await screen.findByRole('heading', { name: '智学系统' })).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: '积分与奖励' })).not.toBeInTheDocument();
    expect(getParentPointsMock).not.toHaveBeenCalled();
  });
});

/**
 * 埋点 Phase 1B：`/parent/goals` 从 `Placeholder` 换成 `ParentGoalsPage`。
 *
 * 与 `/parent/rewards` 同一条理由：页面自己有组件测试，但那个测试挂的是**页面本身**、
 * 绕过了路由表——「路由确实指到这个页面」只有这里能证明。
 */
describe('路由表：家长端「目标设定」', () => {
  it('/parent/goals 渲染 ParentGoalsPage（按学科分组的可改目标），而非 Placeholder', async () => {
    setParentSession();

    renderAt('/parent/goals');

    expect(await screen.findByRole('heading', { name: '目标设定' })).toBeInTheDocument();
    // P6.5：目标按学科分组（每个学科一张卡），行 key 是 学科:指标
    for (const subjectId of [1, 2, 3]) {
      expect(await screen.findByTestId(`goals-subject-${subjectId}`)).toBeInTheDocument();
    }
    for (const key of ['1:daily_study_minutes', '1:weekly_lessons', '2:weekly_passages', '3:daily_words']) {
      expect(screen.getByTestId(`goal-row-${key}`)).toBeInTheDocument();
    }
    // 顶栏孩子切换器把锚点落到唯一那个孩子上，页面按这个 id 取数
    expect(getParentGoalAttainmentMock).toHaveBeenCalledWith(PARENT_STUDENT.id);

    // 占位页文案不许出现——这是「没被改回 Placeholder」的钉子
    expect(screen.queryByText(PLACEHOLDER_TEXT)).not.toBeInTheDocument();
    // 家长端仍是家长主题（商务白蓝，无日夜切换）
    expect(document.querySelector('[data-theme="parent"]')).not.toBeNull();
  });

  it('侧边导航「目标设定」仍指向 /parent/goals（路径不许改）', async () => {
    setParentSession();

    renderAt('/parent/goals');

    expect(await screen.findByRole('link', { name: '目标设定' })).toHaveAttribute(
      'href',
      '/parent/goals',
    );
  });
});

/**
 * P6.9：`/parent/alerts` 从 `Placeholder` 换成 `ParentAlertsPage`。
 *
 * 与 `/parent/rewards`、`/parent/goals` 同一条理由：页面组件测试挂的是页面本身、
 * 绕过路由表——「路由确实指到这个页面」只有这里能证明。
 */
describe('路由表：家长端「异常预警中心」', () => {
  it('/parent/alerts 渲染 ParentAlertsPage，而非 Placeholder', async () => {
    setParentSession();

    renderAt('/parent/alerts');

    expect(await screen.findByRole('heading', { name: '异常预警中心' })).toBeInTheDocument();
    // 列表页默认「全部孩子」口径
    expect(await screen.findByLabelText('孩子')).toBeInTheDocument();
    expect(screen.queryByText(PLACEHOLDER_TEXT)).not.toBeInTheDocument();
    // 家长端仍是家长主题（商务白蓝，无日夜切换）
    expect(document.querySelector('[data-theme="parent"]')).not.toBeNull();
  });

  it('侧边导航「异常预警」指向 /parent/alerts（Banner 点掉后仍可达）', async () => {
    setParentSession();

    renderAt('/parent/alerts');

    expect(await screen.findByRole('link', { name: '异常预警' })).toHaveAttribute(
      'href',
      '/parent/alerts',
    );
  });
});

describe('路由表：RequireRole 守卫未被放宽', () => {
  it('无 token 访问 /student/profile → 回登录页，不发积分请求', async () => {
    localStorage.clear();

    renderAt('/student/profile');

    expect(await screen.findByRole('heading', { name: '智学系统' })).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: '个人中心' })).not.toBeInTheDocument();
    expect(getMyPointsMock).not.toHaveBeenCalled();
  });

  it('角色不符（parent 拿学生路径）→ 回登录页', async () => {
    localStorage.setItem('token', validToken());
    localStorage.setItem('userRole', 'parent');

    renderAt('/student/profile');

    expect(await screen.findByRole('heading', { name: '智学系统' })).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: '个人中心' })).not.toBeInTheDocument();
    expect(getMyPointsMock).not.toHaveBeenCalled();
  });
});
