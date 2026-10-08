# AI_k12: Intelligent Specialized Breakthrough & Self-Learning System

## Project Vision
AI_k12 is a next-generation, adaptive learning platform designed for K12 education. It leverages artificial intelligence to provide personalized learning paths, hierarchical knowledge explanations, and precision assessment across core subjects (Math, Chinese, English, Physics, Chemistry, and Moral & Rule of Law).

The goal is to move away from "blanket teaching" towards "precision learning" by diagnosing student levels and providing targeted, deep-dive explanations and practice.

## Core Features
- **Diagnostic Engine**: Precision assessment of student's current academic level.
- **Hierarchical Knowledge System**: Systemic explanations ranging from broad semester overviews to deep-dives into specific granular points.
- **Adaptive Learning Loop**: Exercises that assess absorption and provide targeted remedial explanations.
- **Multi-level Proficiency Testing**: Tiered assessments to verify mastery.
- **Intelligent Q&A**: An AI tutor that guides students through problem-solving rather than just providing answers.

## Technology Stack
- **Frontend**: React (latest)
- **Desktop App**: Electron
- **Backend**: Node.js
- **Data Crawling & Processing**: Python
- **Core AI**: LLM-driven (Prompt Engineering & RAG)

## Project Structure
- `apps/web`: React-based web application.
- `apps/desktop`: Electron shell for PC App (loads the **same UI as Web**; 交付形态是安装包，见下文 PC App 章节). 见 [PC App 学习管控设计](docs/superpowers/specs/2026-09-23-pc-app-study-lockdown-design.md)。
- `apps/server`: Node.js backend API (NestJS + ai-core AI Agent Hub).
- `tools/crawler`: Python-based data crawling and processing service.
- `packages/`: Shared configurations and types.
- `docs/`: Design documents and requirements.

## 快速启动 (Quick Start)

### 前置条件
- **Node.js**：推荐 LTS 版本。
- **MySQL 8.x**：Server 端连接所需。首次可用 `tools/db/install_mysql.sh` 初始化库（建 schema + seed 学科），库名/账号默认 `ai_k12/ai_k12@localhost/ai_k12`。
- 各端依赖分别安装（monorepo 未统一装包）：在 `apps/web`、`apps/server` 目录下各执行一次 `npm install`。

### 部署与日常启停

- **首次部署**（全新机器，装环境 + 建库 + 构建 + seed + 启动）：`bash tools/deploy.sh`。
- **部署完成后的日常启停**（不构建不安装，只管进程）：

```bash
bash tools/services.sh start    # 启动 server + web（已在运行则跳过），含健康检查
bash tools/services.sh stop     # 停止
bash tools/services.sh restart  # 重启
bash tools/services.sh status   # 查看运行状态
bash tools/services.sh log server  # 跟踪 server 日志（log web 同理）
```

PID/日志与 deploy.sh 共用 `tools/deploy/runtime/`；由 deploy.sh 启动的服务也可用本脚本停止/重启。

#### 局域网部署运维清单（让学生机接入本机服务器）

本机同时是**服务器**：`vite preview`（`:5173`）对外提供页面并反代 `/api`、`/assets`、`/uploads`
到 Nest（`:3001`），Nest 只在本机内网可达。学生机通过局域网访问 `http://<本机IP>:5173`。

部署前逐条确认：

1. ☐ **本机 IP 固定** —— 路由器后台把本机 MAC 绑定到固定地址（DHCP 保留/静态 IP）。
   学生机壳里写死的就是这个地址，**IP 一变，所有学生机都要重新出包重装**，
   或逐台改 `config.json`（见下文「地址变了…」）
2. ☐ **防火墙放行 5173** —— macOS「系统设置 → 网络 → 防火墙」；本机实测当前**防火墙已关闭**，
   故无需额外配置（若日后开启，需放行 `node` 与端口 `5173`）
3. ☐ **换机实测** —— 拿另一台电脑/手机浏览器打开 `http://<本机IP>:5173`，确认能到登录页
4. ☐ **开机自启**（建议）—— 现在服务靠手动 `bash tools/services.sh start`；
   **本机一重启服务不会自己起来，所有学生机立刻白屏**。需要配 launchd（macOS）或等价机制

### PC App (`apps/desktop`，Electron 壳)

本地开发需要**三个进程**（壳加载的是 Web 的页面，不另起一套 UI）：

