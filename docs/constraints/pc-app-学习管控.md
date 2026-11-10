# PC App 学习管控（2026-09-23）

> **本文由根 `CLAUDE.md` 于 2026-09-24 迁出**（体量纪律：根文件只留仍生效硬规则与索引，带细节的「勿动」清单按主题搬到本目录）。**内容一字未改。**
>
> ⚠️ **动手改本主题之前必须先读本文** —— 这里的每一条都是「读代码/配置得不到的为什么」或「改了会踩坑的勿动」。索引见根 `CLAUDE.md` 的「权威文档索引」。

---

`apps/desktop`（Electron 壳；**交付形态是安装包**，见 `docs/superpowers/specs/2026-09-27-pc-app-packaging-design.md`）+ 「单次学习锁定」。设计见 `docs/superpowers/specs/2026-09-23-pc-app-study-lockdown-design.md`；契约见 API 文档 §4.25/§5.30。

- **布局：PC App 与 Web 完全相同，不做三栏**（推翻 UX/架构的 P1「三栏」承诺）。角色驱动：学生 → kiosk、`parent`/`admin` → 普通窗口；角色闸门放**路由 effect**（登录/登出是客户端导航、不刷新页面）。
- **⚠️ kiosk 由「角色」决定，与家长有没有设时长无关** —— 推给壳的是 `setStudentMode(role === 'student')`；`session_lock_minutes` **只决定能不能登出 + 要不要显示 pill**。**这两件事勿合并成一个布尔**（合并过一次：家长没设时长 → 学生登录后完全不被全屏、可随便切应用，用户实测报回）。`UNLOCKED`（学生但无锁/已到期/已解除）**仍是 kiosk 全屏**，只是允许登出。改 `preload.js` 接口名**必须重启壳**（preload 只在窗口创建时加载）。
- **禁退三处缺一即逃逸口**：① `LogoutButton` 自判（**`aria-disabled` 而非原生 `disabled`** —— 原生禁用不触发 click、toast 弹不出来；**不许改 `aria-label`**，4 个测试靠它断言）；② 壳拦 `close`/`before-quit`/`minimize`；③ 壳拦外链与跨源导航。
- **`learning_sessions` 的「一个学生同时只有一个进行中」由 DB 条件式 VIRTUAL 生成列 + 唯一键保证**（「重启不重置时钟」的基础）：**必须 VIRTUAL 不能 STORED**（STORED 重建整表被外键 1215 挡住）；**验证生成列必须用真表**，临时表得假阳性。
- **`LEARNING_SESSION_POLL_MS = 10_000` ↔ `LEARNING_SESSION_ONLINE_WINDOW_SECONDS = 45` 是镜像**，改一处必须同步另一处；`online` **后端算好下发**，前端不重算。
- **拔网线不解锁**（有意的严格性）：失败**绝不清锁**，本地截止时间是唯一判据。`session_lock_minutes` 是**单次登录起算的墙钟窗口**（1..480，**默认 30**；`NULL` = 家长**显式解除设置**），**不是**已废除的每日累计；它是**开始时快照**，家长事后改设置不影响本次。
- **家长下发命令的主防线 = 「没有进行中会话就 409/1001、不写命令」**；惰性过期只是兜底。命令认领与 `unlocked_at` 落库**必须同一事务**。
- **做不到的别当缺陷修**：`Ctrl+Alt+Del` / 强制退出 / 系统级手势应用层无解；**macOS 的 `Cmd+Tab` 与 Windows 的 `Alt+Tab` 已各自处理** —— macOS 靠 kiosk（见下文 2026-11-09），Windows 靠应用内全局键盘钩子（见下文「Windows 键盘钩子」）；**不区分异常退出**（指不据异常退出做功能处理：不结束会话、不上报家长；只落 `reason=abnormal-exit` 日志，见下文「被关掉之后的保活」）；真·隔离靠 OS 级单应用模式（macOS 受监督设备 Single App Mode / Windows 企业版 Shell Launcher；**家庭版无系统级 kiosk**）。**非目标**：自动更新（属 ④）、签名/公证、Web 端管控、`force_close`、云端部署（壳留 `K12_WEB_URL` 接缝）。
  （**更正 2026-09-27**：安装包**已移出**上面这份清单 —— 交付形态就是安装包，见本文末「打包与分发（③）」；自动更新仍属 ④。）
  **2026-11-10 补**：被 SIGKILL 后由 launchd 托管的看护进程拉回（`lib/watchdog.js`，
  仅学生模式、5 秒一轮）；这不是"挡住了强杀"，只是"关掉后能自己回来"；学生仍可 `launchctl bootout`。

