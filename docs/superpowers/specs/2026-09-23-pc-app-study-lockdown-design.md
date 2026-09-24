# PC App（Electron）学习管控与单次学习锁定 — 设计

> **日期**：2026-09-23
> **状态**：设计已与用户逐节确认（14 条裁决见 §3），待用户审阅本文件后转 writing-plans。
> **PRD 锚点**：`docs/K12智学系统-产品需求文档.md` §2（`:35-36`「PC App：桌面客户端，适合居家固定学习场景」）、§7.7 家长端（`:216`）、§13 MVP 范围（`:384`，**PC App 不在 MVP 清单内**）。
> **架构锚点**：`docs/K12智学系统-架构设计文档.md` `:41`（客户端层 `│ PC App │ (Electron)`）、`:1145`（§10.2 P1「PC App 三栏布局」）。
> **上游产物**：本设计由 2026-09-23 的 brainstorming 会话产出。**未使用可视化伴侣**，故 UI 形态在 §6.4 / §6.5 用文字完整固化。

---

## 1. 背景与现状（2026-09-23 实测，勿凭记忆）

### 1.1 客户端

| 事实 | 实测值 |
|---|---|
| `apps/desktop/` | **不存在**（`ls apps/` 只有 `server` / `web`）。README 的 Roadmap 与架构文档都写了它，但零文件 |
| 「Electron」在文档中的地位 | PRD **只承诺「PC App」形态、从未写 Electron**；Electron 只出现在 `架构设计文档.md:41`、README 技术栈、以及埋点枚举里 |
| 阶段 | **P1，不是 MVP**。`UX-UI设计文档.md:760` 与 `架构设计文档.md:1145` 都把「PC App 三栏布局」放 P1；MVP 验收清单（`架构设计文档.md:1132`）无桌面项 |
| 埋点已就绪 | `openapi.yaml:10274` 的 `appShell: [web, electron]`；`数据库设计文档.md:1587` browser 枚举含 `electron`；`schema.sql:1321` `study_sessions.app_shell`；前端 `tracker.ts:316-318` 按 UA `/Electron/i` 判定 |
| 现有 web→native 钩子 | **只有埋点这一处**。无 `window.electron`、无 `window.electronAPI`、无能力探测 |
| 现有照片输入 | 纯 web `<input type="file">`（`AuxInputBar.tsx:574-580`），**无 `getUserMedia`**——桌面壳不改变这条路径 |

### 1.2 前端大屏现状（推翻了「三栏已做」的假设）

UX 文档承诺的 PC 能力（`UX-UI设计文档.md:708` 三栏、`:715-716` 键盘 + LaTeX）在代码里的实际状态：

| 承诺 | 现状 | 证据 |
|---|---|---|
| 学习沉浸层**三栏** + 右侧学情栏 | **完全不存在** | `CourseDetailPage.tsx:574`（左栏）+ `:680`（主区）= 两栏；讨论是 `DiscussDrawer.tsx:64-66` 的 45–70% 浮层；**全仓无任何 ≥1280px 布局分支** |
| 方向键切卡片 | **只有主线** | `CourseDetailPage.tsx:551-559`；训练轨/辅线没有 |
| Enter 提交答案 | **不存在** | `QuestionRunner.tsx` 无 `onKeyDown` |
| Esc 关弹层 | 已实现 | `LevelPanel` / `ImageLightbox` / `StudentSwitcher` |
| LaTeX 直输 | **已实现** | `LatexEditor.tsx` + `SymbolPalette.tsx` + 实时 `LatexPreview` |
| 断点体系 | stock Tailwind，无 `xl`/`2xl` 使用 | `tailwind.config.js:4` `extend: {}` |

→ **本设计不做三栏**（§3 裁决 1），因此上表除「不做」外无需改动。

### 1.3 家长端时长管控现状（关键：一个半成品 + 一条「不做」裁决）

- `controls` 表（`schema.sql:863-881`）里 `daily_time_limit_minutes`（`:866`）**永远是 NULL**：读侧已接（`controls.repo.ts:122-131` 的 `findDailyTimeLimit`），**写侧从未实现**（`update()` 白名单 `:141-168` 只含 4 列）。
- 它产出 `exceeded` 布尔值，**只用于显示**（`study-time.service.ts:54-72` → `GET .../today-usage` → `ParentDashboardPage.tsx:114-126`），**没有任何地方拦截**。
- 仓库自己的欠账清单写着：`docs/家长端学情批-完成情况与待办清单.md:301`「**只算不拦** … 没有任何地方阻止学生继续用。**家长设了会以为有用**」。
- 当初的裁决：`specs/2026-09-20-parent-controls-and-alerts-design.md:43`「本批不做，页面上也不出现」、`:71`「每日最大使用时长 / 禁用时段的学生端强制 | 用户裁决暂不做；**需要时单独立项**」。
- **本设计就是那次「单独立项」**，但语义不同（§3 裁决 4、5）。

