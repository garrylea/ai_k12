# PC App 打包与三平台分发（③）— 设计

> **架构锚点**：`apps/desktop/`（Electron 壳，② 已交付）、`tools/services.sh`（Web 层托管）、
> `docs/superpowers/specs/2026-09-26-pc-app-shell-productionization-design.md`（②，本设计的前置）、
> `apps/desktop/server-url.js`（**服务器地址的唯一真源**，本设计复用）。
>
> **2026-09-27 三次修订（动手前定案）**：实施计划（`docs/superpowers/plans/2026-09-27-pc-app-packaging.md`）
> 提出 4 条偏离，**用户已确认全部采纳**，已回填本文件：**D1** asar 校验从「workflow 内联 bash」
> 改为 `apps/desktop/scripts/verify-asar.js`（§2-10 / §4.3 第 7 步）；**D2** `publish-installer.sh`
> 加 `--no-build`（§4.4）；**D3** `mac.identity: null` 写进 yml，与 CI 的 env 互为保险（§4.1 / §4.3）；
> **D4** 补 3 个测试（2 个形态护栏 + 1 个单测，§2-10）。

> **2026-09-27 复核修订**：本文件经一轮逐条实测复核。新增 **§4.0（阻断项）**；修订 §4.2 / §4.3 / §4.4 /
> §5 / §6-1 与 §9，并给 §7 加了「**要删的旧表述**」一栏。原设计的主体（三层地址来源、白名单、
> 三平台 matrix、asar 断言）**未改**。
>
> **2026-09-27 二次更正（同日、动手前）**：§1 原写「electron-builder 当前主线是 v27」**是错的** ——
> npm 上**没有稳定 v27**（`dist-tags` 实测 `{ latest: '26.15.3', next: '27.0.0-alpha.9', v26: '26.17.0' }`）。
> 已把版本前提改为**稳定线 v26**，连带更正 §2-2 / §4.3 第 2 步 / §7 / §8-2（见各处标了「二次更正」的地方）。

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
| **不该进包的** | 5 个 `*.test.js`（默认会被打进 app 目录，必须显式排除）。**测试恰好 38 条**：`server-url` 2 / `config-file` 13 / `resolve-server-url` 7 / `probe-server` 7 / `shell-state` 9（**注：③ 完成后变为 8 个文件 / 52 条** —— 本行是 2026-09-27 的日期快照，两组计数并存，见 §5） |
| 图标 | `build/icon.png` = **1024×1024 RGBA** ✓（≥256，mac / win / linux 三平台都能由它生成图标，**不需要额外准备 `.ico` / `.icns`**） |
| Electron 版本 | `v44.4.5` |
| electron-builder | **未安装**。**⚠️ 2026-09-27 二次更正**：npm 上**没有稳定 v27** —— 实测 `npm view electron-builder dist-tags` = `{ latest: '26.15.3', next: '27.0.0-alpha.9', v26: '26.17.0' }`；`npm view electron-builder@27` **404**。即 **v27 只有 alpha**，**稳定线是 v26**（`latest` 指向 26.15.3；engines `{ node: '>=14.0.0' }`）。本设计改用 **`^26.15.3`**，可复现性由 `npm ci` + `package-lock.json` 保证 |
| **Electron 44 的连带事实** | **已移除 Windows ia32 构建**（这条是 Electron 侧的事实）。原写「v27 对 ia32 / armv7l 配 `electronVersion >= 44` 会**快速失败**」——**那是 v27 alpha 的行为**（报错文案 `Use electronVersion <= 43.x to keep building for ${archName} …`）。**我们装的稳定 26.x 上不保证有这道闸门**，但**无影响**：本设计只出 x64，根本走不到 ia32/armv7l 分支。**真正的验证靠 §8-2 的本机冒烟，不靠这两行纸面结论** |
| 本机 | macOS **arm64**（Apple M1），node `v25.2.1` |
| 仓库可见性 | **公开**（匿名 API 200）→ **GitHub Actions 分钟数免费无限**（含 macOS runner） |
| 仓库体量 | 1132 个已跟踪文件 / `.git` 54MB / 最大文件 1.2MB → CI 检出无压力，**不需要 LFS** |
| `apps/desktop/dist/` | **已被根 `.gitignore` 的 `dist/` 忽略** ✓（electron-builder 默认输出目录） |
| `apps/web/public/download/` | **当前未被忽略**（根 `.gitignore` 无 `*.dmg` / `*.exe` 规则）→ 需按 §4.4 新增一条 ✓ |
| **⚠️ 根 `.gitignore:53` 的 `*.yml`** | **会命中本设计新增的两个 YAML**（`apps/desktop/electron-builder.yml` + `.github/workflows/desktop-release.yml`）→ **必须按 §4.0 反选**，否则两个文件静默不入库、**CI 永不运行**。原有注释「仓库无已跟踪 `*.yml`，全局忽略安全」已失效（实测 `git ls-files '*.yml'` = 0 条） |
| 现有 CI | **无**（无 `.github/`） |
| 版本 / tag | `apps/desktop/package.json` = `0.1.0`；**无任何 tag**；**无 `productName`** |
| `vite build` 行为 | 会把 `apps/web/public/` 拷进 `apps/web/dist/`，且默认清空 `dist/`（`vite.config.ts` 未改 `publicDir` / `copyPublicDir`，`build.assetsDir: 'static'` 不影响）→ **§4.4 的机制成立** ✓ |
| **macOS Gatekeeper** | **Sequoia (15) 起 Apple 移除了「右键→打开」这条捷径** → 未签名应用现在只有「系统设置 → 隐私与安全性 → 仍要打开」或 `xattr -dr com.apple.quarantine`（见 §6-1） |
| `gh` CLI | **token 已失效**（`Failed to log in to github.com account garrylea`）—— 控制器无法在本机观测 CI 结果 |
| 本机交叉构建工具 | `wine` / `docker` / `podman` **均未安装** |

