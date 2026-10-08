# PC App mac 分发改 pkg 安装器 — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use subagent-driven-development (recommended) or executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** mac 分发产物从 dmg 改为 pkg 安装器，让「安装」本身不产生 quarantine，家长全程零终端。

**Architecture:** electron-builder 的 mac target 从 `dmg` 换成 `pkg`（产物 .app 内容零改动）；发布链路三文件（publish-installer.sh / app-build.sh / CI workflow）同步识别 `.pkg`；文档改为「仍要打开」GUI 流程。spec：`docs/superpowers/specs/2026-10-07-pc-app-mac-pkg-installer-design.md`。

**Tech Stack:** electron-builder 26.15.3、electron-builder.yml、bash 3.2（macOS 自带）、GitHub Actions。

## Global Constraints

- 产物名必须全 ASCII：`k12-desktop-${version}-${arch}.${ext}`（`${ext}` 随 target 自动变 `.pkg`）。
- `mac.identity: null` + CI 的 `CSC_IDENTITY_AUTO_DISCOVERY=false` 不动（不签不公证）。
- `apps/desktop/main.js`、`server-url.js`、asar 白名单：**零改动**。
- `tools/*.sh` 里 `$VAR` 紧跟中文标点必须写 `${VAR}`（bash 3.2 unbound variable，有 `tools-shell.guard.test.js` 钉着）。
- 发布脚本**从不删除**已发布文件（历史 dmg 保留，下载页标「早期版本」）。
- 不做签名；mac 自动更新仍不可用（非目标）。
- Windows（NSIS）/ Linux（AppImage）流程不动。

---

### Task 1: electron-builder.yml 换 pkg target + 本机实测（决策门）

**Files:**
- Modify: `apps/desktop/electron-builder.yml:26-28`（注释里的 dmg 示例）、`:34-38`（mac target 块）

**Interfaces:**
- Produces: `apps/desktop/dist/k12-desktop-<version>-{arm64,x64}.pkg` 两个产物；后续 Task 2-4 都以 `.pkg` 为准。

- [ ] **Step 1: 改 mac target 与注释**

`electron-builder.yml` 第 26-28 行注释改为：

```yaml
# 产物名必须 ASCII：默认模板是 ${productName}-${version}-${arch}.${ext}，会产出
# 「K12 智学-0.1.0-arm64.pkg」（中文 + 空格）→ 污染 /download/ 的 URL、复制粘贴变脆。
# 只用 ${name}/${version}/${arch}/${ext} 这四个确定支持的宏；不引入 ${os}（靠 ${ext} 已能区分平台）。
```

第 34-38 行 mac 块改为：

```yaml
mac:
  # 显式关闭签名（spec §3-2：不签不公证）。比只依赖 CSC_IDENTITY_AUTO_DISCOVERY 环境变量可靠：
  # 本机跑 --mac 时也不会因为钥匙串里恰好有 Developer ID 就签出**不一致的产物**。
  identity: null
  # pkg 替代 dmg（2026-10-07 spec）：Installer.app 不向产物传播 quarantine（实测见 spec §2），
  # 「装完连不上服务器」的事故从机制上消失；dmg 拖拽 + 手跑 xattr 的家长路径废止。
  target: [{ target: pkg, arch: [x64, arm64] }]
```

- [ ] **Step 2: 跑 --check（测试 + 最小出包 + asar 自检）**

Run: `bash tools/app-build.sh --check`
Expected: 测试全绿 + asar 自检通过（`--dir` 不受 target 影响，若这里红说明改坏了别的）。

- [ ] **Step 3: 跑 --local 实测 pkg target（决策门）**

Run: `bash tools/app-build.sh --local`
Expected: `apps/desktop/dist/` 下产出 `k12-desktop-<version>-arm64.pkg` 与 `k12-desktop-<version>-x64.pkg`，无报错。

```bash
ls -la apps/desktop/dist/*.pkg
```

- [ ] **Step 4: 验证 latest 清单与 pkg 内容**

