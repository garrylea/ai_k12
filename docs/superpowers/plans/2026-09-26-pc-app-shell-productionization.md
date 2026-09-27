# PC App 壳生产化（②）实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Spec:** `docs/superpowers/specs/2026-09-26-pc-app-shell-productionization-design.md`（本计划的唯一需求来源；与计划冲突时以 spec 为准）

**Goal:** 让 Electron 壳在真实使用条件下不出洋相 —— 服务器地址有确定来源（三层优先级，含一个手工覆盖文件作救火手段）、连不上时有本地页并自动探测式重连、关掉进程重启后仍进 kiosk、生产构建关掉 DevTools。

**Architecture:** 全部改动落在 `apps/desktop/`。把**纯逻辑**抽成 `lib/*.js`（CommonJS、不 `require('electron')`、路径由调用方传入），使它们能在 Node 下用 vitest 单测；`main.js` 只保留薄封装与副作用（窗口、IPC、定时器）。本地页 `pages/offline.html` 是壳的第一块自有 UI，用纯 HTML + 内联 CSS/JS，不引入 React、不参与 Web 构建。

**Tech Stack:** Electron 44（CommonJS 主进程）、Node 内置 `fs`/`path`/`http`/`https`、vitest 3.2.7（`node` 环境，无配置文件）、`rsvg-convert`（已装，仅用于一次性生成图标）

---

## Global Constraints

逐条都是硬约束，每个任务的要求都隐含包含本节：

- **壳不做业务**；本地页用纯 HTML/CSS/JS，**不引入 React、不参与 `apps/web` 的构建**
- **`apps/desktop/lib/*.js` 必须是 CommonJS**（`module.exports`）且**不 `require('electron')`**、路径由调用方传入 —— 否则无法单测
- **单测里用 `createRequire(import.meta.url)` 引入 lib**，不要写成 `import { x } from '../lib/x.js'` —— Vite 不转换项目内的 CJS 源文件，会报 `module is not defined`
- **所有「读配置/状态」函数绝不抛错**：文件缺失、JSON 损坏、类型不对 → 一律降级为默认值（`null` / `false`）
- **所有「写状态」函数绝不抛错**：失败只 `console.warn`（沿用「写入永不阻断主链路」纪律）
- 壳加载的地址是 **Web 层（`:5173`）**，不是 API（`:3001`）
- 本地页**不显示配置文件路径、不提供任何编辑入口**
- **启动路径不做探测**；探测**只用于重试判定**
- `did-fail-load` 必须**过滤 `isMainFrame`** 并**排除 `ERR_ABORTED`（-3）**
- **不改 `apps/web` 任何代码**；**不改任何 API 端点**
- 不用 emoji；配色沿用 `apps/web/style.md` §2 的 brand（`#ff6b35`）
- `apps/desktop` 的 `npm test` 必须能直接跑通（vitest，`node` 环境，**不需要配置文件**）
- 每个任务末尾都要 commit

---

## File Structure

**新建**

| 文件 | 职责 |
|---|---|
| `apps/desktop/server-url.js` | 服务器地址的**构建时默认值**（唯一写死点） |
| `apps/desktop/lib/resolve-server-url.js` | 三层优先级的纯函数判定 |
| `apps/desktop/lib/config-file.js` | 读 + 校验 `userData/config.json` 的 `serverUrl` |
| `apps/desktop/lib/shell-state.js` | 读 + 写 `userData/shell-state.json` 的 `studentMode` |
| `apps/desktop/lib/probe-server.js` | 探测服务器是否可达（重试用） |
| `apps/desktop/lib/*.test.js`、`apps/desktop/server-url.test.js` | 上述模块的单测 |
| `apps/desktop/pages/offline.html` | 「连不上」本地页 |
| `apps/desktop/build/icon.png` | 应用图标 1024×1024（一次性生成并提交） |

**修改**

| 文件 | 改动 |
|---|---|
| `apps/desktop/main.js` | 地址三层解析、离线页 + 探测式重试、`studentMode` 持久化 + 启动即 kiosk、`devTools` |
| `apps/desktop/preload.js` | 新增 `k12Shell.retryNow()` 单向通道 |
| `apps/desktop/package.json` | 加 `vitest` devDependency 与 `test` script |

**任务依赖（重要）**

- Task 1–5 互相独立，但都必须在 Task 6 之前完成（Task 6 会 require 它们）
- **Task 6 → 7 → 8 → 9 必须按序做**：它们依次改同一个 `main.js`，每一步的「Modify」都以**上一步完成后的 main.js** 为基准。**不要跳序执行。**
- Task 10–13 在代码全部完成后做

---

## Task 1: 测试设施 + 服务器地址写死点

壳现在**没有任何测试设施**。这一步建立它，并落地地址的唯一写死点。

**Files:**
- Create: `apps/desktop/server-url.js`
- Create: `apps/desktop/server-url.test.js`
- Modify: `apps/desktop/package.json`

**Interfaces:**
- Produces: `SERVER_URL: string` —— 由 `server-url.js` `module.exports` 导出；Task 6 会 require 它

- [ ] **Step 1: 装 vitest 并加 test script**

```bash
cd apps/desktop && npm install --save-dev 'vitest@^3.2.7'
```

然后编辑 `apps/desktop/package.json`，在 `scripts` 里加一行 `test`（其余字段不动）：

```json
  "scripts": {
    "start": "electron .",
    "test": "vitest run"
  },
```

- [ ] **Step 2: 写失败的测试**

创建 `apps/desktop/server-url.test.js`：

```js
import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';

// lib 与这些配置文件是 CJS，用 createRequire 引入（Vite 不转换项目内的 CJS 源文件）
const require = createRequire(import.meta.url);
const { SERVER_URL } = require('./server-url.js');

describe('server-url.js：构建时写死点', () => {
  it('是非空字符串', () => {
    expect(typeof SERVER_URL).toBe('string');
    expect(SERVER_URL.trim()).not.toBe('');
  });

  it('以 http(s):// 开头（防止被改成空值后静默退化成相对地址）', () => {
    expect(SERVER_URL).toMatch(/^https?:\/\//);
  });
});
```

- [ ] **Step 3: 跑测试，确认失败**

```bash
cd apps/desktop && npx vitest run server-url.test.js
```

期望：FAIL —— 找不到模块 `./server-url.js`。

- [ ] **Step 4: 写实现**

创建 `apps/desktop/server-url.js`：

```js
'use strict';

/**
 * 服务器地址的**构建时默认值**（spec `2026-09-26-pc-app-shell-productionization-design.md` §4.1）。
 *
 * 这是三层优先级的**兜底一层**。改地址有三条路，从便宜到贵：
 *   1. 临时/dev：启动时设 `K12_WEB_URL` 环境变量
 *   2. 不重装：改 `userData/config.json` 的 `serverUrl`，重启 App（运维最后手段）
 *   3. 改这一行 + 重新出包（③ 的 CI 用环境变量重写本文件，可产出指向不同服务器的包）
 *
 * ⚠️ **地址是 Web 层（vite preview，默认 :5173）的地址，不是 API（Nest，默认 :3001）的地址**
 * —— 学生只认识 Web 层，API 只在服务器本机内网可达（spec §1.2）。
 *
 * ⚠️ 写死地址的前提是**服务器 IP 固定**（DHCP 保留 / 静态 IP）。IP 一变，所有学生机都要
 * 重新出包重装，或逐台改 `userData/config.json`（spec §4.1 ⑤、§6-2）。
 */
module.exports = { SERVER_URL: 'http://192.168.1.5:5173' };
```

- [ ] **Step 5: 跑测试，确认通过**

```bash
cd apps/desktop && npx vitest run server-url.test.js
```

期望：`2 passed`。

- [ ] **Step 6: Commit**

```bash
git add apps/desktop/package.json apps/desktop/package-lock.json apps/desktop/server-url.js apps/desktop/server-url.test.js
git commit -m "feat(desktop): 测试设施（vitest）+ 服务器地址写死点 server-url.js"
```

---

## Task 2: 三层优先级判定

**Files:**
- Create: `apps/desktop/lib/resolve-server-url.js`
- Test: `apps/desktop/lib/resolve-server-url.test.js`

**Interfaces:**
- Produces: `resolveServerUrl(envUrl: string|undefined, fileUrl: string|null, fallback: string): string` —— Task 6 调用

- [ ] **Step 1: 写失败的测试**

创建 `apps/desktop/lib/resolve-server-url.test.js`：

