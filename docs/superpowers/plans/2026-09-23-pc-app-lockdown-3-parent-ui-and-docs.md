# PC App 学习管控（3/3）：家长端 UI 与文档收尾 — 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让家长能设置「单次学习锁定」时长、能看到孩子每次的进入/退出时刻、并能远程解除锁定；同时把本设计与既有文档打通（**其中两处是推翻既有明文裁决**）。

**Architecture:** 复用 `/parent/controls`（行为管控）页新增第三块；仪表盘新增「学习时段」只读卡。文档同步集中在 Task 4、5。

**Tech Stack:** React + Vite + TS + Tailwind + Zustand；Vitest + @testing-library/react。

## Global Constraints

- **不使用 emoji**；图标必须是线性 SVG。
- **`globals: false`**：每个测试文件显式 import vitest 的 `afterEach/beforeEach/describe/expect/it/vi`，并自己写 `afterEach(() => cleanup())`。
- **派生状态必须带 `studentId` 归属**：家长端切孩子**不重挂载**页面，只按自身维度守卫会在切换首帧画出上个孩子的数据。**照抄** `ParentControlsPage.tsx:81-84` 的现有写法（`loaded = controls && controls.studentId === studentId ? controls : null`），**不要**用 `useEffect` 里 `setData(null)` 清空（effect 在 commit 之后才跑，会慢一帧）。
- **保存只发改动过的字段**：后端语义是「未提供即不动」，多带没变的字段等于把过期草稿写回库。
- **无改动 → 保存禁用**（P6.5 踩过「点了没反应」的坑）。
- **不碰 `LogoutButton` 的两个变体**（已被计划 2 改造过，本计划无关）。
- **文档改动必须与代码事实一致**：写完照着 `grep` 复核，别凭记忆写。

> **上游**：spec `docs/superpowers/specs/2026-09-23-pc-app-study-lockdown-design.md` §6.5、§9。
> **前置**：`…-1-backend.md`、`…-2-client-lock-and-shell.md` 必须已合并。

---

## 文件结构

| 文件 | 责任 |
|---|---|
| `apps/web/src/services/api.ts` | 加 `sessionLockMinutes` 到 `ParentControls`；新增 2 个家长端函数与 2 个类型 |
| `apps/web/src/pages/parent/ParentControlsPage.tsx` | 新增第三块「单次学习锁定」+「解除锁定」按钮；**改掉头部注释里"明确不做"那条** |
| `apps/web/src/pages/parent/ParentDashboardPage.tsx` | 新增「学习时段」卡 |
| `docs/K12智学系统-产品需求文档.md` 等 6 份设计文档 | Task 4 同步 |
| `CLAUDE.md` · `docs/ai-core-changelog.md` · `README.md` | Task 5 同步 |

---

## Task 1: `/parent/controls` 新增「单次学习锁定」与「解除锁定」

**Files:**
- Modify: `apps/web/src/services/api.ts`
- Modify: `apps/web/src/pages/parent/ParentControlsPage.tsx`
- Modify: `apps/web/src/pages/parent/ParentControlsPage.test.tsx`

**Interfaces:**
- Consumes: `PUT /api/parent/students/:id/controls` 的 `sessionLockMinutes`（计划 1 Task 3）、`POST …/device-commands` 与 `GET …/learning-sessions`（计划 1 Task 8、9）
- Produces:
  - `ParentControls` 增 `sessionLockMinutes: number | null`
  - `export interface ParentSessionItem { id: number; startedAt: string; endedAt: string | null; online: boolean; lockMinutes: number | null; lockExpiresAt: string | null; unlockedAt: string | null }`
  - `export interface ParentSessionPage { items: ParentSessionItem[]; total: number }`
  - `export function getParentLearningSessions(studentId: number, days?: number, limit?: number): Promise<ParentSessionPage>`
  - `export function issueParentDeviceCommand(studentId: number, command: 'unlock'): Promise<{ id: number; command: string; status: 'pending'; learningSessionId: number; createdAt: string }>`

- [ ] **Step 1: 扩展 API 层**

`apps/web/src/services/api.ts`：把 `ParentControls` 接口改为

```ts
/** `GET|PUT /api/parent/students/:id/controls` —— 行为管控。 */
export interface ParentControls {
  /** 孩子切走页面连续多少分钟算「离开」（1..180，默认 5）。 */
  alertAwayMinutes: number;
  /** 孩子前台无操作连续多少分钟算「走神」（1..180，默认 15）。 */
  alertIdleMinutes: number;
  /**
   * 单次学习锁定分钟数（1..480）。`null` = 未设锁。
   * 语义是**学生登录起算的墙钟窗口**，不是每日累计（旧 `daily_time_limit_minutes` 已于 2026-09-23 改名废除此语义）。
   */
  sessionLockMinutes: number | null;
}
```

在 `putParentControls` 之后追加：