```bash
ls apps/desktop/dist/latest*.yml 2>/dev/null || echo "（无 latest 清单）"
npx --yes @electron/asar extract-file "apps/desktop/dist/mac-arm64/K12 智学.app/Contents/Resources/app.asar" main.js >/dev/null 2>&1 && grep -c "no-proxy-server" main.js && rm -f main.js
```

Expected: `main.js` 含 `no-proxy-server`（记录 latest*.yml 是否仍产出 —— CI 上传路径与 README 发布示例按实测结果写，见 Task 4/5）。

- [ ] **Step 5: 决策门判定**

- pkg 双架构都产出且内容正确 → 继续 Task 2（不做 Task 1b）。
- electron-builder pkg target 在未签名组合下报错/产物损坏 → **执行 Task 1b（退路），跳过本任务的产物形态，其余 Task 不变**。

- [ ] **Step 6: Commit**

```bash
git add apps/desktop/electron-builder.yml
git commit -m "feat(desktop): mac 打包 target 从 dmg 换成 pkg —— 安装动作本身不产生 quarantine"
```

---

### Task 1b（仅当 Task 1 Step 5 判定失败时执行）: pkgbuild 退路

**Files:**
- Create: `apps/desktop/scripts/pkg/postinstall`
- Modify: `apps/desktop/tools/app-build.sh` 的 `mode_local`（出包段）

- [ ] **Step 1: 建 postinstall 脚本**

`apps/desktop/scripts/pkg/postinstall`（可执行）：

```bash
#!/bin/bash
# 双保险：正常情况下 Installer.app 不向产物传播 quarantine（2026-10-07 实测），
# 这里清一次以防 macOS 未来行为变化。失败不阻塞安装。
/usr/bin/xattr -dr com.apple.quarantine "$2/K12 智学.app" 2>/dev/null || true
exit 0
```

- [ ] **Step 2: mode_local 出包段改为 --dir + pkgbuild**

```bash
  log "出 mac .app（--dir，不打 dmg）…"
  run_builder "${args[@]/--mac/--mac --dir}"
  verify_asar
  local arch_dir arch out
  for arch_dir in "$DESKTOP_DIR/dist/mac-arm64" "$DESKTOP_DIR/dist/mac"; do
    [ -d "$arch_dir" ] || die "缺 $arch_dir —— electron-builder --dir 未产出预期目录"
    arch=arm64; case "$arch_dir" in */mac) arch=x64 ;; esac
    out="$DESKTOP_DIR/dist/k12-desktop-$(pkg_version)-${arch}.pkg"
    log "封装 $out …"
    pkgbuild --identifier com.k12zhixue.desktop \
             --root "$arch_dir" \
             --scripts "$DESKTOP_DIR/scripts/pkg" \
             --install-location /Applications \
             "$out"
  done
```

注意：`--root` 指向**包含** `K12 智学.app` 的目录（装完落在 `/Applications/K12 智学.app`）；x64 目录名是 `dist/mac`。

- [ ] **Step 3: 验证 + Commit**

```bash
bash tools/app-build.sh --local && ls apps/desktop/dist/*.pkg
chmod +x apps/desktop/scripts/pkg/postinstall
git add apps/desktop/scripts/pkg/postinstall apps/desktop/tools/app-build.sh apps/desktop/electron-builder.yml
git commit -m "feat(desktop): electron-builder pkg target 不可用时改用 pkgbuild 封装（退路落地）"
```

---

### Task 2: tools/app-build.sh 全文 dmg 口径换 pkg

**Files:**
- Modify: `tools/app-build.sh:11`（头注 hdiutil 理由）、`:77`（list_dist glob）、`:93-94`（--local 说明）、`:102`/`:109-110`/`:115`（--help 文案）、`:113`（--publish 示例）、`:233`（die 提示）

**Interfaces:**
- Consumes: Task 1 产出的 `dist/*.pkg`。
- Produces: `list_dist` 能列出 `*.pkg`；`--help` 文案与实际产物一致。

