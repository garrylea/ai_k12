# PC App：家长解锁后考试页出现返回入口 — 设计

> **本设计解决 2026-11-12 报回的问题**：学生进入考试（专注模式）后遇到紧急情况无法退出；
> 家长在家长端点【解除锁定】，学生端仍然**没有任何变化、没有任何可点的出口**，窗口又关不掉 → 死局。
>
> 前置：`2026-09-23-pc-app-study-lockdown-design.md`（学习锁定）、
> `2026-11-10-pc-app-pill-reveal-and-exit-hardening-design.md`（壳退出加固）。
> 约束：`docs/constraints/pc-app-学习管控.md`。

## 0. 问题结论（先给事实，不靠推测）

### 0.1 「解锁」的实际作用域只有一条

| 环节 | 事实 | 位置 |
|---|---|---|
| 家长点解除 | 落一条 `unlock` 命令；无进行中会话则 409/1001 | `device-commands.service.ts` `issue()` |
| 学生端 | 每 10 秒轮询，把 `unlockedAt` 写进本地快照与 context | `LearningSessionShell.tsx` 轮询 effect |
| 判定 | `unlockedAt !== null` → 不锁 | `learningLock.ts` `isLocked()` |
| **唯一消费者** | **`LogoutButton`**（允许点击；否则 toast「本次学习时长未满」） | `LogoutButton.tsx` `handleLogout()` |
| 壳 | **完全不知情**：`studentMode` 仍为 true，仍是 kiosk，仍拦 `close` / `before-quit` / `minimize` | `apps/desktop/main.js` `driveWindowLockdown()` |

即：**「解锁」= 允许登出，不等于窗口可关**。学生必须先登出（`releaseOnLogout()` 才解 kiosk），窗口才变普通可关窗口。

### 0.2 各答题页的出口盘点（逐页核对）

| 页面 | 页内出口 | 解锁后能否离开 |
|---|---|---|
| 考试 `ExamRunPage` | **无任何出口**（注释写明「考试无页内退出」） | **否 —— 本次要修的就是这一处** |
| 专项 `TargetedRunPage` | X → 确认 → 回配置页 | 能（配置页有登出，解锁后放行） |
| 错题 `ErrorPracticeRunPage` | X → 确认 → 回列表页 | 能 |
| 变式 `VariationRunPage` | PageHeader「返回错题本」+ X | 能 |
| 补偿 `RemediationRunPage` | PageHeader「返回训练」+ X | 能 |
| 语文 默写 / 解释 / 含义 | PageHeader「退出」 | 能 |
| 英语 背单词 | PageHeader「退出」 | 能 |
| 列表 / 配置页 | 右上角 `StudentAccountActions`（含登出） | 能 |

**结论：真正零出口的只有考试页。** 其它页的问题不是「没出口」，而是「解锁后无感知」（学生不知道该走了）——
后者本次不处理（见 §3 非目标）。

### 0.3 为什么考试页是死局

`ExamRunPage` 刻意不提供页内返回（离开不暂停计时、可从列表续考）。在浏览器里这没问题：
关标签页就走。但在壳里，kiosk 没有浏览器 chrome、窗口关不掉、也没有登出按钮 →
学生被完全困住，且家长解锁也无法产生任何可见变化。

## 1. 目标与非目标

**目标**

1. 家长点【解除锁定】后，考试页出现一个**就地、明确**的返回入口，学生能退到考试列表并由自己完成登出、关窗。
2. 不改变「解锁」的既有语义（只放开登出），不新增 IPC，不改变 Web 端行为。

**非目标（本次不做）**

- **断网兜底**：拔网线不解锁（既有裁决），家长命令到不了时按钮不会出现。已接受。
- **锁自然到期后的考试页**：本方案只在家长**主动解除**（`unlockedAt !== null`）时显示按钮；到期不是解除，
  所以到期后学生仍只能交卷离开。这是本次识别出的**遗留缺口**，需要时另立（见 §5）。
