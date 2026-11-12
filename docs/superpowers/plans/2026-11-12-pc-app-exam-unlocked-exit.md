# PC App 家长解锁后考试页返回入口 — 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use subagent-driven-development (recommended) or executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 家长在家长端点【解除锁定】后，学生在考试页能就地看到一个返回入口，退回考试列表并自行登出、关窗。

**Architecture:** 新增一个独立的 `ParentUnlockContext`，由 `LearningSessionShell`（学习会话的唯一真源）从同一个 `lock` 派生下发；考试页消费它，在标题行渲染既有 `BackButton`，导航仍受 `RunExitGuard` 拦截确认。不改壳、不改后端、不改 Web 端行为。

**Tech Stack:** React 18 + TypeScript + react-router 6（`useBlocker`）+ Zustand 无关 + Vitest + @testing-library/react（`globals: false`）；Electron 壳只作为运行环境，本次零改动。

规格：`docs/superpowers/specs/2026-11-12-pc-app-exam-unlocked-exit-design.md`

## Global Constraints

- **只在 Electron 壳里生效**：判定依据是 `ParentUnlockContext` 的值（由 `isDesktopShell()` 参与计算）；浏览器里恒为 `false`，Web 端行为零变化。
- **只认「家长主动解除」**：`unlockedAt !== null`。锁自然到期、家长从未设锁都**不算**。
- **不改 `LearningLockContext`**：其类型、给值条件、`locked` 语义一个字不改；`LockedPillReveal` 与既有 5 条 `lock-probe === 'none'` 断言必须保持原样通过。
- **不在页面里读 `localStorage`**（`docs/constraints/pc-app-学习管控.md` 明令）。
- **不动壳**：`apps/desktop/**` 一行不改，不新增 IPC。
- **导航必须走既有 `RunExitGuard` 确认**：不得把 `guardRef.current` 置 false 绕过。
- **UI 规则**：不用 emoji、不用装饰元素；图标复用 `BackButton` 的线性 SVG。
- **测试纪律**：`globals: false`，多用例文件必须自己 `afterEach(() => cleanup())`。
- **测试与文档同步铁律**：测试断言与设计文档冲突时改测试；改行为时同步 `docs/constraints/pc-app-学习管控.md` 与 `docs/ai-core-changelog.md`。

---

## File Structure

| 文件 | 职责 |
|---|---|
| `apps/web/src/kiosk/parentUnlockContext.ts`（新建） | 只装一个布尔 context + hook，回答「家长是否主动解除了本次锁定」 |
| `apps/web/src/kiosk/LearningSessionShell.tsx`（改） | 从既有 `lock` 派生 `unlockedByParent` 并下发；仍是唯一真源 |
| `apps/web/src/pages/student/training/ExamRunPage.tsx`（改） | 消费 hook，在标题行渲染 `BackButton`，指向考试列表 |
| `apps/web/src/kiosk/LearningSessionShell.test.tsx`（改） | 钉住「解锁 → true / 未解锁与到期与浏览器 → false」 |
| `apps/web/src/pages/student/training/ExamRunPage.test.tsx`（改） | 钉住「未解锁不渲染；解锁渲染且点击经确认回到列表」 |

---

### Task 1: 新增 `ParentUnlockContext` 并由壳下发

**Files:**
- Create: `apps/web/src/kiosk/parentUnlockContext.ts`
- Modify: `apps/web/src/kiosk/LearningSessionShell.tsx:188-192`（return 段）
- Test: `apps/web/src/kiosk/LearningSessionShell.test.tsx`

**Interfaces:**
- Produces:
  - `ParentUnlockContext: React.Context<boolean>`（默认 `false`）
  - `useParentUnlocked(): boolean`
- Consumes: `LearningSessionShell` 内部 state `lock: { id: number; lockExpiresAt: string | null; unlockedAt: string | null } | null`

- [ ] **Step 1: 建 context 文件（先让测试能 import）**

`apps/web/src/kiosk/parentUnlockContext.ts`

```ts
import { createContext, useContext } from 'react';

/**
 * 家长是否**主动**点过【解除锁定】（`unlocked_at` 非空）。
 *
 * 与 `LearningLockContext` 分开的原因：那个 context 只在「锁定中」才非 null，
 * 而「已解除」恰好意味着不锁 —— 塞进去就要放宽给值条件，会让
 * `LearningSessionShell.test.tsx` 里 5 条「未锁定时 lock-probe 为 none」的断言失效。
 *
 * 真源仍是 `LearningSessionShell`（它持有轮询回来的 `lock`），本文件只承载下发通道。
 */
export const ParentUnlockContext = createContext<boolean>(false);

export function useParentUnlocked(): boolean {
  return useContext(ParentUnlockContext);
}
```

