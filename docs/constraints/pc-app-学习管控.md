# PC App 学习管控（2026-09-23）

> **本文由根 `CLAUDE.md` 于 2026-09-24 迁出**（体量纪律：根文件只留仍生效硬规则与索引，带细节的「勿动」清单按主题搬到本目录）。**内容一字未改。**
>
> ⚠️ **动手改本主题之前必须先读本文** —— 这里的每一条都是「读代码/配置得不到的为什么」或「改了会踩坑的勿动」。索引见根 `CLAUDE.md` 的「权威文档索引」。

---

`apps/desktop`（Electron 壳，**dev 模式**；本期不出安装包）+ 「单次学习锁定」。设计见 `docs/superpowers/specs/2026-09-23-pc-app-study-lockdown-design.md`；契约见 API 文档 §4.25/§5.30。

- **布局：PC App 与 Web 完全相同，不做三栏**（推翻 UX/架构的 P1「三栏」承诺）。角色驱动：学生 → kiosk、`parent`/`admin` → 普通窗口；角色闸门放**路由 effect**（登录/登出是客户端导航、不刷新页面）。
- **⚠️ kiosk 由「角色」决定，与家长有没有设时长无关** —— 推给壳的是 `setStudentMode(role === 'student')`；`session_lock_minutes` **只决定能不能登出 + 要不要显示 pill**。**这两件事勿合并成一个布尔**（合并过一次：家长没设时长 → 学生登录后完全不被全屏、可随便切应用，用户实测报回）。`UNLOCKED`（学生但无锁/已到期/已解除）**仍是 kiosk 全屏**，只是允许登出。改 `preload.js` 接口名**必须重启壳**（preload 只在窗口创建时加载）。
- **禁退三处缺一即逃逸口**：① `LogoutButton` 自判（**`aria-disabled` 而非原生 `disabled`** —— 原生禁用不触发 click、toast 弹不出来；**不许改 `aria-label`**，4 个测试靠它断言）；② 壳拦 `close`/`before-quit`/`minimize`；③ 壳拦外链与跨源导航。
- **`learning_sessions` 的「一个学生同时只有一个进行中」由 DB 条件式 VIRTUAL 生成列 + 唯一键保证**（「重启不重置时钟」的基础）：**必须 VIRTUAL 不能 STORED**（STORED 重建整表被外键 1215 挡住）；**验证生成列必须用真表**，临时表得假阳性。
- **`LEARNING_SESSION_POLL_MS = 10_000` ↔ `LEARNING_SESSION_ONLINE_WINDOW_SECONDS = 45` 是镜像**，改一处必须同步另一处；`online` **后端算好下发**，前端不重算。
- **拔网线不解锁**（有意的严格性）：失败**绝不清锁**，本地截止时间是唯一判据。`session_lock_minutes` 是**单次登录起算的墙钟窗口**（1..480，**默认 30**；`NULL` = 家长**显式解除设置**），**不是**已废除的每日累计；它是**开始时快照**，家长事后改设置不影响本次。
- **家长下发命令的主防线 = 「没有进行中会话就 409/1001、不写命令」**；惰性过期只是兜底。命令认领与 `unlocked_at` 落库**必须同一事务**。
- **做不到的别当缺陷修**：拦不住 `Alt+Tab`/`Cmd+Tab`/`Ctrl+Alt+Del`/强制退出；**不区分异常退出**；真·无法切屏靠 OS 级单应用模式（运维）。**非目标**：安装包/自动更新/签名、Web 端管控、`force_close`、云端部署（壳留 `K12_WEB_URL` 接缝）。

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
- `userData` 目录名取 `productName`（若设）否则 `name`。**③ 若设了 `productName`，
  覆盖文件与状态文件的路径都会变，README 里的三条平台路径必须同步改**

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

### 生产加固：只做 DevTools，四条「不做」勿补

- `webPreferences.devTools = !app.isPackaged`。dev 保留，生产一并封掉 F12 / `Cmd+Opt+I` / `Ctrl+Shift+I`
- **明确不做**（补回来是错的）：**禁右键**（Electron 默认不弹右键菜单，Web 应用也无自定义右键菜单，
  没有东西可禁）、**禁刷新**（不动 localStorage，锁还在，不构成逃逸，禁了让学生出错时无法自救）、
  **禁文本选中**（与防逃逸无关，学生可能要复制）、**禁拖拽**（`will-navigate` 已拦非同源）