- **其它答题页加入口**：它们已有 X / 「退出」，本次不动。
- **全局解锁提示 / 横条 / toast**：不新增任何常驻或临时提示，按钮出现本身即信号。
- **自动关窗**：壳不主动退出自己；关窗仍由学生按窗口按钮完成。
- **改变壳的锁定行为**：`main.js` 一行不改。

## 2. 设计

### 2.1 显示条件

两个条件全部满足才渲染，否则返回 `null`（不占位、不留空槽）：

1. `isDesktopShell()` 为真 —— 浏览器里永远不显示，**Web 端零变化**。
2. 当前学生的会话快照存在，且 `unlockedAt !== null` —— 家长点过解除。归属按当前 `userId`
   校验（`readPersistedSession(studentId)`），换学生登录不会串。

（「未交卷」不单独判：交卷成功后页面直接导航到结果页，组件随之卸载；结果页本身已有「返回考试列表」。）

**为什么不看 `isLocked()`**：锁到期、家长未设锁都会让 `isLocked()` 为 false，但这两类都不是
「家长解除」；按用户裁决只认 `unlockedAt`。

### 2.2 状态来源：扩展 `LearningLockContext`

现状：`LearningLockContext` 的类型是 `LearningLockValue | null`，且 provider **只在「锁定中」时给非 null 值**
（`LearningSessionShell` 的 `lockValue`）。而 `unlockedAt !== null` 恰恰意味着「不锁」，所以必须放宽 provider 的给值条件。

改法（最小、明确）：

```ts
// learningLockContext.ts
export interface LearningLockValue {
  locked: boolean;
  remainingMs: number;
  /** 家长主动点过【解除锁定】（`unlocked_at` 非空）。锁到期 / 从未设锁都不算。 */
  unlockedByParent: boolean;
}

// LearningSessionShell.tsx
const lockValue =
  isDesktopShell() && lock !== null
    ? {
        locked,                                        // 与现在的判定完全一致
        remainingMs: lock.lockExpiresAt ? remainingMs(lock.lockExpiresAt, nowMs) : 0,
        unlockedByParent: lock.unlockedAt !== null,
      }
    : null;
```

- **`locked` 的语义不变**（仍是 `isDesktopShell() && 有截止时间 && 未解除 && 未到期`），
  所以现有唯一消费方 `LockedPillReveal` 不受影响 —— 它自己用 `lock?.locked === true` /
  `!lock?.locked` 守卫，给值范围放宽后行为一致（该文件第 49/64 行）。实现后需跑它的既有测试确认。
- provider 由「锁定时才有值」变成「桌面壳且有会话就有值」，但 `remainingMs` 在无锁时为 0，
  没有消费方会在未锁定时读它。
- **禁止**在页面里再 `localStorage.getItem` 自判 —— `docs/constraints/pc-app-学习管控.md`
  明确「锁定态经 `learningLockContext` 下发，禁止在页面里再读一次 localStorage」。

### 2.3 位置与外观

- 位置：考试页 `QuestionRunner` 的 `headerExtra` 内，**倒计时左侧**，与「已答 X/Y」同一行。
  用布局流而非 `absolute`，避免与右上角草稿图标按钮（`absolute top-4 right-4`）抢位置。
- 外观：圆形白底 + 线性 `chevron-left` 图标（与 `BackButton` 视觉规格一致），无文字。
- 可访问性：`aria-label="返回考试列表"`、`title` 同文案。
- 不用 emoji、不用装饰元素（`CLAUDE.md` 硬规则）。

### 2.4 点击行为

```
navigate(`/student/training/exam?subjectId=${subjectId}`)
```

- **不绕过 `RunExitGuard`**：`guardRef.current` 保持 true，导航会被 `useBlocker` 拦下，
  弹现有确认框（文案已经是「离开后计时不会暂停，可从考试列表续考返回。确认离开吗？」）。
  确认 → 回列表页；取消 → 留在考试。这保留「还能改主意」。
