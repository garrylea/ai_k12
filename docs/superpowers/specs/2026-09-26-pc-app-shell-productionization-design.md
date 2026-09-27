# PC App 壳生产化（②）— 设计

> **架构锚点**：`apps/desktop/main.js`（壳）、`apps/desktop/preload.js`（桥）、
> `apps/web/src/kiosk/`（锁定与 kiosk 的渲染层实现）、
> `docs/superpowers/specs/2026-09-23-pc-app-study-lockdown-design.md`（①的产物，本设计修订其两处表述）。

## 0. 本设计在「PC App 正式交付」中的位置

「正式交付包」不是一个项目，是四个有依赖关系的子项目。**本设计只做 ②**，其余三步各有独立 spec：

| # | 子系统 | 依赖 | 状态 |
|---|---|---|---|
| ① | 服务器同源托管前端 + 局域网可达 | 无 | **已存在**（`tools/services.sh` 用 `vite preview --host 0.0.0.0` 托管），① 收敛为一份运维清单，不写 spec |
| **②** | **壳生产化：地址三层来源（写死 + 覆盖文件）+ 连不上本地页 + 补 kiosk 持久化 + 生产加固 + 图标** | ① | **本设计** |
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

⚠️ 一处**有意的例外**：§4.1 的地址覆盖文件是用户可写的，等于把第 2 个逃逸面的门槛从「解包 asar / 改 leveldb」降到「会写一个 JSON 文件」。这是为可用性（客户端无法更新时仍能救活）付的代价，决策依据见 §3-11 与 §6-3。

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
| 1 | 服务器地址**三层来源**：构建时写死 + 手工覆盖文件 + dev 环境变量 | 新增 `apps/desktop/server-url.js` + `lib/resolve-server-url.js` + `lib/config-file.js` + `main.js` |
| 2 | **手工覆盖文件** `userData/config.json`（地址变更而客户端无法更新时的最后手段） | `lib/config-file.js` + 文档 |
| 3 | 「连不上」本地页 + **探测式自动重试** | 新增 `apps/desktop/pages/offline.html` + `lib/probe-server.js` + `main.js` + `preload.js`（新增 `shell:retry-now` 单向通道） |
| 4 | **补 1.4 的洞**：`studentMode` 持久化，启动即进 kiosk | `main.js` + 新增 `userData/shell-state.json` |
| 5 | 生产加固：DevTools 仅生产禁用 | `main.js` 的 `webPreferences` |
| 6 | 应用图标资源准备（1024 PNG） | `apps/desktop/build/icon.png` |
| 7 | 给 ① 的 spec 加更正注记（局限 2/3、裁决 10） | `docs/superpowers/specs/2026-09-23-…md` |
| 8 | `apps/desktop` 引入 vitest，覆盖新抽出的纯逻辑 | `apps/desktop/lib/` |

### 本期不做（明确）

1. **App 内的配置界面 / 口令 / 任何「老师入口」** —— 系统角色只有**学生 / 家长 / 运营管理员**，没有老师；**任何 App 内的配置入口都是给学生敞开的逃逸面**。改地址只走「手工编辑文件」（在范围内，见 §4.1）与「重新出包」两条路
2. **启动前探测** —— 只保留 `did-fail-load` 触发（用户裁决 §3-5）
3. **禁刷新 / 禁文本选中** —— 不构成逃逸（刷新不动 localStorage），且禁了让学生出错时无法自救（§3-7）
4. **Web 层换 Nginx、或收敛到 Nest 单端口** —— Web 层保持 `vite preview`，两层架构不动（§3-8）
5. **打包 / 出包 / 签名 / 安装包 / 自动更新** —— 属 ③ ④
6. **Web 端管控** —— 沿用旧 spec 的裁决（非 Electron 环境不建会话、不轮询、不拦登出）
7. **产品名（`productName`）/ electron-builder 配置** —— 属 ③（本设计只准备图标资源）
8. **在 App 内披露配置文件路径** —— 见 §3-12（只写交付文档）

## 3. 用户裁决记录（逐条，实现时勿推翻）