```bash
cd apps/server && npm run build && node dist/main.js   # 1) 后端 :3001（必须用 dist：npx tsx 的 DI 是坏的）
cd apps/web    && npm run dev                          # 2) 前端 :5173
cd apps/desktop && npm install && npm start            # 3) 壳（首次 npm install 会下载 Electron 二进制，约 100MB+，较慢）
# 壳默认加载 apps/desktop/server-url.js 里写死的地址（当前 http://192.168.1.5:5173）
# 临时换地址：K12_WEB_URL=http://… npm start
```

> 学生登录即进真全屏 kiosk（**处于 kiosk 就关不掉窗口**，与是否在锁定期无关）；家长/管理员登录是普通窗口。
> ⚠️ Electron 拦不住 `Alt+Tab` / `Cmd+Tab` / `Ctrl+Alt+Del` / 强制退出 —— 那是系统级；
> 真·无法切屏要靠装机时的 OS 级单应用模式（运维配置）。见 [设计文档](docs/superpowers/specs/2026-09-23-pc-app-study-lockdown-design.md)。

#### 交付形态：安装包（学生机不需要装 Node）

本地开发才需要上面那三个进程。**发到学生机的是安装包** —— 双击装完就是「K12 智学」应用。

- **从哪下载**：服务器 web 层的 `http://<本机IP>:5173/download/`
  （学生/家长在局域网内直接取，不需要学生机访问公网）
  - **发布过之后**，`/download/` 会打开一张由 `tools/publish-installer.sh` 生成的下载页，
    页面上列出下载目录里实际存在的全部产物（含大小，并标注哪个是本次发布、哪些是早期版本）；逐个点链接即可下载。单文件直链形如
    `<服务器地址>/download/<文件名>`（例如 `http://192.168.1.5:5173/download/k12-desktop-0.1.0-arm64.pkg`）
  - ⚠️ **文件名打错不会 404**：`vite preview` 没有目录列表、且用的是 SPA 回退，
    未命中的路径会返回**学习应用本体**（HTTP 200 + HTML），浏览器会把这份 HTML 存成 `.pkg`。
    所以**只从下载页点链接**，别手敲文件名。**没发布过之前 `/download/` 里没有下载页**
    （访问它同样拿到的是应用本体，不是文件列表）
- **怎么产出**：用出包入口脚本，**参数的唯一说明处是它的 `--help`**

  ```bash
  bash tools/app-build.sh --help                # 全部参数与示例
  bash tools/app-build.sh --check               # 改完壳先跑这个：测试 + 最小出包 + 资源自检（约 10s）
  bash tools/app-build.sh --local               # 本机出两个 mac pkg：x64 + arm64（约 1min）
  bash tools/app-build.sh --local --manifest    # 上面两个 pkg 再加更新清单 latest-mac.yml（若仍产出）
  ```

  - **Windows / Linux 产物本机出不了**（NSIS 要 wine、AppImage 要 docker），只能走 CI：

    ```bash
    bash tools/app-build.sh --online              # 只预检并打印要推什么（不推）
    bash tools/app-build.sh --online --yes        # 预检通过后真打 tag 并推，触发三平台出包
    ```

    推完到 GitHub 的 Actions 页面看 `Desktop Release`，跑完下载 artifact（需要登录 GitHub）。
    **tag 形如 `desktop-v0.1.0`，必须等于 `apps/desktop/package.json` 的 version，否则 CI 直接失败**（防版本漂移）。
  - ⚠️ **打包这一步会去取 Electron 发行包，走的是 HTTPS（443）**。该路径不通时 electron-builder
    会报 `read ECONNRESET` 或干脆卡住（**即使本机 `~/Library/Caches/electron` 里已有缓存也一样**）——
    那不是壳坏了，先修网络 / 代理再重试。
    ⚠️ **别把「能 push」当成「能打包」**：2026-09-28 实测本机 HTTPS 到 GitHub 被 reset，
    而 git 走 SSH 照样能推 tag —— 两条路互不影响。**CI 侧不受影响**（runner 的网络是通的）。

- **怎么发布到服务器**（把从 artifact 或本机 `dist/` 解压/产出的文件拷到 web 层的 `/download/`）：

  ```bash
  bash tools/app-build.sh --publish apps/desktop/dist/k12-desktop-0.1.0-arm64.pkg apps/desktop/dist/latest-mac.yml
  # 等价于 bash tools/publish-installer.sh <安装包> <latest.yml> [latest-linux.yml ...]（同一实现，只是统一了入口）
  # 建议连每个安装包旁的 .blockmap 一起传（差量更新用；缺了它 ④ 只能回退成全量下载）
  # 同时会（重新）生成 /download/ 的下载页，页面上列出目录里实际存在的产物，并标注本次发布 / 早期版本
  # 会重建一次 web（几十秒）—— vite 会把 public/ 拷进 dist/，所以文件不会在下次构建时丢
  # ⚠️ 这一步**会替换正在对外服务的 apps/web/dist/**（:5173 的 vite preview 服务的就是它），
  #    所以工作区里未提交的前端改动会被一并构建、立刻对局域网生效 —— 发布前先确认工作区干净。
  ```