## 2. 范围

### 本期做

| # | 内容 | 落点 |
|---|---|---|
| 1 | electron-builder 配置（标识 / `files` 白名单 / 三平台 target / `artifactName` / `asar`） | 新增 `apps/desktop/electron-builder.yml` |
| 2 | **把 `electron-builder` 钉进 `devDependencies`（`^26.15.3` —— 稳定线；v27 只有 alpha，**不用**）**，CI 用本地 bin —— **不用 `npx` 现拉**（否则每次构建都可能换版本、不可复现） | `apps/desktop/package.json` |
| 3 | **钉死 `userData`**，与 `productName` 解耦 | `apps/desktop/main.js` |
| 4 | 三平台构建 workflow（含出包前测试门禁 + 产物白名单校验） | 新增 `.github/workflows/desktop-release.yml` |
| 5 | 发布到本机服务器（`/download/`） | 新增 `tools/publish-installer.sh` + `.gitignore` 两条 |
| 6 | 更新清单产出（为 ④ 铺路，本期不接更新逻辑） | 由 CI 注入的 `publish` 配置带来 |
| 7 | 交付文档：未签名 mac 的首次打开指引、下载路径、版本/tag 流程 | `README.md` 等 |
| 8 | 结清 ② 遗留的 ③ 待验项：**生产构建下 DevTools 打不开** | 验收，非代码 |
| 9 | **⚠️ `.gitignore` 反选两个新增 YAML**（否则整个 ③ 空转，见 §4.0） | `.gitignore` |
| 10 | **asar 校验脚本 + 3 个测试**（实现计划 D1/D4 定的，见 §4.3 第 7 步） | 新增 `apps/desktop/scripts/verify-asar.js`、`apps/desktop/scripts/verify-asar.test.js`、`apps/desktop/gitignore.guard.test.js`、`apps/desktop/user-data.guard.test.js` |

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
| 2 | macOS 签名 | **不签不公证**；首次打开由交付文档给指引（**具体指引见下方更正**） |
| 3 | mac 自动更新 | **不做** —— 自动更新只覆盖 Win/Linux |
| 4 | 更新清单 | **③ 顺手产出** `latest.yml` / `latest-linux.yml`（electron-builder 自带），**本期不接更新逻辑**，为 ④ 铺路 |
| 5 | 安装包放哪 | **本机服务器 web 层的 `/download/`**；学生/家长从局域网取，不需要学生机访问公网 |
| 6 | 应用名与路径 | **钉死 `userData` = `k12-desktop`** + 中文 `productName`（`K12 智学`）→ 应用名好看、救火路径不变 |
| 7 | mac 产物形态 | **双架构两个 dmg**（x64 + arm64），不用 universal |
| 8 | `appId` | `com.k12zhixue.desktop`（**发布后改不得**） |
| 9 | CI 里的测试门禁 | **出包前跑 `apps/desktop` 的测试**，红则不出包（判据是「全绿」，**不写死条数**——条数会随代码漂移） |

> **裁决 2 的更正（2026-09-27 实测）**：Apple 自 macOS 15 Sequoia 起**移除了「右键→打开」**这条绕过
> Gatekeeper 的捷径。裁决本身（不签不公证、指引写进交付文档）不变，但**指引内容**必须是：
> ① 主推 `xattr -dr com.apple.quarantine "/Applications/K12 智学.app"`；② GUI 备选是
> 「系统设置 → 隐私与安全性 → **仍要打开**」。**不要再写「右键→打开」**（家长会卡住，甚至看到「已损坏」）。

## 4. 设计

### 4.0 ⚠️ 阻断项：根 `.gitignore` 的 `*.yml` 会静默吃掉本设计的两个新文件

**先解决这个，再写任何配置。** 根 `.gitignore` 第 53 行是 `*.yml`（原注释：「仓库无已跟踪 `*.yml`，
全局忽略安全」）。而本设计新增的**恰好是两个 YAML**。实测：

```
$ git check-ignore -v apps/desktop/electron-builder.yml .github/workflows/desktop-release.yml
.gitignore:53:*.yml	apps/desktop/electron-builder.yml
.gitignore:53:*.yml	.github/workflows/desktop-release.yml
$ git ls-files '*.yml' | wc -l
0
```

**不修的后果**（不是「少个小优化」，是整个 ③ 空转）：