| # | 议题 | 裁决 |
|---|---|---|
| 1 | 前端产物放哪 | **服务器同源托管**（方案 A），不把前端打进包 |
| 2 | 系统角色 | **只有学生 / 家长 / 运营管理员**，**没有老师**；据此删除一切「老师入口」设计 |
| 3 | 地址来源 | **构建时写死为默认值**（推翻本设计早前的「首次启动输入」方案）；另有**手工覆盖文件**与 dev 环境变量，优先级见 §4.1。学生零操作 |
| 4 | 连不上本地页 | **保留**，但只做「连不上 + 自动重试」，不含任何配置能力 |
| 5 | 触发方式 | **不做启动前探测**，只由 `did-fail-load` 触发 |
| 6 | 已加载页面中途断网 | **不切**本地页，留在原页面等恢复 |
| 7 | 加固范围 | **只做 DevTools 禁用**；不做禁刷新 / 禁选中 / 禁右键（右键在 Electron 下本就是伪需求） |
| 8 | Web 层实现 | 保持 `vite preview`，不加 Nginx、不收敛到 Nest |
| 9 | 1.4 的洞 | **补**，归入本设计；同步给旧 spec 加更正注记 |
| 10 | IP 固定 | DHCP 保留 / 静态 IP 是**主要保障**（避免全校重装），但**不再是唯一保障** —— 有 §4.1 的覆盖文件兜底 |
| 11 | 手工覆盖文件 | **保留**一个用户可写、手工编辑的地址覆盖文件作**最后手段**（场景：地址变了而客户端无法更新/重装）。**不因此恢复任何 App 内配置入口** |
| 12 | 路径披露 | 覆盖文件的路径与格式**只写在交付文档/README**，**不在 App 内显示**（含「连不上」页）—— 学生改地址的门槛保持在「知道路径 + 会写 JSON + 有自建服务器」 |

## 4. 设计

### 4.1 地址来源：三层优先级

| 优先级 | 来源 | 用途 | 生效方式 |
|---|---|---|---|
| 1（最高） | `K12_WEB_URL` 环境变量 | dev / 临时覆盖 | 启动时读取 |
| 2 | `userData/config.json` 的 `serverUrl` | **运维最后手段**：地址变了而客户端无法更新/重装时 | 改文件后**重启 App** |
| 3（兜底） | `apps/desktop/server-url.js` 的 `SERVER_URL` | 构建时默认值 | 改此行需**重新出包** |

**地址是 Web 层的地址**（`:5173`，`vite preview`），不是 API 的 `:3001` —— 学生只认识 Web 层（① 的结论）。

#### ① 写死点 `apps/desktop/server-url.js`（只放常量）

```js
// 服务器地址的**构建时默认值**。改地址 = 改这一行 + 重新出包。
// 不改包的两条覆盖路径见 lib/resolve-server-url.js。
module.exports = { SERVER_URL: 'http://192.168.1.5:5173' };
```

#### ② 覆盖文件 `app.getPath('userData')/config.json`

```json
{ "serverUrl": "http://192.168.1.5:5173" }
```

读 + 校验抽成 `apps/desktop/lib/config-file.js`（纯 Node，**不 require electron**，userData 路径由调用方传入，故可单测）。**校验不通过一律当作「无覆盖」、回退到下一层，绝不抛错**：

| 情形 | 处理 |
|---|---|
| 文件不存在 | 无覆盖（正常路径，不是异常） |
| 非合法 JSON（含手抖写坏的文件） | 无覆盖 + `console.warn` |
| `serverUrl` 缺失 / 非字符串 / 空白串 | 无覆盖 + `console.warn` |
| 不是可解析的 `http(s)://` URL | 无覆盖 + `console.warn` |
| 合法 | 采用（去掉首尾空白） |

**设计取舍**：一个手抖写坏的文件**不该比没有文件更糟** —— 所以非法输入一律**回退到下一层**，而不是报错卡住启动（学生机一旦卡在启动就彻底不可用了）。其中**只有「文件不存在」是完全静默的**（正常路径）；JSON 损坏 / 字段非法 / 非 http(s) 都会打一行 `console.warn` 说明为什么忽略。

