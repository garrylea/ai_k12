# PC App 打包与三平台分发（③）实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让 PC App 从「装 Node + `npm start`」变成「双击安装包就能用」——用 electron-builder 出 mac/win/linux 三平台产物，由 GitHub Actions 出包，产物放到本机服务器 web 层的 `/download/` 供局域网下载。

**Architecture:** 壳本身（`apps/desktop/`）不动，只加一层打包配置 + 一条 CI + 一个发布脚本。包的「内容白名单」由 `apps/desktop/electron-builder.yml` 的 `files` 字段钉死，并由一个 Node 校验脚本对产出的 `app.asar` 做**出包后断言**（防止 ② spec §8-9 那条「漏资源 → `loadFile` 失败 → 无节流紧循环」）。服务器地址的**唯一真源**仍是 `apps/desktop/server-url.js`，CI 与发布脚本都从它推导，不写第二处。

**Tech Stack:** electron-builder 26.x（稳定线）、Electron 44、GitHub Actions matrix（macos-14 / windows-latest / ubuntu-latest）、vitest、Node 22。

**权威 spec：** `docs/superpowers/specs/2026-09-27-pc-app-packaging-design.md`（下称「spec ③」）。**本计划与它冲突时以 spec 为准**，并按 §7 回填。

## Global Constraints

以下值**逐字**来自 spec ③，每个任务都隐含包含：

- `appId` = `com.k12zhixue.desktop` —— **发布后改不得**（装过的机器按它认身份）
- `productName` = `K12 智学`（中文，允许）；`artifactName` = `k12-desktop-${version}-${arch}.${ext}` —— **必须全 ASCII**（不许出现中文/空格）
- `userData` 目录**钉死**为 `k12-desktop` —— 与 `productName` 解耦，不许让中文名决定路径
- `files` 是**白名单**（不是黑名单），且**必须排除 `*.test.js`**
- `asar` 必须为 true（校验脚本以它为前提）
- 只出 **x64** 的 win/linux；mac 出 **x64 + arm64 两个 dmg**（不用 universal）
- 版本号**只**改 `apps/desktop/package.json` 的 `version`；tag 形如 `desktop-v0.1.0`，与 version 不符则 CI 失败
- 不签名、不公证（mac 也不）→ `mac.identity: null`
- **UI / 组件 / 面向用户的文案里不用 emoji**（仓库硬规则，`CLAUDE.md` 基本原则 1）；`tools/*.sh` 符合仓库既有风格（`set -euo pipefail` + `log()` / `die()`）
  - ⚠️ **本约束的正确范围（Task 1 执行中更正）**：`⚠️` / `✅` 这类符号**在代码注释与文档里是本仓既定风格** —— `apps/desktop/main.js` 3 处、`server-url.js` 2 处、`preload.js`、`lib/probe-server.js`、`lib/shell-state.js` 都在用。**不要**为了「无 emoji」去删注释里的 `⚠️`；约束只管**用户可见面**（UI、组件、文案、脚本对用户打印的输出）。
- 新增 YAML **必须**在 `.gitignore` 里反选（根 `.gitignore` 有全局 `*.yml` 规则，见 Task 1）
- 不许动 `docs/API接口与数据流设计文档.md` 与 `docs/api/openapi.yaml`（本设计不涉及端点）

## 对 spec ③ 的偏离（**动手前请先确认这几条**）

写计划时发现 4 处「照 spec 字面做会出问题/会白做」，本计划按改进版执行，**都已在下面标注**：

| # | spec 原文 | 本计划 | 理由 |
|---|---|---|---|
| **D1** | §4.3 第 7 步：asar 白名单校验「**脚本内联**」在 workflow 里 | 落成 `apps/desktop/scripts/verify-asar.js`（Node，devDep `@electron/asar`），CI 只调 `node scripts/verify-asar.js` | ① mac 的 asar 路径含**中文 + 空格**（`dist/mac-arm64/K12 智学.app/Contents/Resources/`），bash 里极易断词而我复核时已把它列为风险；Node 用 `execFileSync(argv)` 完全没有引号问题。② spec §8-2 要求**本机先验**，脚本化才能本机/CI 同一段逻辑。③ 纯函数部分可单测 |
| **D2** | §4.4 脚本用法只有 `<文件...>` | 多加一个 `--no-build` | 照 `tools/services.sh` 的既有惯例（`--no-build` / `SERVICES_NO_BUILD=1`）；让验收 #7 与脚本的负例分支可测，不必每次都重建 60s 的 web。**默认行为不变**（不加就重建） |
| **D3** | §4.3 只提 CI 的 `CSC_IDENTITY_AUTO_DISCOVERY: false` | 另在 yml 写 `mac.identity: null`，两者都留 | 本机跑 `--mac`（§8-2 要求）时也会去翻钥匙串，写进 yml 才可靠：不会因为本机恰好有 Developer ID 就签出**不一致的产物** |
| **D4** | spec 未要求测试（§5 只有 CI 验收 + 人工验收） | 新增 3 个测试文件（2 个形态护栏 + 1 个单测） | 本案有**两个静默失效点**（`.gitignore` 吃掉 YAML；asar 漏资源），仓库既有惯例正是用「形态护栏」钉住静默失效（见 `apps/server/src/database/repositories/limit-placeholder.guard.test.ts`）。测试**不承重就是负担**，所以每个护栏都带一条「探针有牙齿」用例防假绿 |

另外 **spec §5 有一条待实测回填**：表格里写「更新清单…其中的下载 URL 指向本机服务器地址」。electron-builder 的 `latest*.yml` 多半只记**相对文件名**（基址来自 publish 配置），若属实则该措辞不准。**Task 3 的 Step 10 会实测**，并给出两种情况各自怎么办。

---

## 文件结构

| 文件 | 责任 | 动作 |
|---|---|---|
| `.gitignore` | 反选两个新增 YAML + 忽略安装包目录 | Modify |
| `apps/desktop/electron-builder.yml` | 打包配置的唯一落点（标识 / 白名单 / target / 命名） | Create |
| `apps/desktop/scripts/verify-asar.js` | 出包后断言：必需资源在、测试文件不在（纯函数可测 + CLI 入口） | Create |
| `apps/desktop/scripts/verify-asar.test.js` | 上述纯函数的单测 + 「白名单与 main.js 不漂移」的护栏 | Create |
| `apps/desktop/gitignore.guard.test.js` | 形态护栏：新增 YAML 必须真的能被 git 跟踪 | Create |
| `apps/desktop/user-data.guard.test.js` | 形态护栏：`userData` 必须被钉死、且早于所有读取 | Create |
| `apps/desktop/package.json` | 钉 devDeps（`electron-builder` / `@electron/asar`）+ `verify:asar` 脚本 + 改过期的 `description` | Modify |
| `apps/desktop/main.js` | 加 `app.setPath('userData', …)` | Modify |
| `.github/workflows/desktop-release.yml` | 三平台出包（含测试门禁 + 版本校验 + asar 断言 + 上传产物） | Create |
| `tools/publish-installer.sh` | 发布到本机服务器 `/download/` 并打印下载地址 | Create |
| `README.md` | 交付形态、下载路径、mac 首开指引；**删掉**已失效的 productName 警告 | Modify |
| `docs/constraints/pc-app-学习管控.md` | ③ 的硬约束；**改掉**「路径随 productName 变」的旧表述 | Modify |
| `docs/superpowers/specs/2026-09-26-…md` | §5 结清项 + §8-8 更正注记 | Modify |
| `docs/ai-core-changelog.md` | 本次实测事实 | Modify |
| `apps/desktop/server-url.js` | **删掉**与实现不符的注释 | Modify |

---

## Task 1: 解除 `.gitignore` 阻断（spec §4.0）

**为什么这个排第一：** 不做这里，Task 6 的 workflow 与 Task 3 的 `electron-builder.yml` 都进不了仓库 —— CI 永不运行、`files` 白名单失效，而且**不报错**（spec §4.0）。

**Files:**
- Modify: `.gitignore:52-53`（`*.yml` 那条）+ 文件末尾
- Test: `apps/desktop/gitignore.guard.test.js`（新建）

**Interfaces:**
- Consumes: 无
- Produces: 仓库能被 git 跟踪的两个 YAML 路径常量 —— `apps/desktop/electron-builder.yml`、`.github/workflows/desktop-release.yml`（Task 3 / Task 6 依赖它们真的能 `git add`）

- [ ] **Step 1: 先写失败的护栏测试**

新建 `apps/desktop/gitignore.guard.test.js`：

