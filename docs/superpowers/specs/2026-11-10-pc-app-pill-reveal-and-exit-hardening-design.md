# PC App：剩余时长胶囊改浮层 + 壳退出加固 — 设计

> **本设计解决两个 2026-11-10 报回的问题**：
> ① 锁定的剩余时长胶囊压住了个人中心的三个 tab，学生点不到【练习记录】；
> ② macOS 下切不走 App，但用 Siri 等方式能把 App 关掉，关掉后没有任何机制把它拉回来。
>
> 前置：`2026-09-23-pc-app-study-lockdown-design.md`（学习锁定）、
> `2026-11-04` / `2026-11-09` 的 kiosk 守护修复。约束：`docs/constraints/pc-app-学习管控.md`。

## 0. 问题结论（先给事实，不靠推测）

### 0.1 胶囊遮挡：确认是 bug

| 元素 | 位置 | 实际几何 |
|---|---|---|
| 胶囊 `LockedPill.tsx:19` | `fixed left-1/2 top-3 z-50` | 距窗口顶 12px、高约 34px → y=12–46px，宽约 390px |
| 顶栏 `StudentStayLayout.tsx:65` | `h-16`（64px），三 tab 在 `:70` 居中 | tab 组 y≈20–44px、宽约 210px |

两者垂直区间重叠、胶囊更宽且 `z-50` 在上、**没有 `pointer-events-none`** → tab 既看不见、点击也被胶囊吃掉。
胶囊是 `LearningSessionShell` 的全局元素（锁定期间所有学生页都显示），而三 tab 是 2026-11-01/11-06 才加到正中央的，
所以属于回归：当年"人工冒烟确认与各页顶栏不重叠"只覆盖了沉浸页。

### 0.2 退出：拦得住"优雅退出"，拦不住"被关掉后没人拉起"

抽同样守卫的最小 Electron 程序实测（2026-11-10，本机）：

| 路径 | 结果 |
|---|---|
| AppleScript `quit`（Siri / Dock「退出」走这条 AppleEvent） | `before-quit` 触发 → **被拦**，进程存活 |
| `kill -TERM` | Electron 转成优雅退出 → `before-quit` → **被拦**，进程存活 |
| `kill -KILL`（= 强制退出） | 立即死亡，**应用层无法拦截** |

所以"Siri 关掉"只可能是：① 系统升级为强制退出（SIGKILL）；② 渲染进程/子进程崩溃；③ 当时
`studentMode === false`（登录页，或上一位家长用过并登出）。**不是 `before-quit` 漏写**。

真正的缺口是：**锁只存在于正在运行的 App 里，App 一没，没有任何机制把它拉回 kiosk** ——
没有 launchd 保活、没有登录项。于是"关掉 App"≈"拿到一台自由的 Mac"（锁时与服务端会话仍在走，
偷不到锁时间，但能免费用电脑）。次级缺口：`win.on('closed')` 后进程退不掉却没有窗口；
渲染进程崩溃无人恢复；本地状态（`shell-state.json`）用户可删。

## 1. 目标与非目标

**目标**

1. 胶囊不再常驻、不再遮挡任何可点元素；学生仍能"随时查"剩余时间（桌面悬停 / 触屏点击）。
2. 让"App 被关掉"这件事：能被记录（是哪条路径）、能被恢复（崩溃自愈）、能自己回来（保活）。

**非目标（本次不做）**

- 系统级 kiosk（`/Library/LaunchAgents` root 所有、root LaunchDaemon、受监督设备 Single App Mode）——
  需要装机管理员权限，等家长机形态确认后另立。
- 恢复"上次停在哪一页"。作答状态没有落盘，恢复到考试/答题中途会丢内容；重启回首页即可。
- 关闭 Siri / 改系统偏好（2026-11-05 已裁决不做）。
- Windows 的计划任务保活与本次 macOS 保活**同构但不同实现**，本次只交付 macOS；Windows 另排。

## 2. 胶囊：从"常驻全局"改为"局部可唤出浮层"

### 2.1 归属与可见范围

- **只在浅停留三页出现**：`/student/profile`、`/student/rewards`、`/student/practice-history`（含其详情页）。
  沉浸页（做题、课程详情、考试、辅线答疑）**完全不渲染**——学生点右上角登出时，`LogoutButton` 的
  toast 仍会解释"时长未满"，信息不丢。
- 由 `StudentStayLayout` 渲染，不再由 `LearningSessionShell` 直接渲染。锁定状态经新增的
  `LearningLockContext` 下发（`LearningSessionShell` 是唯一真源，不新增第二份轮询）。