#### ③ 优先级判定 `apps/desktop/lib/resolve-server-url.js`（纯函数）

```js
// envUrl = process.env.K12_WEB_URL；fileUrl = config.json 读出的值（无则 null）
function resolveServerUrl(envUrl, fileUrl, fallback) {
  const hit = [envUrl, fileUrl].find((v) => typeof v === 'string' && v.trim() !== '');
  return hit !== undefined ? hit.trim() : fallback;
}
module.exports = { resolveServerUrl };
```

`main.js`：

```js
const { SERVER_URL } = require('./server-url.js');
const { readServerUrlFromFile } = require('./lib/config-file.js');
const { resolveServerUrl } = require('./lib/resolve-server-url.js');
const WEB_URL = resolveServerUrl(
  process.env.K12_WEB_URL,
  readServerUrlFromFile(app.getPath('userData')),
  SERVER_URL,
);
```

**为什么环境变量排在文件之上**：环境变量是「这一次启动的显式意图」（dev/排障），文件是持久覆盖。生产环境通常没有该变量，文件即为权威。

#### ④ 为什么不给界面

系统角色只有学生 / 家长 / 运营管理员，**没有老师**；而 App 内**任何**配置入口都是给学生敞开的逃逸面（§1.3 第 2 条）。手工文件把门槛留在「知道路径 + 会写 JSON + 有自建服务器」，并且**路径不在 App 内披露**（§3-12）。

#### ⑤ 与「IP 固定」的关系

DHCP 保留仍是**主要保障**（避免全校重装），但**不再是唯一保障** —— 覆盖文件是不重装也能救的最后手段（用户裁决 §3-10、§3-11）。此外，③ 的 CI 可在打包前用环境变量重写 `server-url.js`，从而产出指向不同服务器的包（本设计只定义「三层来源」这个性质）。

### 4.2 启动流程与「连不上」本地页

```
启动
├─ 解析 WEB_URL：K12_WEB_URL 环境变量 → config.json 的 serverUrl → server-url.js 默认值（§4.1）
├─ loadURL(WEB_URL)                      ← 启动不做探测（用户裁决 §3-5）
│    └─ did-fail-load(mainFrame，排除 ERR_ABORTED) → 显示本地页 + 启动「探测式重试」
└─ 加载成功（did-finish-load 且当前是非 file: 的 URL）→ 停表、清状态
```

**本地页**（`apps/desktop/pages/offline.html`，纯 HTML + 内联 CSS/JS，不引入 React、不参与 Web 构建）：

- 主文案：「暂时连不上学习服务器，正在重试…」
- 副文案：「如果一直连不上，请联系家长」
- 小字：当前地址（便于家长/运营报障时定位）
- 「立即重试」按钮（性急时不必等）
- ⚠️ **不显示配置文件路径、不提供任何编辑入口**（用户裁决 §3-12）—— 救援路径只写在交付文档里

#### ⚠️ 重试必须「先探测、再导航」（2026-09-26 写计划时发现的修正）

**不能**每 5 秒无脑 `loadURL`。原因：主 frame 导航失败时，Chromium 会**用它的原生错误页替换掉我们的本地页**
（`ERR_CONNECTION_REFUSED` 在提交前就失败，文档已被替换）。所以：

- 「每 5 秒 `loadURL`」的真实效果是 —— 本地页只出现一次，**之后永久变成 Chromium 的「无法访问此网站」**；
- 而若按「已在本地页就不再 `loadFile`」去防闪烁，本地页一旦被替换就**再也回不来**；
- 两者都会毁掉这张页，且都不是「闪烁」而是「整页丢失」。

**改成探测式**：主进程每 **5 秒**发一个 HTTP `GET WEB_URL`（超时 **3 秒**），
**只有探测通了才 `loadURL`**；探测不通就**什么都不做**，本地页原地不动、学生看到零变化。