- [ ] **Step 2: 写失败测试**

在 `apps/web/src/kiosk/LearningSessionShell.test.tsx` 顶部 import 区加：

```tsx
import { useParentUnlocked } from './parentUnlockContext';
```

在 `LockProbe` 下方加探针：

```tsx
/** 家长解锁态探针：验证壳有没有把 unlockedByParent 下发对。 */
function UnlockProbe() {
  return <div data-testid="unlock-probe">{String(useParentUnlocked())}</div>;
}
```

把 `renderShell()` 里那行路由元素改成同时挂两个探针：

```tsx
<Route path="/student/course-detail" element={<><LockProbe /><UnlockProbe /><div>学习页</div></>} />
```

在文件末尾追加新 describe：

```tsx
describe('LearningSessionShell：家长解锁态下发', () => {
  it('轮询拿到 unlockedAt → 下发 true', async () => {
    vi.useFakeTimers();
    pollMock.mockResolvedValue({
      commands: [{ id: 3, command: 'unlock' }],
      lock: { sessionId: 7, lockExpiresAt: LATER, unlockedAt: '2026-09-23T01:20:00.000Z' },
    });
    renderShell();
    await act(async () => { vi.advanceTimersByTime(10_000); });
    await act(async () => { await Promise.resolve(); });

    expect(screen.getByTestId('unlock-probe')).toHaveTextContent('true');
  });

  it('未解锁 → 下发 false', async () => {
    renderShell();
    await act(async () => { await Promise.resolve(); });

    expect(screen.getByTestId('unlock-probe')).toHaveTextContent('false');
  });

  it('**锁自然到期 → 仍是 false**（到期不等于家长解除）', async () => {
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
    await act(async () => { vi.advanceTimersByTime(3_000); });

    expect(screen.getByTestId('unlock-probe')).toHaveTextContent('false');
  });

  it('**非壳（浏览器）→ false**，即使本地快照带 unlockedAt', async () => {
    delete (window as unknown as { k12Desktop?: unknown }).k12Desktop;
    writePersistedSession({
      studentId: 9,
      id: 7,
      lockExpiresAt: LATER,
      unlockedAt: '2026-09-23T01:20:00.000Z',
    });
    renderShell();
    await act(async () => { await Promise.resolve(); });

    expect(screen.getByTestId('unlock-probe')).toHaveTextContent('false');
  });
});
```

- [ ] **Step 3: 跑测试确认失败**

Run: `cd apps/web && npx vitest run src/kiosk/LearningSessionShell.test.tsx`

Expected: 1 条失败 —— 「轮询拿到 unlockedAt → 下发 true」收到 `false`（其余 3 条此时已通过，因为默认值就是 false）。

- [ ] **Step 4: 在壳里下发**

`apps/web/src/kiosk/LearningSessionShell.tsx`

顶部 import 区加：

```tsx
import { ParentUnlockContext } from './parentUnlockContext';
```

在 `lockValue` 计算之后、`return` 之前加（`unlockedByParent` 必须重新计算，不能复用 `lockValue`）：

```tsx
  /**
   * 家长是否**主动**解除过本次锁定。与 `locked` 是两件事：
   * 到期/从未设锁也会让 `locked` 为 false，但只有 `unlockedAt` 非空才算「家长放行」。
   * 仅桌面壳有意义（浏览器里没有 kiosk 可逃）——与 `lockValue` 用的是同一个闸门。
   */
  const unlockedByParent = isDesktopShell() && lock !== null && lock.unlockedAt !== null;
```

把 `return` 改成嵌套两个 provider：

```tsx
  return (
    <LearningLockContext.Provider value={lockValue}>
      <ParentUnlockContext.Provider value={unlockedByParent}>
        <Outlet />
      </ParentUnlockContext.Provider>
    </LearningLockContext.Provider>
  );
```

- [ ] **Step 5: 跑测试确认通过（含既有用例）**

Run: `cd apps/web && npx vitest run src/kiosk/LearningSessionShell.test.tsx src/kiosk/LockedPillReveal.test.tsx`

Expected: 全绿；尤其原有 5 条 `lock-probe` 为 `none` 的断言**没有任何改动**也必须过。

- [ ] **Step 6: 提交**