### 2.2 交互状态机

```
locked=false                → 不渲染（连识别区一起不渲染）
进入三页中任一 index 页      → 显示 3000ms 后收起
鼠标进入顶边识别区          → 显示，直到鼠标移出（移出后 200ms 收起）
点击/轻触识别区             → 显示 5000ms 后收起（覆盖触屏没有 hover 的情况）
锁定解除 / 组件卸载          → 立即收起并清理定时器
```

- 三个 tab 互跳会重新触发 3000ms（用 `key={staySection}` 强制 `LockedPillReveal` 重挂；
  `staySection` 只到 tab 段，详情页不重挂）；**练习记录详情页进入时不自动弹**，
  避免学生正在看记录时被闪一下。
- 自动显示与点击显示共用同一个 `hideTimer`；新的显示请求覆盖旧的。悬停期间忽略自动收起。

### 2.3 几何

| 项 | 值 |
|---|---|
| 胶囊位置 | `fixed`，水平居中，`top: 72px`（= 顶栏 64px + 8px 间隙） |
| 胶囊层级 / 命中 | `z-40`、`pointer-events-none`（纯展示，绝不抢点击） |
| 识别区 | `fixed inset-x-0 top-0`、高 **10px**、透明、`z-40` |
| 隐藏态 | `opacity-0` + `pointer-events-none` + `aria-hidden="true"`，仍在 DOM 中（不引起布局抖动） |

识别区只覆盖 y=0–10px：顶栏内容（tab 从约 16px 起、右侧「退出本页」按钮从约 11px 起 ——
`p-2.5` + 20px 图标 + 边框 = 42px，居中于 64px 顶栏）都在其下方，不会抢任何按钮的点击；
两者之间只有约 1px 间隙，改识别区高度前必须重新量。

### 2.4 无障碍

- 识别区是 `<button type="button" aria-label="查看本次学习剩余时间">`，可 Tab 聚焦；
  聚焦即显示（等价于悬停），Enter/点击显示 5000ms。
- 胶囊保留 `role="status"`；仅在可见时移除 `aria-hidden`，避免每次自动显示都被读屏重复播报。

### 2.5 不动的部分

`isLocked` / `formatRemaining` / `remainingMs` / 会话轮询 / `LogoutButton` 判定**一行不改**。
本次只改"渲染在哪里、什么时候可见"。

## 3. 壳加固 A：把"被关掉"变成可观测、可恢复

### 3.1 退出尝试落盘（`lib/exit-audit.js`，新增）

- `markRunning(userData)`：启动时写 `running.flag`（仅标志位，不含时间戳）；
- `wasAbnormalExit(userData)`：启动时若 `running.flag` 仍存在 → 上次是**非正常结束**
  （SIGKILL / 崩溃 / 断电），写一行 `kiosk-guard.log: reason=abnormal-exit`；
- `markCleanExit(userData)`：在 `will-quit` 里删掉 flag（正常退出路径）。
- `main.js` 额外记三行：`close-attempt`、`before-quit`、`will-quit`。
  有了这三行，下次复现可以直接判定：**有 `before-quit` 但仍死亡 = 系统升级为强杀；一行都没有 = 直接 SIGKILL 或崩溃**。

### 3.2 崩溃自恢复

- `webContents.on('render-process-gone')`：记日志 → `win.reload()`；
  60 秒内第 2 次及以上 → 销毁并 `createWindow()`（防"崩了只会白屏"）。
- `webContents.on('child-process-gone')`：只记日志（GPU/utility 崩溃不该整窗重建）。
- 以上恢复逻辑只做"把界面拉回来"，**不碰** `studentMode`；kiosk 由 `kiosk-guard` 的看门狗照常兜底。

### 3.3 明确不做

- 不因异常退出结束学习会话、不上报家长（沿用 2026-09-23 裁决 10「不区分异常退出」）；
  要上报需先改口径，另立 spec。

## 4. 壳加固 B：看护进程（watchdog，仅 macOS，仅打包后）

> **2026-11-10 用户裁决（改口径）**：不把 App 本身交给 launchd `KeepAlive`，而是另起一个极小的
> **看护进程**——学生登录后它工作，学生登出/家长登录后它休眠等待。理由：家长也要能正常退出 App，
> 常驻 `KeepAlive` 会让家长点了退出又被立刻拉起来。

### 4.1 机制

首次打包启动时，App 写两样东西（都在用户目录，不需要管理员）：

