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
- **做不到的别当缺陷修**：拦不住 `Alt+Tab`/`Cmd+Tab`/`Ctrl+Alt+Del`/强制退出；**不区分异常退出**；真·无法切屏靠 OS 级单应用模式（运维）。**非目标**：自动更新（属 ④）、签名/公证、Web 端管控、`force_close`、云端部署（壳留 `K12_WEB_URL` 接缝）。
  （**更正 2026-09-27**：安装包**已移出**上面这份清单 —— 交付形态就是安装包，见本文末「打包与分发（③）」；自动更新仍属 ④。）

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

## 打包与分发（2026-09-27，③）

来源：`docs/superpowers/specs/2026-09-27-pc-app-packaging-design.md`

- **新增 YAML 必须检查 `.gitignore`**：根 `.gitignore` 有一条**文件级全局规则** `*.yml`，
  会**静默**吃掉本该入库的 YAML（`git add` 不报错、CI 不报错，只有产物缺内容时才暴露）。
  目前靠**两条**反选放行：`!apps/desktop/electron-builder.yml`、`!.github/workflows/*.yml`
  （`.gitignore` 里另有一条反选 `!apps/desktop/build/`，那是给旧的 `build/` 规则用的、与 `*.yml` 无关，别混在一起数）。
  有 `apps/desktop/gitignore.guard.test.js` 钉着，**改 .gitignore 后跑 `npm test`**
- **`files` 是白名单**（`electron-builder.yml`），且**必须排除 `*.test.js`**。白名单漏一件的后果是
  `pages/offline.html` 那种**无节流紧循环 + 屏幕无 UI**（② spec §8-9）。出包后由
  `apps/desktop/scripts/verify-asar.js` 断言「必需 9 项齐全、无 `*.test.js`」，**CI 红则不发**
- **`artifactName` 必须全 ASCII**（`k12-desktop-${version}-${arch}.${ext}`）：默认模板带中文
  `productName` 与空格，会污染 `/download/` 的 URL
- **`appId` 发布后改不得**（`com.k12zhixue.desktop`）：装过的机器按它认身份，④ 的更新也按它认
- **`mac.identity: null` + `CSC_IDENTITY_AUTO_DISCOVERY=false`** 都是有意的（不签不公证，spec §3-2）；
  别「顺手」打开签名 —— 会产出本机/CI 不一致的产物
- **`electron-builder.yml` 里故意不写 `publish`**：地址的唯一真源是 `apps/desktop/server-url.js`，
  CI 与 `tools/publish-installer.sh` 都从它推导。**别把 URL 抄进 yml**（那就是第二处、必然漂移）
- **mac 包只能在 macOS runner 上构建**（`dmg` 依赖 `hdiutil`）；win/linux 只出 x64。
  **本机出不了 AppImage**（要 docker）—— 本机验证一律用 `--mac`
- **不签名 → macOS 15+ 没有「右键→打开」这条路**：交付文档只能给
  `xattr -dr com.apple.quarantine` 或「系统设置 → 隐私与安全性 → 仍要打开」

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
