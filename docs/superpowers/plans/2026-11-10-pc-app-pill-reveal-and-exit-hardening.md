# PC App：剩余时长胶囊浮层 + 壳退出加固 — 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use subagent-driven-development (recommended) or executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让锁定剩余时长胶囊只在浅停留三页按需出现、永不遮挡 tab；并让被强制关闭的 App 可观测、可自愈、能被 launchd 拉回 kiosk。

**Architecture:** 胶囊的锁定状态由 `LearningSessionShell` 经 React Context 下发，`StudentStayLayout` 内的新组件负责"自动显示 3 秒 / 顶边悬停 / 点击 5 秒"；壳侧新增 `exit-audit`（异常结束判定 + 退出日志）、`watchdog`（launchd 托管的看护脚本，只在学生模式下拉起 App）两个纯 Node 模块，`main.js` 只做接线。

**Tech Stack:** React 18 + React Router 6 + Zustand（Web）；Electron 44 + Node（壳）；Vitest + @testing-library/react。

**Spec:** `docs/superpowers/specs/2026-11-10-pc-app-pill-reveal-and-exit-hardening-design.md`

## Global Constraints

- `@testing-library/react` 的 `globals: false`：多用例文件必须自己写 `afterEach(() => cleanup())`。
- 组件改动必须补渲染测试；测试断言与设计冲突时**改测试**，不改设计。
- UI 不用 emoji；颜色一律走 CSS 变量 token。
- 壳的 `lib/*.js` 新增/改名必须同步 `apps/desktop/scripts/verify-asar.js` 的 `REQUIRED`。
- 壳内写入（日志/状态/plist）失败**只 warn 或静默，绝不抛**，不能阻断启动或答题。
- 关窗/退出/最小化拦截、kiosk 重进逻辑**本次一行不改**（只加日志与恢复，不碰判定）。
- 命令一律在对应子目录执行：Web = `apps/web`，壳 = `apps/desktop`。

---

### Task 1: `LockedPill` 改为受控浮层

**Files:**
- Modify: `apps/web/src/kiosk/LockedPill.tsx`
- Test: `apps/web/src/kiosk/LockedPill.test.tsx`

**Interfaces:**
- Consumes: `formatRemaining(ms: number): string`（`learningLock.ts`，已存在）
- Produces: `LockedPill({ remainingMs, visible }: { remainingMs: number; visible: boolean })`

- [ ] **Step 1: 写失败测试（改现有 3 条 + 新增 2 条）**

把 `LockedPill.test.tsx` 全文替换为：

```tsx
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { LockedPill } from './LockedPill';

afterEach(() => cleanup());

describe('LockedPill', () => {
  it('渲染剩余分钟数', () => {
    render(<LockedPill remainingMs={42 * 60_000} visible />);
    expect(screen.getByTestId('locked-pill')).toHaveTextContent('剩余 42 分钟');
  });

  it('不足一分钟时也给文案，不显示 0 或负数', () => {
    render(<LockedPill remainingMs={5_000} visible />);
    expect(screen.getByTestId('locked-pill')).toHaveTextContent('剩余不足 1 分钟');
    expect(screen.getByTestId('locked-pill')).not.toHaveTextContent('-');
  });

  it('说明这是家长设定的时长，避免学生以为是卡顿', () => {
    render(<LockedPill remainingMs={30 * 60_000} visible />);
    expect(screen.getByTestId('locked-pill')).toHaveTextContent('本次学习时长未满');
  });

  it('收起时视觉隐藏但不占点击（data-visible=false + pointer-events-none）', () => {
    render(<LockedPill remainingMs={30 * 60_000} visible={false} />);
    const pill = screen.getByTestId('locked-pill');
    expect(pill).toHaveAttribute('data-visible', 'false');
    expect(pill.className).toContain('opacity-0');
    expect(pill.className).toContain('pointer-events-none');
  });

  it('显示时位于顶栏下方（top-[72px] = 64px 顶栏 + 8px）', () => {
    render(<LockedPill remainingMs={30 * 60_000} visible />);
    expect(screen.getByTestId('locked-pill').className).toContain('top-[72px]');
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd apps/web && npx vitest run src/kiosk/LockedPill.test.tsx`
Expected: FAIL —— `visible` 不是已知属性 / `data-visible` 不存在。

- [ ] **Step 3: 最小实现**

把 `apps/web/src/kiosk/LockedPill.tsx` 全文替换为（**旧注释整段删除**，见 spec §7）：

```tsx
import { formatRemaining } from './learningLock';

/**
 * 锁定中的剩余时间提示（spec 2026-11-10 §2）。
 *
 * **不再常驻**：由 `LockedPillReveal` 控制可见性（进入浅停留页 3 秒 / 顶边悬停 / 点击 5 秒）。
 * 放在**顶栏下方 8px**（`top-[72px]`）：顶栏高 64px，胶囊若贴 `top-3` 会整块压住
 * 个人中心/奖励册/练习记录三个 tab（2026-11-10 用户实测，学生点不到练习记录）。
 * `pointer-events-none` 是硬要求：它只是展示，任何点击都要落到下面。
 */
export function LockedPill({ remainingMs, visible }: { remainingMs: number; visible: boolean }) {
  return (
    <div
      data-testid="locked-pill"
      data-visible={visible ? 'true' : 'false'}
      role="status"
      aria-live="polite"
      aria-hidden={!visible}
      className={`fixed left-1/2 top-[72px] z-40 -translate-x-1/2 rounded-full border border-[var(--brand-500)] bg-[var(--brand-100)] px-4 py-1.5 text-sm font-medium text-[var(--brand-600)] shadow-sm pointer-events-none transition-opacity duration-200 ${
        visible ? 'opacity-100' : 'opacity-0'
      }`}
    >
      {formatRemaining(remainingMs)} · 本次学习时长未满，需家长解除后才能退出
    </div>
  );
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `cd apps/web && npx vitest run src/kiosk/LockedPill.test.tsx`
Expected: PASS（5 passed）。

- [ ] **Step 5: 提交**

```bash
git add apps/web/src/kiosk/LockedPill.tsx apps/web/src/kiosk/LockedPill.test.tsx
git commit -m "feat(web): 剩余时长胶囊改为受控浮层，落在顶栏下方"
```

---

### Task 2: 锁定状态改用 Context 下发

**Files:**
- Create: `apps/web/src/kiosk/learningLockContext.ts`
- Modify: `apps/web/src/kiosk/LearningSessionShell.tsx`
- Test: `apps/web/src/kiosk/LearningSessionShell.test.tsx`

**Interfaces:**
- Produces:
  - `LearningLockValue = { locked: boolean; remainingMs: number }`
  - `LearningLockContext: React.Context<LearningLockValue | null>`
  - `useLearningLock(): LearningLockValue | null`
- Consumes（Task 3/4 会用到）: 上面三个符号。

- [ ] **Step 1: 新建 context 文件**

`apps/web/src/kiosk/learningLockContext.ts`：

```ts
import { createContext, useContext } from 'react';

/**
 * 学习锁定态的唯一真源在 `LearningSessionShell`（轮询 + 本地快照都在那里）。
 * 只有浅停留页需要"剩余时间"展示，所以用 context 下发，**不要**在页面里再读一次
 * localStorage —— 那会出现第二份真源，切换学生/解锁时必然漂移。
 */
export interface LearningLockValue {
  locked: boolean;
  /** 剩余毫秒（已由 provider 每秒刷新）。 */
  remainingMs: number;
}