### 1.4 可复用的既有机制

- **预警管线已存在且已实现「离开学习页就报」**：`safety_alerts` 表 + 通用助手 `SafetyAlertsService.record()`（`safety-alerts.service.ts:44`，永不抛错、30 分钟去重），类型枚举已含 `away` / `idle`（`:11`），级别 `info|warning|critical`（`:17`）；`maybeRecordHiddenAlert`（`study-sessions.service.ts:268`）已实现「离开 ≥ `controls.alert_away_minutes` 分钟 → 写 `away` 预警」。
- 前端已监听 `visibilitychange` / `pagehide`（`AnalyticsShell.tsx:51-52`）。**缺 `blur` / `focus` 观测**（"窗口可见但失焦"不触发）——本期**不补**，因为不新增预警类型（§4.4）。注意 §6.1 里 Electron 主进程用 `blur` 做**抢回焦点**，与这里的**遥测**是两回事。
- `RunExitGuard.tsx:22-62` 是一个**确认**（`blocker.proceed()` 可穿过），**不是硬拦**，不能用于禁用登出。

### 1.5 会变砖的既有交互（必须在本设计中解掉）

`auth.module.ts:13` `expiresIn: '7d'`（不可刷新）+ `api.ts:40-44` **401 不触发登出**（只抛 `ApiError`）+ 锁定期间禁止登出 = 理论上的死锁。因锁定时长上限 480 分钟远小于 7 天，**实际不会触发**；但 §3 裁决 7（到期自动解除）是这条的最终兜底。

---

## 2. 范围

### 本期做

| # | 内容 | 落点 |
|---|---|---|
| 1 | Electron 壳（dev 模式，加载与 Web **完全相同**的 UI） | `apps/desktop/`（新建） |
| 2 | 角色驱动 kiosk：学生 → 真全屏；家长/管理员 → 普通窗口 | 壳 + `apps/web` |
| 3 | 单次学习锁定（家长可设 1..480 分钟） | `controls` 列改名 + 服务端 + 学生端 |
| 4 | 一次学习会话的记录（家长端「进出时间」的数据源） | 新表 `learning_sessions` |
| 5 | 家长解除锁定的命令通道（专用轮询端点） | 新表 `device_commands` + 新模块 |
| 6 | 锁定期间禁止登出（含共享组件加固） | `LogoutButton` + 壳 |
| 7 | 家长端：`/parent/controls` 新增锁定设置 + 解除；仪表盘「学习时段」卡 | `apps/web` |
| 8 | 封堵应用内逃逸（外链、导航白名单） | 壳 |

### 本期不做（明确）

1. **安装包 / 自动更新 / 代码签名** —— dev 模式运行（用户裁决：先验证）
2. **三栏布局**及其余 PC 专属布局 —— 被推翻的旧承诺（§3 裁决 1）
3. **锁设备**（开机自启 + 启动即锁）—— 用户选「锁应用」
4. **OS 级单应用模式**（Windows Assigned Access / macOS Single App Mode / MDM）—— 装机配置，另出文档
5. **每日累计上限** —— 概念废除（§3 裁决 4）
6. **异常退出识别**（杀进程 / 断电）—— 用户明确不考虑（§3 裁决 10）
7. **Web 端管控** —— 非 Electron 环境不建会话、不轮询、不拦登出（§8 局限 5）
8. **云端部署**（CORS / HTTPS / 持久化存储）—— 留 `K12_WEB_URL` 接缝（§3 裁决 13）
9. **`force_close` 类命令** —— 只为 `unlock` 建通道（§3 裁决 8）
10. **往学情四页加写入逻辑** —— 受 `CLAUDE.md` 硬规则约束，新端点另起模块（§5.0）

---

## 3. 用户裁决记录（逐条，实现时勿推翻）

| # | 议题 | 裁决 |
|---|---|---|
| 1 | PC App 布局 | **与 Web 完全一致**，不做三栏、不改 `apps/web` 布局代码 |
| 2 | 锁定范围 | **锁应用**（学生登录才锁）；不做锁设备、不做 OS 级单应用模式 |
| 3 | 锁定触发 | `role==='student'` → 真全屏 kiosk；`parent`/`admin` → 普通窗口 |
| 4 | 时长字段 | **复用** `controls.daily_time_limit_minutes`，**改名** `session_lock_minutes`（不新增列、不删列） |
| 5 | 时长语义 | **单次登录起算的墙钟窗口**（挂机也算）；不是每日累计、不是累计学习时长 |
| 6 | 时长快照 | 会话开始时快照；家长事后改设置**不影响进行中的本次** |
| 7 | 到期行为 | **自动解除**（不必家长操作） |
| 8 | 家长解除 | 专用轮询端点 + `device_commands`；本期唯一命令 `unlock` |
| 9 | 进出时间 | 家长端可见每次**进入/退出的具体时刻**；新只读端点 + 仪表盘卡 |
| 10 | 异常退出 | **不专门处理**（杀进程换不来自由，见 §8 局限 2） |
| 11 | 失联（断网） | **不解锁**（否则拔网线即逃逸） |
| 12 | `controls` 死列 / `devices` 死表 | **只改要改的，其余不动**（不清理，不碰 CLAUDE.md「保留待用」那条裁决） |
| 13 | 后端归属 | 云端为最终形态；**本期只接本地 dev**，架构上留可配置 URL 的缝 |
| 14 | 交付形态 | **不出安装包**；交付物是代码 + 可运行的 dev 壳 |

