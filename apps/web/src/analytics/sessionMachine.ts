import type { ClientState, EndReason, HiddenReason, SessionEvent, SessionState } from './types';

export interface SessionEffects {
  /** 要新开一段会话（`sessionUid` 由 tracker 生成）。 */
  start: boolean;
  /** 要结束当前会话（`null` = 不结束）。 */
  end: EndReason | null;
  /** 要发一次心跳（`null` = 不发）。`reason` 仅在 `state === 'hidden'` 时有意义。 */
  heartbeat: { state: ClientState; reason: HiddenReason | null } | null;
}

export interface SessionTransition {
  state: SessionState;
  effects: SessionEffects;
}

// 冻结：无副作用转换共用同一个哨兵对象，防止未来调用方就地修改它而悄悄污染后续转换。
const NO_EFFECTS: SessionEffects = Object.freeze({ start: false, end: null, heartbeat: null });

/**
 * 纯 reducer（spec §7.4 的状态机）。**不碰 DOM、不碰网络、不读时钟**——
 * 所有副作用由 tracker 按 `effects` 执行，因此这里可以表驱动地穷举测试。
 *
 * 状态：`idle | active | hidden | ended`
 *
 * ```
 * idle    --ROUTE_ENTER-->  active   起会话 + 首次心跳
 * active  --IDLE_TIMEOUT--> hidden   120s 无输入 → 暂停计时
 * hidden  --VISIBLE-->      active   恢复计时
 * active  --HIDDEN-->       hidden   visibilitychange
 * hidden  --VISIBLE-->      active
 * active|hidden --ROUTE_LEAVE|PAGEHIDE--> ended  带 end_reason
 * ended   --ROUTE_ENTER-->  active   （学习页 A → 学习页 B 是 end 后立刻 start）
 * ```
 *
 * `hidden` 期间**不结束会话**：用户切出去看一眼消息就回来，不该被算成两次学习；
 * 但也不计时（服务端只在 `client_state = 'visible'` 时累加秒数）。
 *
 * `effects.heartbeat.reason` 区分两种挂机：`IDLE_TIMEOUT`（前台发呆）→ `idle`、
 * `HIDDEN`（页面被切走）→ `away`；回到 `visible` 一律 `null`。服务端据此把两类
 * 挂机时长**分开累计**（spec §3.3）。
 */
export function transition(prev: SessionState, event: SessionEvent): SessionTransition {
  switch (prev) {
    case 'idle':
      return event === 'ROUTE_ENTER'
        ? {
            state: 'active',
            effects: { start: true, end: null, heartbeat: { state: 'visible', reason: null } },
          }
        : { state: 'idle', effects: NO_EFFECTS };

    case 'active':
      switch (event) {
        case 'IDLE_TIMEOUT':
          return {
            state: 'hidden',
            effects: { start: false, end: null, heartbeat: { state: 'hidden', reason: 'idle' } },
          };
        case 'HIDDEN':
          return {
            state: 'hidden',
            effects: { start: false, end: null, heartbeat: { state: 'hidden', reason: 'away' } },
          };
        case 'ROUTE_LEAVE':
          return { state: 'ended', effects: { start: false, end: 'route_change', heartbeat: null } };
        case 'PAGEHIDE':
          return { state: 'ended', effects: { start: false, end: 'pagehide', heartbeat: null } };
        // VISIBLE / ROUTE_ENTER 已在前台：空操作，不重复发心跳
        default:
          return { state: 'active', effects: NO_EFFECTS };
      }

    case 'hidden':
      switch (event) {
        case 'VISIBLE':
          return {
            state: 'active',
            effects: { start: false, end: null, heartbeat: { state: 'visible', reason: null } },
          };
        case 'ROUTE_LEAVE':
          return { state: 'ended', effects: { start: false, end: 'route_change', heartbeat: null } };
        case 'PAGEHIDE':
          return { state: 'ended', effects: { start: false, end: 'pagehide', heartbeat: null } };
        default:
          return { state: 'hidden', effects: NO_EFFECTS };
      }

    case 'ended':
      return event === 'ROUTE_ENTER'
        ? {
            state: 'active',
            effects: { start: true, end: null, heartbeat: { state: 'visible', reason: null } },
          }
        : { state: 'ended', effects: NO_EFFECTS };
  }
}