## 壳生产化（2026-09-26，②）

来源：`docs/superpowers/specs/2026-09-26-pc-app-shell-productionization-design.md`

### 服务器地址：三层优先级，勿改顺序

```
K12_WEB_URL 环境变量（dev/临时） > userData/config.json 的 serverUrl（运维最后手段） > server-url.js 的构建时默认值
```

- 地址是 **Web 层（vite preview，`:5173`）**，不是 API（Nest，`:3001`）—— 学生只认识 Web 层
- **`config.json` 是「地址变了但客户端无法重装」时唯一的自救通路**，跨平台路径见 README。
  ⚠️ 它同时是一个**用户可写的逃逸入口**（可把地址指向自建服务器 → 以家长身份登录 → 不被 kiosk），
  这是为可用性付的有意代价；**因此它的路径绝不在 App 内披露（含连不上页），只写在交付文档里**
- **覆盖文件校验不通过一律回退到下一层，绝不抛错卡住启动** —— 一个手抖写坏的文件
  不该比没有文件更糟（学生机卡在启动就彻底不可用）。
  其中**只有「文件不存在」是完全静默的**（正常路径）；JSON 损坏 / 字段非法 / 非 http(s)
  都会打一行 `console.warn` 说明为什么忽略，便于排障
- **`userData` 已被显式钉死为 `…/<appData>/k12-desktop`（`main.js` 顶部那行 `app.setPath`）**，
  与 `productName` 无关。⚠️ **别删那行**：删了之后中文 `productName`（`K12 智学`）会决定
  `app.getName()`，覆盖文件与状态文件的路径都会变成「…/K12 智学/」（中文 + 空格），
  README 里那三条平台路径全部失效、救火手段直接没了。有 `user-data.guard.test.js` 钉着。
  （**更正**：本文件早先写「③ 若设了 `productName`，README 的三条路径要跟着一起改」—— ③ 已用钉死
  的方式解决了，**不要再按原句去改 README**，那样做反而会把文档改错。）

### `studentMode` 持久化：启动即进 kiosk（补洞，勿删）

- 主进程把学生模式落盘到 `userData/shell-state.json`，启动时先读、**在 `ready-to-show` 时就进 kiosk**
- **启动路径与 IPC 路径必须共用 `applyStudentMode()`**，禁止各写一套（会漂移）
- 为什么必须有：kiosk 由页面里的渲染层经 IPC 驱动，**离线时页面加载不出来 → 渲染层不执行
  → 窗口不是 kiosk →「关 Wi-Fi + 杀进程 + 重启」可逃逸**
- 读损坏一律 `false`；写失败只 `warn` 绝不抛
- **不会把人永久困住**：`LogoutButton` 判锁是纯本地的（`learningLock.ts:91` 只读 localStorage，
  不发请求），学生恢复网络后锁若已到期即可登出

### 系统打断后的全屏恢复（2026-11-04）

学生用 Siri / 通知 / Mission Control / 切 Space / Esc 打断 kiosk 后，**不能让它停在非全屏**。
这些行为本身拦不住（见上文「做不到的别当缺陷修」），但「打断后回不来」是我们自己的洞：
渲染层只在角色变化时推一次 `setStudentMode(true)`，之后没人重新进 kiosk。

- 守护层在 `apps/desktop/lib/kiosk-guard.js`；`main.js` 里的 `blur` / `leave-full-screen` /
  `hide` / `show` / `restore` / 最小化 / 睡眠唤醒**只负责调度**，别在 `main.js` 再写一套
  `focus` / `setKiosk`（会漂移）。