```bash
git add apps/web/src/kiosk/parentUnlockContext.ts apps/web/src/kiosk/LearningSessionShell.tsx apps/web/src/kiosk/LearningSessionShell.test.tsx
git commit -m "feat(kiosk): 下发「家长主动解除锁定」状态

新增 ParentUnlockContext，由 LearningSessionShell 从同一个 lock 派生，
不扩 LearningLockContext（避免放宽给值条件、破坏既有 pill 断言）。"
```

---

### Task 2: 考试页渲染返回入口

**Files:**
- Modify: `apps/web/src/pages/student/training/ExamRunPage.tsx`（import 区 + `headerExtra`，约 :264-277）
- Test: `apps/web/src/pages/student/training/ExamRunPage.test.tsx`

**Interfaces:**
- Consumes: `useParentUnlocked(): boolean`（Task 1）
- Produces: DOM 元素 `aria-label="返回考试列表"`（仅解锁时存在）

- [ ] **Step 1: 写失败测试**

在 `apps/web/src/pages/student/training/ExamRunPage.test.tsx` 的 import 区加：

```tsx
import { ParentUnlockContext } from '@/kiosk/parentUnlockContext';
```

把现有 `renderPage()` 换成带参数的版本（**保持默认行为不变**，既有用例仍按 `false` 跑）：

```tsx
/** RunExitGuard 用 useBlocker —— 必须是 data router；结果页与列表页给占位元素。 */
function renderPage(unlockedByParent = false) {
  const router = createMemoryRouter(
    [
      {
        path: '/student/training/exam/run/:sessionId',
        element: (
          <ParentUnlockContext.Provider value={unlockedByParent}>
            <ExamRunPage />
          </ParentUnlockContext.Provider>
        ),
      },
      { path: '/student/training/exam', element: <div>考试列表占位</div> },
      { path: '/student/training/exam/result/:sessionId', element: <div>结果页占位</div> },
    ],
    { initialEntries: ['/student/training/exam/run/77'] },
  );
  render(<RouterProvider router={router} />);
  return router;
}
```

在文件末尾追加新 describe：

```tsx
describe('ExamRunPage 家长解锁后的返回入口（spec 2026-11-12）', () => {
  beforeEach(() => {
    sessionMock.mockReset();
    answerMock.mockReset();
    submitMock.mockReset();
    answerMock.mockResolvedValue({ saved: true });
    sessionMock.mockResolvedValue(SESSION);
    sessionStorage.setItem('exam:session', JSON.stringify(SESSION));
  });

  it('家长未解锁 → 不渲染返回入口', async () => {
    renderPage(false);
    await waitFor(() => expect(screen.getByText('第 1 题')).toBeInTheDocument());

    expect(screen.queryByLabelText('返回考试列表')).toBeNull();
  });

  it('家长已解锁 → 出现返回入口；点击弹「离开考试」确认，确认后回到考试列表', async () => {
    const router = renderPage(true);
    await waitFor(() => expect(screen.getByLabelText('返回考试列表')).toBeInTheDocument());

    fireEvent.click(screen.getByLabelText('返回考试列表'));

    // 必须仍然被 RunExitGuard 拦住（不能绕过确认直接走）
    await waitFor(() => expect(screen.getByText('离开考试')).toBeInTheDocument());
    expect(router.state.location.pathname).toBe('/student/training/exam/run/77');

    fireEvent.click(screen.getByRole('button', { name: '确认离开' }));

    await waitFor(() => expect(router.state.location.pathname).toBe('/student/training/exam'));
    // 落点是考试列表，并带上当前学科（默认数学 = 1）
    expect(router.state.location.search).toBe('?subjectId=1');
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd apps/web && npx vitest run src/pages/student/training/ExamRunPage.test.tsx`

Expected: 「家长已解锁 → …」失败，报找不到 `返回考试列表`；「家长未解锁」通过。

- [ ] **Step 3: 实现**

`apps/web/src/pages/student/training/ExamRunPage.tsx`

import 区加两行（`components/base` 统一导出 `BackButton`）：

```tsx
import { BackButton } from '@/components/base';
import { useParentUnlocked } from '@/kiosk/parentUnlockContext';
```

组件内部、`guardRef` 附近加一行：

```tsx
  /** 家长主动解除锁定后，本页才给返回入口（未解锁时学生没有任何可见出口，这是既有设计）。 */
  const unlockedByParent = useParentUnlocked();
```

把 `headerExtra` 的容器改成（**返回按钮放在最左，用布局流，不用 absolute**，避免与右上角草稿按钮抢位置）：