---

## 4. 数据模型与口径

### 4.1 改名：`controls.daily_time_limit_minutes` → `session_lock_minutes`

- **语义**：`NULL` = 家长显式解除设置（未设锁，学生可自由登出，kiosk 仍全屏）；`1..480` = 登录起算 N 分钟内**禁止登出**；**默认 30**（2026-09-24 用户裁决：新建 controls 行与存量 NULL 都取 30，见迁移 `2026-09-24_session_lock_default_30.sql`）。
- **为什么改名而不是只改语义**：列名继续叫 `daily_time_limit_minutes` 却存"单次登录锁定分钟数"，就是在撒谎——接手者照名字写逻辑必错。
- **迁移**：`tools/db/migrations/2026-09-23_session_lock_minutes.sql`，必须**幂等**（先查 `information_schema.COLUMNS` 存在旧列名才 `ALTER TABLE controls RENAME COLUMN`）。同步 `schema.sql:866`。
- **安全性**：该列实测恒为 NULL（§1.3），重命名不丢数据。

### 4.2 新表 `learning_sessions`（一次学习登录）

```sql
CREATE TABLE IF NOT EXISTS learning_sessions (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  student_id BIGINT NOT NULL,
  app_shell VARCHAR(10) NOT NULL DEFAULT 'electron',   -- 复用埋点既有枚举 web|electron
  started_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  last_seen_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  ended_at DATETIME(3) DEFAULT NULL,
  lock_minutes SMALLINT DEFAULT NULL,                  -- 开始时的快照
  lock_expires_at DATETIME(3) DEFAULT NULL,
  unlocked_at DATETIME(3) DEFAULT NULL,
  unlocked_by_parent_id BIGINT DEFAULT NULL,
  active_student_id BIGINT
    GENERATED ALWAYS AS (IF(ended_at IS NULL, student_id, NULL)) VIRTUAL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3)
    ON UPDATE CURRENT_TIMESTAMP(3),
  KEY idx_learning_sessions_student_started (student_id, started_at),
  UNIQUE KEY uniq_learning_sessions_active (active_student_id),
  CONSTRAINT fk_learning_sessions_student_id
    FOREIGN KEY (student_id) REFERENCES students (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
```

**关键设计点**：

- **无 `end_kind`**：因为不区分异常退出（裁决 10），结束只有一种语义 → `ended_at IS NULL` 即"进行中"。加一个永远只有一个取值的枚举列就是死代码。
- **`active_student_id` 条件式 VIRTUAL 生成列 + UNIQUE**：由**数据库**保证"一个学生同时只有一个进行中的会话"。这是「**重启不重置时钟**」的实现保证——客户端重启后再 `POST` 会撞唯一键，服务层回读既有行返回同一个 `lock_expires_at`。
  - ⚠️ **必须 VIRTUAL、不能 STORED**；且**必须用真表验证**，临时表没有外键会得出假阳性（`CLAUDE.md` 记的 `goals.scope_subject_id` 教训）。
  - **本仓已有同款落地**：`remediation_sets` 的 `active_student_id`（`schema.sql:1174`）+ `uniq_rsets_active`（`:1177`）就是在干"每个学生同时只有一行为 active"这件事，照抄即可，不必重新设计。
- **`last_seen_at` 由轮询更新**（轮询即心跳）。在线判定阈值 `LEARNING_SESSION_ONLINE_WINDOW_SECONDS = 45`（服务端唯一真源，与客户端轮询间隔 `LEARNING_SESSION_POLL_MS = 10_000` 成对）——**两处镜像，改一处必须同步另一处**（沿用本仓 `CLIENT_IDLE_DETECTION_SECONDS` ↔ `IDLE_TIMEOUT_MS` 的既有纪律）。
- **无 `device_id` / 设备指纹**：全仓无设备绑定（`devices` 表从未写入，`study_sessions` 的设备列按类别存、不含唯一标识）。会话以 `student_id` 为界，够用。

### 4.3 新表 `device_commands`（家长 → 学生端命令）