```js
import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * 形态护栏（只读仓库配置，不跑 Electron）：**本该入库的 YAML 必须真的能被 git 跟踪**。
 *
 * 为什么值得一条这么"外围"的用例（spec ③ §4.0 / §8-8，2026-09-27 实测）：
 * 根 `.gitignore` 有一条**文件级全局规则** `*.yml`（为 Playwright 快照加的），它会连
 * electron-builder 配置与 GitHub Actions workflow 一起吃掉。失效模式是**静默**的 ——
 * `git add` 不报错、CI 不报错、本地看不出来，只有学生装出来的包**缺资源、缺标识**
 * （`files` 白名单失效 → 直接复现 ② spec §8-9 的「漏 pages/offline.html → loadFile 失败
 * → 无节流紧循环、屏幕无 UI」）时才暴露。
 *
 * 实测行为（git 2.50.1，本用例的判据就是这么定的；**Task 1 执行中发现的坑**）：
 *   git check-ignore -v <path>  命中普通规则 → status 0，stdout = `文件:行:规则\t路径`
 *                               命中**反选规则（!开头）** → **status 仍是 0**，stdout 把
 *                                 反选规则原样打印（`文件:行:!规则\t路径`）
 *                                 → 所以**带 -v 时 exit status 不代表「被忽略」**
 *                               （只有**不带 -v** 时 status 才纯粹表示「是否被忽略」：
 *                                 被忽略 → 0，未忽略 → 1。）
 *                               不在 git 仓库 → status 128
 *                               没装 git → spawnSync 的 error 有值
 *
 * 这个坑会让「反选生效」永远测不绿 —— 计划初稿就踩了：拿 `-v` 的 status 当「被忽略」，
 * 而反选后 status 恒为 0。下面的判据因此**必须**排除「命中的是反选规则」这一情形。
 */
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

/** 探针：这个必须**被忽略**，用来证明探针真的在读 .gitignore（不是空跑导致假绿）。 */
const IGNORED_PROBE = 'foo.log';
/** 必须**能被跟踪**（相对仓库根）—— spec §4.0 那两个文件。 */
const MUST_BE_TRACKABLE = [
  'apps/desktop/electron-builder.yml',
  '.github/workflows/desktop-release.yml',
];
/** 必须**被忽略**（安装包上百 MB，绝不能入库）—— spec §4.4。 */
const MUST_BE_IGNORED = ['apps/web/public/download/k12-desktop-0.1.0-x64.dmg'];

function checkIgnore(relPath) {
  const r = spawnSync('git', ['check-ignore', '-v', relPath], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
  });
  if (r.error) return null; // 没装 git
  if (r.status === 128) return null; // 不在 git 仓库里（例如导出的 tarball）
  const rule = (r.stdout ?? '').trim();
  // 见文件头「实测行为」：带 -v 时命中反选规则也 status 0，所以「被忽略」不能只看 status，
  // 还要排除「命中的是反选规则」。只取 tab 前的 `文件:行:规则` 部分判断，
  // 避免路径名里恰好含 `:数字:!` 造成误判。
  const ignored = r.status === 0 && !/:\d+:!/.test(rule.split('\t')[0]);
  return { ignored, rule };
}

const probe = checkIgnore(IGNORED_PROBE);
const usable = probe !== null;

describe('.gitignore 的 *.yml 陷阱（spec ③ §4.0）', () => {
  it('探针有牙齿：能观察到仓库里真实存在的忽略规则', () => {
    // 这条挂了说明 checkIgnore 没在工作（没装 git / 不在仓库里）。此时下面两条会 skip ——
    // 护栏会**静默变绿**，那比红更糟。所以宁可在这里红。
    expect(probe, `无法在 ${REPO_ROOT} 用 git check-ignore 观察忽略规则，护栏失效`).not.toBeNull();
    expect(probe.ignored).toBe(true);
    expect(probe.rule).toContain('*.log');
  });

  it.skipIf(!usable)('新增的两个 YAML 不得被 .gitignore 忽略', () => {
    for (const p of MUST_BE_TRACKABLE) {
      const r = checkIgnore(p);
      expect(r.ignored, `${p} 被「${r.rule}」吃掉（spec §4.0）—— 须在 .gitignore 加反选`).toBe(
        false,
      );
    }
  });

  it.skipIf(!usable)('安装包目录必须被忽略', () => {
    for (const p of MUST_BE_IGNORED) {
      const r = checkIgnore(p);
      expect(r.ignored, `${p} 未被忽略 —— 一把 \`git add -A\` 就会把上百 MB 装进仓库`).toBe(true);
    }
  });
});
```

- [ ] **Step 2: 跑测试，确认它失败**

```bash
cd apps/desktop && npx vitest run gitignore.guard.test.js
```

Expected: **FAIL**，两条 skipIf 用例中第一条报

```
apps/desktop/electron-builder.yml 被「.gitignore:53:*.yml	apps/desktop/electron-builder.yml」吃掉（spec §4.0）—— 须在 .gitignore 加反选
```

（「探针有牙齿」那条应当 **PASS** —— 它证明确实是 `.gitignore` 在作祟，不是探针坏了。）

- [ ] **Step 3: 改 `.gitignore`**

把 `.gitignore` 第 52-53 行：

```gitignore
# Playwright MCP 快照（login.yml / targeted.yml 等）——仓库无已跟踪 *.yml，全局忽略安全
*.yml
```

替换为：

```gitignore
# Playwright MCP 快照（login.yml / targeted.yml 等）
# ⚠️ 这是**文件级全局规则**，会连本该入库的 YAML 一起吃掉，而且**不报错**
#    （git add 成功、CI 成功、只有产物缺内容时才暴露）。
#    **每新增一个需要入库的 YAML，都必须在这里加一条反选**，
#    并同步 apps/desktop/gitignore.guard.test.js 的 MUST_BE_TRACKABLE。
# 已反选：electron-builder 配置 + GitHub Actions workflow
# （spec docs/superpowers/specs/2026-09-27-pc-app-packaging-design.md §4.0）
*.yml
!apps/desktop/electron-builder.yml
!.github/workflows/*.yml
```

然后在 `.gitignore` **末尾**追加：

```gitignore

## PC App 安装包（tools/publish-installer.sh 放进 apps/web/public/，单个数十~上百 MB，绝不能入库）
apps/web/public/download/
```

- [ ] **Step 4: 跑测试，确认全绿**

```bash
cd apps/desktop && npx vitest run gitignore.guard.test.js
```

Expected: PASS（3 passed）

- [ ] **Step 5: 跑全量测试，确认没碰坏别的**

```bash
cd apps/desktop && npm test
```

Expected: PASS（41 passed —— 原 38 + 新增 3）

- [ ] **Step 6: 手工确认 git 真的看得见这两个路径**

```bash
cd /Users/lichao/Downloads/claude/imooc/ai_k12
git status --short          # 应看到 .gitignore 与 gitignore.guard.test.js 是 M / ??
git check-ignore apps/desktop/electron-builder.yml .github/workflows/desktop-release.yml
```

Expected: `git check-ignore` 输出为空且 **exit code 1**（`echo $?`）—— 即两个路径都不再被忽略。

> ⚠️ **这里必须用不带 `-v` 的形式**（Task 1 执行中实测的坑）：带 `-v` 时，命中**反选规则**
> 也会返回 exit 0 并把反选行打印出来，所以 `-v` 的退出码**不能**当「是否被忽略」的判据。
> 不带 `-v` 时语义才是纯粹的：被忽略 → 0，未忽略 → 1。

> **这条是 spec §5 的验收 #10**，也是本任务最关键的证据：**必须用 `git status` 亲眼看到**，别只看测试绿。

- [ ] **Step 7: 提交**

```bash
cd /Users/lichao/Downloads/claude/imooc/ai_k12
git add .gitignore apps/desktop/gitignore.guard.test.js
git commit -m "chore(gitignore): 反选 electron-builder 与 workflow 两个 YAML + 忽略安装包目录

根 .gitignore 的全局 *.yml 会静默吃掉这两个文件：CI 永不运行、files 白名单失效。
加护栏用例钉住（探针有牙齿 + 两个 skipIf 断言），见 spec ③ §4.0。"
```

---

## Task 2: `userData` 钉死 + 护栏（spec §4.2）

**Files:**
- Modify: `apps/desktop/main.js`（在 `app.commandLine.appendSwitch('no-proxy-server');` 之后插入）
- Test: `apps/desktop/user-data.guard.test.js`（新建）

**Interfaces:**
- Consumes: 无
- Produces: 打包后 `app.getPath('userData')` 永远是 `<appData>/k12-desktop` —— README 的三条救火路径（`config.json` 位置）与 `shell-state.json` 的位置都依赖它

- [ ] **Step 1: 先写失败的护栏测试**

新建 `apps/desktop/user-data.guard.test.js`：

```js
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

/**
 * 形态护栏：`userData` 必须被**显式钉死**，且钉死发生在所有读取之前（spec ③ §4.2）。
 *
 * 为什么需要（2026-09-27）：③ 给应用设了中文 `productName`（K12 智学），而
 * `app.getPath('userData')` 走的是 `app.getName()` → 打包后会变成「…/K12 智学/」（中文 + 空格），
 * 于是 README 里那三条**救火路径**（客户端连不上时唯一的自救手段，② spec §8-3）全部失效。
 * 一行 `app.setPath` 就是全部防线 —— 删掉它不会有任何测试变红，所以必须钉住。
 *
 * 次序同样承重：`setPath` 晚于读取就等于没钉（读到的已经是中文路径）。
 */
const DESKTOP = path.resolve(path.dirname(fileURLToPath(import.meta.url)));
const require = createRequire(import.meta.url);
const src = readFileSync(path.join(DESKTOP, 'main.js'), 'utf8');
const pkg = require('./package.json');