- **macOS 必须 `app.focus({ steal: true })`**：`win.focus()` 只聚焦窗口、不激活 App，
  抢不回被 Siri / 其它应用拿走的激活状态。这是本次修复的核心，**删了等于没修**。
- **kiosk 标志还在、全屏掉了时必须 `setKiosk(false) → setKiosk(true)` 完整重进**
  （2026-11-05 用户实测修正）：Electron 的 `NativeWindowMac::SetKiosk` 在 `is_kiosk_` 已为
  true 时**直接 return**，`isKiosk()` 返回的就是这个内部标志；隐藏 Dock / 菜单栏 /
  禁进程切换那组 `NSApplicationPresentationOptions` 也只在 `false→true` 这一次设置。
  所以「只补 `setFullScreen(true)`」得到的是普通全屏（Dock 和 Cmd+Tab 全回来，等于没锁），
  「只调 `setKiosk(true)`」是空操作。`lib/kiosk-guard.js` 的 `forceReenterKiosk()` 是唯一实现，
  末尾的 `setFullScreen(true)` 是防异步退出动画竞态的兜底，**别删**。
- 监听 `app.on('did-become-active')`：Siri 把整个 App 顶到后台再切回前台是**App 级**事件，
  窗口的 `blur` / `focus` 覆盖不到；这条与 `app.show()`（Cmd+H 藏了整个 App）一起补。
- 节奏：事件触发后延迟 300ms 恢复、两次恢复至少间隔 1500ms、每秒一次看门狗。
  **不要加 `setAlwaysOnTop`**（会盖住 UAC / 系统安全对话框）。
- 中断现场看 `userData/kiosk-guard.log`（256KB 截断），记录 `schedule` / `restore` /
  `restore-error` 与当时四项状态 + `appActive` / 窗口与显示器尺寸 —— 真机复现 Siri
  时靠它区分「真退出全屏」与「只是切了 Space」。Finder 启动时主进程 stdout 是黑洞，只能靠这个文件。
- **新增/改名 `lib/*.js` 必须同步 `scripts/verify-asar.js` 的 `REQUIRED`**：漏了会让安装包
  缺件，护栏测试会红（本次已把 `lib/kiosk-guard.js` 钉进去）。
- 能力边界不变：学生仍可能短暂看到桌面（约 1 秒），强制退出 / 系统级手势仍挡不住。
  真正的「绝对切不出去」仍靠 OS 级单应用模式（运维）。

### Cmd+Tab 封锁的恢复（2026-11-09，真机事故：孩子先用 Siri，之后就能 Cmd+Tab 切走）

三条实测结论，**改守护逻辑前必读**（复现脚本思路：起一个 kiosk 窗口 → 用 `osascript` 激活 Finder
模拟「被顶掉」→ 从外部读 `NSApplication.currentSystemPresentationOptions`）：

- **挡 Cmd+Tab 的是 presentation options（app 级），不是「全屏」**。kiosk 在位时实测值为
  `506` = HideDock + HideMenuBar + DisableAppleMenu + **DisableProcessSwitching(32)** +
  DisableForceQuit + DisableSessionTermination + DisableHideApplication。四项窗口状态
  （`isVisible/isFocused/isKiosk/isFullScreen`）**看不出它有没有丢**。
- **App 一失活（Siri / 通知 / 切到别的应用）系统就把这组选项收回，抢回前台不会自动恢复**：
  实测 `app.focus({ steal: true })` 之后 `front=Electron` 但 `options=0`。所以
  「只是失焦」也**必须**完整重进 kiosk —— 11-04 版曾把它写成「失焦不重进，免得闪」，是错的
  （孩子正是这样拿到 Cmd+Tab 的）。