```sql
CREATE TABLE IF NOT EXISTS device_commands (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  student_id BIGINT NOT NULL,
  command VARCHAR(20) NOT NULL,          -- 服务端白名单，本期 ['unlock']
  status VARCHAR(10) NOT NULL DEFAULT 'pending',  -- pending | consumed | expired
  issued_by_parent_id BIGINT NOT NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  consumed_at DATETIME(3) DEFAULT NULL,
  KEY idx_device_commands_pending (student_id, status, created_at),
  CONSTRAINT fk_device_commands_student_id
    FOREIGN KEY (student_id) REFERENCES students (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
```

- **`command` 用 VARCHAR + 服务端白名单，不用 ENUM**：本仓 `controls`/`learning_sessions` 的经验是**单个取值的 ENUM 就是死枚举**，将来加命令要改 schema。改用 VARCHAR 后新增命令零迁移。
- **10 分钟惰性过期**：每次读取时把 `created_at < NOW(3) - INTERVAL 10 MINUTE` 的 pending 置 `expired`（惰性清理，**不建定时任务**）。理由：否则一条陈旧 `unlock` 会解锁**将来的某次**锁定。
- 与 `learning_sessions` 一样**不做设备绑定**：命令以 `student_id` 为目标。

### 4.4 显式不动的既有资产（避免实现时误动）

| 资产 | 处置 |
|---|---|
| `controls` 其余 5 列（`disabled_hours` / `photo_search_enabled` / `alert_level` / `break_reminder_minutes` / `auxiliary_enabled`） | **不动**（裁决 12） |
| `devices` 表（`schema.sql:72-83`，从未写入） | **不动**（裁决 12） |
| `study_sessions` 及其全部埋点口径 | **一行不改**——管控不复用埋点表（§7） |
| `safety_alerts` / `away` / `idle` 预警管线 | **不改**（本期不新增预警类型） |

---

## 5. 接口契约

### 5.0 模块落点

新建 `apps/server/src/modules/device-control/`，承载 §5.1–5.5 的**五个新端点**（学生端 3：取或建 / 登出 / 轮询；家长端 2：下发命令 / 进出时间），并注册进 `app.module.ts`。

**为什么不放进 `parent-insights`**：`CLAUDE.md` 硬规则——学情四页是**只读实时聚合**，"**不要往这四个端点里加写入逻辑**"。`POST device-commands` 是写，放进去就破坏该模块的边界。

`controls` 的字段扩展（§5.6）**留在 `parent-insights`**：它是 `controls` 表的列，而该表的读写本来就在那里（`controls.repo.ts` + `parent-insights` 的 controls 端点），跟过去才是正确的归属。

### 5.1 `POST /api/student/learning-sessions` — 取或建本次学习会话

- **角色**：`@Roles('student')`
- **Body**：无
- **逻辑**：
  1. 查该生 open 行（`ended_at IS NULL`）
  2. **有** → 顺带刷新 `last_seen_at`，**原样返回**（不重置时钟）
  3. **无** → 读 `controls.session_lock_minutes`；插入新行，`lock_minutes` 快照，`lock_expires_at = NOW(3) + INTERVAL ? MINUTE`（未设锁则两列皆 NULL）
  4. 并发撞唯一键（MySQL 1062）→ **回读既有 open 行返回**
- **成功**：**`200`**（显式 `@HttpCode(200)`）
  - ⚠️ 这是本仓**第一个** `@HttpCode` 覆盖。理由：该端点是幂等的"取或建"，返回 201 会误导调用方"每次都在创建"。`CLAUDE.md` 中「本仓无端点用 `@HttpCode` 覆盖」一句必须同步改（§9）。
- **响应**：`{ id: number, startedAt: string, lockMinutes: number | null, lockExpiresAt: string | null, unlockedAt: string | null }`
- **边界**：无 body 故无校验失败路径；未登录 → 401。

### 5.2 `PATCH /api/student/learning-sessions/:id/end` — 正常登出

- **角色**：`@Roles('student')`
- **归属**：`id` 必须属于 JWT 里的 `studentId`；不属于 → **404/1002**（不复用 403，避免泄露"该 id 存在"）
- **逻辑**：`ended_at IS NULL` → 置 `ended_at = NOW(3)`；**幂等**（已结束再调 → 200 原样返回）
- **响应**：`{ id: number, endedAt: string }`
- **边界**：`:id` 非数字 → 400/1001（`ParseIntPipe`）

### 5.3 `GET /api/student/device-commands` — 轮询（兼心跳）