- 脚本：`~/Library/Application Support/k12-desktop/sysmon.sh`（`0755`）
- plist：`~/Library/LaunchAgents/com.local.sysmon.plist`
  - `ProgramArguments = [/bin/sh, <脚本路径>, <App 绝对路径>]`
  - `RunAtLoad=true`、`KeepAlive=true`、`ThrottleInterval=10`、`LimitLoadToSessionType=Aqua`
- 随后 `launchctl bootstrap gui/<uid> <plist>`；失败只 warn，不阻断启动。

看护脚本是 **5 秒一轮的 POSIX sh 循环**，判据只有两条：

1. 读 `~/Library/Application Support/k12-desktop/shell-state.json` 的 `studentMode`；
2. `studentMode=true` 且 `pgrep -f "<App>/Contents/MacOS/"` 找不到进程 → `open -a "<App>"`。

`studentMode=false` 或文件不存在 → **什么都不做**（家长/管理员可正常退出，不会被拉起）。
脚本内**不 embed App 路径**：路径由 plist 的 `ProgramArguments` 传入，App 挪位置只改 plist。

App 每次启动都校验一遍：脚本或 plist 缺失/被改 → 重写；`launchctl print gui/<uid>/com.local.sysmon`
失败（没加载）→ 重新 `bootstrap`。**幂等**，重复启动无副作用。
只在 `app.isPackaged && darwin` 执行；`npm start` 开发态不装，避免污染开发机。
看护脚本以 **JS 字符串常量**内置在 `lib/watchdog.js`，不新增打包白名单条目（避免 asar 白名单漂移）。

### 4.2 单实例（不能用两条保活路径，必须有它）

- `app.requestSingleInstanceLock()` 放在 `whenReady` 之前；拿不到 → `app.quit()`（此时 `studentMode`
  还不是 true，不会被 `before-quit` 拦）。第二实例**不得**创建窗口、不得安装任何东西、
  也不得执行 `markCleanExit`（否则会删掉正在运行实例的 `running.flag`，把异常结束判定打瞎）。
- `app.on('second-instance')`：`app.focus({ steal: true })` + 显示窗口 + `kioskGuard.scheduleReassert('second-instance')`。

### 4.3 命名与可发现性（这是边界，不是安全）

- label `com.local.sysmon`、脚本名 `sysmon.sh`，与产品名无关，降低被注意的概率。
- **这不是安全边界**：`launchctl list`、活动监视器、`ps` 都能看到；标准用户对自己的 `gui` 域有权限，
  可 `launchctl bootout gui/$(id -u)/com.local.sysmon`。要真挡需 root 级守护（未立项）。

### 4.4 崩溃循环与卸载

- 看护进程自身被 kill → launchd 的 `KeepAlive` 在 10 秒内拉起（`ThrottleInterval=10` 防连崩拖死机器）。
- 卸载：
  `launchctl bootout gui/$(id -u)/com.local.sysmon && rm ~/Library/LaunchAgents/com.local.sysmon.plist "$HOME/Library/Application Support/k12-desktop/sysmon.sh"`

## 5. 影响文件

| 文件 | 改动 |
|---|---|
| `apps/web/src/kiosk/LockedPill.tsx` | 改为"受控显示"组件（接收 `visible`），位置 `top-[72px]`、`pointer-events-none`、`z-40` |
| `apps/web/src/kiosk/LockedPillReveal.tsx`（新增） | 识别区 + 状态机（3s / hover / 5s） |
| `apps/web/src/kiosk/LearningSessionShell.tsx` | 不再直接渲染胶囊；改为提供 `LearningLockContext`（`{locked, remainingMs}`），provider 值加 `isDesktopShell()` 闸门 |
| `apps/web/src/components/layout/StudentStayLayout.tsx` | 消费 context，渲染 `<LockedPillReveal />` |
| `apps/desktop/lib/exit-audit.js`（新增） | running 标记 / 异常结束判定 / 清理 |
| `apps/desktop/lib/watchdog.js`（新增） | 看护脚本内容、plist 生成、幂等安装 / bootstrap |
| `apps/desktop/lib/launch-agent.js` | **删除**（2026-11-10 裁决改为看护进程） |
| `apps/desktop/main.js` | 单实例锁、退出日志、异常结束判定、崩溃恢复、首启装看护 |
| `apps/desktop/scripts/verify-asar.js` | `REQUIRED` 增删对应文件 |
| `docs/constraints/pc-app-学习管控.md` | 追加本次两条约束与旧表述清单（§7） |

## 6. 测试

**Web**