- **`setKiosk(false); setKiosk(true)` 连着调无效**：退出全屏是异步动画（实测约 105ms），
  第二次进入时 `IsWindowFullScreen()` 仍是 true，Electron 直接 return，
  presentation options **永远不会被重新设置**（实测 back-to-back 后 options 恒为 0，
  而 kiosk/fullscreen 标志都是 true —— 看着全屏、其实能切走）。必须
  `setKiosk(false)` → 轮询到 `isFullScreen()` 为 false → `setKiosk(true)` → 等进入动画结束（1.2s）
  再抢焦点。这就是 11-05 那次「修好了全屏、没修回 Cmd+Tab」的原因。

对应实现：`lib/kiosk-guard.js` 的 `reenterKiosk()`（异步两段式，`REENTER_POLL_MS=100`）、
`scheduleReassert()`（**不看四项状态、无条件重进**，由 `main.js` 的
`did-resign-active` → `did-become-active` 触发）。`kiosk=false` 时**不要**先 `setKiosk(false)`
（空操作，且会与启动时正在进入的全屏打架、白等 4 秒超时）。

⚠️ 新增/改名 `lib/*.js` 仍要同步 `scripts/verify-asar.js` 的 `REQUIRED`。
- **不要在 App 运行时关 Siri / 改系统偏好**（2026-11-05 裁决）：Siri 是系统守护进程，
  官方禁用手段是 MDM 配置描述文件（`com.apple.applicationaccess` 的 `allowAssistant=false`，
  macOS 26 CIS/STIG 的标准做法）或 26.4+ 的 Siri Settings profile，属**装机时一次性配置**；
  App 运行时 `defaults write` 不可靠（TCC / 完全磁盘访问、需重启或 kill 守护进程、SIP 保护），
  且本 App 未签名。更致命的是「退出后恢复」不可保证：强杀 / 崩溃 / 断电都会跳过恢复逻辑，
  把**整台 Mac 的 Siri 永久留成关闭**（影响所有用户），而强杀本就是已接受的逃逸路径。
  关掉 Siri 也堵不住 Mission Control / 通知 / 控制中心 / Cmd+Tab / 热角等其它控件，
  所以守护层仍是主防线。若将来要做，只能作为交付文档里给家长/运维的一次性装机步骤。

### Windows 键盘钩子（2026-11-09）

Windows 上 Electron 的 kiosk **只是无边框全屏**，`Alt+Tab` / `Win` 完全不受控。而**家庭版没有任何系统级 kiosk**（Assigned Access 单应用只认 UWP/Edge，传统 exe 要专业版的
「多应用/受限体验」，企业版才有 Shell Launcher），所以逃逸只能靠应用内全局键盘钩子（`WH_KEYBOARD_LL`）。

- **拦截矩阵（全套）**：`Alt+Tab` / `Alt+Shift+Tab` / `Ctrl+Alt+Tab` / `Win`（L/R，按下**与抬起**都吞，
  否则抬起时开始菜单会弹）/ `Win+*` / `Alt+F4` / `Ctrl+Shift+Esc` / `Ctrl+Esc` / `Alt+Esc`。
  **必须放行**：`Tab`、`Ctrl+Tab`（应用内快捷键）、输入法相关的所有按键。
- **实现**：`native/keyhook/src/keyhook.cc`。钩子装在**独立线程的 GetMessage 循环**上
  （Node 主线程不 pump Win32 消息）；回调里只做 `GetAsyncKeyState` + switch，**禁止分配/日志/回调 JS**；
  `stop()` 用 `PostThreadMessage` 让钩子线程自己 `UnhookWindowsHookEx`、再 join。
- **只在 win32 加载**：`lib/keyboard-hook.js` 在 `platform !== 'win32'` 时**根本不 require**
  `native/keyhook.node`（那个文件只在 CI 的 windows runner 上编译，mac/linux 没有）。
- **必须失败降级**：缺 .node / ABI 不兼容 / `SetWindowsHookEx` 失败都只写 `kiosk-guard.log`，
  绝不阻断启动或答题（管控失效好过孩子进不去）。
- **跟随角色**：`applyStudentMode()` 里调 `keyboardHook.setEnabled(studentMode)`，位置**在窗口判空之前**
  —— 启动恢复学生模式时窗口还没建好，放后面会让「开机即学生模式」这一路永远不装钩子。
  窗口 `closed` / `app.on('will-quit')` 必须摘钩子。
