# PC App 壳生产化（②）— 设计

> **架构锚点**：`apps/desktop/main.js`（壳）、`apps/desktop/preload.js`（桥）、
> `apps/web/src/kiosk/`（锁定与 kiosk 的渲染层实现）、
> `docs/superpowers/specs/2026-09-23-pc-app-study-lockdown-design.md`（①的产物，本设计修订其两处表述）。

## 0. 本设计在「PC App 正式交付」中的位置

「正式交付包」不是一个项目，是四个有依赖关系的子项目。**本设计只做 ②**，其余三步各有独立 spec：

| # | 子系统 | 依赖 | 状态 |
|---|---|---|---|
| ① | 服务器同源托管前端 + 局域网可达 | 无 | **已存在**（`tools/services.sh` 用 `vite preview --host 0.0.0.0` 托管），① 收敛为一份运维清单，不写 spec |
| **②** | **壳生产化：地址写死 + 连不上本地页 + 补 kiosk 持久化 + 生产加固 + 图标** | ① | **本设计** |
| ③ | 打包与三平台分发（electron-builder + GitHub Actions + mac 签名结论） | ② | 待立项 |
| ④ | 自动更新（更新源托管 + electron-updater + macOS 绕过 ShipIt + 与锁定的时机裁决） | ③ | 待立项 |

② 的边界是「**让壳在真实使用条件下不出洋相**」：地址有确定来源、连不上有可理解的反馈、kiosk 关得死、生产构建关掉调试入口。**出包本身属 ③。**

## 1. 背景与现状（2026-09-26 实测，勿凭记忆）

### 1.1 壳现在是什么

`apps/desktop/main.js` 做三件事，且**不做任何业务**：

| 职责 | 实现 |
|---|---|
| kiosk | `ipcMain.on('kiosk:set-student-mode')` → `win.setKiosk()` + `setClosable` + `setMinimizable`（`main.js:105-112`） |
| 拦关闭 | `close` / `minimize` / `before-quit` 在 `studentMode` 时 `preventDefault`（`main.js:70-91`） |
| 拦外逃 | `setWindowOpenHandler` deny + `will-navigate` 非同源拦截（`main.js:64-67`） |

现状缺失：无打包配置、无图标、**无任何测试设施**、无「连不上」的本地页、地址来源是 `process.env.K12_WEB_URL || 'http://localhost:5173'`（`main.js:36`）。

### 1.2 已确认的部署事实

- **服务器就是本机**（macOS），对外一层是 `vite preview`（`:5173`，`--host 0.0.0.0`），Nest 在 `:3001` 只做内网 API
- 本机局域网 IP `192.168.1.5`，走 **DHCP**
- macOS 应用防火墙**已关闭**，不存在入站拦截
- 学生机系统：**Windows / macOS / Linux 三种都有**

### 1.3 关键事实：锁定与 kiosk 全部由客户端 localStorage 决定

| 判定 | 依据 | 位置 |
|---|---|---|
| 是否 kiosk（全屏、关不掉） | `localStorage.userRole === 'student'` | `LearningSessionShell.tsx:87` |
| 能否登出（是否锁定中） | `localStorage.k12_learning_session` 的快照 | `learningLock.ts:91-98`（`isCurrentStudentLocked`） |

**推论（本设计的前提）**：这是客户端实现，不是服务端强制。逃逸面因此有且只有两个：

1. **localStorage** —— DevTools 打开后一行，或直接改磁盘上的用户数据（Local Storage 是 leveldb）
2. **服务器地址** —— 指向自建服务器 → 以家长身份登录 → `userRole` 非 student → 窗口不 kiosk

因此本设计的加固目标不是「造一道防线」，而是**把两个逃逸面的门槛都抬高到普通学生够不着**。这个定位必须写进文档，避免以后误以为它是安全边界。

### 1.4 现存的一个洞（本设计要补）

**复现**：学生登录（进 kiosk、锁定中）→ 关掉 Wi-Fi → 杀进程 → 重新打开 App → **窗口是普通窗口，可关掉、可随意切应用。**

**根因**：kiosk 由**页面里的渲染层**经 IPC 驱动，而离线时页面根本加载不出来：

