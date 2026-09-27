# PC App 打包与三平台分发（③）— 设计

> **架构锚点**：`apps/desktop/`（Electron 壳，② 已交付）、`tools/services.sh`（Web 层托管）、
> `docs/superpowers/specs/2026-09-26-pc-app-shell-productionization-design.md`（②，本设计的前置）、
> `apps/desktop/server-url.js`（**服务器地址的唯一真源**，本设计复用）。

## 0. 本设计在「PC App 正式交付」中的位置

四个子项目，**本设计只做 ③**：

| # | 子系统 | 依赖 | 状态 |
|---|---|---|---|
| ① | 服务器同源托管前端 + 局域网可达 | 无 | **已存在**（`tools/services.sh` 用 `vite preview --host 0.0.0.0` 托管） |
| ② | 壳生产化（地址三层来源 / 本地页 / kiosk 持久化 / devTools / 图标） | ① | **已交付并推送**（`main` 的 `f3b702a`） |
| **③** | **打包与三平台分发（electron-builder + GitHub Actions + 签名结论 + 发布到本机服务器）** | ② | **本设计** |
| ④ | 自动更新（更新源托管 + electron-updater + 与锁定的时机裁决） | ③ | 待立项 |

**为什么 ③ 不可省**：现在学生机要跑壳得装 Node + 在 `apps/desktop` 里 `npm install`（下 ~100MB Electron）+ 命令行 `npm start` —— 这不可能发给 K12 学生。③ 是让 ② 变成「双击安装包就能用」的那一步。

## 1. 背景与现状（2026-09-27 实测，勿凭记忆）

| 事实 | 值 / 结论 |
|---|---|
| 壳的运行时资源 | `main.js`、`preload.js`、`server-url.js`、`lib/` 四个模块（`config-file` / `resolve-server-url` / `probe-server` / `shell-state`）、`pages/offline.html`、`build/icon.png` |
| **不该进包的** | 5 个 `*.test.js`（默认会被打进 app 目录，必须显式排除） |
| Electron 版本 | `v44.4.5` |
| electron-builder | **未安装**；当前主线是 **v27**，需 **Node ≥ 22.12** |
| **Electron 44 的连带事实** | **已移除 Windows ia32 构建**；v27 对 ia32 / armv7l 配 `electronVersion >= 44` 会**快速失败**（与「只出 x64」的计划一致） |
| 本机 | macOS **arm64**（Apple M1），node `v25.2.1` |
| 仓库可见性 | **公开**（匿名 API 200）→ **GitHub Actions 分钟数免费无限**（含 macOS runner） |
| 仓库体量 | 1132 个已跟踪文件 / `.git` 54MB / 最大文件 1.2MB → CI 检出无压力，**不需要 LFS** |
| `apps/desktop/dist/` | **已被根 `.gitignore` 的 `dist/` 忽略** ✓（electron-builder 默认输出目录） |
| 现有 CI | **无**（无 `.github/`） |
| 版本 / tag | `apps/desktop/package.json` = `0.1.0`；**无任何 tag**；**无 `productName`** |
| `gh` CLI | **token 已失效**（`Failed to log in to github.com account garrylea`）—— 控制器无法在本机观测 CI 结果 |
| 本机交叉构建工具 | `wine` / `docker` / `podman` **均未安装** |

## 2. 范围

### 本期做

| # | 内容 | 落点 |
|---|---|---|
| 1 | electron-builder 配置（标识 / `files` 白名单 / 三平台 target / `artifactName` / `publish`） | 新增 `apps/desktop/electron-builder.yml` |
| 2 | **钉死 `userData`**，与 `productName` 解耦 | `apps/desktop/main.js` |
| 3 | 三平台构建 workflow（含出包前测试门禁 + 产物白名单校验） | 新增 `.github/workflows/desktop-release.yml` |
| 4 | 发布到本机服务器（`/download/`） | 新增 `tools/publish-installer.sh` + `.gitignore` 一条 |
| 5 | 更新清单产出（为 ④ 铺路，本期不接更新逻辑） | 由 `publish` 配置带来 |
| 6 | 交付文档：未签名 mac 的首次打开指引、下载路径、版本/tag 流程 | `README.md` 等 |
| 7 | 结清 ② 遗留的 ③ 待验项：**生产构建下 DevTools 打不开** | 验收，非代码 |

### 本期不做（明确）