- [ ] **Step 1: 逐处替换（保留原注释风格，别动无关行）**

1. `:11` 头注：`.dmg 依赖 hdiutil` → `.pkg 走 productbuild（macOS 自带）`，其余保留。
2. `:77` `list_dist` 循环：

```bash
    for f in *.pkg *.exe *.AppImage *.blockmap latest*.yml; do
```

3. `:93-94` `--local` 帮助行：

```
  --local              本机出 mac 安装包：先清空 apps/desktop/dist，再出 x64 + arm64
                       两个 pkg（约 1min），最后跑 asar 自检。
```

4. `:102-103` 示例：`# 出两个 dmg` → `# 出两个 mac pkg：x64 + arm64（约 1min）`；`# 上面两个 dmg 再加…` → `# 上面两个 pkg 再加…`。
5. `:113` `--publish` 示例：`k12-desktop-<版本>-arm64.dmg` → `k12-desktop-<版本>-arm64.pkg`。
6. `:115` 本机限制行：`.dmg 要 hdiutil` → `.pkg 要 productbuild（macOS 自带，本机就能出）`。
7. `:141`（`mode_local` 内日志）`出 mac 包（x64 + arm64 两个 dmg，约 1min）…` → `…两个 pkg…`。
8. `:233` die 提示示例 `.dmg` → `.pkg`。

- [ ] **Step 2: 跑护栏与自检**

Run: `cd apps/desktop && npm test`（tools-shell.guard 扫 `tools/**/*.sh` 的 bash 3.2 规则）
Run: `bash tools/app-build.sh --help`
Expected: 测试全绿；`--help` 里不再出现 dmg（历史注释里「不再出 dmg」的说明性文字除外）。

- [ ] **Step 3: Commit**

```bash
git add tools/app-build.sh
git commit -m "docs(tools): app-build.sh 的产物口径从 dmg 换成 pkg"
```

---

### Task 3: publish-installer.sh 识别 .pkg + 重写 mac 首次打开说明

**Files:**
- Modify: `tools/publish-installer.sh:111-120`（case 分支）、`:213-218`（首次打开说明）

**Interfaces:**
- Consumes: 下载目录里的 `*.pkg` 文件。
- Produces: 下载页把 `.pkg` 列为安装包并给 macOS 架构提示；mac 说明为 GUI 流程。

- [ ] **Step 1: case 分支合并 dmg/pkg**

第 111-120 行改为（dmg 分支保留，供历史产物渲染）：

```bash
      *.exe)      kind=installer; hint="Windows" ;;
      *.appimage) kind=installer; hint="Linux" ;;
      *.dmg|*.pkg)
        kind=installer
        case "$name_lc" in
          *arm64*) hint="macOS（Apple 芯片 / M 系列）" ;;
          *x64*)   hint="macOS（Intel）" ;;
          *)       hint="macOS" ;;
        esac ;;
      latest*.yml|*.blockmap) kind=updates ;;
```

- [ ] **Step 2: 重写「首次打开说明」mac 部分**

第 213-218 行 `<ul class="notes">` 改为：

```html
  <ul class="notes">
    <li>macOS（.pkg 安装包，未签名）：双击安装；若提示「无法验证开发者」，到
      「系统设置 → 隐私与安全性」点「仍要打开」后再双击，按安装器提示输入开机密码完成。
      全程不需要终端。</li>
    <li>macOS（早期发布的 .dmg 包）：拖入「应用程序」后首次打开若被拦，需在终端执行
      <code>xattr -dr com.apple.quarantine "/Applications/K12 智学.app"</code>，
      或走「系统设置 → 隐私与安全性 → 仍要打开」。</li>
    <li>Windows（安装包未签名）：首次运行会弹 SmartScreen 警告，点「更多信息」后选「仍要运行」。</li>
  </ul>
```

- [ ] **Step 3: 本机验证下载页渲染**