| 环节 | 位置 | 行为 |
|---|---|---|
| `studentMode` 初值 | `main.js:26` `let studentMode = false` | 启动时默认**非**学生模式 |
| 谁把它设为 true | `LearningSessionShell.tsx:133` `setDesktopStudentMode(isStudent)` | **需页面加载成功才会执行** |
| 窗口创建 | `main.js:47-58` `createWindow()` | 不应用 kiosk，等渲染层通知 |

离线 → 页面不加载 → 渲染层不执行 → `studentMode` 恒为 false → 窗口不 kiosk。

**与既有 spec 的冲突**（必须修订）：

- `2026-09-23-pc-app-study-lockdown-design.md` §8 局限 3 称「拔网线不解锁 → 断网期间学生被困到 `lock_expires_at`」—— 该条只覆盖「学习中途断网」，**没有覆盖重新启动**
- 同文档 §3 裁决 10 称「异常退出不专门处理（**杀进程换不来自由**）」—— **在这条路径下该判断不成立**：杀进程 + 断网确实换来了自由

## 2. 范围

### 本期做

| # | 内容 | 落点 |
|---|---|---|
| 1 | 服务器地址改为**构建时写死**，收敛到单一来源 | 新增 `apps/desktop/server-url.js` + `main.js` |
| 2 | 「连不上」本地页 + **自动重试** | 新增 `apps/desktop/pages/offline.html` + `main.js` |
| 3 | **补 1.4 的洞**：`studentMode` 持久化，启动即进 kiosk | `main.js` + 新增 `userData/shell-state.json` |
| 4 | 生产加固：DevTools 仅生产禁用 | `main.js` 的 `webPreferences` |
| 5 | 应用图标资源准备（1024 PNG） | `apps/desktop/build/icon.png` |
| 6 | 给 ① 的 spec 加更正注记（局限 2/3、裁决 10） | `docs/superpowers/specs/2026-09-23-…md` |
| 7 | `apps/desktop` 引入 vitest，覆盖新抽出的纯逻辑 | `apps/desktop/lib/` |

### 本期不做（明确）

1. **配置界面 / 配置文件 / 口令 / 任何「老师入口」** —— 系统角色只有**学生 / 家长 / 运营管理员**，没有老师；地址写死后也不需要现场配置（用户裁决，见 §3-2、§3-3）
2. **启动前探测** —— 只保留 `did-fail-load` 触发（用户裁决 §3-5）
3. **禁刷新 / 禁文本选中** —— 不构成逃逸（刷新不动 localStorage），且禁了让学生出错时无法自救（§3-7）
4. **Web 层换 Nginx、或收敛到 Nest 单端口** —— Web 层保持 `vite preview`，两层架构不动（§3-8）
5. **打包 / 出包 / 签名 / 安装包 / 自动更新** —— 属 ③ ④
6. **Web 端管控** —— 沿用旧 spec 的裁决（非 Electron 环境不建会话、不轮询、不拦登出）
7. **产品名（`productName`）/ electron-builder 配置** —— 属 ③（本设计只准备图标资源）

## 3. 用户裁决记录（逐条，实现时勿推翻）

| # | 议题 | 裁决 |
|---|---|---|
| 1 | 前端产物放哪 | **服务器同源托管**（方案 A），不把前端打进包 |
| 2 | 系统角色 | **只有学生 / 家长 / 运营管理员**，**没有老师**；据此删除一切「老师入口」设计 |
| 3 | 地址来源 | **构建时写死**（推翻本设计早前的「首次启动输入」方案）；学生零操作 |
| 4 | 连不上本地页 | **保留**，但只做「连不上 + 自动重试」，不含任何配置能力 |
| 5 | 触发方式 | **不做启动前探测**，只由 `did-fail-load` 触发 |
| 6 | 已加载页面中途断网 | **不切**本地页，留在原页面等恢复 |
| 7 | 加固范围 | **只做 DevTools 禁用**；不做禁刷新 / 禁选中 / 禁右键（右键在 Electron 下本就是伪需求） |
| 8 | Web 层实现 | 保持 `vite preview`，不加 Nginx、不收敛到 Nest |
| 9 | 1.4 的洞 | **补**，归入本设计；同步给旧 spec 加更正注记 |
| 10 | IP 固定 | DHCP 保留 / 静态 IP 从「建议」升为**硬前置**（写死地址的唯一保障） |

## 4. 设计

### 4.1 地址来源：单一写死点

新增 `apps/desktop/server-url.js`（**只放常量**）：