- 探测模块 `apps/desktop/lib/probe-server.js`（纯 Node，可单测）
- **任何 HTTP 响应（含 4xx/5xx）都算「可达」** —— 要判断的是「连不连得上」，不是「这个路径对不对」；只有连接失败/超时才 false
- 探测成功即**停表**再 `loadURL`；若这次加载仍然失败，`did-fail-load` 会重新起表（不会死循环）
- 用一个 in-flight 标记防止 3 秒超时与 5 秒间隔叠加导致的并发探测
- 「立即重试」按钮走同一条探测路径（`shell:retry-now` → 立即探测一次）

> 注：这里只给**重试**加探测。**启动不做探测**（用户裁决 §3-5 未变）：启动路径本来就是「第一次 loadURL 失败才进本地页」，不存在本地页被替换的问题。

**其余实现要点**：

1. `did-fail-load` 必须**过滤 `isMainFrame`** —— 子资源（图片/CSS）失败也会触发该事件，不过滤会把能用的页面误判为「连不上」
2. **排除 `ERR_ABORTED`（-3）** —— 导航被取消时也会触发，此时页面并未失败（§8-6 已预警此类差异）
3. 页面**加载成功时停掉重试定时器**（`did-finish-load` 且当前 URL 非 `file:`），否则连上之后定时器还在后台空转
4. 本地页所需的「当前地址」由 `loadFile(path, { query: { url: WEB_URL } })` 传入，本地页从 `location.search` 读 —— **不为此新增 IPC 通道**

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

### 4.7 必须禁用代理（2026-09-27 真机验证后补）

`main.js` 在 `app.whenReady()` **之前**调用 `app.commandLine.appendSwitch('no-proxy-server')`。

**为什么这不是优化而是前提**：§4.2 的「连不上 → 本地页 + 探测式重连」**全靠 `did-fail-load` 触发**，
而 Chromium 会把**局域网地址也交给系统代理 / PAC**：

- `127.0.0.1` 通常被 PAC 判为直连 → 端口没人听时毫秒级拒连 → 一切正常
- **`192.168.1.5`（本机 LAN IP）走代理 → 请求挂在代理上**：`did-fail-load` **永不触发**，
  连 `Failed to load URL` 都不打，页面停在 pending 的 http URL 上 → **本地页永不出现、探测式重连不启动**
- 服务一恢复，挂着的请求立刻完成，看起来像「0 秒进入」——**假象**

**实测证据（2026-09-27，本机 macOS 开着 PAC，`scutil --proxy` →
`ProxyAutoConfigURLString: http://127.0.0.1:12223/proxy.pac`）**：服务停掉、地址为
`http://192.168.1.5:5173` 时 **30 秒无任何失败信号**；同场景加 `no-proxy-server` 后立刻出现
`ERR_CONNECTION_REFUSED`、**2 秒**出现本地页、再等 15 秒仍是本地页。
对照 `curl`：两个地址在 TCP 层都是 7ms 内拒连 ⇒ **网络本身没问题，差异纯在 Chromium 的代理解析**。

**为什么直连是对的**：本壳只跟自己的服务器通信 —— 页面、`/api`、`/assets` 全同源，④ 的更新源也计划
挂在同一台服务器上。**若将来真要经代理访问外网，需重新评估**（届时改用
`--proxy-bypass-list` 只绕过服务器地址更合适）。

⚠️ **影响面不止失败路径**：配了系统代理 / PAC 的学生机（校园网、VPN/Clash 类客户端在国内很常见），
局域网地址可能整条走代理，**正常加载也会被干扰**。部署前应在目标网络形态下验证。

## 5. 测试与验收

### 单测（`apps/desktop` 引入 vitest，与仓库一致）

壳现在**没有任何测试设施**。本期只测**抽出来的纯逻辑**（不测 Electron API，那部分靠人工冒烟）：

