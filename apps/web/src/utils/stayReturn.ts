/**
 * 浅停留页（个人中心 / 奖励册 / 练习记录）顶栏**「退出本页」的来源页协议**。
 *
 * **为什么不用 `navigate(-1)`（回退浏览器历史）**：这几页共用同一个外壳
 * `StudentStayLayout`，页内「奖励册 / 个人中心 / 练习记录」互跳会把兄弟页压进历史栈。
 * 学生从星图进来、点过奖励册再切回个人中心后退出，退回去的是**奖励册**而不是进来的那一页
 * （2026-09-21 用户实测反馈）—— **历史栈 ≠「从哪来」**。
 *
 * **做法**：进入浅停留页的入口（当前只有段位面板 `LevelPanel` 的「查看积分明细 →」）
 * 把来源页**完整地址（pathname + search + hash）**写进导航 state（`from`），tab 互跳时
 * 原样带过去，「退出本页」直接跳 `from`。只记 pathname 会丢 `?subjectId=5` 这类参数，
 * 物理/化学训练页退出后会被解析成默认的数学。
 *
 * - **来源页自己的 `location.state` 必须一起带**（`fromState`）：课程详情这类页面的
 *   subjectId / lessonId 全在 `location.state` 里，丢了会被它自己的
 *   「缺少课程信息，请从星图选择小节进入」挡住。
 * - **刷新不丢**：React Router 把 state 存在 `history.state` 里。只有「直接输地址 /
 *   老书签进来」没有来源 → 兜底回星图（UX §5.5 P5.1 的原始口径）。
 */

/** 浅停留页的路径（与 `routes/routeTable.tsx` 的顶层路由保持同步）。 */
const STAY_PATHS = ['/student/profile', '/student/rewards', '/student/practice-history'];

/** 没有来源时的兜底落点：回星图。 */
export const STAY_FALLBACK_PATH = '/student/star-map';

/** 入口页写进导航 state 的载荷。 */
export interface StayReturnState {
  /** 进入浅停留页之前所在的页面（pathname + search + hash）。 */
  from?: string;
  /** 来源页自己的 `location.state`，返回时原样还给它。 */
  fromState?: unknown;
}

/** 入口页 / 两页互跳时用：把「来源」打包进导航 state。 */
export function buildStayReturnState(from: string, fromState: unknown): StayReturnState {
  return { from, fromState };
}

/** 来源本身是浅停留页（三个 tab 互跳）不算来源 —— 否则「退出本页」会在 tab 之间打转。 */
function isStayPath(pathname: string): boolean {
  const path = pathname.split(/[?#]/)[0];
  return STAY_PATHS.includes(path);
}

/**
 * 浅停留页用：算出顶栏「退出本页」的落点。
 * 来源缺失 / 不是站内路径 / 来源本身是浅停留页 → 兜底星图。
 *
 * **三个 tab（奖励册 / 个人中心 / 练习记录）同权**：无论当前在哪一页（含练习记录
 * 列表与详情），「退出本页」都回**进入浅停留页之前的那一页**。2026-11-02 曾按层级
 * 固定「列表→个人中心、详情→列表」，但那是给左侧「返回」定的；左侧按钮已于
 * 2026-11-06 删除，唯一出口的语义是「从哪进回哪」，层级规则作废
 * （2026-11-06 用户实测：从个人中心切到练习记录后退出只回到个人中心）。
 *
 * 2026-11-06 用户要求：从练习记录详情退出也直接回最初来源，故列表 → 详情的
 * `Link` 必须把当前 `location.state` 一并传下去（见 `PracticeHistoryPage`）。
 */
export function resolveStayReturn(state: unknown): { to: string; state?: unknown } {
  const payload = state as StayReturnState | null | undefined;
  const from = typeof payload?.from === 'string' ? payload.from : '';
  if (!from.startsWith('/') || isStayPath(from)) return { to: STAY_FALLBACK_PATH };
  return { to: from, state: payload?.fromState };
}
