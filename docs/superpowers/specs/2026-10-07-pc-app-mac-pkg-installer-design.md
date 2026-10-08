# PC App mac 分发改 pkg 安装器 —— 设计 spec

- 日期：2026-10-07
- 状态：已与用户确认方案（方案 A，免费路线，不买 Apple Developer 签名）
- 上游 spec：`docs/superpowers/specs/2026-09-27-pc-app-packaging-design.md`（③ 打包与分发；本文修订其 mac 产物形态）

## 1. 背景与事故（2026-10-07 实测）

第二台 MacBook 安装 `K12 智学.app`（未跑 README 的 `xattr -dr com.apple.quarantine`）后：
App **能启动**，但连 `http://192.168.1.5:5173` 全部失败、永远停在 offline.html「暂时连不上学习服务器」；
**同一台机器的浏览器却正常打开同一 URL**。

排查证据链：

- 服务器侧正常：`:5173` 监听 `*`、macOS 防火墙关闭、IP 未漂移、包内 `server-url.js` 与 `main.js` 的
  `no-proxy-server` 都正确（从 asar 解包验证）。
- 终端日志：`[shell] 加载地址: http://192.168.1.5:5173`（地址正确，排除 config.json 覆盖）+
  `sandbox_extension_issue_file failed ... (Operation not permitted)`。
- 根因：**quarantine 隔离属性没有拦启动，但让包内 Chromium 的网络请求拿不到沙箱许可** → 局域网全断。
  浏览器没有 quarantine 属性，故不受影响。
- 清隔离后立刻恢复。

结论：dmg 拖拽分发下，quarantine 必然存在；而清隔离只能靠终端命令 —— **家长做不到**。必须让
「安装」这个动作本身不产生 quarantine。

## 2. 实测依据（2026-10-07，本机 `pkgbuild` + `installer` 实验）

- 用 `pkgbuild` 造测试包并给包本体打上 `com.apple.quarantine`（模拟浏览器下载），
  `installer -target CurrentUserHomeDirectory` 安装后，**装出来的文件没有任何 xattr**
  —— 即 **Installer.app 不向安装产物传播 quarantine**（无 postinstall 脚本的对照组同样干净，排除了
  脚本清掉的歧义）。
- `pkgbuild` 支持 `--scripts`（postinstall），可作为未来的保险机制（本方案暂不使用，见 §4 风险与退路）。
- 实验坑（复现时注意）：`-target CurrentUserHomeDirectory` 会把 `--install-location` 的**绝对路径**
  再拼到用户 home 下（实测文件落到了 `/Users/<user>/Users/lichao/...`）；CLI `installer` 不触发
  Gatekeeper 的 GUI 评估，**双击 pkg 的拦截行为仍需真机人工验证**（§8）。

## 3. 目标与非目标

**目标**：mac 安装全程零终端；安装完成的 .app 不带 quarantine；本次事故从机制上不再发生。

**非目标**：
- 不买 Apple Developer Program，不做签名/公证（用户裁决 2026-10-07）。
- mac 自动更新仍不可用（④ 的既有裁决不变，只覆盖 Win/Linux）。
- 不清理下载目录里的历史 dmg（沿用「发布脚本从不删除」原则，页面标「早期版本」）。
- Windows（NSIS + SmartScreen）/ Linux（AppImage）流程不动。

## 4. 设计

### 4.1 打包产物（`apps/desktop/electron-builder.yml`）

- `mac.target`：`dmg` → `pkg`（双架构 `x64 + arm64` 不变）。
- 产物名沿用 `artifactName: k12-desktop-${version}-${arch}.${ext}` → `k12-desktop-<ver>-{arm64,x64}.pkg`
  （`${ext}` 自动跟随，仍是全 ASCII）。
- `identity: null`、`asar`、`files` 白名单、`directories` 全部不动。
- `--check` 模式（`--dir`，只出 .app）不受影响。
- `latest-mac.yml` / `*.blockmap`：dmg 的 blockmap 不再产出；latest*.yml 是否仍生成以实测为准
  （mac 更新本就不可用，不构成承诺面；CI 上传路径按实测结果决定是否保留 `latest*.yml`）。

### 4.2 风险与退路（实施第一步先实测）

electron-builder 的 pkg target 在「`identity: null` 未签名」组合下**未实测**。实施顺序：

1. 先跑 `bash tools/app-build.sh --local`（改动后）本机实测 pkg target；
2. 若它坚持要求证书或产物损坏 → **退路**：electron-builder 保留 `--dir` 出 .app，改用 macOS 自带
   `pkgbuild --root dist/mac-<arch>/"K12 智学.app" --install-location /Applications --scripts <scripts>`
   自行封装 pkg（约 20 行 shell，postinstall 里做 `xattr -dr` 双保险）。两条路都只在 mac 执行，
   不影响 Win/Linux。