```js
import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { resolveServerUrl } = require('./resolve-server-url.js');

const FALLBACK = 'http://10.0.0.1:5173';

describe('resolveServerUrl：三层优先级', () => {
  it('env 与文件同时有值 → env 胜', () => {
    expect(resolveServerUrl('http://env:1', 'http://file:2', FALLBACK)).toBe('http://env:1');
  });

  it('env 为空串 → 取文件值', () => {
    expect(resolveServerUrl('', 'http://file:2', FALLBACK)).toBe('http://file:2');
  });

  it('env 只有空白 → 视为未提供，取文件值', () => {
    expect(resolveServerUrl('   ', 'http://file:2', FALLBACK)).toBe('http://file:2');
  });

  it('env 未定义 → 取文件值', () => {
    expect(resolveServerUrl(undefined, 'http://file:2', FALLBACK)).toBe('http://file:2');
  });

  it('文件为 null（缺失/非法）→ 取 fallback', () => {
    expect(resolveServerUrl(undefined, null, FALLBACK)).toBe(FALLBACK);
  });

  it('两侧有空白 → 取 trim 后的值', () => {
    expect(resolveServerUrl('  http://env:1  ', null, FALLBACK)).toBe('http://env:1');
  });

  it('env 与文件都为空 → 返回 fallback', () => {
    expect(resolveServerUrl('', null, FALLBACK)).toBe(FALLBACK);
  });
});
```

- [ ] **Step 2: 跑测试，确认失败**

```bash
cd apps/desktop && npx vitest run lib/resolve-server-url.test.js
```

期望：FAIL —— 找不到模块。

- [ ] **Step 3: 写实现**

创建 `apps/desktop/lib/resolve-server-url.js`：

```js
'use strict';

/**
 * 服务器地址的三层优先级判定（spec §4.1 ③）。**纯函数、不 require electron、无副作用** —— 必须可单测。
 *
 * 优先级：`envUrl`（`K12_WEB_URL` 环境变量，dev/临时覆盖）
 *      > `fileUrl`（`userData/config.json` 的 `serverUrl`，运维最后手段）
 *      > `fallback`（`server-url.js` 的构建时默认值）
 *
 * **为什么环境变量排在文件之上**：环境变量是「这一次启动的显式意图」（dev/排障），
 * 文件是持久覆盖。生产环境通常没有该变量，文件即为权威（spec §4.1）。
 *
 * 空白串一律视为「未提供」—— 传 `K12_WEB_URL=` 或写一个只有空格的 `serverUrl`
 * 都不该把地址变成空串（那会让壳去加载一个空的相对地址）。
 *
 * @param {string|undefined} envUrl  `process.env.K12_WEB_URL`
 * @param {string|null} fileUrl      `readServerUrlFromFile()` 的返回值；无覆盖时为 `null`
 * @param {string} fallback          `server-url.js` 的 `SERVER_URL`
 * @returns {string} 去掉首尾空白的最终地址
 */
function resolveServerUrl(envUrl, fileUrl, fallback) {
  const hit = [envUrl, fileUrl].find((v) => typeof v === 'string' && v.trim() !== '');
  return hit !== undefined ? hit.trim() : fallback;
}

module.exports = { resolveServerUrl };
```

- [ ] **Step 4: 跑测试，确认通过**

```bash
cd apps/desktop && npx vitest run lib/resolve-server-url.test.js
```

期望：`7 passed`。

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/lib/resolve-server-url.js apps/desktop/lib/resolve-server-url.test.js
git commit -m "feat(desktop): 服务器地址三层优先级判定（纯函数）"
```

---

## Task 3: 覆盖文件读取与校验

这是「地址变了但客户端无法重装」时唯一的自救通路（spec §4.1 ②、§3-11）。

**Files:**
- Create: `apps/desktop/lib/config-file.js`
- Test: `apps/desktop/lib/config-file.test.js`

**Interfaces:**
- Consumes: 无
- Produces:
  - `readServerUrlFromFile(userDataDir: string): string|null` —— Task 6 调用
  - `CONFIG_FILE_NAME`（常量，值为 `'config.json'`，测试用）

- [ ] **Step 1: 写失败的测试**

创建 `apps/desktop/lib/config-file.test.js`：

```js
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const { readServerUrlFromFile, CONFIG_FILE_NAME } = require('./config-file.js');

let dir;

beforeEach(() => {
  // 用真实临时目录写真实文件来测，不 mock fs（spec §5）
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'k12-config-'));
  // 非法情形都会 warn，静音以免刷屏；用例仍然断言返回值
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(dir, { recursive: true, force: true });
});

const write = (content) =>
  fs.writeFileSync(path.join(dir, CONFIG_FILE_NAME), content, 'utf8');

describe('readServerUrlFromFile', () => {
  it('文件不存在 → null（正常路径，不是异常）', () => {
    expect(readServerUrlFromFile(dir)).toBeNull();
  });

  it('非 JSON → null', () => {
    write('这不是 json');
    expect(readServerUrlFromFile(dir)).toBeNull();
  });

  it('JSON 但顶层是数组 → null', () => {
    write('[]');
    expect(readServerUrlFromFile(dir)).toBeNull();
  });

  it('JSON 但顶层是字符串 → null', () => {
    write('"x"');
    expect(readServerUrlFromFile(dir)).toBeNull();
  });

  it('JSON 但顶层是 null → null', () => {
    write('null');
    expect(readServerUrlFromFile(dir)).toBeNull();
  });

  it('serverUrl 缺失 → null', () => {
    write('{}');
    expect(readServerUrlFromFile(dir)).toBeNull();
  });

  it('serverUrl 非字符串 → null', () => {
    write(JSON.stringify({ serverUrl: 123 }));
    expect(readServerUrlFromFile(dir)).toBeNull();
  });

  it('serverUrl 是空白串 → null', () => {
    write(JSON.stringify({ serverUrl: '   ' }));
    expect(readServerUrlFromFile(dir)).toBeNull();
  });

  it('serverUrl 不是 http(s) → null', () => {
    write(JSON.stringify({ serverUrl: 'ftp://example.com/a' }));
    expect(readServerUrlFromFile(dir)).toBeNull();
  });

  it('serverUrl 不可解析 → null', () => {
    write(JSON.stringify({ serverUrl: 'not a url' }));
    expect(readServerUrlFromFile(dir)).toBeNull();
  });

  it('合法 http 值 → 返回 trim 后的值', () => {
    write(JSON.stringify({ serverUrl: '  http://192.168.1.5:5173  ' }));
    expect(readServerUrlFromFile(dir)).toBe('http://192.168.1.5:5173');
  });

  it('合法 https 值也接受', () => {
    write(JSON.stringify({ serverUrl: 'https://learn.example.com' }));
    expect(readServerUrlFromFile(dir)).toBe('https://learn.example.com');
  });

  it('忽略其它无关字段', () => {
    write(JSON.stringify({ 别的: 1, serverUrl: 'http://a:1' }));
    expect(readServerUrlFromFile(dir)).toBe('http://a:1');
  });
});
```

- [ ] **Step 2: 跑测试，确认失败**

```bash
cd apps/desktop && npx vitest run lib/config-file.test.js
```

期望：FAIL —— 找不到模块。

- [ ] **Step 3: 写实现**

创建 `apps/desktop/lib/config-file.js`：

```js
'use strict';

const fs = require('node:fs');
const path = require('node:path');

/** 覆盖文件名。放在 `app.getPath('userData')` 下（跨平台普通用户可写）。 */
const CONFIG_FILE_NAME = 'config.json';

/**
 * 读 `userData/config.json` 的 `serverUrl`（spec §4.1 ②）。
 *
 * **纯 Node，不 require electron** —— userData 路径由调用方传入，所以能单测。
 *
 * **任何异常/非法情形一律返回 `null`（= 无覆盖），绝不抛错**：
 * 一个手抖写坏的文件**不该比没有文件更糟** —— 学生机一旦卡在启动就彻底不可用了
 * （spec §4.1 ② 的设计取舍）。
 *
 * 注意文件解析出的地址**只做 http(s) 校验，不做可达性校验**：可达性由重试时的
 * 探测负责（`lib/probe-server.js`），启动时不做探测（spec §3-5）。
 *
 * @param {string} userDataDir `app.getPath('userData')`
 * @returns {string|null} 去掉首尾空白的合法地址；无覆盖/非法时为 `null`
 */
function readServerUrlFromFile(userDataDir) {
  const file = path.join(userDataDir, CONFIG_FILE_NAME);

  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch {
    return null; // 文件不存在是正常路径，不打 warn
  }

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    console.warn(`[shell] ${CONFIG_FILE_NAME} 不是合法 JSON，忽略该覆盖`);
    return null;
  }

  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    console.warn(`[shell] ${CONFIG_FILE_NAME} 顶层不是对象，忽略该覆盖`);
    return null;
  }

  const value = parsed.serverUrl;
  if (typeof value !== 'string' || value.trim() === '') {
    console.warn(`[shell] ${CONFIG_FILE_NAME} 的 serverUrl 不是非空字符串，忽略该覆盖`);
    return null;
  }

  const trimmed = value.trim();

  let url;
  try {
    url = new URL(trimmed);
  } catch {
    console.warn(`[shell] ${CONFIG_FILE_NAME} 的 serverUrl 不是可解析的 URL，忽略该覆盖`);
    return null;
  }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    console.warn(`[shell] ${CONFIG_FILE_NAME} 的 serverUrl 不是 http(s)，忽略该覆盖`);
    return null;
  }

  return trimmed;
}