```bash
cp apps/desktop/dist/k12-desktop-*-arm64.pkg /tmp/fake-9.9.9-arm64.pkg 2>/dev/null || printf x > /tmp/fake-9.9.9-arm64.pkg
bash tools/publish-installer.sh --no-build /tmp/fake-9.9.9-arm64.pkg
grep -o "macOS（Apple 芯片 / M 系列）" apps/web/public/download/index.html
# 清理：删假文件后，把 index.html 自己作为参数重跑一次 —— gen_download_page 会跳过 index.html
# 本身、按目录里实际存在的产物重刷页面（--no-build 只重写 public/download/index.html，不动 dist/）
rm /tmp/fake-9.9.9-arm64.pkg
bash tools/publish-installer.sh --no-build apps/web/public/download/index.html
grep -c "fake-9.9.9" apps/web/public/download/index.html || echo "页面已刷干净"
```

- [ ] **Step 4: 跑护栏 + Commit**

```bash
cd apps/desktop && npm test
git add tools/publish-installer.sh
git commit -m "feat(tools): 下载页识别 .pkg 安装包，mac 说明改为 pkg 图形安装流程"
```

---

### Task 4: CI workflow 与 gitignore 护栏

**Files:**
- Modify: `.github/workflows/desktop-release.yml:93-96`（注释）、`:100-105`（上传 path）
- Modify: `apps/desktop/gitignore.guard.test.js:44`

**Interfaces:**
- Consumes: Task 1 产出的 `dist/*.pkg`。
- Produces: CI mac job 上传 `*.pkg`；若 latest*.yml 不再产出（以 Task 1 Step 4 实测为准）则从 path 删 `latest*.yml`（win/linux 仍产出 latest*.yml 时**保留**该行）。

- [ ] **Step 1: 改上传 path 与注释**

`:96-106` 步骤改为：

```yaml
      # 只收产物本身，**不收** dist/mac*/ 下的 .app 目录 —— 那条路径含中文与空格。
      # .exe 旁的 .blockmap（差量更新差分索引）一并上传：缺了它 ④ 只能回退成全量下载（spec §9）。
      # mac 产物是 .pkg（2026-10-07 spec）；mac 自动更新本就不可用，pkg 无 blockmap 不构成缺口。
      - name: 上传产物（安装包 + 更新清单 + 差分图）
        uses: actions/upload-artifact@v4
        with:
          name: k12-desktop-${{ matrix.os }}
          path: |
            apps/desktop/dist/*.pkg
            apps/desktop/dist/*.exe
            apps/desktop/dist/*.AppImage
            apps/desktop/dist/*.blockmap
            apps/desktop/dist/latest*.yml
          if-no-files-found: error
```

- [ ] **Step 2: gitignore 护栏加 .pkg 样例**

`gitignore.guard.test.js:44`：

```js
const MUST_BE_IGNORED = ['apps/web/public/download/k12-desktop-0.1.0-x64.dmg', 'apps/web/public/download/k12-desktop-0.1.0-arm64.pkg'];
```

- [ ] **Step 3: 跑测试 + Commit**

```bash
cd apps/desktop && npm test
git add .github/workflows/desktop-release.yml apps/desktop/gitignore.guard.test.js
git commit -m "ci(desktop): mac 产物上传 *.pkg；gitignore 护栏补 .pkg 样例"
```

---

### Task 5: README / constraints / 旧 spec 注记 / changelog

**Files:**
- Modify: `README.md:92`、`:102-103`、`:124`、`:133-145`
- Modify: `docs/constraints/pc-app-学习管控.md:109-112`
- Modify: `docs/superpowers/specs/2026-09-27-pc-app-packaging-design.md`（顶部注记）
- Modify: `docs/ai-core-changelog.md`（文件头追加一节）

- [ ] **Step 1: README 四处**

1. `:92` 示例 URL：`k12-desktop-0.1.0-arm64.dmg` → `k12-desktop-0.1.0-arm64.pkg`。
2. `:102-103`：