```tsx
              headerExtra={
                <div className="flex shrink-0 items-center gap-4">
                  {unlockedByParent && (
                    <BackButton
                      to={`/student/training/exam?subjectId=${subjectId}`}
                      ariaLabel="返回考试列表"
                    />
                  )}
                  <span className="text-sm text-[var(--text-secondary)]">
                    已答 {answeredNs.size}/{questions.length}
                  </span>
                  <span
                    className="font-mono text-2xl font-bold tabular-nums"
                    style={{ color: remaining < LOW_TIME_SECONDS ? 'var(--error)' : 'var(--text-primary)' }}
                    aria-label="剩余时间"
                  >
                    {pad2(Math.floor(remaining / 60))}:{pad2(remaining % 60)}
                  </span>
                </div>
              }
```

同时把页面顶部注释里的「无 BackButton（考试中不可返回）」改成准确表述：

```tsx
/**
 * 考试进行页：限时答题 + 倒计时 + 续考恢复 + 归零自动交卷。
 * 常规不做页内退出；**家长主动解除锁定后**才在标题行给一个返回考试列表的入口
 * （spec 2026-11-12，PC App 专注模式下紧急退出）。答完末题即视为交卷（QuestionRunner onFinish）。
 */
```

- [ ] **Step 4: 跑测试确认通过**

Run: `cd apps/web && npx vitest run src/pages/student/training/ExamRunPage.test.tsx`

Expected: 全绿（原有 4 条 + 新增 2 条）。

- [ ] **Step 5: 提交**

```bash
git add apps/web/src/pages/student/training/ExamRunPage.tsx apps/web/src/pages/student/training/ExamRunPage.test.tsx
git commit -m "feat(exam): 家长解锁后考试页给出返回入口

仅在桌面壳 + 家长主动解除锁定时渲染 BackButton，点击仍走 RunExitGuard
确认，退回考试列表后由学生自行登出。"
```

---

### Task 3: 文档同步与全量验证

**Files:**
- Modify: `docs/constraints/pc-app-学习管控.md`
- Modify: `docs/ai-core-changelog.md`

**Interfaces:**
- Consumes: Task 1/2 的行为
- Produces: 无代码接口；只补口径

- [ ] **Step 1: 约束文档补口径**

在 `docs/constraints/pc-app-学习管控.md` 的「### 系统打断后的全屏恢复（2026-11-04）」**之前**插入：

```markdown
### 家长解锁后考试页的返回入口（2026-11-12）

- **「解除锁定」只放开登出，不改窗口锁定**：`studentMode` 仍为 true、仍是 kiosk、仍拦 `close`。
  学生必须走完「登出」（`releaseOnLogout()` → `setStudentMode(false)`）窗口才可关。**别把解锁做成关窗**。
- 考试页原本零出口（`ExamRunPage` 注释「考试无页内退出」）。现仅在**桌面壳 + `unlockedAt !== null`**
  时于标题行显示 `BackButton`（`aria-label="返回考试列表"`），点击仍走 `RunExitGuard` 确认。
- **判定通道是 `ParentUnlockContext`，不是 `LearningLockContext`**：后者只在锁定中才非 null，
  塞进去要放宽给值条件、会推翻 5 条「未锁定时不下发锁定态」的回归钉子。
  **禁止**在页面里读 `localStorage` 自判。
- **不扩到其它答题页**：专项/错题/变式/补偿/语文/英语页已有 X 或「退出」，学生能退到列表页登出。
- **锁自然到期不算解锁**：到期后考试页仍无出口（已知遗留，需要时另立）。**断网不解锁**这一条不变。
```

- [ ] **Step 2: changelog 追加**

在 `docs/ai-core-changelog.md` 的 `---` 之后（最新的 `## 2026-11-12 PC App 首屏连不上…` 之前）插入：