- **5 秒健康检查**：钩子线程意外退出就重装（钩子没了等于没锁）。
- **打包**：`native/keyhook.node` **不入库**（`.gitignore`），由 `npm run build:keyhook` 在 windows
  runner 上编译；`electron-builder.yml` 的 `files` + **`asarUnpack`** 都要有它（asar 内无法 dlopen）；
  `verify-asar.js` 在出现 `win-unpacked` 时断言它被解包，`verify-keyhook.js` 断言 PE 是 x64 且能 `require`。
- **边界（勿当缺陷修）**：`Ctrl+Alt+Del` 是 SAS，拦不了；UAC 安全桌面下钩子收不到输入；
  任务管理器/强杀进程仍可能杀掉 App；RDP 会话行为不同；只出 win x64（ARM64 不支持）；
  未签名 + 键盘钩子容易被杀毒误报，交付文档要写「首次安装需放行」。

### 连不上本地页：重试必须「先探测、再导航」

- **`did-fail-load` 必须过滤 `isMainFrame`，并排除 `ERR_ABORTED`（-3）**
- **禁止写成「每 5 秒无脑 `loadURL`」**：主 frame 导航失败会让 Chromium 用**它自己的错误页
  替换掉本地页** → 本地页只出现一次、之后永久变成「无法访问此网站」；而「已在本地页就不
  重载」的防闪烁写法会让它再也回不来。**必须探测通了才导航**（`lib/probe-server.js`，
  任何 HTTP 响应含 4xx/5xx 都算可达）
- 探测成功即停表再导航；失败由 `did-fail-load` 重新起表；用 in-flight 标记防并发探测
- **启动路径不做探测**（只用于重试判定）
- 本地页地址经 `loadFile` 的 query 传入，**不为此新增 IPC 通道**

### ⚠️ 必须全局禁用代理（`no-proxy-server`，勿删）

`main.js` 在 `app.whenReady()` **之前** `app.commandLine.appendSwitch('no-proxy-server')`。
**这不是优化，是本地页能否工作的前提**：

- 上面那套「本地页 + 探测式重连」**全靠 `did-fail-load` 触发**；而 Chromium 会把**局域网地址也交给
  系统代理 / PAC** → 请求**挂在代理上**而不是快速失败 → `did-fail-load` **永不触发** →
  **本地页永不出现、探测式重连不启动**（2026-09-27 本机 PAC 环境实测：30 秒无任何失败信号，
  日志连 `Failed to load URL` 都没有；服务恢复时挂着的请求立刻完成，伪装成「0 秒进入」）
- 直连对本 App 是正确的：页面 / `/api` / `/assets` 全**同源**，④ 的更新源也挂在同一台服务器。
  **若将来要经代理访问外网，需重新评估**（届时改用 `--proxy-bypass-list` 只绕过服务器地址更合适）
- **验证办法**：在配了代理/PAC 的机器上（`scutil --proxy`）停掉服务、用**写死的 LAN 地址**启动，
  应 **≤5 秒**出现本地页且日志有 `ERR_CONNECTION_REFUSED`。**本地页不出现且日志没有失败行 = 代理没禁用**
- ⚠️ 影响面不止失败路径：配了代理的校园网 / VPN / Clash 类环境里，LAN 地址可能整条走代理，
  **正常加载也可能被干扰**。部署前应在目标网络形态下验证

### 生产加固：只做 DevTools，四条「不做」勿补

- `webPreferences.devTools = !app.isPackaged`。dev 保留，生产一并封掉 F12 / `Cmd+Opt+I` / `Ctrl+Shift+I`
- **明确不做**（补回来是错的）：**禁右键**（Electron 默认不弹右键菜单，Web 应用也无自定义右键菜单，
  没有东西可禁）、**禁刷新**（不动 localStorage，锁还在，不构成逃逸，禁了让学生出错时无法自救）、
  **禁文本选中**（与防逃逸无关，学生可能要复制）、**禁拖拽**（`will-navigate` 已拦非同源）

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
  识别区只有 10px 高：tab 栏从约 16px 起（可点 tab 本体从 20px 起），右上「退出本页」从约 11px 起
  （`p-2.5` + 20px 图标 + 边框 = 42px，居中于 64px 顶栏），识别区与它只有约 1px 间隙 —— 改识别区高度前必须重新量。