#### ⚠️ macOS 安装与首次打开（未签名）

安装包是 `.pkg`，**没有代码签名、也没有公证**。双击安装，若提示「无法验证开发者 / 不能打开」：

1. 到 **系统设置 → 隐私与安全性**，找到关于 K12 智学 的拦截提示，点 **仍要打开**；
2. 再次双击 `.pkg`，按安装器「继续 → 安装」，输入开机密码；
3. 完成后从启动台或「应用程序」打开「K12 智学」。**全程不需要终端。**

> pkg 安装器装出的应用**不带隔离属性**，不会出现「能打开却一直『暂时连不上学习服务器』」的
> quarantine 问题（2026-10-07 事故，见 docs/superpowers/specs/2026-10-07-pc-app-mac-pkg-installer-design.md）。
> **早期发布的 .dmg 包**仍拖拽安装，若被拦需终端执行
> `xattr -dr com.apple.quarantine "/Applications/K12 智学.app"` 或走「仍要打开」。
> 不要按老文章去「右键 → 打开」—— macOS 15 起已移除这条捷径。

#### ⚠️ Windows 首次打开：会被 SmartScreen 拦（未签名）

`.exe` 安装包**没有代码签名**，所以首次运行会弹 Windows SmartScreen 警告（「Windows 已保护你的电脑」）。
按 **「更多信息」→「仍要运行」** 即可继续安装。不是文件坏了。

#### 服务器地址（三层优先级）

壳加载的是 **Web 层地址**（`vite preview`，默认 `:5173`），不是 API 的 `:3001`。解析顺序：

```
K12_WEB_URL 环境变量  >  userData/config.json 的 serverUrl  >  apps/desktop/server-url.js 的默认值
```

- **默认值**写在 `apps/desktop/server-url.js` 一行里；改它需要**重新出包**
- **dev 临时改**：`K12_WEB_URL=http://… npm start`

#### ⚠️ 地址变了、而客户端又没法重新装：改覆盖文件救火

**这是客户端连不上时唯一的自救手段。** 手工创建/编辑下面这个文件，然后**重启 App**：

| 平台 | 路径 |
|---|---|
| Windows | `%APPDATA%\k12-desktop\config.json` |
| macOS | `~/Library/Application Support/k12-desktop/config.json` |
| Linux | `~/.config/k12-desktop/config.json` |

内容就一行（**把地址替换成服务器的新地址**；照抄下面这行等于没改 —— 它正好是当前默认值）：

```json
{ "serverUrl": "http://192.168.1.5:5173" }
```

- 改完**必须重启 App** 才生效（启动时读取）
  - ⚠️ **如果窗口关不掉**：学生处于 kiosk（学生模式）时，壳会自己拦掉关闭 / 最小化 / `Cmd+Q` / `Alt+F4`。
    此时用系统的**强制退出**（macOS `Cmd+Opt+Esc`；Windows 任务管理器；Linux 等价方式）
    或**直接重启这台机器**，再打开壳。**这是唯一能绕过壳自身拦截的出口** —— 别在窗口上反复点关闭
- 必须是合法 JSON，且 `serverUrl` 是 `http(s)://` 开头的完整地址；
  **不合法时会被忽略并回退到 `server-url.js` 的默认值，不会让 App 卡住启动**
  （启动日志里会有一行 `warn` 说明为什么忽略）

#### 连不上服务器时会看到什么

学生打开壳若连不上，会看到一张本地页：「暂时连不上学习服务器，正在重试…」+ 当前地址 +
「立即重试」按钮。壳**每 5 秒自动探测一次，探测通了就自动进入**，学生不需要做任何事。

#### 已知边界

- 学生登录即进 kiosk；**只要处于 kiosk（学生模式）就关不掉窗口**（与是否在锁定期无关）；
  「不能登出」才是锁定期间的限制，只有家长能解除或到期自动解除