```ts
// --- Parent: PC App 学习管控（spec §5.4/§5.5）---

/** 家长端「进出时间」的一行。`online` 由后端算好下发，**前端不重算阈值**。 */
export interface ParentSessionItem {
  id: number;
  startedAt: string;
  /** `null` = 仍在进行中。 */
  endedAt: string | null;
  online: boolean;
  lockMinutes: number | null;
  lockExpiresAt: string | null;
  unlockedAt: string | null;
}

export interface ParentSessionPage {
  items: ParentSessionItem[];
  total: number;
}

/** 孩子每次进入/退出 PC App 的记录（近 `days` 天，倒序）。 */
export function getParentLearningSessions(
  studentId: number,
  days = 7,
  limit = 50,
): Promise<ParentSessionPage> {
  return fetchApi<ParentSessionPage>(
    `/parent/students/${studentId}/learning-sessions?days=${days}&limit=${limit}`,
  );
}

/**
 * 下发设备命令。本期只有 `'unlock'`。
 *
 * 服务端在**没有进行中会话时返回 409/1001**，所以调用方要么先确认有进行中的会话
 * （`getParentLearningSessions` 的 `items[0].endedAt === null`），要么把 409 的 message 展示出来。
 */
export function issueParentDeviceCommand(
  studentId: number,
  command: 'unlock',
): Promise<{ id: number; command: string; status: 'pending'; learningSessionId: number; createdAt: string }> {
  return fetchApi(`/parent/students/${studentId}/device-commands`, {
    method: 'POST',
    body: JSON.stringify({ command }),
  });
}
```

- [ ] **Step 2: 写失败的测试（追加到 `ParentControlsPage.test.tsx`）**

在该文件顶部 mock 里补两个新函数，并加新 describe：

```tsx
// 顶部 vi.mock('@/services/api', …) 的返回对象里补：
//   getParentLearningSessions: vi.fn(),
//   issueParentDeviceCommand: vi.fn(),

const getSessionsMock = vi.mocked(getParentLearningSessions);
const issueCommandMock = vi.mocked(issueParentDeviceCommand);

const SESSION_RUNNING: ParentSessionItem = {
  id: 7,
  startedAt: '2026-09-23T01:00:00.000Z',
  endedAt: null,
  online: true,
  lockMinutes: 60,
  lockExpiresAt: '2026-09-23T02:00:00.000Z',
  unlockedAt: null,
};
```

在 `beforeEach` 里补：

```tsx
  getControlsMock.mockResolvedValue({ ...CONTROLS, sessionLockMinutes: 60 });
  getSessionsMock.mockReset();
  getSessionsMock.mockResolvedValue({ items: [SESSION_RUNNING], total: 1 });
  issueCommandMock.mockReset();
  issueCommandMock.mockResolvedValue({
    id: 3,
    command: 'unlock',
    status: 'pending',
    learningSessionId: 7,
    createdAt: '2026-09-23T01:10:00.000Z',
  });
```

并把文件里现有的 `const CONTROLS: ParentControls = { alertAwayMinutes: 5, alertIdleMinutes: 15 };` 补成：

```tsx
const CONTROLS: ParentControls = { alertAwayMinutes: 5, alertIdleMinutes: 15, sessionLockMinutes: null };
```

新增 describe：

```tsx
describe('ParentControlsPage：单次学习锁定（spec §6.5）', () => {
  it('渲染接口值；未设锁时输入框为空、显示「当前：未设锁」', async () => {
    renderPage();
    expect(await screen.findByTestId('lock-minutes-input')).toHaveValue(null);
    expect(screen.getByTestId('lock-status')).toHaveTextContent('未设锁');
  });

  it('已设锁时回显分钟数', async () => {
    getControlsMock.mockResolvedValue({ ...CONTROLS, sessionLockMinutes: 90 });
    renderPage();
    expect(await screen.findByTestId('lock-minutes-input')).toHaveValue(90);
    expect(screen.getByTestId('lock-status')).toHaveTextContent('90 分钟');
  });

  it('越界（0 / 481）→ 行内报错 + 保存禁用 + **不发请求**', async () => {
    renderPage();
    const input = await screen.findByTestId('lock-minutes-input');
    fireEvent.change(input, { target: { value: '481' } });

    expect(screen.getByText('请填 1–480 的整数')).toBeInTheDocument();
    expect(screen.getByTestId('save-controls')).toBeDisabled();
    fireEvent.click(screen.getByTestId('save-controls'));
    expect(putControlsMock).not.toHaveBeenCalled();
  });

  it('清空输入框 = 解除设置，保存时发 **null**（不是省略该字段）', async () => {
    getControlsMock.mockResolvedValue({ ...CONTROLS, sessionLockMinutes: 60 });
    renderPage();
    const input = await screen.findByTestId('lock-minutes-input');
    fireEvent.change(input, { target: { value: '' } });
    fireEvent.click(screen.getByTestId('save-controls'));

    await waitFor(() =>
      expect(putControlsMock).toHaveBeenCalledWith(1, { sessionLockMinutes: null }),
    );
  });

  it('**只发改动过的字段**：改锁定时长不会把预警阈值一起带上', async () => {
    renderPage();
    const input = await screen.findByTestId('lock-minutes-input');
    fireEvent.change(input, { target: { value: '120' } });
    fireEvent.click(screen.getByTestId('save-controls'));

    await waitFor(() => expect(putControlsMock).toHaveBeenCalledWith(1, { sessionLockMinutes: 120 }));
  });

  it('保存成功回显服务端值', async () => {
    putControlsMock.mockResolvedValue({ ...CONTROLS, sessionLockMinutes: 120 });
    renderPage();
    const input = await screen.findByTestId('lock-minutes-input');
    fireEvent.change(input, { target: { value: '120' } });
    fireEvent.click(screen.getByTestId('save-controls'));

    await waitFor(() => expect(toastMock).toHaveBeenCalledWith('success', expect.stringContaining('120')));
  });

  it('有进行中的会话 → 解除按钮可点，点击后下发 unlock', async () => {
    renderPage();
    const button = await screen.findByTestId('unlock-button');
    expect(button).not.toBeDisabled();

    fireEvent.click(button);

    await waitFor(() => expect(issueCommandMock).toHaveBeenCalledWith(1, 'unlock'));
  });

  it('**没有**进行中的会话 → 解除按钮禁用并说明原因（不硬发请求）', async () => {
    getSessionsMock.mockResolvedValue({ items: [], total: 0 });
    renderPage();

    const button = await screen.findByTestId('unlock-button');
    expect(button).toBeDisabled();
    expect(screen.getByTestId('unlock-hint')).toHaveTextContent('当前没有进行中的学习');
    fireEvent.click(button);
    expect(issueCommandMock).not.toHaveBeenCalled();
  });

  it('会话列表加载失败 → 解除按钮**保持可点**（交给服务端判 409），不把家长卡死', async () => {
    getSessionsMock.mockRejectedValue(new ApiError(500, 'boom'));
    renderPage();
    expect(await screen.findByTestId('unlock-button')).not.toBeDisabled();
  });

  it('切孩子时锁定值不许串台（派生状态带 studentId 归属）', async () => {
    getControlsMock.mockResolvedValue({ ...CONTROLS, sessionLockMinutes: 90 });
    const { rerender } = renderPage();
    expect(await screen.findByTestId('lock-minutes-input')).toHaveValue(90);

    getControlsMock.mockResolvedValue({ ...CONTROLS, sessionLockMinutes: 30 });
    useParentStudentStore.setState({ studentId: 2 });
    rerender(
      <MemoryRouter>
        <ParentControlsPage />
      </MemoryRouter>,
    );

    await waitFor(() => expect(screen.getByTestId('lock-minutes-input')).toHaveValue(30));
  });
});
```