| 目标 | 用例 |
|---|---|
| `lib/resolve-server-url.js` | env 有值 → 取 env（**含 env 与文件同时有值时 env 胜**）；env 空串 / 未定义 → 取文件值；文件为 `null` → 取 fallback；两侧有空白 → 取 trim 后的值；三者皆空 → 返回 fallback |
| `lib/config-file.js` | 文件不存在 → `null`；非 JSON → `null`；JSON 但非对象（如 `[]`、`"x"`）→ `null`；`serverUrl` 缺失 / 非字符串 / 空白串 → `null`；`ftp://…` 等非 http(s) → `null`；合法值 → 返回 trim 后的值；用临时目录写真实文件来测（不 mock fs） |
| `server-url.js` | `SERVER_URL` 是非空字符串，且以 `http` 开头（防止写死点被改成空值后静默退化成相对地址） |
| `lib/probe-server.js` | 本地起真 http server：200 → `true`；**404 → `true`**（可达即算）；端口无人监听 → `false`；URL 不可解析 → `false`；服务器接受连接但永不响应 + 短超时 → `false` |
| `lib/shell-state.js` | 无文件 → `false`；写入后读回 `true`；JSON 损坏 → `false`；字段非布尔 → `false`；目录不存在时写入不抛 |

抽成 `apps/desktop/lib/*.js`（纯 Node，不 require electron），`main.js` 只做薄封装与副作用。

### 人工冒烟（dev 壳，`npm start`）

| # | 操作 | 期望 |
|---|---|---|
| 1 | 不设 `K12_WEB_URL`，只设好 `server-url.js`，起 web 与 server | 正常加载 |
| 2 | 关掉 web 服务后启动壳 | 显示本地页 |
| 3 | 承 #2，本地页显示期间**等 20 秒以上** | 本地页**始终在**、文案与按钮不变；**绝不出现 Chromium 的「无法访问此网站」**（这是探测式重试的核心验收点，见 §4.2 的修正） |
| 4 | 承 #3，在本地页点「立即重试」（服务器仍关着） | 页面**无任何变化**（不跳转、不刷新、不出现错误页） |
| 5 | 承 #3，重新起 web 服务 | **≤5 秒自动进入**，学生无需操作 |
| 6 | 页面加载成功后，故意让其中一张图片 404 | **不切**本地页（验证 `isMainFrame` 过滤 + `ERR_ABORTED` 排除） |
| 7 | 学生登录 → 确认进 kiosk | 全屏、关不掉 |
| 8 | 学生登录后**杀进程 + 关掉 web 服务** → 重新启动壳 | **仍是 kiosk**（补洞生效），且显示本地页 |
| 9 | 承 #8，恢复 web 服务 | 自动进入；锁未到期仍不能登出 |
| 10 | 承 #9，把锁设为已到期（或等它到点）| 能登出 → kiosk 关闭 |
| 11 | 家长账号登录 | 不是 kiosk；可关、可最小化 |
| 12 | 学生登录 → 正常登出 → 重启壳 | **不是 kiosk**（验证清标志） |
| 13 | 手动把 `shell-state.json` 写成乱码后启动 | 不是 kiosk（坏数据容错） |
| 14 | 在 userData 放 `config.json` 指向一个**错误**地址 → 启动 | 本地页显示的**就是这个错误地址**（证明文件生效、优先级高于写死值） |
| 15 | 承 #14，把 `config.json` 改成**正确**地址 → 重启 App | 正常连上（证明「不重装也能救」这条通路成立） |
| 16 | 把 `config.json` 写成**乱码** → 启动 | 回退到 `server-url.js` 的默认值；**不崩、不卡启动**，日志有 warn |
| 17 | 同时设 `K12_WEB_URL` 与 `config.json`（两者不同） | **env 胜**（§4.1 优先级） |
| 18 | **在配了系统代理 / PAC 的机器上**（`scutil --proxy` 能看到 `ProxyAutoConfigEnable:1`）：地址用**写死的 LAN 地址**，停掉服务后启动壳 | **≤5 秒出现本地页**；日志有 `Failed to load URL … ERR_CONNECTION_REFUSED`。若本地页不出现且日志没有失败行 ⇒ **代理没被禁用**（§4.7），功能静默失效 |