1. workflow 推不上去 → **CI 永远不运行**，§4.3 / §5 的自动化验收全部落空；
2. `electron-builder.yml` 不入库 → CI 里 electron-builder 读到**默认配置**：`appId` / `productName` /
   `files` 白名单 / `artifactName` / `asar` **全部不生效**。其中 `files` 白名单失效将直接复现
   ② spec §8-9 那条「漏 `pages/offline.html` → `loadFile` 失败 → **无节流紧循环、屏幕无 UI**」的危害；
3. `git add -A` **不会报错**，只会静静跳过 —— 这类问题在 CI 上表现为「什么都没发生」，最难查。

**修法（二选一，推荐 A）**：

```gitignore
# .gitignore —— 方案 A：反选（注意 `*.yml` 是文件级规则，反选文件即可，无需先反选目录）
!.github/workflows/*.yml
!apps/desktop/electron-builder.yml
```

- **方案 B**：把两个文件改用 `.yaml` 后缀（`*.yml` 不覆盖 `.yaml`）—— 能绕开，但与仓库其它 YAML 命名不一致，不推荐
- 无论哪种，**都要顺手改掉那句已失效的注释**「仓库无已跟踪 `*.yml`，全局忽略安全」，否则下一个人会照着它再踩一次
- 加完后**自检**：`git status --short` 必须看到这两个文件是 untracked（而不是消失）

> ⚠️ **自检时要用「不带 `-v`」的 `git check-ignore`**（2026-09-27 实测，实现 Task 1 时发现）：
> 带 `-v` 时，路径命中**反选规则**（`!` 开头）**也返回 exit 0**，只是把反选行原样打印出来
> （`文件:行:!规则\t路径`）。所以 **`-v` 的退出码不能当「是否被忽略」的判据** —— 用它会把
> 「反选已生效」误判成「仍被忽略」，护栏用例就永远变不绿（本设计的计划初稿正是这么踩的）。
> 不带 `-v` 时语义才是纯粹的：被忽略 0 / 未忽略 1 / **不在 git 仓库 128**。
> 若要同时拿到规则文本（做报错信息/探针），用 `-v` 的 stdout，但「是否被忽略」要另判：
> 看 tab 前那段规则是否以 `!` 起头（取 tab 前可避免路径名含 `:数字:!` 造成误判）。

### 4.1 `apps/desktop/electron-builder.yml`（新建）

```yaml
appId: com.k12zhixue.desktop
productName: K12 智学
asar: true                       # 显式写：下面的 asar 白名单校验以「产物是 asar」为前提
directories:
  buildResources: build          # build/icon.png（1024×1024）会被自动采用
  output: dist                   # 已被根 .gitignore 的 dist/ 忽略
# ⚠️ 白名单而非黑名单：默认会把 app 目录下所有文件打进包，包括 *.test.js。
# ⚠️ `lib/**/*.js` 会匹配 lib/*.test.js，靠最后一条否定排除 —— 否定语义一旦失效，
#    测试文件就会进包，届时由 §4.3 第 7 步的 asar 断言兜住（会红，不会静默通过）。
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
  # 显式关闭签名（§3-2：不签不公证）。比只依赖 CSC_IDENTITY_AUTO_DISCOVERY 环境变量可靠：
  # 本机跑 --mac 验包时也不会因为钥匙串里恰好有 Developer ID 就签出**不一致的产物**
  identity: null
  target: [{ target: dmg, arch: [x64, arm64] }]
linux:
  target: [{ target: AppImage, arch: [x64] }]
# ⚠️ 这里**故意不写 publish** —— 下载地址的唯一真源是 apps/desktop/server-url.js，
# 写到 yml 里会成为第二处、必然漂移。CI 每次都用 CLI 注入（写全 provider + url，见 §4.5）。
```

**为什么 `artifactName` 必须显式覆盖**：electron-builder 默认是 `${productName}-${version}-${arch}.${ext}` → 会产出
`K12 智学-0.1.0-arm64.dmg`（**中文 + 空格**）。空格在 URL 里要转义，交付文档里的复制粘贴会变脆。
改成 `k12-desktop-0.1.0-arm64.dmg` 这种全 ASCII 形式。只用 `${name}/${version}/${arch}/${ext}` 这四个
确定支持的宏，**不引入 `${os}`**（三个平台靠 `${ext}` 已经能区分）。

**为什么 `appId` 现在就得定**：装过的机器按它认应用身份，④ 的更新也按它认。发布后再改 = 学生机器上等于换了一个应用。

**关于 `lib/**/*.js` 里的测试文件**：更稳的做法是**把 4 个 `lib/*.test.js` 挪进
`apps/desktop/__tests__/`** —— 这样 `lib/**/*.js` 天然干净，**不必依赖否定规则的语义**（否定规则是否
生效、生效范围如何，是 electron-builder 的实现细节，不该成为「资源是否进包」的唯一保障）。
两种做法都可接受，但**必须由 §4.3 第 7 步的断言兜底**。

**关于 `publish` 与更新清单**：electron-builder **只在存在 `publish` 配置时才产出** `latest.yml` /
`latest-linux.yml`。本设计把 `publish` 交给 CLI 注入，所以「清单会不会产出」**取决于注入是否成功** ——
§4.5 因此要求注入时**写全 `provider` + `url`**，并且这一点要在本机先验（§8-2）。