```markdown
## 2026-11-12 PC App 家长解锁后考试页出现返回入口（专注模式紧急退出）

**用户反馈**：学生进入考试等专注模式后遇紧急情况出不去；家长在家长端点【解除锁定】，
学生端仍然没有任何变化、也没有可点的出口，窗口又关不掉 → 死局。

**核查结论**：
1. 「解锁」只写 `unlocked_at`，唯一消费者是 `LogoutButton`（放开登出）；壳完全不知情，仍是 kiosk、仍拦 `close`；
2. 逐页核对后**只有考试页是零出口**（`ExamRunPage` 明写「考试无页内退出」），专项/错题/变式/补偿/语文/英语
   都有 X 或「退出」能退回列表页登出；
3. 所以缺陷是「解锁后考试页无任何可见变化」，不是「所有答题页都没出口」。

**修复**：
- 新增 `apps/web/src/kiosk/parentUnlockContext.ts`（`ParentUnlockContext` / `useParentUnlocked`）；
- `LearningSessionShell` 从既有 `lock` 派生 `unlockedByParent = isDesktopShell() && lock?.unlockedAt !== null` 下发；
  **不扩 `LearningLockContext`**（会放宽给值条件，推翻 5 条 pill 回归钉子）；
- `ExamRunPage` 在标题行渲染 `BackButton`（`aria-label="返回考试列表"`），点击经 `RunExitGuard` 确认后回考试列表；
- 壳、后端、API 文档均零改动；Web 端行为不变（`isDesktopShell()` 为假时恒不渲染）。

**明确不做**：断网兜底、锁到期后的考试页出口、其它答题页的解锁提示、自动关窗。

**验证**：`apps/web` 新增 6 条用例（壳 4 条、考试页 2 条）+ 全量 `npm test` / `npm run build` / `npm run lint`。
```

- [ ] **Step 3: 全量验证**

```bash
cd apps/web && npm test && npm run build && npm run lint
```

Expected: 全部通过；`tsc -b` 无类型错误（特别是 `useParentUnlocked` 的返回值被当布尔用）。

- [ ] **Step 4: 提交**

```bash
git add docs/constraints/pc-app-学习管控.md docs/ai-core-changelog.md
git commit -m "docs(pc-app): 补「家长解锁后考试页返回入口」口径与变更日志"
```

---

### Task 4: 手动验收（需要真壳 + 真服务）

> 自动化测试覆盖不到「壳里 kiosk 与窗口可关闭」，必须人走一遍。

- [ ] **Step 1: 起服务与壳**

按仓内既有方式起后端（`node dist/main.js`）与 Web（`npm run dev`），再 `cd apps/desktop && npm start`。
详细命令见 `apps/desktop/README`。

- [ ] **Step 2: 逐条验收**

1. 学生登录 → 进入考试 → 确认**没有**返回图标。
2. 家长端（另一设备/浏览器）【行为管控】→【解除锁定】→ 学生端 **≤10 秒**出现返回图标。
3. 点击 → 弹「离开考试」（文案含「计时不会暂停，可从考试列表续考返回」）→ 确认 → 回到考试列表。
4. 列表页右上角登出 → 回登录页 → 窗口红绿灯可用，能关闭。
5. 重开壳续考（未解锁）→ 返回图标不存在。
6. 用浏览器打开同一考试页 → 任何状态都看不到该图标。

- [ ] **Step 3: 记录结果**

把 6 条的实际结果写进 PR 描述或交付说明；若第 2 条超过 10 秒，先查学生端轮询是否在跑（`LearningSessionShell` 的 10 秒 interval），不要先怀疑 UI。

---

## Self-Review

**1. Spec coverage**

| Spec 章节 | 对应任务 |
|---|---|
| §2.1 显示条件（桌面壳 + `unlockedAt`） | Task 1（下发条件）+ Task 2（渲染条件） |
| §2.2 新增 `ParentUnlockContext` | Task 1 |
| §2.3 位置与外观（headerExtra、BackButton） | Task 2 Step 3 |
| §2.4 点击行为（不绕 guard、落点 URL） | Task 2 Step 1/3 |
| §2.5 时序（轮询 ≤10s / 刷新即时） | Task 1 测试 + Task 4 Step 2 |
| §3 边界（无锁/刷新/换学生/浏览器/断网） | Task 1 的 4 条用例 + 既有 learningLock 用例 |
| §4 验证 | Task 1/2 自动化 + Task 4 手动 |
| §5 遗留缺口 | 写进 Task 3 的两份文档，不写代码 |
| §6 文档同步 | Task 3 |

无遗漏。

**2. Placeholder scan**：本文所有代码块均为可直接粘贴的完整实现与完整测试，无 TBD / 「类似 Task N」/「适当加错误处理」。

**3. Type consistency**：`ParentUnlockContext: Context<boolean>`、`useParentUnlocked(): boolean`、`renderPage(unlockedByParent = false)`、`lock.unlockedAt: string | null` 在四个文件中一致；`BackButton` 的 prop 名为 `to` / `ariaLabel`（与 `BackButton.tsx:58` 一致）。