- [ ] **Step 3: 跑测试确认失败**

Run: `cd apps/web && npx vitest run src/pages/parent/ParentControlsPage.test.tsx`
Expected: FAIL —— `lock-minutes-input` / `unlock-button` 找不到。

- [ ] **Step 4: 改页面头部注释（**别跳过这步**）**

`ParentControlsPage.tsx:22-23` 现在写着：

```
 * **明确不做**（别照 PRD/UX 原文加回来）：每日最大使用时长、禁用时段、
 * 辅线访问开关、拍照解题开关 —— 四项均已裁决不做，`controls` 表里那几列保留待用。
```

改为：

```
 * **明确不做**（别照 PRD/UX 原文加回来）：每日最大使用时长（概念已于 2026-09-23 废除，
 * 见下）、禁用时段、辅线访问开关、拍照解题开关 —— 后三项仍裁决不做，`controls` 表里
 * 那几列保留待用。
 *
 * 2026-09-23 新增第三块「单次学习锁定」：`controls.session_lock_minutes`（1..480）。
 * 它是**单次登录起算的墙钟窗口**，**不是**被废除的「每日累计上限」——旧列
 * `daily_time_limit_minutes` 已在同一次迁移中改名并改语义，别再按每日累计去实现。
```

并把第一段「本页**只有两块**」改为「本页**共三块**」。

- [ ] **Step 5: 实现第三块**

在 `ParentControlsPage.tsx` 里：

1. 常量区新增：

```ts
/** 「单次学习锁定」范围（spec §5.6）。null = 未设锁。 */
const LOCK_MINUTES_MIN = 1;
const LOCK_MINUTES_MAX = 480;
const LOCK_MINUTES_ERROR = `请填 ${LOCK_MINUTES_MIN}–${LOCK_MINUTES_MAX} 的整数，或留空表示不设锁`;

/**
 * 解析锁定输入框原值。
 * 返回 `number | null | undefined`：`undefined` = 非法；`null` = 空（= 不设锁）；数字 = 合法值。
 * 空串是**合法**的（解除设置），这与上面 `parseMinutes` 把空串当非法**不同**，别复用那个。
 */
function parseLockMinutes(raw: string): number | null | undefined {
  if (raw.trim() === '') return null;
  if (!/^\d+$/.test(raw)) return undefined;
  const value = Number(raw);
  return value >= LOCK_MINUTES_MIN && value <= LOCK_MINUTES_MAX ? value : undefined;
}
```

2. `LoadedControls` 接口加两个字段（`lock: string` 与快照基准已由 `snapshot` 承担）：

```ts
interface LoadedControls {
  studentId: number;
  /** 输入框原值（字符串），不要 Number() 后回写。 */
  away: string;
  idle: string;
  /** 单次学习锁定输入框原值；空串 = 未设锁。 */
  lock: string;
  /** 服务器快照（判脏基准 + 只发改动字段的对照）。 */
  snapshot: ParentControls;
}
```

3. 拉取 controls 的 effect 里补 `lock: res.sessionLockMinutes === null ? '' : String(res.sessionLockMinutes)`；`doSave` 成功后的 `setControls` 同样补 `lock`。

4. 新增会话状态与拉取 effect：

```tsx
  /** 进行中的学习会话（用来决定「解除锁定」按钮可否点）。`null` = 未知/加载失败。 */
  const [activeSessionId, setActiveSessionId] = useState<number | null>(null);
  const [activeSessionStudentId, setActiveSessionStudentId] = useState<number | null>(null);
  const [unlocking, setUnlocking] = useState(false);
  const [sessionsReload, setSessionsReload] = useState(0);

  useEffect(() => {
    if (studentId === null) return;
    let cancelled = false;
    getParentLearningSessions(studentId, 1, 1)
      .then((res) => {
        if (cancelled) return;
        const open = res.items.find((item) => item.endedAt === null) ?? null;
        setActiveSessionId(open ? open.id : null);
        setActiveSessionStudentId(studentId);
      })
      .catch(() => {
        // 加载失败 → 保持 null **但标记归属**，按钮维持可点，交给服务端判 409。
        if (cancelled) return;
        setActiveSessionId(null);
        setActiveSessionStudentId(studentId);
      });
    return () => {
      cancelled = true;
    };
  }, [studentId, sessionsReload]);
```