- **角色**：`@Roles('student')`
- **逻辑**（同一事务内）：
  1. **惰性过期**：`UPDATE device_commands SET status='expired' WHERE student_id=? AND status='pending' AND created_at < NOW(3) - INTERVAL 10 MINUTE`
  2. **心跳**：`UPDATE learning_sessions SET last_seen_at=NOW(3) WHERE student_id=? AND ended_at IS NULL`
  3. 取 pending 命令（`ORDER BY id`）
  4. **认领**：`UPDATE device_commands SET status='consumed', consumed_at=NOW(3) WHERE id IN (...) AND status='pending'`（`WHERE status='pending'` 使认领幂等）
  5. 认领到 `unlock` → `UPDATE learning_sessions SET unlocked_at=NOW(3), unlocked_by_parent_id=? WHERE student_id=? AND ended_at IS NULL`
- **响应**：
  ```
  {
    commands: [{ id: number, command: string }],
    lock: { sessionId: number, lockExpiresAt: string | null, unlockedAt: string | null } | null
  }
  ```
- **`lock` 的作用**：供客户端**对账**——本地 `lockExpiresAt` 与服务端不一致时以服务端为准（例如家长已在别处解除）。
- **无 open 会话** → `{ commands: [], lock: null }`（**正常态，不是 404**）
- **未知命令** → 客户端**忽略并 ack**（前向兼容，代价见 §8 局限 4）

### 5.4 `POST /api/parent/students/:studentId/device-commands` — 家长下发命令

- **角色**：`@Roles('parent')`；先 `requireOwnedStudent` → 非己出 403/1005、孩子不存在 404/1002
- **Body**：`{ command: 'unlock' }`；`command` 不在白名单 → **400/1001**
- **逻辑**：查该生 open 行 → **无 → 409/1001「当前没有进行中的学习会话」**；有 → 插 `pending` 命令行
- **为什么无 open 就 409**：否则一条命令会悬在那里，解锁掉**将来某次**锁定（10 分钟过期只是兜底，不该当主防线）
- **成功**：**`201`**（Nest `@Post` 默认，不覆盖）
- **响应**：`{ id: number, command: string, status: 'pending', learningSessionId: number, createdAt: string }`

### 5.5 `GET /api/parent/students/:studentId/learning-sessions` — 家长端「进出时间」

- **角色**：`@Roles('parent')`；`requireOwnedStudent` 同上
- **Query**：`days` 缺省 7、范围 1..90；`limit` 缺省 50、范围 1..100。**越界 400/1001，不静默钳制**（本仓全局纪律，见 `parent-insights.controller.ts:258` 同款注释）
- **响应**：
  ```
  {
    items: [{
      id, startedAt, endedAt: string | null,
      online: boolean,                 // 后端算好下发
      lockMinutes: number | null, lockExpiresAt: string | null, unlockedAt: string | null
    }],
    total: number
  }
  ```
  - 排序 `started_at DESC`
  - `online` = `ended_at IS NULL && (NOW(3) - last_seen_at) <= 45s`。**阈值真源在后端，前端不重算**（沿用数学薄弱点图谱的同款纪律：常量只有一个真源）
- **空结果** → `{ items: [], total: 0 }`（正常态）

### 5.6 `GET` / `PUT /api/parent/students/:studentId/controls` 扩展

- `GET` 响应**新增** `sessionLockMinutes: number | null`
- `PUT` body **新增**可选 `sessionLockMinutes`：`1..480` 的整数，或 `null`（= 解除设置）；越界 → **409/1001**（与该端点既有校验口径一致）
- 既有约束照旧：至少一个字段、`ControlsPatchSchema` 的既有范围与「未提供即不动」语义
- `PUT` 响应回读完整对象（含新字段）

### 5.7 `GET /api/parent/students/:studentId/today-usage` 收缩（改造的连带）

- **移除** `limitMinutes` 与 `exceeded`（每日上限概念已废除，留着就是撒谎）
- **保留** `date` / `activeSeconds` / `byModule`
- 连带改动：`TodayUsageSummary` DTO、`study-time.service.ts:48-72`（删掉 `findDailyTimeLimit` 调用及其注释里的每日口径段落）、`controls.repo.ts:111-131`（`findDailyTimeLimit` → 改名 `findSessionLockMinutes` 并重写注释）、`ParentDashboardPage.tsx:114-126` 的 `exceeded` 展示、相关测试、API 文档与 `openapi.yaml`

---

## 6. 客户端设计

### 6.1 `apps/desktop/`（新建 Electron 壳）

- **文件**：`package.json`（`electron` 作 devDependency；`scripts.start = electron .`）、`main.js`、`preload.js`
- **加载**：`win.loadURL(process.env.K12_WEB_URL ?? 'http://localhost:5173')`
  - 本期默认指向本地 vite dev（`:5173` **已在服务端 CORS 白名单内**，故本期零 CORS 改动）
  - `K12_WEB_URL` 即**云端接缝**（裁决 13）；云端接入所需的 CORS/HTTPS/持久化存储列为非目标（§2.8）
