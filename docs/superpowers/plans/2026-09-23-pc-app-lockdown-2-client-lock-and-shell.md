# PC App 学习管控（2/3）：学生端锁定与 Electron 壳 — 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在 Electron 壳内实现「学生登录即真全屏 kiosk；家长设了时长则期间禁止登出；到期或家长解除后恢复可登出」，并封堵应用内逃逸（外链、跨源导航、窗口关闭）。

**Architecture:** 新建 `apps/web/src/kiosk/`（纯逻辑 + 桥接 + 全局壳 + 剩余时间 pill）与 `apps/desktop/`（Electron 主进程 + preload）。壳以 **pathless wrapper route** 挂载（与 `AnalyticsShell` 同级同法），锁定态经 preload 桥单向驱动主进程。

**Tech Stack:** React 18 + Vite + TS + Zustand + React Router 6；Vitest + @testing-library/react（`globals: false`）；Electron（dev 模式，不出包）。

## Global Constraints

- **不使用 emoji**；图标必须是线性 SVG。
- **`globals: false`**：每个测试文件显式 `import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'`，并自己写 `afterEach(() => cleanup())`（`@testing-library/react` 不自动注册）。
- **组件改动必须补渲染测试**，不能只靠 `tsc + lint + build`。
- **界面优先于文字提示**：剩余时间要被**看到**，而不是只在被拦时解释。
- **不改 `LogoutButton` 的 `aria-label`/`title` 默认值**：4 个现有测试用 `getByLabelText('退出登录')` / `getByRole('button', { name: '退出登录' })` 断言存在，改了会连带打破它们。
- **不要给 `LogoutButton` 加原生 `disabled`**：原生禁用按钮**不触发 click**，解释用的 toast 就永远弹不出来。用 `aria-disabled` + 在 handler 里拒绝。
- **`LEARNING_SESSION_POLL_MS = 10_000` 与服务端 `LEARNING_SESSION_ONLINE_WINDOW_SECONDS = 45` 成对**，改一处必须同步另一处（镜像纪律）。
- **拔网线不解锁**：本地持久化的截止时间是唯一判据，轮询失败**不得**清锁。
- **`services/api.ts` 是唯一 API 层**，不新开 fetch 封装。

> **上游**：`docs/superpowers/specs/2026-09-23-pc-app-study-lockdown-design.md` §6、§8。
> **前置**：`…-1-backend.md` 必须已合并（本计划的 3 个新端点由它提供）。
> **后续**：`…-3-parent-ui-and-docs.md`。

---

## 文件结构

| 文件 | 责任 |
|---|---|
| `apps/web/src/kiosk/learningLock.ts` | **新建**：纯逻辑 —— 常量、持久化模型、`isLocked`、`formatRemaining`。无副作用、可纯测 |
| `apps/web/src/kiosk/desktopBridge.ts` | **新建**：与 Electron 的桥 + 登出收尾（唯一有副作用的地方） |
| `apps/web/src/kiosk/LearningSessionShell.tsx` | **新建**：状态机编排（建会话 / 同步锁定态 / 轮询 / 到点解锁） |
| `apps/web/src/kiosk/LockedPill.tsx` | **新建**：锁定中的「剩余 N 分钟」pill |
| `apps/web/src/routes/index.tsx` | 把 `LearningSessionShell` 挂成第二个 pathless wrapper |
| `apps/web/src/services/api.ts` | 加 3 个函数 + 3 个类型 |
| `apps/web/src/components/base/LogoutButton.tsx` | 锁定中拒绝登出 |
| `apps/desktop/package.json` · `main.js` · `preload.js` | **新建**：Electron 壳 |

**为什么 `learningLock.ts` 要独立成"纯"文件**：锁定判定是本功能最容易出错的地方（到期边界、跨学生、已解除），必须能在没有 DOM / 没有 Electron 的环境里逐条测。把它和 IPC 混在一起就只能靠人工冒烟，那不够。

---

## Task 1: web API 层与类型

**Files:**
- Modify: `apps/web/src/services/api.ts`（在文件末尾追加一节）

**Interfaces:**
- Produces:
  - `export interface StudentLearningSession { id: number; startedAt: string; lockMinutes: number | null; lockExpiresAt: string | null; unlockedAt: string | null }`
  - `export function openStudentLearningSession(): Promise<StudentLearningSession>`
  - `export function endStudentLearningSession(id: number): Promise<{ id: number; endedAt: string }>`
  - `export interface DeviceCommandPoll { commands: Array<{ id: number; command: string }>; lock: { sessionId: number; lockExpiresAt: string | null; unlockedAt: string | null } | null }`
  - `export function pollStudentDeviceCommands(): Promise<DeviceCommandPoll>`

- [ ] **Step 1: 追加代码**

在 `apps/web/src/services/api.ts` 末尾追加（沿用该文件既有风格：`fetchApi` + 显式返回类型 + 上一条注释说明契约）：

```ts
// --- 学生端：学习会话与设备命令（spec §5.1–§5.3，PC App 学习管控）---

/**
 * `POST /api/student/learning-sessions` —— 取或建本次学习会话。
 *
 * **幂等**：服务端已有进行中的会话就原样返回（含**原来那个** `lockExpiresAt`），
 * 所以客户端重启后再调也不会重置锁定时钟。成功码是 **200**（本仓唯一覆盖 `@Post` 默认 201 的端点）。
 */
export interface StudentLearningSession {
  id: number;
  startedAt: string;
  /** 开始时的快照；`null` = 本次未设锁。 */
  lockMinutes: number | null;
  lockExpiresAt: string | null;
  unlockedAt: string | null;
}

export function openStudentLearningSession(): Promise<StudentLearningSession> {
  return fetchApi<StudentLearningSession>('/student/learning-sessions', { method: 'POST' });
}

/** `PATCH /api/student/learning-sessions/:id/end` —— 正常登出。幂等。 */
export function endStudentLearningSession(id: number): Promise<{ id: number; endedAt: string }> {
  return fetchApi<{ id: number; endedAt: string }>(`/student/learning-sessions/${id}/end`, {
    method: 'PATCH',
  });
}

/**
 * `GET /api/student/device-commands` —— 轮询（兼心跳，服务端据此刷 `last_seen_at`）。
 *
 * `lock` 是服务端对当前会话锁定态的权威描述，客户端拿它**对账**（家长在别处解除时，
 * 本地的 `lockExpiresAt` 会被这里带回的 `unlockedAt` 覆盖）。无进行中会话 → `lock: null`。
 */
export interface DeviceCommandPoll {
  commands: Array<{ id: number; command: string }>;
  lock: { sessionId: number; lockExpiresAt: string | null; unlockedAt: string | null } | null;
}

export function pollStudentDeviceCommands(): Promise<DeviceCommandPoll> {
  return fetchApi<DeviceCommandPoll>('/student/device-commands');
}
```

- [ ] **Step 2: 类型检查**

Run: `cd apps/web && npx tsc -b`
Expected: 无输出（干净）。若有 `fetchApi` 未使用的类型参数告警，检查 `fetchApi<T>` 的泛型是否被推断成 `unknown`。

- [ ] **Step 3: Commit**

```bash
git add apps/web/src/services/api.ts
git commit -m "feat(web/api): 学生端学习会话与设备命令的 API 层与类型"
```

---

## Task 2: 锁定判定的纯逻辑

**Files:**
- Create: `apps/web/src/kiosk/learningLock.ts`
- Test: `apps/web/src/kiosk/learningLock.test.ts`

**Interfaces:**
- Produces:
  - `export const LEARNING_SESSION_STORAGE_KEY = 'k12_learning_session'`
  - `export const LEARNING_SESSION_POLL_MS = 10_000`
  - `export interface PersistedLearningSession { studentId: number; id: number; lockExpiresAt: string | null; unlockedAt: string | null }`
  - `readPersistedSession(studentId?: number | null): PersistedLearningSession | null`
  - `writePersistedSession(value: PersistedLearningSession): void`
  - `clearPersistedSession(): void`
  - `isLocked(session: { lockExpiresAt: string | null; unlockedAt: string | null } | null, now?: number): boolean`
  - `remainingMs(lockExpiresAt: string, now?: number): number`
  - `formatRemaining(ms: number): string`
  - `isCurrentStudentLocked(now?: number): boolean`

- [ ] **Step 1: 写失败的测试**

创建 `apps/web/src/kiosk/learningLock.test.ts`：