module.exports = { readServerUrlFromFile, CONFIG_FILE_NAME };
```

- [ ] **Step 4: 跑测试，确认通过**

```bash
cd apps/desktop && npx vitest run lib/config-file.test.js
```

期望：`13 passed`。

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/lib/config-file.js apps/desktop/lib/config-file.test.js
git commit -m "feat(desktop): userData/config.json 覆盖地址的读取与降级校验"
```

---

## Task 4: 学生模式状态持久化（补洞的存储层）

**Files:**
- Create: `apps/desktop/lib/shell-state.js`
- Test: `apps/desktop/lib/shell-state.test.js`

**Interfaces:**
- Produces:
  - `readStudentMode(userDataDir: string): boolean` —— Task 8 调用
  - `writeStudentMode(userDataDir: string, on: boolean): void` —— Task 8 调用
  - `STATE_FILE_NAME`（常量，值为 `'shell-state.json'`，测试用）

- [ ] **Step 1: 写失败的测试**

创建 `apps/desktop/lib/shell-state.test.js`：

```js
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const { readStudentMode, writeStudentMode, STATE_FILE_NAME } = require('./shell-state.js');

let dir;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'k12-state-'));
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('readStudentMode', () => {
  it('无文件 → false', () => {
    expect(readStudentMode(dir)).toBe(false);
  });

  it('写入 true 后读回 true', () => {
    writeStudentMode(dir, true);
    expect(readStudentMode(dir)).toBe(true);
  });

  it('写入 false 后读回 false', () => {
    writeStudentMode(dir, true);
    writeStudentMode(dir, false);
    expect(readStudentMode(dir)).toBe(false);
  });

  it('JSON 损坏 → false（坏数据不该把家长锁在 kiosk 里）', () => {
    fs.writeFileSync(path.join(dir, STATE_FILE_NAME), '{oops', 'utf8');
    expect(readStudentMode(dir)).toBe(false);
  });

  it('顶层是数组 → false', () => {
    fs.writeFileSync(path.join(dir, STATE_FILE_NAME), '[true]', 'utf8');
    expect(readStudentMode(dir)).toBe(false);
  });

  it('顶层是 null → false', () => {
    fs.writeFileSync(path.join(dir, STATE_FILE_NAME), 'null', 'utf8');
    expect(readStudentMode(dir)).toBe(false);
  });

  it('studentMode 非布尔（如 "yes"）→ false', () => {
    fs.writeFileSync(
      path.join(dir, STATE_FILE_NAME),
      JSON.stringify({ studentMode: 'yes' }),
      'utf8',
    );
    expect(readStudentMode(dir)).toBe(false);
  });
});

describe('writeStudentMode', () => {
  it('目录不存在时自动建目录，不抛错，且能读回', () => {
    const missing = path.join(dir, 'nested', 'deep');
    expect(() => writeStudentMode(missing, true)).not.toThrow();
    expect(readStudentMode(missing)).toBe(true);
  });

  it('非布尔入参被强制成布尔：落盘的是布尔，不是原始值', () => {
    writeStudentMode(dir, 'yes');
    const raw = JSON.parse(fs.readFileSync(path.join(dir, STATE_FILE_NAME), 'utf8'));
    // Boolean('yes') === true —— 这里是**类型强制**，不是「把真值丢掉」。
    // 断言用 toBe（严格同一）才能同时钉住「值是 true」与「类型是 boolean」：
    // 若实现写成 JSON.stringify({ studentMode: on })，落盘会是字符串 'yes'，此断言即红。
    expect(raw.studentMode).toBe(true);
  });
});
```

- [ ] **Step 2: 跑测试，确认失败**

```bash
cd apps/desktop && npx vitest run lib/shell-state.test.js
```

期望：FAIL —— 找不到模块。

- [ ] **Step 3: 写实现**

创建 `apps/desktop/lib/shell-state.js`：

```js
'use strict';

const fs = require('node:fs');
const path = require('node:path');

/**
 * 学生模式的持久化状态文件名。放在 `app.getPath('userData')` 下。
 *
 * ⚠️ 这是**壳自己的内部状态**，不是给用户编辑的配置（那是 `config.json`）。
 * 文件名特意与 `config.json` 分开，避免有人把内部状态当配置改。
 */
const STATE_FILE_NAME = 'shell-state.json';

/**
 * 读上一次的学生模式（spec §1.4 / §4.3）。
 *
 * **为什么要持久化**：kiosk 由页面里的渲染层经 IPC 驱动，而**离线时页面根本加载不出来**
 * → 渲染层不执行 → `studentMode` 恒为 false → 窗口不是 kiosk → 学生只要
 * 「关掉 Wi-Fi + 杀进程 + 重启」就能逃逸。启动时把上次的状态读回来即可封住这条路
 * （spec §1.4）。
 *
 * **任何异常/损坏一律 `false`** —— 坏数据不该把家长锁在 kiosk 里（spec §4.3）。
 * 「偏向不锁」在这里是安全的：真实的锁定状态另有 localStorage 与家长端两条来源，
 * 这里只是决定**窗口要不要一开机就全屏**。
 *
 * @param {string} userDataDir `app.getPath('userData')`
 * @returns {boolean}
 */
function readStudentMode(userDataDir) {
  try {
    const raw = fs.readFileSync(path.join(userDataDir, STATE_FILE_NAME), 'utf8');
    const parsed = JSON.parse(raw);
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return false;
    return parsed.studentMode === true;
  } catch {
    return false;
  }
}

/**
 * 写学生模式。**失败只 warn、绝不抛**（沿用「写入永不阻断主链路」的既有纪律，spec §4.3）。
 *
 * 用同步写：调用点在 IPC 事件里，频率极低（学生登录/登出各一次），不值得为它引异步竞态。
 *
 * @param {string} userDataDir `app.getPath('userData')`
 * @param {boolean} on
 */
function writeStudentMode(userDataDir, on) {
  try {
    fs.mkdirSync(userDataDir, { recursive: true });
    fs.writeFileSync(
      path.join(userDataDir, STATE_FILE_NAME),
      JSON.stringify({ studentMode: Boolean(on) }),
      'utf8',
    );
  } catch (err) {
    console.warn(`[shell] 写 ${STATE_FILE_NAME} 失败（已忽略）：${err && err.message}`);
  }
}

module.exports = { readStudentMode, writeStudentMode, STATE_FILE_NAME };
```

- [ ] **Step 4: 跑测试，确认通过**

```bash
cd apps/desktop && npx vitest run lib/shell-state.test.js
```

期望：`9 passed`。

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/lib/shell-state.js apps/desktop/lib/shell-state.test.js
git commit -m "feat(desktop): 学生模式状态的持久化存储层（补断网重启逃逸的前提）"
```

---

## Task 5: 服务器可达性探测

这是「探测式重试」的判定器（spec §4.2 的修正）。**必须有它**：不能每 5 秒无脑 `loadURL`，否则 Chromium 会用它的错误页替换掉本地页。

**Files:**
- Create: `apps/desktop/lib/probe-server.js`
- Test: `apps/desktop/lib/probe-server.test.js`

**Interfaces:**
- Produces: `probeServer(url: string, timeoutMs: number): Promise<boolean>` —— Task 7 调用

- [ ] **Step 1: 写失败的测试**

创建 `apps/desktop/lib/probe-server.test.js`：

```js
import { describe, it, expect, afterEach } from 'vitest';
import { createRequire } from 'node:module';
import http from 'node:http';

const require = createRequire(import.meta.url);
const { probeServer } = require('./probe-server.js');

/** 用例里起的 server，afterEach 统一关闭。 */
const servers = [];

/** 起一个监听随机端口的本地 server，返回它的 base url。 */
function listen(handler) {
  return new Promise((resolve) => {
    const server = http.createServer(handler);
    server.listen(0, '127.0.0.1', () => {
      servers.push(server);
      resolve(`http://127.0.0.1:${server.address().port}`);
    });
  });
}

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map((s) => new Promise((r) => s.close(r))),
  );
});