- **窗口**：`contextIsolation: true` / `nodeIntegration: false` / `sandbox: true` + preload
- **`k12Desktop.setStudentMode(true)` 时**：`win.setKiosk(true)`、`setClosable(false)`、`setMinimizable(false)`、`win.on('close', e => studentMode && e.preventDefault())`、`app.on('before-quit', e => studentMode && e.preventDefault())`
- **`setStudentMode(false)`**：反向恢复（`setKiosk(false)`、恢复 closable/minimizable）
  - ⚠️ **这个名字与语义是 2026-09-24 修正的**：初稿把这个信号叫 `setLocked`，读起来像「锁定窗口生效时才 kiosk」——照字面实现会让**未设锁的学生完全不被全屏**（学生登录后仍能随便切应用），与 §3 裁决 2「**角色驱动** kiosk」和 §6.2 的 `UNLOCKED → kiosk 全屏` 直接冲突。**kiosk 只由「是不是学生角色 + 在不在壳里」决定**；家长设的时长只决定**能不能登出**（§6.3 的 `LogoutButton` 自判）与**要不要显示 pill**（§6.4）。两件事必须分开，**勿再合并成一个布尔**。
- **封堵导航逃逸**：`webContents.setWindowOpenHandler(() => ({ action: 'deny' }))`；`will-navigate` 只放行同源 URL
  - 必须做：AI 回复的 markdown 会渲染 `target="_blank"` 外链（`AdminChatPage.tsx:136`、`AuxChatPanel.tsx:171`），不拦就是"大模型吐个链接 → 学生点进浏览器"
- **失焦抢回**：`win.on('blur', () => { if (locked) win.focus() })`
  - **刻意不加 `setAlwaysOnTop`**：会盖住 UAC / 系统安全对话框，风险大于收益
  - 定位为**尽力而为**（OS 可限流；§8 局限 1）
- **DevTools**：dev 模式保留；**生产构建禁用**——该项本期**无法验证**（不出包），规格写明、验证延后（§8 局限 7）

### 6.2 `apps/web` 侧：`LearningSessionShell`（新增）

- **挂载点**：与 `AnalyticsShell` 同级（App 根）。理由：学习页是 full-screen、不在任何 Layout 下，**只有根层能覆盖全部路由**
- **启用条件**：`localStorage.userRole === 'student' && window.k12Desktop` → **只有 Electron 壳内生效**（§2 本期不做 7 / §8 局限 5）
- **状态机**：

| 状态 | 进入条件 | 壳行为 | 登出 |
|---|---|---|---|
| `IDLE` | 非学生 或 非 Electron 环境 | 普通窗口（`setStudentMode(false)`） | 允许 |
| `UNLOCKED` | 学生 + 无 `lockExpiresAt`（含已到期 / 已被家长解除） | kiosk 全屏（`setStudentMode(true)`） | 允许 |
| `LOCKED` | 学生 + `lockExpiresAt > now` | kiosk 全屏（`setStudentMode(true)`） | **禁止** |

> **注意 `UNLOCKED` 与 `LOCKED` 的壳行为完全相同**（都是 kiosk 全屏）—— 两者只差「登出允许与否」+ 是否显示 pill。
> 推给壳的信号是 **`setStudentMode(role === 'student' && inShell)`**，**不是**「锁定窗口是否生效」（2026-09-24 修正，见 §6.1）。

- **转移**：
  - `onEnable` → `POST 5.1` 拿到 `lockExpiresAt` → `LOCKED` 或 `UNLOCKED`
  - 本地定时器到点 → `LOCKED` → `UNLOCKED`
  - 轮询取回 `unlock` 命令 **或** `lock.unlockedAt != null` → `LOCKED` → `UNLOCKED`
  - 正常登出（仅 `UNLOCKED` 可达）→ `PATCH 5.2` → 清 localStorage 键 → `IDLE`
  - 角色翻转（登入为家长）→ `IDLE`
- **轮询**：`GET 5.3` 每 `LEARNING_SESSION_POLL_MS = 10_000`
- **本地持久化**：`localStorage['k12_learning_session'] = { id, lockExpiresAt }`
  - **这是「拔网线不解锁」的实现**（裁决 11）：断网时读本地截止时间，仍在锁定就一直锁
- 新增 service 函数写进既有单一 API 层 `apps/web/src/services/api.ts`

### 6.3 锁定期间禁退（三处堵，缺一处即逃逸口）

1. **`LogoutButton` 自身判定**（`components/base/LogoutButton.tsx`）
   - 读 `k12_learning_session` + 当前时间；锁定中 → `disabled` + `title`/`aria-label` 提示
   - **放在共享组件里而不是调用点**：4 个学生页调用点（`EntrySelectPage.tsx:79` / `CourseDetailPage.tsx:673` / `StudentStayLayout.tsx:76` / `AuxiliaryHomePage.tsx:62`）自动生效，**新增页面不可能漏**
   - 当前实现只有 `handleLogout`（`:45-52`），**无 `disabled` 语义**——需新增
   - 非学生角色（parent/admin 的 3 个调用点）不受影响
