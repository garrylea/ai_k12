import { endStudySession, heartbeatStudySession, startStudySession } from '@/services/api';
import { sceneKey } from './sceneMap';
import { transition } from './sessionMachine';
import { newSessionUid } from './types';
import type {
  AppShell,
  ClientState,
  EndReason,
  InputType,
  SceneInfo,
  ScreenClass,
  SessionEvent,
  SessionState,
} from './types';

/** 与后端 `study-sessions.service.ts` 的常量对齐（心跳间隔 30s、空闲阈值 120s）。 */
export const HEARTBEAT_INTERVAL_MS = 30_000;
export const IDLE_TIMEOUT_MS = 120_000;
/** 空闲检测的轮询间隔：120s 阈值不必每秒查，5s 粒度足够，且省电。 */
const IDLE_CHECK_INTERVAL_MS = 5_000;
/** 用户活动节流：只在活动停下来时更新 `lastInputAt`，避免 scroll 每次都进回调。 */
const INPUT_THROTTLE_MS = 5_000;

export interface StudySessionStartBody {
  sessionUid: string;
  module: string;
  scene: string;
  subjectId?: number;
  refType?: string;
  refId?: number;
  screenClass?: ScreenClass;
  inputType?: InputType;
  appShell?: AppShell;
}

export interface StudySessionTransport {
  start(body: StudySessionStartBody): Promise<unknown>;
  heartbeat(uid: string, state: ClientState): Promise<unknown>;
  end(uid: string, reason: EndReason): Promise<unknown>;
}

/** 默认传输走 `api.ts`（带 Authorization 的 `fetch`）。测试用 `setTransport` 注入假实现。 */
const defaultTransport: StudySessionTransport = {
  start: (body) => startStudySession(body),
  heartbeat: (uid, state) => heartbeatStudySession(uid, state),
  end: (uid, reason) => endStudySession(uid, reason),
};

let enabled = false;
let transport: StudySessionTransport = defaultTransport;
let subjectIdProvider: () => number | null = () => null;

let state: SessionState = 'idle';
let currentKey: string | null = null;
/** 当前场景的完整信息。开会话必须同时知道 module/scene，而 `currentKey` 只是个去重键。 */
let currentInfo: SceneInfo | null = null;
let sessionUid: string | null = null;
let lastInputAt = 0;
let lastInputRecordedAt = 0;
let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
let idleTimer: ReturnType<typeof setInterval> | null = null;

// ---------------------------------------------------------------- 对外开关

/** 角色闸门：只有学生端启动会话（家长/管理端只落 `page_view`，属 Phase 2）。 */
export function setEnabled(value: boolean): void {
  enabled = value;
  if (!value) {
    // 退出登录 / 角色变化：把在跑的会话收掉，别让它挂到惰性收尾（会白记 5 分钟）
    if (sessionUid) endSession('closed');
    else resetLocalState();
  }
}

/** 测试缝：注入假传输。 */
export function setTransport(next: StudySessionTransport): void {
  transport = next;
}

/** 学科 id 由 `learnContextStore` 提供（见 Task 9），避免 tracker 直接依赖 store。 */
export function setSubjectIdProvider(fn: () => number | null): void {
  subjectIdProvider = fn;
}

/** 测试缝：把模块级状态复位（模块单例会在用例之间残留）。 */
export function __resetForTests(): void {
  disarmTimers();
  transport = defaultTransport;
  subjectIdProvider = () => null;
  enabled = false;
  resetLocalState();
}

// ---------------------------------------------------------------- 路由 / 事件

/**
 * 路由变化。**唯一**的会话开关入口——由 `AnalyticsShell` 的 `useLocation` 副作用驱动。
 *
 * 去重：同一 `module/scene` 重复调用是 no-op（React 严格模式会双跑 effect，
 * 翻页/改 query 也不该被算成新会话）。
 *
 * 开会话**只经状态机**（`runTransition('ROUTE_ENTER')` → `effects.start`），
 * 这里不直接建会话——否则「谁负责开会话」就有两个答案，迟早重复开会话。
 */
export function onRouteChange(info: SceneInfo): void {
  if (!enabled) return;

  const key = sceneKey(info);
  if (key !== null && key === currentKey && sessionUid) return;
  if (sessionUid) runTransition('ROUTE_LEAVE');

  currentKey = key;
  currentInfo = info;
  if (key !== null) runTransition('ROUTE_ENTER');
}

/** 用户活动（节流）。用于空闲检测与「hidden → active」的恢复。 */
export function notifyInput(): void {
  if (!enabled || !sessionUid) return;
  const now = Date.now();
  if (now - lastInputRecordedAt < INPUT_THROTTLE_MS) return;
  lastInputRecordedAt = now;
  lastInputAt = now;
  applyEffect({ visibility: true });
}

/** `document.visibilitychange`。 */
export function setVisibility(visible: boolean): void {
  if (!enabled || !sessionUid) return;
  applyEffect({ visibility: visible });
}

/** `window.pagehide`。 */
export function onPageHide(): void {
  if (!enabled || !sessionUid) return;
  applyEffect({ pageHide: true });
}

// ---------------------------------------------------------------- 内部

/**
 * 真正建会话（生成 uid、采设备信息、发首次 `start`）。
 * **只由 `runTransition` 在 `effects.start` 为真时调用**——这是全模块唯一的开会话点。
 */