### 4.2 `main.js` 钉死 `userData`（解耦 `productName`）

在 `main.js` 最早期（**任何读取 `userData` 的代码之前**）加：

```js
// 钉死 userData 目录，与 productName 解耦：打包后 productName 是中文（K12 智学），
// 若让它决定 app.getName()，userData 会变成「…/K12 智学/」（中文 + 空格），
// README 里刚交付的三条救火路径全部失效。这里显式固定为 ASCII 且与 dev 一致。
app.setPath('userData', path.join(app.getPath('appData'), 'k12-desktop'));
```

- **dev 下路径不变**：`package.json` 的 `name` 本来就是 `k12-desktop`，解析结果一致（调用仍会执行，只是无副作用）
- **打包后是修复**：`productName` 变成中文也不影响 `userData` → 三条救火路径（README 的平台表）**内容仍然正确**
- ⚠️ **待实测**：`app.setPath('userData', …)` 是否能在 `whenReady` **之前**调用。若不能，退路是放在 `whenReady` 的**第一行**（仍是所有读取之前）。两者都写进实施计划，按实测结论二选一。**（③ 状态：已完成出包，但从未启动过打包后的壳 —— 该点因此仍未人工确认，须在 §5 人工验收 #4 里读 `userData` 实际落点来结清。）**

> **⚠️ 但「README 一字不用改」是错的（2026-09-27 更正）**：路径**内容**不用改，但 README 里有**一句会
> 变成错误指引的话必须删掉** —— `README.md:118`：
>
> > 「⚠️ 若 ③ 给应用设了 `productName`，上表中的 `k12-desktop` 会变成那个名字 —— 届时需同步改本表」
>
> 钉死 `userData` 之后这句**是假的**。留着它的后果比不写更糟：后来者会照做，把三条救火路径改成
> `K12 智学`，**直接毁掉救火通路**（而这是「客户端连不上时唯一的自救手段」，② spec §8-3）。
> 同一条失效表述还出现在 `docs/constraints/pc-app-学习管控.md`（「`userData` 目录名取 `productName`……
> 必须同步改」）与 ② spec §8-8 —— 三处都要改成「**已钉死为 `k12-desktop`，不随 `productName` 变**」。
> 详见 §7。

### 4.3 `.github/workflows/desktop-release.yml`（新建）

**前置**：先做完 §4.0（否则这个文件根本进不了仓库）。

**触发**：推 `desktop-v*` tag，或手动 `workflow_dispatch`。

**三个 job**（`strategy.matrix.os` = `macos-14` / `windows-latest` / `ubuntu-latest`）：
macOS 那个标签若在 Actions 里不可用，退回 `macos-latest` —— **架构对本设计不关键**（见下方「关于 runner 架构」）。
标签可用性以**当天** GitHub 的 runner 列表为准（`macos-14` 属较老的镜像，投产前核一下）。

1. `actions/checkout`
2. `actions/setup-node` → **node 22**（⚠️ **不是**被 electron-builder 逼的：稳定 v26 的 engines 只要求 `node >= 14`；选 22 是为了与仓库其它工具链对齐、并给日后可能升 v27 留余量），并开 npm 缓存（`cache-dependency-path: apps/desktop/package-lock.json`）
3. `npm ci` —— **只在 `apps/desktop`**（包内不含 web / server 构建产物，CI 因此很快）
4. **版本一致性校验**：tag 去掉前缀必须等于 `apps/desktop/package.json` 的 `version`，不符直接失败（防版本漂移）
5. **`npm test`** —— **全绿**才继续（出包前门禁，用户裁决 §3-9）
6. `apps/desktop` 目录下跑 `./node_modules/.bin/electron-builder --<platform>`（**依赖 §2-2 已把 electron-builder 钉进 devDependencies**；不要用会现拉版本的裸 `npx`），
   并按 §4.5 注入 `--config.publish.provider=generic --config.publish.url="$SERVER/download"`
7. **产物白名单校验**（`apps/desktop/scripts/verify-asar.js`，见下）
8. `actions/upload-artifact`

**关于工作目录（易错点）**：第 6 步的 electron-builder **必须在 `apps/desktop` 下运行**（它按 cwd 找
`electron-builder.yml` 与 `package.json`）；而 §4.5 的取值命令按**仓库根**写。**两者不能在同一段里同时成立**。
实现时统一成：在仓库根取好 `SERVER` 变量，再 `cd apps/desktop` 执行构建（`${{ github.workspace }}` 拼绝对路径亦可）。

**产物白名单校验（第 7 步，直接守住 ② spec §8-9 那个「漏资源 → 无节流紧循环」的危害）**：
落在 **`apps/desktop/scripts/verify-asar.js`**（Node；CI 里就是 `npm run verify:asar`），
它扫 `apps/desktop/dist/**/app.asar`，用 `@electron/asar` 的 CLI 列内容，然后断言：

- **必须存在**（9 项）：`main.js`、`preload.js`、`server-url.js`、`package.json`、
  `lib/config-file.js`、`lib/resolve-server-url.js`、`lib/probe-server.js`、`lib/shell-state.js`、`pages/offline.html`