describe('probeServer', () => {
  it('服务器在（200）→ true', async () => {
    const url = await listen((_req, res) => {
      res.writeHead(200);
      res.end('ok');
    });
    expect(await probeServer(url, 1000)).toBe(true);
  });

  it('404 也算可达 → true（要判断的是「连不连得上」，不是「路径对不对」）', async () => {
    const url = await listen((_req, res) => {
      res.writeHead(404);
      res.end();
    });
    expect(await probeServer(url, 1000)).toBe(true);
  });

  it('500 也算可达 → true', async () => {
    const url = await listen((_req, res) => {
      res.writeHead(500);
      res.end();
    });
    expect(await probeServer(url, 1000)).toBe(true);
  });

  it('端口没人监听 → false', async () => {
    const server = http.createServer();
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const port = server.address().port;
    await new Promise((r) => server.close(r));
    expect(await probeServer(`http://127.0.0.1:${port}`, 1000)).toBe(false);
  });

  it('URL 不可解析 → false', async () => {
    expect(await probeServer('not a url', 1000)).toBe(false);
  });

  it('连上了但永不响应 + 短超时 → false', async () => {
    const url = await listen(() => {
      /* 故意不响应 */
    });
    expect(await probeServer(url, 300)).toBe(false);
  });
});
```

- [ ] **Step 2: 跑测试，确认失败**

```bash
cd apps/desktop && npx vitest run lib/probe-server.test.js
```

期望：FAIL —— 找不到模块。

- [ ] **Step 3: 写实现**

创建 `apps/desktop/lib/probe-server.js`：

```js
'use strict';

const http = require('node:http');
const https = require('node:https');

/**
 * 探测服务器是否可达。**纯 Node、不 require electron**，返回 Promise\<boolean\>。
 *
 * **只用于「连不上」时的重试判定**（spec §4.2）：只有它返回 `true` 才允许 `loadURL`。
 *
 * ⚠️ **不能把它退化成「每 5 秒无脑 loadURL」**：主 frame 导航失败时，Chromium 会用
 * **它自己的错误页替换掉我们的本地页**（`ERR_CONNECTION_REFUSED` 在提交前就失败，
 * 文档已被替换）。那样本地页只会出现一次，之后永久变成「无法访问此网站」。
 *
 * **任何 HTTP 响应（含 4xx/5xx）都算「可达」**：要判断的是「连不连得上」，
 * 不是「这个路径对不对」—— 服务在但路径 404 时，页面本来就加载得出来。
 * 只有**连接失败**（ECONNREFUSED / DNS 失败等）与**超时**才返回 `false`。
 *
 * @param {string} url 形如 `http://192.168.1.5:5173`
 * @param {number} timeoutMs 超时毫秒数（spec 定 3000）
 * @returns {Promise<boolean>}
 */
function probeServer(url, timeoutMs) {
  return new Promise((resolve) => {
    let target;
    try {
      target = new URL(url);
    } catch {
      resolve(false);
      return;
    }

    const mod = target.protocol === 'https:' ? https : http;

    // 超时与 error 可能都触发，用 settled 保证只 resolve 一次
    let settled = false;
    const done = (ok) => {
      if (settled) return;
      settled = true;
      resolve(ok);
    };

    const req = mod.request(
      {
        method: 'GET',
        hostname: target.hostname,
        port: target.port || (target.protocol === 'https:' ? 443 : 80),
        path: target.pathname || '/',
        timeout: timeoutMs,
      },
      (res) => {
        res.resume(); // 丢弃 body，尽早释放 socket
        done(true);
      },
    );

    req.on('timeout', () => {
      req.destroy();
      done(false);
    });
    req.on('error', () => done(false));
    req.end();
  });
}

module.exports = { probeServer };
```

- [ ] **Step 4: 跑测试，确认通过**

```bash
cd apps/desktop && npx vitest run lib/probe-server.test.js
```

期望：`6 passed`。

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/lib/probe-server.js apps/desktop/lib/probe-server.test.js
git commit -m "feat(desktop): 服务器可达性探测（探测式重试的判定器）"
```

---

## Task 6: `main.js` 接入三层地址来源

**前置：Task 1–5 全部完成。**

**Files:**
- Modify: `apps/desktop/main.js`
- Test: 人工验证（`main.js` 是 Electron 主进程入口，不可单测 —— 纯逻辑已在 Task 1–5 覆盖）

**Interfaces:**
- Consumes: `SERVER_URL`（Task 1）、`resolveServerUrl`（Task 2）、`readServerUrlFromFile`（Task 3）
- Produces: 模块级 `let WEB_URL` —— Task 7 与既有 `isSameOrigin()` 都用它

- [ ] **Step 1: 加 require**

把 `main.js` 顶部的这两行：

```js
const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('node:path');
```

替换为：

```js
const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('node:path');
const { SERVER_URL } = require('./server-url.js');
const { readServerUrlFromFile } = require('./lib/config-file.js');
const { resolveServerUrl } = require('./lib/resolve-server-url.js');
```

- [ ] **Step 2: 把 WEB_URL 改成延迟解析**

把这一整段（含它上面的注释块）：

```js
/**
 * 壳加载的 Web 地址。本期默认本地 vite dev（`http://localhost:5173`——它已在服务端
 * CORS 白名单里，故本期零 CORS 改动）。
 *
 * `K12_WEB_URL` 就是**云端接缝**：下一期把后端部署到公网后改这个环境变量即可，
 * 不需要改代码。云端接入所需的 CORS / HTTPS / 持久化存储**不在本期范围**。
 */
const WEB_URL = process.env.K12_WEB_URL || 'http://localhost:5173';
```

替换为：

```js
/**
 * 壳加载的 Web 地址（spec §4.1）。**三层优先级**：
 *   `K12_WEB_URL` 环境变量（dev/临时） > `userData/config.json` 的 `serverUrl`
 *   （运维最后手段） > `server-url.js` 的构建时默认值。
 *
 * 这里是 Web 层（vite preview，默认 :5173）的地址，不是 API（Nest，默认 :3001）的
 * —— 学生只认识 Web 层。
 *
 * **必须是 `let` 且延迟到 `app.whenReady()` 之后再赋值**：解析要用 `app.getPath('userData')`。
 */
let WEB_URL = null;
```

- [ ] **Step 3: 在 whenReady 里解析**

把：

```js
app.whenReady().then(() => {
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});
```

替换为：

```js
app.whenReady().then(() => {
  WEB_URL = resolveServerUrl(
    process.env.K12_WEB_URL,
    readServerUrlFromFile(app.getPath('userData')),
    SERVER_URL,
  );
  // 打一行日志：排障时一眼看出壳到底在连哪个地址（人工冒烟 #14/#16 靠它验证）
  console.log(`[shell] 加载地址: ${WEB_URL}`);

  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});
```

- [ ] **Step 4: 人工验证三条优先级**

先确认 web 服务在跑：

```bash
cd /Users/lichao/Downloads/claude/imooc/ai_k12 && bash tools/services.sh status
```

若未运行：`bash tools/services.sh start`（会先构建）。然后：

```bash
cd apps/desktop
# ① 无 env、无 config.json → 用 server-url.js 的默认值
node -e "console.log(require('./server-url.js').SERVER_URL)"
npm start   # 控制台应打印「[shell] 加载地址: http://192.168.1.5:5173」
```

（`npm start` 会打开窗口；看到登录页即算通过，然后关掉窗口。）

```bash
# ② 放一个覆盖文件，指到错误地址
UD="$HOME/Library/Application Support/k12-desktop"
mkdir -p "$UD" && echo '{"serverUrl":"http://127.0.0.1:9"}' > "$UD/config.json"
npm start   # 期望打印「[shell] 加载地址: http://127.0.0.1:9」，窗口连不上（此时还没有本地页，见 Task 7）

# ③ env 应压过文件
K12_WEB_URL=http://192.168.1.5:5173 npm start
# 期望打印「[shell] 加载地址: http://192.168.1.5:5173」

# 清理
rm -f "$UD/config.json"
```

期望：三次打印的地址分别与「默认值 / 覆盖文件 / 环境变量」一致。

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/main.js
git commit -m "feat(desktop): 壳接入地址三层来源（env > config.json > 写死默认值）"
```

---

## Task 7: 「连不上」本地页 + 探测式重试

**这是本计划最容易做错的一步。** 重试**必须**「先探测、再导航」，理由见 spec §4.2 修正与 §8-7。

**Files:**
- Create: `apps/desktop/pages/offline.html`
- Modify: `apps/desktop/main.js`
- Modify: `apps/desktop/preload.js`
- Test: 人工验证（窗口与导航事件不可单测）

**Interfaces:**
- Consumes: `probeServer`（Task 5）、`WEB_URL`（Task 6）
- Produces:
  - `main.js` 内部：`tryReconnect()` / `startRetry()` / `stopRetry()` / `showOfflinePage()`
  - IPC 通道：`shell:retry-now`
  - 渲染层全局：`window.k12Shell.retryNow()`

- [ ] **Step 1: 扩展 preload，加单向重试通道**

把 `apps/desktop/preload.js` 的**最后一行**：