1. **代码签名 / 公证**（mac 不签、Win 不买证书）—— 用户裁决，见 §3-2
2. **macOS 自动更新** —— 用户裁决，见 §3-3
3. **自动更新的逻辑本身**（检查/下载/安装/重启时机，与学习锁定的冲突裁决）—— 属 ④
4. **静默安装 / 批量部署**（GPO、MSI、脚本化装机）
5. **增量更新 / 差分包**
6. **arm64 的 Windows / Linux 产物**（只出 x64）
7. **把 GitHub Releases 当学生的下载渠道** —— 学生一律从本机服务器取（见 §3-5）
8. **安装包版本归档策略**（留几个版本、怎么命名历史版本）

## 3. 用户裁决记录（逐条，实现时勿推翻）

| # | 议题 | 裁决 |
|---|---|---|
| 1 | 产物怎么产出 | **GitHub Actions matrix**，三平台各自原生构建（仓库公开 → 分钟数免费；免去在本机装 wine/docker） |
| 2 | macOS 签名 | **不签不公证**；首次打开由交付文档给「右键→打开」或 `xattr -dr com.apple.quarantine` |
| 3 | mac 自动更新 | **不做** —— 自动更新只覆盖 Win/Linux |
| 4 | 更新清单 | **③ 顺手产出** `latest.yml` / `latest-linux.yml`（electron-builder 自带），**本期不接更新逻辑**，为 ④ 铺路 |
| 5 | 安装包放哪 | **本机服务器 web 层的 `/download/`**；学生/家长从局域网取，不需要学生机访问公网 |
| 6 | 应用名与路径 | **钉死 `userData` = `k12-desktop`** + 中文 `productName`（`K12 智学`）→ 应用名好看、救火路径不变 |
| 7 | mac 产物形态 | **双架构两个 dmg**（x64 + arm64），不用 universal |
| 8 | `appId` | `com.k12zhixue.desktop`（**发布后改不得**） |
| 9 | CI 里的测试门禁 | **出包前跑 `apps/desktop` 的 38 条测试**，红则不出包 |

## 4. 设计

### 4.1 `apps/desktop/electron-builder.yml`（新建）

```yaml
appId: com.k12zhixue.desktop
productName: K12 智学
directories:
  buildResources: build          # build/icon.png 会被自动采用
  output: dist                   # 已被 .gitignore 忽略
# ⚠️ 白名单而非黑名单：默认会把 app 目录下所有文件打进包，包括 *.test.js
files:
  - main.js
  - preload.js
  - server-url.js
  - lib/**/*.js
  - pages/**
  - package.json
  - '!**/*.test.js'
# 产物名必须 ASCII：默认模板含 productName（中文 + 空格），会污染 /download/ 的 URL。
# 用 ${ext} 区分平台（dmg/AppImage/exe 本身就不同），${arch} 区分两个 mac 包。
artifactName: k12-desktop-${version}-${arch}.${ext}
win:
  target: [{ target: nsis, arch: [x64] }]
mac:
  target: [{ target: dmg, arch: [x64, arm64] }]
linux:
  target: [{ target: AppImage, arch: [x64] }]
# ⚠️ 这里**故意不写 publish** —— 下载地址的唯一真源是 apps/desktop/server-url.js，
# 写到 yml 里会成为第二处、必然漂移。CI 每次都用 --config.publish.url 注入（§4.5）。
```

**为什么 `artifactName` 必须显式覆盖**：electron-builder 默认是 `${productName}-${version}-${arch}.${ext}` → 会产出
`K12 智学-0.1.0-arm64.dmg`（**中文 + 空格**）。空格在 URL 里要转义，交付文档里的复制粘贴会变脆。
改成 `k12-desktop-0.1.0-arm64.dmg` 这种全 ASCII 形式。只用 `${name}/${version}/${arch}/${ext}` 这四个
确定支持的宏，**不引入 `${os}`**（三个平台靠 `${ext}` 已经能区分）。

**为什么 `appId` 现在就得定**：装过的机器按它认应用身份，④ 的更新也按它认。发布后再改 = 学生机器上等于换了一个应用。

**本地直接跑 `npx electron-builder` 会怎样**：因为没有 `publish`，产出的更新清单里下载地址是空/默认值。
这**只影响更新清单**（那是给 ④ 用的、由 CI 产出），不影响安装包本身；本地出包只为验证壳能不能装起来。

### 4.2 `main.js` 钉死 `userData`（解耦 `productName`）

在 `main.js` 最早期（**任何读取 `userData` 的代码之前**）加：

