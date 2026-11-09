# PC App：Windows 全局键盘钩子（2026-11-09）

## 1. 背景

孩子用 Windows 家庭版试用时，学生锁定期间 `Alt+Tab` 可以切走整个 App。

- Windows 上 Electron 的 `setKiosk(true)` **只是无边框全屏**，不像 macOS 会设置
  `NSApplicationPresentationOptions`。`Alt+Tab` / `Win` 完全不受控。
- **家庭版没有可用的系统级方案**：Assigned Access 的**单应用 kiosk 只支持 UWP/Edge**，
  传统 Win32 exe 在专业版要走「多应用/受限体验」，企业版/教育版才有 Shell Launcher。
- 所以只能在应用层装 `WH_KEYBOARD_LL` 全局低级键盘钩子。

## 2. 目标与非目标

**目标**：`studentMode === true` 时吞掉能逃离 App 或杀掉 App 的组合键；家长/管理员登录立即解除；
装钩子失败只降级、不阻断启动与答题。

**非目标**：`Ctrl+Alt+Del`（SAS，用户态无解）、强杀进程后的自动拉起、macOS/Linux（不动）、
系统级 kiosk（运维配置）。

## 3. 拦截矩阵

| 组合 | 处理 |
|---|---|
| `Alt+Tab` / `Alt+Shift+Tab` / `Ctrl+Alt+Tab` | 吞 |
| `Win`（左右）、`Win+*`（Win+Tab / D / 方向…） | 吞（按下与抬起都吞） |
| `Alt+F4` | 吞 |
| `Ctrl+Shift+Esc`（任务管理器）/ `Ctrl+Esc`（开始菜单）/ `Alt+Esc` | 吞 |
| `Tab` / `Ctrl+Tab` / 输入法 / 其它 | **放行** |

判定条件（`src/keyhook.cc` 的 `ShouldBlock`）：`VK_TAB` 看 Alt；`VK_F4` 看 Alt；`VK_ESCAPE` 看 Ctrl 或 Alt；
`VK_LWIN` / `VK_RWIN` 直接吞。修饰键状态用 `GetAsyncKeyState`，Alt 同时参考钩子结构的 `LLKHF_ALTDOWN`。

## 4. 实现

### 4.1 原生模块 `apps/desktop/native/keyhook/`

- `binding.gyp` + `src/keyhook.cc`，node-addon-api（仅编译期头文件）。
- **钩子装在独立线程**：`CreateThread` → `SetWindowsHookExW` → `GetMessageW` 循环。
  Node 主线程不 pump Win32 消息，不能直接装。
- 回调里只做 O(1) 判定：禁止分配、写日志、回调 JS（每个按键都会进这里）。
- `stop()`：`PostThreadMessageW(WM_APP+0x4B31)` → 钩子线程自己 `UnhookWindowsHookEx` → join（2s 超时）。
- 导出 `start() / stop() / isActive() / lastError() / ping()`；`AddEnvironmentCleanupHook` 兜底摘钩。
- 产物：`apps/desktop/native/keyhook.node`，由 `scripts/build-keyhook.js` 在 **win32 且 x64** 上编译并复制；
  **不入库**（`.gitignore`）。非 Windows 上脚本直接跳过并 `exit 0`。

### 4.2 壳内封装 `apps/desktop/lib/keyboard-hook.js`

依赖注入（`platform / load / log / timers`），行为：

- 非 win32：**不 require 原生模块**，全 no-op。
- 加载失败 / 接口不全 / `start()` 返回 false：只写 `kiosk-guard.log`，之后不反复重试（日志不刷屏）。
- `setEnabled(on)` 与学生模式一一对应；启用时每 5 秒健康检查，`isActive()` 为 false 就重装。
- `reassert()` 供唤醒/解锁后立即确认。

### 4.3 接线 `apps/desktop/main.js`

- `applyStudentMode()` 里 `keyboardHook.setEnabled(studentMode)`，位置**在窗口判空之前**
  （启动恢复学生模式时窗口还没建好）。
- `win.on('closed')` 与 `app.on('will-quit')` 摘钩子。

### 4.4 打包与 CI

- `electron-builder.yml`：`files` 加 `native/keyhook.node`，`asarUnpack` 加同一项（asar 内无法 dlopen）。
- `scripts/verify-asar.js`：出现 `win-unpacked` 时断言 `.node` 已解包；`REQUIRED` 增 `lib/keyboard-hook.js`。
- `scripts/verify-keyhook.js`：断言 PE machine = x64、能 `require`、`ping()` 正常。
- `.github/workflows/desktop-release.yml`：`npm ci` 后 `npm run build:keyhook`（其它平台自跳过），
  出包后 `npm run verify:keyhook`（仅 win）。
- `.github/workflows/desktop-ci.yml`（新）：`apps/desktop/**` 变更时在 `windows-latest` 上
  编译 + 跑全量 vitest，避免到发版 tag 才发现编译错误。
- `native/keyhook/native.test.js`：仅 Windows 跑，验证 ABI 与 start/stop 生命周期
  （CI runner 非交互式桌面时 `start()` 允许失败，只告警）。

## 5. 风险与边界

| 风险 | 说明 / 处置 |
|---|---|
| `Ctrl+Alt+Del` → 任务管理器杀进程 | 拦不住；装机可选用组策略禁用任务管理器（文档，不做代码） |
| UAC 安全桌面 | 弹 UAC 时钩子收不到输入；但 UAC 需要管理员密码 |
| 杀毒误报 | 未签名 exe + 键盘钩子是重点盯的行为；交付文档写「首次安装需放行」 |
| 多用户 / RDP | 低级钩子只作用于当前桌面会话；RDP 下行为不同 |
| 架构 | 只 win x64（与 NSIS target 一致），ARM64 不支持 |
| 性能 | 回调纯算术 + `GetAsyncKeyState`，无分配 |
| 打包缺件 | 三处兜底：`files`/`asarUnpack` 护栏测试、`verify-asar`、`verify-keyhook` |

## 6. 验收

**本机（mac）**：`npm test` 全绿（Windows 用例 skip）；`npm run build:keyhook` 跳过；`tools/app-build.sh --check` 通过。

**CI（windows-latest）**：能编译出 x64 `.node`；win 包内 `app.asar.unpacked/native/keyhook.node` 存在且可加载。

**真机（Windows 家庭版）**：学生登录后硬按 `Alt+Tab` / `Win` / `Alt+F4` / `Ctrl+Shift+Esc` 无反应；
`Tab` / `Ctrl+Tab` / 中文输入法 / 复制粘贴正常；家长登录后快捷键恢复；`Ctrl+Alt+Del` 仍可杀掉 App（已知边界）。