> 已实测（2026-09-27，本机 PAC 环境）：#18 在加 `no-proxy-server` 前 **30 秒无任何失败信号**、本地页永不出现；加后 **2 秒**出现。
> 另：**#2/#3/#4/#6/#12/#13 与 #7 之外的第 8 条，controller 已用 Electron 远程调试端口（CDP）自动化验过**
> —— 读页面 URL 判断是否 `file://…/offline.html`、读视口尺寸判断是否 kiosk。仍只能人工的是需要真实账号交互的
> #7（学生登录）、#9/#10（锁生命周期 + 家长解除）、#11（断网仍倒计时且不能登出）。

### ② 阶段**无法**验证的（必须留给 ③，别当成没做）

| 项 | 原因 |
|---|---|
| DevTools 真的打不开 | `devTools` 只在 `app.isPackaged` 时为 false，**② 不出包** |
| 图标在各平台显示正确 | 需出包 |
| Windows / Linux 上的行为 | ② 只在本机 macOS 的 dev 壳上验证 |

## 6. 非目标与已知限制（必须在文档里明说）

1. **锁定仍是客户端实现** —— 会用 DevTools 或直接改 leveldb 的学生**仍可绕过**。本设计只抬高门槛，不改变这个事实（§1.3）
2. **地址变更的代价** —— 默认走「重新出包并重装」；不想重装时走 `config.json` 手工覆盖（§4.1）。故 DHCP 保留是**主要保障**，但已有最后手段，不是无退路
3. **`config.json` 同时是一个可写逃逸入口** —— 它落在用户可写目录（跨平台可改的前提），因此知道路径、会写 JSON、且有自建服务器的学生，可以把地址指向自己的服务器（以家长身份登录 → 不被 kiosk）。**这是为「可用性最后手段」付的代价**：我们选择「宁可留一根救命稻草，也不让学生机因 IP 变更集体变砖」。缓解措施只有一条，且是有意的：**路径不在 App 内披露**（§3-12），只写在交付文档里
4. **断网期间学生确实用不了** —— 本地页只解释原因、自动重试，不提供任何功能（用户已确认接受）
5. **Electron 拦不住 `Alt+Tab` / `Cmd+Tab` / `Ctrl+Alt+Del` / 强制退出** —— 系统级，沿用旧 spec §8 局限 1
6. **本设计不出包** —— 交付物是代码 + 可在本机 dev 运行的壳；安装包/签名/自动更新属 ③ ④
7. **`studentMode` 持久化可能与真实状态短暂不一致** —— 若学生被杀进程时正处 kiosk，下次启动会先进 kiosk，直到页面加载后由渲染层纠正。**这个方向是安全的**（宁可多锁一下，不可漏锁）

## 7. 文档同步清单（仓库铁律，实现时必须一起改）

| 文档 | 要改什么 |
|---|---|
| `docs/superpowers/specs/2026-09-23-pc-app-study-lockdown-design.md` | §8 局限 2 / 局限 3 与 §3 裁决 10 加**更正注记**：说明「断网 + 杀进程 + 重启」这条路径当时未覆盖，已由本设计补齐；裁决 10 的「杀进程换不来自由」需限定为「杀进程**且**服务器可达时」；⚠️ 注记措辞必须对两条都成立（局限 2 讲的是「杀进程后退出时间模糊」，与网络无关，别用「本条只覆盖学习中途断网」这类只适用于局限 3 的措辞） |
| `docs/constraints/pc-app-学习管控.md` | 新增本设计的硬约束：**地址三层来源与优先级**、覆盖文件的**校验降级规则**（非法输入一律回退到下一层、绝不卡启动；**文件不存在完全静默，其余非法情形打 `console.warn`**）、`studentMode` 持久化（启动即 kiosk）、`devTools` 仅生产禁用、本地页**探测式重试**的实现要点（`isMainFrame` 过滤 + 排除 `ERR_ABORTED` + 探测通了才导航 + 成功即停表 + 探测并发防抖）、**必须全局禁用代理**（§4.7，否则本地页永不出现）、以及 §4.4「明确不做」那四条 |
| `CLAUDE.md` | **不新增章节**（体量纪律：内容进 `docs/constraints/`，此处至多一行指向） |
| `README.md` | PC App 章节补三块：① 默认地址写死在 `apps/desktop/server-url.js`；② **地址变更的救火步骤** —— 覆盖文件的**三平台完整路径**、JSON 格式示例、改完要**重启 App**、以及「非法文件会被忽略并回退到默认值」；③ 连不上时的现象（本地页 + 5 秒自动重试）与「杀进程 + 断网不再能逃逸」 |
| `docs/ai-core-changelog.md` | 记录本次设计与实现（含发现 1.4 那个洞的经过） |
| `docs/API接口与数据流设计文档.md` + `docs/api/openapi.yaml` | **无需变更**（本设计不涉及任何端点）—— 明确记录此结论，免得后来者以为漏同步 |