```js
// 服务器地址的**唯一写死点**。改地址 = 改这一行 + 重新出包。
// dev 期用 K12_WEB_URL 环境变量覆盖（见 lib/resolve-server-url.js），打包产物里以本文件为准。
module.exports = { SERVER_URL: 'http://192.168.1.5:5173' };
```

优先级判定抽成纯函数 `apps/desktop/lib/resolve-server-url.js`（**只做判定，不 require electron**，故可单测）：

```js
// env 传 process.env.K12_WEB_URL；fallback 传 server-url.js 的 SERVER_URL
function resolveServerUrl(envUrl, fallback) {
  const trimmed = typeof envUrl === 'string' ? envUrl.trim() : '';
  return trimmed !== '' ? trimmed : fallback;
}
module.exports = { resolveServerUrl };
```

`main.js` 改为：

```js
const { SERVER_URL } = require('./server-url.js');
const { resolveServerUrl } = require('./lib/resolve-server-url.js');
const WEB_URL = resolveServerUrl(process.env.K12_WEB_URL, SERVER_URL);
```

- **优先级**：`K12_WEB_URL` 环境变量（仅 dev 用）→ `server-url.js`
- **地址是 Web 层的地址**（`:5173`，vite preview），不是 API 的 `:3001` —— 学生只认识 Web 层（① 的结论）
- ③ 的 CI 可在打包前用环境变量重写该文件，从而产出指向不同服务器的包（本设计只定义「单一来源」这个性质）

⚠️ **硬前置**：服务器必须固定 IP。写死地址的代价是 IP 一变**所有学生机都要重新出包并重装**，没有现场可救的手段。路由器后台把本机 MAC 绑到固定地址这一条不兑现，本设计就是给自己埋雷。

### 4.2 启动流程与「连不上」本地页

```
启动
├─ 有 K12_WEB_URL 环境变量 → loadURL(它)                      （dev 路径，行为不变）
├─ 有 server-url.js       → loadURL(SERVER_URL)
│                            └─ did-fail-load(mainFrame) → 显示本地页，开始自动重试
└─ 无（不可能，文件里总有默认值）
```

**本地页**（`apps/desktop/pages/offline.html`，纯 HTML + 内联 CSS/JS，不引入 React、不参与 Web 构建）：

- 主文案：「暂时连不上学习服务器，正在重试…」
- 副文案：「如果一直连不上，请联系家长」
- 小字：当前地址（便于家长/运营报障时定位）
- 「立即重试」按钮（性急时不必等）
- **自动重试**：每 **5 秒**重新 `loadURL(WEB_URL)`，无限次（局域网内 5 秒一次无成本，学生不需要做任何事）

**实现要点（三条防空转/防闪烁的约束）**：

1. `did-fail-load` 必须**过滤 `isMainFrame`** —— 子资源（图片/CSS）失败也会触发该事件，不过滤会把能用的页面误判为「连不上」
2. **显示本地页前先判断当前是否已在本地页**，已在则不再 `loadFile` —— 否则每次重试失败都重载本地页，页面闪烁
3. 页面**加载成功时清掉重试定时器**（在 `did-finish-load` 的主 frame 上判定），否则连上之后定时器还在后台空转

### 4.3 补洞：`studentMode` 持久化

主进程把学生模式落到磁盘，启动时先读、**在建窗口时就进 kiosk**，不再等渲染层。

- **文件**：`app.getPath('userData')/shell-state.json`，形状 `{ "studentMode": boolean }`
- **读写代码**：抽成 `apps/desktop/lib/shell-state.js`（纯 Node、不 require electron，故可单测），`main.js` 只传入 userData 路径
- **写**：`ipcMain.on('kiosk:set-student-mode')` 里同步落盘；**写失败只 warn、绝不阻断**（沿用「埋点/日志写入永不阻断主链路」的既有纪律）
- **读**：`createWindow()` 前同步读取；文件缺失 / JSON 损坏 / 字段类型不对 → 一律当 `false`（坏数据不该把家长锁在 kiosk 里）
- **应用时机**：若为 `true`，在窗口 `ready-to-show` 时执行 `setKiosk(true)` + `setClosable(false)` + `setMinimizable(false)`，与 IPC 路径**走同一段代码**（抽成一个函数，避免两处漂移）
- **清**：收到 `setStudentMode(false)` 时写入 `false` —— 这正是 `releaseOnLogout()` 的路径（`desktopBridge.ts:54-64`）