5. 派生与保存逻辑：

```tsx
  const parsedLock = loaded ? parseLockMinutes(loaded.lock) : undefined;
  const lockError = parsedLock === undefined;
  const lockChanged =
    parsedLock !== undefined &&
    parsedLock !== (loaded?.snapshot.sessionLockMinutes ?? null);
  const dirty = awayChanged || idleChanged || lockChanged;
  const canSave = dirty && !awayError && !idleError && !lockError && !saving;

  const sessionsKnown = activeSessionStudentId === studentId;
  const canUnlock = sessionsKnown && !unlocking;
  const unlockHint =
    sessionsKnown && activeSessionId === null ? '当前没有进行中的学习，无需解除' : null;
```

`doSave` 里补：

```tsx
    if (lockChanged && parsedLock !== undefined) body.sessionLockMinutes = parsedLock;
```

和保存成功后的 toast：把现有那句改成按改动字段拼（改动多块时别只报预警那两个）：

```tsx
      toast(
        'success',
        lockChanged
          ? `已保存：单次学习锁定 ${next.sessionLockMinutes === null ? '未设' : `${next.sessionLockMinutes} 分钟`}`
          : `已保存：离开页面 ${next.alertAwayMinutes} 分钟 / 无操作 ${next.alertIdleMinutes} 分钟`,
      );
```

6. 新增 `doUnlock`：

```tsx
  /**
   * 解除锁定（spec §5.4）。服务端在没有进行中会话时返回 409/1001，
   * 所以 `canUnlock` 只是**前置提示**，真正的闸门在服务端；这里不因为本地判断而放弃请求。
   */
  const doUnlock = async () => {
    if (studentId === null || unlocking) return;
    setUnlocking(true);
    try {
      await issueParentDeviceCommand(studentId, 'unlock');
      toast('success', '已解除锁定，孩子现在可以退出学习');
      setSessionsReload((n) => n + 1);
    } catch (err: unknown) {
      toast('error', err instanceof ApiError && err.message ? err.message : '解除失败');
    } finally {
      setUnlocking(false);
    }
  };
```

7. JSX：在 `controls-form` 那张 Card 之后、`controls-rewards` Card 之前插入第三块：

```tsx
      <Card data-testid="controls-lock" className="mt-4 p-6">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <h2 className="text-base font-bold text-[var(--text-primary)]">单次学习锁定</h2>
            <p className="mt-0.5 text-xs text-[var(--text-secondary)]">
              孩子登录学习端后，下面这段时间内**不能退出登录**，到点自动解除；也可以随时手动解除。
              留空表示不设锁。
            </p>
          </div>
          <span data-testid="lock-status" className="text-sm text-[var(--text-secondary)]">
            {loaded.snapshot.sessionLockMinutes === null
              ? '当前：未设锁'
              : `当前：${loaded.snapshot.sessionLockMinutes} 分钟`}
          </span>
        </div>

        <div className="mt-5 flex flex-wrap items-end gap-4">
          <Input
            label="锁定时长（分钟，1–480）"
            data-testid="lock-minutes-input"
            type="number"
            min={LOCK_MINUTES_MIN}
            max={LOCK_MINUTES_MAX}
            step={1}
            inputMode="numeric"
            value={loaded.lock}
            disabled={saving}
            error={lockError ? LOCK_MINUTES_ERROR : undefined}
            onChange={(e) => patch((prev) => ({ ...prev, lock: e.target.value }))}
          />
          <Button
            variant="secondary"
            size="sm"
            loading={unlocking}
            disabled={!canUnlock}
            data-testid="unlock-button"
            onClick={() => void doUnlock()}
          >
            解除锁定
          </Button>
        </div>

        {unlockHint && (
          <p data-testid="unlock-hint" className="mt-2 text-xs text-[var(--text-secondary)]">
            {unlockHint}
          </p>
        )}
      </Card>
```

> 该页的「保存」按钮是所有字段共用的（`save-controls`），所以改锁定值也是点同一个按钮——**不要**给第三块单独加一个保存按钮，否则会出现两个「保存」让家长猜哪个生效。

- [ ] **Step 6: 跑测试**

Run: `cd apps/web && npx vitest run src/pages/parent/ParentControlsPage.test.tsx`
Expected: PASS（含原有全部用例）。

- [ ] **Step 7: 跑全量 + 类型 + lint**

Run: `cd apps/web && npm test && npx tsc -b && npm run lint`
Expected: 全绿、无输出、0 error。

- [ ] **Step 8: Commit**

```bash
git add apps/web/src/services/api.ts apps/web/src/pages/parent/ParentControlsPage.tsx apps/web/src/pages/parent/ParentControlsPage.test.tsx
git commit -m "feat(parent-controls): 单次学习锁定设置与解除按钮（清空=解除设置，恢复每日上限口径注释）"
```

---

## Task 2: 仪表盘「学习时段」卡

**Files:**
- Modify: `apps/web/src/pages/parent/ParentDashboardPage.tsx`
- Modify: `apps/web/src/pages/parent/ParentDashboardPage.test.tsx`

**Interfaces:**
- Consumes: `getParentLearningSessions`、`ParentSessionItem`（Task 1）
- Produces: 页面内组件 `LearningTimelineCard`（**不导出**，与同文件既有的 `StudyTimePanel` 一致）

- [ ] **Step 1: 写失败的测试**