```js
contextBridge.exposeInMainWorld('k12Desktop', {
  setStudentMode: (on) => ipcRenderer.send('kiosk:set-student-mode', Boolean(on)),
  isDesktop: true,
});
```

替换为下面这段（**原有注释块保留不动**，只把末两行换成三行 + 新增一段说明）：

```js
contextBridge.exposeInMainWorld('k12Desktop', {
  setStudentMode: (on) => ipcRenderer.send('kiosk:set-student-mode', Boolean(on)),
  isDesktop: true,
});

/**
 * 本地页（`pages/offline.html`）用的桥，只有一件事：点「立即重试」时通知主进程
 * 立刻探测一次（spec §4.2）。
 *
 * 它**是无参数、无返回的单向 send**，唯一效果是「再试一次加载连接」——远端页面即使
 * 拿到它也做不了任何越权的事。因此它不违反上面那条「不要加 invoke / fs」的约束。
 */
contextBridge.exposeInMainWorld('k12Shell', {
  retryNow: () => ipcRenderer.send('shell:retry-now'),
});
```

- [ ] **Step 2: 写本地页**

创建目录与文件 `apps/desktop/pages/offline.html`：

```html
<!doctype html>
<html lang="zh-CN">
  <head>
    <meta charset="utf-8" />
    <!-- 本地页不加载任何外部资源；内联脚本/样式需要显式放行 -->
    <meta
      http-equiv="Content-Security-Policy"
      content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'"
    />
    <title>K12 智学系统</title>
    <style>
      :root {
        --brand: #ff6b35;
        --ink: #1f2328;
        --muted: #6b7280;
      }
      * {
        box-sizing: border-box;
      }
      body {
        margin: 0;
        min-height: 100vh;
        display: flex;
        align-items: center;
        justify-content: center;
        background: #f7f8fa;
        color: var(--ink);
        font-family: -apple-system, BlinkMacSystemFont, 'PingFang SC', 'Microsoft YaHei', sans-serif;
      }
      main {
        width: 420px;
        max-width: 90vw;
        padding: 32px 28px;
        text-align: center;
        background: #fff;
        border-radius: 16px;
        box-shadow: 0 1px 3px rgba(0, 0, 0, 0.06), 0 8px 24px rgba(0, 0, 0, 0.06);
      }
      .spinner {
        width: 44px;
        height: 44px;
        margin: 0 auto 18px;
        border: 3px solid var(--brand);
        border-top-color: transparent;
        border-radius: 50%;
        animation: spin 1s linear infinite;
      }
      @keyframes spin {
        to {
          transform: rotate(360deg);
        }
      }
      h1 {
        margin: 0 0 8px;
        font-size: 17px;
        font-weight: 600;
      }
      p {
        margin: 0 0 6px;
        font-size: 13px;
        line-height: 1.7;
        color: var(--muted);
      }
      button {
        margin-top: 20px;
        padding: 9px 22px;
        font-family: inherit;
        font-size: 14px;
        color: #fff;
        background: var(--brand);
        border: 0;
        border-radius: 8px;
        cursor: pointer;
      }
      button:hover {
        filter: brightness(1.05);
      }
      .addr {
        margin-top: 14px;
        font-size: 12px;
        color: var(--muted);
        word-break: break-all;
      }
    </style>
  </head>
  <body>
    <main>
      <div class="spinner" role="img" aria-label="正在重试"></div>
      <h1>暂时连不上学习服务器，正在重试…</h1>
      <p>如果一直连不上，请联系家长。</p>
      <button id="retry" type="button">立即重试</button>
      <!-- 当前地址由主进程经 loadFile 的 query 传入，便于家长/运营报障时定位。
           ⚠️ 这里**不显示配置文件路径、不提供任何编辑入口**（spec §3-12） -->
      <p class="addr" id="addr"></p>
    </main>
    <script>
      const params = new URLSearchParams(location.search);
      document.getElementById('addr').textContent = params.get('url') || '';
      document.getElementById('retry').addEventListener('click', () => {
        // 主进程走同一条「先探测、再导航」的路径；探测不通时页面不会有任何变化
        window.k12Shell?.retryNow?.();
      });
    </script>
  </body>
</html>
```

- [ ] **Step 3: main.js 加 require 与重试状态/函数**

在 `main.js` 的 require 区（Task 6 之后的样子）末尾追加一行：

```js
const { probeServer } = require('./lib/probe-server.js');
```

在 `let WEB_URL = null;` 这一行（连同它上面的注释块）**之后**、`function isSameOrigin(...)` **之前**追加：

```js
/** 重试定时器（null = 未在重试）。 */
let retryTimer = null;
/** 探测进行中标记：3 秒超时与 5 秒间隔会叠加，必须防并发探测。 */
let probing = false;

/** 重试间隔与探测超时（spec §4.2）。 */
const RETRY_INTERVAL_MS = 5000;
const PROBE_TIMEOUT_MS = 3000;

/**
 * 探测式重连：**只有探测通了才导航**（spec §4.2 的修正）。
 *
 * ⚠️ **不要改成「每 5 秒无脑 `loadURL`」**：主 frame 导航失败时 Chromium 会用
 * **它自己的错误页替换掉我们的本地页**，那样本地页只出现一次、之后永久变成
 * 「无法访问此网站」；而「已在本地页就不再 loadFile」的防闪烁写法会让它再也回不来。
 */
async function tryReconnect() {
  if (!win || win.isDestroyed() || probing) return;
  probing = true;
  try {
    if (await probeServer(WEB_URL, PROBE_TIMEOUT_MS)) {
      // 通了就停表，把控制权交回正常加载；若这次加载仍失败，
      // did-fail-load 会重新起表，不会死循环。
      stopRetry();
      if (win && !win.isDestroyed()) win.loadURL(WEB_URL);
    }
  } finally {
    probing = false;
  }
}

function startRetry() {
  if (retryTimer) return;
  retryTimer = setInterval(() => {
    void tryReconnect();
  }, RETRY_INTERVAL_MS);
}

function stopRetry() {
  if (retryTimer) {
    clearInterval(retryTimer);
    retryTimer = null;
  }
}

/**
 * 显示本地页。当前地址经 `loadFile` 的 query 传入，本地页从 `location.search` 读
 * —— 不为此新增 IPC 通道（spec §4.2）。
 */
function showOfflinePage() {
  if (!win || win.isDestroyed()) return;
  win.loadFile(path.join(__dirname, 'pages', 'offline.html'), {
    query: { url: WEB_URL },
  });
}
```

- [ ] **Step 4: main.js 挂上导航事件**

在 `createWindow()` 里（**注意：`tryReconnect()` 里也有一处 `win.loadURL(WEB_URL)`，但那行带 `if (…)` 前缀，与本行的两空格缩进不同 —— 别改错**），把这一行：

```js
  win.loadURL(WEB_URL);
```

替换为：

```js
  win.loadURL(WEB_URL);

  // 连不上 → 本地页 + 探测式重试（spec §4.2）
  win.webContents.on('did-fail-load', (_event, errorCode, _errorDescription, _url, isMainFrame) => {
    if (!isMainFrame) return; // 子资源（图片/CSS）失败不算「连不上」
    if (errorCode === -3) return; // ERR_ABORTED：导航被取消，页面并未失败
    showOfflinePage();
    startRetry();
  });

  win.webContents.on('did-finish-load', () => {
    if (!win || win.isDestroyed()) return;
    // 主 frame 加载完成且当前不是本地页（file:）→ 说明连上了，停表
    if (!win.webContents.getURL().startsWith('file:')) stopRetry();
  });
```

- [ ] **Step 4b: 在窗口 `closed` 时清掉重试表（2026-09-27 补）**

`createWindow()` 里原本就有的 `closed` 处理器只置空了 `win`，没管重试表 —— 于是窗口关掉后
interval 会一直每 5 秒空转一次（被 `tryReconnect()` 的 `!win` 早退挡掉，无害，但没必要）。

⚠️ 这**不是**功能修复：重建窗口后自动重连本来就能工作（`setInterval` 的回调读的是**模块级** `win`，
不是捕获的旧窗口，所以 `activate` 建了新窗之后，旧表的下一次 tick 就会作用于新窗）。
改这一段只是因为表不该活得比它的窗口长。

把 `createWindow()` 里这段：

```js
  win.on('closed', () => {
    win = null;
  });
```

替换为：

```js
  win.on('closed', () => {
    // 窗口没了就把重试表停掉，别留一个每 5 秒空转（被 `!win` 挡掉）的定时器。
    // 注意：这**不是**功能修复 —— 重建窗口后自动重连本来就能工作（interval 回调读的是
    // 模块级 `win`，不是捕获的旧窗口）。新窗口加载失败时 did-fail-load 会自己重新起表。
    stopRetry();
    win = null;
  });
```

- [ ] **Step 5: main.js 加「立即重试」的 IPC**