### 4.3 发布链路（三个文件）

| 文件 | 改动 |
|---|---|
| `tools/publish-installer.sh` | ① `gen_download_page` 的 case 加 `*.pkg`（`kind=installer`，平台提示沿用 `*arm64*`/`*x64*` 的文案）；② 「首次打开说明」mac 条目重写为 pkg 流程（见 §5），`xattr` 终端命令降级为「旧 dmg 安装包」的兜底说明 |
| `tools/app-build.sh` | `list_dist` 的 glob 加 `*.pkg`；`--help`、头注、`mode_local` 日志、`--publish` 示例中的 dmg 文案全部换 pkg；「本机限制」中 hdiutil 理由更新（pkg 走 productbuild，macOS 自带，本机照样能出）。**bash 3.2 规则照旧**（`$VAR` 紧跟中文标点必须写 `${VAR}`） |
| `.github/workflows/desktop-release.yml` | 上传产物 path 的 `apps/desktop/dist/*.dmg` → `*.pkg`（`if-no-files-found: error` 保留，保证 mac job 不静默变空包） |

### 4.4 文档改动（按文档纪律点名要删的旧表述）

- `README.md`：
  - §「macOS 首次打开：会被 Gatekeeper 拦」整节重写为 pkg 安装流程（`仍要打开` GUI + 输密码）；
    **删除**「推荐：去掉隔离属性 `xattr -dr ...`」作为首选项的表述，降级为「旧 dmg 安装包的兜底」。
  - `:92` 示例 URL `k12-desktop-0.1.0-arm64.dmg` → `.pkg`；`:124` `--publish` 示例同步。
- `docs/constraints/pc-app-学习管控.md`：`:112` 附近的 Gatekeeper 说明同步为 pkg 口径。
- `docs/ai-core-changelog.md`：补一段本次事故与改造记录（日期日志进 changelog，不进 CLAUDE.md）。
- `apps/desktop/gitignore.guard.test.js`：`MUST_BE_IGNORED` 样例加一条 `.pkg`（dmg 样例保留 ——
  下载目录里历史 dmg 现实存在）。
- 旧 spec `2026-09-27-pc-app-packaging-design.md`：在 mac 产物相关小节顶部加「已被 2026-10-07 spec 修订」注记
  （按「旧 spec 标注、不逐行改」的文档风格）。

### 4.5 新增「仍要打开」口径（下载页与 README 共用文案）

> 1. 下载 `.pkg`，双击打开；
> 2. 若提示「无法验证开发者 / 不能打开」，到「系统设置 → 隐私与安全性」，点「仍要打开」；
> 3. 再次双击，按安装器「继续 → 安装」，输入开机密码；
> 4. 完成后从启动台或「应用程序」打开「K12 智学」。
>
> 全程不需要终端。旧版 dmg 安装包（早期版本）仍需终端命令清隔离，见下方折叠说明。

## 5. 家长体验（改后）

下载页 → 下载 `.pkg` → 双击 →（首次）Gatekeeper 拦截 → 系统设置点「仍要打开」→ 安装器 + 开机密码 →
完成打开。零终端；pkg 装出的 .app 无 quarantine，「能启动但连不上服务器」的事故不再发生。

## 6. 测试与验收

**自动**：
- `apps/desktop` 全量测试（`npm test`）+ `npm run verify:asar`；
- `tools-shell.guard.test.js`（bash 3.2 规则）、`gitignore.guard.test.js`（含新 `.pkg` 样例）；
- `bash tools/app-build.sh --check`；`--local` 实测出双架构 pkg + asar 自检 + `list_dist` 正确列出。

**人工冒烟（需第二台 mac；Gatekeeper 的 GUI 行为无法自动化）**：
1. 从下载页下载 pkg（浏览器会打 quarantine）→ 双击 → 出现 Gatekeeper 拦截对话框；
2. 走「系统设置 → 隐私与安全性 → 仍要打开」→ 再双击 → 安装器可完成、输密码后装进 /Applications；
3. 打开 App → 能加载 `http://192.168.1.5:5173` 并登录（本次事故场景）；
4. `xattr -l "/Applications/K12 智学.app"` 确认无 quarantine；
5. 已装旧版本的机器升级安装：不残留两份、`config.json` 与 `shell-state.json` 存续。

## 7. 影响面核对清单

- `apps/web`、`apps/server`：零改动。
- `apps/desktop/main.js` / `server-url.js` / asar 内容：零改动（本次只改「怎么装」，不改「装什么」）。
- 下载页：新增 `.pkg` 分区渲染 + mac 说明重写；历史 dmg 自动归入「早期版本」。