- `LockedPill.test.tsx`：现有 3 条（文案）保留。
- 新增 `LockedPillReveal.test.tsx`（fake timers，`afterEach(cleanup)`）：
  1. 挂载即显示，3000ms 后隐藏；
  2. 悬停显示，移出 200ms 后隐藏（悬停期间 3000ms 到点也不隐藏）；
  3. 点击显示 5000ms 后隐藏；
  4. `locked=false` 时识别区与胶囊都不渲染；
  5. 胶囊带 `pointer-events-none`。
- `StudentStayLayout.test.tsx`：三页都渲染识别区；无 context 时不渲染。
- `LearningSessionShell.test.tsx`：原 4 条 `locked-pill` 断言改为断言 context 下发值（测试跟随实现，不反向改设计）。

**Desktop**

- `lib/exit-audit.test.js`：正常/异常两条路径（临时目录）。
- `lib/watchdog.test.js`：脚本关键判据、plist 字段、幂等（重复调用不重写）、App 路径变化重写、
  非 darwin 不动、未加载时 bootstrap、bootout/bootstrap 失败不抛。
- `kiosk-guard.wiring.guard.test.js` 追加断言：`main.js` 里存在
  `requestSingleInstanceLock`、`render-process-gone`、`markRunning`、`installWatchdog`，且 `REQUIRED` 含新文件。

## 7. 旧表述清单（改口径必须同步删改，别只加注记）

- `apps/web/src/kiosk/LockedPill.tsx` 头部注释「定位用 fixed + 顶部居中…人工冒烟时确认它与各页顶栏不重叠」——**整段删除**，改为"浮层、只在浅停留三页、顶栏下方、`pointer-events-none`"。
- `apps/web/src/kiosk/LearningSessionShell.tsx` 注释「剩余时间 pill 的渲染也在这里」——删除。
- `docs/constraints/pc-app-学习管控.md` 的「`session_lock_minutes` 只决定…要不要显示 pill」**保留**
  （仍成立），但需补一句"pill 只在浅停留三页、按需唤出"。
- `2026-09-23-pc-app-study-lockdown-design.md` §6.4 的"顶部居中"描述加一行注记指向本文（旧 spec 不重写）。
- `docs/constraints/pc-app-学习管控.md` 的"做不到的别当缺陷修"那段补一句：
  "被 SIGKILL 后由 launchd 托管的看护进程拉回（2026-11-10）"，避免下次又被当成缺陷重查。

## 8. 验收（真机，按顺序）

1. 锁定中进个人中心：胶囊出现在**顶栏下方**，3 秒后消失；三个 tab 可正常点击（【练习记录】能进）。
2. 鼠标移到窗口顶边 10px：胶囊出现；移开：消失。
3. 触屏/iPad：点顶边出现，5 秒后消失（无 hover 环境必须走这条）。
4. 进做题页：**没有**胶囊；点登出仍弹"时长未满"toast。
5. `osascript -e 'quit app "K12 智学"'`：不退出；`kiosk-guard.log` 出现 `before-quit`。
6. `kill -KILL <pid>`：看护进程在一个轮询周期内（≤10 秒）把 App 拉起并回到 kiosk；`kiosk-guard.log` 出现 `abnormal-exit`。
7. 连续两次触发第 6 步：仍能回来（验证 `ThrottleInterval` 不会把学生卡死）。
8. 家长登录（`studentMode=false`）后点退出：**不再被拉起**；`launchctl print gui/$(id -u)/com.local.sysmon` 里看护仍在、只是空闲。
9. 卸载演练：`launchctl bootout` + 删 plist 与脚本后，App 不会再被拉起（文档步骤可复现）。

## 9. 风险

- **看护是用户级**：学生 `launchctl bootout` / 删 plist 即可摘掉（普通用户对自己的 `gui` 域有权限）。
  本次只挡"顺手关掉 / Siri 关掉"，不承诺"关不掉"。
- **看护是 5 秒轮询**：从被强杀到被拉起，最多约 5–10 秒的桌面空窗（比 launchd 直接托管 App 慢）。
- **看护靠进程存在性（`pgrep`）判断**，不靠网络心跳：拔网线/服务器挂掉不会误判成"App 死了"。
- 打包后首次启动才装看护；若学生手动删了 plist，下次启动会重装（幂等逻辑覆盖）。
- `render-process-gone` 自动 reload 可能打断正在输入的答案——仅在真的崩溃时发生，属可接受降级。
- **命名只是降低被注意的概率**（`com.local.sysmon`），不是隐藏手段：`launchctl list` / 活动监视器可见。