在既有的 `ipcMain.on('kiosk:set-student-mode', ...)` 附近追加：

```js
// 本地页「立即重试」→ 走同一条探测路径（单向通道，spec §4.2）
ipcMain.on('shell:retry-now', () => {
  void tryReconnect();
});
```

- [ ] **Step 6: 人工验证（spec §5 冒烟 #2–#6）**

```bash
cd /Users/lichao/Downloads/claude/imooc/ai_k12
bash tools/services.sh status     # 记下 web 是否在跑
bash tools/services.sh stop       # 关掉 web + server
```

```bash
cd apps/desktop && npm start
```

逐条核对：

| 冒烟 # | 操作 | 期望 |
|---|---|---|
| 2 | 观察窗口 | 显示**本地页**（「暂时连不上学习服务器，正在重试…」+ 按钮 + 地址） |
| 3 | 等 **20 秒以上** | 本地页**始终在**、文案与按钮不变；**绝不出现 Chromium 的「无法访问此网站」** |
| 4 | 点「立即重试」 | 页面**无任何变化**（不跳转、不刷新、不出现错误页） |

然后另开一个终端重新起服务：

```bash
cd /Users/lichao/Downloads/claude/imooc/ai_k12 && bash tools/services.sh start
```

| 冒烟 # | 操作 | 期望 |
|---|---|---|
| 5 | 在本地页显示期间重新起 web 服务 | **≤5 秒自动进入**登录页，学生无需操作 |
| 6 | 进入后手动让某张图 404（或断网再恢复），观察是否误切本地页 | **不切**本地页 |

期望：全部通过。**#3 是这一步的核心验收点**，如果出现 Chromium 的「无法访问此网站」，说明重试退化成了「反复 loadURL」，回去检查 `tryReconnect()`。

- [ ] **Step 7: Commit**

```bash
git add apps/desktop/pages/offline.html apps/desktop/preload.js apps/desktop/main.js
git commit -m "feat(desktop): 连不上本地页 + 探测式自动重连（先探测再导航，避免被错误页替换）"
```

---

## Task 8: 补洞 —— `studentMode` 持久化，启动即进 kiosk

封住「断网 + 杀进程 + 重启」这条逃逸路径（spec §1.4、§4.3）。

**Files:**
- Modify: `apps/desktop/main.js`
- Test: 人工验证

**Interfaces:**
- Consumes: `readStudentMode` / `writeStudentMode`（Task 4）
- Produces: `main.js` 内部 `applyStudentMode(on: boolean): void` —— 启动路径与 IPC 路径**共用**它

- [ ] **Step 1: 加 require**

在 require 区末尾追加：

```js
const { readStudentMode, writeStudentMode } = require('./lib/shell-state.js');
```

- [ ] **Step 2: 把 IPC 处理器抽成共用函数**

把 `main.js` 末尾这段：

```js
// 渲染层 → 主进程：学生模式开关。`setKiosk` 是真全屏 + 锁定（比 fullscreen 更彻底）。
ipcMain.on('kiosk:set-student-mode', (_event, on) => {
  studentMode = Boolean(on);
  if (!win || win.isDestroyed()) return;
  win.setKiosk(studentMode);
  win.setClosable(!studentMode);
  // setMinimizable 在 macOS 上是 no-op；Windows/Linux 上有效。不是错误，别加平台分支。
  win.setMinimizable(!studentMode);
});
```

替换为：

```js
/**
 * 应用学生模式：落盘 + 驱动窗口的 kiosk 三件套。
 *
 * **启动路径（补洞）与 IPC 路径必须走同一段代码**（spec §4.3）—— 两处各写一套必然漂移，
 * 而漂移的后果是「某个入口忘了落盘」或「某个入口忘了全屏」，正是这次要修的洞。
 */
function applyStudentMode(on) {
  studentMode = Boolean(on);
  // 先落盘：写失败只 warn、绝不抛（写入永不阻断主链路）。落盘是为了下次启动能恢复。
  writeStudentMode(app.getPath('userData'), studentMode);

  if (!win || win.isDestroyed()) return;
  win.setKiosk(studentMode);
  win.setClosable(!studentMode);
  // setMinimizable 在 macOS 上是 no-op；Windows/Linux 上有效。不是错误，别加平台分支。
  win.setMinimizable(!studentMode);
}

// 渲染层 → 主进程：学生模式开关。`setKiosk` 是真全屏 + 锁定（比 fullscreen 更彻底）。
ipcMain.on('kiosk:set-student-mode', (_event, on) => {
  applyStudentMode(on);
});
```

- [ ] **Step 3: 启动时读回状态（在 createWindow 之前）**

把 Task 6 之后 `app.whenReady()` 的开头：

```js
app.whenReady().then(() => {
  WEB_URL = resolveServerUrl(
    process.env.K12_WEB_URL,
    readServerUrlFromFile(app.getPath('userData')),
    SERVER_URL,
  );
  // 打一行日志：排障时一眼看出壳到底在连哪个地址（人工冒烟 #14/#16 靠它验证）
  console.log(`[shell] 加载地址: ${WEB_URL}`);

  createWindow();
```

替换为：

```js
app.whenReady().then(() => {
  WEB_URL = resolveServerUrl(
    process.env.K12_WEB_URL,
    readServerUrlFromFile(app.getPath('userData')),
    SERVER_URL,
  );
  // 打一行日志：排障时一眼看出壳到底在连哪个地址（人工冒烟 #14/#16 靠它验证）
  console.log(`[shell] 加载地址: ${WEB_URL}`);

  // 补洞（spec §1.4 / §4.3）：kiosk 由页面里的渲染层经 IPC 驱动，而**离线时页面
  // 根本加载不出来** → 渲染层不执行 → studentMode 恒为 false → 窗口不是 kiosk
  // → 学生「关 Wi-Fi + 杀进程 + 重启」就能逃逸。所以先把上次的状态读回来，
  // 建窗口时就进 kiosk，不等渲染层。
  studentMode = readStudentMode(app.getPath('userData'));

  createWindow();
```

- [ ] **Step 4: 建窗口时应用 kiosk**

在 `createWindow()` 里，把 **Task 7 Step 4 刚加好的这一整块**（从 `win.loadURL(WEB_URL);` 到 `did-finish-load` 处理器结束）：

```js
  win.loadURL(WEB_URL);

  // 连不上 → 本地页 + 探测式重试（spec §4.2）
  win.webContents.on('did-fail-load', (_event, errorCode, _errorDescription, _url, isMainFrame) => {
    if (!isMainFrame) return; // 子资源（图片/CSS）失败不算「连不上」
    if (errorCode === -3) return; // ERR_ABORTED：导航被取消，页面并未失败
    showOfflinePage();
    startRetry();
  });

  win.webContents.on('did-finish-load', () => {
    if (!win || win.isDestroyed()) return;
    // 主 frame 加载完成且当前不是本地页（file:）→ 说明连上了，停表
    if (!win.webContents.getURL().startsWith('file:')) stopRetry();
  });
```

替换为（**只在最前面插入 kiosk 那 4 行，事件处理器原样保留**）：

```js
  // 「偏向多锁」：上次是学生模式就一开机就进 kiosk，不等渲染层（spec §4.3、§6-7）。
  // 在首页真正显示出来之前应用，避免「先普通窗口、再全屏」的可见闪动。
  if (studentMode) {
    win.once('ready-to-show', () => applyStudentMode(true));
  }

  win.loadURL(WEB_URL);

  // 连不上 → 本地页 + 探测式重试（spec §4.2）
  win.webContents.on('did-fail-load', (_event, errorCode, _errorDescription, _url, isMainFrame) => {
    if (!isMainFrame) return; // 子资源（图片/CSS）失败不算「连不上」
    if (errorCode === -3) return; // ERR_ABORTED：导航被取消，页面并未失败
    showOfflinePage();
    startRetry();
  });

  win.webContents.on('did-finish-load', () => {
    if (!win || win.isDestroyed()) return;
    // 主 frame 加载完成且当前不是本地页（file:）→ 说明连上了，停表
    if (!win.webContents.getURL().startsWith('file:')) stopRetry();
  });
```

- [ ] **Step 5: 人工验证（spec §5 冒烟 #7–#10、#12、#13）**

先起服务：

```bash
cd /Users/lichao/Downloads/claude/imooc/ai_k12 && bash tools/services.sh start
cd apps/desktop && npm start
```