describe('userData 钉死护栏（spec ③ §4.2）', () => {
  it('main.js 里有 app.setPath(\'userData\', …)', () => {
    expect(src).toMatch(/app\.setPath\(\s*'userData'/);
  });

  it('钉死的目录名与 package.json 的 name 一致（否则 dev 路径与打包后不一致）', () => {
    const m = src.match(/app\.setPath\(\s*'userData'\s*,\s*([^\n]+)\)/);
    expect(m, '没找到 setPath 调用的参数').not.toBeNull();
    // 本仓约定：目录名 = package.json 的 name（dev 下本就是这个值，故 dev 路径不变）
    expect(m[1]).toContain(`'${pkg.name}'`);
  });

  it('钉死发生在所有 app.getPath(\'userData\') 读取之前（否则等于没钉）', () => {
    const setAt = src.search(/app\.setPath\(\s*'userData'/);
    const getAt = src.search(/app\.getPath\(\s*'userData'/);
    expect(getAt, 'main.js 应当有读取 userData 的代码，本用例才有意义').toBeGreaterThanOrEqual(0);
    expect(setAt, 'setPath 必须在第一处 getPath 之前').toBeLessThan(getAt);
  });
});
```

- [ ] **Step 2: 跑测试，确认它失败**

```bash
cd apps/desktop && npx vitest run user-data.guard.test.js
```

Expected: **FAIL** —— 第一条报 `expected '…' to match /app\.setPath\(\s*'userData'/`（还没这行）。

- [ ] **Step 3: 在 `main.js` 加钉死代码**

在 `apps/desktop/main.js` 里，紧跟这一段之后（即 `app.commandLine.appendSwitch('no-proxy-server');` 之后、下一个注释块之前）：

```js
app.commandLine.appendSwitch('no-proxy-server');
```

插入：

```js

/**
 * **钉死 userData 目录，与 `productName` 解耦**（spec ③ §4.2）。
 *
 * 打包后 `productName` 是中文（`K12 智学`），而 `app.getPath('userData')` 取 `app.getName()`
 * —— 也就是 `productName`（若设了）否则 `name`。不钉的话 userData 会变成
 * 「…/K12 智学/」（**中文 + 空格**），README 里那三条救火路径（`config.json` 的位置）就全失效了，
 * 而那是客户端连不上时**唯一的自救手段**（② spec §8-3）。
 *
 * 显式固定为 ASCII，且与 dev 下的路径完全一致（`package.json` 的 `name` 本来就是 `k12-desktop`）
 * —— 所以 dev 行为不变，打包后才生效。
 *
 * ⚠️ **必须在任何 `app.getPath('userData')` 读取之前调用**（本文件里那两处都在 `whenReady` 内，
 * 且用的是模块级 `app`，所以放在这里一定早于它们）。删掉这行不会有任何测试变红，
 * 但会让 README 的三条路径全部指向不存在的目录 —— 有 `user-data.guard.test.js` 钉着。
 */
app.setPath('userData', path.join(app.getPath('appData'), 'k12-desktop'));
```

（`path` 已在文件首部 `require('node:path')`，无需新增 import。）

- [ ] **Step 4: 跑测试，确认全绿**

```bash
cd apps/desktop && npx vitest run user-data.guard.test.js
```

Expected: PASS（3 passed）

- [ ] **Step 5: 确认 dev 行为没变（路径是同一个）**

```bash
cd apps/desktop && node -e "
const path=require('node:path'), os=require('node:os');
const {app}=require('electron');
" 2>/dev/null || echo "（electron 不能在纯 node 下 require，跳过；改由 Task 3 Step 11 的真实启动验证）"
node -e "console.log('appData 下的目标目录名 =', require('./package.json').name)"
```

Expected: 打印 `k12-desktop` —— 与钉死的目录名一致（这就是「dev 不变」的含义）。

- [ ] **Step 6: 提交**

```bash
cd /Users/lichao/Downloads/claude/imooc/ai_k12
git add apps/desktop/main.js apps/desktop/user-data.guard.test.js
git commit -m "fix(desktop): 钉死 userData 为 k12-desktop，与中文 productName 解耦

不钉的话打包后 userData 会变成「…/K12 智学/」（中文+空格），README 里那三条救火路径
（config.json 的位置，客户端连不上时唯一的自救手段）全部失效。加护栏用例钉住
「存在 + 名字与 package.json 一致 + 早于所有读取」，见 spec ③ §4.2。"
```

---

## Task 3: 打包配置 + 校验脚本 + 本机出包验证（spec §4.1 / §4.3 第 7 步 / §8-2）

**为什么这个排第三：** spec §8-2 明确要求「计划的第一个任务先在本机跑通 `--dir`，并紧接着真出一次包确认更新清单产出」—— 这是全案**唯一**能证伪「Electron 44 + electron-builder 26.x 能出包」的手段，不能等到 CI。

**Files:**
- Modify: `apps/desktop/package.json`（devDeps + script + description）
- Create: `apps/desktop/electron-builder.yml`
- Create: `apps/desktop/scripts/verify-asar.js`
- Create: `apps/desktop/scripts/verify-asar.test.js`

**Interfaces:**
- Consumes: Task 1 的反选（否则本任务的文件进不了仓库）
- Produces:
  - `apps/desktop/scripts/verify-asar.js` —— 导出 `REQUIRED: string[]`、`parseAsarList(stdout: string): Set<string>`、`checkEntries(entries: Set<string>): string[]`；CLI：`node scripts/verify-asar.js [distDir]`，通过时退出码 0 并打印 `asar 白名单校验通过`，否则退出码 1
  - npm script `verify:asar`（Task 6 的 CI 会用同名脚本）

- [ ] **Step 1: 写校验脚本的失败测试**

新建 `apps/desktop/scripts/verify-asar.test.js`：

```js
import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const HERE = path.resolve(path.dirname(fileURLToPath(import.meta.url)));
const DESKTOP = path.resolve(HERE, '..');
const { REQUIRED, parseAsarList, checkEntries } = require('./verify-asar.js');

describe('parseAsarList', () => {
  it('去掉前导斜杠与反斜杠，统一成正斜杠', () => {
    const out = parseAsarList('/main.js\n\\lib\\config-file.js\n');
    expect([...out].sort()).toEqual(['lib/config-file.js', 'main.js']);
  });

  it('忽略空行与行尾空白', () => {
    expect([...parseAsarList('/pages/offline.html  \n\n\n')]).toEqual(['pages/offline.html']);
  });
});

describe('checkEntries', () => {
  const good = new Set(REQUIRED);

  it('齐全且无测试文件 → 没有问题', () => {
    expect(checkEntries(good)).toEqual([]);
  });

  it('缺一件必需资源 → 报出来（② spec §8-9：漏 pages/offline.html 会无节流紧循环）', () => {
    const bad = new Set(REQUIRED);
    bad.delete('pages/offline.html');
    const problems = checkEntries(bad);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('pages/offline.html');
  });

  it('混进任何 *.test.js → 报出来（files 白名单的否定规则失效时靠这条兜住）', () => {
    const bad = new Set([...REQUIRED, 'lib/shell-state.test.js', 'user-data.guard.test.js']);
    const problems = checkEntries(bad);
    expect(problems).toHaveLength(2);
    expect(problems.every((p) => p.includes('*.test.js 或测试文件') || p.includes('混进包'))).toBe(
      true,
    );
  });

  it('有牙齿：空集合必须被判为不合格（防"空扫导致假绿"）', () => {
    const problems = checkEntries(new Set());
    expect(problems.length).toBeGreaterThanOrEqual(REQUIRED.length);
  });
});

describe('REQUIRED 与本仓库的真实形态一致（防漂移）', () => {
  it('每一项都在磁盘上真实存在（防白名单写错名字）', () => {
    for (const f of REQUIRED) {
      expect(existsSync(path.join(DESKTOP, f)), `${f} 在 apps/desktop 下不存在`).toBe(true);
    }
  });

  it('覆盖 main.js 里所有 require(\'./…\') 的本地模块（改 main.js 加模块时这里会红）', () => {
    const src = readFileSync(path.join(DESKTOP, 'main.js'), 'utf8');
    const rel = [...src.matchAll(/require\(['"](\.[^'"]+)['"]\)/g)].map((m) =>
      m[1].replace(/^\.\//, ''),
    );
    expect(rel.length, '没扫到本地 require，正则失效了').toBeGreaterThanOrEqual(4);
    for (const r of rel) {
      expect(REQUIRED, `main.js require 了 ${r}，但 asar 白名单没钉住它 → 打包后会缺件`).toContain(
        r,
      );
    }
  });
});
```

- [ ] **Step 2: 跑测试，确认它失败**

```bash
cd apps/desktop && npx vitest run scripts/verify-asar.test.js
```

Expected: **FAIL** —— `Cannot find module './verify-asar.js'`。

- [ ] **Step 3: 写 `apps/desktop/scripts/verify-asar.js`**

```js
'use strict';

/**
 * 出包后断言：`app.asar` 里**必需资源一件不少、测试文件一件不多**（spec ③ §4.3 第 7 步）。
 *
 * 为什么必须有这一段（② spec §8-9，2026-09-27）：`main.js` 的 `showOfflinePage()` 用
 * `loadFile('pages/offline.html')` 加载本地页，**没有失败守卫**。若打包漏了这个文件，
 * `loadFile` 失败会触发 `did-fail-load` → 再次 `showOfflinePage()` → **无节流的紧循环，
 * 且屏幕上没有任何可见 UI**（这条路径不受重试定时器限流）。所以"漏资源"必须在上线前拦下。
 *
 * 为什么用 Node 而不是 workflow 里内联 bash：mac 的 asar 落在
 * `dist/mac-arm64/K12 智学.app/Contents/Resources/` —— 路径**含中文与空格**，
 * bash 里极易断词；这里用 `execFileSync(可执行文件, argv[])`（不经过 shell），零引号问题。
 *
 * 用法：
 *   node scripts/verify-asar.js            # 扫 apps/desktop/dist
 *   node scripts/verify-asar.js <distDir>  # 扫指定目录（本地 --dir 出包时用）
 */

const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

/** 必须进包的运行时资源。缺一件 → 学生机上的失败模式见文件头。 */
const REQUIRED = [
  'main.js',
  'preload.js',
  'server-url.js',
  'package.json',
  'lib/config-file.js',
  'lib/resolve-server-url.js',
  'lib/probe-server.js',
  'lib/shell-state.js',
  'pages/offline.html',
];

/**
 * 把 `asar list` 的输出解析成包内相对路径集合。
 * 输出每行形如 `/main.js`（前导 `/`）、目录也会有、Windows 上可能是 `\lib\x.js`。
 */
function parseAsarList(stdout) {
  return new Set(
    String(stdout)
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter(Boolean)
      .map((l) => l.replace(/^[/\\]+/, '').replace(/\\/g, '/')),
  );
}

/** 纯校验：返回问题列表，空数组 = 通过。 */
function checkEntries(entries) {
  const problems = [];
  for (const f of REQUIRED) {
    if (!entries.has(f)) problems.push(`缺必需资源：${f}`);
  }
  for (const f of entries) {
    if (/(^|\/)[^/]*\.test\.js$/.test(f)) problems.push(`测试文件混进包：${f}`);
  }
  return problems;
}

/** 递归找出 distDir 下所有 app.asar（--dir 与完整出包都在这个位置）。 */
function findAsarFiles(distDir) {
  const out = [];
  const walk = (dir) => {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) walk(full);
      else if (e.name === 'app.asar') out.push(full);
    }
  };
  walk(distDir);
  return out;
}

/** 取 @electron/asar 的 CLI 入口，用 `node <cli> list <archive>` 调（跨平台、不依赖 .bin 垫片）。 */
function asarCliPath() {
  // ⚠️ 不能 `require.resolve('@electron/asar/package.json')`：v4（实测 4.3.1）的 `exports`
  //    是**单个字符串** `'./lib/asar.js'`，不含 `'./package.json'` 子路径，会抛
  //    `ERR_PACKAGE_PATH_NOT_EXPORTED`（Task 3 执行时实测）。所以改成：解析包入口（exports
  //    字符串对 `require` 条件仍生效）→ 从入口目录**上溯找到包根** → 从磁盘读 `package.json`
  //    取 `bin`。这样同时兼容 v3 的对象式 `bin`（`bin.asar`）与 v4 的字符串式 `bin`。
  //    （v4 的 bin 是 `./bin/asar.mjs`，包本身 `"type": "module"` —— 我们用
  //     `execFileSync(process.execPath, [cli, ...])` 调它，所以 ESM 与否都无所谓。）
  const entry = require.resolve('@electron/asar');
  let root = path.dirname(entry);
  let pkg = null;
  for (;;) {
    const pkgFile = path.join(root, 'package.json');
    if (fs.existsSync(pkgFile)) {
      try {
        const parsed = JSON.parse(fs.readFileSync(pkgFile, 'utf8'));
        if (parsed.name === '@electron/asar') {
          pkg = parsed;
          break;
        }
      } catch {
        /* 读不了就继续上溯 */
      }
    }
    const parent = path.dirname(root);
    if (parent === root) throw new Error('找不到 @electron/asar 的包根');
    root = parent;
  }
  const bin = pkg.bin;
  const rel = typeof bin === 'string' ? bin : bin && bin.asar;
  if (!rel) throw new Error('@electron/asar 的 package.json 里没有 bin.asar');
  return path.join(root, rel);
}

function main() {
  const distDir = process.argv[2]
    ? path.resolve(process.argv[2])
    : path.resolve(__dirname, '..', 'dist');

  if (!fs.existsSync(distDir)) {
    console.error(`[verify-asar] 找不到输出目录：${distDir}（先出包再校验）`);
    process.exit(1);
  }

  const archives = findAsarFiles(distDir);
  if (archives.length === 0) {
    console.error(`[verify-asar] ${distDir} 下没有任何 app.asar —— 打包没成功，或 asar 被关掉了`);
    process.exit(1);
  }

  const cli = asarCliPath();
  let failed = false;

  for (const archive of archives) {
    let stdout;
    try {
      stdout = execFileSync(process.execPath, [cli, 'list', archive], {
        encoding: 'utf8',
        maxBuffer: 32 * 1024 * 1024,
      });
    } catch (err) {
      console.error(`[verify-asar] 列不出 ${archive}：${err.message}`);
      failed = true;
      continue;
    }

    const entries = parseAsarList(stdout);
    const problems = checkEntries(entries);
    if (problems.length > 0) {
      failed = true;
      console.error(`[verify-asar] ${archive} 不合格：`);
      for (const p of problems) console.error(`  - ${p}`);
    } else {
      console.log(`[verify-asar] ${archive} 合格（必需 ${REQUIRED.length} 项齐全，无测试文件）`);
    }
  }

  if (failed) process.exit(1);
  console.log(`asar 白名单校验通过（${archives.length} 个包）`);
}

if (require.main === module) main();

module.exports = { REQUIRED, parseAsarList, checkEntries, findAsarFiles };
```

- [ ] **Step 4: 跑测试，确认全绿**

```bash
cd apps/desktop && npx vitest run scripts/verify-asar.test.js
```

Expected: PASS（8 passed）

> ⚠️ 若 `覆盖 main.js 里所有 require('./…')` 那条红了，说明 `REQUIRED` 漏了模块 —— **补 REQUIRED，别改测试**（测试是判据）。

- [ ] **Step 5: 钉依赖 + 加 script + 修过期的 description**

在 `apps/desktop` 下执行（**让 lockfile 一起更新**，CI 用 `npm ci` 依赖它）：

```bash
cd apps/desktop
npm install --save-dev electron-builder@^26.15.3 @electron/asar@^4.3.1
```

Expected: 安装成功；`package.json` 的 `devDependencies` 出现这两个包；`package-lock.json` 被更新。

> ⚠️ **不要用 `^27`** —— npm 上**没有稳定 v27**（只有 `27.0.0-alpha.9`），`^27` 解析不到任何版本（spec ③ §1 二次更正）。
> 若 `^26.15.3` 解到的版本（可能是 26.17.0）在本步之后的出包里失败，退路是**钉精确版本**：
> `npm install --save-dev --save-exact electron-builder@26.15.3`，并把实测结论回填 spec §1。

然后把 `apps/desktop/package.json` 改成（**逐字**，只动 `description` 与 `scripts`；`devDependencies` 的顺序按 npm 写回的为准）：

```json
{
  "name": "k12-desktop",
  "private": true,
  "version": "0.1.0",
  "description": "K12 智学 PC App（Electron 壳）。安装包由 GitHub Actions 出，见 docs/superpowers/specs/2026-09-27-pc-app-packaging-design.md",
  "main": "main.js",
  "scripts": {
    "start": "electron .",
    "test": "vitest run",
    "verify:asar": "node scripts/verify-asar.js"
  },
  "devDependencies": {
    "@electron/asar": "^4.3.1",
    "electron": "^44.4.5",
    "electron-builder": "^26.15.3",
    "vitest": "^3.2.7"
  }
}
```

（原 `description` 是「（Electron 壳，dev 模式；本期不出安装包）」—— ③ 之后这句过期，spec §7 点名要改。）

- [ ] **Step 6: 新建 `apps/desktop/electron-builder.yml`**

```yaml
# PC App 打包配置 —— spec docs/superpowers/specs/2026-09-27-pc-app-packaging-design.md §4.1
#
# ⚠️ 本文件是 YAML：根 .gitignore 有一条全局 `*.yml` 规则，靠里面的反选才进得来。
#    动 .gitignore 时别把反选弄丢（apps/desktop/gitignore.guard.test.js 钉着）。

appId: com.k12zhixue.desktop      # ⚠️ 发布后改不得：装过的机器按它认应用身份，④ 的更新也按它认
productName: K12 智学             # 中文允许（应用名好看）；路径不受影响，见下面 userData 的说明
asar: true                        # 显式写：脚本与 CI 的白名单校验都以「产物是 asar」为前提

directories:
  buildResources: build           # build/icon.png（1024×1024）会被自动采用，不需要另备 .ico/.icns
  output: dist                    # 已被根 .gitignore 的 `dist/` 忽略

# ⚠️ 白名单，不是黑名单：不写的话默认会把 app 目录下所有文件打进包，**包括 5 个 *.test.js**。
# ⚠️ `lib/**/*.js` 会匹配 lib/*.test.js，靠最后那条否定规则排掉。
#    否定语义一旦失效，测试文件就会进包 —— 由 scripts/verify-asar.js 兜住（会红，不静默通过）。
files:
  - main.js
  - preload.js
  - server-url.js
  - lib/**/*.js
  - pages/**
  - package.json
  - '!**/*.test.js'

# 产物名必须 ASCII：默认模板是 ${productName}-${version}-${arch}.${ext}，会产出
# 「K12 智学-0.1.0-arm64.dmg」（中文 + 空格）→ 污染 /download/ 的 URL、复制粘贴变脆。
# 只用 ${name}/${version}/${arch}/${ext} 这四个确定支持的宏；不引入 ${os}（靠 ${ext} 已能区分平台）。
artifactName: k12-desktop-${version}-${arch}.${ext}

win:
  target: [{ target: nsis, arch: [x64] }]

mac:
  # 显式关闭签名（spec §3-2：不签不公证）。比只依赖 CSC_IDENTITY_AUTO_DISCOVERY 环境变量可靠：
  # 本机跑 --mac 时也不会因为钥匙串里恰好有 Developer ID 就签出**不一致的产物**。
  identity: null
  target: [{ target: dmg, arch: [x64, arm64] }]   # 双架构两个 dmg，不用 universal（spec §3-7）

linux:
  target: [{ target: AppImage, arch: [x64] }]

# ⚠️ 这里**故意不写 `publish`** —— 下载地址的唯一真源是 apps/desktop/server-url.js，
#    写进 yml 就成第二处、必然漂移。CI 与本机验证都用 CLI 注入（spec §4.5）：
#      --config.publish.provider=generic --config.publish.url="$SERVER/download"
```

- [ ] **Step 7: 本机最小验证 —— `--dir` 出包（spec §8-2 ①）**

```bash
cd apps/desktop && rm -rf dist && ./node_modules/.bin/electron-builder --mac --dir
```

Expected: 退出码 0；产出 `dist/mac-arm64/K12 智学.app/`（本机是 arm64，无 arch 参数时按宿主架构）。

```bash
cd apps/desktop && find dist -name 'app.asar' -print
```

Expected: `dist/mac-arm64/K12 智学.app/Contents/Resources/app.asar`

> 这一步就是为了**证伪/证实**「Electron 44 + electron-builder 26.x 能出包」。若报
> electron-builder 不认识 Electron 44 之类，**停下来**：把报错原文记下来，按 spec §8-2 的退路
> （钉精确版本 / 改 CI 的 node 版本）处理，并把结论回填 spec §1，再继续。

- [ ] **Step 8: 用校验脚本验收这个包（这一步才是「资源真的进包了」的证据）**

```bash
cd apps/desktop && node scripts/verify-asar.js
```

Expected:

```
[verify-asar] /…/apps/desktop/dist/mac-arm64/K12 智学.app/Contents/Resources/app.asar 合格（必需 9 项齐全，无测试文件）
asar 白名单校验通过（1 个包）
```

- [ ] **Step 9: 反向验证「校验脚本真的会红」（别只信绿）**

```bash
cd apps/desktop && node -e "
const { checkEntries } = require('./scripts/verify-asar.js');
const bad = new Set(['main.js','preload.js','server-url.js','package.json','lib/config-file.js','lib/resolve-server-url.js','lib/probe-server.js','lib/shell-state.js','lib/x.test.js']);
const p = checkEntries(bad);
console.log(p);
if (!p.some(x => x.includes('offline.html'))) throw new Error('没报出缺 offline.html —— 校验器失效');
if (!p.some(x => x.includes('测试文件混进包'))) throw new Error('没报出测试文件 —— 校验器失效');
console.log('反向验证通过：校验器确实有牙齿');
"
```

Expected: 打印问题列表 + `反向验证通过：校验器确实有牙齿`

- [ ] **Step 10: 真出一次包，验证更新清单真的产出（spec §8-2 ②）+ 实测 §5 那条待回填的措辞**

```bash
cd apps/desktop
SERVER_URL="$(cd ../.. && node -e "console.log(require('./apps/desktop/server-url.js').SERVER_URL)")"
echo "服务器地址 = $SERVER_URL"
CSC_IDENTITY_AUTO_DISCOVERY=false ./node_modules/.bin/electron-builder --mac \
  --config.publish.provider=generic \
  --config.publish.url="$SERVER_URL/download"
```

Expected: 退出码 0；`dist/` 下出现

- `k12-desktop-0.1.0-arm64.dmg`、`k12-desktop-0.1.0-x64.dmg`（**全 ASCII 名字**）
- `latest-mac.yml`

```bash
cd apps/desktop
ls -1 dist/*.dmg dist/latest*.yml
python3 -c "
import yaml, json
d = yaml.safe_load(open('dist/latest-mac.yml'))
print(json.dumps(d, ensure_ascii=False, indent=2))
"
```

**然后按实际输出二选一走：**

- **情况 A：清单里的 `files[].url` 是相对文件名（预期）** → 说明 spec §5 那句「其中的下载 URL 指向本机服务器地址」**措辞不准**：清单只记相对名，基址来自 publish 配置。此时本步的判据改为两条**可验证**的不变量：① `version` = `0.1.0`；② 清单里的每个 `files[].url` 都能在 `dist/` 里找到同名文件。并在 Task 8 里回填 spec §5 的措辞与 changelog。
- **情况 B：清单里确实含绝对地址** → 则断言它等于 `$SERVER_URL/download` 前缀，spec §5 原文成立，Task 8 不需回填这一条。

```bash
# 两种情况都要跑：清单里的文件名必须真实存在
cd apps/desktop && python3 -c "
import yaml, os, sys
d = yaml.safe_load(open('dist/latest-mac.yml'))
missing = [f['url'] for f in d['files'] if not os.path.exists(os.path.join('dist', f['url']))]
print('version =', d['version'])
print('缺失的产物 =', missing)
sys.exit(1 if missing or d['version'] != '0.1.0' else 0)
" && echo "清单与产物一致 OK"
```

Expected: `version = 0.1.0`、`缺失的产物 = []`、最后打印 `清单与产物一致 OK`

> **这一步的结论（含产物大小、耗时、任何警告）要写进 Task 8 的 changelog** —— 它是全案唯一的真机证据。
> 若 electron-builder 因 `identity: null` 报错，改成只依赖 `CSC_IDENTITY_AUTO_DISCOVERY=false` 环境变量，
> 并把结论回填 spec §4.1 的 yml 片段。

- [ ] **Step 11: 跑一次打包后的壳，验证 userData 与「连不上本地页」（人工，需要屏）**

```bash
open "apps/desktop/dist/mac-arm64/K12 智学.app"
```

Expected（对照 spec §5 人工验收 #4 / #6）：

1. 启动日志有 `[shell] 加载地址: http://192.168.1.5:5173`
2. `ls ~/Library/Application\ Support/k12-desktop/` 是**存在的**，且**没有** `~/Library/Application Support/K12 智学/` 这个目录
3. `Cmd+Opt+I` **打不开** DevTools（`app.isPackaged` 为 true）← 结清 ② spec §5 遗留项
4. 停掉服务器后重启壳 → ≤5 秒出现「暂时连不上学习服务器」本地页

> 这是在**本机**（有屏）验；spec §5 人工验收 #1 要求的是**另一台** mac 装 dmg —— 那一步留在 Task 9。

- [ ] **Step 12: 提交**

```bash
cd /Users/lichao/Downloads/claude/imooc/ai_k12
git add apps/desktop/electron-builder.yml apps/desktop/scripts/ apps/desktop/package.json apps/desktop/package-lock.json
git commit -m "feat(desktop): 打包配置 + asar 白名单校验脚本（含本机出包验证）

- electron-builder.yml：白名单 files（排除 *.test.js）、ASCII artifactName、asar、
  mac x64+arm64 双 dmg、identity:null（不签不公证）、故意不写 publish（地址只留一处真源）
- scripts/verify-asar.js：出包后断言必需 9 项齐全、无测试文件 —— 守住 ② spec §8-9 的
  「漏 pages/offline.html → loadFile 失败 → 无节流紧循环」。用 Node 而非内联 bash 是因为
  mac 的 asar 路径含中文+空格，bash 极易断词
- 钉 electron-builder ^26.15.3 + @electron/asar ^4.3.1（npm 上没有稳定 v27，只有 alpha）
- 本机实测结论见 docs/ai-core-changelog.md（Task 后补）"
```

---

## Task 4: `tools/publish-installer.sh`（spec §4.4）

**Files:**
- Create: `tools/publish-installer.sh`

**Interfaces:**
- Consumes: Task 1 的 `apps/web/public/download/` 忽略规则；`apps/desktop/server-url.js` 的 `SERVER_URL`
- Produces: CLI `bash tools/publish-installer.sh [--no-build] <文件1> [文件2 ...]` —— 用法/参数错误与非空校验失败时退出码 1 并打印 `[publish-installer] [ERROR] …`；成功时把文件拷进 `apps/web/public/download/` 并逐个打印 `<SERVER_URL>/download/<文件名>`

- [ ] **Step 1: 写脚本**

新建 `tools/publish-installer.sh`（**注意：无 emoji**）：

```bash
#!/usr/bin/env bash
#
# 把 PC App 的安装包（与更新清单）发布到本机服务器，并打印下载地址。
#
# 用法：
#   bash tools/publish-installer.sh <文件1> [文件2 ...]
#   bash tools/publish-installer.sh --no-build <文件...>    # 只拷不重建（本地验收用）
#
# 做法：拷进 apps/web/public/download/ 之后重建 web —— `vite build` 会把 public/ 原样拷进
# dist/，所以放进 public/ 的文件能在下次构建后仍然存活（`vite build` 默认清空 dist/，
# 直接往 dist/ 里拷会在下次构建时丢失）。
#
# ⚠️ 副作用（spec §4.4）：第 3 步会**重建并替换 apps/web/dist/**，而本机 :5173 的
#    `vite preview` 正在服务这个目录 —— 也就是这一步会重建线上前端，
#    工作区里未提交的前端改动会被一并构建并对外生效。
#
# 设计见 docs/superpowers/specs/2026-09-27-pc-app-packaging-design.md §4.4
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
WEB_DIR="$ROOT/apps/web"
DEST_DIR="$WEB_DIR/public/download"

log() { printf '[publish-installer] %s\n' "$*"; }
die() { printf '[publish-installer] [ERROR] %s\n' "$*" >&2; exit 1; }

DO_BUILD=1
if [ "${1:-}" = "--no-build" ]; then
  DO_BUILD=0
  shift
fi

[ "$#" -ge 1 ] || die "用法: bash tools/publish-installer.sh [--no-build] <文件1> [文件2 ...]"

# 1) 先全量校验再动手 —— 拷进去一半比不拷更糟（下载目录是个公开的静态目录）
for f in "$@"; do
  [ -f "$f" ] || die "找不到文件: $f"
done

# 2) 拷入 public/（vite build 会把它带进 dist/）
mkdir -p "$DEST_DIR"
for f in "$@"; do
  cp -f "$f" "$DEST_DIR/"
  log "已拷入 $(basename "$f")"
done

# 3) 重建 web
if [ "$DO_BUILD" -eq 1 ]; then
  log "重建 web（会把 public/ 拷进 dist/）…"
  ( cd "$WEB_DIR" && npm run build )
else
  log "跳过重建（--no-build）—— 若 dist/ 里还没有这些文件，浏览器会 404"
fi

# 4) 打印下载地址（地址的唯一真源 = apps/desktop/server-url.js）
SERVER_URL="$(cd "$ROOT" && node -e "console.log(require('./apps/desktop/server-url.js').SERVER_URL)")"
log "下载地址（浏览器打开即可下载）："
for f in "$@"; do
  printf '  %s/download/%s\n' "${SERVER_URL%/}" "$(basename "$f")"
done
```

- [ ] **Step 2: 让脚本可执行**

```bash
chmod +x /Users/lichao/Downloads/claude/imooc/ai_k12/tools/publish-installer.sh
```

（调用方式是 `bash tools/…`，所以这不是必需的；但与 `tools/deploy.sh` / `tools/services.sh` 保持一致。）

- [ ] **Step 3: 负例 1 —— 无参数**

```bash
cd /Users/lichao/Downloads/claude/imooc/ai_k12 && bash tools/publish-installer.sh; echo "exit=$?"
```

Expected:

```
[publish-installer] [ERROR] 用法: bash tools/publish-installer.sh [--no-build] <文件1> [文件2 ...]
exit=1
```

- [ ] **Step 4: 负例 2 —— 文件不存在（必须在拷贝前就拦住）**

```bash
cd /Users/lichao/Downloads/claude/imooc/ai_k12
ls apps/web/public/download/ 2>/dev/null || echo "（目录尚不存在，符合预期）"
bash tools/publish-installer.sh /tmp/不存在的包.dmg; echo "exit=$?"
ls apps/web/public/download/ 2>/dev/null || echo "（仍不存在 —— 校验发生在 mkdir/cp 之前，正确）"
```

Expected: `exit=1`，报 `找不到文件: /tmp/不存在的包.dmg`，且**目录未被创建**（`mkdir` 在校验之后）。

- [ ] **Step 5: 正例（不重建 web，只验路径与地址）**

```bash
cd /Users/lichao/Downloads/claude/imooc/ai_k12
: > /tmp/k12-fake.dmg
: > /tmp/latest.yml
bash tools/publish-installer.sh --no-build /tmp/k12-fake.dmg /tmp/latest.yml
```

Expected:

```
[publish-installer] 已拷入 k12-fake.dmg
[publish-installer] 已拷入 latest.yml
[publish-installer] 跳过重建（--no-build）—— 若 dist/ 里还没有这些文件，浏览器会 404
[publish-installer] 下载地址（浏览器打开即可下载）：
  http://192.168.1.5:5173/download/k12-fake.dmg
  http://192.168.1.5:5173/download/latest.yml
```

> ⚠️ 注意第 2 个地址是 `http://192.168.1.5:5173/download/latest.yml`，正好呼应 spec §9：
> ④ 要的更新清单与安装包**同目录**，所以脚本必须能一次收多个文件（D2 之外的硬要求）。

- [ ] **Step 6: 确认这些文件不会入库（Task 1 的忽略规则真的生效）**

```bash
cd /Users/lichao/Downloads/claude/imooc/ai_k12
git status --short apps/web/public/download/
```

Expected: **无输出**（目录被忽略）。若看到 `?? apps/web/public/download/…`，说明 Task 1 的规则没生效，**回去修**。

- [ ] **Step 7: 清理测试残留**

```bash
cd /Users/lichao/Downloads/claude/imooc/ai_k12
rm -f apps/web/public/download/k12-fake.dmg apps/web/public/download/latest.yml /tmp/k12-fake.dmg /tmp/latest.yml
ls -A apps/web/public/download/ 2>/dev/null; echo "（应为空）"
```

- [ ] **Step 8: 提交**

```bash
cd /Users/lichao/Downloads/claude/imooc/ai_k12
git add tools/publish-installer.sh
git commit -m "feat(tools): publish-installer.sh —— 安装包与更新清单发布到本机服务器 /download/

一次收多个文件（安装包 + latest*.yml），否则 spec §9「更新源已就位」落空。
拷进 apps/web/public/download/ 后重建 web（vite 会把 public/ 拷进 dist/，故不会被清空）。
支持 --no-build（照 services.sh 惯例）便于本地验收，不必每次重建 60s 的 web。"
```

---

## Task 5: 版本/tag 流程与 CI workflow（spec §4.3 / §4.6）

**Files:**
- Create: `.github/workflows/desktop-release.yml`

**Interfaces:**
- Consumes: Task 3 的 `verify:asar` script 与 `electron-builder.yml`；Task 1 的 `.gitignore` 反选
- Produces: tag `desktop-v<version>` 推送后三平台产物 + artifact `k12-desktop-<os>`（内含 dmg/exe/AppImage + `latest*.yml`）

- [ ] **Step 1: 新建 `.github/workflows/desktop-release.yml`**

```yaml
# PC App 三平台打包与分发 —— spec docs/superpowers/specs/2026-09-27-pc-app-packaging-design.md §4.3
#
# ⚠️ 本文件是 YAML：根 .gitignore 有一条全局 `*.yml` 规则，靠里面的反选才进得来。
#    若它没被推上去，本 workflow **永远不会运行，而且不报错**。
#    （apps/desktop/gitignore.guard.test.js 钉着这条。）
name: Desktop Release

on:
  push:
    tags:
      - 'desktop-v*'
  workflow_dispatch:

permissions:
  contents: read

concurrency:
  group: desktop-${{ github.ref }}
  cancel-in-progress: true

env:
  # mac 不签不公证（spec §3-2）。yml 里已写 mac.identity: null，这里再加一道：
  # 免得 runner 上因为找证书而报错，或行为与本机不一致。
  CSC_IDENTITY_AUTO_DISCOVERY: 'false'

jobs:
  build:
    name: build (${{ matrix.os }})
    runs-on: ${{ matrix.os }}
    strategy:
      fail-fast: false
      matrix:
        include:
          - os: macos-14
            platform: --mac
          - os: windows-latest
            platform: --win
          - os: ubuntu-latest
            platform: --linux
    defaults:
      run:
        working-directory: apps/desktop
    steps:
      - uses: actions/checkout@v4

      # node 22 不是被 electron-builder 逼的：稳定 v26 的 engines 只要 node >= 14。
      # 选 22 是为了与仓库其它工具链对齐，并给日后可能升 v27 留余量（spec §4.3 第 2 步）。
      - uses: actions/setup-node@v4
        with:
          node-version: '22'
          cache: npm
          cache-dependency-path: apps/desktop/package-lock.json

      - name: 安装依赖
        run: npm ci

      - name: 版本一致性校验（tag 必须等于 package.json 的 version）
        if: startsWith(github.ref, 'refs/tags/desktop-v')
        shell: bash
        run: |
          set -euo pipefail
          TAG="${GITHUB_REF_NAME#desktop-v}"
          PKG="$(node -p "require('./package.json').version")"
          echo "tag=$TAG  package.json=$PKG"
          if [ "$TAG" != "$PKG" ]; then
            echo "::error::tag（$TAG）与 apps/desktop/package.json 的 version（$PKG）不一致"
            exit 1
          fi

      - name: 测试门禁（全绿才继续）
        run: npm test

      - name: 取服务器地址（唯一真源 = apps/desktop/server-url.js）
        id: server
        shell: bash
        run: |
          set -euo pipefail
          S="$(node -e "console.log(require('./server-url.js').SERVER_URL)")"
          echo "服务器地址 = $S"
          echo "publish_url=$S/download" >> "$GITHUB_OUTPUT"

      - name: 出包
        shell: bash
        run: |
          set -euo pipefail
          ./node_modules/.bin/electron-builder ${{ matrix.platform }} \
            --config.publish.provider=generic \
            --config.publish.url="${{ steps.server.outputs.publish_url }}"

      - name: 产物白名单校验（asar）
        run: npm run verify:asar

      # 只收产物本身，**不收** dist/mac*/ 下的 .app 目录 —— 那条路径含中文与空格。
      - name: 上传产物（安装包 + 更新清单）
        uses: actions/upload-artifact@v4
        with:
          name: k12-desktop-${{ matrix.os }}
          path: |
            apps/desktop/dist/*.dmg
            apps/desktop/dist/*.exe
            apps/desktop/dist/*.AppImage
            apps/desktop/dist/latest*.yml
          if-no-files-found: error
```

- [ ] **Step 2: 校验 YAML 能解析**

```bash
cd /Users/lichao/Downloads/claude/imooc/ai_k12
python3 -c "
import yaml, sys
d = yaml.safe_load(open('.github/workflows/desktop-release.yml'))
j = d['jobs']['build']
print('name =', d['name'])
print('matrix os =', [m['os'] for m in j['strategy']['matrix']['include']])
print('steps =', len(j['steps']))
print('working-directory =', j['defaults']['run']['working-directory'])
print('触发 =', list(d[True] if True in d else d.get('on')))
"
```

Expected:

```
name = Desktop Release
matrix os = ['macos-14', 'windows-latest', 'ubuntu-latest']
steps = 9
working-directory = apps/desktop
触发 = ['push', 'workflow_dispatch']
```

> 注意：YAML 1.1 会把裸 `on:` 解析成布尔 `True`（Python 的已知怪癖），所以上面用 `True in d` 兜了一下 ——
> 这不是文件写错了。

- [ ] **Step 3: 本机复现「版本一致性校验」这段 shell（它是 CI 里最容易写错、又最该早失败的一段）**

```bash
cd /Users/lichao/Downloads/claude/imooc/ai_k12/apps/desktop
GITHUB_REF_NAME=desktop-v0.1.0 bash -c '
  set -euo pipefail
  TAG="${GITHUB_REF_NAME#desktop-v}"
  PKG="$(node -p "require(\"./package.json\").version")"
  echo "tag=$TAG  package.json=$PKG"
  if [ "$TAG" != "$PKG" ]; then echo "不一致（预期之外）"; exit 1; fi
  echo "一致 OK"
'
```

Expected: `tag=0.1.0  package.json=0.1.0` + `一致 OK`

- [ ] **Step 4: 负例 —— 不一致时必须失败**

```bash
cd /Users/lichao/Downloads/claude/imooc/ai_k12/apps/desktop
GITHUB_REF_NAME=desktop-v9.9.9 bash -c '
  set -euo pipefail
  TAG="${GITHUB_REF_NAME#desktop-v}"
  PKG="$(node -p "require(\"./package.json\").version")"
  if [ "$TAG" != "$PKG" ]; then echo "不一致，按预期失败"; exit 1; fi
' ; echo "exit=$?"
```

Expected: 打印 `不一致，按预期失败`，`exit=1`

- [ ] **Step 5: 确认 workflow 真的能被 git 跟踪**

```bash
cd /Users/lichao/Downloads/claude/imooc/ai_k12
git status --short .github/
git check-ignore .github/workflows/desktop-release.yml; echo "check-ignore exit=$? （0=被忽略/坏，1=未被忽略/好）"
```

Expected: `git status` 看到 `?? .github/`（或 `?? .github/workflows/desktop-release.yml`）；`check-ignore` **exit=1**。

> ⚠️ 同样**不要加 `-v`**（理由见 Task 1 Step 6 的注）。

- [ ] **Step 6: 跑全量桌面测试，确认没碰坏**

```bash
cd apps/desktop && npm test
```

Expected: PASS（8 文件 / 52 passed —— Task 1–3 新增了 3 个测试文件共 14 条用例，原 38 条）

- [ ] **Step 7: 提交（**先不推 tag**）**

```bash
cd /Users/lichao/Downloads/claude/imooc/ai_k12
git add .github/workflows/desktop-release.yml
git commit -m "ci(desktop): 三平台出包的 GitHub workflow（测试门禁 + 版本校验 + asar 断言）

matrix = macos-14 / windows-latest / ubuntu-latest；tag desktop-v* 或手动触发。
出包前跑 npm test（红则不出包），出包后用 npm run verify:asar 断言产物内容，
只上传安装包与 latest*.yml（不收含中文空格的 .app 目录）。"
```

> **本步不做的事**：**不推 tag**。推 `desktop-v0.1.0` 会真的触发 CI（消耗 Actions 分钟、
> 产出公开可见的 artifact），属于「对外可见的动作」，留给 Task 7 由你确认后执行。

---

## Task 6: 文档同步（spec §7）

**Files:**
- Modify: `README.md`（PC App 章节；`:24`、`:118`、`:206`）
- Modify: `docs/constraints/pc-app-学习管控.md`（首段 + 服务器地址段）
- Modify: `apps/desktop/server-url.js`（文件头注释）

**Interfaces:**
- Consumes: Task 2–5 的最终行为（命令、路径、指引措辞都必须与实际一致）
- Produces: 面向家长/运维的交付说明 —— 下载地址、mac 首开指引、tag 发版流程、本地开发仍用 `npm start`

> **本任务的核心不是「加」，是「删」**（spec §7 的加粗警告）：③ 让三条旧表述**变成错的**，
> 而它们都是「照着做会更糟」的那种错。

- [ ] **Step 1: 删掉 README 里那句会毁掉救火通路的警告**

先看现状：

```bash
cd /Users/lichao/Downloads/claude/imooc/ai_k12 && grep -n 'productName' README.md
```

Expected:

```
118:- ⚠️ 若 ③ 给应用设了 `productName`，上表中的 `k12-desktop` 会变成那个名字 —— 届时需同步改本表
```

把这**整行删掉**。理由（写进提交信息，别只删）：`userData` 已被 Task 2 显式钉死为 `k12-desktop`，
这句是**假的**；留着它，后来者会照做、把三条救火路径改成 `K12 智学`，从而毁掉「客户端连不上时唯一
的自救手段」（② spec §8-3）。

- [ ] **Step 2: 在 README 的 PC App 章节补三块**

在 `README.md` 的 `### PC App (`apps/desktop`，Electron 壳)` 小节里、`#### 服务器地址（三层优先级）`
之前插入：

````markdown
#### 交付形态：安装包（学生机不需要装 Node）

本地开发才需要上面那三个进程。**发到学生机的是安装包** —— 双击装完就是「K12 智学」应用。

- **从哪下载**：服务器 web 层的 `http://<本机IP>:5173/download/`
  （学生/家长在局域网内直接取，不需要学生机访问公网）
- **怎么产出**：CI 出包（`apps/desktop` 的版本号 = tag 的版本号）

  ```bash
  cd apps/desktop
  # 1) 改 package.json 的 version（例如 0.1.0）
  # 2) 提交后打 tag 并推送 —— 推送即触发三平台出包
  git tag desktop-v0.1.0 && git push origin desktop-v0.1.0
  ```

  推 tag 后到 GitHub 的 Actions 页面看 `Desktop Release`，跑完下载 artifact（需要登录 GitHub）。
  **tag 与 `package.json` 的 version 不一致时 CI 会直接失败**（防版本漂移）。

- **怎么发布到服务器**（把从 artifact 解压出来的文件拷到 web 层的 `/download/`）：

  ```bash
  bash tools/publish-installer.sh <安装包> <latest.yml> [latest-linux.yml ...]
  # 会重建一次 web（几十秒）—— vite 会把 public/ 拷进 dist/，所以文件不会在下次构建时丢
  ```

#### ⚠️ macOS 首次打开：会被 Gatekeeper 拦（未签名）

安装包**没有代码签名、也没有公证**，所以首次打开会被系统拦下。按下面任一条处理后即可正常使用：

```bash
# 推荐：去掉隔离属性（把路径换成实际装的位置）
xattr -dr com.apple.quarantine "/Applications/K12 智学.app"
```

或走界面：**系统设置 → 隐私与安全性 → 仍要打开**。

> ⚠️ **不要按老文章去「右键 → 打开」** —— 自 macOS 15 (Sequoia) 起 Apple **已移除**这条捷径，
> 现在右键打开仍会被拦，甚至提示「已损坏」。这不是文件坏了。

````

- [ ] **Step 3: 修掉 README 里过期的「dev 模式」措辞**

```bash
cd /Users/lichao/Downloads/claude/imooc/ai_k12 && grep -n 'dev 模式\|dev mode' README.md
```

Expected（两条）：

```
24:- `apps/desktop`: Electron shell for PC App (dev mode; loads the **same UI as Web**). 见 [PC App 学习管控设计](...)
206:5. Electron Desktop Integration → **已落地（dev 模式，2026-09-23）**：`apps/desktop` 壳 + kiosk 单次学习锁定，见 [设计文档](...)（安装包/签名/自动更新仍非目标）
```

改法：

- `:24` —— 把 `(dev mode; loads the **same UI as Web**)` 改成 `(loads the **same UI as Web**; 交付形态是安装包，见下文 PC App 章节)`
- `:206` —— 把 `**已落地（dev 模式，2026-09-23）**` 改成 `**已落地（2026-09-23；安装包分发 2026-09-27 落地，签名仍未做）**`，并把句尾的
  `（安装包/签名/自动更新仍非目标）` 改成 `（**签名仍非目标**；自动更新待 ④）`

- [ ] **Step 4: 改 `docs/constraints/pc-app-学习管控.md` 里那条已失效的表述**

```bash
cd /Users/lichao/Downloads/claude/imooc/ai_k12 && grep -n 'productName\|dev 模式' docs/constraints/pc-app-学习管控.md
```

Expected（两条）：

```
7:`apps/desktop`（Electron 壳，**dev 模式**；本期不出安装包）+ 「单次学习锁定」。设计见 ...
（服务器地址段末尾）- `userData` 目录名取 `productName`（若设）否则 `name`。**③ 若设了 `productName`，
  覆盖文件与状态文件的路径都会变，README 里的三条平台路径必须同步改**
```

改法：

- 首段「（Electron 壳，**dev 模式**；本期不出安装包）」→「（Electron 壳；**交付形态是安装包**，见 `docs/superpowers/specs/2026-09-27-pc-app-packaging-design.md`）」
- 那条 `userData` 说明**整条替换**为：

```markdown
- **`userData` 已被显式钉死为 `…/<appData>/k12-desktop`（`main.js` 顶部那行 `app.setPath`）**，
  与 `productName` 无关。⚠️ **别删那行**：删了之后中文 `productName`（`K12 智学`）会决定
  `app.getName()`，覆盖文件与状态文件的路径都会变成「…/K12 智学/」（中文 + 空格），
  README 里那三条平台路径全部失效、救火手段直接没了。有 `user-data.guard.test.js` 钉着。
  （**更正**：本文件早先写「③ 若设了 `productName`，README 的三条路径必须同步改」—— ③ 已用钉死
  的方式解决了，**不要再按原句去改 README**，那样做反而会把文档改错。）
```

- [ ] **Step 5: 在 constraints 里补 ③ 的硬约束（新小节）**

在 `docs/constraints/pc-app-学习管控.md` 末尾追加：

```markdown
## 打包与分发（2026-09-27，③）

来源：`docs/superpowers/specs/2026-09-27-pc-app-packaging-design.md`

- **新增 YAML 必须检查 `.gitignore`**：根 `.gitignore` 有一条**文件级全局规则** `*.yml`，
  会**静默**吃掉本该入库的 YAML（`git add` 不报错、CI 不报错，只有产物缺内容时才暴露）。
  目前靠两条反选放行：`!apps/desktop/electron-builder.yml`、`!.github/workflows/*.yml`
  （`.gitignore` 里另有第三条反选 `!apps/desktop/build/`，那是给旧的 `build/` 规则用的、与 `*.yml` 无关，别混在一起数）。
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
```

- [ ] **Step 6: 删掉 `apps/desktop/server-url.js` 里与实现不符的注释**

现状（第 9 行附近）：

```js
 *   3. 改这一行 + 重新出包（③ 的 CI 用环境变量重写本文件，可产出指向不同服务器的包）
```

改成：

```js
 *   3. 改这一行 + 重新出包（③ 的 CI **不重写本文件**，而是从这里读出地址注入 electron-builder 的
 *      publish 配置与交付文档 —— 地址因此只有这一处真源）
```

- [ ] **Step 7: 确认没有残留的旧表述**

```bash
cd /Users/lichao/Downloads/claude/imooc/ai_k12
echo "=== 应为空（README 里不该再有 productName 警告）==="
grep -n 'productName' README.md || echo OK
echo "=== 应为空（不该再教人右键→打开）==="
grep -n '右键→打开\|右键 -> 打开' README.md || echo OK
echo "=== 应为空（constraints 不该再说路径会随 productName 变）==="
grep -n '必须同步改' docs/constraints/pc-app-学习管控.md || echo OK
echo "=== 应为空（不该再说 dev 模式不出包）==="
grep -n 'dev 模式' README.md docs/constraints/pc-app-学习管控.md apps/desktop/package.json || echo OK
```

Expected: 四条都输出 `OK`。

- [ ] **Step 8: 提交**

```bash
cd /Users/lichao/Downloads/claude/imooc/ai_k12
git add README.md docs/constraints/pc-app-学习管控.md apps/desktop/server-url.js
git commit -m "docs: ③ 的交付说明 + 删除三处已被 ③ 变成错的旧表述

- README：交付形态（安装包/下载路径/tag 流程）、发布脚本用法、mac 首开指引
  （xattr 为主 + 「仍要打开」；说明 macOS 15 起已无「右键→打开」）
- 删掉 README:118「productName 会改本表」整句 —— 钉死 userData 后为假，
  照做会毁掉客户端连不上时唯一的自救手段
- constraints：补 ③ 的硬约束；把「路径随 productName 变」更正为「已钉死，勿删那行」
- server-url.js：注释里「CI 用环境变量重写本文件」与实际（读出后注入 publish）不符"
```

---

## Task 7: 内部文档收尾 + 全量验收（spec §5 / §7）

**Files:**
- Modify: `docs/superpowers/specs/2026-09-26-pc-app-shell-productionization-design.md`（§5 表 + §8-8）
- Modify: `docs/ai-core-changelog.md`
- Modify: `docs/superpowers/specs/2026-09-27-pc-app-packaging-design.md`（按 Task 3 Step 10 的实测回填）

**Interfaces:**
- Consumes: Task 3 的实测结论（清单里有没有绝对地址）、Task 1–6 的全部产物
- Produces: ② spec 的遗留项标为结清；changelog 记下七条实测事实

- [ ] **Step 1: 给 ② spec 打两条注记**

在 `docs/superpowers/specs/2026-09-26-pc-app-shell-productionization-design.md`：

1. §5 的「② 阶段**无法**验证的」表里，「DevTools 真的打不开」那一行末尾追加：
   `—— **已由 ③ 结清**（2026-09-27，见 2026-09-27-pc-app-packaging-design.md §4.7）`
2. §8-8 那条末尾追加更正注记：

```markdown
   > **更正（2026-09-27，③）**：③ **没有**按本条去改 README —— 而是在 `main.js` 里用
   > `app.setPath('userData', …)` 把目录**显式钉死**为 `k12-desktop`，与 `productName` 解耦。
   > 所以 README 那三条平台路径**依然正确**。**不要再按本条原句去同步改 README 的表**，
   > 那会把文档改错（并连带毁掉救火路径）。详见 ③ spec §4.2。
```

- [ ] **Step 2: 按 Task 3 Step 10 的实测结论回填 ③ spec**

- **情况 A（清单只含相对文件名）**：把 §5 自动化的「更新清单产出」一行改为：

```markdown
| 更新清单产出 | win 有 `latest.yml`、linux 有 `latest-linux.yml`。⚠️ **措辞更正（2026-09-27 实测）**：清单里只有**相对文件名**，**不含绝对地址**（基址来自 publish 配置）→ 判据改为「清单存在 + `version` 与 `package.json` 一致 + 每个 `files[].url` 在 `dist/` 里都有同名文件」。④ 接手时注意基址来自 `--config.publish.url` |
```

  同时在 §9 的「更新源已就位」那条补一句：
  `（⚠️ 清单里不含绝对地址，基址由 publish 配置提供 —— ④ 换地址时要同时刷 publish 配置，见 §8-4）`

- **情况 B（清单含绝对地址）**：不改 §5 那一行，改为在 §8 追加一条风险：
  `11. 清单里嵌了绝对地址 → 换服务器地址后，**已发出的清单会指向旧地址**（与 §8-4 同源，④ 必须处理）`

- [ ] **Step 3: 写 changelog**

在 `docs/ai-core-changelog.md` 末尾追加一节（日期用今天）：

```markdown
## 2026-09-27 · PC App 打包与三平台分发（③）

### 实测事实（写代码前先量过的，供以后省一次）

- **npm 上没有稳定版 electron-builder v27**：`dist-tags` = `{ latest: '26.15.3',
  next: '27.0.0-alpha.9', v26: '26.17.0' }`；`npm view electron-builder@27` 直接 404。
  稳定线 **v26** 的 engines 是 `{ node: '>=14.0.0' }`。
  → 早先「主线 v27 / 需 Node ≥22.12 / ESM-only / 对 ia32 快速失败」四条说法**都只对 alpha 成立**，
  已从 spec（③ §1）里删掉。教训：**版本前提必须去 registry 查，不能从文章里抄**
  （那批说法来自一篇 CSDN 汇编文，对着 alpha 写的）。本仓钉 `^26.15.3`。
- **根 `.gitignore` 的 `*.yml` 会静默吃掉新增 YAML**（§4.0）。`git check-ignore -v` 实测命中
  `apps/desktop/electron-builder.yml` 与 `.github/workflows/desktop-release.yml`；
  `git ls-files '*.yml'` 当时是 **0 条**（原有注释「仓库无已跟踪 *.yml，全局忽略安全」已失效）。
  失效模式是**静默**：`git add` 不报错、CI 不报错，只有产物缺资源/缺标识时才暴露。
  已加三条反选 + `gitignore.guard.test.js`（含「探针有牙齿」用例防静默变绿）。
- **`git check-ignore` 的退出码可当判据 —— 但只在「不带 `-v`」时**：
  不带 `-v`：被忽略 0 / 未忽略 1 / **不在 git 仓库 128**。
  **带 `-v` 时，命中反选规则（`!` 开头）也返回 0**（只是把反选行原样打印），
  所以 `-v` 的退出码**不能**当「是否被忽略」的判据 —— 计划初稿就踩了这个坑，
  会让「反选生效」永远测不绿；护栏用例改为「status 0 **且** 命中的不是反选规则」才正确。
  另：`-v` 的 stdout 形如 `文件:行:规则\t路径`，取 tab 前那段判断可避免路径名里的
  `:数字:!` 造成误判。
- **macOS 15 (Sequoia) 起 Apple 移除了「右键→打开」**：未签名应用现在只有
  `xattr -dr com.apple.quarantine` 或「系统设置 → 隐私与安全性 → 仍要打开」。
  原交付文档写「右键→打开」**会让家长卡住甚至看到「已损坏」**，已改。
- **AppImage 在 macOS 上要 docker**：本机 `wine`/`docker`/`podman` 均未安装 →
  spec §8-2 原写「本机真出一次包（如 `--linux`）」**不可执行**，改为本机验 `--mac` +
  `latest-mac.yml`（与 win/linux 走同一段 publish 组装逻辑）。
- `build/icon.png` 是 **1024×1024 RGBA** → mac/win/linux 都能由它生成图标，不需要另备 `.ico`/`.icns`。
- `apps/desktop` 测试共 38 条（`server-url` 2 / `config-file` 13 / `resolve-server-url` 7 /
  `probe-server` 7 / `shell-state` 9）—— 门禁判据写「全绿」，**不写死条数**（会漂移）。
- **[Task 3 Step 10 的结论填这里]**：更新清单 `latest-mac.yml` 的实际内容与是否含绝对地址；
  出包耗时；`identity: null` 是否被 electron-builder 接受；`^26.15.3` 实际解到的版本号。

### 本批改了什么

（列出 Task 1–6 的提交与产物，并记录 spec ③ 的实测回填）

### 文档同步

- `README.md`：补交付形态/下载路径/mac 首开指引；**删掉**「productName 会改本表」整句（钉死 userData 后为假）
- `docs/constraints/pc-app-学习管控.md`：补 ③ 硬约束；把「路径随 productName 变」更正为「已钉死」
- ② spec：§5 的 DevTools 项标注已结清；§8-8 打更正注记（**不要**去改 README 的表）
- `docs/API接口与数据流设计文档.md` + `docs/api/openapi.yaml`：**确认无需变更**（③ 不涉及任何端点）
```

- [ ] **Step 4: 跑全量桌面测试 + 用 CI 的同一段命令自检**

```bash
cd /Users/lichao/Downloads/claude/imooc/ai_k12/apps/desktop && npm test && node scripts/verify-asar.js
```

Expected: 测试全绿；`asar 白名单校验通过（1 个包）`（用的是 Task 3 Step 7 留下的 `--dir` 产物；
若已清理，先重跑 `./node_modules/.bin/electron-builder --mac --dir` 再校验）。

- [ ] **Step 5: 本机把 spec §5 的人工验收表跑一遍（有屏的那几条）**

逐条对照 spec §5「人工验收（真机）」，本机能做的先做掉：

| spec §5 # | 本机怎么做 | 期望 |
|---|---|---|
| 3 | 打开 `dist/mac-arm64/K12 智学.app`，按 `Cmd+Opt+I` | 打不开 DevTools |
| 4 | 看启动日志 + `ls ~/Library/Application\ Support/` | 日志地址正确；只有 `k12-desktop/`，**没有** `K12 智学/` |
| 5 | 在 `~/Library/Application Support/k12-desktop/` 写一个指向错误地址的 `config.json` → 重启 | 走覆盖文件（救火路径在打包后仍然有效） |
| 6 | 停掉服务器后启动壳 | ≤5 秒出现本地页 |

```bash
cd /Users/lichao/Downloads/claude/imooc/ai_k12
ls -d ~/Library/Application\ Support/k12-desktop 2>&1
ls -d ~/Library/Application\ Support/K12\ 智学 2>&1   # 期望：No such file or directory
```

Expected: 第一条存在；第二条报 `No such file or directory` —— **这是「钉死生效」最直接的证据**。

> ⚠️ **不要为了验第 6 条去 kill 用户正在跑的服务**。那要停 :5173；若 `tools/services.sh`
> 正在服务，请**先问**，或另起一个假端口、把 `config.json` 指过去验「连不上」。
> 收尾一律按 PID 对照，**不要 `pkill`**。

- [ ] **Step 6: 提交**

```bash
cd /Users/lichao/Downloads/claude/imooc/ai_k12
git add docs/ai-core-changelog.md \
  docs/superpowers/specs/2026-09-26-pc-app-shell-productionization-design.md \
  docs/superpowers/specs/2026-09-27-pc-app-packaging-design.md
git commit -m "docs: ③ 收尾 —— ② spec 遗留项结清与更正注记 + changelog 七条实测事实

- ② spec §5「DevTools 打不开」标注已结清；§8-8 加更正注记（③ 用钉死 userData 解决，
  不要再按原句去改 README 的三条路径表）
- ③ spec：按 Task 3 Step 10 的实测回填「更新清单」那条措辞
- changelog：electron-builder 无稳定 v27 / .gitignore 的 *.yml 静默陷阱 /
  macOS 15 无「右键→打开」/ AppImage 在 mac 上要 docker / icon 尺寸 / 测试条数
- 确认 API 文档与 openapi.yaml 无需变更（③ 不涉及端点）"
```

---

## 收尾：还剩什么（不在本计划内，属「对外可见」需你决定）

| 项 | 为什么留给用户 |
|---|---|
| **推 `desktop-v0.1.0` tag 触发首次 CI** | 会真的消耗 Actions 分钟、产出公开可见的 artifact；首次跑大概率要按报错迭代，而 `gh` token 已失效 → 得你在浏览器看日志 |
| **在另一台 mac 上装 dmg 过 Gatekeeper**（spec §5 人工验收 #1） | 需要第二台 mac |
| **Windows / Linux 真机安装**（spec §5 #8 / #9） | 需要对应机器 |
| **把产物发布到服务器并浏览器下载**（spec §5 #7 全链路） | 需要先有 CI 产物；且会重建线上 web（替换 `apps/web/dist/`） |
| **Windows 的 NSIS 默认 oneClick 是否符合交付预期**（spec §6-10） | 产品判断（一键装、装到用户目录 `%LOCALAPPDATA%\Programs\`、装完自动启动） |

---

## Self-Review（写完后自查）

### 1. spec 覆盖

| spec 条目 | 落在哪个 Task |
|---|---|
| §2-1 electron-builder 配置 | Task 3 Step 6 |
| §2-2 钉 devDependencies | Task 3 Step 5 |
| §2-3 钉死 userData | Task 2 |
| §2-4 三平台 workflow | Task 5 |
| §2-5 发布到 `/download/` | Task 4 |
| §2-6 更新清单产出 | Task 3 Step 10（实测）+ Task 5 |
| §2-7 交付文档 | Task 6 |
| §2-8 结清 DevTools 待验项 | Task 3 Step 11 + Task 7 Step 5 |
| §2-9 `.gitignore` 反选 | Task 1 |
| §4.0 阻断项 | Task 1 |
| §4.1 yml | Task 3 Step 6 |
| §4.2 userData | Task 2 |
| §4.3 workflow（含第 7 步 asar 断言） | Task 5 + Task 3 |
| §4.4 publish 脚本 | Task 4 |
| §4.5 地址单一真源 | Task 3 Step 10、Task 4 Step 5、Task 5 Step 5 |
| §4.6 版本 / tag 流程 | Task 3 Step 5、Task 5 Step 1、Task 6 Step 2 |
| §4.7 结清 ② 遗留项 | Task 3 Step 11、Task 7 Step 1 |
| §5 自动化验收 | Task 3 Step 8/10、Task 5 Step 2–4、Task 7 Step 4 |
| §5 人工验收 | Task 3 Step 11、Task 6 Step 5、Task 7 Step 5、收尾表 |
| §6 非目标 / 限制写进文档 | Task 6 Step 2/5 |
| §7 文档同步（含「要删的旧表述」） | Task 6 + Task 7 |
| §8-2 本机先验 | Task 3 Step 7–10 |
| §9 交接 ④ | Task 4 Step 5、Task 6 Step 5、Task 7 Step 2 |

### 2. 占位符扫描

无 `TBD` / `TODO` / 「实现细节待定」。每个改代码的步骤都给了**完整文件内容**或完整插入片段。
唯一带条件的是 Task 3 Step 10 与 Task 7 Step 2 的「情况 A / 情况 B」—— 那是**实测分支**，
两支都写明了判据与各自的回填文案，不是待办。

### 3. 类型 / 命名一致性（逐个核对过）

- `verify-asar.js` 导出 `REQUIRED` / `parseAsarList` / `checkEntries` / `findAsarFiles`；
  Task 3 的测试与 CLI 入口用的是同名（未出现第二种叫法）；
- npm script 名 `verify:asar`（Task 3 定义）↔ CI 里的 `npm run verify:asar`（Task 5）一致；
- `MUST_BE_TRACKABLE` / `MUST_BE_IGNORED` 只在 `gitignore.guard.test.js` 内使用，
  其字符串与 Task 6 Step 5 写给运维的路径**逐字相同**；
- 目录名字面量 `k12-desktop` 在 `main.js`（Task 2）、`package.json` 的 `name`、
  护栏断言三处是同一个值；
- `--no-build` 只属 `tools/publish-installer.sh`，未与 `tools/services.sh` 的
  `SERVICES_NO_BUILD` 混用。

### 4. 偏离

见文首「对 spec ③ 的偏离」表（D1–D4）。这 4 条**请在动手前确认** —— 其中 D1（asar 校验脚本化）
与 D2（`--no-build`）是需要改 spec 措辞的，确认后我一并回填 spec。