export const LearningLockContext = createContext<LearningLockValue | null>(null);

export function useLearningLock(): LearningLockValue | null {
  return useContext(LearningLockContext);
}
```

- [ ] **Step 2: 写失败测试（把 4 条 pill 断言改为 probe 断言）**

在 `LearningSessionShell.test.tsx` 里：

1. 顶部 import 加一行：

```tsx
import { useLearningLock } from './learningLockContext';
```

2. 新增 probe 组件（放在 `NavProbe` 下方）：

```tsx
/** 把 context 值渲染成文本：pill 已移出本组件，这里断言"状态有没有下发对"。 */
function LockProbe() {
  const lock = useLearningLock();
  return (
    <div data-testid="lock-probe">
      {lock ? `locked:${lock.locked}:${Math.round(lock.remainingMs / 60_000)}` : 'none'}
    </div>
  );
}
```

3. 把 `renderShell` 的学习页元素改为：

```tsx
<Route path="/student/course-detail" element={<><LockProbe /><div>学习页</div></>} />
```

4. 「**未设锁（lockExpiresAt=null）→ 仍然是 kiosk 全屏**」这条用例的末尾，把
   `expect(screen.queryByTestId('locked-pill')).not.toBeInTheDocument();` 改为：

```tsx
    expect(screen.getByTestId('lock-probe')).toHaveTextContent('none');
```

5. 「到点自动解除」那条的同名断言改为：

```tsx
    expect(screen.getByTestId('lock-probe')).toHaveTextContent('none');
```

6. 「锁定中渲染剩余时间 pill；解锁后消失」整条替换为：

```tsx
  it('锁定中下发 locked=true 与剩余分钟；解锁后归零', async () => {
    vi.useFakeTimers();
    renderShell();
    await act(async () => { await Promise.resolve(); });
    expect(screen.getByTestId('lock-probe')).toHaveTextContent('locked:true:60');

    await act(async () => { vi.advanceTimersByTime(61 * 60_000); });
    expect(screen.getByTestId('lock-probe')).toHaveTextContent('none');
  });
```

7. 「未锁定时不渲染 pill」那条改为：

```tsx
  it('未锁定时不下发锁定态', async () => {
    openMock.mockResolvedValue({
      id: 7,
      startedAt: '2026-09-23T01:00:00.000Z',
      lockMinutes: null,
      lockExpiresAt: null,
      unlockedAt: null,
    });
    renderShell();
    await act(async () => { await Promise.resolve(); });

    expect(screen.getByTestId('lock-probe')).toHaveTextContent('none');
  });
```

- [ ] **Step 3: 跑测试确认失败**

Run: `cd apps/web && npx vitest run src/kiosk/LearningSessionShell.test.tsx`
Expected: FAIL —— `useLearningLock` 是 `null`（provider 还没接），probe 恒为 `none`。

- [ ] **Step 4: 改 `LearningSessionShell`**

`apps/web/src/kiosk/LearningSessionShell.tsx`：

1. 删除 `import { LockedPill } from './LockedPill';`，新增：

```tsx
import { LearningLockContext } from './learningLockContext';
```

2. 在 `const locked = lock !== null && computeLocked(lock, nowMs);` 之后加：

```tsx
  /**
   * 下发给浅停留页的锁定态。**加 `isDesktopShell()` 闸门**：浏览器里即使本地躺着
   * 上一台设备的锁定快照，也不该显示"需家长解除"（那是壳的语义）。
   */
  const lockValue =
    isDesktopShell() && locked && lock?.lockExpiresAt
      ? { locked: true, remainingMs: remainingMs(lock.lockExpiresAt, nowMs) }
      : null;
```

3. 把末尾 `return` 整段替换为：

```tsx
  return (
    <LearningLockContext.Provider value={lockValue}>
      <Outlet />
    </LearningLockContext.Provider>
  );
```

- [ ] **Step 5: 跑测试确认通过**

Run: `cd apps/web && npx vitest run src/kiosk/LearningSessionShell.test.tsx`
Expected: PASS。

- [ ] **Step 6: 提交**

```bash
git add apps/web/src/kiosk/learningLockContext.ts apps/web/src/kiosk/LearningSessionShell.tsx apps/web/src/kiosk/LearningSessionShell.test.tsx
git commit -m "refactor(web): 锁定状态下发改用 context"
```

---

### Task 3: `LockedPillReveal` 状态机（自动 3 秒 / 悬停 / 点击 5 秒）

**Files:**
- Create: `apps/web/src/kiosk/LockedPillReveal.tsx`
- Test: `apps/web/src/kiosk/LockedPillReveal.test.tsx`

**Interfaces:**
- Consumes: `useLearningLock()`（Task 2）、`LockedPill({remainingMs, visible})`（Task 1）
- Produces: `LockedPillReveal(): JSX.Element | null`，`data-testid="pill-reveal-zone"` 的识别区；
  导出常量 `AUTO_SHOW_MS = 3000`、`TAP_SHOW_MS = 5000`、`HOVER_HIDE_DELAY_MS = 200`

- [ ] **Step 1: 写失败测试**

`apps/web/src/kiosk/LockedPillReveal.test.tsx`：

```tsx
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { LockedPillReveal } from './LockedPillReveal';
import { LearningLockContext } from './learningLockContext';

afterEach(() => cleanup());
beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

function renderReveal(lock: { locked: boolean; remainingMs: number } | null) {
  return render(
    <LearningLockContext.Provider value={lock}>
      <LockedPillReveal />
    </LearningLockContext.Provider>,
  );
}