| 冒烟 # | 操作 | 期望 |
|---|---|---|
| 7 | 用**学生**账号登录 | 进 kiosk：真全屏、关不掉、最小化不了 |
| 8 | 保持登录，**杀进程**（活动监视器里结束 Electron）**并关掉 web 服务** → 重新 `npm start` | **仍是 kiosk**（补洞生效），且显示本地页 |
| 9 | 恢复服务（`bash tools/services.sh start`） | 自动进入；锁未到期时「退出登录」仍被拒 |
| 10 | 承 #9，在家长端把锁清空（或等锁到期） | 能正常登出 → 窗口恢复普通尺寸 |
| 12 | 承 #10 登出后，重启壳 | **不是 kiosk**（验证 false 已落盘） |
| 13 | 把 `shell-state.json` 写成乱码 → 重启壳 | **不是 kiosk**（坏数据容错） |

```bash
# #13 的辅助命令
UD="$HOME/Library/Application Support/k12-desktop"
echo '{oops' > "$UD/shell-state.json"
cat "$UD/shell-state.json"     # 确认写坏
```

- [ ] **Step 6: Commit**

```bash
git add apps/desktop/main.js
git commit -m "fix(desktop): 学生模式持久化，启动即进 kiosk —— 封住「断网+杀进程+重启」逃逸"
```

---

## Task 9: 生产加固 —— DevTools 仅生产禁用

**Files:**
- Modify: `apps/desktop/main.js`
- Test: 代码检查（`app.isPackaged` 只在出包时为 true，**② 不出包，故此条只能留到 ③ 冒烟**，见 spec §5「② 阶段无法验证的」）

**注意：「生产下 DevTools 打不开」这一条本批无法验证**，只能在 Task 13 的 changelog 里登记为 ③ 的待验项 —— 不要在本任务里编造验证步骤。

**Interfaces:**
- 无新增导出

- [ ] **Step 1: 改 webPreferences**

把 `createWindow()` 里的 `webPreferences` 块：

```js
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
```

替换为：

```js
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      // 生产构建关掉 DevTools（spec §4.4）：这是「改 localStorage」这个逃逸面
      // 价值最高的一道门槛 —— 它也一并封掉 F12 / Cmd+Opt+I / Ctrl+Shift+I。
      // dev 模式保留（isPackaged 为 false），调试不受影响。
      devTools: !app.isPackaged,
    },
```

- [ ] **Step 2: 代码检查**

```bash
cd /Users/lichao/Downloads/claude/imooc/ai_k12 && grep -n "devTools" apps/desktop/main.js
```

期望：输出一行 `devTools: !app.isPackaged,`。

- [ ] **Step 3: 确认 dev 模式仍开着 DevTools**

```bash
cd /Users/lichao/Downloads/claude/imooc/ai_k12 && bash tools/services.sh start
cd apps/desktop && npm start
```

在窗口里按 `Cmd+Opt+I`（macOS）。期望：**DevTools 打开** —— 说明 dev 模式没被误伤（`app.isPackaged === false` 时 `devTools === true`）。关掉 DevTools 与窗口。

- [ ] **Step 4: Commit**

```bash
git add apps/desktop/main.js
git commit -m "feat(desktop): 生产构建禁用 DevTools（dev 模式保留）"
```

---

## Task 10: 应用图标

**Files:**
- Create: `apps/desktop/build/icon.png`

**Interfaces:**
- Produces: `apps/desktop/build/icon.png`（1024×1024 PNG）—— ③ 的 electron-builder 配置会引用它

- [ ] **Step 1: 确认工具在**

```bash
which rsvg-convert && rsvg-convert --version
```

期望：路径为 `/opt/homebrew/bin/rsvg-convert`，版本 `2.62.x`（本机已装 librsvg；若报未找到，先跑 `brew install librsvg`）。

- [ ] **Step 2: 生成 PNG**

```bash
cd /Users/lichao/Downloads/claude/imooc/ai_k12/apps/desktop && mkdir -p build && rsvg-convert -w 1024 -h 1024 ../web/public/favicon.svg -o build/icon.png
```

- [ ] **Step 3: 验证尺寸与格式**

```bash
cd /Users/lichao/Downloads/claude/imooc/ai_k12/apps/desktop && file build/icon.png && ls -l build/icon.png
```

期望：`build/icon.png: PNG image data, 1024 x 1024, ...`，且文件非空（约数 KB～数十 KB）。

- [ ] **Step 4: 目视确认**

用系统预览打开：

```bash
open /Users/lichao/Downloads/claude/imooc/ai_k12/apps/desktop/build/icon.png
```

期望：品牌橘（`#ff6b35`）圆角方块 + 白色线性书本，**边缘不糊、不变形**。

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/build/icon.png
git commit -m "chore(desktop): 应用图标 1024×1024（由 web 的 favicon.svg 栅格化）"
```

---

## Task 11: 文档同步（一）— 旧 spec 更正注记 + 权威约束文档

**Files:**
- Modify: `docs/superpowers/specs/2026-09-23-pc-app-study-lockdown-design.md`
- Modify: `docs/constraints/pc-app-学习管控.md`
- Modify: `docs/superpowers/plans/2026-09-26-pc-app-shell-productionization.md`（本文件，把 Task 11–13 的 checkbox 勾掉）

**Interfaces:**
- 无代码接口

- [ ] **Step 1: 给旧 spec 的三处打更正注记**

在 `docs/superpowers/specs/2026-09-23-pc-app-study-lockdown-design.md` 里改三处，**只加注记、不改写原文**（本仓风格：就地标注）。三处的锚点已核实如下：

**1）第 373 行，§8 已知限制第 2 条** —— 该行以 `2. **被杀进程那次的「退出时间」是模糊的**` 开头。
**2）第 374 行，§8 已知限制第 3 条** —— 该行以 `3. **拔网线不解锁（有意）**` 开头。

这两条都在有序列表里，注记必须**缩进 3 空格**才能留在同一条目内。在两行各自末尾换行后追加：

```markdown
   > **更正（2026-09-26）**：本条只覆盖「学习中途断网」。**没有覆盖「断网后重新启动壳」** ——
   > 那条路径当时可逃逸（kiosk 由页面里的渲染层经 IPC 驱动，离线时页面加载不出来、渲染层不执行，
   > 于是 `studentMode` 恒为 false、窗口不是 kiosk）。已由
   > `2026-09-26-pc-app-shell-productionization-design.md` §4.3 补齐（`studentMode` 持久化到 `userData/shell-state.json`）。
```

**3）第 102 行，§3 用户裁决记录表的第 10 行** —— 原文是：

```markdown
| 10 | 异常退出 | **不专门处理**（杀进程换不来自由，见 §8 局限 2） |
```

把该行的**裁决单元格**替换为：

```markdown
**不专门处理**（杀进程换不来自由，见 §8 局限 2）（**2026-09-26 限定**：此处「杀进程换不来自由」仅在**服务器仍可达**时成立；服务器不可达 + 杀进程 + 重启原可逃逸，已由 `2026-09-26-pc-app-shell-productionization-design.md` §4.3 补齐）
```

- [ ] **Step 2: 往权威约束文档追加一节**

在 `docs/constraints/pc-app-学习管控.md` **末尾**追加一节：

```markdown
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
- **覆盖文件校验不通过一律静默回退到下一层，绝不抛错卡住启动** —— 一个手抖写坏的文件
  不该比没有文件更糟（学生机卡在启动就彻底不可用）
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
```

- [ ] **Step 3: 复核没写进 `CLAUDE.md`**

```bash
cd /Users/lichao/Downloads/claude/imooc/ai_k12 && wc -c CLAUDE.md && grep -c "config.json\|shell-state" CLAUDE.md || true
```

期望：`CLAUDE.md` 体积仍在 ~11KB 量级（不因本次增长），且第二行输出 **`0`**
（= 不含 `config.json` / `shell-state` 的细节，内容都在 `docs/constraints/`，符合体量纪律）。

- [ ] **Step 4: Commit**

```bash
git add docs/superpowers/specs/2026-09-23-pc-app-study-lockdown-design.md docs/constraints/pc-app-学习管控.md docs/superpowers/plans/2026-09-26-pc-app-shell-productionization.md
git commit -m "docs: 旧 spec 补更正注记 + constraints 落壳生产化硬约束"
```

---

## Task 12: 文档同步（二）— README（PC App 三块 + ① 局域网运维清单）

README 是**唯一**披露覆盖文件路径的地方（spec §3-12）。漏写 = 这个设计白做。

**Files:**
- Modify: `README.md`

**Interfaces:**
- 无代码接口

- [ ] **Step 1: 改「PC App」章节**

在 `README.md` 的「### PC App (`apps/desktop`，Electron 壳)」这一节里：**原有的三进程启动命令与 kiosk 说明原样保留**，在它们**之后**追加下面四块（用 `####` 作子标题）：

```markdown
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

内容就一行：

```json
{ "serverUrl": "http://192.168.1.5:5173" }
```

- 改完**必须重启 App** 才生效（启动时读取）
- 必须是合法 JSON，且 `serverUrl` 是 `http(s)://` 开头的完整地址；
  **不合法时会被忽略并回退到 `server-url.js` 的默认值，不会让 App 卡住启动**
  （启动日志里会有一行 `warn` 说明为什么忽略）