```bash
  bash tools/app-build.sh --local               # 本机出两个 mac pkg：x64 + arm64（约 1min）
  bash tools/app-build.sh --local --manifest    # 上面两个 pkg 再加更新清单 latest-mac.yml（若仍产出）
```

3. `:124` `--publish` 示例：`.dmg` → `.pkg`。
4. `:133-145` 整节替换为：

```markdown
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
```

- [ ] **Step 2: constraints 文档**

`docs/constraints/pc-app-学习管控.md:109-112` 替换为：

```markdown
- **mac 包只能在 macOS runner 上构建**（`pkg` 走 `productbuild`，macOS 自带）；win/linux 只出 x64。
  **本机出不了 AppImage**（要 docker）—— 本机验证一律用 `--mac`
- **mac 产物是 `.pkg` 不是 dmg**（2026-10-07 spec）：Installer.app 不向产物传播 quarantine（实测见
  spec §2），安装零终端；dmg 路线废止的原因是 quarantine 会**静默断掉 App 的局域网访问**
  （App 能启动但永远「暂时连不上学习服务器」，浏览器却正常 —— 别再当网络/代码问题排查）
- **不签名 → pkg 双击首次仍被 Gatekeeper 拦一次**：交付文档给「系统设置 → 隐私与安全性 → 仍要打开」
  （GUI）；`xattr` 终端命令只作为旧 dmg 包的兜底说明保留
```

- [ ] **Step 3: 旧 spec 顶部注记 + changelog**

旧 spec `2026-09-27-pc-app-packaging-design.md` 头部状态行后加：

```markdown
> **修订（2026-10-07）**：mac 产物形态 dmg → pkg，见 `2026-10-07-pc-app-mac-pkg-installer-design.md`；
> 本文涉 mac dmg 的章节以修订 spec 为准。
```

`docs/ai-core-changelog.md` 文件头按现有格式追加一节：2026-10-07 事故（第二台 MacBook quarantine → App 局域网全断、浏览器正常、`sandbox_extension_issue_file` 日志特征）+ pkg 改造 + `pkgbuild`/`installer` 实验结论（Installer 不传播 quarantine；`-target CurrentUserHomeDirectory` 会把绝对 install-location 拼到 home 下）。

- [ ] **Step 4: 自检 + Commit**

```bash
grep -rn "dmg" README.md docs/constraints/pc-app-学习管控.md | grep -v "旧\|历史\|早期\|废止\|不是 dmg"
git add README.md docs/constraints/pc-app-学习管控.md docs/superpowers/specs/2026-09-27-pc-app-packaging-design.md docs/ai-core-changelog.md
git commit -m "docs: mac 安装口径改 pkg —— README/约束/旧 spec 注记/changelog"
```

Expected: grep 只剩「旧 dmg 兜底」类表述；无把 dmg 当现行产物的主张。

---

### Task 6: 全量验收（自动部分）

**Files:** 无新改动（验收门）。

- [ ] **Step 1: 全量测试**

```bash
cd apps/desktop && npm test
```
Expected: 全绿（含 gitignore/tools-shell/user-data 护栏）。

- [ ] **Step 2: 端到端出包**

```bash
bash tools/app-build.sh --local
ls -la apps/desktop/dist/*.pkg
node apps/desktop/scripts/verify-asar.js
```
Expected: 双架构 pkg + asar 自检通过 + `list_dist` 列出 pkg。

- [ ] **Step 3: 汇报人工冒烟清单（转交用户，需第二台 mac）**

1. 从下载页下载 `.pkg` → 双击 → 出现 Gatekeeper 拦截对话框；
2. 「系统设置 → 隐私与安全性 → 仍要打开」→ 再双击 → 安装器完成、输密码装进 /Applications；
3. 打开 App → 能加载 `http://192.168.1.5:5173` 并登录（本次事故场景）；
4. `xattr -l "/Applications/K12 智学.app"` 输出为空；
5. 已装旧版本的机器升级安装：不残留两份、`~/Library/Application Support/k12-desktop/` 的 config.json 与 shell-state.json 存续。