```ts
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  LEARNING_SESSION_STORAGE_KEY,
  clearPersistedSession,
  formatRemaining,
  isCurrentStudentLocked,
  isLocked,
  readPersistedSession,
  remainingMs,
  writePersistedSession,
} from './learningLock';

const T0 = Date.parse('2026-09-23T01:00:00.000Z');
const LATER = '2026-09-23T02:00:00.000Z';

beforeEach(() => localStorage.clear());
afterEach(() => localStorage.clear());

describe('isLocked', () => {
  it('未设锁（lockExpiresAt=null）→ 不锁', () => {
    expect(isLocked({ lockExpiresAt: null, unlockedAt: null }, T0)).toBe(false);
  });

  it('无会话（null）→ 不锁', () => {
    expect(isLocked(null, T0)).toBe(false);
  });

  it('截止时间在将来 → 锁', () => {
    expect(isLocked({ lockExpiresAt: LATER, unlockedAt: null }, T0)).toBe(true);
  });

  it('截止时间**恰好等于** now → 不锁（到期即解除，边界取开区间）', () => {
    expect(isLocked({ lockExpiresAt: LATER, unlockedAt: null }, Date.parse(LATER))).toBe(false);
  });

  it('截止时间已过 → 不锁（自动解除）', () => {
    expect(isLocked({ lockExpiresAt: LATER, unlockedAt: null }, Date.parse(LATER) + 1)).toBe(false);
  });

  it('家长已解除（unlockedAt 非空）→ 不锁，**哪怕截止时间还没到**', () => {
    expect(
      isLocked({ lockExpiresAt: LATER, unlockedAt: '2026-09-23T01:20:00.000Z' }, T0),
    ).toBe(false);
  });

  it('截止时间是不可解析的字符串 → 不锁（不抛错，宁可放行也不锁死）', () => {
    expect(isLocked({ lockExpiresAt: 'not-a-date', unlockedAt: null }, T0)).toBe(false);
  });
});

describe('持久化与跨学生隔离', () => {
  it('写入后能读回', () => {
    writePersistedSession({ studentId: 9, id: 7, lockExpiresAt: LATER, unlockedAt: null });
    expect(readPersistedSession(9)).toEqual({
      studentId: 9,
      id: 7,
      lockExpiresAt: LATER,
      unlockedAt: null,
    });
  });

  it('**studentId 不符 → 返回 null**（同一台设备换学生登录时，不许沿用上一个人的锁定）', () => {
    writePersistedSession({ studentId: 9, id: 7, lockExpiresAt: LATER, unlockedAt: null });
    expect(readPersistedSession(42)).toBeNull();
  });

  it('不传 studentId 时不做归属校验', () => {
    writePersistedSession({ studentId: 9, id: 7, lockExpiresAt: LATER, unlockedAt: null });
    expect(readPersistedSession()?.id).toBe(7);
  });

  it('内容损坏 → 返回 null，不抛错', () => {
    localStorage.setItem(LEARNING_SESSION_STORAGE_KEY, '{ 坏掉的 json');
    expect(readPersistedSession(9)).toBeNull();
  });

  it('形状不对（缺 id）→ 返回 null', () => {
    localStorage.setItem(LEARNING_SESSION_STORAGE_KEY, JSON.stringify({ studentId: 9 }));
    expect(readPersistedSession(9)).toBeNull();
  });

  it('clear 之后读不到', () => {
    writePersistedSession({ studentId: 9, id: 7, lockExpiresAt: LATER, unlockedAt: null });
    clearPersistedSession();
    expect(readPersistedSession(9)).toBeNull();
  });
});

describe('isCurrentStudentLocked', () => {
  it('userId 与持久化会话一致且在锁定期内 → true', () => {
    localStorage.setItem('userId', '9');
    writePersistedSession({ studentId: 9, id: 7, lockExpiresAt: LATER, unlockedAt: null });
    expect(isCurrentStudentLocked(T0)).toBe(true);
  });

  it('userId 是别的学生 → false', () => {
    localStorage.setItem('userId', '42');
    writePersistedSession({ studentId: 9, id: 7, lockExpiresAt: LATER, unlockedAt: null });
    expect(isCurrentStudentLocked(T0)).toBe(false);
  });

  it('没有 userId（未登录）→ false', () => {
    writePersistedSession({ studentId: 9, id: 7, lockExpiresAt: LATER, unlockedAt: null });
    expect(isCurrentStudentLocked(T0)).toBe(false);
  });
});

describe('remainingMs / formatRemaining', () => {
  it('remainingMs = 截止 - now', () => {
    expect(remainingMs(LATER, T0)).toBe(3_600_000);
  });

  it('已过期 → 负数（调用方负责判断）', () => {
    expect(remainingMs(LATER, Date.parse(LATER) + 5_000)).toBe(-5_000);
  });

  it.each([
    [3_600_000, '剩余 60 分钟'],
    [2_700_000, '剩余 45 分钟'],
    [60_000, '剩余 1 分钟'],
    [90_000, '剩余 2 分钟'], // 向上取整：1.5 分钟不该显示成 1 分钟（会让人以为马上能走）
    [30_000, '剩余不足 1 分钟'],
    [0, '剩余不足 1 分钟'],
  ])('formatRemaining(%s) → %s', (ms, text) => {
    expect(formatRemaining(ms)).toBe(text);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd apps/web && npx vitest run src/kiosk/learningLock.test.ts`
Expected: FAIL —— `Failed to resolve import './learningLock'`。

- [ ] **Step 3: 实现**

创建 `apps/web/src/kiosk/learningLock.ts`：

```ts
/**
 * 学习锁定的**纯逻辑**（spec `2026-09-23-pc-app-study-lockdown-design.md` §6.2/§6.4）。
 *
 * 本文件刻意不碰 Electron、不发请求：锁定判定是最容易出错的地方（到期边界、跨学生、
 * 家长已解除），必须能在没有 DOM / 没有壳的环境里逐条测。
 */

/** localStorage 键：本次学习会话的本地快照。 */
export const LEARNING_SESSION_STORAGE_KEY = 'k12_learning_session';

/**
 * 客户端轮询间隔（毫秒）。
 *
 * ⚠️ **与服务端 `LEARNING_SESSION_ONLINE_WINDOW_SECONDS = 45` 成对**（45 秒 = 容忍 4 次
 * 丢包/抖动）。**改一处必须同步另一处**——沿用本仓 `IDLE_TIMEOUT_MS` ↔
 * `CLIENT_IDLE_DETECTION_SECONDS` 的镜像纪律。
 */
export const LEARNING_SESSION_POLL_MS = 10_000;

export interface PersistedLearningSession {
  /**
   * 归属学生。**必须存**：本仓 MVP 明确「家长与学生可共用同一设备」（UX `:233-234`），
   * 换学生登录后若沿用上一个人的锁定，会锁住一个本不该被锁的孩子。
   */
  studentId: number;
  id: number;
  lockExpiresAt: string | null;
  unlockedAt: string | null;
}

/**
 * 读本地快照。传了 `studentId` 就做归属校验，不符返回 `null`。
 *
 * **每次调用都重新 `localStorage.getItem`**，不在模块初始化时缓存：测试的
 * `beforeEach` 会 `vi.stubGlobal('localStorage', …)` 换成新的内存实现，
 * 模块级缓存会拿到过期对象（`parentStudentStore.ts` 踩过这个坑，注释里有完整经过）。
 * 内容损坏 / 形状不对一律返回 `null`，不抛错——坏数据不该让整个应用白屏。
 */
export function readPersistedSession(studentId?: number | null): PersistedLearningSession | null {
  if (typeof localStorage === 'undefined') return null;
  const raw = localStorage.getItem(LEARNING_SESSION_STORAGE_KEY);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<PersistedLearningSession> | null;
    if (!parsed || typeof parsed !== 'object') return null;
    if (typeof parsed.studentId !== 'number' || typeof parsed.id !== 'number') return null;
    if (studentId !== undefined && studentId !== null && parsed.studentId !== studentId) return null;
    return {
      studentId: parsed.studentId,
      id: parsed.id,
      lockExpiresAt: typeof parsed.lockExpiresAt === 'string' ? parsed.lockExpiresAt : null,
      unlockedAt: typeof parsed.unlockedAt === 'string' ? parsed.unlockedAt : null,
    };
  } catch {
    return null;
  }
}

export function writePersistedSession(value: PersistedLearningSession): void {
  if (typeof localStorage === 'undefined') return;
  localStorage.setItem(LEARNING_SESSION_STORAGE_KEY, JSON.stringify(value));
}

export function clearPersistedSession(): void {
  if (typeof localStorage === 'undefined') return;
  localStorage.removeItem(LEARNING_SESSION_STORAGE_KEY);
}

/**
 * 是否处于锁定中（= 期间禁止登出）。
 *
 * 四个条件缺一不可：有截止时间、**家长没解除**、截止时间可解析、且**严格晚于** now。
 *
 * 「截止时间恰好等于 now」算**不锁**（开区间）：到点自动解除，边界上不该多锁一毫秒。
 * 不可解析的日期算**不锁**：宁可放行也不能把一个学生永久锁死。
 * `unlockedAt` 优先于截止时间：家长点了「解除」就该立刻生效，不必等原定时刻。
 */
export function isLocked(
  session: { lockExpiresAt: string | null; unlockedAt: string | null } | null,
  now: number = Date.now(),
): boolean {
  if (!session) return false;
  if (session.unlockedAt !== null) return false;
  if (session.lockExpiresAt === null) return false;
  const expiresAt = Date.parse(session.lockExpiresAt);
  if (!Number.isFinite(expiresAt)) return false;
  return expiresAt > now;
}

/** 当前登录学生是否被锁。未登录 / 非该生 → false。 */
export function isCurrentStudentLocked(now: number = Date.now()): boolean {
  if (typeof localStorage === 'undefined') return false;
  const rawUserId = localStorage.getItem('userId');
  if (rawUserId === null) return false;
  const studentId = Number(rawUserId);
  if (!Number.isFinite(studentId)) return false;
  return isLocked(readPersistedSession(studentId), now);
}

/** 剩余毫秒（可能为负；调用方负责判断）。 */
export function remainingMs(lockExpiresAt: string, now: number = Date.now()): number {
  return Date.parse(lockExpiresAt) - now;
}

/**
 * 剩余时间的展示文案。**向上取整到分钟**：1 分 30 秒显示「剩余 2 分钟」而不是 1 分钟——
 * 少报会让学生以为马上能走，多报 30 秒无感。
 */
export function formatRemaining(ms: number): string {
  if (ms < 60_000) return '剩余不足 1 分钟';
  return `剩余 ${Math.ceil(ms / 60_000)} 分钟`;
}
```