function beginSession(): void {
  const info = currentInfo;
  if (!info?.module || !info.scene) return;

  sessionUid = newSessionUid();
  lastInputAt = Date.now();
  lastInputRecordedAt = lastInputAt;

  const subjectId = subjectIdProvider();
  const device = collectDeviceInfo();
  void transport
    .start({
      sessionUid,
      module: info.module,
      scene: info.scene,
      ...(subjectId !== null ? { subjectId } : {}),
      ...device,
    })
    .catch(() => {
      /* 埋点失败静默：绝不打断学习 */
    });

  armTimers();
}

/** 收尾当前会话（若有）。所有「结束」都走这里，避免多处各写一遍。 */
function endSession(reason: EndReason): void {
  const uid = sessionUid;
  resetLocalState();
  if (!uid) return;
  void transport.end(uid, reason).catch(() => {
    /* 静默 */
  });
}

function sendHeartbeat(next: ClientState): void {
  const uid = sessionUid;
  if (!uid) return;
  void transport.heartbeat(uid, next).catch(() => {
    /* 同上 */
  });
}

/**
 * 把「输入 / 可见性 / pagehide」映射成状态机事件并执行副作用。
 * 心跳**由状态机产出**，不再由调用点各自决定发什么——这是「唯一真源」的落点。
 */
function applyEffect(input: { visibility?: boolean; pageHide?: boolean }): void {
  let event: 'VISIBLE' | 'HIDDEN' | 'PAGEHIDE' | null = null;
  if (input.pageHide) event = 'PAGEHIDE';
  else if (input.visibility !== undefined) event = input.visibility ? 'VISIBLE' : 'HIDDEN';

  if (!event) return;
  // 已在前台时的「恢复可见」是空操作，只刷新活跃时间；不发多余心跳。
  if (event === 'VISIBLE' && state === 'active') {
    lastInputAt = Date.now();
    return;
  }
  runTransition(event);
}

/**
 * 执行一次状态机迁移——**全部副作用的唯一出口**：`start` / `end` / `heartbeat`
 * 都由这里按 `effects` 执行。调用点（路由变化、可见性、pagehide、空闲）只负责把事件喂进来，
 * 自己不做任何网络或状态操作。这样「谁负责开会话/结束会话」永远只有一个答案。
 */
function runTransition(event: SessionEvent): void {
  const next = transition(state, event);
  state = next.state;

  if (next.effects.start) beginSession();
  if (next.effects.end) return endSession(next.effects.end);
  if (next.effects.heartbeat) sendHeartbeat(next.effects.heartbeat);
}

function armTimers(): void {
  disarmTimers();
  heartbeatTimer = setInterval(() => {
    if (state === 'active' || state === 'hidden') sendHeartbeat(state === 'active' ? 'visible' : 'hidden');
  }, HEARTBEAT_INTERVAL_MS);

  idleTimer = setInterval(() => {
    if (state === 'active' && Date.now() - lastInputAt >= IDLE_TIMEOUT_MS) runTransition('IDLE_TIMEOUT');
  }, IDLE_CHECK_INTERVAL_MS);
}

function disarmTimers(): void {
  if (heartbeatTimer !== null) clearInterval(heartbeatTimer);
  if (idleTimer !== null) clearInterval(idleTimer);
  heartbeatTimer = null;
  idleTimer = null;
}

function resetLocalState(): void {
  disarmTimers();
  state = 'idle';
  currentKey = null;
  currentInfo = null;
  sessionUid = null;
  lastInputAt = 0;
  lastInputRecordedAt = 0;
}

// ---------------------------------------------------------------- 设备分档

/**
 * 屏幕档：对齐 `UX-UI设计文档` 的 iPad 横屏主断点（≥1024px）。
 * 只在会话开始时取一次——会话中途转屏不改（一段连续学习用哪块屏不重要）。
 */
export function collectScreenClass(width: number, height: number): ScreenClass {
  if (width >= 1280) return 'desktop';
  if (width >= 1024 && width > height) return 'ipad_landscape';
  if (width >= 768) return 'tablet_portrait';
  return 'mobile';
}

/** 指针类型：粗+细同时存在（触屏笔记本）→ hybrid。 */
export function collectInputType(matches: (query: string) => boolean): InputType {
  const coarse = matches('(pointer: coarse)');
  const fine = matches('(pointer: fine)');
  if (coarse && fine) return 'hybrid';
  if (coarse) return 'touch';
  return 'mouse';
}

/** Electron 壳：UA 里有 `Electron` 标记（双保险，主判定仍看 UA）。 */
export function collectAppShell(ua: string): AppShell {
  return /Electron/i.test(ua) ? 'electron' : 'web';
}

export function collectDeviceInfo(): {
  screenClass: ScreenClass;
  inputType: InputType;
  appShell: AppShell;
} {
  const matches = (query: string) =>
    typeof window !== 'undefined' && typeof window.matchMedia === 'function'
      ? window.matchMedia(query).matches
      : false;
  return {
    screenClass: collectScreenClass(window.innerWidth, window.innerHeight),
    inputType: collectInputType(matches),
    appShell: collectAppShell(navigator.userAgent),
  };
}