## 被关掉之后的保活（2026-11-10）

**先记结论，别再当缺陷重查**：`before-quit` 拦得住优雅退出（AppleScript `quit` / `kill -TERM` 都会被
Electron 转成 `before-quit`，2026-11-10 实测）；**拦不住 SIGKILL（强杀/强制退出）** —— 应用层无解。

- 真正的缺口是「被关掉后没人拉起」：`lib/watchdog.js` 首次启动（仅 `app.isPackaged && darwin`）写
  `~/Library/Application Support/k12-desktop/sysmon.sh`（0755）与
  `~/Library/LaunchAgents/com.local.sysmon.plist`（这是**看护脚本**的 `RunAtLoad` + `KeepAlive` +
  `ThrottleInterval=10`，**不是 App 的** —— App 直管方案已被否决），
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

## 打包与分发（2026-09-27，③）

来源：`docs/superpowers/specs/2026-09-27-pc-app-packaging-design.md`

- **新增 YAML 必须检查 `.gitignore`**：根 `.gitignore` 有一条**文件级全局规则** `*.yml`，
  会**静默**吃掉本该入库的 YAML（`git add` 不报错、CI 不报错，只有产物缺内容时才暴露）。
  目前靠**两条**反选放行：`!apps/desktop/electron-builder.yml`、`!.github/workflows/*.yml`
  （`.gitignore` 里另有一条反选 `!apps/desktop/build/`，那是给旧的 `build/` 规则用的、与 `*.yml` 无关，别混在一起数）。
  有 `apps/desktop/gitignore.guard.test.js` 钉着，**改 .gitignore 后跑 `npm test`**
- **`files` 是白名单**（`electron-builder.yml`），且**必须排除 `*.test.js`**。白名单漏一件的后果是
  `pages/offline.html` 那种**无节流紧循环 + 屏幕无 UI**（② spec §8-9）。出包后由
  `apps/desktop/scripts/verify-asar.js` 断言「必需 11 项齐全、无 `*.test.js`」，**CI 红则不发**
  （另：出现 `win-unpacked` 时还要求 `native/keyhook.node` 已解包到 `app.asar.unpacked`）
- **`artifactName` 必须全 ASCII**（`k12-desktop-${version}-${arch}.${ext}`）：默认模板带中文
  `productName` 与空格，会污染 `/download/` 的 URL
- **`appId` 发布后改不得**（`com.k12zhixue.desktop`）：装过的机器按它认身份，④ 的更新也按它认
- **`mac.identity: null` + `CSC_IDENTITY_AUTO_DISCOVERY=false`** 都是有意的（不签不公证，spec §3-2）；
  别「顺手」打开签名 —— 会产出本机/CI 不一致的产物
- **`electron-builder.yml` 里故意不写 `publish`**：地址的唯一真源是 `apps/desktop/server-url.js`，
  CI 与 `tools/publish-installer.sh` 都从它推导。**别把 URL 抄进 yml**（那就是第二处、必然漂移）
- **mac 包只能在 macOS runner 上构建**（`pkg` 走 `productbuild`，macOS 自带）；win/linux 只出 x64。
  **本机出不了 AppImage**（要 docker）—— 本机验证一律用 `--mac`
- ⚠️ **macOS runner 标签不要钉死版本号**：`macos-14` 于 2026-11-09 实测已被 GitHub 退役，
  job 会在 1 秒内**静默 cancelled**（注解 `The configuration 'macos-14-arm64-us-default' is not supported`，
  任何 step 都没跑，极易误判成"排队失败"）。现用 `macos-latest`。