```js
// 钉死 userData 目录，与 productName 解耦：打包后 productName 是中文（K12 智学），
// 若让它决定 app.getName()，userData 会变成「…/K12 智学/」（中文 + 空格），
// README 里刚交付的三条救火路径全部失效。这里显式固定为 ASCII 且与 dev 一致。
app.setPath('userData', path.join(app.getPath('appData'), 'k12-desktop'));
```

- **dev 下是无操作**：`package.json` 的 `name` 本来就是 `k12-desktop`，路径不变
- **打包后是修复**：`productName` 变成中文也不影响 `userData` → **README 一字不用改**，同时**消掉 ② spec §8-8 那条风险**
- ⚠️ **待实测**：`app.setPath('userData', …)` 是否能在 `whenReady` **之前**调用。若不能，退路是放在 `whenReady` 的**第一行**（仍是所有读取之前）。两者都写进实施计划，按实测结论二选一

### 4.3 `.github/workflows/desktop-release.yml`（新建）

**触发**：推 `desktop-v*` tag，或手动 `workflow_dispatch`。

**三个 job**（`strategy.matrix.os` = `macos-14` / `windows-latest` / `ubuntu-latest`）：
macOS 那个标签若在 Actions 里不可用，退回 `macos-latest` —— **架构对本设计不关键**（见下方「关于 runner 架构」）。

1. `actions/checkout`
2. `actions/setup-node` → **node 22**（electron-builder v27 要求 ≥ 22.12），并开 npm 缓存（`cache-dependency-path: apps/desktop/package-lock.json`）
3. `npm ci` —— **只在 `apps/desktop`**（包内不含 web/server 构建产物，CI 因此很快）
4. **版本一致性校验**：tag 去掉前缀必须等于 `apps/desktop/package.json` 的 `version`，不符直接失败（防版本漂移）
5. **`npm test`** —— 38 条全绿才继续（出包前门禁，用户裁决 §3-9）
6. `npx electron-builder --<platform>`，`--config.publish.url` 由 §4.5 推导后注入
7. **产物白名单校验**（脚本内联，见下）
8. `actions/upload-artifact`

**产物白名单校验（第 7 步，直接守住 ② spec §8-9 那个「漏资源 → 无节流紧循环」的危害）**：
找到 `apps/desktop/dist/**/app.asar`，用 `npx @electron/asar list` 列出，然后断言：

- **必须存在**：`main.js`、`preload.js`、`server-url.js`、`lib/config-file.js`、`lib/resolve-server-url.js`、
  `lib/probe-server.js`、`lib/shell-state.js`、`pages/offline.html`
- **必须不存在**：任何 `*.test.js`
- 缺一件或混入测试文件 → **job 失败**

**关于 runner 架构**：本设计**不依赖** runner 标签与架构的对应关系 —— mac 产物用 `--x64 --arm64` 显式指定目标架构，
electron-builder 会下载对应架构的 Electron 再重打包，与 runner 自身架构无关。**硬约束只有一条：
mac 包只能在 macOS runner 上构建**（`dmg` 依赖 macOS 的 `hdiutil`）。

**权限 / 已知限制**：产物以 Actions artifact 形式留存；**公开仓库下载 artifact 需要登录 GitHub**（用户本人有账号，可接受）。
若日后想免登录取回，可加一步发布到 Release —— **本期不做**（§2-7）。

### 4.4 `tools/publish-installer.sh`（新建）

一条命令完成「拷入 + 重建 web + 打印下载地址」：

```
用法: bash tools/publish-installer.sh <安装包路径>
  1. 校验文件存在
  2. mkdir -p apps/web/public/download && cp <file> 进去
  3. (cd apps/web && npm run build)      # vite 会把 public/ 拷进 dist/
  4. 从 apps/desktop/server-url.js 读默认地址，打印 http://<addr>/download/<文件名>
```

- **为什么不放 Nest**：那会让下载落在内网层，与「只对外暴露 web 层」的架构冲突；也不想起第三个静态服务进程
- **为什么 `apps/web/public/download/`**：`vite build` 会把 `public/` 原样拷进 `dist/`，所以放进 `public/` 的安装包
  **能在 `npm run build` 之后仍然存活**（`vite build` 默认清空 `dist/`，直接往 `dist/` 里拷会在下次构建时丢失）
- **代价（用户已接受）**：发布一次安装包要**重建一次 web**（几十秒）
- **`.gitignore` 新增一条**：`apps/web/public/download/`（安装包上百 MB，绝不能入库）
- `vite preview` 按请求读文件，**重建后无需重启 web 服务**即可下载到新文件