- [ ] **Step 4: 跑测试**

Run: `cd apps/web && npx vitest run src/kiosk/learningLock.test.ts`
Expected: PASS（全 20+ 用例）。

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/kiosk/learningLock.ts apps/web/src/kiosk/learningLock.test.ts
git commit -m "feat(kiosk): 锁定判定的纯逻辑 + 常量（含跨学生隔离与到期边界）"
```

---

## Task 3: 桥接层（Electron IPC + 登出收尾）

**Files:**
- Create: `apps/web/src/kiosk/desktopBridge.ts`
- Test: `apps/web/src/kiosk/desktopBridge.test.ts`

**Interfaces:**
- Consumes: `readPersistedSession` / `clearPersistedSession` / `LEARNING_SESSION_STORAGE_KEY`（Task 2）、`endStudentLearningSession`（Task 1）
- Produces:
  - `export interface K12DesktopBridge { setLocked: (locked: boolean) => void; isDesktop: true }`
  - `export function isDesktopShell(): boolean`
  - `export function setDesktopLocked(locked: boolean): void`
  - `export function releaseOnLogout(): void`

- [ ] **Step 1: 写失败的测试**

创建 `apps/web/src/kiosk/desktopBridge.test.ts`：

```ts
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readPersistedSession, writePersistedSession } from './learningLock';
import { endStudentLearningSession } from '@/services/api';

vi.mock('@/services/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/services/api')>();
  return { ...actual, endStudentLearningSession: vi.fn() };
});

const endMock = vi.mocked(endStudentLearningSession);

/** 每个用例装一个新的壳桥，并记下调用。 */
function installBridge() {
  const calls: boolean[] = [];
  (window as unknown as { k12Desktop?: unknown }).k12Desktop = {
    isDesktop: true,
    setLocked: (locked: boolean) => calls.push(locked),
  };
  return calls;
}

beforeEach(() => {
  localStorage.clear();
  endMock.mockReset();
  endMock.mockResolvedValue({ id: 7, endedAt: '2026-09-23T02:00:00.000Z' });
});

afterEach(() => {
  delete (window as unknown as { k12Desktop?: unknown }).k12Desktop;
  localStorage.clear();
  vi.restoreAllMocks();
});

describe('isDesktopShell / setDesktopLocked', () => {
  it('没有桥（浏览器）→ isDesktopShell() 为 false', async () => {
    const { isDesktopShell } = await import('./desktopBridge');
    expect(isDesktopShell()).toBe(false);
  });

  it('setDesktopLocked 把布尔值原样送到桥', async () => {
    const calls = installBridge();
    const { setDesktopLocked } = await import('./desktopBridge');
    setDesktopLocked(true);
    setDesktopLocked(false);
    expect(calls).toEqual([true, false]);
  });

  it('没有桥时 setDesktopLocked **不抛错**（浏览器里也是正常路径）', async () => {
    const { setDesktopLocked } = await import('./desktopBridge');
    expect(() => setDesktopLocked(true)).not.toThrow();
  });
});

describe('releaseOnLogout', () => {
  it('结束服务端会话 + 清本地快照 + 解除壳锁定', async () => {
    const calls = installBridge();
    localStorage.setItem('userId', '9');
    writePersistedSession({ studentId: 9, id: 7, lockExpiresAt: null, unlockedAt: null });
    const { releaseOnLogout } = await import('./desktopBridge');

    releaseOnLogout();

    expect(endMock).toHaveBeenCalledWith(7);
    expect(readPersistedSession(9)).toBeNull();
    expect(calls).toEqual([false]);
  });

  it('没有本地快照时不发请求，但仍要解除壳锁定', async () => {
    const calls = installBridge();
    localStorage.setItem('userId', '9');
    const { releaseOnLogout } = await import('./desktopBridge');

    releaseOnLogout();

    expect(endMock).not.toHaveBeenCalled();
    expect(calls).toEqual([false]);
  });

  it('结束会话的请求失败**不抛错、也不阻断登出**', async () => {
    installBridge();
    localStorage.setItem('userId', '9');
    writePersistedSession({ studentId: 9, id: 7, lockExpiresAt: null, unlockedAt: null });
    endMock.mockRejectedValue(new Error('network down'));
    const { releaseOnLogout } = await import('./desktopBridge');

    expect(() => releaseOnLogout()).not.toThrow();
    expect(readPersistedSession(9)).toBeNull();
  });
});
```

> 用 `await import(...)` 而不是顶层 import：`isDesktopShell()` 读 `window`，必须在 stub 装好之后再取用。

- [ ] **Step 2: 跑测试确认失败**

Run: `cd apps/web && npx vitest run src/kiosk/desktopBridge.test.ts`
Expected: FAIL —— 模块不存在。

- [ ] **Step 3: 实现**

创建 `apps/web/src/kiosk/desktopBridge.ts`：

```ts
import { endStudentLearningSession } from '@/services/api';
import { clearPersistedSession, readPersistedSession } from './learningLock';

/** preload 经 `contextBridge` 暴露的接口（见 `apps/desktop/preload.js`）。 */
export interface K12DesktopBridge {
  /** 驱动主进程进/出 kiosk。渲染层是唯一发起方。 */
  setLocked: (locked: boolean) => void;
  isDesktop: true;
}

declare global {
  interface Window {
    k12Desktop?: K12DesktopBridge;
  }
}

/**
 * 是否运行在 Electron 壳里。
 *
 * 这是**能力探测，不是环境判断**：浏览器里没有 `window.k12Desktop`，锁定相关的一切
 * （建会话、轮询、禁登出、剩余时间）都该整段跳过——浏览器没有 kiosk 可逃，锁它没有意义，
 * 而 Web 端「进出时间」也不在本期范围内（spec §8 局限 5）。
 */
export function isDesktopShell(): boolean {
  return typeof window !== 'undefined' && Boolean(window.k12Desktop);
}

/** 把锁定态同步给主进程。没有桥时是**静默 no-op**（浏览器里也是正常路径，不是异常）。 */
export function setDesktopLocked(locked: boolean): void {
  window.k12Desktop?.setLocked(locked);
}

/**
 * 真正登出时的收尾，由 `LogoutButton` 调用。
 *
 * 三件事，**顺序有意**：
 *   1. 先告诉服务端这次学习会话结束了（`ended_at` 是家长端「退出时间」的数据源，
 *      不发这个请求，家长会看到一次永远「进行中 / 已断开」的记录）；
 *   2. 再清本地快照（否则下次登录会沿用旧会话）；
 *   3. 最后解除壳锁定（不清壳锁定的话，登出后窗口仍然是 kiosk，家长/管理员用不了）。
 *
 * 请求失败**必须吞掉**：登出是主链路，不能因为一次网络抖动就把学生留在登录页外面。
 * 本地快照照清、壳锁定照解——最坏情况是家长端少一条 `ended_at`。
 */
export function releaseOnLogout(): void {
  const session = readPersistedSession();
  if (session) {
    void endStudentLearningSession(session.id).catch(() => {
      /* 吞掉：登出不得被网络问题阻断 */
    });
  }
  clearPersistedSession();
  setDesktopLocked(false);
}
```

- [ ] **Step 4: 跑测试**

Run: `cd apps/web && npx vitest run src/kiosk/desktopBridge.test.ts`
Expected: PASS。

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/kiosk/desktopBridge.ts apps/web/src/kiosk/desktopBridge.test.ts
git commit -m "feat(kiosk): Electron 桥接层与登出收尾（失败不阻断登出）"
```