- **必须不存在**：任何 `*.test.js`
- 缺一件或混入测试文件 → **退出码 1，job 失败**

**为什么用 Node 而不是 workflow 内联 bash**（实现计划 D1，2026-09-27 定）：
① mac 的 asar 落在 `dist/mac-arm64/K12 智学.app/Contents/Resources/` —— 路径**含中文与空格**，
bash 的 `for f in $(find …)` 会在空格处断词（校验静默失效）；Node 用 `execFileSync(可执行文件, argv[])`
不经过 shell，零引号问题。② §8-2 要求**本机先验**，脚本化才能让本机与 CI 跑同一段逻辑。
③ 纯函数部分（`parseAsarList` / `checkEntries`）可单测 —— 配套 `scripts/verify-asar.test.js` 还包含
「必需项都在磁盘上存在」与「覆盖 `main.js` 里所有本地 `require`」两条防漂移断言。
`@electron/asar` 因此进 `devDependencies`（与 `electron-builder` 一起，§2-2）。

**CI 加固（低成本，建议一并加）**：

- `env: CSC_IDENTITY_AUTO_DISCOVERY: false` —— 与 yml 里的 `mac.identity: null`（§4.1）**互为保险**：
  明确告诉 electron-builder 别去找签名证书，避免 macOS runner 上的噪音或偶发失败（与 §3-2「不签不公证」一致）
- `permissions: { contents: read }` —— 最小权限
- `concurrency: { group: desktop-${{ github.ref }}, cancel-in-progress: true }` —— 同一 tag 重复推送时不做两次

**关于 runner 架构**：本设计**不依赖** runner 标签与架构的对应关系 —— mac 产物用 `--x64 --arm64` 显式指定目标架构，
electron-builder 会下载对应架构的 Electron 再重打包，与 runner 自身架构无关。**硬约束只有一条：
mac 包只能在 macOS runner 上构建**（`dmg` 依赖 macOS 的 `hdiutil`）。

**权限 / 已知限制**：产物以 Actions artifact 形式留存；**公开仓库下载 artifact 需要登录 GitHub**（用户本人有账号，可接受）。
若日后想免登录取回，可加一步发布到 Release —— **本期不做**（§2-7）。所以**取回链路是手工的**：
浏览器登录 GitHub → 下载 artifact（zip）→ 解压 → 挑出安装包 → 跑 `tools/publish-installer.sh`（§4.4）。

### 4.4 `tools/publish-installer.sh`（新建）

一条命令完成「拷入 + 重建 web + 打印下载地址」：

```
用法: bash tools/publish-installer.sh <文件1> [文件2 ...]
  1. 逐个校验文件存在
  2. mkdir -p apps/web/public/download && 把每个文件 cp 进去
  3. (cd apps/web && npm run build)      # vite 会把 public/ 拷进 dist/
  4. 从 apps/desktop/server-url.js 读默认地址，逐个打印 http://<addr>/download/<文件名>

另支持 bash tools/publish-installer.sh --no-build <文件...>   # 只拷不重建（本地验收用）
```

- **`--no-build` 是有意加的**（实现计划 D2，2026-09-27 定）：照 `tools/services.sh` 已有的
  `--no-build` / `SERVICES_NO_BUILD=1` 惯例，让「参数校验 / 多文件 / 地址打印」这些分支
  不必每次都等 60 秒的 web 重建就能验。**默认行为不变**（不加 `--no-build` 就重建）

- **为什么收多个文件**：④ 需要的不只是安装包，还有 `latest.yml` / `latest-linux.yml`（§9）。**单文件参数会让 §9
  「更新源已就位」这句话落空** —— 脚本必须能一次把安装包与更新清单一起放上去（多文件是硬要求，不是便利）
- **为什么不放 Nest**：那会让下载落在内网层，与「只对外暴露 web 层」的架构冲突；也不想起第三个静态服务进程
- **为什么 `apps/web/public/download/`**：`vite build` 会把 `public/` 原样拷进 `dist/`，所以放进 `public/` 的安装包
  **能在 `npm run build` 之后仍然存活**（`vite build` 默认清空 `dist/`，直接往 `dist/` 里拷会在下次构建时丢失）
- **代价（用户已接受）**：发布一次安装包要**重建一次 web**（几十秒）
- ⚠️ **上一条的副作用要明说**：`(cd apps/web && npm run build)` 会**重建并替换 `apps/web/dist/`**，而本机
  `:5173` 的 `vite preview`（`tools/services.sh` 起的）正在服务这个目录 → **「发布一次安装包」= 线上前端被重建一次**。
  这不是缺陷（新的 `/download/` 文件正是靠它才出现的），但它意味着：**跑这个脚本前，工作区里未提交的前端改动会被一起构建并对外生效**
- **`.gitignore` 新增两条**（都在 §4.0 那一批里一起改）：
  1. `apps/web/public/download/` —— 安装包上百 MB，绝不能入库
  2. （见 §4.0）反选两个新增 YAML
- `vite preview` 按请求读文件，**重建后无需重启 web 服务**即可下载到新文件

### 4.5 地址的单一真源