describe('LockedPillReveal', () => {
  it('进入页面即显示，3 秒后收起', () => {
    renderReveal({ locked: true, remainingMs: 42 * 60_000 });
    expect(screen.getByTestId('locked-pill')).toHaveAttribute('data-visible', 'true');

    act(() => { vi.advanceTimersByTime(3000); });
    expect(screen.getByTestId('locked-pill')).toHaveAttribute('data-visible', 'false');
  });

  it('悬停顶部识别区显示，移开 200ms 后收起（悬停期间到点也不收起）', () => {
    renderReveal({ locked: true, remainingMs: 42 * 60_000 });
    act(() => { vi.advanceTimersByTime(3000); }); // 先让自动显示结束

    const zone = screen.getByTestId('pill-reveal-zone');
    fireEvent.mouseEnter(zone);
    act(() => { vi.advanceTimersByTime(10_000); });
    expect(screen.getByTestId('locked-pill')).toHaveAttribute('data-visible', 'true');

    fireEvent.mouseLeave(zone);
    act(() => { vi.advanceTimersByTime(199); });
    expect(screen.getByTestId('locked-pill')).toHaveAttribute('data-visible', 'true');
    act(() => { vi.advanceTimersByTime(1); });
    expect(screen.getByTestId('locked-pill')).toHaveAttribute('data-visible', 'false');
  });

  it('点击识别区显示 5 秒后收起（触屏没有 hover 的等价路径）', () => {
    renderReveal({ locked: true, remainingMs: 42 * 60_000 });
    act(() => { vi.advanceTimersByTime(3000); });

    fireEvent.click(screen.getByTestId('pill-reveal-zone'));
    act(() => { vi.advanceTimersByTime(4999); });
    expect(screen.getByTestId('locked-pill')).toHaveAttribute('data-visible', 'true');
    act(() => { vi.advanceTimersByTime(1); });
    expect(screen.getByTestId('locked-pill')).toHaveAttribute('data-visible', 'false');
  });

  it('未锁定时识别区与胶囊都不渲染', () => {
    renderReveal(null);
    expect(screen.queryByTestId('pill-reveal-zone')).not.toBeInTheDocument();
    expect(screen.queryByTestId('locked-pill')).not.toBeInTheDocument();
  });

  it('锁定解除时立即收起', () => {
    const { rerender } = renderReveal({ locked: true, remainingMs: 42 * 60_000 });
    expect(screen.getByTestId('locked-pill')).toHaveAttribute('data-visible', 'true');

    rerender(
      <LearningLockContext.Provider value={null}>
        <LockedPillReveal />
      </LearningLockContext.Provider>,
    );
    expect(screen.queryByTestId('locked-pill')).not.toBeInTheDocument();
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd apps/web && npx vitest run src/kiosk/LockedPillReveal.test.tsx`
Expected: FAIL —— 模块不存在。

- [ ] **Step 3: 实现**

`apps/web/src/kiosk/LockedPillReveal.tsx`：

```tsx
import { useCallback, useEffect, useRef, useState } from 'react';
import { LockedPill } from './LockedPill';
import { useLearningLock } from './learningLockContext';

/** 进入浅停留页自动显示时长。 */
export const AUTO_SHOW_MS = 3000;
/** 点击/轻触识别区后的显示时长（触屏没有 hover）。 */
export const TAP_SHOW_MS = 5000;
/** 鼠标移出识别区后的收起延迟，防手抖。 */
export const HOVER_HIDE_DELAY_MS = 200;

/**
 * 剩余时长的"按需唤出"层（spec 2026-11-10 §2）。
 *
 * **为什么要藏**：胶囊以前是全局常驻、`top-3` 贴在顶栏里，正好压住个人中心的
 * 奖励册/个人中心/练习记录三个 tab，学生点不到练习记录（用户实测）。
 * 现在只在浅停留页出现，进入 3 秒 / 顶边悬停 / 点击 5 秒三种方式唤出。
 *
 * ⚠️ 识别区只覆盖窗口顶部 10px：顶栏里的 tab 从 20px 起、右上"退出本页"从 12px 起，
 * 都在它下面，不会被抢点击。改高度前先量这两个位置。
 */
export function LockedPillReveal() {
  const lock = useLearningLock();
  const [visible, setVisible] = useState(false);
  const hideTimer = useRef<number | null>(null);
  const hovering = useRef(false);

  const clearHide = useCallback(() => {
    if (hideTimer.current !== null) {
      window.clearTimeout(hideTimer.current);
      hideTimer.current = null;
    }
  }, []);

  const showFor = useCallback(
    (ms: number) => {
      clearHide();
      setVisible(true);
      hideTimer.current = window.setTimeout(() => {
        hideTimer.current = null;
        // 悬停期间不自动收：否则鼠标一直停在顶边，提示却每 3 秒闪一次。
        if (!hovering.current) setVisible(false);
      }, ms);
    },
    [clearHide],
  );

  const locked = lock?.locked === true;

  useEffect(() => {
    if (locked) showFor(AUTO_SHOW_MS);
    else setVisible(false);
    return clearHide;
  }, [locked, showFor, clearHide]);

  if (!lock?.locked) return null;

  return (
    <>
      <button
        type="button"
        data-testid="pill-reveal-zone"
        aria-label="查看本次学习剩余时间"
        className="fixed inset-x-0 top-0 z-40 h-2.5 bg-transparent"
        onMouseEnter={() => {
          hovering.current = true;
          clearHide();
          setVisible(true);
        }}
        onMouseLeave={() => {
          hovering.current = false;
          showFor(HOVER_HIDE_DELAY_MS);
        }}
        onFocus={() => showFor(TAP_SHOW_MS)}
        onClick={() => {
          // 触屏会先补一个 mouseenter（之后没有 mouseleave）：不清掉悬停标记
          // 的话，点击的 5 秒定时器会被 `!hovering` 判据挡掉，胶囊永远不消失。
          hovering.current = false;
          showFor(TAP_SHOW_MS);
        }}
      />
      <LockedPill remainingMs={lock.remainingMs} visible={visible} />
    </>
  );
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `cd apps/web && npx vitest run src/kiosk/LockedPillReveal.test.tsx`
Expected: PASS（5 passed）。

- [ ] **Step 5: 提交**

```bash
git add apps/web/src/kiosk/LockedPillReveal.tsx apps/web/src/kiosk/LockedPillReveal.test.tsx
git commit -m "feat(web): 剩余时长改为按需唤出（自动 3s / 悬停 / 点击 5s）"
```

---

### Task 4: 浅停留页接入

**Files:**
- Modify: `apps/web/src/components/layout/StudentStayLayout.tsx`
- Test: `apps/web/src/components/layout/StudentStayLayout.test.tsx`

**Interfaces:**
- Consumes: `LockedPillReveal`（Task 3）、`LearningLockContext`（Task 2）

- [ ] **Step 1: 写失败测试**

在 `StudentStayLayout.test.tsx` 顶部加 import：

```tsx
import { LearningLockContext } from '@/kiosk/learningLockContext';
```

把 `renderStay` 改成可注入锁定态（**不传时行为不变**）：

```tsx
function renderStay(
  initialEntry: { pathname: string; state?: unknown },
  lock: { locked: boolean; remainingMs: number } | null = null,
) {
  const router = createMemoryRouter(
    [
      { path: '/student/star-map', element: <div>知识星图</div> },
      { path: '/student/course-detail', element: <div>课程详情</div> },
      { path: '/student/entry', element: <div>入口选择页</div> },
      {
        path: '/student/profile',
        element: <StudentStayLayout />,
        children: [{ index: true, element: <div>个人中心内容</div> }],
      },
      {
        path: '/student/rewards',
        element: <StudentStayLayout />,
        children: [{ index: true, element: <div>奖励册内容</div> }],
      },
    ],
    { initialEntries: [initialEntry] },
  );
  render(
    <LearningLockContext.Provider value={lock}>
      <RouterProvider router={router} />
    </LearningLockContext.Provider>,
  );
  return router;
}
```

在文件末尾新增一个 describe：

```tsx
describe('StudentStayLayout 剩余时长浮层', () => {
  it('没有锁定上下文时不渲染识别区', () => {
    renderStay({ pathname: '/student/profile' });
    expect(screen.queryByTestId('pill-reveal-zone')).not.toBeInTheDocument();
  });

  it('锁定时渲染识别区与胶囊，且胶囊不抢点击', () => {
    renderStay({ pathname: '/student/profile' }, { locked: true, remainingMs: 30 * 60_000 });
    expect(screen.getByTestId('pill-reveal-zone')).toBeInTheDocument();
    expect(screen.getByTestId('locked-pill').className).toContain('pointer-events-none');
    // 三个 tab 仍然可点（胶囊在它们下方、且 pointer-events-none）
    expect(screen.getByRole('link', { name: '练习记录' })).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd apps/web && npx vitest run src/components/layout/StudentStayLayout.test.tsx`
Expected: FAIL —— 找不到 `pill-reveal-zone`。

- [ ] **Step 3: 接入**

`apps/web/src/components/layout/StudentStayLayout.tsx`：

1. 顶部 import 加：

```tsx
import { LockedPillReveal } from '@/kiosk/LockedPillReveal';
```

2. 在 `return (` 的根 `<div ...>` 之后、`<header>` 之前插入一行（浮层是 `fixed`，DOM 位置不影响渲染）：

```tsx
      <LockedPillReveal />
```

- [ ] **Step 4: 跑测试确认通过**

Run: `cd apps/web && npx vitest run src/components/layout/StudentStayLayout.test.tsx`
Expected: PASS（原有 5 条 + 新增 2 条）。

- [ ] **Step 5: 全量 Web 测试**

Run: `cd apps/web && npm test`
Expected: PASS（若 `LearningSessionShell.test.tsx` 仍有残留 pill 断言，回到 Task 2 Step 2 逐条改掉）。

- [ ] **Step 6: 提交**

```bash
git add apps/web/src/components/layout/StudentStayLayout.tsx apps/web/src/components/layout/StudentStayLayout.test.tsx
git commit -m "feat(web): 浅停留三页接入剩余时长浮层"
```

---

### Task 5: 退出审计（异常结束标记 + 退出尝试日志）

**Files:**
- Create: `apps/desktop/lib/exit-audit.js`
- Create: `apps/desktop/lib/exit-audit.test.js`
- Modify: `apps/desktop/main.js`

**Interfaces:**
- Produces:
  - `markRunning(userDataDir: string): void`
  - `wasAbnormalExit(userDataDir: string): boolean`
  - `markCleanExit(userDataDir: string): void`

- [ ] **Step 1: 写失败测试**

`apps/desktop/lib/exit-audit.test.js`：

```js
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { markRunning, wasAbnormalExit, markCleanExit } = require('./exit-audit.js');

let dir;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'k12-exit-audit-'));
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('exit-audit', () => {
  it('第一次启动没有标记 → 不算异常结束', () => {
    expect(wasAbnormalExit(dir)).toBe(false);
  });

  it('正常运行中标记存在 → 重新启动即判定上次异常结束', () => {
    markRunning(dir);
    expect(fs.existsSync(path.join(dir, 'running.flag'))).toBe(true);
    expect(wasAbnormalExit(dir)).toBe(true);
  });

  it('正常退出会清标记', () => {
    markRunning(dir);
    markCleanExit(dir);
    expect(wasAbnormalExit(dir)).toBe(false);
  });

  it('目录不可写也不抛（写入永不阻断启动）', () => {
    expect(() => markRunning(path.join(dir, 'missing', 'deeper'))).not.toThrow();
    expect(wasAbnormalExit(path.join(dir, 'missing'))).toBe(false);
    expect(() => markCleanExit(path.join(dir, 'missing'))).not.toThrow();
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd apps/desktop && npx vitest run lib/exit-audit.test.js`
Expected: FAIL —— 模块不存在。

- [ ] **Step 3: 实现**

`apps/desktop/lib/exit-audit.js`：

```js
'use strict';

const fs = require('node:fs');
const path = require('node:path');

/**
 * 退出审计（spec 2026-11-10 §3.1）。
 *
 * 目的只有一个：**区分"正常退出"与"被强杀/崩溃"**。做法是启动写标记、正常退出删标记，
 * 下次启动如果标记还在 → 上次没走完退出流程。
 *
 * ⚠️ 不要在这里做"异常退出就结束学习会话/通知家长"：2026-09-23 裁决 10 明确不区分异常退出。
 * 这里只写日志，给下次复现 Siri 关掉 App 时留证据。
 */
const FLAG_NAME = 'running.flag';

function flagPath(userDataDir) {
  return path.join(userDataDir, FLAG_NAME);
}

function markRunning(userDataDir) {
  try {
    fs.writeFileSync(flagPath(userDataDir), String(process.pid));
  } catch {
    // 写不了就不写：审计信息缺失好过启动失败。
  }
}

function wasAbnormalExit(userDataDir) {
  try {
    return fs.existsSync(flagPath(userDataDir));
  } catch {
    return false;
  }
}

function markCleanExit(userDataDir) {
  try {
    fs.rmSync(flagPath(userDataDir), { force: true });
  } catch {
    // 同上，绝不抛。
  }
}

module.exports = { markRunning, wasAbnormalExit, markCleanExit, FLAG_NAME };
```

- [ ] **Step 4: 跑测试确认通过**

Run: `cd apps/desktop && npx vitest run lib/exit-audit.test.js`
Expected: PASS（4 passed）。

- [ ] **Step 5: 接到 `main.js`**

1. 顶部 require 区加：

```js
const { markRunning, wasAbnormalExit, markCleanExit } = require('./lib/exit-audit.js');
```

2. `app.whenReady().then(() => {` 之后第一行（**在 `WEB_URL` 解析之前**）：

```js
  if (wasAbnormalExit(app.getPath('userData'))) {
    appendKioskLog('[guard] reason=abnormal-exit');
  }
  markRunning(app.getPath('userData'));
```

3. `win.on('close', ...)` 改为（**只加日志，判定不动**）：

```js
  win.on('close', (event) => {
    appendKioskLog(`[guard] close-attempt student-mode=${studentMode}`);
    if (studentMode) event.preventDefault();
  });
```

4. `app.on('before-quit', ...)` 改为：

```js
app.on('before-quit', (event) => {
  appendKioskLog(`[guard] before-quit student-mode=${studentMode}`);
  if (studentMode) event.preventDefault();
});
```

5. `app.on('will-quit', ...)` 改为：

```js
app.on('will-quit', () => {
  keyboardHook.setEnabled(false);
  appendKioskLog('[guard] will-quit');
  markCleanExit(app.getPath('userData'));
});
```

- [ ] **Step 6: 跑壳全量测试**

Run: `cd apps/desktop && npm test`
Expected: PASS（新增 4 条）。

- [ ] **Step 7: 提交**

```bash
git add apps/desktop/lib/exit-audit.js apps/desktop/lib/exit-audit.test.js apps/desktop/main.js
git commit -m "feat(desktop): 退出尝试落盘 + 异常结束判定"
```

---

### Task 6: 渲染进程崩溃自恢复

**Files:**
- Modify: `apps/desktop/main.js`
- Test: `apps/desktop/kiosk-guard.wiring.guard.test.js`

**Interfaces:**
- Consumes: `appendKioskLog`、`createWindow()`（`main.js` 内部）
- Produces: 护栏断言（源码级）——无对外导出

- [ ] **Step 1: 写失败护栏测试**

在 `kiosk-guard.wiring.guard.test.js` 的 `describe` 里追加：

```js
  it('渲染进程崩溃要自动恢复（60 秒内二次崩溃则重建窗口）', () => {
    expect(mainSrc).toMatch(/webContents\.on\(\s*'render-process-gone'/);
    expect(mainSrc).toMatch(/rendererCrashAt/);
    // 恢复块里必须真的调 createWindow（单独匹配 createWindow() 会被文件里原有的调用骗过）
    expect(mainSrc).toMatch(/render-process-gone[\s\S]{0,1200}?createWindow\(\)/);
  });

  it('子进程崩溃只记日志，不重建窗口', () => {
    expect(mainSrc).toMatch(/webContents\.on\(\s*'child-process-gone'/);
  });
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd apps/desktop && npx vitest run kiosk-guard.wiring.guard.test.js`
Expected: FAIL —— `render-process-gone` 不存在。

- [ ] **Step 3: 实现**

在 `main.js` 的 `createWindow()` 内、`win.webContents.on('did-finish-load', ...)` 之后追加：

```js
  // 崩溃自恢复（spec 2026-11-10 §3.2）：界面没了 = 学生看到的是死窗口，
  // 而"窗口还在、kiosk 还在"会骗过看门狗。首次崩溃就地 reload；60 秒内再来一次
  // 说明这个页面/进程起不来，直接重建窗口（重建后由 ready-to-show 重新进 kiosk）。
  win.webContents.on('render-process-gone', (_event, details) => {
    // 正常关闭/kill 也会触发，别把它当崩溃去"复活"窗口。
    if (details && details.reason === 'clean-exit') return;
    const now = Date.now();
    const repeated = now - rendererCrashAt < 60_000;
    rendererCrashAt = now;
    appendKioskLog(
      `[guard] render-process-gone reason=${details && details.reason} repeated=${repeated}`,
    );
    try {
      if (!win || win.isDestroyed()) return;
      if (repeated) {
        const old = win;
        // 不要先把 win 置 null：`closed` 处理器会按窗口身份判断（见下面的 `thisWindow`），
        // 由它负责收尾，否则会漏掉 stopRetry / kioskGuard.stop。
        old.destroy(); // destroy 绕过 close 拦截（拦截是给学生的，不是给恢复逻辑的）
        createWindow();
      } else {
        win.webContents.reload();
      }
    } catch (err) {
      appendKioskLog(`[guard] render-recover-error err=${err && err.message}`);
    }
  });

  // GPU / utility 崩了不该整窗重建，记一笔就够（下一次 tick 会检查窗口状态）。
  win.webContents.on('child-process-gone', (_event, details) => {
    appendKioskLog(
      `[guard] child-process-gone type=${details && details.type} reason=${details && details.reason}`,
    );
  });
```

**同时必须给 `closed` 处理器加窗口身份判断**（否则重建窗口时，旧窗口的 `closed` 会把新窗口的模块级
`win` 置 null，守护从此找不到窗口）：

```js
  win.on('closed', () => {
    // 恢复逻辑会 destroy 旧窗口再建新的；旧窗口的 closed 晚到一步时，
    // 不能把 `win` 里已经装好的新窗口抹掉。
    if (win !== thisWindow) return;
    stopRetry();
    kioskGuard.stop();
    keyboardHook.setEnabled(false);
    win = null;
  });
```

并在 `createWindow()` 里、创建窗口之后立刻捕获引用：

```js
  const thisWindow = win;
```

在 `main.js` 模块级（`let appWasInactive = false;` 下方）加：

```js
/** 最近一次渲染进程崩溃的时间戳：60 秒内二次崩溃改走"重建窗口"。 */
let rendererCrashAt = 0;
```

- [ ] **Step 4: 跑测试确认通过**

Run: `cd apps/desktop && npm test`
Expected: PASS。

- [ ] **Step 5: 提交**

```bash
git add apps/desktop/main.js apps/desktop/kiosk-guard.wiring.guard.test.js
git commit -m "fix(desktop): 渲染进程崩溃自动 reload / 重建窗口"
```

---

### Task 7: 看护进程 + 单实例

> **2026-11-10 用户裁决替换了原「launchd 直管 App」方案**：家长也要能正常退出 App，所以改为
> 「launchd 托管一个极小的看护脚本，脚本只在学生模式下拉起 App」。上一版已提交的
> `lib/launch-agent.js` 与 `lib/launch-agent.test.js`（commit 96664653）在本任务里**删除** ——
> 它尚未发布，不保留兼容层。

**Files:**
- Create: `apps/desktop/lib/watchdog.js`
- Create: `apps/desktop/lib/watchdog.test.js`
- Delete: `apps/desktop/lib/launch-agent.js`, `apps/desktop/lib/launch-agent.test.js`
- Modify: `apps/desktop/main.js`
- Modify: `apps/desktop/scripts/verify-asar.js`
- Modify: `apps/desktop/kiosk-guard.wiring.guard.test.js`

**Interfaces:**
- Produces:
  - `WATCHDOG_LABEL = 'com.local.sysmon'`
  - `WATCHDOG_SCRIPT_NAME = 'sysmon.sh'`
  - `buildWatchdogScript(): string`
  - `buildWatchdogPlist({ execPath, scriptPath }): string`
  - `installWatchdog({ platform, homeDir, execPath, uid, log, run }): { installed: boolean; reason?: string; scriptPath?: string; plistPath?: string; bootstrapped?: boolean }`

- [ ] **Step 1: 写失败测试**

`apps/desktop/lib/watchdog.test.js`：

```js
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  WATCHDOG_LABEL,
  WATCHDOG_SCRIPT_NAME,
  buildWatchdogScript,
  buildWatchdogPlist,
  installWatchdog,
} = require('./watchdog.js');

let home;
let calls;
let logLines;
const runOk = (file, args) => calls.push([file, ...args]);

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'k12-watchdog-'));
  calls = [];
  logLines = [];
});
afterEach(() => {
  fs.rmSync(home, { recursive: true, force: true });
});

const EXEC = '/Applications/K12 智学.app';
const log = (line) => logLines.push(line);

function install(overrides = {}) {
  return installWatchdog({
    platform: 'darwin',
    execPath: EXEC,
    homeDir: home,
    uid: 501,
    log,
    run: runOk,
    ...overrides,
  });
}

describe('watchdog', () => {
  it('脚本只在 studentMode=true 时工作，靠进程存在性判断、5 秒一轮', () => {
    const script = buildWatchdogScript();
    expect(script).toContain('"studentMode":true');
    expect(script).toContain('pgrep -f "$APP/Contents/MacOS/"');
    expect(script).toContain('open -a "$APP"');
    expect(script).toContain('sleep 5');
    // 靠网络心跳判断会被拔网线误伤，脚本里不该出现 curl / 后端地址
    expect(script).not.toContain('curl');
  });

  it('plist 带 KeepAlive / RunAtLoad / ThrottleInterval / 脚本与 App 两个参数', () => {
    const xml = buildWatchdogPlist({
      execPath: EXEC,
      scriptPath: '/Users/x/Library/Application Support/k12-desktop/sysmon.sh',
    });
    expect(xml).toContain(`<string>${WATCHDOG_LABEL}</string>`);
    expect(xml).toContain('<key>KeepAlive</key>');
    expect(xml).toContain('<key>RunAtLoad</key>');
    expect(xml).toContain('<integer>10</integer>');
    expect(xml).toContain('<string>/bin/sh</string>');
    expect(xml).toContain('/Users/x/Library/Application Support/k12-desktop/sysmon.sh');
    expect(xml).toContain(EXEC);
  });

  it('首次安装写脚本(0755)+plist，并 bootstrap', () => {
    const res = install({ run: (file, args) => { calls.push([file, ...args]); throw new Error('not loaded'); } });
    const scriptPath = path.join(home, 'Library', 'Application Support', 'k12-desktop', WATCHDOG_SCRIPT_NAME);
    const plistPath = path.join(home, 'Library', 'LaunchAgents', `${WATCHDOG_LABEL}.plist`);
    expect(res.installed).toBe(true);
    expect(fs.existsSync(scriptPath)).toBe(true);
    expect(fs.statSync(scriptPath).mode & 0o777).toBe(0o755);
    expect(fs.readFileSync(scriptPath, 'utf8')).toContain('pgrep');
    expect(fs.existsSync(plistPath)).toBe(true);
    expect(calls).toEqual([
      ['launchctl', 'print', `gui/501/${WATCHDOG_LABEL}`],
      ['launchctl', 'bootstrap', 'gui/501', plistPath],
    ]);
  });

  it('内容没变且已加载 → 幂等，不重写不 bootstrap', () => {
    install({ run: (file, args) => { calls.push([file, ...args]); throw new Error('not loaded'); } });
    calls = [];
    const before = fs.statSync(path.join(home, 'Library', 'LaunchAgents', `${WATCHDOG_LABEL}.plist`)).mtimeMs;
    const res = install(); // print 成功 = 已加载
    expect(res.reason).toBe('unchanged');
    expect(calls).toEqual([['launchctl', 'print', `gui/501/${WATCHDOG_LABEL}`]]);
    const after = fs.statSync(path.join(home, 'Library', 'LaunchAgents', `${WATCHDOG_LABEL}.plist`)).mtimeMs;
    expect(after).toBe(before);
  });

  it('App 路径变了 → 重写 plist，先 bootout 再 bootstrap', () => {
    install({ run: (file, args) => { calls.push([file, ...args]); throw new Error('not loaded'); } });
    calls = [];
    const res = install({ execPath: '/Applications/K12 智学 2.app' });
    const plistPath = path.join(home, 'Library', 'LaunchAgents', `${WATCHDOG_LABEL}.plist`);
    expect(res.installed).toBe(true);
    expect(fs.readFileSync(plistPath, 'utf8')).toContain('/Applications/K12 智学 2.app');
    expect(calls).toEqual([
      ['launchctl', 'print', `gui/501/${WATCHDOG_LABEL}`],
      ['launchctl', 'bootout', `gui/501/${WATCHDOG_LABEL}`],
      ['launchctl', 'bootstrap', 'gui/501', plistPath],
    ]);
  });

  it('只有脚本内容变了 → 也要 bootout 再 bootstrap（plist 是纯函数，升级时通常不变）', () => {
    install({ run: (file, args) => { calls.push([file, ...args]); throw new Error('not loaded'); } });
    const scriptPath = path.join(home, 'Library', 'Application Support', 'k12-desktop', WATCHDOG_SCRIPT_NAME);
    fs.writeFileSync(scriptPath, '#!/bin/sh\n# old\n');
    calls = [];
    const res = install(); // print 成功 = 已加载
    const plistPath = path.join(home, 'Library', 'LaunchAgents', `${WATCHDOG_LABEL}.plist`);
    expect(res.installed).toBe(true);
    expect(res.bootstrapped).toBe(true);
    expect(calls).toEqual([
      ['launchctl', 'print', `gui/501/${WATCHDOG_LABEL}`],
      ['launchctl', 'bootout', `gui/501/${WATCHDOG_LABEL}`],
      ['launchctl', 'bootstrap', 'gui/501', plistPath],
    ]);
    expect(fs.readFileSync(scriptPath, 'utf8')).toBe(buildWatchdogScript());
  });

  it('非 darwin 完全不碰磁盘', () => {
    const res = install({ platform: 'win32' });
    expect(res.reason).toBe('platform');
    expect(fs.existsSync(path.join(home, 'Library'))).toBe(false);
  });

  it('launchctl 失败只记账，不抛（也带超时参数）', () => {
    const boom = (file, args) => {
      calls.push([file, ...args]);
      throw new Error('launchctl failed');
    };
    expect(() => install({ run: boom })).not.toThrow();
    expect(logLines.some((line) => line.includes('watchdog-bootstrap-error'))).toBe(true);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd apps/desktop && npx vitest run lib/watchdog.test.js`
Expected: FAIL —— 模块不存在。

- [ ] **Step 3: 实现 `lib/watchdog.js`**

```js
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

/**
 * 看护进程（spec 2026-11-10 §4，仅 macOS，仅打包后）。
 *
 * **为什么不是把 App 交给 launchd KeepAlive**（2026-11-10 用户裁决）：那样家长点了退出
 * 也会被立刻拉回来，只能去终端摘。所以改成「launchd 托管一个极小的 sh 看护脚本」：
 * 脚本只在 `shell-state.json` 的 `studentMode === true` 时工作，家长/管理员模式直接空转。
 *
 * **判据用进程存在性（pgrep），不用网络心跳**：心跳会被拔网线 / 服务器故障误判成
 * "App 死了"，进而反复拉起一个本来正常的程序。
 *
 * ⚠️ `execFileSync` 必须带 timeout：launchctl 卡住（XPC 无响应）会把主进程一起卡死、
 * 窗口永远不出来 —— 宁可这一次没保活。
 *
 * ⚠️ 名字与产品无关（`com.local.sysmon`）只是降低被注意的概率，**不是隐藏手段**：
 * `launchctl list`、活动监视器都能看到；学生 `launchctl bootout` 仍能摘掉。
 */
const WATCHDOG_LABEL = 'com.local.sysmon';
const WATCHDOG_SCRIPT_NAME = 'sysmon.sh';
const APP_SUPPORT_DIR = 'k12-desktop';

function buildWatchdogScript() {
  return `#!/bin/sh
# sysmon —— 本地看护（spec 2026-11-10 §4）。
# 只在 studentMode=true 时工作：发现 App 不在运行就拉起；家长/管理员模式什么都不做。
APP="$1"
[ -n "$APP" ] || exit 0
STATE="$HOME/Library/Application Support/k12-desktop/shell-state.json"
while :; do
  if [ -f "$STATE" ] && grep -q '"studentMode":true' "$STATE" 2>/dev/null; then
    if ! pgrep -f "$APP/Contents/MacOS/" >/dev/null 2>&1; then
      open -a "$APP" >/dev/null 2>&1
    fi
  fi
  sleep 5
done
`;
}

function escapeXml(value) {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function buildWatchdogPlist({ execPath, scriptPath }) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${WATCHDOG_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>/bin/sh</string>
    <string>${escapeXml(scriptPath)}</string>
    <string>${escapeXml(execPath)}</string>
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>ThrottleInterval</key>
  <integer>10</integer>
  <key>LimitLoadToSessionType</key>
  <string>Aqua</string>
</dict>
</plist>
`;
}

function defaultRun(file, args) {
  execFileSync(file, args, { stdio: 'ignore', timeout: 3000, killSignal: 'SIGKILL' });
}

/**
 * @param {object} deps
 * @param {string} deps.platform
 * @param {string} deps.execPath App 包路径（`.app`，不是可执行文件）
 * @param {string} deps.homeDir `app.getPath('home')`
 * @param {number} [deps.uid]
 * @param {(m: string) => void} [deps.log]
 * @param {(file: string, args: string[]) => void} [deps.run]
 */
function installWatchdog({ platform, execPath, homeDir, uid, log = () => {}, run = defaultRun }) {
  if (platform !== 'darwin') return { installed: false, reason: 'platform' };
  const resolvedUid =
    typeof uid === 'number' ? uid : typeof process.getuid === 'function' ? process.getuid() : null;
  if (resolvedUid === null) return { installed: false, reason: 'uid' };

  const scriptPath = path.join(homeDir, 'Library', 'Application Support', APP_SUPPORT_DIR, WATCHDOG_SCRIPT_NAME);
  const plistPath = path.join(homeDir, 'Library', 'LaunchAgents', `${WATCHDOG_LABEL}.plist`);
  const script = buildWatchdogScript();
  const plist = buildWatchdogPlist({ execPath, scriptPath });

  let changed = false;
  try {
    const oldScript = fs.readFileSync(scriptPath, 'utf8');
    if (oldScript !== script) changed = true;
  } catch {
    changed = true;
  }
  let plistChanged = false;
  try {
    const oldPlist = fs.readFileSync(plistPath, 'utf8');
    if (oldPlist !== plist) plistChanged = true;
  } catch {
    plistChanged = true;
  }

  try {
    if (changed) {
      fs.mkdirSync(path.dirname(scriptPath), { recursive: true });
      fs.writeFileSync(scriptPath, script, { mode: 0o755 });
      fs.chmodSync(scriptPath, 0o755);
    }
    if (plistChanged) {
      fs.mkdirSync(path.dirname(plistPath), { recursive: true });
      fs.writeFileSync(plistPath, plist);
    }
  } catch (err) {
    log(`[guard] watchdog-write-error err=${err && err.message}`);
    return { installed: false, reason: 'write-error' };
  }

  let loaded = false;
  try {
    run('launchctl', ['print', `gui/${resolvedUid}/${WATCHDOG_LABEL}`]);
    loaded = true;
  } catch {
    loaded = false;
  }

  // 脚本内容变了也必须重载：正在运行的 /bin/sh 已把旧脚本读进内存，只重写文件它不会重读，
  // 且 plist 是 execPath 的纯函数、升级时通常不变 —— 只看 plistChanged 会漏掉这种最常见的情况。
  const dirty = changed || plistChanged;
  if (dirty && loaded) {
    try {
      run('launchctl', ['bootout', `gui/${resolvedUid}/${WATCHDOG_LABEL}`]);
    } catch {
      // bootout 失败也继续尝试 bootstrap（launchd 可能已经把 job 摘了）。
    }
    loaded = false;
  }

  if (loaded) return { installed: false, reason: 'unchanged', scriptPath, plistPath };

  try {
    run('launchctl', ['bootstrap', `gui/${resolvedUid}`, plistPath]);
    log(`[guard] watchdog-installed plist=${plistPath}`);
    return { installed: true, scriptPath, plistPath, bootstrapped: true };
  } catch (err) {
    log(`[guard] watchdog-bootstrap-error err=${err && err.message}`);
    // 文件已落地：下次登录 RunAtLoad 仍会拉起；只是本次运行期没有保活。
    // 这次写过文件就不能复述成 'unchanged'。
    return {
      installed: true,
      reason: dirty ? 'updated' : 'bootstrap-failed',
      scriptPath,
      plistPath,
      bootstrapped: false,
    };
  }
}

module.exports = { WATCHDOG_LABEL, WATCHDOG_SCRIPT_NAME, buildWatchdogScript, buildWatchdogPlist, installWatchdog };
```

- [ ] **Step 4: 跑测试确认通过**

Run: `cd apps/desktop && npx vitest run lib/watchdog.test.js`
Expected: PASS（8 passed）。

- [ ] **Step 5: 删除上一版实现**

```bash
git rm apps/desktop/lib/launch-agent.js apps/desktop/lib/launch-agent.test.js
```

- [ ] **Step 6: 改 `main.js` 接线**

1. require 改为：

```js
const { installWatchdog } = require('./lib/watchdog.js');
```

2. `whenReady` 里的安装调用改为：

```js
  // 首次启动（打包后）装看护：学生模式被强杀后 5 秒内拉回 kiosk；家长模式它空转。
  if (app.isPackaged) {
    installWatchdog({
      platform: process.platform,
      execPath: app.getAppPath().replace(/\/Contents\/Resources\/app\.asar$/, ''),
      homeDir: app.getPath('home'),
      log: appendKioskLog,
    });
  }
```

（`app.getAppPath()` 指向 `.asar`，去掉尾部即 `.app` 包路径；`open -a` 需要包路径。）

3. 单实例与 `second-instance` 保持上一版不变；`will-quit` 里的 `if (!singleInstance) return;`
   **保留**（否则第二实例会删掉正在运行实例的 `running.flag`）。

- [ ] **Step 7: 更新 `verify-asar.js` 与护栏**

- `REQUIRED` 里把 `'lib/launch-agent.js'` 换成 `'lib/watchdog.js'`。
- `kiosk-guard.wiring.guard.test.js` 追加：

```js
  it('首启安装看护进程（不再直管 App 的 KeepAlive）', () => {
    expect(mainSrc).toMatch(/installWatchdog\(/);
    expect(mainSrc).not.toMatch(/installLaunchAgent\(/);
  });
```

- [ ] **Step 8: 跑壳全量测试**

Run: `cd apps/desktop && npm test`
Expected: PASS。

- [ ] **Step 9: 提交**

```bash
git add -A apps/desktop/lib apps/desktop/main.js apps/desktop/scripts/verify-asar.js apps/desktop/kiosk-guard.wiring.guard.test.js
git commit -m "feat(desktop): 看护进程保活（仅学生模式）+ 单实例"
```

---

### Task 8: 文档同步与收尾

**Files:**
- Modify: `docs/constraints/pc-app-学习管控.md`
- Modify: `docs/ai-core-changelog.md`

- [ ] **Step 1: 约束文档追加两节**

在 `docs/constraints/pc-app-学习管控.md` 的 `## 系统打断后的全屏恢复（2026-11-04）` 之前插入：

```markdown
## 剩余时长胶囊：只在浅停留三页、按需唤出（2026-11-10）

之前胶囊是 `LearningSessionShell` 的全局常驻元素、`fixed top-3`（距窗口顶 12px），
**整块落在 64px 顶栏内部**，正好压住个人中心/奖励册/练习记录三个 tab —— 学生点不到练习记录（用户实测）。

- 现在只在 `StudentStayLayout`（三页 + 练习记录详情）渲染；沉浸页**没有**胶囊，
  学生点右上角登出时由 `LogoutButton` 的 toast 解释「时长未满」。
- 锁定态经 `learningLockContext` 下发，`LearningSessionShell` 仍是唯一真源（含 `isDesktopShell()` 闸门），
  **禁止**在页面里再读一次 localStorage。
- 交互：进入三个主 tab 显示 **3 秒**；顶边 **10px** 识别区悬停显示、移出 200ms 收起；点击/轻触显示 **5 秒**
  （触屏没有 hover，这条是 iPad 的唯一路径）。详情页不自动弹。
- 胶囊 `top-[72px]`（= 64px 顶栏 + 8px）、`pointer-events-none`、`z-40`：**它绝不能再抢任何点击**。
  识别区只有 10px 高，tab 从 20px 起、右上按钮从 12px 起，都在其下方 —— 改高度前先量这两处。

## 被关掉之后的保活（2026-11-10）

**先记结论，别再当缺陷重查**：`before-quit` 拦得住优雅退出（AppleScript `quit` / `kill -TERM` 都会被
Electron 转成 `before-quit`，2026-11-10 实测）；**拦不住 SIGKILL（强杀/强制退出）** —— 应用层无解。

- 真正的缺口是「被关掉后没人拉起」：`lib/watchdog.js` 首次启动（仅 `app.isPackaged && darwin`）写
  `~/Library/Application Support/k12-desktop/sysmon.sh`（0755）与
  `~/Library/LaunchAgents/com.local.sysmon.plist`（`RunAtLoad` + `KeepAlive` + `ThrottleInterval=10`），
  并 `launchctl bootstrap`。看护脚本 5 秒一轮，**只在 `shell-state.json` 的 `studentMode=true` 时**
  用 `pgrep` 判活、`open -a` 拉起；家长/管理员模式直接空转。被强杀后最多约 5–10 秒回到 kiosk。
- **不用网络心跳判断**：拔网线 / 服务器故障会被误判成「App 死了」，从而反复拉起正常进程。
- **看护是用户级**：学生 `launchctl bootout gui/$(id -u)/com.local.sysmon` 仍能摘掉。它挡的是
  Siri / 活动监视器顺手关，不承诺「绝对关不掉」；要那一步得 root 级 `LaunchDaemon` 或受监督设备
  Single App Mode（未立项）。名字与产品无关只是降低被注意的概率，`launchctl list` / 活动监视器可见。
- 单实例锁 `app.requestSingleInstanceLock()` 是看护的配套：没有它，「看护拉起 + 用户双击」会双开；
  第二实例还必须跳过 `markCleanExit`，否则会删掉正在运行实例的 `running.flag`。
- `lib/exit-audit.js` 用 `running.flag` 判「上次是否非正常结束」，只在 `kiosk-guard.log` 记一行
  `reason=abnormal-exit`，**不上报家长、不结束会话**（沿用 2026-09-23 裁决 10）。
- 退出尝试（`close-attempt` / `before-quit` / `will-quit`）都落 `kiosk-guard.log`：
  下次复现「Siri 关掉」时，**有 `before-quit` 仍死亡 = 系统升级为强杀；一行都没有 = 直接 SIGKILL 或崩溃**。
- 崩溃自恢复：`render-process-gone` → `reload()`；60 秒内二次崩溃 → `destroy()` + `createWindow()`。
  `child-process-gone` 只记日志。
- 卸载：`launchctl bootout gui/$(id -u)/com.local.sysmon && rm ~/Library/LaunchAgents/com.local.sysmon.plist "$HOME/Library/Application Support/k12-desktop/sysmon.sh"`
  （写进交付文档，App 内不提供开关）。
```

同时把「做不到的别当缺陷修」那一段末尾补一句：

```markdown
  **2026-11-10 补**：被 SIGKILL 后由 launchd 托管的看护进程拉回（`lib/watchdog.js`，
  仅学生模式、5 秒一轮）；这不是"挡住了强杀"，只是"关掉后能自己回来"；学生仍可 `launchctl bootout`。
```

- [ ] **Step 2: changelog 追加**

在 `docs/ai-core-changelog.md` 顶部（最新的 `## 2026-11-09 ...` 之前）插入：

```markdown
## 2026-11-10 PC App：剩余时长胶囊遮挡 tab + 被关掉后不自动恢复

**问题 1**：锁定胶囊 `fixed top-3`（距顶 12px）落在 64px 顶栏内，整块压住个人中心的
奖励册/个人中心/练习记录三个 tab，学生点不到练习记录。改为只在浅停留三页、`top-[72px]`、
`pointer-events-none`；进入 3 秒 / 顶边悬停 / 点击 5 秒唤出（iPad 走点击）。

**问题 2**：macOS 下切不走 App，但 Siri 能把它关掉。实测：AppleScript `quit` 与 `kill -TERM`
都会被 `before-quit` 拦（Electron 把 SIGTERM 转成优雅退出）；只有 SIGKILL 拦不住。
**真正的缺口是关掉后没人拉起**。新增 `lib/watchdog.js`（launchd 托管的 sh 看护：
只在 `studentMode=true` 时用 `pgrep` 判活并 `open -a` 拉起，家长模式空转）+ 单实例锁 +
`lib/exit-audit.js`（`running.flag` 判异常结束）+ 退出尝试日志 + `render-process-gone` 自恢复。
边界：用户级看护可被 `launchctl bootout`，不是"绝对关不掉"；名字 `com.local.sysmon` 只是降低被注意的概率。

设计：`docs/superpowers/specs/2026-11-10-pc-app-pill-reveal-and-exit-hardening-design.md`
```

- [ ] **Step 2b: 修三处文档漂移（本次实现改变了事实，别只加注记）**

1. `docs/superpowers/specs/2026-11-10-pc-app-pill-reveal-and-exit-hardening-design.md` §2.2 的
   「三个 tab 互跳会重新触发 3000ms（路由切换会重挂布局）」——括号里那句是**错的**（React Router v6
   会复用 sibling route 的外壳）。改成「（用 `key={staySection}` 强制 `LockedPillReveal` 重挂；
   `staySection` 只到 tab 段，详情页不重挂）」。
2. `apps/web/src/components/layout/StudentStayLayout.tsx` 文件头 JSDoc 仍写「个人中心（P5.1）与奖励册（P5.2）专用」，
   补上练习记录（含详情）。
3. Task 8 Step 1 的约束文档里，「识别区只有 10px 高，tab 从 20px 起、右上按钮从 12px 起」按实测改为
   「tab 从约 16px 起、右上『退出本页』从约 11px 起（`p-2.5` + 20px 图标 + 边框 = 42px，居中于 64px 顶栏），
   识别区与它只有约 1px 间隙 —— 改识别区高度前必须重新量」。
4. `apps/desktop/lib/watchdog.js` 里 bootout 的 catch 注释「没加载过就是正常路径」已不准确
   （现在进入该 catch 时 `loaded` 可能为 true），改为「bootout 失败也继续尝试 bootstrap」。

- [ ] **Step 3: 全量测试**

Run: `cd apps/web && npm test && cd ../desktop && npm test`
Expected: 两侧全 PASS。

- [ ] **Step 4: 手工冒烟（不能自动化的部分）**

1. `cd apps/web && npm run build`，`cd apps/desktop && npx electron .`，学生登录 → 进个人中心：
   胶囊出现在顶栏下方、3 秒收起；三个 tab 都能点。
2. 鼠标移到窗口最顶边 → 胶囊出现；移开 → 消失。
3. 进做题页 → 无胶囊。
4. 打包后（需用户确认再跑 `bash tools/app-build.sh --local`，会覆盖 `apps/desktop/dist`）启动：
   `ls ~/Library/LaunchAgents/com.local.sysmon.plist` 与
   `~/Library/Application Support/k12-desktop/sysmon.sh` 都在；`kill -KILL` 主进程后
   ≤10 秒（一个轮询周期）自动回来。家长登录后点退出不应被拉起。

- [ ] **Step 5: 提交**

```bash
git add docs/constraints/pc-app-学习管控.md docs/ai-core-changelog.md
git commit -m "docs(desktop): 胶囊浮层与保活的口径与边界"
```

---

## 自检记录

- **Spec 覆盖**：§2 → Task 1–4；§3.1 → Task 5；§3.2 → Task 6；§4 → Task 7；§5 文件清单 → 各任务 Files；§7 旧表述 → Task 1 注释整段替换 + Task 8 约束文档；§8 验收 → Task 8 Step 4。
- **占位符**：无 TBD / "适当处理"；每个代码步骤都给了完整代码。
- **类型一致**：`LearningLockValue` 在 Task 2 定义，Task 3/4 按 `{ locked, remainingMs }` 使用；`LockedPill` 的 `visible` 在 Task 1 定义，Task 3 传参一致；`installWatchdog` 的返回字段在 Task 7 测试与实现中一致。
- **已知偏差**：spec §6 写"`LearningSessionShell.test.tsx` 原 4 条断言改为断言 context"——Task 2 Step 2 已按 4 处逐条落地（未设锁 / 到点解除 / 锁定中 / 未锁定时）。