- ⚠️ 若 ③ 给应用设了 `productName`，上表中的 `k12-desktop` 会变成那个名字 —— 届时需同步改本表

#### 连不上服务器时会看到什么

学生打开壳若连不上，会看到一张本地页：「暂时连不上学习服务器，正在重试…」+ 当前地址 +
「立即重试」按钮。壳**每 5 秒自动探测一次，探测通了就自动进入**，学生不需要做任何事。

#### 已知边界

- 学生登录即进 kiosk；**锁定期间关不掉窗口、不能登出**，只有家长能解除或到期自动解除
- 「**断网 + 杀进程 + 重启**」不再能逃逸：启动时会先读回上次的学生模式，直接进 kiosk
- Electron 拦不住 `Alt+Tab` / `Cmd+Tab` / `Ctrl+Alt+Del` / 强制退出 —— 那是系统级；
  真·无法切屏要靠装机时的 OS 级单应用模式（运维配置）
```

- [ ] **Step 2: 新增「① 局域网部署」运维清单**

在 `README.md` 的「### 部署与日常启停」小节之后插入：

```markdown
#### 局域网部署运维清单（让学生机接入本机服务器）

本机同时是**服务器**：`vite preview`（`:5173`）对外提供页面并反代 `/api`、`/assets`、`/uploads`
到 Nest（`:3001`），Nest 只在本机内网可达。学生机通过局域网访问 `http://<本机IP>:5173`。

部署前逐条确认：

1. ☐ **本机 IP 固定** —— 路由器后台把本机 MAC 绑定到固定地址（DHCP 保留/静态 IP）。
   学生机壳里写死的就是这个地址，**IP 一变，所有学生机都要重新出包重装**，
   或逐台改 `config.json`（见上文「地址变了…」）
2. ☐ **防火墙放行 5173** —— macOS「系统设置 → 网络 → 防火墙」；本机实测当前**防火墙已关闭**，
   故无需额外配置（若日后开启，需放行 `node` 与端口 `5173`）
3. ☐ **换机实测** —— 拿另一台电脑/手机浏览器打开 `http://<本机IP>:5173`，确认能到登录页
4. ☐ **开机自启**（建议）—— 现在服务靠手动 `bash tools/services.sh start`；
   **本机一重启服务不会自己起来，所有学生机立刻白屏**。需要配 launchd（macOS）或等价机制
```

- [ ] **Step 3: 核对三条路径与实际一致**

```bash
cd /Users/lichao/Downloads/claude/imooc/ai_k12 && grep -n "k12-desktop" README.md && grep -n '"name"' apps/desktop/package.json && grep -n '"productName"' apps/desktop/package.json || echo "(无 productName —— 与 README 里的 k12-desktop 一致)"
```

期望：README 里三处路径都含 `k12-desktop`，且 `apps/desktop/package.json` 的 `name` 是 `k12-desktop`、**没有** `productName`。不一致就改 README。

- [ ] **Step 4: Commit**

```bash
git add README.md
git commit -m "docs(README): PC App 地址三层来源与救火步骤 + 局域网部署运维清单"
```

---

## Task 13: 文档同步（三）— changelog 与 API 文档「无需变更」记录

**Files:**
- Modify: `docs/ai-core-changelog.md`
- Modify: `docs/API接口与数据流设计文档.md`

**Interfaces:**
- 无代码接口

- [ ] **Step 1: 往 changelog 追加一条（加在顶部）**

`docs/ai-core-changelog.md` 的约定是「**迁出后的新条目继续追加在顶部**」（该文件开头第 3 行明写），
且现有条目按日期倒序排列。所以把下面这条**插到第一个 `## ` 标题之前** ——
也就是第一处 `---` 分隔线之后、`## 2026-09-24 CLAUDE.md 深度瘦身…` 之前：

```markdown
## 2026-09-26 — PC App 壳生产化（②）

设计：`docs/superpowers/specs/2026-09-26-pc-app-shell-productionization-design.md`；
计划：`docs/superpowers/plans/2026-09-26-pc-app-shell-productionization.md`。

做了什么：
- 地址改为**三层来源**（`K12_WEB_URL` env > `userData/config.json` > `server-url.js` 写死值），
  并新增一个用户可写的覆盖文件作「地址变了但客户端无法重装」时的**最后手段**
- 「连不上」本地页 + 探测式自动重连（每 5 秒探测 `WEB_URL`，通了才导航）
- 补洞：`studentMode` 持久化到 `userData/shell-state.json`，启动即进 kiosk
- 生产构建禁用 DevTools（dev 保留）
- 应用图标由 `apps/web/public/favicon.svg` 栅格化

**过程中发现并修正的一个设计缺陷（值得记下来）**：原 spec §4.2 写的是「每 5 秒重新
`loadURL`」，而主 frame 导航失败时 **Chromium 会用它自己的错误页替换掉我们的本地页**
（`ERR_CONNECTION_REFUSED` 在提交前就失败，文档已被替换）。于是「反复 loadURL」的真实效果是
本地页只出现一次、之后永久变成「无法访问此网站」；而「已在本地页就不重载」的防闪烁写法会让
本地页再也回不来。**两者都不是「闪烁」，而是「整页丢失」。** 改成「先探测、再导航」解决。
教训：**凡是「用户可见的本地页」+「反复尝试加载远端」的组合，都要先问一句
「失败的那次导航会不会把本地页顶掉」。**

**未在本批验证、留给 ③ 的**：生产构建下 DevTools 是否真的打不开（`devTools` 只在
`app.isPackaged` 为 true 时生效，本批不出包）；图标在各平台的显示；Windows/Linux 上的行为。
本批留了 17 条人工冒烟清单（spec §5）。
```

- [ ] **Step 2: 在 API 文档的变更日志表里登记「契约零变更」**

`docs/API接口与数据流设计文档.md` 的 `## 9. 变更日志`（第 2039 行起）是一张
`| 版本 | 日期 | 说明 |` 的表，**最新在前**，当前最新是 `v4.10`。
在 `|---|---|---|` 分隔行**之后、`v4.10` 那一行之前**插入一行：

```markdown
| v4.11 | 2026-09-26 | **PC App 壳生产化（②）：接口契约零变更（仅登记）**。`docs/superpowers/specs/2026-09-26-pc-app-shell-productionization-design.md` 只改 `apps/desktop`（Electron 壳）与若干文档，**未新增/修改/删除任何 HTTP 端点**，故本文件正文与 `docs/api/openapi.yaml` 本批均无需同步。此结论显式登记，避免后来者误以为漏同步（spec §7）。 |
```

- [ ] **Step 3: 核对两档仍一致（本仓铁律）**

```bash
cd /Users/lichao/Downloads/claude/imooc/ai_k12 && git diff --stat -- docs/api/openapi.yaml docs/API接口与数据流设计文档.md
```

期望：只有 `docs/API接口与数据流设计文档.md` 有改动（**+1 行**表格行），
`docs/api/openapi.yaml` **零改动** —— 因为本批不涉及端点。

再确认 changelog 确实加在顶部（新条目应是文件里第一个 `## ` 标题）：

```bash
cd /Users/lichao/Downloads/claude/imooc/ai_k12 && grep -n "^## " docs/ai-core-changelog.md | head -3
```

期望：第一行是 `…:## 2026-09-26 — PC App 壳生产化（②）`。

- [ ] **Step 4: Commit**

```bash
git add docs/ai-core-changelog.md docs/API接口与数据流设计文档.md
git commit -m "docs: changelog 记录壳生产化（含重试设计缺陷的发现）+ API 文档登记本批无端点变更"
```

---

## 完成后的总验收

- [ ] **全量单测**

```bash
cd /Users/lichao/Downloads/claude/imooc/ai_k12/apps/desktop && npm test
```

期望：5 个测试文件全过（`server-url`、`resolve-server-url`、`config-file`、`shell-state`、`probe-server`），共 37 个用例。

- [ ] **确认没碰 `apps/web` 与后端**

```bash
cd /Users/lichao/Downloads/claude/imooc/ai_k12 && git diff --stat origin/main -- apps/web apps/server
```

期望：**输出为空**（本批只动 `apps/desktop/` 与文档）。

- [ ] **跑一遍 spec §5 的全部人工冒烟（#1–#17）**

逐条对照 spec `2026-09-26-pc-app-shell-productionization-design.md` §5「人工冒烟」表。
**#3（等 20 秒本地页仍在、绝不出现 Chromium 错误页）与 #8（杀进程+断网重启仍是 kiosk）是核心两条。**

- [ ] **明确不在本批验证的三项**（spec §5 末表）

DevTools 生产禁用、图标各平台显示、Windows/Linux 行为 —— 全部留给 ③ 出包后。