- 回到列表页后，学生点右上角 `LogoutButton` —— 此时 `unlockedAt !== null`，登出放行 →
  `releaseOnLogout()` 结束学习会话并 `setStudentMode(false)` 解 kiosk → 窗口可正常关闭。
- **不在按钮里直接登出**（用户裁决）：多一步，但保留继续考试的可能，且与其它页「先退再登出」一致。

### 2.5 时序

```
家长点【解除锁定】
  → 服务端写 device_commands + 会话 unlocked_at
  → 学生端轮询（≤10s）拿到 unlockedAt
  → LearningSessionShell 写本地快照 + setLock()
  → context.unlockedByParent 变 true
  → 考试页重渲染，返回图标出现
  → 学生点击 → RunExitGuard 确认 → 考试列表 → 登出 → 窗口可关
```

刷新/重进考试页时，`initialLockState()` 从本地快照取到 `unlockedAt`，按钮**第一帧就在**，不等轮询。

## 3. 边界

| 场景 | 行为 |
|---|---|
| 家长从未设锁（`session_lock_minutes = NULL`） | 按钮不出现（`unlockedAt` 为 null）；学生靠交卷/答完离开 |
| 家长先解锁，学生刷新页面 | 从本地快照读到 `unlockedAt`，按钮立即出现 |
| 家长解锁后换另一个学生登录 | 快照按 `studentId` 归属校验，按钮不出现，不串孩子 |
| 浏览器（非壳） | `isDesktopShell()` 为假，按钮不渲染；Web 端行为完全不变 |
| 考试自动收卷 / 已交卷 | 导航到结果页，组件卸载；结果页自带「返回考试列表」 |
| 轮询失败（断网/服务不可达） | `unlockedAt` 不更新 → 按钮不出现（既有「拔网线不解锁」口径） |
| 家长解锁后学生继续答题不离开 | 无副作用；按钮常驻直到交卷 |

## 4. 验证

**自动化**

- 组件测试（新增）：
  - 非桌面壳 → 不渲染；
  - 壳 + 快照无 `unlockedAt` → 不渲染；
  - 壳 + 快照 `unlockedAt` 非空 → 渲染，`aria-label` 正确；
  - 点击 → 目标 URL 为 `/student/training/exam?subjectId=<id>`。
- `ExamRunPage` 渲染测试（新增）：注入解锁态 → 按钮出现；未解锁 → 不出现。
- 注意本仓 `globals: false`：多用例文件必须自己 `afterEach(() => cleanup())`。

**手动验收**

1. 学生登录壳 → 进入考试页 → 确认无返回图标。
2. 家长端点【解除锁定】→ 10 秒内考试页出现返回图标。
3. 点击 → 弹「离开考试」确认 → 确认 → 回到考试列表。
4. 列表页点右上角登出 → 回登录页 → 窗口红绿灯可用，能关闭。
5. 重开壳并续考（未解锁状态下）→ 按钮不存在。
6. 浏览器打开考试页 → 任何状态都看不到该图标。

## 5. 遗留缺口（本次不修，记录在案）

1. **锁自然到期后考试页仍无出口**：到期不是「家长解除」，按钮不出现；学生仍只能交卷。
   若要修，应把判据从 `unlockedAt !== null` 扩为「当前不锁」，但那会让「家长从未设锁」的用户也看到入口。
2. **断网 → 家长无法远程解救**：既有严格性裁决，未被本设计改变。
3. **解锁后学生端在其它答题页无感知**：专项/错题等页有 X 能退，但学生不知道已经可以走了；
   若要补，应在所有答题页加一次性提示，本次明确不做。

## 6. 需要同步的文档

- `docs/constraints/pc-app-学习管控.md`：补一条「解锁后考试页返回入口」的口径与「不扩到其它页 / 不做断网兜底」的裁决。
- `docs/ai-core-changelog.md`：实现完成后追加一条带日期的工作日志。
- API 文档 / `openapi.yaml`：**不需要改**（无端点、无字段变化，仅消费既有 `unlockedAt`）。