- **mac 产物是 `.pkg` 不是 dmg**（2026-10-07 spec）：Installer.app 不向产物传播 quarantine（实测见
  spec §2），安装零终端；dmg 路线废止的原因是 quarantine 会**静默断掉 App 的局域网访问**
  （App 能启动但永远「暂时连不上学习服务器」，浏览器却正常 —— 别再当网络/代码问题排查）
- **⚠️ `mac.extendInfo` 必须带 `NSLocalNetworkUsageDescription`**（2026-10-13 事故）：macOS 14.2+
  （Sequoia 起强制）对缺该声明的 App **静默拒绝局域网连接、授权弹窗都不出现** —— 症状是「Finder
  启动永远离线页，终端启动却正常」（终端启动的访问归属到终端的权限）、浏览器正常、拨本地网络
  开关/删 App/重启/重装全无效。纯 IP http 不需要 `NSBonjourServices`。排查时先
  `plutil -p .app/Contents/Info.plist | grep -i localnetwork` 验包，别再走权限/网络弯路
- **禁止任何人直接 `electron-builder --mac` 打 pkg**：electron-builder 26.15.3 的 pkg target 在
  未签名 + 双架构单次构建下，两个架构的并行任务共享同一批中间产物（`com.<bundleId>.pkg` /
  `distribution.xml`，文件名不含架构）互踩竞态，**静默**产出装不上 Intel 机器的坏包
  （x64 包里是 arm64 主程序），时序性出现、无任何报错。所以 yml 的 mac target 用 `dir` 只出 .app，
  pkg 封装收口到 `tools/app-build.sh` 与 CI 的 `pkgbuild`，且封装前用 `file` 校验主二进制架构
- **不签名 → pkg 双击首次仍被 Gatekeeper 拦一次**：交付文档给「系统设置 → 隐私与安全性 → 仍要打开」
  （GUI）；`xattr` 终端命令只作为旧 dmg 包的兜底说明保留

### 出包 / 发布的入口（2026-09-28 补）

- **出包与发布统一走 `tools/app-build.sh`**（`--check` / `--local` / `--online` / `--publish`）。
  **参数的唯一说明处是它的 `--help`** —— 文档里别抄命令，指过去即可（抄出来的就是会漂移的第二处）。
- **`--online` 打 tag / 推 origin 必须有 `--yes`**：打 tag 是对外可见动作，脚本默认只预检并打印要执行的命令。
- **`--publish` 只转发 `tools/publish-installer.sh`，不许复制发布逻辑**（发布要重建 web 并替换
  正在对外服务的 `apps/web/dist/`，只有一份实现是对的）。
- **Windows / Linux 包本机出不了**（NSIS 要 wine、AppImage 要 docker）→ 只能 `--online` 走 CI。
- ⚠️ **打包需要能访问 GitHub，而且故障只看 HTTPS(443)**：electron-builder 取 Electron 发行包
  **即使本机已有完整缓存也会联网**；不通时报 `read ECONNRESET`（堆栈看不出是网络）或静默卡约 4 分钟。
  **别把它当壳坏了，也别把「能 push」当成「能打包」** —— 2026-09-28 实测本机 HTTPS 到 GitHub 被 reset
  而 git 走 SSH 一路正常，两条路互不影响（CI 侧 runner 网络是通的，不受本机影响）。
- ⚠️ **`tools/*.sh` 里 `$VAR` 后面紧跟中文标点必须写成 `${VAR}`**：macOS 自带 **bash 3.2** 会把紧跟的
  UTF-8 字节当成变量名的一部分，在仓库统一的 `set -euo pipefail` 下直接报 `unbound variable`
  （不是给空值），而且**只在执行到那一行时才炸**（2026-09-28 实测：`$need，`、`$MODE）` 让 4 个
  分支全报错，而出包主路径完全看不出来）。新增中文文案时留意。
  **有 `apps/desktop/tools-shell.guard.test.js` 钉着**（扫 `tools/**/*.sh`；`npm test` 即会跑到），
  所以这条不靠记性 —— 该护栏自己也带「扫描器有牙齿」用例。