## 8. 风险

1. **补洞会碰到既有的 kiosk 语义**（kiosk 由「角色」驱动而非「锁定」，2026-09-24 才刚拆开）→ 改动必须复用同一段应用函数，禁止在启动路径里另写一套；人工冒烟 #7–#12 是本项的主要证据
2. **写死地址使「IP 固定」成为主要保障** —— 忘配 DHCP 保留后只剩两条补救路：全校重装，或逐台手工改覆盖文件（都很贵）。这条要在 ③ 的部署文档里再强调一次
3. **覆盖文件的存在必须写进交付文档，否则本设计白做** —— 它是「客户端无法更新时」唯一的自救手段；文档漏写就等于不存在。§7 已把「三平台完整路径 + 格式示例 + 重启要求 + 非法文件会被忽略」列为 README 的必写项
4. **覆盖文件是新的可写逃逸面**（§6-3）—— 无法消除，只能靠「不披露路径」抬高门槛；若将来发现被利用，退路是改为需签名/加密的文件格式（本期不做）
5. **`shell-state.json` 是新的持久化状态** —— 与 localStorage 里的真实状态是两个源，存在不一致窗口；本设计选择「偏向多锁」的方向（§6-7）
6. **`did-fail-load` 的行为差异** —— 不同平台的错误码与触发时机可能有别（如 `ERR_ABORTED` 在导航取消时也会触发）。实现时须以人工冒烟 #2–#6 为准，必要时加错误码白名单
7. **⭐ 重试若写成「反复 `loadURL`」会毁掉本地页**（写计划时发现，已修正 §4.2）—— 主 frame 导航失败会让 Chromium 用它自己的错误页替换我们的本地页，于是「每 5 秒 loadURL」的结果是本地页只出现一次、之后永久变成浏览器的「无法访问此网站」；而「已在本地页就不重载」的防闪烁写法会让它再也回不来。**必须探测通了才导航**。人工冒烟 #3 是这条的专门验收点
8. **`userData` 目录名会被 ③ 的 `productName` 改掉** —— `app.getPath('userData')` 用的是 `app.getName()`，它取 `productName`（若设了）否则取 `name`。本期 `package.json` 无 `productName`，故路径是 `…/k12-desktop/`。**③ 若设了 `productName`，覆盖文件与状态文件的路径都会变，README 里那三条平台路径必须同步改**；否则文档会指向一个不存在的目录，救火时找不到文件
9. **③ 打包必须包含壳的运行时资源，否则会静默紧循环** —— `showOfflinePage()` 用
   `loadFile('pages/offline.html')` 加载本地页，**没有失败守卫**。若 ③ 的打包配置漏了这个文件
   （asar / `files` 白名单），`loadFile` 失败 → 触发 `did-fail-load` → 再次 `showOfflinePage()`
   → **无节流的紧循环，且屏幕上没有任何可见 UI**（这条路径不受重试定时器限流）。
   **③ 的打包清单必须钉住**：`pages/offline.html`、`lib/*.js`、`server-url.js`、`preload.js`
   都要进包（`build/icon.png` 位置正确，已在 `buildResources`）。
   可选加固：给 `loadFile` 加一个「本地页也加载失败就不再重试」的标记。