### 4.5 地址的单一真源

`publish.url` 与交付文档里的下载地址都必须指向**学生机能到达的地址**，而这个地址在
`apps/desktop/server-url.js` 里已经写死了（②）。所以：

- CI 第 6 步：`SERVER=$(node -e "console.log(require('./apps/desktop/server-url.js').SERVER_URL)")`
  → 注入 `--config.publish.url="$SERVER/download"`
- `publish-installer.sh` 第 4 步：用同一条命令取地址

**这样地址只有一处真源**；换地址时改 `server-url.js` 一行即可，不会出现「壳连 A、更新清单指 B」的漂移。

### 4.6 版本与 tag 流程

- 版本号只改 `apps/desktop/package.json` 的 `version`（当前 `0.1.0`）
- 打 tag：`desktop-v0.1.0` → 推送后 CI 自动出三平台产物
- tag 与 `package.json` 版本不一致 → CI **失败**（§4.3 第 4 步）

### 4.7 结清 ② 遗留的 ③ 待验项

② spec §5 明确记录了「**② 阶段无法验证**」的三项，其中一项在这里结清：

| ② 遗留项 | ③ 怎么验 |
|---|---|
| **生产构建下 DevTools 打不开** | 装 mac dmg → 按 `Cmd+Opt+I` / `F12` → **不应打开**（`app.isPackaged` 为 true 时 `devTools:false`） |
| 图标在各平台显示正确 | 装完后看 Finder / 开始菜单 / 应用列表的图标 |
| Windows / Linux 上的行为 | 有对应机器时装一次；**mac 上仍验不了这三平台的运行时行为** |

## 5. 测试与验收

### 自动化（CI 里就有）

| 项 | 期望 |
|---|---|
| 版本一致性校验 | tag 与 `package.json` 不符 → job 失败 |
| `apps/desktop` 38 条测试 | 全绿 |
| 三平台产物产出 | mac **两个** dmg（x64 + arm64）+ win 一个 exe + linux 一个 AppImage |
| 产物名全 ASCII | 形如 `k12-desktop-0.1.0-arm64.dmg`（**无中文、无空格**） |
| **asar 白名单** | 必需 8 个文件都在；**任何 `*.test.js` 都不在** |
| 更新清单产出 | win 有 `latest.yml`、linux 有 `latest-linux.yml`，且其中的下载 URL 指向本机服务器地址 |

### 人工验收（真机）

| # | 操作 | 期望 |
|---|---|---|
| 1 | 把 mac dmg 拷到一台 mac（最好**另一台**，非构建机）装 | 能装上；首次打开按文档指引可过 Gatekeeper |
| 2 | 启动壳 | 能连上服务器、进登录页 |
| 3 | **按 `Cmd+Opt+I` / `F12`** | **打不开 DevTools**（`devTools:false` 生效）← ② 遗留项 |
| 4 | 读启动日志 `[shell] 加载地址:` + 确认 `userData` 路径 | 地址与预期一致；`userData` 仍是 `…/k12-desktop/`（**不是** `K12 智学`） |
| 5 | 在 `~/Library/Application Support/k12-desktop/` 放一个指向错误地址的 `config.json` → 重启 | 走覆盖文件（证明打包后救火路径仍有效） |
| 6 | 停掉服务器后启动壳 | ≤5 秒出现本地页（② 的行为在打包后仍然成立） |
| 7 | `bash tools/publish-installer.sh <包>` | 打印下载地址；浏览器打开该地址能下载 |
| 8 | Windows 机器装 exe | 能装能启动（无签名会有 SmartScreen 警告，按「仍要运行」） |
| 9 | Linux 机器跑 AppImage | `chmod +x` 后能跑 |

## 6. 非目标与已知限制（必须在文档里明说）

1. **macOS 未签名、未公证** → 首次打开会被 Gatekeeper 拦：右键→打开，或
   `xattr -dr com.apple.quarantine "/Applications/K12 智学.app"`。**这条必须写进交付文档**（否则家长会以为文件坏了）
2. **macOS 不支持自动更新**（无签名 → ShipIt 验签必失败，spec ④ 已记）→ 学生机 ④ 只覆盖 Win/Linux
3. **CI 依赖 GitHub** → 完全离线的环境出不了包；且 `gh` CLI 在本机 token 已失效，
   **控制器无法观测 CI 结果**，需要用户在浏览器看（或修 token）