**为什么不会把人永久困住**（这是本设计最需要说清的一点）：

`LogoutButton` 判锁是**纯本地**的 —— `LogoutButton.tsx:50` 调用 `isCurrentStudentLocked()`，后者只读 `localStorage`、**不发任何请求**（`learningLock.ts:91-98`）。所以：

> 学生恢复网络 → 页面加载 → 若锁已到期，本地判定立刻放行 → 学生能登出 → `releaseOnLogout()` 推 `setStudentMode(false)` → kiosk 关闭。

**学生想合法离开，恢复网络即可；想靠拔网线+杀进程逃逸，行不通了。** 这正是旧 spec 原本想要的效果。

### 4.4 生产加固

只做一条：`webPreferences.devTools = !app.isPackaged`。

- 它同时封掉 `F12` / `Cmd+Opt+I` / `Ctrl+Shift+I`（`devTools:false` 后快捷键也打不开）
- **dev 模式保留**，调试不受影响
- 这是价值最高的一条，因为**能改 localStorage 的入口主要就是 DevTools**

**明确不做**（并说明理由，免得后来者当缺陷补）：

| 不做 | 理由 |
|---|---|
| 禁右键 | Electron 默认不弹右键菜单，且 Web 应用无自定义右键菜单（已 grep 确认）——**没有东西可禁** |
| 禁刷新 | 刷新不动 localStorage，锁还在，不构成逃逸；禁了反而让学生出错时无法自救 |
| 禁文本选中 | 与防逃逸无关，且学生可能需要复制 |
| 禁拖拽 | `will-navigate` 已拦非同源，已覆盖 |

### 4.5 图标

`apps/desktop/build/icon.png`，**1024×1024**，由 `apps/web/public/favicon.svg`（品牌橘 `#ff6b35` + 白色线性书本）栅格化而来。

- **一次性生成并提交进仓库**，不引入构建期依赖（图标是静态资源，没必要每次构建都生成）
- electron-builder 用这一张 PNG 自行生成 `.icns` / `.ico`（属 ③ 的配置）

### 4.6 断网时的行为（kiosk 中的学生）

- **不切本地页**：已加载的页面留在原地，请求失败由页面自身提示，网络恢复后自动继续
- 只有「**页面本身加载失败**」才切本地页（启动时 / `reload` 时）
- 与既有的「拔网线不解锁」一致

## 5. 测试与验收

### 单测（`apps/desktop` 引入 vitest，与仓库一致）

壳现在**没有任何测试设施**。本期只测**抽出来的纯逻辑**（不测 Electron API，那部分靠人工冒烟）：

| 目标 | 用例 |
|---|---|
| `lib/resolve-server-url.js` | env 有值 → 取 env；env 为空串 / 未定义 → 取 fallback；env 两侧有空白 → 取 trim 后的值 |
| `server-url.js` | `SERVER_URL` 是非空字符串（防止写死点被改成空值后静默退化成相对地址） |
| `lib/shell-state.js` | 无文件 → `false`；写入后读回 `true`；JSON 损坏 → `false`；字段非布尔 → `false`；目录不存在时写入不抛 |

抽成 `apps/desktop/lib/*.js`（纯 Node，不 require electron），`main.js` 只做薄封装与副作用。

### 人工冒烟（dev 壳，`npm start`）

| # | 操作 | 期望 |
|---|---|---|
| 1 | 不设 `K12_WEB_URL`，只设好 `server-url.js`，起 web 与 server | 正常加载 |
| 2 | 关掉 web 服务后启动壳 | 显示本地页；**每 5 秒自动重试** |
| 3 | 在本地页显示期间重新起 web 服务 | **≤5 秒自动进入**，学生无需操作 |
| 4 | 本地页显示时观察页面是否反复闪烁 | **不闪**（重试失败不应重载本地页） |
| 5 | 页面上故意让一张图片 404 | **不切**本地页（验证 `isMainFrame` 过滤） |
| 6 | 学生登录 → 确认进 kiosk | 全屏、关不掉 |
| 7 | 学生登录后**杀进程 + 关掉 web 服务** → 重新启动壳 | **仍是 kiosk**（补洞生效），且显示本地页 |
| 8 | 承 #7，恢复 web 服务 | 自动进入；锁未到期仍不能登出 |
| 9 | 承 #8，把锁设为已到期（或等它到点）| 能登出 → kiosk 关闭 |
| 10 | 家长账号登录 | 不是 kiosk；可关、可最小化 |
| 11 | 学生登录 → 正常登出 → 重启壳 | **不是 kiosk**（验证清标志） |
| 12 | 手动把 `shell-state.json` 写成乱码后启动 | 不是 kiosk（坏数据容错） |