`publish.url` 与交付文档里的下载地址都必须指向**学生机能到达的地址**，而这个地址在
`apps/desktop/server-url.js` 里已经写死了（②）。所以：

```bash
# 在仓库根取地址（唯一真源）
SERVER=$(node -e "console.log(require('./apps/desktop/server-url.js').SERVER_URL)")
# 再进 apps/desktop 构建，CLI 注入要写全 provider + url
cd apps/desktop
./node_modules/.bin/electron-builder --<platform> \
  --config.publish.provider=generic \
  --config.publish.url="$SERVER/download"
```

- **`provider` 必须显式给**：electron-builder 的 `publish` 配置需要 provider 才能组装出更新清单；
  只给 `url` 属于「半个 publish 配置」，可能报错、也可能**不产出 `latest.yml`**（§8-2 要求本机先验）
- 若将来 CLI 注入这条路走不通，**退路**是把 `publish` 写回 `electron-builder.yml`（接受「地址出现第二处」的代价），
  或从环境变量注入整段配置 —— 但**不要**把 URL 硬编码进 yml 就完事（那正是漂移的来源）
- `publish-installer.sh` 第 4 步用**同一条**取值命令

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
| `apps/desktop` 测试 | **全绿**（判据是「全绿」，不写死条数；当前为 8 个文件 / 52 条） |
| 三平台产物产出 | mac **两个** dmg（x64 + arm64）+ win 一个 exe + linux 一个 AppImage |
| 产物名全 ASCII | 形如 `k12-desktop-0.1.0-arm64.dmg`（**无中文、无空格**） |
| **asar 白名单** | 必需 **9** 项都在（含 `package.json`）；**任何 `*.test.js` 都不在** |
| 更新清单产出 | win 有 `latest.yml`、linux 有 `latest-linux.yml`。⚠️ **措辞更正（2026-09-27 实测）**：清单里只有**相对文件名**，**不含绝对地址**（基址来自 publish 配置）→ 判据改为「清单存在 + `version` 与 `package.json` 一致 + 每个 `files[].url` 在 `dist/` 里都有同名文件」。④ 接手时注意基址来自 `--config.publish.url` |

### 人工验收（真机）

| # | 操作 | 期望 |
|---|---|---|
| 1 | 把 mac dmg 拷到一台 mac（最好**另一台**，非构建机）装 | 能装上；按 §6-1 的**新指引**（`xattr -dr` 或「仍要打开」）能过 Gatekeeper |
| 2 | 启动壳 | 能连上服务器、进登录页 |
| 3 | **按 `Cmd+Opt+I` / `F12`** | **打不开 DevTools**（`devTools:false` 生效）← ② 遗留项 |
| 4 | 读启动日志 `[shell] 加载地址:` + 确认 `userData` 路径 | 地址与预期一致；`userData` 仍是 `…/k12-desktop/`（**不是** `K12 智学`） |
| 5 | 在 `~/Library/Application Support/k12-desktop/` 放一个指向错误地址的 `config.json` → 重启 | 走覆盖文件（证明打包后救火路径仍有效） |
| 6 | 停掉服务器后启动壳 | ≤5 秒出现本地页（② 的行为在打包后仍然成立） |
| 7 | 从 CI artifact 解压出安装包与 `latest*.yml` → `bash tools/publish-installer.sh <安装包> <latest*.yml>` | 打印各文件的下载地址；浏览器逐个打开都能下载到 |
| 8 | Windows 机器装 exe | 能装能启动（无签名会有 SmartScreen 警告，按「仍要运行」） |
| 9 | Linux 机器跑 AppImage | `chmod +x` 后能跑 |
| 10 | `git status --short` 看两个新增 YAML | **是 untracked / 已跟踪**（**不是消失**）← §4.0 的自检 |

## 6. 非目标与已知限制（必须在文档里明说）

1. **macOS 未签名、未公证** → 首次打开会被 Gatekeeper 拦。**「右键→打开」自 macOS 15 Sequoia 起已被 Apple 移除，
   不要再写**。正确指引（两条都要给，主推第一条）：
   - `xattr -dr com.apple.quarantine "/Applications/K12 智学.app"`
   - 或 GUI：**系统设置 → 隐私与安全性 → 仍要打开**
   若跳过这两条，家长会看到「已损坏，无法打开」并以为下载坏了。**这条必须写进交付文档**
2. **macOS 不支持自动更新**（无签名 → ShipIt 验签必失败，spec ④ 已记）→ 学生机 ④ 只覆盖 Win/Linux
3. **CI 依赖 GitHub** → 完全离线的环境出不了包；且 `gh` CLI 在本机 token 已失效，
   **控制器无法观测 CI 结果**，需要用户在浏览器看（或修 token）
4. **产物以 Actions artifact 留存**：公开仓库下载 artifact **需要登录 GitHub**；本期不发布到 Release。
   因此**取回是手工链路**（浏览器下载 zip → 解压 → 跑 `publish-installer.sh`），没做成自动化（§4.3 末段）