---

## Task 4: 剩余时间 pill

**Files:**
- Create: `apps/web/src/kiosk/LockedPill.tsx`
- Test: `apps/web/src/kiosk/LockedPill.test.tsx`

**Interfaces:**
- Consumes: `formatRemaining`（Task 2）
- Produces: `export function LockedPill({ remainingMs }: { remainingMs: number }): JSX.Element`

- [ ] **Step 1: 写失败的测试**

创建 `apps/web/src/kiosk/LockedPill.test.tsx`：

```tsx
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { LockedPill } from './LockedPill';

afterEach(() => cleanup());

describe('LockedPill', () => {
  it('渲染剩余分钟数', () => {
    render(<LockedPill remainingMs={42 * 60_000} />);
    expect(screen.getByTestId('locked-pill')).toHaveTextContent('剩余 42 分钟');
  });

  it('不足一分钟时也给文案，不显示 0 或负数', () => {
    render(<LockedPill remainingMs={5_000} />);
    expect(screen.getByTestId('locked-pill')).toHaveTextContent('剩余不足 1 分钟');
    expect(screen.getByTestId('locked-pill')).not.toHaveTextContent('-');
  });

  it('说明这是家长设定的时长，避免学生以为是卡顿', () => {
    render(<LockedPill remainingMs={30 * 60_000} />);
    expect(screen.getByTestId('locked-pill')).toHaveTextContent('本次学习时长未满');
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd apps/web && npx vitest run src/kiosk/LockedPill.test.tsx`
Expected: FAIL —— 模块不存在。

- [ ] **Step 3: 实现**

创建 `apps/web/src/kiosk/LockedPill.tsx`：

```tsx
import { formatRemaining } from './learningLock';

/**
 * 锁定中的剩余时间提示（spec §6.4）。
 *
 * **为什么要它**：仓库纪律「界面优先于文字提示」——剩余时间要被**看到**，
 * 而不是只在学生点了登出、被拒绝时才解释。学生知道还有多久，就不会去试各种逃逸路径。
 *
 * 定位用 fixed + 顶部居中：沉浸页自己的顶栏在右上角已经有 `LogoutButton`，
 * 贴右上会撞在一起。**人工冒烟时确认它与各页顶栏不重叠**；若重叠，这是纯展示层调整，
 * 改 className 即可，不要动状态机。
 */
export function LockedPill({ remainingMs }: { remainingMs: number }) {
  return (
    <div
      data-testid="locked-pill"
      role="status"
      aria-live="polite"
      className="fixed left-1/2 top-3 z-50 -translate-x-1/2 rounded-full border border-[var(--brand-500)] bg-[var(--brand-100)] px-4 py-1.5 text-sm font-medium text-[var(--brand-600)] shadow-sm"
    >
      {formatRemaining(remainingMs)} · 本次学习时长未满，需家长解除后才能退出
    </div>
  );
}
```

- [ ] **Step 4: 跑测试**

Run: `cd apps/web && npx vitest run src/kiosk/LockedPill.test.tsx`
Expected: PASS。

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/kiosk/LockedPill.tsx apps/web/src/kiosk/LockedPill.test.tsx
git commit -m "feat(kiosk): 锁定中的剩余时间 pill"
```

---

## Task 5: `LearningSessionShell` 与挂载

**Files:**
- Create: `apps/web/src/kiosk/LearningSessionShell.tsx`
- Modify: `apps/web/src/routes/index.tsx`
- Test: `apps/web/src/kiosk/LearningSessionShell.test.tsx`

**Interfaces:**
- Consumes: Task 1/2/3 全部产物
- Produces: `export default function LearningSessionShell()`

- [ ] **Step 1: 写失败的测试**

创建 `apps/web/src/kiosk/LearningSessionShell.test.tsx`：

```tsx
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import LearningSessionShell from './LearningSessionShell';
import { LEARNING_SESSION_STORAGE_KEY, readPersistedSession, writePersistedSession } from './learningLock';
import { openStudentLearningSession, pollStudentDeviceCommands } from '@/services/api';

vi.mock('@/services/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/services/api')>();
  return {
    ...actual,
    openStudentLearningSession: vi.fn(),
    pollStudentDeviceCommands: vi.fn(),
    endStudentLearningSession: vi.fn(),
  };
});

const openMock = vi.mocked(openStudentLearningSession);
const pollMock = vi.mocked(pollStudentDeviceCommands);

const LATER = new Date(Date.now() + 60 * 60_000).toISOString();

let lockCalls: boolean[] = [];

function installBridge() {
  lockCalls = [];
  (window as unknown as { k12Desktop?: unknown }).k12Desktop = {
    isDesktop: true,
    setLocked: (locked: boolean) => lockCalls.push(locked),
  };
}

function renderShell() {
  return render(
    <MemoryRouter initialEntries={['/student/course-detail']}>
      <Routes>
        <Route element={<LearningSessionShell />}>
          <Route path="/student/course-detail" element={<div>学习页</div>} />
        </Route>
      </Routes>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  localStorage.clear();
  installBridge();
  localStorage.setItem('userRole', 'student');
  localStorage.setItem('userId', '9');
  openMock.mockReset();
  openMock.mockResolvedValue({
    id: 7,
    startedAt: '2026-09-23T01:00:00.000Z',
    lockMinutes: 60,
    lockExpiresAt: LATER,
    unlockedAt: null,
  });
  pollMock.mockReset();
  pollMock.mockResolvedValue({ commands: [], lock: null });
});

afterEach(() => {
  cleanup();
  delete (window as unknown as { k12Desktop?: unknown }).k12Desktop;
  vi.useRealTimers();
  vi.restoreAllMocks();
  localStorage.clear();
});

describe('LearningSessionShell：建立会话', () => {
  it('学生 + 壳 → 调取或建，并把锁定态推给壳', async () => {
    renderShell();
    await act(async () => { await Promise.resolve(); });

    expect(openMock).toHaveBeenCalledTimes(1);
    expect(lockCalls).toEqual([true]);
    expect(readPersistedSession(9)).toMatchObject({ id: 7, lockExpiresAt: LATER });
    expect(screen.getByText('学习页')).toBeInTheDocument();
  });

  it('**非壳（浏览器）→ 完全不建会话、不锁**', async () => {
    delete (window as unknown as { k12Desktop?: unknown }).k12Desktop;
    renderShell();
    await act(async () => { await Promise.resolve(); });

    expect(openMock).not.toHaveBeenCalled();
    expect(lockCalls).toEqual([]);
  });

  it('非学生角色（家长登录）→ 不建会话，且把壳解锁', async () => {
    localStorage.setItem('userRole', 'parent');
    renderShell();
    await act(async () => { await Promise.resolve(); });

    expect(openMock).not.toHaveBeenCalled();
    expect(lockCalls).toEqual([false]);
  });

  it('已有本地会话 → 不重复建（重启不重置时钟）', async () => {
    writePersistedSession({ studentId: 9, id: 7, lockExpiresAt: LATER, unlockedAt: null });
    renderShell();
    await act(async () => { await Promise.resolve(); });

    expect(openMock).not.toHaveBeenCalled();
    expect(lockCalls).toEqual([true]);
  });

  it('建会话失败 → 保持未锁（不把学生挡在门外）', async () => {
    openMock.mockRejectedValue(new Error('boom'));
    renderShell();
    await act(async () => { await Promise.resolve(); });

    expect(lockCalls).toEqual([false]);
  });

  it('未设锁（lockExpiresAt=null）→ 建会话但**不锁**', async () => {
    openMock.mockResolvedValue({
      id: 7,
      startedAt: '2026-09-23T01:00:00.000Z',
      lockMinutes: null,
      lockExpiresAt: null,
      unlockedAt: null,
    });
    renderShell();
    await act(async () => { await Promise.resolve(); });

    expect(readPersistedSession(9)).toMatchObject({ lockExpiresAt: null });
    expect(lockCalls).toEqual([false]);
  });
});