2. **Electron 壳拦 `close` / `before-quit` / `minimize`**（§6.1）
3. **外链与跨源导航封堵**（§6.1）

### 6.4 锁定中的可见状态

- 学习界面顶部一个 pill：`本次学习剩余 42 分钟`（`LOCKED` 时显示，解除即消失）
- 点击被禁用的登出按钮 → toast「本次学习时长未满，需家长解除后才能退出」
- **理由**（仓库纪律「界面优先于文字提示」）：剩余时间要**被看到**，而不是只在被拦时才解释

### 6.5 家长端 UI

**`/parent/controls`（`ParentControlsPage.tsx`）新增第三块「单次学习锁定」**

- 一个分钟输入（1..480）+ 说明文案：「孩子登录后 N 分钟内不能退出登录；期满自动解除，也可在下方随时解除」
- **「解除锁定」按钮**：仅在存在进行中会话时可点（据 `GET 5.5` 的 `items[0].endedAt === null` 判断）；否则禁用并给出原因
- 必须遵守该页既有三条纪律（其头部注释 `:25-30` 自陈）：派生状态带 `studentId` 归属、**只发改动过的字段**、**无改动 → 保存禁用**
- ⚠️ 该页 `:22-23` 的注释「**明确不做**（别照 PRD/UX 原文加回来）：每日最大使用时长…」**必须改**——否则实现者会照它把本功能删掉

**仪表盘新增「学习时段」卡**（`ParentDashboardPage`）

- **落点定为仪表盘**（家长最常打开的页），不放学情报告
- 内容：近 7 天每次**进入 / 退出时刻** + 在线状态点，列表最多 10 条
- **列表式，不聚合**；数据源 `GET 5.5`

---

## 7. 为什么家长端「进出时间」必须新建数据源

- 现有家长端时长全为**聚合值**：`parent-analytics.repo.ts` 的 `getStudyTimeTotal`（`:46`）/ `ByDay`（`:57`）/ `ByModule`（`:72`）/ `BySubject`（`:86`）/ `getActiveDays`（`:129`）——**没有一行返回原始起止时刻**。
- `study_sessions` 是**学习页粒度**（进一个场景一行，`sceneMap.ts:22-45` 定义场景），不是**登录粒度**；把相邻行拼成"一次学习期"属于猜测，且它**没有登录审计**可依据（`devices` 表从未写入）。
- 因此需要 `learning_sessions`（登录粒度）+ 新端点。这是**新能力**，不是现有能力的 UI 化。
- **不把管控状态塞进 `study_sessions`**：埋点表有自己的不可用容忍度（`CLAUDE.md`：「埋点不得影响请求」「永不抛」），让"禁止登出"依赖埋点表的可用性，方向就错了。

---

## 8. 非目标与已知限制（必须在文档里明说）

### 已知限制

1. **`Alt+Tab` / `Cmd+Tab` / `Ctrl+Alt+Del` / 强制退出挡不住** —— 应用层无解（`Ctrl+Alt+Del` 是系统级，任何应用都拦不住；macOS 后台抢占受 OS 限制）。`blur → focus` 只是干扰，不是阻断。**真正的"无法切屏"必须靠装机时的 OS 级单应用模式**（§2.4）。
2. **被杀进程那次的「退出时间」是模糊的** —— `ended_at` 保持 NULL，家长看到的是"已断开"（`last_seen_at` 超 45s 判定）而非确切退出时刻。这是裁决 10「不考虑异常」的直接代价。
3. **拔网线不解锁（有意）** —— 代价：断网期间学生被困到 `lock_expires_at`，最长可达 480 分钟。家长端文案必须说清这一点。
4. **客户端对未知命令忽略并 ack** —— 未来若新增命令，发给旧客户端会被吞掉。
5. **Web 端不受管控** —— 学生用浏览器登录既不建会话、不轮询，也不被禁退；家长端「进出时间」**只反映 PC App 的使用**。
6. **`force_close` 未实现** —— 通道已按可扩展设计（VARCHAR + 白名单），但没有命令实体，也没有 UI 入口。
7. **加固项本期无法验证** —— DevTools 禁用、右键屏蔽等只在生产构建生效，本期不出包（§2.1）。

---

## 9. 文档同步清单（仓库铁律，实现时必须一起改）