在 `ParentDashboardPage.test.tsx` 追加（并在顶部 `vi.mock('@/services/api', …)` 里补 `getParentLearningSessions: vi.fn()`）：

```tsx
const getSessionsMock = vi.mocked(getParentLearningSessions);

const SESSIONS: ParentSessionPage = {
  items: [
    {
      id: 7,
      startedAt: '2026-09-23T01:00:00.000Z',
      endedAt: null,
      online: true,
      lockMinutes: 60,
      lockExpiresAt: '2026-09-23T02:00:00.000Z',
      unlockedAt: null,
    },
    {
      id: 6,
      startedAt: '2026-09-22T09:00:00.000Z',
      endedAt: '2026-09-22T09:40:00.000Z',
      online: false,
      lockMinutes: null,
      lockExpiresAt: null,
      unlockedAt: null,
    },
  ],
  total: 2,
};

describe('仪表盘：学习时段卡（spec §6.5）', () => {
  it('渲染每次进入/退出时刻 + 在线状态', async () => {
    getSessionsMock.mockResolvedValue(SESSIONS);
    renderPage();

    expect(await screen.findByTestId('learning-timeline')).toBeInTheDocument();
    expect(screen.getByTestId('session-7')).toHaveTextContent('进行中');
    expect(screen.getByTestId('session-6')).toHaveTextContent('已退出');
  });

  it('**不聚合**：两次会话渲染两行（这是「进出时间」与既有聚合卡的本质区别）', async () => {
    getSessionsMock.mockResolvedValue(SESSIONS);
    renderPage();
    await screen.findByTestId('learning-timeline');
    expect(screen.getAllByTestId(/^session-/)).toHaveLength(2);
  });

  it('空态是正常态（不是错误）', async () => {
    getSessionsMock.mockResolvedValue({ items: [], total: 0 });
    renderPage();
    expect(await screen.findByTestId('learning-timeline-empty')).toHaveTextContent(
      '近 7 天还没有学习记录',
    );
  });

  it('加载失败 → 有重试，且**不拖垮同页其他卡**', async () => {
    getSessionsMock.mockRejectedValue(new ApiError(500, 'boom'));
    renderPage();
    expect(await screen.findByTestId('learning-timeline-error')).toBeInTheDocument();
    expect(screen.getByTestId('learning-timeline-retry')).toBeInTheDocument();
  });

  it('切孩子 → 重新取该孩子的记录', async () => {
    getSessionsMock.mockResolvedValue(SESSIONS);
    renderPage();
    await screen.findByTestId('learning-timeline');

    useParentStudentStore.setState({ studentId: 2 });
    await waitFor(() => expect(getSessionsMock).toHaveBeenCalledWith(2, 7, 10));
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd apps/web && npx vitest run src/pages/parent/ParentDashboardPage.test.tsx`
Expected: FAIL —— `learning-timeline` 找不到。

- [ ] **Step 3: 实现卡片**

在 `ParentDashboardPage.tsx` 里新增（与既有 `StudyTimePanel` 同风格：局部状态 + 归属标记 + 独立失败态）：