describe('LearningSessionShell：轮询与解锁', () => {
  it('轮询取到 unlock 命令 → 解锁并落 unlockedAt', async () => {
    vi.useFakeTimers();
    pollMock.mockResolvedValue({
      commands: [{ id: 3, command: 'unlock' }],
      lock: { sessionId: 7, lockExpiresAt: LATER, unlockedAt: '2026-09-23T01:20:00.000Z' },
    });
    renderShell();
    await act(async () => { vi.advanceTimersByTime(10_000); });
    await act(async () => { await Promise.resolve(); });

    expect(pollMock).toHaveBeenCalled();
    expect(lockCalls[lockCalls.length - 1]).toBe(false);
    expect(readPersistedSession(9)?.unlockedAt).not.toBeNull();
  });

  it('**轮询失败不清锁**（拔网线不解锁）', async () => {
    vi.useFakeTimers();
    pollMock.mockRejectedValue(new Error('offline'));
    renderShell();
    await act(async () => { vi.advanceTimersByTime(30_000); });
    await act(async () => { await Promise.resolve(); });

    expect(lockCalls[lockCalls.length - 1]).toBe(true);
    expect(readPersistedSession(9)?.lockExpiresAt).toBe(LATER);
  });

  it('到点自动解除（不必家长操作）', async () => {
    vi.useFakeTimers();
    const soon = new Date(Date.now() + 2_000).toISOString();
    openMock.mockResolvedValue({
      id: 7,
      startedAt: '2026-09-23T01:00:00.000Z',
      lockMinutes: 1,
      lockExpiresAt: soon,
      unlockedAt: null,
    });
    renderShell();
    await act(async () => { await Promise.resolve(); });
    expect(lockCalls[lockCalls.length - 1]).toBe(true);

    await act(async () => { vi.advanceTimersByTime(3_000); });

    expect(lockCalls[lockCalls.length - 1]).toBe(false);
  });

  it('锁定中渲染剩余时间 pill；解锁后消失', async () => {
    vi.useFakeTimers();
    renderShell();
    await act(async () => { await Promise.resolve(); });
    expect(screen.getByTestId('locked-pill')).toBeInTheDocument();

    await act(async () => { vi.advanceTimersByTime(61 * 60_000); });
    expect(screen.queryByTestId('locked-pill')).not.toBeInTheDocument();
  });

  it('未锁定时不渲染 pill', async () => {
    openMock.mockResolvedValue({
      id: 7,
      startedAt: '2026-09-23T01:00:00.000Z',
      lockMinutes: null,
      lockExpiresAt: null,
      unlockedAt: null,
    });
    renderShell();
    await act(async () => { await Promise.resolve(); });

    expect(screen.queryByTestId('locked-pill')).not.toBeInTheDocument();
  });
});