| 文档 | 要改什么 |
|---|---|
| `docs/K12智学系统-产品需求文档.md` | §7.7 附近新增 PC App 学习管控；**`:224`**「MVP…无需额外 PIN / 图形锁 / 独立密码」→ 标注为 MVP 口径、本能力属正式版；`§13` MVP 清单不必动（PC App 本就不在） |
| `docs/UX-UI设计文档.md` | `:698` / `:708` / `:760` 的「PC App 三栏」承诺 → 改为「与 Web 相同布局」；`:233-234`「正式版再做物理设备隔离」→ 指向本设计；新增 PC 学习管控页规格 |
| `docs/K12智学系统-架构设计文档.md` | `:1145` P1「PC App 三栏布局」→ 改；`:41` 客户端层补 kiosk 说明 |
| `apps/web/style.md` | `:485`「PC App：学习沉浸层可扩展为三栏…」→ 改 |
| `CLAUDE.md` | 家长端章节「每日时长 / 禁用时段…**不做、页面上也不出现**」→ 改（字段名也从"每日"变"单次"）；「本仓**无端点用 `@HttpCode` 覆盖**」→ 改（§5.1 是第一个）；新增「PC App 学习管控」小节（禁退三处、拔网线不解锁、`LEARNING_SESSION_*` 镜像常量） |
| `docs/API接口与数据流设计文档.md` + `docs/api/openapi.yaml` | 新增 5 个端点（§5.1–5.5：学生端 3 + 家长端 2）、`controls` 扩展（§5.6）、`today-usage` 收缩（§5.7）。**两档必须同步**（CLAUDE.md 同步规则） |
| `docs/K12智学系统-数据库设计文档.md` | `controls.daily_time_limit_minutes` → `session_lock_minutes`；新增两表；`app_shell` 补 kiosk 说明 |
| `docs/家长端学情批-完成情况与待办清单.md` | `:301`「只算不拦」→ 更新为已立项 |
| `docs/superpowers/specs/2026-09-20-parent-controls-and-alerts-design.md` | `:43` / `:71` 的「不做」标注 → 注明已被本设计推翻 |
| `README.md` | Roadmap 的「Electron Desktop Integration」→ 指向本设计；补三进程 dev 启动方式（server + vite + electron） |

---

## 10. 测试与验收

### 服务端

- `learning-sessions`：**取或建**幂等（连调两次同一 id）；`end` 幂等；跨学生访问 → 404/1002
- **并发钉子**：两个请求同时 `POST 5.1` → 只产生一行，另一个撞唯一键后回读**同一** `lock_expires_at`（这是「重启不重置时钟」的保证）
- `device-commands`：惰性过期（把 `created_at` 改到 11 分钟前 → 返回空且被置 `expired`）；认领幂等；轮询是否刷新 `last_seen_at`
- 家长下发命令：有 open 会话 → 201；**无 open → 409/1001**
- `controls`：`sessionLockMinutes` 越界（0 / 481）→ 409/1001；`null` 可写；**只发改动字段**语义不被破坏
- `today-usage`：契约收缩后的回归（不再返回 `limitMinutes` / `exceeded`）
- 迁移：**跑两次**均成功（幂等）；`active_student_id` VIRTUAL 生成列**用真表验证**——⚠️ 临时表无外键会得假阳性（`CLAUDE.md` 教训）

### 前端

- `LogoutButton`：锁定中渲染为 `disabled` 且**点击不清 auth**（仓库铁律：**组件改动必须补渲染测试**）
- `LearningSessionShell`：三态状态机；到点 `LOCKED→UNLOCKED`；收到 `unlock` 命令转移；**断网时仍保持 `LOCKED`**
- `ParentControlsPage` 第三块：只发改动字段、无改动保存禁用、解除按钮仅在会话进行中可点
- `ParentDashboardPage`「学习时段」卡：在线 / 已断开 / 进行中三态

### 人工冒烟（壳层难以单测，另列清单）

真全屏是否生效；锁定中窗口是否关不掉；`blur → focus` 抢回是否有效；学生页登出按钮是否禁用；外链是否被拦；**杀进程重启后是否回到锁定且剩余时间不变**；家长解除后学生端是否在 ≤10s 内解锁；到期是否自动解除。

---

## 11. 风险

1. **本设计大幅偏离既有文档**（推翻 UX/架构的「三栏 P1 承诺」、推翻 P6.6 的「时间管控不做」）→ 靠 §9 清单兜住，否则下一个接手者会照旧文档反向实现。
2. **禁退依赖"共享组件 + 壳层"两处都改对**，漏一处就是一个逃逸口 → 用渲染测试 + 人工冒烟双钉，不靠人记得。
3. **`session_lock_minutes` 上限 480 且断网不解锁** → 家长设 8 小时 + 断网 = 学生被锁 8 小时。这是有意的严格性（裁决 11），但必须在家长端文案里写清，否则会被当成故障。
4. **`learning_sessions` 的 open 唯一性依赖 VIRTUAL 生成列** → 若误用 STORED，重建整表会被外键挡住（`goals` 的 1215 教训）。