### ② 阶段**无法**验证的（必须留给 ③，别当成没做）

| 项 | 原因 |
|---|---|
| DevTools 真的打不开 | `devTools` 只在 `app.isPackaged` 时为 false，**② 不出包** |
| 图标在各平台显示正确 | 需出包 |
| Windows / Linux 上的行为 | ② 只在本机 macOS 的 dev 壳上验证 |

## 6. 非目标与已知限制（必须在文档里明说）

1. **锁定仍是客户端实现** —— 会用 DevTools 或直接改 leveldb 的学生**仍可绕过**。本设计只抬高门槛，不改变这个事实（§1.3）
2. **地址写死 → IP 变即需重新出包并重装** —— 这是写死的直接代价，故 IP 固定是硬前置（§4.1）
3. **断网期间学生确实用不了** —— 本地页只解释原因、自动重试，不提供任何功能（用户已确认接受）
4. **Electron 拦不住 `Alt+Tab` / `Cmd+Tab` / `Ctrl+Alt+Del` / 强制退出** —— 系统级，沿用旧 spec §8 局限 1
5. **本设计不出包** —— 交付物是代码 + 可在本机 dev 运行的壳；安装包/签名/自动更新属 ③ ④
6. **`studentMode` 持久化可能与真实状态短暂不一致** —— 若学生被杀进程时正处 kiosk，下次启动会先进 kiosk，直到页面加载后由渲染层纠正。**这个方向是安全的**（宁可多锁一下，不可漏锁）

## 7. 文档同步清单（仓库铁律，实现时必须一起改）

| 文档 | 要改什么 |
|---|---|
| `docs/superpowers/specs/2026-09-23-pc-app-study-lockdown-design.md` | §8 局限 2 / 局限 3 与 §3 裁决 10 加**更正注记**：说明「断网 + 杀进程 + 重启」这条路径当时未覆盖，已由本设计补齐；裁决 10 的「杀进程换不来自由」需限定为「杀进程**且**服务器可达时」 |
| `docs/constraints/pc-app-学习管控.md` | 新增本设计的硬约束：地址单一写死点、`studentMode` 持久化（启动即 kiosk）、`devTools` 仅生产禁用、本地页「自动重试」的实现要点（`isMainFrame` 过滤 / 防重载 / 清定时器）、以及 §4.4「明确不做」那四条 |
| `CLAUDE.md` | **不新增章节**（体量纪律：内容进 `docs/constraints/`，此处至多一行指向） |
| `README.md` | PC App 章节补：地址写死在哪一行、连不上时的现象与自动重试、「杀进程 + 断网不再能逃逸」 |
| `docs/ai-core-changelog.md` | 记录本次设计与实现（含发现 1.4 那个洞的经过） |
| `docs/API接口与数据流设计文档.md` + `docs/api/openapi.yaml` | **无需变更**（本设计不涉及任何端点）—— 明确记录此结论，免得后来者以为漏同步 |

## 8. 风险

1. **补洞会碰到既有的 kiosk 语义**（kiosk 由「角色」驱动而非「锁定」，2026-09-24 才刚拆开）→ 改动必须复用同一段应用函数，禁止在启动路径里另写一套；人工冒烟 #6–#11 是本项的主要证据
2. **写死地址把「IP 固定」变成硬依赖** —— 忘记配 DHCP 保留就全校白屏，且没有现场补救手段（§4.1）。这条要在 ③ 的部署文档里再强调一次
3. **`shell-state.json` 是新的持久化状态** —— 与 localStorage 里的真实状态是两个源，存在不一致窗口；本设计选择「偏向多锁」的方向（§6.6）
4. **`did-fail-load` 的行为差异** —— 不同平台的错误码与触发时机可能有别（如 `ERR_ABORTED` 在导航取消时也会触发）。实现时须以人工冒烟 #2–#5 为准，必要时加错误码白名单