describe('LearningSessionShell：本地快照', () => {
  it('本地快照损坏也不崩溃，退化为未锁', async () => {
    localStorage.setItem(LEARNING_SESSION_STORAGE_KEY, 'not json');
    renderShell();
    await act(async () => { await Promise.resolve(); });

    expect(screen.getByText('学习页')).toBeInTheDocument();
    expect(openMock).toHaveBeenCalledTimes(1);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd apps/web && npx vitest run src/kiosk/LearningSessionShell.test.tsx`
Expected: FAIL —— 组件不存在。

- [ ] **Step 3: 实现 `LearningSessionShell.tsx`**

> **实施时修正（2026-09-24，两处）**：
> 1. **推送锁定态只留一个出口，并加 `resolved` 门**。初稿在 effect ① 里对「非学生角色」直接
>    `setDesktopLocked(false)`，同时 effect ② 也推当前 `locked` —— 于是挂载瞬间会发**两次**
>    （`[false, false]`），新生登录路径更是 `[false, true]`：先退出 kiosk 再进回去。
>    这与本计划 Step 1 的测试（用精确数组断言 `[true]` / `[false]`）**自相矛盾**，
>    且「先解锁再锁回」在真机上可能让 kiosk 闪一下普通窗口。改为：effect ① 只做判定并置
>    `resolved`，effect ② 是**唯一**推送点、且在 `resolved` 之前不推（判定完成前不猜）。
> 2. **effect ③ 的依赖从 `[lock?.id]` 改为 `[lockId]`**（`const lockId = lock?.id ?? null`）：
>    语义完全等价（换会话才换轮询，否则每次轮询 `setLock` 都会重建 interval），
>    只是让 `react-hooks/exhaustive-deps` 不再报警告——它是**刻意收窄**的依赖，不是漏写。

```tsx
import { useEffect, useState } from 'react';
import { Outlet, useLocation } from 'react-router-dom';
import {
  openStudentLearningSession,
  pollStudentDeviceCommands,
} from '@/services/api';
import {
  LEARNING_SESSION_POLL_MS,
  isLocked as computeLocked,
  readPersistedSession,
  remainingMs,
  writePersistedSession,
} from './learningLock';
import { isDesktopShell, setDesktopLocked } from './desktopBridge';
import { LockedPill } from './LockedPill';

interface LockState {
  id: number;
  lockExpiresAt: string | null;
  unlockedAt: string | null;
}

/** 从本地快照取初值：**重启后第一帧就应该是锁着的**，不能等接口回来才锁。 */
function initialLockState(): LockState | null {
  const rawUserId = typeof localStorage === 'undefined' ? null : localStorage.getItem('userId');
  const studentId = rawUserId === null ? null : Number(rawUserId);
  const persisted = readPersistedSession(studentId);
  return persisted
    ? { id: persisted.id, lockExpiresAt: persisted.lockExpiresAt, unlockedAt: persisted.unlockedAt }
    : null;
}

/**
 * PC App 学习锁定的全局壳（spec §6.2）。
 *
 * **挂载点是 pathless wrapper**（见 `routes/index.tsx`），与 `AnalyticsShell` 同法：
 * 学习页是 full-screen、不在任何 Layout 下，只有路由根层能覆盖全部路由。
 *
 * **角色闸门放在路由 effect 里、而不是挂载 effect 里**——与 `AnalyticsShell` 同一个理由，
 * 别改回去：登录/登出都是**客户端导航**（写 localStorage 后直接 `navigate`，页面不刷新），
 * 只在挂载时读一次 `userRole`，「从登录页进来」的学生在本会话里永远拿不到锁定态。
 *
 * 职责四件事：① 学生 + 壳 → 取或建会话；② 把锁定态推给主进程；
 * ③ 每 10 秒轮询（兼心跳）并处理 `unlock`；④ 到点自动解除。
 * 剩余时间 pill 的渲染也在这里——只有它有 `locked` 与倒计时。
 */
export default function LearningSessionShell() {
  const location = useLocation();
  const [lock, setLock] = useState<LockState | null>(initialLockState);
  /**
   * 「角色 + 会话是否已判定」。判定完成前**不推**锁定态（见下面 effect ②），
   * 否则挂载瞬间会先推 `false` 再推 `true`，窗口闪一次普通态。
   */
  const [resolved, setResolved] = useState(false);
  const [nowMs, setNowMs] = useState(() => Date.now());

  // ① 角色闸门 + 建立会话。**只做判定，不直接推锁定态**（推的动作留给 effect ②）。
  useEffect(() => {
    if (!isDesktopShell()) return;
    if (localStorage.getItem('userRole') !== 'student') {
      // 家长/管理员登入（或学生已登出）：壳必须回到普通窗口，否则家长也用不了这台机器。
      setResolved(true);
      return;
    }
    if (readPersistedSession() !== null) {
      setResolved(true); // 已有本地会话 → 交给轮询对账，不重复建
      return;
    }

    let cancelled = false;
    openStudentLearningSession()
      .then((session) => {
        if (cancelled) return;
        writePersistedSession({
          studentId: Number(localStorage.getItem('userId')),
          id: session.id,
          lockExpiresAt: session.lockExpiresAt,
          unlockedAt: session.unlockedAt,
        });
        setLock({
          id: session.id,
          lockExpiresAt: session.lockExpiresAt,
          unlockedAt: session.unlockedAt,
        });
        setResolved(true);
      })
      .catch(() => {
        // 建会话失败**不阻断学习**：退化为「未锁」。管控失效好过学生进不去。
        if (!cancelled) setResolved(true);
      });
    return () => {
      cancelled = true;
    };
  }, [location.pathname]);

  const locked = lock !== null && computeLocked(lock, nowMs);

  // ② 锁定态 → Electron 主进程（**唯一出口**）。`resolved` 之前不推，避免先解锁再锁回去。
  useEffect(() => {
    if (!isDesktopShell() || !resolved) return;
    setDesktopLocked(locked);
  }, [locked, resolved]);

  // ③ 轮询（兼心跳）。依赖**会话 id**（而非整个 lock）：换会话才换轮询，
  // 否则每次轮询 setLock 都会重建 interval。取出 `lockId` 是为了让依赖数组显式且无 warning。
  const lockId = lock?.id ?? null;
  useEffect(() => {
    if (!isDesktopShell() || lockId === null) return;
    const poll = () => {
      pollStudentDeviceCommands()
        .then((res) => {
          // 服务端是锁定态的**唯一真源**：家长在别处解除时，这里带回的 unlockedAt 非空。
          if (res.lock) {
            setLock((prev) => {
              if (prev === null || prev.id !== res.lock!.sessionId) return prev;
              const next: LockState = {
                id: prev.id,
                lockExpiresAt: res.lock!.lockExpiresAt,
                unlockedAt: res.lock!.unlockedAt,
              };
              const studentId = Number(localStorage.getItem('userId'));
              if (Number.isFinite(studentId)) {
                writePersistedSession({ studentId, ...next });
              }
              return next;
            });
          }
        })
        .catch(() => {
          // 轮询失败**绝不清锁**：拔网线不解锁（spec §8 局限 3）。本地截止时间继续生效。
        });
    };
    poll();
    const timer = window.setInterval(poll, LEARNING_SESSION_POLL_MS);
    return () => window.clearInterval(timer);
  }, [lockId]);

  // ④ 锁定时每秒对表（驱动 pill 与到点解除）；不锁就不起定时器。
  useEffect(() => {
    if (!locked) return;
    const timer = window.setInterval(() => setNowMs(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [locked]);

  return (
    <>
      {locked && lock?.lockExpiresAt && (
        <LockedPill remainingMs={remainingMs(lock.lockExpiresAt, nowMs)} />
      )}
      <Outlet />
    </>
  );
}
```

- [ ] **Step 4: 跑测试**

Run: `cd apps/web && npx vitest run src/kiosk/LearningSessionShell.test.tsx`
Expected: PASS。

- [ ] **Step 5: 挂载**

`apps/web/src/routes/index.tsx` 改为（**嵌套两个 pathless wrapper**，不碰 `routeTable.tsx`——它的测试用 `createMemoryRouter(routes)` 挂真实表，往里加组件会破坏「纯配置」约束）：

```tsx
import { createBrowserRouter, RouterProvider } from 'react-router-dom';
import { routes } from './routeTable';
import AnalyticsShell from '../analytics/AnalyticsShell';
import LearningSessionShell from '../kiosk/LearningSessionShell';

/**
 * 路由引导：真正的路由表在 `./routeTable`（单独成文件是为了让路由级测试能用
 * `createMemoryRouter(routes)` 直接挂载真实表；本文件只保留浏览器 router 单例）。
 *
 * 两个 **pathless wrapper**（无 `path`、渲染 `<Outlet/>`）依次包在真实路由表外面。
 * 两者都必须在**这里**、而不是 `App.tsx`——后者在 `RouterProvider` 之外，拿不到 `useLocation`，
 * 而两者的角色闸门都依赖路由变化才能捕获「不刷新页面」的登录/登出。
 * 顺序无要求（都只读 localStorage），但别合并成一个组件：埋点与学习管控是两件事。
 */
const router = createBrowserRouter([
  {
    element: <AnalyticsShell />,
    children: [{ element: <LearningSessionShell />, children: routes }],
  },
]);

export function AppRouter() {
  return <RouterProvider router={router} />;
}
```

- [ ] **Step 6: 跑全量前端测试 + 类型检查 + lint**

Run: `cd apps/web && npm test && npx tsc -b && npm run lint`
Expected: 全绿、无输出、0 error。**若 `routeTable.test.tsx` 因嵌套包装器报错，说明它没有用 `createMemoryRouter(routes)` 而是渲染了整个 router** —— 修测试（本仓铁律），不要为了迁就测试改动 `routeTable.tsx`。

- [ ] **Step 7: Commit**

```bash
git add apps/web/src/kiosk/ apps/web/src/routes/index.tsx
git commit -m "feat(kiosk): LearningSessionShell 三态状态机（建会话/推锁定/轮询/到点解除）+ 挂载"
```

---

## Task 6: `LogoutButton` 锁定中拒绝登出

**Files:**
- Modify: `apps/web/src/components/base/LogoutButton.tsx`
- Create: `apps/web/src/components/base/LogoutButton.test.tsx`（此前**不存在**，本仓只有「断言存在」的间接覆盖）
- Test: `apps/web/src/components/base/LogoutButton.test.tsx`

**Interfaces:**
- Consumes: `isCurrentStudentLocked`（Task 2）、`releaseOnLogout`（Task 3）
- Produces: 无新导出（行为变更 + `data-locked` 属性）

- [ ] **Step 1: 写失败的测试**

创建 `apps/web/src/components/base/LogoutButton.test.tsx`：

```tsx
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { LogoutButton, toast } from '@/components/base';
import { writePersistedSession } from '@/kiosk/learningLock';

vi.mock('@/components/base/Toast', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/components/base/Toast')>();
  return { ...actual, toast: vi.fn() };
});

vi.mock('@/services/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/services/api')>();
  return { ...actual, endStudentLearningSession: vi.fn() };
});

const toastMock = vi.mocked(toast);
const endMock = vi.mocked(endStudentLearningSession);
const LATER = new Date(Date.now() + 60 * 60_000).toISOString();

function renderButton() {
  return render(
    <MemoryRouter initialEntries={['/student/course-detail']}>
      <Routes>
        <Route path="/student/course-detail" element={<LogoutButton />} />
        <Route path="/login" element={<div>登录页</div>} />
      </Routes>
    </MemoryRouter>,
  );
}

function seedSession(studentId: number, opts: { lockExpiresAt: string | null; unlockedAt: string | null }) {
  localStorage.setItem('userId', String(studentId));
  writePersistedSession({ studentId, id: 7, ...opts });
}

beforeEach(() => {
  localStorage.clear();
  localStorage.setItem('token', 'jwt');
  localStorage.setItem('username', '小明');
  localStorage.setItem('userRole', 'student');
  localStorage.setItem('userId', '9');
  toastMock.mockReset();
  // 每次重新武装：`afterEach` 的 restoreAllMocks 会抹掉模块 mock 的实现，
  // 而 `vi.mock` 工厂只跑一次（模块被缓存），不重设就会让 `endStudentLearningSession`
  // 返回 undefined → `releaseOnLogout` 里的 `.catch` 抛错 → 登出被自己的收尾逻辑打断。
  endMock.mockReset();
  endMock.mockResolvedValue({ id: 7, endedAt: '2026-09-23T02:00:00.000Z' });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  localStorage.clear();
});

describe('LogoutButton：未锁定', () => {
  it('清掉四个鉴权键并跳到登录页', () => {
    renderButton();
    fireEvent.click(screen.getByLabelText('退出登录'));

    expect(localStorage.getItem('token')).toBeNull();
    expect(localStorage.getItem('userId')).toBeNull();
    expect(localStorage.getItem('username')).toBeNull();
    expect(localStorage.getItem('userRole')).toBeNull();
    expect(screen.getByText('登录页')).toBeInTheDocument();
  });

  it('没有本地会话时也能正常登出（家长/管理员/普通浏览器）', () => {
    localStorage.setItem('userRole', 'parent');
    renderButton();
    fireEvent.click(screen.getByLabelText('退出登录'));
    expect(screen.getByText('登录页')).toBeInTheDocument();
  });
});

describe('LogoutButton：锁定中', () => {
  it('**拒绝登出**：token 仍在、没有跳转', () => {
    seedSession(9, { lockExpiresAt: LATER, unlockedAt: null });
    renderButton();
    fireEvent.click(screen.getByLabelText('退出登录'));

    expect(localStorage.getItem('token')).toBe('jwt');
    expect(screen.queryByText('登录页')).not.toBeInTheDocument();
  });

  it('给出**可解释**的拒绝理由（toast），而不是静默失效', () => {
    seedSession(9, { lockExpiresAt: LATER, unlockedAt: null });
    renderButton();
    fireEvent.click(screen.getByLabelText('退出登录'));

    expect(toastMock).toHaveBeenCalledWith('info', '本次学习时长未满，需家长解除后才能退出');
  });

  it('标记为 aria-disabled，但**保留 aria-label**（4 个现有测试靠它断言存在）', () => {
    seedSession(9, { lockExpiresAt: LATER, unlockedAt: null });
    renderButton();

    const button = screen.getByLabelText('退出登录');
    expect(button).toHaveAttribute('aria-disabled', 'true');
    expect(button).toHaveAttribute('data-locked', 'true');
    // 原生 disabled 会让 click 不触发 → toast 永远弹不出来，所以必须是 false
    expect(button).not.toBeDisabled();
  });

  it('家长已解除 → 可以正常登出', () => {
    seedSession(9, { lockExpiresAt: LATER, unlockedAt: '2026-09-23T01:20:00.000Z' });
    renderButton();
    fireEvent.click(screen.getByLabelText('退出登录'));
    expect(screen.getByText('登录页')).toBeInTheDocument();
  });

  it('**别的孩子**被锁不影响当前登录者（同设备换人）', () => {
    // 顺序要紧：`seedSession` 会把 `userId` 写成 `studentId`，所以必须先落「学生 9 的会话」，
    // 再把当前登录者改成学生 42。反过来写会被覆盖回 9，这条用例就退化成「本人被锁」。
    seedSession(9, { lockExpiresAt: LATER, unlockedAt: null });
    localStorage.setItem('userId', '42');
    renderButton();
    fireEvent.click(screen.getByLabelText('退出登录'));
    expect(screen.getByText('登录页')).toBeInTheDocument();
  });

  it('到期后自动可登出（不需要家长操作）', () => {
    seedSession(9, { lockExpiresAt: new Date(Date.now() - 1000).toISOString(), unlockedAt: null });
    renderButton();
    fireEvent.click(screen.getByLabelText('退出登录'));
    expect(screen.getByText('登录页')).toBeInTheDocument();
  });

  it('用户名药丸变体同样受管控', () => {
    seedSession(9, { lockExpiresAt: LATER, unlockedAt: null });
    render(
      <MemoryRouter initialEntries={['/student/course-detail']}>
        <Routes>
          <Route path="/student/course-detail" element={<LogoutButton username="小明" />} />
          <Route path="/login" element={<div>登录页</div>} />
        </Routes>
      </MemoryRouter>,
    );
    fireEvent.click(screen.getByLabelText('退出登录'));
    expect(localStorage.getItem('token')).toBe('jwt');
    expect(toastMock).toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd apps/web && npx vitest run src/components/base/LogoutButton.test.tsx`
Expected: FAIL —— 锁定中的用例失败（当前会照常登出）。

- [ ] **Step 3: 实现**

把 `apps/web/src/components/base/LogoutButton.tsx` 的上半部分（imports + 组件签名 + `handleLogout`）改为：

```tsx
import { ButtonHTMLAttributes, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import clsx from 'clsx';
import { isCurrentStudentLocked } from '@/kiosk/learningLock';
import { releaseOnLogout } from '@/kiosk/desktopBridge';
import { toast } from './Toast';

interface LogoutButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  /** Button label, used for title + aria-label. Default "退出登录" */
  label?: string;
  /** Extra cleanup before clearing auth (e.g. reset in-memory stores) */
  onLogout?: () => void;
  /** When provided, renders as a user-info pill (avatar + name + logout icon) instead of the icon-only circle. */
  username?: string;
  /** Avatar initial; falls back to username[0]. */
  initial?: string;
}

const LOCKED_HINT = '本次学习时长未满，需家长解除后才能退出';
```

组件体：

```tsx
export function LogoutButton({
  label = '退出登录',
  onLogout,
  username,
  initial,
  className,
  ...rest
}: LogoutButtonProps) {
  const navigate = useNavigate();
  const [locked, setLocked] = useState(() => isCurrentStudentLocked());

  /**
   * 锁定态会随时间变化（到点自动解除），所以每秒对一次表——**只在锁定时起定时器**，
   * 平时零开销。不依赖 `LearningSessionShell` 的原因是：本组件也被家长/管理员页面使用，
   * 那些页面上那个壳根本不参与。
   */
  useEffect(() => {
    if (!locked) return;
    const timer = window.setInterval(() => setLocked(isCurrentStudentLocked()), 1000);
    return () => window.clearInterval(timer);
  }, [locked]);

  const handleLogout = () => {
    // 再判一次，不只是信 state：距上次 tick 最多差 1 秒，而这里才是**真正的闸门**。
    if (isCurrentStudentLocked()) {
      setLocked(true);
      toast('info', LOCKED_HINT);
      return;
    }
    releaseOnLogout();
    onLogout?.();
    localStorage.removeItem('token');
    localStorage.removeItem('userId');
    localStorage.removeItem('username');
    localStorage.removeItem('userRole');
    navigate('/login');
  };

  /**
   * 锁定中的公共属性。
   *
   * ⚠️ 三条**都不能改**：
   * 1. `aria-label` / `title` 仍是 `label`（='退出登录'）——4 个现有测试用
   *    `getByLabelText('退出登录')` 断言存在，改成提示文案会连带打破它们；提示走 toast。
   * 2. **不给原生 `disabled`**：原生禁用按钮不触发 click，toast 就永远弹不出来。
   *    真正的闸门是 `handleLogout` 里的判断，不是属性。
   * 3. `data-locked` 供测试与样式选择。
   */
  const lockProps = locked
    ? ({ 'aria-disabled': true, 'data-locked': 'true' } as const)
    : ({} as const);
  const lockClass = locked ? 'opacity-50 cursor-not-allowed' : undefined;
```

两个 return 分支（药丸变体与图标变体）分别在 `<button {...rest} …>` 里加 `{...lockProps}`，并在 `className={clsx(…)}` 的参数末尾加 `lockClass`。药丸变体：

```tsx
      <button
        {...rest}
        {...lockProps}
        type="button"
        onClick={handleLogout}
        title={label}
        aria-label={label}
        className={clsx(
          'group flex items-center gap-2 bg-white px-3 py-1.5 rounded-full border border-slate-200 shadow-sm',
          'hover:bg-slate-50 hover:border-slate-300 transition-colors',
          lockClass,
          className,
        )}
      >
```

图标变体：

```tsx
    <button
      {...rest}
      {...lockProps}
      type="button"
      onClick={handleLogout}
      title={label}
      aria-label={label}
      className={clsx(
        'p-2.5 rounded-full bg-white border border-slate-200 shadow-sm',
        'hover:bg-slate-50 transition-colors text-slate-600',
        lockClass,
        className,
      )}
    >
```

- [ ] **Step 4: 跑测试**

Run: `cd apps/web && npx vitest run src/components/base/LogoutButton.test.tsx`
Expected: PASS。

- [ ] **Step 5: 跑全量前端测试（确认没打破那 4 个「断言存在」的用例）**

Run: `cd apps/web && npm test`
Expected: 全绿。重点是 `routeTable.test.tsx`、`ParentAccountPage.test.tsx`、`AuxiliaryHomePage.test.tsx`、`EntrySelectPage.test.tsx`、`CourseDetailPage.test.tsx`、`UserBadge.test.tsx` 仍通过。

Run: `cd apps/web && npx tsc -b && npm run lint`
Expected: 无输出、0 error。

- [ ] **Step 6: Commit**

```bash
git add apps/web/src/components/base/LogoutButton.tsx apps/web/src/components/base/LogoutButton.test.tsx
git commit -m "feat(logout): 锁定中拒绝登出（aria-disabled + toast 解释，保留 aria-label）"
```

---

## Task 7: `apps/desktop` Electron 壳

**Files:**
- Create: `apps/desktop/package.json`
- Create: `apps/desktop/main.js`
- Create: `apps/desktop/preload.js`
- Create: `apps/desktop/.gitignore`

**Interfaces:**
- Consumes: `window.k12Desktop.setLocked(boolean)` 契约（Task 3 的 `K12DesktopBridge`）
- Produces: 可 `npm start` 运行的 dev 壳

- [ ] **Step 1: 建 `package.json` 并装 Electron**

创建 `apps/desktop/package.json`：

```json
{
  "name": "k12-desktop",
  "private": true,
  "version": "0.1.0",
  "description": "K12 智学 PC App（Electron 壳，dev 模式；本期不出安装包）",
  "main": "main.js",
  "scripts": {
    "start": "electron ."
  }
}
```

Run:
```bash
cd apps/desktop && npm install --save-dev electron
```
Expected: 装成功。**记下实际装到的版本**（写进本任务 Step 5 的提交信息）；不要手写一个猜的版本号。

- [ ] **Step 2: 写 `preload.js`**

```js
const { contextBridge, ipcRenderer } = require('electron');

/**
 * 渲染层与主进程之间**唯一**的通道（spec §6.1）。
 *
 * 只暴露两个东西，且都是单向/只读的：
 *   - `setLocked`：渲染层 → 主进程，驱动 kiosk 开关。渲染层是唯一发起方。
 *   - `isDesktop`：能力探测，渲染层据此决定是否启用整套锁定（浏览器里没有这个对象）。
 *
 * **不要**在这里加 `require`/`fs`/`ipcRenderer.invoke` 之类的口子：渲染层加载的是
 * 远端页面（云端时是公网），暴露 Node 能力等于把整台机器交出去。
 */
contextBridge.exposeInMainWorld('k12Desktop', {
  setLocked: (locked) => ipcRenderer.send('kiosk:set-locked', Boolean(locked)),
  isDesktop: true,
});
```

- [ ] **Step 3: 写 `main.js`**

```js
const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('node:path');

/**
 * K12 智学 PC App —— Electron 壳（spec `2026-09-23-pc-app-study-lockdown-design.md` §6.1）。
 *
 * 本壳**不做任何业务**：它加载与 Web App **完全相同**的 UI，只负责三件事：
 *   1. 学生登录时进真全屏 kiosk（由渲染层经 preload 驱动，本文件不判断角色）；
 *   2. 锁定期间关不掉窗口（拦 close / before-quit / minimize）；
 *   3. 封堵应用内逃逸（外链、跨源导航）。
 *
 * **能力边界（有意写在这里，别当成缺陷去"修"）**：Electron 拦不住 Alt+Tab / Cmd+Tab /
 * Ctrl+Alt+Del / 强制退出——那是系统级，任何应用都做不到。`blur` 抢回只是尽力而为。
 * 真·无法切屏要靠装机时的 OS 级单应用模式（Windows Assigned Access / macOS Single App Mode），
 * 属运维配置，不是代码（spec §8 局限 1）。
 */

/** 锁定态由渲染层上报。false = 家长/管理员在用，或学生未被锁定 → 窗口应像普通应用一样可用。 */
let locked = false;
let win = null;

/**
 * 壳加载的 Web 地址。本期默认本地 vite dev（`http://localhost:5173`——它已在服务端
 * CORS 白名单里，故本期零 CORS 改动）。
 *
 * `K12_WEB_URL` 就是**云端接缝**：下一期把后端部署到公网后改这个环境变量即可，
 * 不需要改代码。云端接入所需的 CORS / HTTPS / 持久化存储**不在本期范围**。
 */
const WEB_URL = process.env.K12_WEB_URL || 'http://localhost:5173';

/** 同源判定：只放行壳自己的地址，其余一律拦。 */
function isSameOrigin(url) {
  try {
    return new URL(url).origin === new URL(WEB_URL).origin;
  } catch {
    return false;
  }
}

function createWindow() {
  win = new BrowserWindow({
    width: 1440,
    height: 900,
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  win.loadURL(WEB_URL);

  // 拦外链：AI 回复的 markdown 会渲染 target="_blank"（AdminChatPage / AuxChatPanel），
  // 不拦就是「大模型吐个链接 → 学生点进浏览器」。
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', (event, url) => {
    if (!isSameOrigin(url)) event.preventDefault();
  });

  // 锁定期间关不掉 / 最小化不了。家长/管理员登录时 locked=false，窗口完全正常。
  win.on('close', (event) => {
    if (locked) event.preventDefault();
  });
  win.on('minimize', (event) => {
    if (locked) event.preventDefault();
  });

  // 失焦抢回：**尽力而为**。刻意**不加** setAlwaysOnTop——那会盖住 UAC / 系统安全对话框，
  // 风险大于收益。macOS 上后台抢占受 OS 限制，抢不回来是已知限制（spec §8 局限 1）。
  win.on('blur', () => {
    if (locked && win && !win.isDestroyed()) win.focus();
  });

  win.on('closed', () => {
    win = null;
  });
}

// 拦 before-quit：否则 Cmd+Q / Alt+F4 能绕过上面那个 close 拦截。
app.on('before-quit', (event) => {
  if (locked) event.preventDefault();
});

app.whenReady().then(() => {
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

// 渲染层 → 主进程：锁定开关。`setKiosk` 是真全屏 + 锁定（比 fullscreen 更彻底）。
ipcMain.on('kiosk:set-locked', (_event, next) => {
  locked = Boolean(next);
  if (!win || win.isDestroyed()) return;
  win.setKiosk(locked);
  win.setClosable(!locked);
  // setMinimizable 在 macOS 上是 no-op；Windows/Linux 上有效。不是错误，别加平台分支。
  win.setMinimizable(!locked);
});
```

- [ ] **Step 4: 写 `.gitignore`**

```
node_modules/
```

- [ ] **Step 5: 跑起来（三进程 dev 拓扑）**

依次起三个进程：

```bash
# 终端 1 —— 后端（必须用 dist，`npx tsx src/main.ts` 的 DI 是坏的）
cd apps/server && npm run build && node dist/main.js

# 终端 2 —— 前端 dev server
cd apps/web && npm run dev

# 终端 3 —— 壳
cd apps/desktop && npm start
```

Expected: 弹出一个 1440×900 的窗口，加载出登录页（与浏览器里一模一样）。此时**不是**全屏 kiosk（还没登录）。

- [ ] **Step 6: Commit**

```bash
git add apps/desktop/package.json apps/desktop/package-lock.json apps/desktop/main.js apps/desktop/preload.js apps/desktop/.gitignore
git commit -m "feat(desktop): Electron 壳（kiosk / 拦关闭 / 拦逃逸导航 / K12_WEB_URL 云端接缝）"
```

---

## Task 8: 人工冒烟（逐条勾选，不通过不算完成）

**Files:** 无（纯验证）。**壳层与真全屏无法单测**，这一份清单就是它们的验收证据。

- [ ] **Step 1: 准备两个账号**

用管理员在家长端建一个学生；在家长端 `/parent/controls` 把「单次学习锁定」设成 **2 分钟**并保存（该页面在计划 3 才做；**若计划 3 未完成**，直接用 SQL 设置：`UPDATE controls SET session_lock_minutes = 2 WHERE student_id = <id>;`）。

- [ ] **Step 2: 逐条冒烟**

| # | 操作 | 期望 |
|---|---|---|
| 1 | 壳里用学生账号登录 | 窗口变**真全屏**（无标题栏、无菜单栏），左侧顶栏无浏览器痕迹 |
| 2 | 全屏下按 `Cmd/Ctrl+W`、点窗口关闭 | **关不掉**（窗口不消失） |
| 3 | 按 `Cmd/Ctrl+Q` | **退不出**（进程仍在） |
| 4 | 顶部是否有「剩余 N 分钟 · 本次学习时长未满」pill | 有，且**不与本页顶栏重叠**（重叠就调 `LockedPill.tsx` 的定位） |
| 5 | 点右上角「退出登录」 | **不跳转**，弹 toast「本次学习时长未满，需家长解除后才能退出」，`token` 仍在 |
| 6 | 切到别的应用再回来（`Alt+Tab` / `Cmd+Tab`） | 窗口**会被抢回前台**（能切换过去几秒是已知限制，不算失败） |
| 7 | 等 2 分钟到点 | pill **自动消失**，此时点「退出登录」→ **能正常登出**，窗口恢复普通尺寸 |
| 8 | 家长端点「解除锁定」（或在别处 `POST .../device-commands`） | 学生端 **≤10 秒**内 pill 消失、可登出 |
| 9 | 在 AI 辅线对话里让模型给出一个 http 链接，点它 | **不跳转**（外链被壳拦掉） |
| 10 | 学生登录后**杀进程**（用活动监视器/任务管理器），重新 `npm start` | **回到锁定**，且剩余时间**没有重置**（不是重新 2 分钟） |
| 11 | 学生登录后**断网**（关 Wi-Fi） | pill **照常倒计时**，仍不能登出；恢复网络后功能正常 |
| 12 | 学生登出后，用**家长账号**登录同一个壳 | 窗口**不是 kiosk**（可关、可最小化），能正常用 |
| 13 | 家长端「进出时间」列表 | 每次进出都有记录，时间与操作**对得上**；在线时是「进行中」 |
| 14 | 把锁定设成 `NULL`（解除设置）后学生重新登录 | 全屏但**可以随时登出**（无 pill） |

- [ ] **Step 3: 记录结果**

把未通过的条目、实际现象、以及**是否为设计缺口**（区别于实现失误）写进计划 3 的文档同步里（`docs/ai-core-changelog.md` 的一次条目）。若发现设计缺口，**先改 spec 再改代码**（本仓纪律：设计定了再改）。

- [ ] **Step 4: Commit（若有修正）**

```bash
git add -A
git commit -m "fix(desktop): 人工冒烟第 N 条 — <现象>"
```

---

## 计划自检（写完后的核对结果）

**spec 覆盖**

| spec 章节 | 落在哪个任务 |
|---|---|
| §6.1 Electron 壳（kiosk / 拦关闭 / 拦导航 / 失焦抢回 / DevTools） | Task 7（DevTools 见下） |
| §6.2 `LearningSessionShell` 三态状态机 + 本地持久化 + 轮询 | Task 2、3、5 |
| §6.3 禁退三处 | `LogoutButton` = Task 6；壳拦关闭 = Task 7；外链 = Task 7 |
| §6.4 剩余时间 pill | Task 4、5 |
| §6.5 家长端 UI | **计划 3** |
| §8 局限 1/2/3 的验证 | Task 8（第 6、10、11 条） |
| §8 局限 7「DevTools 禁用只在生产构建生效」 | **本期不做**（不出包），spec 已列非目标 |

**类型一致性**：`PersistedLearningSession`（Task 2）→ `LockState`（Task 5）是**两个类型**，前者是持久化形状（含 `studentId`），后者是内存形状（不含）。Task 5 在 `setLock` 里显式构造 `LockState`，**不要**直接把 `PersistedLearningSession` 当 `LockState` 用（多一个 `studentId` 字段会让 `writePersistedSession({studentId, ...next})` 静默带上两个同名键）。

**已知风险**
1. `LearningSessionShell` 的 `useEffect(..., [lock?.id])` 依赖项用了可选链——ESLint 的 `exhaustive-deps` 可能报警。若报警，改为在 effect 内取 `const sessionId = lock?.id` 再作为依赖，**不要**图省事把依赖写成 `[]`（会让换会话后停止轮询）。
2. `LockedPill` 的定位可能与沉浸页顶栏重叠（Task 8 第 4 条专门验它）。
3. 任务依赖：Task 5 必须在 Task 1–4 之后；Task 6 依赖 Task 2、3；Task 7 依赖 Task 3 的桥契约；Task 8 最后。