```tsx
/** 时刻格式化：只给家长看「几点几分」，不显示秒与时区噪音。 */
function formatClock(iso: string): string {
  const d = new Date(iso);
  return `${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

/**
 * 学习时段（spec §6.5）。
 *
 * 与同页「学习时长」卡的本质区别：**这条是列表、不是聚合**——家长要看的是「几点进去、
 * 几点出来」。数据源是 `learning_sessions`（**登录粒度**），不是 `study_sessions`
 * （学习页粒度，且只有聚合值可用）。
 *
 * `online` 由后端算好下发（阈值真源在后端），这里**不重算**。
 */
function LearningTimelineCard({ studentId }: { studentId: number }) {
  const [state, setState] = useState<{ studentId: number; page: ParentSessionPage } | null>(null);
  const [failedStudentId, setFailedStudentId] = useState<number | null>(null);
  const [reload, setReload] = useState(0);

  useEffect(() => {
    let cancelled = false;
    getParentLearningSessions(studentId, 7, 10)
      .then((page) => {
        if (cancelled) return;
        setState({ studentId, page });
        setFailedStudentId(null);
      })
      .catch(() => {
        if (cancelled) return;
        setState(null);
        setFailedStudentId(studentId);
      });
    return () => {
      cancelled = true;
    };
  }, [studentId, reload]);

  const page = state && state.studentId === studentId ? state.page : null;
  const failed = failedStudentId === studentId;

  return (
    <Card data-testid="learning-timeline" className="p-6">
      <h2 className="text-base font-bold text-[var(--text-primary)]">学习时段（近 7 天）</h2>
      <p className="mt-0.5 text-xs text-[var(--text-secondary)]">
        孩子每次进入和退出学习端的时间。这里只记 PC App 上的学习。
      </p>

      {failed ? (
        <div className="mt-4">
          <div data-testid="learning-timeline-error" className="flex flex-wrap items-center justify-between gap-4">
            <span className="text-sm text-[var(--text-secondary)]">学习时段暂时加载失败</span>
            <Button variant="secondary" size="sm" data-testid="learning-timeline-retry" onClick={() => setReload((n) => n + 1)}>
              重试
            </Button>
          </div>
        </div>
      ) : page === null ? (
        <div className="mt-4">
          <Skeleton width="100%" height={96} rounded />
        </div>
      ) : page.items.length === 0 ? (
        <p data-testid="learning-timeline-empty" className="mt-4 text-sm text-[var(--text-secondary)]">
          近 7 天还没有学习记录
        </p>
      ) : (
        <ul className="mt-4 divide-y divide-[var(--bg-subtle)]">
          {page.items.map((item) => (
            <li key={item.id} data-testid={`session-${item.id}`} className="flex items-center justify-between gap-4 py-2">
              <span className="text-sm text-[var(--text-primary)]">{formatClock(item.startedAt)}</span>
              <span className="text-sm text-[var(--text-secondary)]">
                {item.endedAt === null ? '进行中' : `→ ${formatClock(item.endedAt)}`}
              </span>
              <span
                className={
                  item.online
                    ? 'text-xs font-medium text-[var(--brand-600)]'
                    : 'text-xs text-[var(--text-secondary)]'
                }
              >
                {item.endedAt === null ? (item.online ? '在线' : '已断开') : '已退出'}
              </span>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}
```

在页面 JSX 里，把这张卡放在既有「学习时长」卡附近（`{studentId !== null && <LearningTimelineCard studentId={studentId} />}`），**插在既不遮住「今日已用」也不抢首位的位置**——它是补充信息，不是主指标。

- [ ] **Step 4: 跑测试**

Run: `cd apps/web && npx vitest run src/pages/parent/ParentDashboardPage.test.tsx`
Expected: PASS。

- [ ] **Step 5: 跑全量 + 类型 + lint**

Run: `cd apps/web && npm test && npx tsc -b && npm run lint`
Expected: 全绿。

- [ ] **Step 6: Commit**

```bash
git add apps/web/src/pages/parent/ParentDashboardPage.tsx apps/web/src/pages/parent/ParentDashboardPage.test.tsx
git commit -m "feat(parent-dashboard): 学习时段卡（列表不聚合，在线状态由后端算好下发）"
```

---

## Task 3: 端到端联调与截图核对

**Files:** 无（验证任务）

- [ ] **Step 1: 起四个进程**

```bash
cd apps/server && npm run build && node dist/main.js   # 终端 1
cd apps/web && npm run dev                              # 终端 2
cd apps/desktop && npm start                            # 终端 3（可选，也可只用浏览器）
cd apps/web && npm run preview                          # 可选：验证生产构建
```

- [ ] **Step 2: 走一遍完整链路（家长视角在浏览器，学生视角在壳）**

| # | 操作 | 期望 |
|---|---|---|
| 1 | 家长在 `/parent/controls` 设 60 分钟并保存 | 成功 toast 回显 60；刷新后仍是 60 |
| 2 | 家长在仪表盘看「学习时段」 | 若孩子没登录过 → 空态；有过 → 看到记录 |
| 3 | 学生在壳里登录 | 壳全屏，pill「剩余 60 分钟」，退出登录被拒 |
| 4 | 家长刷新仪表盘 | 出现一条「进行中 · 在线」 |
| 5 | 家长点「解除锁定」 | 成功 toast；学生端 ≤10 秒 pill 消失、可登出 |
| 6 | 学生登出 | 仪表盘那条变成「已退出」并带退出时刻，不再是「进行中」 |
| 7 | 家长清空锁定输入框并保存 | 「当前：未设锁」；学生重新登录后无 pill、可随时登出 |
| 8 | 学生**断网**后家长点解除 | 学生端**仍然锁着**（拔网线不解锁）；恢复网络后 ≤10 秒解锁 |

- [ ] **Step 3: 失败即修，并把结论写进 changelog**

若第 8 条不符预期，说明"拔网线不解锁"没做对——**先改设计再改代码**（本仓纪律），不要在实现里打补丁绕过去。

- [ ] **Step 4: Commit（若有修正）**

```bash
git add -A
git commit -m "fix(parent-ui): 端到端联调第 N 条 — <现象>"
```

---

## Task 4: 设计文档同步（6 份）

**Files:**
- Modify: `docs/K12智学系统-产品需求文档.md`
- Modify: `docs/UX-UI设计文档.md`
- Modify: `docs/K12智学系统-架构设计文档.md`
- Modify: `apps/web/style.md`
- Modify: `docs/K12智学系统-数据库设计文档.md`
- Modify: `docs/家长端学情批-完成情况与待办清单.md`
- Modify: `docs/superpowers/specs/2026-09-20-parent-controls-and-alerts-design.md`

> ⚠️ **其中三处是推翻既有明文裁决**（PRD 的三栏/无密码校验、P6.6 的"时长不做"）。不改就是没做——下个接手者会照旧文档反向实现。

- [ ] **Step 1: PRD**

`docs/K12智学系统-产品需求文档.md`：
1. §7.7 家长端附近新增一小节 **「PC App 学习管控（正式版）」**：单次学习锁定（1..480 分钟，学生登录起算、期间禁止登出、到期自动解除、家长可远程解除）、家长端可见每次进入/退出时刻。
2. `:224`「MVP 阶段…**无需额外的 PIN 码、图形锁或独立密码等安全校验**」加脚注：这是 **MVP 同设备共存**口径；PC App 的锁定与家长解除属**正式版**能力，与 §13 的「物理设备隔离」（`:225`）同源。
3. `:341-343`（输入方式）保持不变。

- [ ] **Step 2: UX/UI**

`docs/UX-UI设计文档.md`：
1. `:708`「**PC App**：扩展为三栏（导航+卡片+讨论），右侧增加学情侧边栏」→ 改为「**PC App**：布局与 Web 完全一致（**不做三栏**，2026-09-23 用户裁决）」。
2. `:760`（§9.1 P1 列表）里的「PC App 三栏扩展」→ 改为「PC App 学习管控（kiosk + 单次学习锁定）」。
3. `:233-234`「MVP 阶段家长与学生可共用同一设备，退出登录切换身份即可；正式版迭代时再做物理设备隔离」→ 追加指向本设计（`docs/superpowers/specs/2026-09-23-pc-app-study-lockdown-design.md`），并说明"物理设备隔离"的落地形态就是 PC App 的 kiosk + 家长解除。
4. 新增一节 **PC App 学习管控页规格**：`/parent/controls` 第三块（锁定时长输入 1..480 + 解除按钮 + 当前状态文案）、仪表盘「学习时段」卡（列表、在线/已断开/已退出三态）、学生端锁定中的剩余时间 pill（顶部居中）。

- [ ] **Step 3: 架构文档**

`docs/K12智学系统-架构设计文档.md`：
1. `:1145`（§10.2 P1）「PC App 三栏布局」→ 改为「PC App（Electron 壳 + kiosk 学习管控）」。
2. `:41` 客户端层那行 `│ PC App │ (Electron)` 旁加注释：PC App 加载与 Web 相同的 UI；学生角色进 kiosk、家长/管理员为普通窗口；**真·无法切屏需 OS 级单应用模式（运维配置）**。

- [ ] **Step 4: style.md**

`apps/web/style.md:485`「**PC App**：学习沉浸层可扩展为三栏…非学习页卡片保持居中最大宽度」→ 改为「**PC App**：与 Web 使用同一套布局（≥1280px 不另做三栏）。锁定中的剩余时间 pill 用 `--brand-*` 令牌，不使用第二套配色」。

- [ ] **Step 5: 数据库设计文档**

`docs/K12智学系统-数据库设计文档.md`：
1. `controls` 一节：`daily_time_limit_minutes` → `session_lock_minutes`，注释写「单次学习锁定分钟数（1..480），学生登录起算；`NULL` = 未设锁」。
2. 新增 `learning_sessions`、`device_commands` 两表的结构说明（照抄 spec §4.2/§4.3），并**明确写出 `active_student_id` 是条件式 VIRTUAL 生成列、必须 VIRTUAL 不能 STORED**（把 `2026-09-22_remediation_sets_active_unique.sql` 里那条 1215 教训一并带过来）。
3. `study_sessions` 的 `app_shell` 说明补一句：Electron 壳的学生端同时会写 `learning_sessions`（登录粒度），两者**粒度不同、不要合并**。
4. `:1118` 附近若有「`daily_time_limit_minutes` 恒为 NULL」的表述，一并更新为「已改名并改为单次锁定语义，读写在 2026-09-23 落地」。

- [ ] **Step 6: 待办清单与 P6.6 spec**

`docs/家长端学情批-完成情况与待办清单.md:301`「**只算不拦** … 没有任何地方阻止学生继续用。家长设了会以为有用」→ 改为已完成（2026-09-23）：每日累计上限**已废除**，改为「单次学习锁定」（期间禁止登出，到期自动解除，家长可远程解除），并附 spec 路径。

`docs/superpowers/specs/2026-09-20-parent-controls-and-alerts-design.md` 的 `:43`（「本批不做，页面上也不出现」）与 `:71`（「每日最大使用时长 / 禁用时段的学生端强制 | 用户裁决暂不做；需要时单独立项」）各加一行标注：

```
> **2026-09-23 更新**：本条已被 `docs/superpowers/specs/2026-09-23-pc-app-study-lockdown-design.md` 推翻并落地
> —— 即当年记的「需要时单独立项」那次立项。注意语义已从「每日累计上限」改为「单次登录起算的锁定窗口」。
```

- [ ] **Step 7: 复核（用 grep 而不是眼睛）**

Run:
```bash
cd /Users/lichao/Downloads/claude/imooc/ai_k12 && echo "--- 应为 0（三栏承诺已清）---" && grep -rn "PC App 三栏\|三栏布局" docs/ apps/web/style.md | grep -v "不做三栏" | grep -v "不另做三栏" ; echo "--- 应为 0（每日上限已清）---" && grep -rn "daily_time_limit_minutes\|每日最大使用时长" docs/ apps/ | grep -v "已改名\|已废除\|已被.*推翻\|改名并改语义" ; echo "--- 应 >0（新字段已写）---" && grep -rc "session_lock_minutes" docs/K12智学系统-数据库设计文档.md
```
Expected: 前两段无输出，第三段 ≥ 1。**有输出就是漏改**。

- [ ] **Step 8: Commit**

```bash
git add docs/K12智学系统-产品需求文档.md docs/UX-UI设计文档.md docs/K12智学系统-架构设计文档.md apps/web/style.md docs/K12智学系统-数据库设计文档.md docs/家长端学情批-完成情况与待办清单.md docs/superpowers/specs/2026-09-20-parent-controls-and-alerts-design.md
git commit -m "docs: 同步 PC App 学习管控 —— 推翻三栏承诺与 P6.6『时长不做』裁决"
```

---

## Task 5: `CLAUDE.md` · changelog · README

**Files:**
- Modify: `CLAUDE.md`
- Modify: `docs/ai-core-changelog.md`
- Modify: `README.md`

- [ ] **Step 1: `CLAUDE.md` 四处改动**

1. **家长端章节**：删掉「P6.6 只做「预警灵敏度 + 奖励兑换只读」：每日时长 / 禁用时段 / 辅线开关 / 拍照开关**不做、页面上也不出现**」里的「每日时长」，改为「禁用时段 / 辅线开关 / 拍照开关**仍不做、页面上也不出现**（`controls` 表那几列保留待用）」。
2. **家长端章节**补一条：`controls` 端点现在含**三个**字段（两个预警阈值 + `session_lock_minutes`）。⚠️ 这里仍要保留「同一字段不做两个归属」的口径说明（兑换字段仍归 `points/settings`）。
3. **API 文档同步规则**一节：把「本仓**无端点用 `@HttpCode` 覆盖**」改为「本仓**唯一**的 `@HttpCode` 覆盖是 `POST /api/student/learning-sessions`（幂等取或建，显式 200 而非 201）」。
4. **新增一节「PC App 学习管控（2026-09-23）」**，只放**仍生效的硬约束**：
   - 布局：PC App 与 Web **完全相同**，**不做三栏**（推翻 UX/架构的 P1 承诺）。
   - 锁定由**角色**驱动：学生 → 真全屏 kiosk；`parent`/`admin` → 普通窗口。
   - **禁退三处缺一即逃逸口**：`LogoutButton` 自判（`aria-disabled` **不给原生 `disabled`**，否则 toast 弹不出来，且**不许改 `aria-label`**——4 个测试靠它断言）/ 壳拦 `close`·`before-quit`·`minimize` / 壳拦外链与跨源导航。
   - **`learning_sessions` 的「一个学生同时只有一个进行中」由 DB 条件式 VIRTUAL 生成列 + 唯一键保证**——这是「重启不重置时钟」的实现保证，**必须 VIRTUAL 不能 STORED**（照抄 `remediation_sets` 先例）。
   - **`LEARNING_SESSION_POLL_MS = 10_000` ↔ `LEARNING_SESSION_ONLINE_WINDOW_SECONDS = 45` 镜像**，改一处必须同步另一处。
   - **拔网线不解锁**（有意的严格性）：轮询失败**绝不清锁**，本地截止时间是唯一判据。
   - **`session_lock_minutes` 是单次登录起算的墙钟窗口**，不是被废除的每日累计；`NULL` = 未设锁。
   - **做不到的别当缺陷修**：Electron 拦不住 `Alt+Tab`/`Ctrl+Alt+Del`/强制退出；不区分异常退出；真·无法切屏靠 OS 级单应用模式（运维）。
   - **本期非目标**：安装包/自动更新/签名、Web 端管控、`force_close` 命令、云端部署（壳留 `K12_WEB_URL` 接缝）。

- [ ] **Step 2: changelog**

在 `docs/ai-core-changelog.md` **顶部**（该文件最新在最上）追加一条 `2026-09-23` 条目，写清：
- 做了什么（三份计划各自的产出）；
- 人工冒烟结果（计划 2 Task 8 那 14 条 + 计划 3 Task 3 那 8 条的实际结果）；
- **踩到什么坑 / 与设计不符之处**（这是 changelog 的主要价值）；
- 遗留（例：`LockedPill` 定位是否需微调、是否有设计缺口）。

- [ ] **Step 3: README**

`README.md`：
1. `Roadmap` 的「Electron Desktop Integration」→ 改为已落地（dev 模式）并指向本设计。
2. 在「部署与日常启停」附近补 **三进程 dev 起法**：

```bash
# PC App（Electron 壳）本地开发需要三个进程：
cd apps/server && npm run build && node dist/main.js   # 1) 后端 :3001
cd apps/web    && npm run dev                          # 2) 前端 :5173
cd apps/desktop && npm install && npm start            # 3) 壳
# 壳默认加载 http://localhost:5173；换地址用 K12_WEB_URL=… npm start
```

3. 结构一节里 `apps/desktop` 前的「Planned」去掉。

- [ ] **Step 4: 复核 CLAUDE.md 体量**

Run:
```bash
cd /Users/lichao/Downloads/claude/imooc/ai_k12 && wc -c CLAUDE.md && grep -c "^" CLAUDE.md
```
Expected: ≤ 约 15KB（本文件有体量纪律）。**超了就只留硬约束**——把细节挪进 `docs/ai-core-changelog.md`，别删约束本身。

- [ ] **Step 5: Commit**

```bash
git add CLAUDE.md docs/ai-core-changelog.md README.md
git commit -m "docs: CLAUDE.md 新增 PC App 学习管控硬约束 + changelog + README 三进程 dev"
```

---

## 计划自检（写完后的核对结果）

**spec §9 文档同步清单覆盖**

| spec §9 要改的 | 落在 |
|---|---|
| PRD（`:224` 措辞 + PCT App 小节） | Task 4 Step 1 |
| UX-UI（`:698/:708/:760` + `:233-234` + 新规格） | Task 4 Step 2 |
| 架构设计（`:1145`、`:41`） | Task 4 Step 3 |
| `style.md:485` | Task 4 Step 4 |
| 数据库设计文档 | Task 4 Step 5 |
| 家长端清单 `:301` | Task 4 Step 6 |
| P6.6 spec `:43`/`:71` | Task 4 Step 6 |
| `CLAUDE.md`（含 `@HttpCode` 那句） | Task 5 Step 1 |
| API 文档 + openapi | **计划 1 Task 10** |
| README | Task 5 Step 3 |

**类型一致性**：`ParentSessionItem` / `ParentSessionPage`（Task 1 的 api.ts）与服务端 DTO 同名同形（计划 1 Task 9），字段顺序与可空性一致。

**已知风险**
1. Task 1 与 Task 2 都往 `apps/web/src/services/api.ts` 加东西，且都 mock 它——**若两个任务并行做，会冲突**。顺序执行。
2. Task 4 Step 7 的 `grep` 复核是**唯一**能证明"文档没漏改"的手段；跳过它会重演"文档说三栏、代码没有"的老问题。
3. `CLAUDE.md` 体量纪律：新增一节后必须 `wc -c` 复核（Task 5 Step 4）。