4. **产物以 Actions artifact 留存**：公开仓库下载 artifact **需要登录 GitHub**；本期不发布到 Release
5. **发布安装包要重建一次 web**（几十秒）—— 4.4 的代价
6. **下载目录在 web 层的 `public/` 里**：若某次 `npm run build` 之前 `public/download/` 被清空，下载会 404（脚本会 `mkdir -p`，但手工清理要留意）
7. **`appId` 发布后不可更改** —— 改了等于换应用
8. **只出 x64 的 Win/Linux**：arm64 的 Windows/Linux 机器装不了（学生机以 x64 为主，暂不覆盖）
9. **未做静默安装/批量部署**：学校装机仍需逐台点安装包

## 7. 文档同步清单（仓库铁律，实现时必须一起改）

| 文档 | 要改什么 |
|---|---|
| `README.md` | PC App 章节补：① 三平台安装包怎么产出（tag 流程）；② **从 `http://<本机IP>:5173/download/` 下载**；③ **未签名 mac 的首次打开指引**（右键→打开 与 `xattr -dr com.apple.quarantine` 两条）；④ 本地开发仍用 `npm start`，装包只是交付形态 |
| `docs/constraints/pc-app-学习管控.md` | 补 ③ 的硬约束：`userData` 被显式钉死为 `k12-desktop`（勿删那行，删了中文 productName 会改路径）；`files` 是白名单且必须排除 `*.test.js`；`artifactName` 必须 ASCII；mac 包只能在 macOS runner 出 |
| `docs/superpowers/specs/2026-09-26-pc-app-shell-productionization-design.md` | §5「② 阶段无法验证的」表里「DevTools 真的打不开」一项 → 标注已由 ③ 结清（并指向本设计） |
| `docs/ai-core-changelog.md` | 记录本次（含「electron-builder v27 需 Node ≥22.12」「Electron 44 移除 ia32」「公开仓库 Actions 免费」「asar 白名单校验」四条实测事实） |
| `CLAUDE.md` | **不新增章节**（体量纪律：内容进 `docs/constraints/`）；若「开发命令」一节需要提一句 `desktop-v*` tag 发版，至多一行 |
| `docs/API接口与数据流设计文档.md` + `docs/api/openapi.yaml` | **无需变更**（本设计不涉及任何端点）—— 明确记录此结论，免得后来者以为漏同步 |

## 8. 风险

1. **mac 包只能在 macOS runner 上构建** —— 这条是硬约束，若日后想在本机/其它环境出 mac 包必须回到 macOS
2. **Electron 44 与 electron-builder v27 的组合未经实测** —— 已知 v27 支持 Electron 44 且会拒 ia32/armv7l，
   但**首个 CI run 之前都是纸面判断**；计划的第一个任务应先在本机跑通 `--dir`（不打包、只产出 app 目录）最小验证
3. **未签名 mac 的首次打开体验**：家长大概率会卡在 Gatekeeper 提示上 → 交付文档必须放在显眼处，
   且下载页/说明里给出一行命令
4. **地址单一真源的耦合**：`publish.url` 从 `server-url.js` 推导 —— 换地址时只改一处是对的，
   但**已经发出去的旧更新清单里仍是旧地址**（④ 接手时要意识到这点）
5. **`app.setPath('userData')` 的调用时机**（§4.2 的 ⚠️）—— 若 `whenReady` 之前调用无效，
   退路是 `whenReady` 第一行；两种写法都要在计划里给出，并按实测二选一
6. **CI 产物未做版本归档**：artifact 有过期时间，且被后续构建覆盖不冲突（按名字区分），
   但**没有长期留存策略**（§2-8 有意不做）
7. **`gh` token 失效** → 控制器看不到 CI 日志，出问题时可能要多轮「用户贴日志」；建议顺手修 token

## 9. 交接给 ④（自动更新）

③ 为 ④ 准备好的东西：

- **更新源已就位**：安装包 + `latest.yml` / `latest-linux.yml` 都放在 `<server-url>/download`，
  更新的下载地址与 ② 的壳地址**同源同基址**，不需要为更新另起服务
- **mac 不接更新**（无签名 → ShipIt 必失败）→ ④ 只需覆盖 Win/Linux
- ④ 仍需自己裁决的：`electron-updater` 集成方式、**与学习锁定的时机冲突**（更新安装要退出 app，而锁定中禁止退出）、
  失败回滚、以及「更新清单里的地址在服务器地址变更后如何刷新」（见 §8-4）