- 「**断网 + 杀进程 + 重启**」不再能逃逸：启动时会先读回上次的学生模式，直接进 kiosk
- **壳全局不使用代理**（`no-proxy-server`）。它只访问自己的服务器，直连最稳；这也很关键 ——
  若走系统代理/PAC，局域网地址会被代理挂住、`did-fail-load` 不触发，**那张「连不上」本地页就不会出现**。
  所以：装壳的机器**不需要**（也不能靠）配代理来访问学习服务器
- Electron 拦不住 `Alt+Tab` / `Cmd+Tab` / `Ctrl+Alt+Del` / 强制退出 —— 那是系统级；
  真·无法切屏要靠装机时的 OS 级单应用模式（运维配置）

### Web 端 (`apps/web`)

Vite + React + TypeScript 前端，所有命令在 `apps/web/` 下执行：

```bash
cd apps/web
npm install          # 首次安装依赖
npm run dev          # 启动开发服务器，访问 http://localhost:5173
```

常用命令：

| 命令 | 说明 |
| --- | --- |
| `npm run dev` | 启动 Vite 开发服务器（默认端口 5173） |
| `npm run build` | `tsc -b` 类型检查 + `vite build` 打包 |
| `npm run preview` | 本地预览生产构建 |
| `npm run lint` | ESLint 检查 `.ts/.tsx` |

### Server 端 (`apps/server`)

NestJS 后端，内含 ai-core AI Agent Hub。开发服务器默认监听 `http://localhost:3001`，CORS 已放行 `localhost:5173/5174/3000`。所有命令在 `apps/server/` 下执行：

```bash
cd apps/server
npm install          # 首次安装依赖
cp .env.example .env # 复制环境变量模板，并按下方说明填写
npm run start:dev    # 开发模式：免编译热重载，监听 http://localhost:3001
```

> ℹ️ 开发用 `npm run start:dev`（`node --watch` + `@swc-node/register`，免编译热重载，已实测 DI 正常）。生产或需稳定启动时用 `npm run build && npm start`（`tsc` 编译后 `node dist/main.js`）。**不要用 `tsx` 直接跑** `src/main.ts`——会导致 NestJS 依赖注入失效（实测不可用）。

常用命令：

| 命令 | 说明 |
| --- | --- |
| `npm run start:dev` | 开发热重载（swc-node，免编译，推荐开发用） |
| `npm run build` | `tsc` 类型检查 + 编译到 `dist/` |
| `npm start` / `npm run start:prod` | 运行 `node dist/main.js`（需先 `build`） |
| `npm test` | `vitest run` 执行单元测试 |
| `npm run test:watch` | vitest watch 模式 |

#### 环境变量 (`.env`)

`apps/server/.env.example` 仅含 LLM 凭证模板，实际运行还需补充 DB 与 JWT 配置。完整所需项：

- **LLM 提供商**（至少填一个，含 `*_BASE_URL` + `*_API_KEY`）：
  - `KIMI_API_KEY` / `QWEN_API_KEY` / `GEMINI_API_KEY` / `DEEPSEEK_API_KEY`
  - 注意：ai-core 专属变量，**不要用 `ANTHROPIC_*`**（会被 shell 里的 Claude Code 覆盖）。
- **数据库**：`DB_HOST` / `DB_PORT` / `DB_USER` / `DB_PASSWORD` / `DB_NAME`（默认 `ai_k12`）。
- **鉴权**：`JWT_SECRET`。
- **可选**：`PORT`（默认 `3001`）、`UPLOAD_DIR`（用户上传图片目录，默认 `./uploads`）。

### 本地联调

```bash
# 终端 1：启动后端
cd apps/server && npm run start:dev            # http://localhost:3001（开发热重载）

# 终端 2：启动前端
cd apps/web && npm run dev                     # http://localhost:5173
```

前端默认通过 `/api/*` 访问后端；后端启动时会把 `tools/data-refinery/output/assets` 挂到 `/assets/`、`UPLOAD_DIR` 挂到 `/uploads/` 提供静态服务。

## Development Roadmap (Phase 1: Knowledge Learning System)
1. Initialize Project Skeleton
2. Design Hierarchical Knowledge Data Model
3. Build Node.js Knowledge API
4. Build React Knowledge Navigation & Display UI
5. Electron Desktop Integration → **已落地（2026-09-23；安装包分发 2026-09-27 落地，签名仍未做）**：`apps/desktop` 壳 + kiosk 单次学习锁定，见 [设计文档](docs/superpowers/specs/2026-09-23-pc-app-study-lockdown-design.md)（**签名仍非目标**；自动更新待 ④）