5. **发布安装包要重建一次 web**（几十秒），并会**替换本机正在服务的 `apps/web/dist/`** —— §4.4 的代价与副作用
6. **下载目录在 web 层的 `public/` 里**：若某次 `npm run build` 之前 `public/download/` 被清空，下载会 404（脚本会 `mkdir -p`，但手工清理要留意）
7. **`appId` 发布后不可更改** —— 改了等于换应用
8. **只出 x64 的 Win/Linux**：arm64 的 Windows/Linux 机器装不了（学生机以 x64 为主，暂不覆盖）
9. **未做静默安装/批量部署**：学校装机仍需逐台点安装包
10. **Windows 采用 NSIS 的默认行为**（有意，不额外配置）：**oneClick 一键安装**（没有向导、不能选安装目录）、
    装到用户目录 `%LOCALAPPDATA%\Programs\`、**装完自动启动应用**。对家长其实更友好，但这是个**有意的决定**，
    别当成漏配；若日后学校要求「可选目录 / 装到 Program Files」，改 `nsis` 段即可
11. **`.gitignore` 的 `*.yml` 是个通用陷阱**：以后任何新增 YAML（哪怕不属于本设计）都会被静默忽略。
    §4.0 的反选是**针对这两个具体文件**的，不是全局放宽

## 7. 文档同步清单（仓库铁律，实现时必须一起改）

> ⚠️ **每一条都要同时问「补什么」和「删什么」**：本设计把 ③ 之前的几条**已生效表述变成了假的**
> （`productName` 会改 `userData` 路径、「右键→打开」可用、「dev 模式、不出安装包」）。**只加不删 = 留着错误指引**，
> 后来者会照着旧句子把新设计改回去。下表「要删 / 要改的旧表述」一栏**必须逐条处理**。

| 文档 | 补什么 | **要删 / 要改的旧表述** |
|---|---|---|
| `.gitignore` | 反选 `!.github/workflows/*.yml`、`!apps/desktop/electron-builder.yml`；新增 `apps/web/public/download/` | 注释「仓库无已跟踪 `*.yml`，全局忽略安全」**已失效，必须改**（§4.0） |
| `README.md` | PC App 章节补：① 三平台安装包怎么产出（tag 流程）；② **从 `http://<本机IP>:5173/download/` 下载**；③ **未签名 mac 的首次打开指引**（`xattr -dr` 为主、**「仍要打开」**为备选）；④ 本地开发仍用 `npm start`，装包只是交付形态 | **`README.md:118`「若 ③ 给应用设了 `productName`…需同步改本表」整句删掉**（钉死 userData 后为假，照做会毁掉救火通路）；`:24` 与 `:206` 的「**dev 模式** / 交付物是 dev 壳」改为「已出安装包，交付形态=安装包」 |
| `docs/constraints/pc-app-学习管控.md` | 补 ③ 的硬约束：`userData` 被显式钉死为 `k12-desktop`（勿删那行，删了中文 productName 会改路径）；`files` 是白名单且必须排除 `*.test.js`；`artifactName` 必须 ASCII；mac 包只能在 macOS runner 出；**新增 YAML 要检查 `.gitignore` 的 `*.yml`**；未签名 mac 的首开指引；**三处护栏用例（`gitignore.guard` / `user-data.guard` / `scripts/verify-asar.test`）的存在与意图** | 「`userData` 目录名取 `productName`（若设）否则 `name`…… README 里的三条平台路径必须同步改」→ 改为「**已钉死，不随 `productName` 变**」；首段「（Electron 壳，**dev 模式**；本期不出安装包）」→ 过期，改掉 |
| `docs/superpowers/specs/2026-09-26-pc-app-shell-productionization-design.md` | §5「② 阶段无法验证的」表里「DevTools 真的打不开」→ 标注已由 ③ 结清（指向本设计） | §8-8「`userData` 目录名会被 ③ 的 `productName` 改掉……**README 里那三条平台路径必须同步改**」→ 加**更正注记**：已由 ③ 显式钉死 `userData` 解决，**不要再按原句去改 README** |
| `apps/desktop/package.json` | 加 `electron-builder` 到 `devDependencies`（`^26.15.3`） | `description` 里「（Electron 壳，dev 模式；本期不出安装包）」→ 过期 |
| `apps/desktop/server-url.js` | —— | 文件头注释「**③ 的 CI 用环境变量重写本文件**，可产出指向不同服务器的包」与 §4.5 选的机制（**从本文件推导地址、不重写**）不是一回事 → 改成与实际一致（或删掉该句） |
| `docs/ai-core-changelog.md` | 记录本次（含「**npm 上 electron-builder 无稳定 v27、只有 `27.0.0-alpha.9`；稳定线 v26 的 engines 是 `node >= 14`**」「Electron 44 移除 Windows ia32」「公开仓库 Actions 免费」「asar 白名单校验」「**根 `.gitignore` 的 `*.yml` 会吃掉新增 YAML**」「**macOS 15 移除右键→打开**」「**AppImage 在 macOS 上要 docker、故本机只能验 `--mac`**」七条实测事实） | —— |
| `CLAUDE.md` | **不新增章节**（体量纪律：内容进 `docs/constraints/`）；若「开发命令」一节需要提一句 `desktop-v*` tag 发版，至多一行 | —— |
| `docs/API接口与数据流设计文档.md` + `docs/api/openapi.yaml` | **无需变更**（本设计不涉及任何端点）—— 明确记录此结论，免得后来者以为漏同步 | —— |

## 8. 风险

1. **mac 包只能在 macOS runner 上构建** —— 这条是硬约束，若日后想在本机/其它环境出 mac 包必须回到 macOS
2. **Electron 44 与 electron-builder 26.x 的组合：出包能力已在本机实测通过，仍未验的是打包后的运行时行为**
   （原「v27 支持 Electron 44 且会拒 ia32/armv7l」这个前提，随 §1 的二次更正一起作废）。本机
   （macOS arm64）实测：electron-builder 解到 **26.15.3**、配 Electron **44.4.5**，`--dir` ≈ **10 s**，
   `--mac` 双架构 dmg 全量 ≈ **58 s**，产出 `k12-desktop-0.1.0-x64.dmg`（**125 MB**）/
   `…-arm64.dmg`（**122 MB**）+ `latest-mac.yml`，**文件名全 ASCII**（细节见 changelog）——
   即「**能不能出包**」已不是纸面判断。**仍未验的是打包后的运行时行为**（DevTools 是否真打不开、
   `userData` 实际落点、连不上时的本地页）—— 因为**从未启动过打包后的壳**，这几项留给 §5 的人工验收
   （#3 / #4 / #6）。**CI 侧仍完全未跑**，故「本机先验」的两步纪律照旧：
   ① 本机跑通 `--dir`（不打包、只产出 app 目录）最小验证；② **紧接着真出一次包**，确认更新清单真的产出、URL 正确
   —— 只跑 `--dir` 验不到清单这一步（§4.5）。
   ⚠️ **② 在本机只能用 `--mac`，不能用 `--linux`**：AppImage 在 macOS 上要 docker，而 §1 已记录本机
   `wine` / `docker` / `podman` **均未安装**。本机验 `--mac` + `latest-mac.yml` 即可 —— mac 清单虽然 ④ 不会用，
   但它与 win/linux 走的是**同一段 publish 组装逻辑**，足以证明「CLI 注入能产出清单」这件事成立
3. **未签名 mac 的首次打开体验**：家长大概率会卡在 Gatekeeper 提示上 → 交付文档必须放在显眼处，
   且下载页/说明里给出一行命令（**注意用 §6-1 的新指引，不要写已被移除的「右键→打开」**）
4. **地址单一真源的耦合**：`publish.url` 从 `server-url.js` 推导 —— 换地址时只改一处是对的，
   但**已经发出去的旧更新清单里仍是旧地址**（④ 接手时要意识到这点）
5. **`app.setPath('userData')` 的调用时机**（§4.2 的 ⚠️）—— 若 `whenReady` 之前调用无效，
   退路是 `whenReady` 第一行；两种写法都要在计划里给出，并按实测二选一
6. **CI 产物未做版本归档**：artifact 有过期时间，且被后续构建覆盖不冲突（按名字区分），
   但**没有长期留存策略**（§2-8 有意不做）
7. **`gh` token 失效** → 控制器看不到 CI 日志，出问题时可能要多轮「用户贴日志」；建议顺手修 token
8. **⭐ `.gitignore` 的 `*.yml`（§4.0）是本设计最危险的坑**：失效模式是「静默」——
   `git add` 不报错、CI 不报错、本地看不出来，只有学生装出来的包**缺资源和标识**时才暴露。
   §4.0 的反选 + §5 的 `git status` 自检（验收 #10）是配套的两道保险
9. **Gatekeeper 指引会随 macOS 版本继续变**（Apple 每次大版本都在收紧）→ 交付文档里给**命令行**（`xattr -dr`）比给 GUI 路径更耐放；
   GUI 路径要标注「本指引按 macOS 15+ 写」
10. **`--config.publish.*` 的 CLI 注入已实测可用** —— 注入后产出的 `latest-mac.yml` 里 `files[].url`
    正是期望的相对文件名（§8-2 的 ② 本机验过），故「electron-builder 会拒绝半个 publish 配置」的担心不成立。
    但**清单里不含绝对地址**（基址来自 publish 配置）→ 换地址时**必须同时刷新 publish 配置**，
    否则旧清单里的相对地址会被解析到旧基址（§8-4 已就同一件事警告）

## 9. 交接给 ④（自动更新）

③ 为 ④ 准备好的东西：

- **更新源已就位**：安装包 + `latest.yml` / `latest-linux.yml` 都放在 `<server-url>/download`，
  更新的下载地址与 ② 的壳地址**同源同基址**，不需要为更新另起服务
  —— ⚠️ 前提是 §4.4 的脚本**支持一次传多个文件**（安装包 + 清单），单文件版本会让这句话落空
  （⚠️ 清单里不含绝对地址，基址由 publish 配置提供 —— ④ 换地址时要同时刷 publish 配置，见 §8-4）
- **mac 不接更新**（无签名 → ShipIt 必失败）→ ④ 只需覆盖 Win/Linux
- ④ 仍需自己裁决的：`electron-updater` 集成方式、**与学习锁定的时机冲突**（更新安装要退出 app，而锁定中禁止退出）、
  失败回滚、以及「更新清单里的地址在服务器地址变更后如何刷新」（见 §8-4）
