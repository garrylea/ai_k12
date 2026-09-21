/**
 * 浅停留页（个人中心 / 奖励册）顶栏「返回」的**来源页协议**。
 *
 * **为什么不用 `navigate(-1)`（回退浏览器历史）**：这两页共用同一个外壳
 * `StudentStayLayout`，页内「奖励册 / 个人中心」互跳会把兄弟页压进历史栈。学生从星图
 * 进来、点过奖励册再切回个人中心后按「返回」，退回去的是**奖励册**而不是进来的那一页
 * （2026-09-21 用户实测反馈）—— **历史栈 ≠「从哪来」**。
 *
 * **做法**：进入浅停留页的入口（当前只有段位面板 `LevelPanel` 的「查看积分明细 →」）
 * 把来源页 pathname 写进导航 state（`from`），两页互跳时原样带过去，顶栏「返回」直接跳 `from`。
 *
 * - **来源页自己的 `location.state` 必须一起带**（`fromState`）：课程详情这类页面的
 *   subjectId / lessonId 全在 `location.state` 里，丢了会被它自己的
 *   「缺少课程信息，请从星图选择小节进入」挡住。
 * - **刷新不丢**：React Router 把 state 存在 `history.state` 里。只有「直接输地址 /
 *   老书签进来」没有来源 → 兜底回星图（UX §5.5 P5.1 的原始口径）。
 */

/** 浅停留页的两条路径（与 `routes/routeTable.tsx` 的两条顶层路由保持同步）。 */
const STAY_PATHS = ['/student/profile', '/student/rewards'];

/** 没有来源时的兜底落点：回星图。 */
export const STAY_FALLBACK_PATH = '/student/star-map';

/** 入口页写进导航 state 的载荷。 */
export interface StayReturnState {
  /** 进入浅停留页之前所在的页面（pathname）。 */
  from?: string;
  /** 来源页自己的 `location.state`，返回时原样还给它。 */
  fromState?: unknown;
}

/** 入口页 / 两页互跳时用：把「来源」打包进导航 state。 */
export function buildStayReturnState(from: string, fromState: unknown): StayReturnState {
  return { from, fromState };
}

/** 来源本身是浅停留页（兄弟页互跳）不算来源 —— 否则「返回」会在两页之间打转。 */
function isStayPath(pathname: string): boolean {
  const path = pathname.split(/[?#]/)[0];
  return STAY_PATHS.includes(path);
}

/**
 * 浅停留页用：算出顶栏「返回」的落点。
 * 来源缺失 / 不是站内路径 / 来源本身是浅停留页 → 兜底星图。
 */
export function resolveStayReturn(state: unknown): { to: string; state?: unknown } {
  const payload = state as StayReturnState | null | undefined;
  const from = typeof payload?.from === 'string' ? payload.from : '';
  if (!from.startsWith('/') || isStayPath(from)) return { to: STAY_FALLBACK_PATH };
  return { to: from, state: payload?.fromState };
}
