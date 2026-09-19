# 埋点 Phase 1A（学习时长端到端）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让家长第一次看到**真实的学习时长**——孩子在哪个模块、哪一天、每科学了多久、今天已用多少——从「进入学习页打点」到「家长端卡片」整条链路打通。

**Architecture:** 三段式。① **采集**：前端 `analytics/` 的会话状态机在进入学习页时 `POST /api/study-sessions`，之后 30s 一次 `PATCH .../heartbeat`，离开时 `PATCH .../end`；服务端 `StudySessionsService` 用**带封顶的增量 SQL** 累计 `active_seconds`（客户端上报的秒数一律不采信）。② **读侧**：新建 `parent-analytics.repo.ts`（只读聚合，家长端硬过滤口径的唯一入口），`StudyTimeService` 把聚合结果组装成 `study-time` / `today-usage` 两个响应。③ **展示**：家长端仪表盘与报告页**新增**卡片，与既有的「近 7 天活跃天数」**并列**展示（见 Global Constraints 的 §10 硬约束）。

**Tech Stack:** NestJS 10（`@Controller` / `@UseGuards` / `@Inject('DATABASE_POOL')`）、TypeScript ESM、MySQL 9（mysql2/promise）、Zod、Vitest；前端 React 18 + React Router 6（`createBrowserRouter`）+ Zustand + Vite/Vitest。

**Spec:** `docs/superpowers/specs/2026-09-19-analytics-instrumentation-design.md`（本计划只做 §12 的 Phase 1 中「学习时长」这一半；专项/掌握度/目标另立 Phase 1B 计划）
**上游已合并:** Phase 0（`24861ef`，`main`）——`llm_call_logs` / `api_request_logs` 账本、`TelemetryBuffer`、`AnalyticsInterceptor`、`request-context` ALS 已就绪，本计划直接复用，不重建。
**来源盘点:** `docs/家长端学情批-完成情况与待办清单.md` §2.1

## Global Constraints

- **§10 硬约束（本批最容易做错的地方）**：**新「学习时长」与旧「近 7 天活跃天数」是两套口径，并存、不替换**。旧活跃是 `practice_results ∪ point_ledger ∪ exam_sessions ∪ ai_messages` 的**四路时间戳代理**（`parent-insights.repo.ts:241` 的 `getActivitySummary`）；新时长只来自**显式会话** `study_sessions`。`GET /api/parent/dashboard` 与 `GET /api/parent/students/:id/reports` 的**响应体一行不改**（spec §8.4），新数据走独立端点。UI 上两者必须**并列且文案区分**（「学习时长（会话）」vs「活跃天数」），**不得**把旧字段藏起来或覆盖成新口径——否则家长会看到数字莫名下降。
- **埋点不得影响主链路（按场景收窄，2026-09-19 裁决）**：规则只约束**嵌在别的业务流里的埋点写入**——例如 `StudyTimeService` 在家长 GET 里调 `closeStale`，必须 `try/catch` + `logger.warn`，**绝不**因为它把家长的页面打成 500。**三个采集端点（`/api/study-sessions*`）不在此列**：校验错照旧 400/1001，DB 故障就 500——前端的 `StudySessionTransport` 一律 `.catch` 吞掉，学习流程不受影响，而静默吞掉 DB 故障会让线上问题只能靠日志排查。
- **客户端上报的秒数一律不采信**：`active_seconds` 只由服务端按 `last_heartbeat_at` 差值累加，且单次增量**封顶 45s**（不封顶时「关标签 2 小时」会被算成 2 小时）。
- **DB 约定**：所有时间列 `DATETIME(3)`；`updated_at` 用**列级** `ON UPDATE CURRENT_TIMESTAMP(3)`，**绝不加触发器**；`ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`。
- **迁移**：无迁移运行器，**手工 apply**（`mysql -u ai_k12 -pai_k12 ai_k12 < tools/db/migrations/<file>.sql`，在仓库根执行）；必须**幂等**（建表 `CREATE TABLE IF NOT EXISTS`，加列用 `information_schema` + `PREPARE` 守卫）；新表/新列**必须同时写进 `tools/db/schema.sql`**。
- **时区**：窗口的 `from`/`to` 由**应用层**按服务器本地时区算好传参，**刻意不用 `CURDATE()`**（DB 会话时区与 Node 可能不一致，会算错一天）。沿用 `window.util.ts` 的既有约定。`< endExclusive` 半开区间，跨月/跨年无需拼接。
- **`rate` 口径**：`answered = 0 → null`，**不是 0**（0 会被读成「全错」）。复用 `parent-insights/rate.util.ts` 的 `toRate`，不另写一套。
- **Nest DI 坑**：`@Injectable()` 的类若构造参数是**接口类型**（非 class），运行时 `design:paramtypes` 会被写成 `Object`，Nest 找不到 token 会**启动直接失败**。必须显式 `@Inject(TOKEN)` 或 `@Optional()`。
- **前端测试约定**：`globals: false` → 每个用例文件自己 `import { describe, it, expect, vi } from 'vitest'`；多用例文件必须 `afterEach(() => cleanup())`；页面测试用 `createMemoryRouter(routes, { initialEntries: [path] })` 挂**真实路由表**（`routeTable.tsx` 保持纯配置，**不往里面加组件**）。
- **派生状态必须带 `studentId` 归属**：家长端页面切换孩子不重挂载，新卡片的数据必须存成 `{ studentId, value }` 并**按当前 `studentId` 比较后派生**，不能在 effect 里 `setState(null)`（effect 在 commit 之后跑，会闪一帧上个孩子的数据）。
- **UI 规则**：不用 emoji，图标用线性 SVG，配色只用 `apps/web/style.md` §2 的 token（不写字面颜色），家长端全程日间主题。每个新组件/页面补至少一条渲染测试。
- **命令**：后端 `cd apps/server && npm test`；前端 `cd apps/web && npm test`；构建 `npm run build`；起服务 `node dist/main.js`（`npx tsx src/main.ts` 的 DI 是坏的）。冒烟用**独立端口 + 按 PID 收尾**，**别 `pkill -f 'node dist/main.js'`**。
- **本批不做（勿顺手加）**：`behavior_events` 表与 `/api/track/events`（属 Phase 2，见下方「范围裁剪」）；`special_practice_logs` / `MasteryService` / `goals`（属 Phase 1B）；任何 ops/运营端接口；任何价格/成本列。

### 范围裁剪（对 spec §12 的一处有意收敛，评审时可否决）

spec §7.1/§7.5 把 `beacon.ts`、事件批量队列、`/api/track/events` 写在「前端 analytics/」，但 §12 明确把 **`behavior_events` 建表与 `EventsService` 放在 Phase 2**。二者矛盾。本计划取**§12 为准**，理由是：**家长端卡片一条也不需要 `behavior_events`**（时长读 `study_sessions`），而 `/api/track/events` 没有表就是死端点。

因此本批前端 `analytics/` 只实现**会话生命周期**（start / heartbeat / end）所需的模块：`types.ts` / `sceneMap.ts` / `sessionMachine.ts` / `tracker.ts` / `AnalyticsShell.tsx`（**不含 `beacon.ts` 与事件队列**）。`page_view` 及一切 client 语义事件随 `behavior_events` 在 Phase 2 一起落地。

---

## File Structure

**新建（后端）**

| 文件 | 职责 |
|---|---|
| `tools/db/migrations/2026-09-21_study_sessions.sql` | 建 `study_sessions`（含 5 个设备画像列） |
| `apps/server/src/database/repositories/study-sessions.repo.ts` | 会话生命周期写入（幂等插入 / 心跳封顶增量 / 结束 / 惰性收尾） |
| `apps/server/src/database/repositories/parent-analytics.repo.ts` | **只读**聚合（学习时长；Phase 1B 再加专项/掌握度/目标）。家长端口径的唯一入口 |
| `apps/server/src/common/utils/user-agent.util.ts` | UA 粗分类（`platform_class` / `browser`）+ 按 UA 字符串 memoize |
| `apps/server/src/modules/analytics/study-sessions.service.ts` | 白名单校验 + 设备校正 + 心跳封顶 + 幂等语义 |
| `apps/server/src/modules/analytics/analytics.controller.ts` | `/api/study-sessions/*`（student 角色） |
| `apps/server/src/modules/parent-insights/study-time.service.ts` | 组装 `study-time` / `today-usage` 两个响应 |

**新建（前端）**

| 文件 | 职责 |
|---|---|
| `apps/web/src/analytics/types.ts` | 会话相关类型（module/scene/state/end_reason/设备档） |
| `apps/web/src/analytics/sceneMap.ts` | pathname 正则 → `{ module, scene, isStudyScene }`（**唯一真源**） |
| `apps/web/src/analytics/sessionMachine.ts` | 纯 reducer：`transition(state, event)` → `{ state, effects }` |
| `apps/web/src/analytics/tracker.ts` | 会话编排 + 心跳定时器 + 设备信息采集 + 传输注入 |
| `apps/web/src/analytics/AnalyticsShell.tsx` | pathless 壳：路由变化 / 可见性 / pagehide / 输入活跃 |
| `apps/web/src/utils/duration.ts` | `formatDuration(seconds)`（两个页面共用） |

**修改**

| 文件 | 改动 |
|---|---|
| `tools/db/schema.sql` | 末尾新增 §16 段落（`study_sessions`） |
| `apps/server/src/database/repositories/index.ts` | 导出两个新 repo |
| `apps/server/src/database/repositories/controls.repo.ts` | 加 `findDailyTimeLimit(studentId)`（只读一个列，不动既有两法） |
| `apps/server/src/modules/analytics/analytics.module.ts` | 加 `AnalyticsController` + `StudySessionsService` + 两个 repo + `SubjectsRepository`（**保留 `TelemetryService`**——见 Task 5 Step 6 的注释） |
| `apps/server/src/database/repositories/study-sessions.repo.ts` | 只改类注释第 54 行那**一句**：把「调用方必须包 try/catch、绝不 500」收窄为「只约束嵌在别的业务流里的埋点写入（如家长 GET 的 `closeStale`）；三个采集端点是例外，允许 500」（该句写于 2026-09-19 收窄裁决之前，已过期） |
| `apps/server/src/common/interceptors/analytics.interceptor.ts` | 跳过名单加「心跳」（高频自指噪音） |
| `apps/server/src/common/interceptors/analytics.interceptor.test.ts` | 补心跳跳过断言 |
| `apps/server/src/modules/parent-insights/parent-insights.module.ts` | 加 `StudyTimeService` + `ParentAnalyticsRepository` + `ControlsRepository` |
| `apps/server/src/modules/parent-insights/parent-insights.controller.ts` | 加 2 个端点 |
| `apps/server/src/modules/parent-insights/dto/parent-insights.dto.ts` | 加 `StudyTimeSummary` / `TodayUsageSummary`（**Task 7 Step 0**，因为 service 是产出方；Task 8 只消费） |
| `apps/server/src/modules/parent-insights/window.util.ts` | 导出 `toDayString` + 新增 `resolveRange(from?, to?)` |
| `apps/web/src/routes/index.tsx` | 包 pathless `AnalyticsShell` |
| `apps/web/src/store/learnContextStore.ts` | 加 `subjectId` |
| `apps/web/src/pages/student/StarMapPage.tsx` | `setContext` 时带上 `subjectId` |
| `apps/web/src/services/api.ts` | 3 个会话方法 + 2 个家长端点方法与类型 |
| `apps/web/src/pages/parent/ParentDashboardPage.tsx` | 加「学习时长（近 7 天）」与「今日已用」两卡（**与活跃天数并列**） |
| `apps/web/src/pages/parent/ParentReportPage.tsx` | 加「学习时长」StatCard + 「每日学习时长」ChartBar（**保留活跃天数**） |
| `docs/API接口与数据流设计文档.md` / `docs/api/openapi.yaml` | §4.13 补 2 端点 + 新增 §4.23 采集端 + §6.25 数据流（**两份必须同步**） |
| `docs/K12智学系统-数据库设计文档.md` | 新表 |
| `docs/ai-core-changelog.md` | 本批完成后追加一条 |
| `CLAUDE.md` | 「工程约定」补一条：会话时长的两条写入纪律 |

**任务依赖**：`1 → 3 → 4 → 5`；`1 → 6 → 7 → 8`；`9 → 12 → 13`；`10、11 → 13`；`8 → 14 → 15 → 16`；`17、18` 收尾。任务 2、9、10、11 可与后端并行。

---

### Task 1: 迁移与 schema —— `study_sessions`

**Files:**
- Create: `tools/db/migrations/2026-09-21_study_sessions.sql`
- Modify: `tools/db/schema.sql`（末尾 §16，插在 §15 说明块之后、`SET FOREIGN_KEY_CHECKS = 1;` 之前）

**Interfaces:**
- Consumes: 无
- Produces: 表 `study_sessions`，列名以 spec §4.2 为准（后续任务依赖：`session_uid` / `student_id` / `module` / `scene` / `subject_id` / `status` / `client_state` / `active_seconds` / `heartbeat_count` / `started_at` / `last_heartbeat_at` / `ended_at` / `end_reason` / `platform_class` / `browser` / `screen_class` / `input_type` / `app_shell`）

- [ ] **Step 1: 写迁移文件**

Create `tools/db/migrations/2026-09-21_study_sessions.sql`：

```sql
-- 2026-09-21 埋点 Phase 1A：学习会话（学习时长的唯一真源）。
--
-- 背景（见 docs/superpowers/specs/2026-09-19-analytics-instrumentation-design.md §4.2）：
--   全库此前没有任何时长/会话表；`progress.last_active_at` 只在首次领课时写一次且仓储不读，
--   `devices.last_active_at` 从未写入。家长端只有「近 7 天活跃天数」这一**代理指标**，
--   无法回答「今天学了多久 / 这周比上周多还是少」。
--
-- 口径：
--   * `active_seconds` **只由服务端累计**：心跳时按 `last_heartbeat_at` 差值增量，
--     单次封顶 45s。客户端上报的秒数一律不采信（不封顶时「关标签 2 小时」会被算成 2 小时）。
--   * 设备画像**只到「类别」**，不存任何能唯一定位一台设备的标识（也不存原始 UA 字符串）。
--     `platform_class` / `browser` 由服务端从 User-Agent 粗分类（防客户端伪造）；
--     `screen_class` / `input_type` / `app_shell` 由前端上报（服务端拿不到）。
--   * iPadOS 13+ 的 Safari UA 写的是 `Macintosh`，只看 UA 会把 iPad 误判成 Mac——
--     服务端在写入时应用「platform_class == 'mac' 且 input_type == 'touch' → ipad」校正。
--
-- 幂等：建表用 CREATE TABLE IF NOT EXISTS，重复执行无副作用。
--
-- ⚠️ schema.sql 已同步（无迁移运行器，两处必须一致）。

CREATE TABLE IF NOT EXISTS study_sessions (
  id                BIGINT AUTO_INCREMENT PRIMARY KEY,
  student_id        BIGINT       NOT NULL,
  session_uid       CHAR(36)     NOT NULL COMMENT '前端生成的幂等键',
  module            VARCHAR(32)  NOT NULL COMMENT '低基数枚举，见 spec §5.1',
  scene             VARCHAR(40)  NOT NULL COMMENT '路由级细分，比 module 细',
  subject_id        BIGINT       DEFAULT NULL,
  ref_type          VARCHAR(24)  DEFAULT NULL COMMENT 'lesson|card|paper|passage|word|dialogue',
  ref_id            BIGINT       DEFAULT NULL,
  status            VARCHAR(12)  NOT NULL DEFAULT 'active' COMMENT 'active|ended|abandoned',
  client_state      VARCHAR(10)  NOT NULL DEFAULT 'visible' COMMENT 'visible|hidden（上次心跳时的可见性）',
  active_seconds    INT          NOT NULL DEFAULT 0 COMMENT '服务端累计；客户端上报的秒数一律不采信',
  heartbeat_count   INT          NOT NULL DEFAULT 0,
  started_at        DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  last_heartbeat_at DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  ended_at          DATETIME(3)  DEFAULT NULL,
  end_reason        VARCHAR(20)  DEFAULT NULL COMMENT 'route_change|pagehide|idle_timeout|closed|hidden_timeout',
  platform_class    VARCHAR(20)  DEFAULT NULL COMMENT 'ipad|iphone|android_tablet|android_phone|mac|windows|linux|other（服务端解析 UA）',
  browser           VARCHAR(20)  DEFAULT NULL COMMENT 'chrome|safari|edge|firefox|electron|other（服务端解析 UA）',
  screen_class      VARCHAR(20)  DEFAULT NULL COMMENT 'ipad_landscape|desktop|tablet_portrait|mobile（前端上报）',
  input_type        VARCHAR(10)  DEFAULT NULL COMMENT 'touch|mouse|hybrid（前端上报）',
  app_shell         VARCHAR(10)  DEFAULT NULL COMMENT 'web|electron（前端上报）',
  created_at        DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at        DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  UNIQUE KEY uniq_ss_uid (session_uid),
  KEY idx_ss_student_time   (student_id, started_at),
  KEY idx_ss_student_module (student_id, module, started_at),
  KEY idx_ss_open           (status, last_heartbeat_at),
  KEY idx_ss_platform_time  (platform_class, started_at),
  CONSTRAINT fk_ss_student_id FOREIGN KEY (student_id) REFERENCES students (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
```

- [ ] **Step 2: 同步 `tools/db/schema.sql`**

在 `tools/db/schema.sql` 的 §15 说明块之后、`SET FOREIGN_KEY_CHECKS = 1;` 之前（当前约 1231 行）插入：

```sql
-- ============================================================
-- 16. 学习会话（2026-09-21，埋点 Phase 1A）
-- ============================================================
-- 见 tools/db/migrations/2026-09-21_study_sessions.sql 的头部注释（口径与幂等说明）。

-- ---- study_sessions：一段「进入学习页 → 离开 / 挂机结束」的会话 ----
-- active_seconds 只由服务端按心跳差值累计（单次封顶 45s），客户端上报的秒数一律不采信。
-- 设备列只到「类别」，不存唯一标识；platform_class/browser 由服务端解析 UA，
-- screen_class/input_type/app_shell 由前端上报。iPadOS 的 Macintosh UA 由服务端校正为 ipad。
CREATE TABLE IF NOT EXISTS study_sessions (
  ...  -- ← 与 Step 1 的 CREATE TABLE 逐字相同
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
```

（`...` 处粘贴 Step 1 的完整列定义——**不要**真的写省略号，两处必须逐字一致。)

- [ ] **Step 3: 手工 apply 迁移**

```bash
cd /Users/lichao/Downloads/claude/imooc/ai_k12
mysql -u ai_k12 -pai_k12 ai_k12 < tools/db/migrations/2026-09-21_study_sessions.sql
```

Expected: 无输出（成功）。再跑一次同样无输出（幂等）。

- [ ] **Step 4: 确认表与列已建**

```bash
mysql -u ai_k12 -pai_k12 ai_k12 --vertical -e "SHOW COLUMNS FROM study_sessions" | grep -c "session_uid\|active_seconds\|platform_class\|input_type\|app_shell"
```

Expected: `5`

- [ ] **Step 5: Commit**

```bash
git add tools/db/migrations/2026-09-21_study_sessions.sql tools/db/schema.sql
git commit -m "feat(db): study_sessions 表 + schema.sql 同步（埋点 Phase 1A）"
```

---

### Task 2: UA 粗分类工具

**Files:**
- Create: `apps/server/src/common/utils/user-agent.util.ts`
- Test: `apps/server/src/common/utils/user-agent.util.test.ts`

**Interfaces:**
- Consumes: 无
- Produces:
  - `type PlatformClass = 'ipad'|'iphone'|'android_tablet'|'android_phone'|'mac'|'windows'|'linux'|'other'`
  - `type BrowserClass = 'chrome'|'safari'|'edge'|'firefox'|'electron'|'other'`
  - `parseUserAgent(ua: string | null | undefined): { platformClass: PlatformClass | null; browser: BrowserClass | null }`（**memoized**，同一 UA 字符串返回**同一个对象引用**）
  - `clearUserAgentCache(): void`（测试用）

- [ ] **Step 1: 写失败测试**

Create `apps/server/src/common/utils/user-agent.util.test.ts`：

```ts
import { describe, it, expect, beforeEach } from 'vitest';
import { parseUserAgent, clearUserAgentCache } from './user-agent.util.js';

// 真实 UA 片段（截取足以区分平台/浏览器的部分）
const UA = {
  ipadSafari:
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15',
  macChrome:
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
  iphoneSafari:
    'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
  androidTablet:
    'Mozilla/5.0 (Linux; Android 13; SM-X700) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
  androidPhone:
    'Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Mobile Safari/537.36',
  windowsEdge:
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36 Edg/126.0.0.0',
  windowsFirefox:
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:127.0) Gecko/20100101 Firefox/127.0',
  linuxChrome:
    'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
  electron:
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) k12-desktop/1.0.0 Chrome/126.0.0.0 Electron/31.0.0 Safari/537.36',
} as const;

beforeEach(() => clearUserAgentCache());

describe('parseUserAgent', () => {
  it.each([
    ['iPad Safari（UA 写的是 Macintosh——单看 UA 会误判，校正由 service 做）', UA.ipadSafari, 'mac', 'safari'],
    ['Mac Chrome', UA.macChrome, 'mac', 'chrome'],
    ['iPhone Safari', UA.iphoneSafari, 'iphone', 'safari'],
    ['Android 平板（UA 无 Mobile）', UA.androidTablet, 'android_tablet', 'chrome'],
    ['Android 手机（UA 有 Mobile）', UA.androidPhone, 'android_phone', 'chrome'],
    ['Windows Edge', UA.windowsEdge, 'windows', 'edge'],
    ['Windows Firefox', UA.windowsFirefox, 'windows', 'firefox'],
    ['Linux Chrome', UA.linuxChrome, 'linux', 'chrome'],
    ['Electron 壳（浏览器判定优先于 Chrome）', UA.electron, 'mac', 'electron'],
  ])('%s', (_label, ua, platformClass, browser) => {
    expect(parseUserAgent(ua)).toEqual({ platformClass, browser });
  });

  it('空 / 缺失 UA → 两个 null（不编造 other）', () => {
    expect(parseUserAgent(null)).toEqual({ platformClass: null, browser: null });
    expect(parseUserAgent(undefined)).toEqual({ platformClass: null, browser: null });
    expect(parseUserAgent('')).toEqual({ platformClass: null, browser: null });
  });

  it('无法识别的 UA → other/other', () => {
    expect(parseUserAgent('SomeRandomBot/1.0')).toEqual({
      platformClass: 'other',
      browser: 'other',
    });
  });

  it('同一 UA 字符串走 memoize：返回同一个对象引用', () => {
    const first = parseUserAgent(UA.macChrome);
    const second = parseUserAgent(UA.macChrome);
    expect(second).toBe(first); // 引用相等 = 没有重新解析
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

```bash
cd apps/server && npx vitest run src/common/utils/user-agent.util.test.ts
```

Expected: FAIL —— `Failed to resolve import "./user-agent.util.js"`。

- [ ] **Step 3: 实现**

Create `apps/server/src/common/utils/user-agent.util.ts`：

```ts
/**
 * User-Agent 粗分类（**只到类别**，不存原始 UA 字符串、不做设备指纹）。
 *
 * 为什么不引 `ua-parser` / `bowser`：我们只需要约 8 个平台档 + 6 个浏览器档、
 * 不要版本号，自研粗正则足够，且省一个依赖（spec §4.2）。
 *
 * 为什么 memoize：本函数在每个采集请求上调用（心跳 30s 一次），而学生群体里
 * UA 字符串的分布极窄（同一台设备反复请求）。按**原始 UA 字符串**缓存解析结果，
 * 命中即返回同一个对象——调用方**不得**修改返回值。
 *
 * ⚠️ iPadOS 13+ 的 Safari UA 写的是 `Macintosh`（苹果的 desktop-class browsing 策略），
 * 单看这里**必然**把 iPad 判成 mac。产品的主断点是 iPad 横屏，误判会让设备报表失去意义。
 * 校正放在 `StudySessionsService`（那里同时有前端上报的 `input_type`）：
 * `platform_class === 'mac' && input_type === 'touch' → 'ipad'`。
 */

export type PlatformClass =
  | 'ipad'
  | 'iphone'
  | 'android_tablet'
  | 'android_phone'
  | 'mac'
  | 'windows'
  | 'linux'
  | 'other';

export type BrowserClass = 'chrome' | 'safari' | 'edge' | 'firefox' | 'electron' | 'other';

export interface UserAgentInfo {
  platformClass: PlatformClass | null;
  browser: BrowserClass | null;
}

/** 缓存上限：UA 种类很少，超过就整体清空（比 LRU 简单，且不会无限增长）。 */
const CACHE_MAX = 500;
const cache = new Map<string, UserAgentInfo>();

/** 测试用：清空 memoize 缓存，保证用例互不影响。 */
export function clearUserAgentCache(): void {
  cache.clear();
}

function detectPlatform(ua: string): PlatformClass {
  // iPad 要排在最前：它的 UA 同时含 `Macintosh` 与 `Mobile` 之外的特征，顺序错会落到 mac。
  if (/iPad/i.test(ua)) return 'ipad';
  if (/iPhone|iPod/i.test(ua)) return 'iphone';
  if (/Android/i.test(ua)) return /Mobile/i.test(ua) ? 'android_phone' : 'android_tablet';
  if (/Macintosh|Mac OS X/i.test(ua)) return 'mac';
  if (/Windows/i.test(ua)) return 'windows';
  if (/Linux/i.test(ua)) return 'linux';
  return 'other';
}

function detectBrowser(ua: string): BrowserClass {
  // Electron 必须排在 Chrome 之前——Electron 的 UA 里同时含 `Chrome/`。
  if (/Electron/i.test(ua)) return 'electron';
  if (/Edg\//i.test(ua)) return 'edge';
  if (/Chrome\/|CriOS/i.test(ua)) return 'chrome';
  if (/Firefox\/|FxiOS/i.test(ua)) return 'firefox';
  if (/Safari\//i.test(ua) && !/Chromium/i.test(ua)) return 'safari';
  return 'other';
}

export function parseUserAgent(ua: string | null | undefined): UserAgentInfo {
  if (!ua) return { platformClass: null, browser: null };

  const hit = cache.get(ua);
  if (hit) return hit;

  const info: UserAgentInfo = {
    platformClass: detectPlatform(ua),
    browser: detectBrowser(ua),
  };

  if (cache.size >= CACHE_MAX) cache.clear();
  cache.set(ua, info);
  return info;
}
```

- [ ] **Step 4: 跑测试确认通过**

```bash
cd apps/server && npx vitest run src/common/utils/user-agent.util.test.ts
```

Expected: PASS（13 条）。若 `iPad Safari` 那条失败，检查 `detectPlatform` 里 `Macintosh` 分支是否被 `/iPad/` 抢先——注意上面那台 iPad 的 UA **确实**含 `Macintosh`，所以此处预期就是 `mac`（校正发生在服务层）。

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/common/utils/user-agent.util.ts apps/server/src/common/utils/user-agent.util.test.ts
git commit -m "feat(analytics): UA 粗分类工具（平台/浏览器 + memoize）"
```

---

### Task 3: `StudySessionsRepository`

**Files:**
- Create: `apps/server/src/database/repositories/study-sessions.repo.ts`
- Test: `apps/server/src/database/repositories/study-sessions.repo.test.ts`
- Modify: `apps/server/src/database/repositories/index.ts`

**Interfaces:**
- Consumes: 表 `study_sessions`（Task 1）
- Produces:
  - `interface StudySessionRow extends RowDataPacket`（列名同表，`id: number` … `created_at: Date`）
  - `interface StudySessionInsertInput { studentId; sessionUid; module; scene; subjectId; refType; refId; platformClass; browser; screenClass; inputType; appShell }`（后 5 个均 `string | null`）
  - `class StudySessionsRepository`
    - `findByUid(sessionUid: string): Promise<StudySessionRow | null>`（**不按学生过滤**——调用方要能区分「别人的 uid」）
    - `insert(input: StudySessionInsertInput): Promise<boolean>`（`true` = 真新建）
    - `heartbeat(sessionUid: string, studentId: number, state: 'visible' | 'hidden'): Promise<number | null>`（返回累计秒数；`null` = 没命中活跃会话）
    - `end(sessionUid: string, studentId: number, reason: string): Promise<{ activeSeconds: number; endedAt: Date } | null>`
    - `closeStale(studentId?: number): Promise<number>`（把 `active` 且心跳超 5 分钟的会话收尾，返回行数）

- [ ] **Step 1: 写失败测试**

Create `apps/server/src/database/repositories/study-sessions.repo.test.ts`：

```ts
import { describe, it, expect, vi } from 'vitest';
import { StudySessionsRepository } from './study-sessions.repo.js';

const mockPool = (opts: { rows?: any[]; affectedRows?: number } = {}) => {
  const { rows = [], affectedRows = 1 } = opts;
  return {
    execute: vi.fn().mockImplementation((sql: string) => {
      if (/^\s*INSERT/i.test(sql)) return Promise.resolve([{ insertId: 1, affectedRows }, []]);
      if (/^\s*UPDATE/i.test(sql)) {
        return Promise.resolve([{ affectedRows, changedRows: affectedRows }, []]);
      }
      return Promise.resolve([rows, []]);
    }),
    query: vi.fn().mockResolvedValue([rows, []]),
  };
};

const insertInput = () => ({
  studentId: 9,
  sessionUid: '3f2504e0-4f89-11d3-9a0c-0305e82c3301',
  module: 'training_targeted',
  scene: 'targeted_run',
  subjectId: 1,
  refType: null,
  refId: null,
  platformClass: 'ipad',
  browser: 'safari',
  screenClass: 'ipad_landscape',
  inputType: 'touch',
  appShell: 'web',
});

describe('StudySessionsRepository.insert', () => {
  it('INSERT IGNORE 落一行，列序与参数一一对应', async () => {
    const pool = mockPool({ affectedRows: 1 });
    const repo = new StudySessionsRepository(pool as any);
    expect(await repo.insert(insertInput())).toBe(true);

    const [sql, params] = pool.execute.mock.calls[0];
    expect(sql).toContain('INSERT IGNORE INTO study_sessions');
    expect(sql).toContain(
      '(student_id, session_uid, module, scene, subject_id, ref_type, ref_id, platform_class, browser, screen_class, input_type, app_shell)',
    );
    expect(params).toEqual([
      9,
      '3f2504e0-4f89-11d3-9a0c-0305e82c3301',
      'training_targeted',
      'targeted_run',
      1,
      null,
      null,
      'ipad',
      'safari',
      'ipad_landscape',
      'touch',
      'web',
    ]);
  });

  it('撞 uniq_ss_uid（affectedRows=0）→ false（幂等，不新建）', async () => {
    const pool = mockPool({ affectedRows: 0 });
    const repo = new StudySessionsRepository(pool as any);
    expect(await repo.insert(insertInput())).toBe(false);
  });
});

describe('StudySessionsRepository.heartbeat', () => {
  it('增量封顶 45s，且用 GREATEST 防负数（时钟回拨）', async () => {
    const pool = mockPool({ affectedRows: 1, rows: [{ active_seconds: 120 }] });
    const repo = new StudySessionsRepository(pool as any);
    const seconds = await repo.heartbeat('uid-1', 9, 'hidden');

    expect(seconds).toBe(120);
    const [updateSql, updateParams] = pool.execute.mock.calls[0];
    expect(updateSql).toContain('LEAST(TIMESTAMPDIFF(SECOND, last_heartbeat_at, NOW(3)), 45)');
    expect(updateSql).toContain('GREATEST(0,');
    expect(updateSql).toContain("IF(client_state = 'visible'");
    expect(updateSql).toContain('heartbeat_count = heartbeat_count + 1');
    expect(updateSql).toContain("WHERE session_uid = ? AND student_id = ? AND status = 'active'");
    // 顺序是 load-bearing：MySQL 的 SET 从左到右求值，后出现的表达式会看到**已赋值**的新值。
    // 若把 `client_state = ?` 挪到 IF 之前，IF 就会读到本次上报的新状态（hidden 心跳不再补计
    // 最后一段 visible、visible 心跳反而把 hidden 期间也计上），静默算错时长。
    const ifIndex = updateSql.indexOf("IF(client_state = 'visible'");
    const assignIndex = updateSql.indexOf('client_state = ?');
    expect(ifIndex).toBeGreaterThanOrEqual(0);
    expect(assignIndex).toBeGreaterThan(ifIndex);
    expect(updateParams).toEqual(['hidden', 'uid-1', 9]);
  });

  it('没命中活跃会话（affectedRows=0）→ null，不报错', async () => {
    const pool = mockPool({ affectedRows: 0 });
    const repo = new StudySessionsRepository(pool as any);
    expect(await repo.heartbeat('uid-x', 9, 'visible')).toBeNull();
  });
});

describe('StudySessionsRepository.end', () => {
  it('结束时补计最后一段并落 end_reason', async () => {
    const pool = mockPool({ affectedRows: 1, rows: [{ active_seconds: 300, ended_at: new Date('2026-09-19T10:00:00Z') }] });
    const repo = new StudySessionsRepository(pool as any);
    const out = await repo.end('uid-1', 9, 'route_change');

    const [sql] = pool.execute.mock.calls[0];
    expect(sql).toContain("status = 'ended'");
    expect(sql).toContain('end_reason = ?');
    expect(sql).toContain('ended_at = NOW(3)');
    expect(out?.activeSeconds).toBe(300);
  });

  it('没命中（已结束/不存在）→ null', async () => {
    const pool = mockPool({ affectedRows: 0, rows: [] });
    const repo = new StudySessionsRepository(pool as any);
    expect(await repo.end('uid-x', 9, 'route_change')).toBeNull();
  });
});

describe('StudySessionsRepository.closeStale', () => {
  it('按学生收尾：end_reason=closed、ended_at=最后一次心跳', async () => {
    const pool = mockPool({ affectedRows: 3 });
    const repo = new StudySessionsRepository(pool as any);
    expect(await repo.closeStale(9)).toBe(3);

    const [sql, params] = pool.execute.mock.calls[0];
    expect(sql).toContain("status = 'ended', end_reason = 'closed', ended_at = last_heartbeat_at");
    expect(sql).toContain("WHERE status = 'active' AND last_heartbeat_at < NOW(3) - INTERVAL 5 MINUTE");
    expect(sql).toContain('AND student_id = ?');
    expect(params).toEqual([9]);
  });

  it('不传 studentId → 全库收尾（夜间兜底用）', async () => {
    const pool = mockPool({ affectedRows: 0 });
    const repo = new StudySessionsRepository(pool as any);
    await repo.closeStale();
    const [sql, params] = pool.execute.mock.calls[0];
    expect(sql).not.toContain('student_id = ?');
    expect(params).toEqual([]);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

```bash
cd apps/server && npx vitest run src/database/repositories/study-sessions.repo.test.ts
```

Expected: FAIL —— 模块不存在。

- [ ] **Step 3: 实现**

Create `apps/server/src/database/repositories/study-sessions.repo.ts`：

```ts
import { Injectable, Inject } from '@nestjs/common';
import type { Pool, ResultSetHeader, RowDataPacket } from 'mysql2/promise';

export interface StudySessionRow extends RowDataPacket {
  id: number;
  student_id: number;
  session_uid: string;
  module: string;
  scene: string;
  subject_id: number | null;
  ref_type: string | null;
  ref_id: number | null;
  status: 'active' | 'ended' | 'abandoned';
  client_state: 'visible' | 'hidden';
  active_seconds: number;
  heartbeat_count: number;
  started_at: Date;
  last_heartbeat_at: Date;
  ended_at: Date | null;
  end_reason: string | null;
  platform_class: string | null;
  browser: string | null;
  screen_class: string | null;
  input_type: string | null;
  app_shell: string | null;
  created_at: Date;
  updated_at: Date;
}

export interface StudySessionInsertInput {
  studentId: number;
  sessionUid: string;
  module: string;
  scene: string;
  subjectId: number | null;
  refType: string | null;
  refId: number | null;
  platformClass: string | null;
  browser: string | null;
  screenClass: string | null;
  inputType: string | null;
  appShell: string | null;
}

const INSERT_COLUMNS =
  '(student_id, session_uid, module, scene, subject_id, ref_type, ref_id, platform_class, browser, screen_class, input_type, app_shell)';

/**
 * 学习会话仓储（`study_sessions`，学习时长的唯一真源）。
 *
 * **两条纪律**（spec §3）：
 * 1. `active_seconds` 只在这里累加，且**单次封顶 45s**——不封顶时「关标签 2 小时」
 *    会在下一次心跳被算成 2 小时。`GREATEST(0, ...)` 兜住客户端/DB 时钟回拨。
 * 2. 所有写入都是**业务数据直写**：调用方（service）必须包 try/catch，失败只 warn、绝不 500。
 *    心跳失败前端无感，是刻意的。
 *
 * 心跳 / 结束都带 `status = 'active'` 条件——这是乐观锁：会话一旦 ended，
 * 迟到的请求只会影响 0 行，不会把已结算的秒数再动一遍。
 */
@Injectable()
export class StudySessionsRepository {
  constructor(@Inject('DATABASE_POOL') private readonly pool: Pool) {}

  /**
   * 按 session_uid 查（**不按 student 过滤**）。
   *
   * 故意不按学生过滤：`session_uid` 是前端生成的，服务层需要能分辨
   * 「这个 uid 被别的学生占用了」并拒掉，而不是静默把别人会话的 startedAt 返回。
   * 数据泄漏面为零——service 只在比对 `student_id` 后使用，不会把行内容回给调用方。
   */
  async findByUid(sessionUid: string): Promise<StudySessionRow | null> {
    const [rows] = await this.pool.execute<StudySessionRow[]>(
      `SELECT * FROM study_sessions WHERE session_uid = ? LIMIT 1`,
      [sessionUid],
    );
    return rows[0] ?? null;
  }

  /** `true` = 真新建；撞 `uniq_ss_uid` → `false`（幂等，调用方回读既有会话）。 */
  async insert(input: StudySessionInsertInput): Promise<boolean> {
    const [result] = await this.pool.execute<ResultSetHeader>(
      `INSERT IGNORE INTO study_sessions ${INSERT_COLUMNS} VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        input.studentId,
        input.sessionUid,
        input.module,
        input.scene,
        input.subjectId,
        input.refType,
        input.refId,
        input.platformClass,
        input.browser,
        input.screenClass,
        input.inputType,
        input.appShell,
      ],
    );
    return result.affectedRows === 1;
  }

  /**
   * 心跳：按「上次心跳」到现在累加秒数，**只在上一状态为 visible 时计**（hidden 暂停计时）。
   *
   * ⚠️ **本语句的列顺序是 load-bearing 的**。MySQL 对单表 `SET` 列表**从左到右**求值，
   * 后出现的表达式若引用前面已赋值的列，读到的是**新值**——并不是「所有表达式都用更新前的值」。
   * 因此 `IF(client_state = 'visible', ...)`（读**旧**状态）**必须排在 `client_state = ?`
   * （写**新**状态）之前**。顺序反了照样能编译运行，但 IF 会读到本次上报的新状态：
   * hidden 心跳不再补计最后一段 visible、visible 心跳反而把 hidden 期间也计上，**静默算错时长**。
   * 单测里有一条 index 顺序钉子（`assignIndex > ifIndex`）守着这一点。
   *
   * 也不要拆成两条 SQL（会有竞态窗口）。
   *
   * 返回累计秒数；`null` = 会话不存在 / 非本人 / 非 active（调用方**静默 200**，不报错——
   * 心跳是尽力而为，报错只会污染前端日志）。
   */
  async heartbeat(
    sessionUid: string,
    studentId: number,
    state: 'visible' | 'hidden',
  ): Promise<number | null> {
    const [result] = await this.pool.execute<ResultSetHeader>(
      `UPDATE study_sessions
       SET active_seconds = active_seconds
             + IF(client_state = 'visible',
                  GREATEST(0, LEAST(TIMESTAMPDIFF(SECOND, last_heartbeat_at, NOW(3)), 45)),
                  0),
           client_state = ?,
           heartbeat_count = heartbeat_count + 1,
           last_heartbeat_at = NOW(3)
       WHERE session_uid = ? AND student_id = ? AND status = 'active'`,
      [state, sessionUid, studentId],
    );
    if (result.affectedRows === 0) return null;

    const [rows] = await this.pool.execute<(RowDataPacket & { active_seconds: number })[]>(
      `SELECT active_seconds FROM study_sessions WHERE session_uid = ? LIMIT 1`,
      [sessionUid],
    );
    return Number(rows[0]?.active_seconds ?? 0);
  }

  /**
   * 结束会话：先补计最后一段（同心跳的封顶规则，但**不改** `client_state`），再落状态。
   *
   * `ended_at = NOW(3)` 而不是 `last_heartbeat_at`：用户按「离开」时已经过了一段时间，
   * 秒数已按 `last_heartbeat_at → NOW(3)` 补进来，结束时刻就该是现在。
   */
  async end(
    sessionUid: string,
    studentId: number,
    reason: string,
  ): Promise<{ activeSeconds: number; endedAt: Date } | null> {
    const [result] = await this.pool.execute<ResultSetHeader>(
      `UPDATE study_sessions
       SET active_seconds = active_seconds
             + IF(client_state = 'visible',
                  GREATEST(0, LEAST(TIMESTAMPDIFF(SECOND, last_heartbeat_at, NOW(3)), 45)),
                  0),
           status = 'ended',
           end_reason = ?,
           ended_at = NOW(3),
           last_heartbeat_at = NOW(3)
       WHERE session_uid = ? AND student_id = ? AND status = 'active'`,
      [reason, sessionUid, studentId],
    );
    if (result.affectedRows === 0) return null;

    const [rows] = await this.pool.execute<
      (RowDataPacket & { active_seconds: number; ended_at: Date })[]
    >(
      `SELECT active_seconds, ended_at FROM study_sessions WHERE session_uid = ? LIMIT 1`,
      [sessionUid],
    );
    const row = rows[0];
    return row ? { activeSeconds: Number(row.active_seconds), endedAt: row.ended_at } : null;
  }

  /**
   * 惰性收尾：`active` 且心跳超 5 分钟的会话视为已结束。
   *
   * 为什么需要：用户直接关标签 / 断网时不会有 `end` 请求，会话会永远 `active`——
   * 「今日已用时长」会一直不更新。收尾时 `ended_at = last_heartbeat_at`
   * （不是 NOW），因为最后 5 分钟的实际状态未知，不能白送时长。
   *
   * `studentId` 可选：家长查单人时传（顺带修正那个人），夜间任务不传（全库兜底）。
   */
  async closeStale(studentId?: number): Promise<number> {
    const where = studentId === undefined ? '' : ' AND student_id = ?';
    const params = studentId === undefined ? [] : [studentId];
    const [result] = await this.pool.execute<ResultSetHeader>(
      `UPDATE study_sessions
       SET status = 'ended', end_reason = 'closed', ended_at = last_heartbeat_at
       WHERE status = 'active' AND last_heartbeat_at < NOW(3) - INTERVAL 5 MINUTE${where}`,
      params,
    );
    return result.affectedRows;
  }
}
```

- [ ] **Step 4: 跑测试确认通过**

```bash
cd apps/server && npx vitest run src/database/repositories/study-sessions.repo.test.ts
```

Expected: PASS（8 条）

- [ ] **Step 5: 加进 barrel**

在 `apps/server/src/database/repositories/index.ts` 末尾追加：

```ts
export { StudySessionsRepository } from './study-sessions.repo.js';
export type { StudySessionRow, StudySessionInsertInput } from './study-sessions.repo.js';
```

- [ ] **Step 6: Commit**

```bash
git add apps/server/src/database/repositories/study-sessions.repo.ts apps/server/src/database/repositories/study-sessions.repo.test.ts apps/server/src/database/repositories/index.ts
git commit -m "feat(analytics): StudySessionsRepository（心跳封顶增量 + 惰性收尾）"
```

---

### Task 4: `StudySessionsService`

**Files:**
- Create: `apps/server/src/modules/analytics/study-sessions.service.ts`
- Test: `apps/server/src/modules/analytics/study-sessions.service.test.ts`

**Interfaces:**
- Consumes: `StudySessionsRepository`（Task 3）、`parseUserAgent`（Task 2）、`SubjectsRepository`
- Produces:
  - 封闭字典常量 `STUDY_MODULES` / `STUDY_SCENES` / `END_REASONS`（**不导出**数字阈值常量——45s 封顶与 5min 收尾是 SQL 字面量，见实现处注释）
  - `type StudyModule` / `type StudyScene`（spec §5.1 的封闭枚举，供 controller 复用）
  - `interface StartSessionInput { studentId; sessionUid; module; scene; subjectId?; refType?; refId?; screenClass?; inputType?; appShell?; userAgent?: string | null }`
  - `class StudySessionsService`
    - `start(input): Promise<{ sessionUid: string; startedAt: Date }>`
    - `heartbeat(input: { studentId; sessionUid; state }): Promise<{ activeSeconds: number | null }>`
    - `end(input: { studentId; sessionUid; reason }): Promise<{ activeSeconds: number | null; endedAt: Date | null }>`
    - `closeStale(studentId?: number): Promise<number>`

- [ ] **Step 1: 写失败测试**

Create `apps/server/src/modules/analytics/study-sessions.service.test.ts`：

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { BadRequestException } from '@nestjs/common';
import { StudySessionsService } from './study-sessions.service.js';
import type { StudySessionsRepository, StudySessionRow } from '../../database/repositories/study-sessions.repo.js';
import type { SubjectsRepository } from '../../database/repositories/subjects.repo.js';

const MAC_CHROME_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

function makeRepo(overrides: Partial<StudySessionsRepository> = {}) {
  return {
    findByUid: vi.fn().mockResolvedValue(null),
    insert: vi.fn().mockResolvedValue(true),
    heartbeat: vi.fn().mockResolvedValue(60),
    end: vi.fn().mockResolvedValue({ activeSeconds: 90, endedAt: new Date('2026-09-19T10:00:00Z') }),
    closeStale: vi.fn().mockResolvedValue(0),
    ...overrides,
  } as unknown as StudySessionsRepository;
}

function makeSubjects(ids: number[] = [1, 2, 3]) {
  return { findAll: vi.fn().mockResolvedValue(ids.map((id) => ({ id }))) } as unknown as SubjectsRepository;
}

const baseInput = () => ({
  studentId: 9,
  sessionUid: '3f2504e0-4f89-11d3-9a0c-0305e82c3301',
  module: 'training_targeted',
  scene: 'targeted_run',
  userAgent: MAC_CHROME_UA,
});

describe('StudySessionsService.start', () => {
  let repo: StudySessionsRepository;

  beforeEach(() => {
    repo = makeRepo();
  });

  it('新建：解析 UA + 落库，返回 startedAt', async () => {
    const service = new StudySessionsService(repo, makeSubjects());
    const out = await service.start({ ...baseInput(), inputType: 'mouse', screenClass: 'desktop' });

    expect(out.sessionUid).toBe('3f2504e0-4f89-11d3-9a0c-0305e82c3301');
    expect(out.startedAt).toBeInstanceOf(Date);
    const arg = (repo.insert as any).mock.calls[0][0];
    expect(arg.platformClass).toBe('mac');
    expect(arg.browser).toBe('chrome');
    expect(arg.inputType).toBe('mouse');
    expect(arg.screenClass).toBe('desktop');
  });

  it('iPad 校正：Macintosh UA + input_type=touch → platform_class=ipad', async () => {
    const service = new StudySessionsService(repo, makeSubjects());
    await service.start({ ...baseInput(), inputType: 'touch' });
    expect((repo.insert as any).mock.calls[0][0].platformClass).toBe('ipad');
  });

  it('Macintosh UA + input_type=mouse → 仍是 mac（不误判）', async () => {
    const service = new StudySessionsService(repo, makeSubjects());
    await service.start({ ...baseInput(), inputType: 'mouse' });
    expect((repo.insert as any).mock.calls[0][0].platformClass).toBe('mac');
  });

  it('设备字段非法 → 存 NULL，不报错（设备信息是尽力而为）', async () => {
    const service = new StudySessionsService(repo, makeSubjects());
    await service.start({ ...baseInput(), screenClass: 'nintendo-switch', inputType: 'wand', appShell: 'wechat' });
    const arg = (repo.insert as any).mock.calls[0][0];
    expect(arg.screenClass).toBeNull();
    expect(arg.inputType).toBeNull();
    expect(arg.appShell).toBeNull();
  });

  it('sessionUid 非 UUID → 1001', async () => {
    const service = new StudySessionsService(repo, makeSubjects());
    await expect(service.start({ ...baseInput(), sessionUid: 'not-a-uuid' })).rejects.toBeInstanceOf(
      BadRequestException,
    );
    expect(repo.insert).not.toHaveBeenCalled();
  });

  it('module / scene 不在白名单 → 1001', async () => {
    const service = new StudySessionsService(repo, makeSubjects());
    await expect(service.start({ ...baseInput(), module: 'hacked' })).rejects.toBeInstanceOf(BadRequestException);
    await expect(service.start({ ...baseInput(), scene: 'hacked' })).rejects.toBeInstanceOf(BadRequestException);
  });

  it('subjectId 不属于在售学科 → 1001', async () => {
    const service = new StudySessionsService(repo, makeSubjects([1, 2, 3]));
    await expect(service.start({ ...baseInput(), subjectId: 999 })).rejects.toBeInstanceOf(BadRequestException);
  });

  it('sessionUid 重复且是本人 → 幂等返回既有 startedAt，不新建', async () => {
    const existing = {
      session_uid: baseInput().sessionUid,
      student_id: 9,
      started_at: new Date('2026-09-19T09:00:00Z'),
    } as StudySessionRow;
    const r = makeRepo({ findByUid: vi.fn().mockResolvedValue(existing) });
    const service = new StudySessionsService(r, makeSubjects());

    const out = await service.start(baseInput());
    expect(out.startedAt).toEqual(existing.started_at);
    expect(r.insert).not.toHaveBeenCalled();
  });

  it('sessionUid 被别的学生占用 → 1001（不泄漏别人的会话）', async () => {
    const foreign = {
      session_uid: baseInput().sessionUid,
      student_id: 404,
      started_at: new Date(),
    } as StudySessionRow;
    const r = makeRepo({ findByUid: vi.fn().mockResolvedValue(foreign) });
    const service = new StudySessionsService(r, makeSubjects());
    await expect(service.start(baseInput())).rejects.toBeInstanceOf(BadRequestException);
    expect(r.insert).not.toHaveBeenCalled();
  });
});

describe('StudySessionsService.heartbeat', () => {
  it('命中 → 返回累计秒数', async () => {
    const repo = makeRepo({ heartbeat: vi.fn().mockResolvedValue(123) });
    const service = new StudySessionsService(repo, makeSubjects());
    await expect(
      service.heartbeat({ studentId: 9, sessionUid: baseInput().sessionUid, state: 'visible' }),
    ).resolves.toEqual({ activeSeconds: 123 });
  });

  it('未命中 / 非本人 / 已结束 → activeSeconds:null（静默，不抛）', async () => {
    const repo = makeRepo({ heartbeat: vi.fn().mockResolvedValue(null) });
    const service = new StudySessionsService(repo, makeSubjects());
    await expect(
      service.heartbeat({ studentId: 9, sessionUid: baseInput().sessionUid, state: 'visible' }),
    ).resolves.toEqual({ activeSeconds: null });
  });

  it('state 非法 → 1001（这是契约，不静默）', async () => {
    const repo = makeRepo();
    const service = new StudySessionsService(repo, makeSubjects());
    await expect(
      service.heartbeat({ studentId: 9, sessionUid: baseInput().sessionUid, state: 'zzz' as never }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });
});

describe('StudySessionsService.end', () => {
  it('命中 → 返回累计秒数与结束时刻', async () => {
    const repo = makeRepo();
    const service = new StudySessionsService(repo, makeSubjects());
    const out = await service.end({ studentId: 9, sessionUid: baseInput().sessionUid, reason: 'route_change' });
    expect(out.activeSeconds).toBe(90);
    expect(out.endedAt).toBeInstanceOf(Date);
  });

  it('已结束 → 回读现有值（幂等），不报错', async () => {
    const existing = {
      session_uid: baseInput().sessionUid,
      student_id: 9,
      active_seconds: 90,
      ended_at: new Date('2026-09-19T10:00:00Z'),
    } as StudySessionRow;
    const repo = makeRepo({ end: vi.fn().mockResolvedValue(null), findByUid: vi.fn().mockResolvedValue(existing) });
    const service = new StudySessionsService(repo, makeSubjects());
    const out = await service.end({ studentId: 9, sessionUid: baseInput().sessionUid, reason: 'pagehide' });
    expect(out.activeSeconds).toBe(90);
    expect(out.endedAt).toEqual(existing.ended_at);
  });

  it('reason 非法 → 1001', async () => {
    const service = new StudySessionsService(makeRepo(), makeSubjects());
    await expect(
      service.end({ studentId: 9, sessionUid: baseInput().sessionUid, reason: 'rage_quit' }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

```bash
cd apps/server && npx vitest run src/modules/analytics/study-sessions.service.test.ts
```

Expected: FAIL —— 模块不存在。

- [ ] **Step 3: 实现**

Create `apps/server/src/modules/analytics/study-sessions.service.ts`：

```ts
import { BadRequestException, Inject, Injectable } from '@nestjs/common';
import { StudySessionsRepository } from '../../database/repositories/study-sessions.repo.js';
import type { StudySessionRow } from '../../database/repositories/study-sessions.repo.js';
import { parseUserAgent } from '../../common/utils/user-agent.util.js';
import type { PlatformClass } from '../../common/utils/user-agent.util.js';

/**
 * 三个时长阈值（45s 单次封顶 / 5min 惰性收尾 / 前端 30s 心跳间隔）在此**不导出为常量**：
 * 它们只作为 SQL 字面量出现（见 `study-sessions.repo.ts` 的两处 `LEAST(..., 45)` 与
 * `INTERVAL 5 MINUTE`），导出会变成没人引用的死代码。要改封顶值，得同时改那两处 SQL
 * 和守着顺序的 index 钉子测试——不是改一个常量。
 */

/** `module` / `scene` 是封闭字典（spec §5.1）——**唯一真源在后端**，前端 `sceneMap.ts` 只能取这里的值。 */
export const STUDY_MODULES = [
  'mainline',
  'aux_qna',
  'training_targeted',
  'training_error_practice',
  'exam',
  'chinese_dictation',
  'chinese_interpretation',
  'chinese_meaning',
  'en_vocabulary',
] as const;
export type StudyModule = (typeof STUDY_MODULES)[number];

export const STUDY_SCENES = [
  'course_detail',
  'star_map',
  'aux_chat',
  'targeted_run',
  'error_run',
  'exam_run',
  'dictation_run',
  'interpretation_run',
  'meaning_run',
  'vocabulary_run',
  'profile',
  'rewards',
] as const;
export type StudyScene = (typeof STUDY_SCENES)[number];

export const END_REASONS = [
  'route_change',
  'pagehide',
  'idle_timeout',
  'closed',
  'hidden_timeout',
] as const;
export type EndReason = (typeof END_REASONS)[number];

const SCREEN_CLASSES = ['ipad_landscape', 'desktop', 'tablet_portrait', 'mobile'] as const;
const INPUT_TYPES = ['touch', 'mouse', 'hybrid'] as const;
const APP_SHELLS = ['web', 'electron'] as const;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface StartSessionInput {
  studentId: number;
  sessionUid: string;
  module: string;
  scene: string;
  subjectId?: number | null;
  refType?: string | null;
  refId?: number | null;
  screenClass?: string | null;
  inputType?: string | null;
  appShell?: string | null;
  /** 服务端从请求头取，**不接受客户端上报**（伪造 UA 是弱信号，但至少比自报强）。 */
  userAgent?: string | null;
}

/** 白名单命中就取原值，否则 NULL——设备信息是**尽力而为**，非法值不报错（spec §8.1）。 */
function pick<T extends string>(allowed: readonly T[], value: string | null | undefined): T | null {
  return value != null && (allowed as readonly string[]).includes(value) ? (value as T) : null;
}

@Injectable()
export class StudySessionsService {
  constructor(
    @Inject(StudySessionsRepository) private readonly repo: StudySessionsRepository,
    @Inject('SUBJECTS_REPO_FOR_ANALYTICS') private readonly subjectsRepo: SubjectsRepoLike,
  ) {}

  /**
   * 开始（或幂等复用）一段学习会话。
   *
   * 幂等：`session_uid` 由前端生成，重复 POST 必须返回**既有**会话而不是新建
   * （前端路由抖动 / 重试会重复发）。但若该 uid 已被**别的学生**占用 → 1001：
   * 静默返回别人的 startedAt 会让前端以为自己的会话在跑，而后续心跳全会落空。
   */
  async start(input: StartSessionInput): Promise<{ sessionUid: string; startedAt: Date }> {
    if (!UUID_RE.test(input.sessionUid)) {
      throw new BadRequestException({ code: 1001, message: 'sessionUid 必须是 UUID' });
    }
    if (!(STUDY_MODULES as readonly string[]).includes(input.module)) {
      throw new BadRequestException({ code: 1001, message: `未知 module：${input.module}` });
    }
    if (!(STUDY_SCENES as readonly string[]).includes(input.scene)) {
      throw new BadRequestException({ code: 1001, message: `未知 scene：${input.scene}` });
    }

    const existing = await this.repo.findByUid(input.sessionUid);
    if (existing) {
      if (existing.student_id !== input.studentId) {
        throw new BadRequestException({ code: 1001, message: '会话标识冲突' });
      }
      return { sessionUid: input.sessionUid, startedAt: existing.started_at };
    }

    if (input.subjectId != null) {
      const subjects = await this.subjectsRepo.findAll();
      if (!subjects.some((s) => s.id === input.subjectId)) {
        throw new BadRequestException({ code: 1001, message: `未知学科：${input.subjectId}` });
      }
    }

    const inputType = pick(INPUT_TYPES, input.inputType);
    const ua = parseUserAgent(input.userAgent);
    const platformClass = correctIpad(ua.platformClass, inputType);

    const created = await this.repo.insert({
      studentId: input.studentId,
      sessionUid: input.sessionUid,
      module: input.module,
      scene: input.scene,
      subjectId: input.subjectId ?? null,
      refType: input.refType ?? null,
      refId: input.refId ?? null,
      platformClass,
      browser: ua.browser,
      screenClass: pick(SCREEN_CLASSES, input.screenClass),
      inputType,
      appShell: pick(APP_SHELLS, input.appShell),
    });

    // 竞态兜底：findByUid 与 insert 之间被并发插入 → INSERT IGNORE 返回 false，回读既有行。
    if (!created) {
      const row = await this.repo.findByUid(input.sessionUid);
      if (row) return { sessionUid: input.sessionUid, startedAt: row.started_at };
    }
    return { sessionUid: input.sessionUid, startedAt: new Date() };
  }

  /** 心跳。未命中一律**静默返回 null**（spec §8.1：心跳是尽力而为，报错会污染前端日志）。 */
  async heartbeat(input: {
    studentId: number;
    sessionUid: string;
    state: string;
  }): Promise<{ activeSeconds: number | null }> {
    if (input.state !== 'visible' && input.state !== 'hidden') {
      throw new BadRequestException({ code: 1001, message: "state 必须是 visible 或 hidden" });
    }
    const seconds = await this.repo.heartbeat(input.sessionUid, input.studentId, input.state);
    return { activeSeconds: seconds };
  }

  /** 结束。未命中（已结束/不存在）→ 回读现有值，幂等（spec §8.1）。 */
  async end(input: {
    studentId: number;
    sessionUid: string;
    reason: string;
  }): Promise<{ activeSeconds: number | null; endedAt: Date | null }> {
    if (!(END_REASONS as readonly string[]).includes(input.reason)) {
      throw new BadRequestException({ code: 1001, message: `未知 end reason：${input.reason}` });
    }
    const done = await this.repo.end(input.sessionUid, input.studentId, input.reason);
    if (done) return { activeSeconds: done.activeSeconds, endedAt: done.endedAt };

    const row = await this.repo.findByUid(input.sessionUid);
    if (!row || row.student_id !== input.studentId) return { activeSeconds: null, endedAt: null };
    return { activeSeconds: row.active_seconds, endedAt: row.ended_at };
  }

  /** 惰性收尾（家长端查询前 / 夜间兜底）。见 repo 的同名方法。 */
  async closeStale(studentId?: number): Promise<number> {
    return this.repo.closeStale(studentId);
  }
}

/** 只用到 `findAll().id`，用最小结构声明依赖，避免 import 整个 SubjectsRepository 的类型。 */
export interface SubjectsRepoLike {
  findAll(): Promise<Array<{ id: number }>>;
}

/**
 * iPad 校正（spec §4.2 的硬要求）。
 *
 * iPadOS 13+ 的 Safari UA 写的是 `Macintosh`，只看 UA **必然**把 iPad 判成 Mac；
 * 而 iPad 横屏正是这个产品的主断点。前端上报的 `input_type` 与 UA 在同一个请求里，
 * 当场可校正：`mac + touch → ipad`。
 */
export function correctIpad(
  platformClass: PlatformClass | null,
  inputType: 'touch' | 'mouse' | 'hybrid' | null,
): PlatformClass | null {
  if (platformClass === 'mac' && inputType === 'touch') return 'ipad';
  return platformClass;
}
```

> **DI 说明**：第二个构造参数是**接口** `SubjectsRepoLike`——按仓库的 DI 坑，**必须**显式 `@Inject(token)`，否则 Nest 会把 `design:paramtypes` 写成 `Object` 并启动失败。本计划用 `'SUBJECTS_REPO_FOR_ANALYTICS'` 作为 token，并在 `AnalyticsModule` 里 `{ provide: 'SUBJECTS_REPO_FOR_ANALYTICS', useExisting: SubjectsRepository }`（见 Task 5）。

- [ ] **Step 4: 跑测试确认通过**

```bash
cd apps/server && npx vitest run src/modules/analytics/study-sessions.service.test.ts
```

Expected: PASS（15 条）

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/modules/analytics/study-sessions.service.ts apps/server/src/modules/analytics/study-sessions.service.test.ts
git commit -m "feat(analytics): StudySessionsService（白名单 + iPad 校正 + 幂等语义）"
```

---

### Task 5: 采集端 controller + 模块接线 + 心跳不落请求日志

**Files:**
- Create: `apps/server/src/modules/analytics/analytics.controller.ts`
- Modify: `apps/server/src/modules/analytics/analytics.module.ts`
- Modify: `apps/server/src/common/interceptors/analytics.interceptor.ts:11`（`SKIP_PATTERNS`）
- Test: `apps/server/src/common/interceptors/analytics.interceptor.test.ts`（补一条断言）

**Interfaces:**
- Consumes: `StudySessionsService`（Task 4）、`StudySessionsRepository`（Task 3）
- Produces: 三个端点
  - `POST /api/study-sessions` → 201 `{ sessionUid, startedAt }`
  - `PATCH /api/study-sessions/:uid/heartbeat` → 200 `{ activeSeconds: number | null }`
  - `PATCH /api/study-sessions/:uid/end` → 200 `{ activeSeconds: number | null, endedAt: Date | null }`

- [ ] **Step 1: 写失败测试（心跳不进 api_request_logs）**

在 `apps/server/src/common/interceptors/analytics.interceptor.test.ts` 的 `describe('shouldSkipRoute', ...)` 里补一条：

```ts
  it('跳过心跳：30s 一次的高频自指噪音，且已落 study_sessions', () => {
    expect(shouldSkipRoute('/api/study-sessions/3f2504e0-4f89-11d3-9a0c-0305e82c3301/heartbeat')).toBe(true);
    // 开始/结束是低频且有业务意义的写入，仍要计入请求日志
    expect(shouldSkipRoute('/api/study-sessions')).toBe(false);
    expect(shouldSkipRoute('/api/study-sessions/3f2504e0-4f89-11d3-9a0c-0305e82c3301/end')).toBe(false);
  });
```

- [ ] **Step 2: 跑测试确认失败**

```bash
cd apps/server && npx vitest run src/common/interceptors/analytics.interceptor.test.ts
```

Expected: FAIL —— 第一条断言返回 `false`。

- [ ] **Step 3: 改跳过名单**

`apps/server/src/common/interceptors/analytics.interceptor.ts` 第 11 行改为：

```ts
const SKIP_PATTERNS = [
  /^\/api\/admin\/analytics(\/|$)/,
  /^\/api\/track(\/|$)/,
  // 心跳 30s 一次 × 全班在学的学生，会让 api_request_logs 被单端点淹没；
  // 它的时长语义已落 study_sessions，请求日志里没有额外信息（spec §6.2 的「自指噪音」同理）。
  // 开始/结束**不跳过**——低频且携带业务事件。
  /^\/api\/study-sessions\/[^/]+\/heartbeat$/,
];
```

- [ ] **Step 4: 跑测试确认通过**

```bash
cd apps/server && npx vitest run src/common/interceptors/analytics.interceptor.test.ts
```

Expected: PASS

- [ ] **Step 5: 实现 controller**

Create `apps/server/src/modules/analytics/analytics.controller.ts`：

```ts
import { BadRequestException, Body, Controller, Param, Patch, Post, Req, UseGuards } from '@nestjs/common';
import type { Request } from 'express';
import { z } from 'zod';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard.js';
import type { JwtUser } from '../../common/guards/jwt-auth.guard.js';
import { RolesGuard } from '../../common/guards/roles.guard.js';
import { Roles } from '../../common/decorators/roles.js';
import { CurrentUser } from '../../common/decorators/current-user.js';
import { StudySessionsService, END_REASONS } from './study-sessions.service.js';

/**
 * 采集端（student 角色，spec §8.1）。
 *
 * `/api/track/events` **不在本批**：`behavior_events` 表属 Phase 2（见计划头部「范围裁剪」）。
 * 在表不存在的情况下提前开端点只会得到一个 500。
 *
 * 不手工包 `{code, message, data}`——全局 `ResponseInterceptor` 统一包。
 */
const StartSchema = z.object({
  sessionUid: z.string().uuid(),
  module: z.string().min(1).max(32),
  scene: z.string().min(1).max(40),
  subjectId: z.number().int().positive().optional(),
  refType: z.string().max(24).optional(),
  refId: z.number().int().positive().optional(),
  // 设备三项**不做枚举校验**：非法值在 service 里落 NULL，不报错（设备信息是尽力而为）。
  screenClass: z.string().max(20).optional(),
  inputType: z.string().max(10).optional(),
  appShell: z.string().max(10).optional(),
});

const HeartbeatSchema = z.object({ state: z.enum(['visible', 'hidden']) });
const EndSchema = z.object({ reason: z.enum(END_REASONS) });

function parseOrThrow<T>(schema: z.ZodType<T>, body: unknown): T {
  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    throw new BadRequestException({ code: 1001, message: '请求参数不合法' });
  }
  return parsed.data;
}

@Controller('api/study-sessions')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles('student')
export class AnalyticsController {
  constructor(private readonly studySessions: StudySessionsService) {}

  /** 开始一段学习会话（幂等，`@Post` 默认 201）。 */
  @Post()
  async start(@CurrentUser() user: JwtUser, @Body() body: unknown, @Req() req: Request) {
    const dto = parseOrThrow(StartSchema, body);
    return this.studySessions.start({
      ...dto,
      studentId: user.sub,
      userAgent: req.headers['user-agent'] ?? null,
    });
  }

  /** 心跳（PATCH 默认 200）。未命中 → `{activeSeconds: null}`，不报错。 */
  @Patch(':uid/heartbeat')
  async heartbeat(
    @CurrentUser() user: JwtUser,
    @Param('uid') uid: string,
    @Body() body: unknown,
  ) {
    const dto = parseOrThrow(HeartbeatSchema, body);
    return this.studySessions.heartbeat({ studentId: user.sub, sessionUid: uid, state: dto.state });
  }

  /** 结束会话（幂等）。 */
  @Patch(':uid/end')
  async end(@CurrentUser() user: JwtUser, @Param('uid') uid: string, @Body() body: unknown) {
    const dto = parseOrThrow(EndSchema, body);
    return this.studySessions.end({ studentId: user.sub, sessionUid: uid, reason: dto.reason });
  }
}
```

- [ ] **Step 6: 接线 `AnalyticsModule`**

`apps/server/src/modules/analytics/analytics.module.ts` 全文改为：

```ts
import { Module } from '@nestjs/common';
import { LlmCallLogsRepository } from '../../database/repositories/llm-call-logs.repo.js';
import { ApiRequestLogsRepository } from '../../database/repositories/api-request-logs.repo.js';
import { StudySessionsRepository } from '../../database/repositories/study-sessions.repo.js';
import { SubjectsRepository } from '../../database/repositories/subjects.repo.js';
import { TelemetryService } from './telemetry.service.js';
import { StudySessionsService } from './study-sessions.service.js';
import { AnalyticsController } from './analytics.controller.js';
import { AnalyticsInterceptor } from '../../common/interceptors/analytics.interceptor.js';
import { setLlmCallSink } from '../../ai-core/infra/llm-call-log.js';

/**
 * 埋点模块。
 *
 * - Phase 0（账本 + 请求日志）：两个 buffer + `AnalyticsInterceptor`，sink 在这里接上。
 * - Phase 1A（学习时长）：`study_sessions` 的采集端点。
 *
 * 为什么把 sink 注册放这里：capability 是零参 `new` 出来的、拿不到 DI 容器
 * （见 CLAUDE.md 的 DI 坑），所以 ai-core 用模块级 sink 单例，由本模块在启动时接上。
 *
 * `SUBJECTS_REPO_FOR_ANALYTICS` 这个 token：`StudySessionsService` 的第二个构造参数是
 * **接口** `SubjectsRepoLike`，按仓库的 DI 坑必须显式 `@Inject(token)`，否则 Nest 会把
 * `design:paramtypes` 写成 `Object` 并启动失败。用 `useExisting` 复用同一个 SubjectsRepository。
 */
@Module({
  controllers: [AnalyticsController],
  providers: [
    LlmCallLogsRepository,
    ApiRequestLogsRepository,
    // TelemetryService **必须留在这里**：本模块的构造函数（下面的 setLlmCallSink）与
    // AnalyticsInterceptor 都注入它，而本模块没有 imports、也不是 @Global。
    // 漏掉它 = 模块初始化直接失败（Phase 0 的原始 providers 里本来就有它，别删）。
    TelemetryService,
    StudySessionsRepository,
    SubjectsRepository,
    StudySessionsService,
    AnalyticsInterceptor,
    { provide: 'SUBJECTS_REPO_FOR_ANALYTICS', useExisting: SubjectsRepository },
  ],
  exports: [TelemetryService, AnalyticsInterceptor, StudySessionsService],
})
export class AnalyticsModule {
  constructor(private telemetry: TelemetryService) {
    setLlmCallSink((entry) => this.telemetry.llmCalls.push(entry));
  }
}
```

- [ ] **Step 6b: 订正 `study-sessions.repo.ts` 的过期注释（只改一句）**

`apps/server/src/database/repositories/study-sessions.repo.ts:54` 的「两条纪律」第 2 条写的是「所有写入……调用方（service）必须包 try/catch，失败只 warn、绝不 500」。这句写在 2026-09-19 的**收窄裁决之前**，现在是错的：生效义务只落在**嵌在别的业务流里的埋点写入**（如家长 GET 里的 `closeStale`），而本任务的三个采集端点**是例外**——允许 DB 失败直接 500。

把**这一句**改成收窄后的说法（保持中文、`**加粗**` 承重点、一句话讲清，别顺手改这个文件的其它行）。

- [ ] **Step 7: 构建 + 全量后端测试**

```bash
cd apps/server && npm run build && npm test
```

Expected: 构建通过；测试全绿（Phase 0 的 1166 条 + 本计划新增）。

- [ ] **Step 8: 冒烟（独立端口 + 按 PID 收尾）**

```bash
cd apps/server && PORT=3199 node dist/main.js &
SERVER_PID=$!
sleep 2
curl -s -o /dev/null -w "%{http_code}\n" -X POST http://localhost:3199/api/study-sessions -H 'Content-Type: application/json' -d '{}'
kill $SERVER_PID
```

Expected: `401`（未登录被 `JwtAuthGuard` 拒——**不是** 500，说明模块 DI 正常、路由已注册）。若输出 `500`，检查 `SUBJECTS_REPO_FOR_ANALYTICS` 是否配好。

- [ ] **Step 9: Commit**

```bash
git add apps/server/src/modules/analytics/analytics.controller.ts apps/server/src/modules/analytics/analytics.module.ts apps/server/src/common/interceptors/analytics.interceptor.ts apps/server/src/common/interceptors/analytics.interceptor.test.ts apps/server/src/database/repositories/study-sessions.repo.ts
git commit -m "feat(analytics): /api/study-sessions 采集端点 + 模块接线 + 心跳不进请求日志"
```

---

### Task 6: `ParentAnalyticsRepository`（学习时长聚合 + 隐私守卫）

**Files:**
- Create: `apps/server/src/database/repositories/parent-analytics.repo.ts`
- Test: `apps/server/src/database/repositories/parent-analytics.repo.test.ts`
- Modify: `apps/server/src/database/repositories/index.ts`

**Interfaces:**
- Consumes: 表 `study_sessions`（Task 1）
- Produces:
  - `interface DaySeconds { day: string; seconds: number }`
  - `interface ModuleSeconds { module: string; seconds: number }`
  - `interface SubjectSeconds { subjectId: number; seconds: number }`
  - `class ParentAnalyticsRepository`
    - `getStudyTimeTotal(studentId: number, from: Date, toExclusive: Date): Promise<number>`
    - `getStudyTimeByDay(...): Promise<DaySeconds[]>`
    - `getStudyTimeByModule(...): Promise<ModuleSeconds[]>`
    - `getStudyTimeBySubject(...): Promise<SubjectSeconds[]>`
    - `getActiveDays(...): Promise<number>`

- [ ] **Step 1: 写失败测试**

Create `apps/server/src/database/repositories/parent-analytics.repo.test.ts`：

```ts
import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { ParentAnalyticsRepository } from './parent-analytics.repo.js';

const mockPool = (rows: any[] = []) => ({
  execute: vi.fn().mockResolvedValue([rows, []]),
  query: vi.fn().mockResolvedValue([rows, []]),
});

const FROM = new Date(2026, 8, 13); // 2026-09-13 本地 00:00
const TO = new Date(2026, 8, 20); // 2026-09-20 本地 00:00（半开）

describe('ParentAnalyticsRepository 学习时长', () => {
  it('getStudyTimeTotal：只算已结束（含惰性可收尾的孤儿会话）', async () => {
    const pool = mockPool([{ total: 3661 }]);
    const repo = new ParentAnalyticsRepository(pool as any);
    expect(await repo.getStudyTimeTotal(9, FROM, TO)).toBe(3661);

    const [sql, params] = pool.execute.mock.calls[0];
    expect(sql).toContain('FROM study_sessions');
    expect(sql).toContain("status IN ('ended','abandoned')");
    // 关标签的会话不会有 end 请求，必须把「active 但心跳超 5 分钟」也算进来
    expect(sql).toContain("status = 'active' AND last_heartbeat_at < NOW(3) - INTERVAL 5 MINUTE");
    expect(sql).toContain('student_id = ? AND started_at >= ? AND started_at < ?');
    expect(sql).not.toContain('CURDATE()');
    expect(params).toEqual([9, FROM, TO]);
  });

  it('getStudyTimeByDay：按 DATE(started_at) 分组，日期由 SQL 出', async () => {
    const rows = [
      { day: '2026-09-13', seconds: 600 },
      { day: '2026-09-15', seconds: 1200 },
    ];
    const pool = mockPool(rows);
    const repo = new ParentAnalyticsRepository(pool as any);
    expect(await repo.getStudyTimeByDay(9, FROM, TO)).toEqual(rows);

    const [sql] = pool.execute.mock.calls[0];
    expect(sql).toContain("DATE_FORMAT(started_at, '%Y-%m-%d') AS day");
    expect(sql).toContain('GROUP BY day ORDER BY day');
  });

  it('getStudyTimeByModule / bySubject：NULL 维度不出现在结果里（不编造「未知」桶）', async () => {
    const pool = mockPool([{ module: 'en_vocabulary', seconds: 300 }]);
    const repo = new ParentAnalyticsRepository(pool as any);
    await repo.getStudyTimeByModule(9, FROM, TO);
    const [moduleSql] = pool.execute.mock.calls[0];
    expect(moduleSql).toContain('GROUP BY module ORDER BY seconds DESC');

    const subjectPool = mockPool([{ subjectId: 1, seconds: 300 }]);
    const repo2 = new ParentAnalyticsRepository(subjectPool as any);
    await repo2.getStudyTimeBySubject(9, FROM, TO);
    const [subjectSql] = subjectPool.execute.mock.calls[0];
    expect(subjectSql).toContain('subject_id IS NOT NULL');
    expect(subjectSql).toContain('GROUP BY subject_id ORDER BY seconds DESC');
  });

  it('getActiveDays：COUNT(DISTINCT DATE(started_at))，空结果为 0', async () => {
    const pool = mockPool([{ active_days: 4 }]);
    const repo = new ParentAnalyticsRepository(pool as any);
    expect(await repo.getActiveDays(9, FROM, TO)).toBe(4);

    const empty = mockPool([]);
    const repo2 = new ParentAnalyticsRepository(empty as any);
    expect(await repo2.getActiveDays(9, FROM, TO)).toBe(0);
  });
});

/**
 * 隐私守卫（spec §5.4 第三道锁）：
 * `parent-analytics.repo.ts` 是家长端取数的**唯一**入口，文件里**不允许出现**任何
 * ops-only 信号名。这是穷尽式断言——将来谁把 `behavior_events` 的 ops 事件查进来，
 * 这条用例会立刻红。
 */
describe('隐私守卫：家长端仓储不含 ops 信号', () => {
  it('源码里不出现 ops-only 事件名', () => {
    const path = fileURLToPath(new URL('./parent-analytics.repo.ts', import.meta.url));
    const src = readFileSync(path, 'utf8');
    for (const forbidden of [
      'hint_requested',
      'answer_revealed',
      'self_assess_answered',
      'consecutive_failures',
      'study_session_idle',
      'behavior_events',
    ]) {
      expect(src).not.toContain(forbidden);
    }
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

```bash
cd apps/server && npx vitest run src/database/repositories/parent-analytics.repo.test.ts
```

Expected: FAIL —— 模块不存在。

- [ ] **Step 3: 实现**

Create `apps/server/src/database/repositories/parent-analytics.repo.ts`：

```ts
import { Injectable, Inject } from '@nestjs/common';
import type { Pool, RowDataPacket } from 'mysql2/promise';

export interface DaySeconds {
  day: string;
  seconds: number;
}

export interface ModuleSeconds {
  module: string;
  seconds: number;
}

export interface SubjectSeconds {
  subjectId: number;
  seconds: number;
}

/**
 * 家长端**只读**聚合仓储（spec §6.1）。
 *
 * 三条纪律：
 * 1. **隐私分层第三道锁**：本文件是家长端取数的唯一入口，**只准查 parent 层信号**。
 *    ops-only（提示依赖 / 连续失败 / 放弃点 / 自评）永不进这个文件——
 *    `parent-analytics.repo.test.ts` 的守卫用例会静态断言这一点。
 * 2. 时间窗由**应用层**算好传参（`from` 含、`toExclusive` 不含），**不用 `CURDATE()`**：
 *    DB 会话时区与 Node 可能不一致，会算错一天（`point-ledger.repo.ts` 的既有约定）。
 * 3. 学习时长只统计**已结束**的会话。`active` 但心跳超 5 分钟的孤儿会话
 *    （用户直接关标签、没有 end 请求）也要算进来，否则「今日已用」会永远不更新。
 *
 * Phase 1B 会往这里加专项 / 掌握度 / 目标三组查询；保持单一入口，不要按域拆文件。
 */
@Injectable()
export class ParentAnalyticsRepository {
  constructor(@Inject('DATABASE_POOL') private readonly pool: Pool) {}

  /**
   * 会话有效性的**唯一口径**，四处聚合共用。
   *
   * 抽成常量而不是四处复制：漏掉孤儿会话分支的散点 SQL 会让不同卡片上的
   * 「学习时长」互相打架，而家长会认为其中一个是 bug。
   */
  private static readonly EFFECTIVE_SESSION = `(status IN ('ended','abandoned')
       OR (status = 'active' AND last_heartbeat_at < NOW(3) - INTERVAL 5 MINUTE))`;

  async getStudyTimeTotal(studentId: number, from: Date, toExclusive: Date): Promise<number> {
    const [rows] = await this.pool.execute<(RowDataPacket & { total: number | string | null })[]>(
      `SELECT COALESCE(SUM(active_seconds), 0) AS total
       FROM study_sessions
       WHERE student_id = ? AND started_at >= ? AND started_at < ?
         AND ${ParentAnalyticsRepository.EFFECTIVE_SESSION}`,
      [studentId, from, toExclusive],
    );
    return Number(rows[0]?.total ?? 0);
  }

  async getStudyTimeByDay(studentId: number, from: Date, toExclusive: Date): Promise<DaySeconds[]> {
    const [rows] = await this.pool.execute<
      (RowDataPacket & { day: string; seconds: number | string | null })[]
    >(
      `SELECT DATE_FORMAT(started_at, '%Y-%m-%d') AS day,
              COALESCE(SUM(active_seconds), 0)    AS seconds
       FROM study_sessions
       WHERE student_id = ? AND started_at >= ? AND started_at < ?
         AND ${ParentAnalyticsRepository.EFFECTIVE_SESSION}
       GROUP BY day ORDER BY day`,
      [studentId, from, toExclusive],
    );
    return rows.map((r) => ({ day: r.day, seconds: Number(r.seconds ?? 0) }));
  }

  async getStudyTimeByModule(studentId: number, from: Date, toExclusive: Date): Promise<ModuleSeconds[]> {
    const [rows] = await this.pool.execute<
      (RowDataPacket & { module: string; seconds: number | string | null })[]
    >(
      `SELECT module, COALESCE(SUM(active_seconds), 0) AS seconds
       FROM study_sessions
       WHERE student_id = ? AND started_at >= ? AND started_at < ?
         AND ${ParentAnalyticsRepository.EFFECTIVE_SESSION}
       GROUP BY module ORDER BY seconds DESC`,
      [studentId, from, toExclusive],
    );
    return rows.map((r) => ({ module: r.module, seconds: Number(r.seconds ?? 0) }));
  }

  async getStudyTimeBySubject(studentId: number, from: Date, toExclusive: Date): Promise<SubjectSeconds[]> {
    const [rows] = await this.pool.execute<
      (RowDataPacket & { subjectId: number; seconds: number | string | null })[]
    >(
      `SELECT subject_id AS subjectId, COALESCE(SUM(active_seconds), 0) AS seconds
       FROM study_sessions
       WHERE student_id = ? AND started_at >= ? AND started_at < ?
         AND subject_id IS NOT NULL
         AND ${ParentAnalyticsRepository.EFFECTIVE_SESSION}
       GROUP BY subject_id ORDER BY seconds DESC`,
      [studentId, from, toExclusive],
    );
    return rows.map((r) => ({ subjectId: Number(r.subjectId), seconds: Number(r.seconds ?? 0) }));
  }

  /** 会话口径的「有学习的天数」。与旧「近 7 天活跃」（四路时间戳代理）**刻意不同**，见 spec §10。 */
  async getActiveDays(studentId: number, from: Date, toExclusive: Date): Promise<number> {
    const [rows] = await this.pool.execute<(RowDataPacket & { active_days: number | string | null })[]>(
      `SELECT COUNT(DISTINCT DATE(started_at)) AS active_days
       FROM study_sessions
       WHERE student_id = ? AND started_at >= ? AND started_at < ?
         AND ${ParentAnalyticsRepository.EFFECTIVE_SESSION}`,
      [studentId, from, toExclusive],
    );
    return Number(rows[0]?.active_days ?? 0);
  }
}
```

- [ ] **Step 4: 跑测试确认通过**

```bash
cd apps/server && npx vitest run src/database/repositories/parent-analytics.repo.test.ts
```

Expected: PASS（6 条）

- [ ] **Step 5: 加进 barrel**

在 `apps/server/src/database/repositories/index.ts` 末尾追加：

```ts
export { ParentAnalyticsRepository } from './parent-analytics.repo.js';
export type { DaySeconds, ModuleSeconds, SubjectSeconds } from './parent-analytics.repo.js';
```

- [ ] **Step 6: Commit**

```bash
git add apps/server/src/database/repositories/parent-analytics.repo.ts apps/server/src/database/repositories/parent-analytics.repo.test.ts apps/server/src/database/repositories/index.ts
git commit -m "feat(analytics): ParentAnalyticsRepository（学习时长聚合 + 隐私守卫）"
```

---

### Task 7: `window.util.resolveRange` + `ControlsRepository.findDailyTimeLimit` + `StudyTimeService`

**Files:**
- Modify: `apps/server/src/modules/parent-insights/window.util.ts`（导出 `toDayString`、新增 `resolveRange`）
- Test: `apps/server/src/modules/parent-insights/window.util.test.ts`（若已存在则追加）
- Modify: `apps/server/src/database/repositories/controls.repo.ts`（加一个只读方法）
- Test: `apps/server/src/database/repositories/controls.repo.test.ts`（若已存在则追加）
- Create: `apps/server/src/modules/parent-insights/study-time.service.ts`
- Test: `apps/server/src/modules/parent-insights/study-time.service.test.ts`
- Modify: `apps/server/src/modules/parent-insights/dto/parent-insights.dto.ts`（追加 `StudyTimeSummary` / `TodayUsageSummary`——**由本任务加**，因为 `StudyTimeService` 是它们的产出方；Task 8 只消费）

**Interfaces:**
- Consumes: `ParentAnalyticsRepository`（Task 6）、`ControlsRepository`、`StudySessionsService`（Task 4）
- Produces:
  - `resolveRange(from?: string, to?: string): ReportWindow`（`from`/`to` 为 `YYYY-MM-DD`；缺省近 7 天；非法回落默认；`from > to` 自动交换）
  - `ControlsRepository.findDailyTimeLimit(studentId: number): Promise<number | null>`
  - DTO 类型 `StudyTimeSummary` / `TodayUsageSummary`（Task 8 的 controller 与前端 `api.ts` 都按这两个形状对齐）
  - `class StudyTimeService`：`getStudyTime(studentId, from?, to?)` 与 `getTodayUsage(studentId)`

- [ ] **Step 0: 先把两个 DTO 类型加到 `dto/parent-insights.dto.ts` 末尾**

`StudyTimeService` 的返回类型就是这两个接口，所以**本任务必须先加它们**，否则 `tsc` 会红（Task 8 只消费、不再新增）。照 plan 的 Task 8 Step 1 里那两段 `export interface StudyTimeSummary` / `export interface TodayUsageSummary` 逐字粘贴到文件末尾。

- [ ] **Step 1: 写 `resolveRange` 的失败测试**

在 `apps/server/src/modules/parent-insights/window.util.test.ts` 追加。
**注意**：该文件已存在，当前 import 是 `import { startOfDaysAgo, resolveWindow } from './window.util.js';`——必须先把 `resolveRange` 加进这一行（否则新用例直接报 `resolveRange is not a function`）。

```ts
describe('resolveRange', () => {
  it('两个都不传 → 近 7 天（含今天），endExclusive 是明天的 00:00', () => {
    const w = resolveRange();
    const today = new Date();
    expect(w.endDay).toBe(
      `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`,
    );
    expect(Math.round((w.endExclusive.getTime() - w.start.getTime()) / 86_400_000)).toBe(7);
  });

  it('显式 from/to → 闭区间：to 那天整天都在窗口内', () => {
    const w = resolveRange('2026-09-13', '2026-09-19');
    expect(w.startDay).toBe('2026-09-13');
    expect(w.endDay).toBe('2026-09-19');
    expect(Math.round((w.endExclusive.getTime() - w.start.getTime()) / 86_400_000)).toBe(7);
    expect(w.endExclusive.getTime() - w.start.getTime()).toBe(7 * 86_400_000);
  });

  it('只给 to → 以 to 收尾的 7 天窗口', () => {
    const w = resolveRange(undefined, '2026-09-19');
    expect(w.startDay).toBe('2026-09-13');
    expect(w.endDay).toBe('2026-09-19');
  });

  it('非法日期串 → 回落默认（查询参数宽容，不 400）', () => {
    const w = resolveRange('2026-9-3', 'garbage');
    expect(w.startDay).not.toBe('2026-9-3');
    expect(w.endDay).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it('from > to → 交换，不返回空窗口', () => {
    const w = resolveRange('2026-09-19', '2026-09-13');
    expect(w.startDay).toBe('2026-09-13');
    expect(w.endDay).toBe('2026-09-19');
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

```bash
cd apps/server && npx vitest run src/modules/parent-insights/window.util.test.ts
```

Expected: FAIL —— `resolveRange is not a function`。

- [ ] **Step 3: 实现 `resolveRange`**

在 `apps/server/src/modules/parent-insights/window.util.ts` 中：把 `toDayString` 前的 `function` 改为 `export function`，并在文件末尾追加：

```ts
/** 把 `YYYY-MM-DD` 解析为**本地时区**当天 00:00；形状不合法或日期不存在（如 2026-02-30）→ null。 */
function parseDayString(raw: string): Date | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(raw);
  if (!m) return null;
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  if (Number.isNaN(d.getTime())) return null;
  // 挡掉 2026-02-30 这类「Date 会静默滚到 3 月」的输入
  if (d.getFullYear() !== Number(m[1]) || d.getMonth() !== Number(m[2]) - 1 || d.getDate() !== Number(m[3])) {
    return null;
  }
  return d;
}

const DEFAULT_RANGE_DAYS = 7;

/**
 * 显式日期区间 → 报告窗口。用于 `study-time` 的 `from`/`to`（spec §8.2）。
 *
 * 宽容回落：查询类参数非法**不 400**（与 `PeriodSchema` 对 `period` 的处理一致）——
 * 一个拼错的日期不应该让家长看到错误页。缺省 = 近 7 天。
 * `from > to` 时自动交换：宁可给出「反着的窗口」也不要给空窗口。
 */
export function resolveRange(from?: string, to?: string): ReportWindow {
  const parsedTo = to ? parseDayString(to) : null;
  const endInclusive = parsedTo ?? startOfDaysAgo(0);
  let start = (from ? parseDayString(from) : null) ?? new Date(endInclusive.getTime() - (DEFAULT_RANGE_DAYS - 1) * DAY_MS);
  let end = endInclusive;
  if (start.getTime() > end.getTime()) {
    const swap = start;
    start = end;
    end = swap;
  }
  return {
    start,
    endExclusive: new Date(end.getTime() + DAY_MS),
    startDay: toDayString(start),
    endDay: toDayString(end),
  };
}
```

- [ ] **Step 4: 跑测试确认通过**

```bash
cd apps/server && npx vitest run src/modules/parent-insights/window.util.test.ts
```

Expected: PASS

- [ ] **Step 5: 加 `ControlsRepository.findDailyTimeLimit`**

在 `apps/server/src/database/repositories/controls.repo.ts` 的 `findByStudent` 之后加：

```ts
  /**
   * 读每日学习时长上限（分钟）。**无行 / 列为 NULL → 返回 null**（= 未设限）。
   *
   * 不复用 `findByStudent`：那个方法刻意只 select 兑换两列，把整张表带进服务层是
   * 它注释里明确拒绝的过度设计。这里同样只取**一个列**，不做通用 controls 仓储。
   *
   * 语义提醒：这个值只是**上限**。它是「行为管控」的一半，另一半「今日已用」
   * 来自 `study_sessions`（Phase 1A 才补上）——在本批之前这个上限是摆设。
   */
  async findDailyTimeLimit(studentId: number): Promise<number | null> {
    const [rows] = await this.pool.execute<
      (RowDataPacket & { daily_time_limit_minutes: number | null })[]
    >(
      `SELECT daily_time_limit_minutes FROM controls WHERE student_id = ? LIMIT 1`,
      [studentId],
    );
    const value = rows[0]?.daily_time_limit_minutes;
    return value === null || value === undefined ? null : Number(value);
  }
```

同时在 `controls.repo.test.ts` 追加：

```ts
describe('ControlsRepository.findDailyTimeLimit', () => {
  it('有值 → 数字', async () => {
    const pool = { execute: vi.fn().mockResolvedValue([[{ daily_time_limit_minutes: 60 }], []]) };
    const repo = new ControlsRepository(pool as any);
    expect(await repo.findDailyTimeLimit(9)).toBe(60);
  });

  it('无行 / NULL → null（未设限，不是 0）', async () => {
    const pool = { execute: vi.fn().mockResolvedValue([[], []]) };
    const repo = new ControlsRepository(pool as any);
    expect(await repo.findDailyTimeLimit(9)).toBeNull();

    const nullPool = { execute: vi.fn().mockResolvedValue([[{ daily_time_limit_minutes: null }], []]) };
    const repo2 = new ControlsRepository(nullPool as any);
    expect(await repo2.findDailyTimeLimit(9)).toBeNull();
  });
});
```

（若 `controls.repo.test.ts` 不存在，新建并在顶部加 `import { describe, it, expect, vi } from 'vitest';` 与 `import { ControlsRepository } from './controls.repo.js';`。）

- [ ] **Step 6: 写 `StudyTimeService` 的失败测试**

Create `apps/server/src/modules/parent-insights/study-time.service.test.ts`：

```ts
import { describe, it, expect, vi } from 'vitest';
import { StudyTimeService } from './study-time.service.js';
import type { ParentAnalyticsRepository } from '../../database/repositories/parent-analytics.repo.js';
import type { ControlsRepository } from '../../database/repositories/controls.repo.js';
import type { StudySessionsService } from '../analytics/study-sessions.service.js';

function makeRepo(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    getStudyTimeTotal: vi.fn().mockResolvedValue(3661),
    getStudyTimeByDay: vi.fn().mockResolvedValue([{ day: '2026-09-19', seconds: 600 }]),
    getStudyTimeByModule: vi.fn().mockResolvedValue([{ module: 'en_vocabulary', seconds: 600 }]),
    getStudyTimeBySubject: vi.fn().mockResolvedValue([{ subjectId: 1, seconds: 600 }]),
    getActiveDays: vi.fn().mockResolvedValue(3),
    ...overrides,
  } as unknown as ParentAnalyticsRepository;
}

const makeControls = (limit: number | null) =>
  ({ findDailyTimeLimit: vi.fn().mockResolvedValue(limit) } as unknown as ControlsRepository);

const makeSessions = () => ({ closeStale: vi.fn().mockResolvedValue(0) } as unknown as StudySessionsService);

describe('StudyTimeService.getStudyTime', () => {
  it('组装窗口、总量、按天/模块/学科，并回显 source=sessions', async () => {
    const repo = makeRepo();
    const service = new StudyTimeService(repo, makeControls(null), makeSessions());

    const out = await service.getStudyTime(9, '2026-09-13', '2026-09-19');
    expect(out).toEqual({
      totalSeconds: 3661,
      activeDays: 3,
      byDay: [{ date: '2026-09-19', seconds: 600 }],
      byModule: [{ module: 'en_vocabulary', seconds: 600 }],
      bySubject: [{ subjectId: 1, seconds: 600 }],
      source: 'sessions',
    });
    const [totalArgs] = (repo.getStudyTimeTotal as any).mock.calls[0];
    expect(totalArgs).toBe(9);
  });

  it('查询前先惰性收尾这个学生的孤儿会话（否则今日已用永远不更新）', async () => {
    const sessions = makeSessions();
    const service = new StudyTimeService(makeRepo(), makeControls(null), sessions);
    await service.getStudyTime(9);
    expect(sessions.closeStale).toHaveBeenCalledWith(9);
  });

  it('收尾失败不阻断查询（埋点不得影响主链路）', async () => {
    const sessions = { closeStale: vi.fn().mockRejectedValue(new Error('db down')) } as unknown as StudySessionsService;
    const service = new StudyTimeService(makeRepo(), makeControls(null), sessions);
    await expect(service.getStudyTime(9)).resolves.toBeTruthy();
  });
});

describe('StudyTimeService.getTodayUsage', () => {
  it('未设上限 → limitMinutes:null、exceeded:false', async () => {
    const service = new StudyTimeService(makeRepo(), makeControls(null), makeSessions());
    const out = await service.getTodayUsage(9);
    expect(out.limitMinutes).toBeNull();
    expect(out.exceeded).toBe(false);
    expect(out.activeSeconds).toBe(3661);
    expect(out.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(out.byModule).toEqual([{ module: 'en_vocabulary', seconds: 600 }]);
  });

  it('达到上限即 exceeded（用满就该停，不是严格大于）', async () => {
    const repo = makeRepo({ getStudyTimeTotal: vi.fn().mockResolvedValue(30 * 60) });
    const service = new StudyTimeService(repo, makeControls(30), makeSessions());
    const out = await service.getTodayUsage(9);
    expect(out.exceeded).toBe(true);
  });

  it('未达上限 → exceeded:false', async () => {
    const repo = makeRepo({ getStudyTimeTotal: vi.fn().mockResolvedValue(29 * 60) });
    const service = new StudyTimeService(repo, makeControls(30), makeSessions());
    expect((await service.getTodayUsage(9)).exceeded).toBe(false);
  });
});
```

- [ ] **Step 7: 实现 `StudyTimeService`**

Create `apps/server/src/modules/parent-insights/study-time.service.ts`：

```ts
import { Inject, Injectable, Logger } from '@nestjs/common';
import { ParentAnalyticsRepository } from '../../database/repositories/parent-analytics.repo.js';
import { ControlsRepository } from '../../database/repositories/controls.repo.js';
import { StudySessionsService } from '../analytics/study-sessions.service.js';
import { resolveRange, startOfDaysAgo, toDayString } from './window.util.js';
import type { StudyTimeSummary, TodayUsageSummary } from './dto/parent-insights.dto.js';

@Injectable()
export class StudyTimeService {
  private readonly logger = new Logger(StudyTimeService.name);

  constructor(
    @Inject(ParentAnalyticsRepository) private readonly repo: ParentAnalyticsRepository,
    @Inject(ControlsRepository) private readonly controls: ControlsRepository,
    @Inject(StudySessionsService) private readonly sessions: StudySessionsService,
  ) {}

  /**
   * 学习时长（spec §8.2）。窗口缺省 = 近 7 天；`source: 'sessions'` 是**口径标记**——
   * 家长端同时还有一套「活跃天数」（四路时间戳代理），响应里必须能分辨哪个是哪个。
   *
   * ⚠️ 这个数字与「近 7 天活跃天数」**不是同一回事**（spec §10）：孩子挂机不答题 →
   * 旧口径不活跃，但页面开着就有新时长；反之只看一页不操作也可能两边都不算。
   * 永远不要把两者合并或相互替换。
   */
  async getStudyTime(studentId: number, from?: string, to?: string): Promise<StudyTimeSummary> {
    const window = resolveRange(from, to);
    await this.closeStaleQuietly(studentId);

    const [totalSeconds, activeDays, byDay, byModule, bySubject] = await Promise.all([
      this.repo.getStudyTimeTotal(studentId, window.start, window.endExclusive),
      this.repo.getActiveDays(studentId, window.start, window.endExclusive),
      this.repo.getStudyTimeByDay(studentId, window.start, window.endExclusive),
      this.repo.getStudyTimeByModule(studentId, window.start, window.endExclusive),
      this.repo.getStudyTimeBySubject(studentId, window.start, window.endExclusive),
    ]);

    return {
      totalSeconds,
      activeDays,
      byDay: byDay.map((r) => ({ date: r.day, seconds: r.seconds })),
      byModule,
      bySubject,
      source: 'sessions',
    };
  }

  /**
   * 今日已用时长（spec §8.2）——补齐 `controls.daily_time_limit_minutes` 的另一半。
   *
   * `limitMinutes: null` = 家长未设限 → `exceeded: false`（**不是**「超了」，
   * 也不是「用了 0 分钟」）。`exceeded` 用 `>=`：管控语义是「用满了就该停」。
   */
  async getTodayUsage(studentId: number): Promise<TodayUsageSummary> {
    const today = toDayString(startOfDaysAgo(0));
    const window = resolveRange(today, today);
    await this.closeStaleQuietly(studentId);

    const [activeSeconds, limitMinutes, byModule] = await Promise.all([
      this.repo.getStudyTimeTotal(studentId, window.start, window.endExclusive),
      this.controls.findDailyTimeLimit(studentId),
      this.repo.getStudyTimeByModule(studentId, window.start, window.endExclusive),
    ]);

    return {
      date: today,
      activeSeconds,
      limitMinutes,
      exceeded: limitMinutes !== null && activeSeconds >= limitMinutes * 60,
      byModule,
    };
  }

  /**
   * 惰性收尾必须**吞掉异常**：它只是为了让「今日已用」更准，失败时按已收尾的数据返回即可。
   * 让一次收尾失败把家长的整个页面打成 500，是本末倒置。
   */
  private async closeStaleQuietly(studentId: number): Promise<void> {
    try {
      await this.sessions.closeStale(studentId);
    } catch (err) {
      this.logger.warn(`closeStale(${studentId}) 失败，本次按现状聚合：${String(err)}`);
    }
  }
}
```

- [ ] **Step 8: 跑测试确认通过**

```bash
cd apps/server && npx vitest run src/modules/parent-insights/window.util.test.ts src/database/repositories/controls.repo.test.ts src/modules/parent-insights/study-time.service.test.ts
```

Expected: PASS

- [ ] **Step 9: Commit**

```bash
git add apps/server/src/modules/parent-insights/window.util.ts apps/server/src/modules/parent-insights/window.util.test.ts apps/server/src/database/repositories/controls.repo.ts apps/server/src/database/repositories/controls.repo.test.ts apps/server/src/modules/parent-insights/study-time.service.ts apps/server/src/modules/parent-insights/study-time.service.test.ts apps/server/src/modules/parent-insights/dto/parent-insights.dto.ts
git commit -m "feat(parent): StudyTimeService + resolveRange + controls 每日上限读取"
```

---

### Task 8: 家长端两个新端点 + DTO + 模块接线

**Files:**
- Modify: `apps/server/src/modules/parent-insights/dto/parent-insights.dto.ts`（**只读确认**：`StudyTimeSummary` / `TodayUsageSummary` 已由 Task 7 Step 0 添加；本任务若要给 controller 加查询参数类型再加，别重复定义）
- Modify: `apps/server/src/modules/parent-insights/parent-insights.controller.ts`
- Modify: `apps/server/src/modules/parent-insights/parent-insights.module.ts`
- Test: `apps/server/src/modules/parent-insights/parent-insights.controller.test.ts`（若不存在则新建，验证归属校验先于取数）

**Interfaces:**
- Consumes: `StudyTimeService`（Task 7）、`StudyTimeSummary` / `TodayUsageSummary`（Task 7 Step 0 已加到 DTO）
- Produces:
  - `GET /api/parent/students/:studentId/study-time?from=&to=` → `StudyTimeSummary`
  - `GET /api/parent/students/:studentId/today-usage` → `TodayUsageSummary`

- [ ] **Step 1: 确认 DTO 类型已就位（**不要重复定义**）**

`StudyTimeSummary` / `TodayUsageSummary` 已在 Task 7 Step 0 加进 `dto/parent-insights.dto.ts` 末尾。这里只需 `grep` 确认两个 `export interface` 都在，然后直接进 Step 2。若你出于任何原因发现它们缺失，说明 Task 7 没做全——**先回报，不要在这里补抄一份**（两处定义会让 `tsc` 报 duplicate identifier，而且这两个形状是 `StudyTimeService` 的契约，必须只有一处真源）。

为便于核对，Task 7 Step 0 粘进去的应当是下面这两段（**仅供比对，勿再粘贴一次**）：

```ts
/**
 * 学习时长（spec §8.2）。`source: 'sessions'` 是**口径标记**：家长端同时存在
 * 「活跃天数」（四路时间戳代理）与「学习时长」（显式会话）两套口径，UI 必须能区分，
 * 见 spec §10 的第 1 条硬约束。
 */
export interface StudyTimeSummary {
  totalSeconds: number;
  /** 会话口径的「有学习的天数」，与旧 `activeDays7` **刻意不同**。 */
  activeDays: number;
  byDay: Array<{ date: string; seconds: number }>;
  byModule: Array<{ module: string; seconds: number }>;
  /** 只含 `subject_id IS NOT NULL` 的会话；没选学科的会话不进这张表。 */
  bySubject: Array<{ subjectId: number; seconds: number }>;
  source: 'sessions';
}

/** 今日已用时长（spec §8.2）。`limitMinutes: null` = 家长未设限。 */
export interface TodayUsageSummary {
  date: string;
  activeSeconds: number;
  limitMinutes: number | null;
  /** `>=` 判定：用满上限即算超出（管控语义是「该停了」）。 */
  exceeded: boolean;
  byModule: Array<{ module: string; seconds: number }>;
}
```

- [ ] **Step 2: 加 controller 端点**

`apps/server/src/modules/parent-insights/parent-insights.controller.ts`：
顶部 import 加

```ts
import { StudyTimeService } from './study-time.service.js';
import type { StudyTimeSummary, TodayUsageSummary } from './dto/parent-insights.dto.js';
```

构造函数加一个参数（放在 `chatLogsService` 之后）：

```ts
    private readonly studyTimeService: StudyTimeService,
```

类末尾（`getChatLog` 之后、类闭合 `}` 之前）加两个 handler：

```ts
  /**
   * 学习时长（spec §8.2）。`from`/`to` 形如 `YYYY-MM-DD`，缺省近 7 天；
   * 非法值**宽容回落**默认窗口，不 400（与 `period` 的处理一致）。
   *
   * ⚠️ 这个端点的数字与 `dashboard` 里的 `activeDays7` 是**两套口径**（spec §10）。
   * 不要为了「看起来一致」把任何一个改掉。
   */
  @Get('students/:studentId/study-time')
  async getStudyTime(
    @CurrentUser() user: JwtUser,
    @Param('studentId', ParseIntPipe) studentId: number,
    @Query('from') from?: string,
    @Query('to') to?: string,
  ): Promise<StudyTimeSummary> {
    await this.parentService.requireOwnedStudent(user.sub, studentId);
    return this.studyTimeService.getStudyTime(studentId, from, to);
  }

  /** 今日已用时长（spec §8.2）——用于和 `controls.daily_time_limit_minutes` 比较。 */
  @Get('students/:studentId/today-usage')
  async getTodayUsage(
    @CurrentUser() user: JwtUser,
    @Param('studentId', ParseIntPipe) studentId: number,
  ): Promise<TodayUsageSummary> {
    await this.parentService.requireOwnedStudent(user.sub, studentId);
    return this.studyTimeService.getTodayUsage(studentId);
  }
```

- [ ] **Step 3: 模块接线**

`apps/server/src/modules/parent-insights/parent-insights.module.ts`：
- imports 加 `AnalyticsModule`（为了拿到 `StudySessionsService`）与 `ControlsRepository`：

```ts
import { AnalyticsModule } from '../analytics/analytics.module.js';
import { StudyTimeService } from './study-time.service.js';
import { ParentAnalyticsRepository } from '../../database/repositories/parent-analytics.repo.js';
import { ControlsRepository } from '../../database/repositories/controls.repo.js';
```

- `imports: [ParentModule, ProgressModule, AnalyticsModule]`
- `providers` 追加 `StudyTimeService, ParentAnalyticsRepository, ControlsRepository`
- 模块 JSDoc 补一句：`imports: [AnalyticsModule]` 是为了 `StudyTimeService` 注入 `StudySessionsService`（`AnalyticsModule` 已 `exports: [StudySessionsService]`）。

- [ ] **Step 4: 写归属校验测试**

若 `parent-insights.controller.test.ts` 不存在，Create（否则追加一个 describe）：

```ts
import { describe, it, expect, vi } from 'vitest';
import { ParentInsightsController } from './parent-insights.controller.js';
import type { ParentService } from '../parent/parent.service.js';
import type { StudyTimeService } from './study-time.service.js';

function makeController(requireOwnedStudent: ReturnType<typeof vi.fn>) {
  const parentService = { requireOwnedStudent } as unknown as ParentService;
  const studyTime = {
    getStudyTime: vi.fn().mockResolvedValue({ totalSeconds: 0 }),
    getTodayUsage: vi.fn().mockResolvedValue({ activeSeconds: 0 }),
  } as unknown as StudyTimeService;
  const controller = new ParentInsightsController(
    parentService,
    {} as never, // dashboardService
    {} as never, // reportService
    {} as never, // errorsService
    {} as never, // chatLogsService
    studyTime,
  );
  return { controller, studyTime };
}

const USER = { sub: 3, role: 'parent' as const };

describe('ParentInsightsController 学习时长端点', () => {
  it('study-time 先做归属校验，再取数', async () => {
    const order: string[] = [];
    const requireOwned = vi.fn().mockImplementation(async () => {
      order.push('ownership');
    });
    const { controller, studyTime } = makeController(requireOwned);
    (studyTime.getStudyTime as any).mockImplementation(async () => {
      order.push('query');
      return { totalSeconds: 0 };
    });

    await controller.getStudyTime(USER, 11, '2026-09-13', '2026-09-19');
    expect(order).toEqual(['ownership', 'query']);
    expect(requireOwned).toHaveBeenCalledWith(3, 11);
    expect(studyTime.getStudyTime).toHaveBeenCalledWith(11, '2026-09-13', '2026-09-19');
  });

  it('归属校验失败时**不取数**（1005 不许泄漏存在性）', async () => {
    const requireOwned = vi.fn().mockRejectedValue(new Error('1005'));
    const { controller, studyTime } = makeController(requireOwned);
    await expect(controller.getTodayUsage(USER, 11)).rejects.toThrow();
    expect(studyTime.getTodayUsage).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 5: 跑测试 + 构建**

```bash
cd apps/server && npx vitest run src/modules/parent-insights && npm run build
```

Expected: 测试 PASS；构建通过。

- [ ] **Step 6: Commit**

```bash
git add apps/server/src/modules/parent-insights/
git commit -m "feat(parent): study-time / today-usage 两个端点 + 模块接线"
```

---

### Task 9: `learnContextStore` 加 `subjectId`

**Files:**
- Modify: `apps/web/src/store/learnContextStore.ts`
- Modify: `apps/web/src/pages/student/StarMapPage.tsx:130-134`
- Test: `apps/web/src/store/learnContextStore.test.ts`（新建）

**Interfaces:**
- Produces: `useLearnContextStore.getState().subjectId: number | null`（`AnalyticsShell` 的 `subjectIdProvider` 读它）
- 注意：`StudentLayout.tsx:9` 用解构 `const { subjectName, gradeName, publisher } = useLearnContextStore();`——加字段**不会**破坏它，不要去改它。

- [ ] **Step 1: 写失败测试**

Create `apps/web/src/store/learnContextStore.test.ts`：

```ts
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { useLearnContextStore } from './learnContextStore';

beforeEach(() => {
  useLearnContextStore.setState({ subjectId: null, subjectName: null, gradeName: null, publisher: null });
});

describe('learnContextStore', () => {
  it('setContext 一并存下 subjectId（埋点上报需要数字学科 id，不是名字）', () => {
    useLearnContextStore.getState().setContext({
      subjectId: 7,
      subjectName: '数学',
      gradeName: '七年级上',
      publisher: '人教版',
    });
    const s = useLearnContextStore.getState();
    expect(s.subjectId).toBe(7);
    expect(s.subjectName).toBe('数学');
  });

  it('未选学科时初始值是 null（不是 0）——0 会被服务端当成非法学科', async () => {
    // 必须拿一个**全新的模块实例**来观察初始值：beforeEach 的 setState 会把这个字段
    // 直接写进去（Zustand 合并未声明的键），在同一个实例上断言只会断言到 beforeEach 自己。
    // 同理**不能**改用「把 subjectId 从 beforeEach 里删掉」来省事——本文件第一条用例会把
    // subjectId 写成 7，模块级单例下就变成靠用例顺序决定成败。
    // 初始值若被改成 0（服务端会当成非法学科），这条必须红。
    vi.resetModules();
    const fresh = await import('./learnContextStore');
    expect(fresh.useLearnContextStore.getState().subjectId).toBeNull();
  });
});
```

- [ ] **Step 2: 跑 RED —— 注意真正的 RED 在 `tsc`，不在 vitest**

```bash
cd apps/web && npx vitest run src/store/learnContextStore.test.ts
```

Expected: **两条都 PASS**（不是 FAIL）。这不是测试写错——Zustand 的 `set` 会合并任意键、esbuild 又把类型擦掉，所以旧的 `setContext` 在运行时**本来就会**把 `subjectId` 存进去。类型层才是真正缺的那一半：

```bash
cd apps/web && npx tsc -b
```

Expected: FAIL —— `Property 'subjectId' does not exist on type 'LearnContextState'`（约 4 处：store 接口、`setContext` 参数、初始化对象、`StarMapPage` 调用点）。**这才是本任务的 RED**，也是唯一的守卫：`npm test`（vitest）不做类型检查，只有 `npm run build` 里的 `tsc -b` 会。

- [ ] **Step 3: 实现 store 改动**

`apps/web/src/store/learnContextStore.ts` 全文改为：

```ts
import { create } from 'zustand';

/**
 * 当前学习上下文（星图数据加载后写入，供 StudentLayout 顶栏展示真实 学科·年级·版本）。
 *
 * `subjectId` 是**数字**学科 id：顶栏只显示名字就够，但埋点上报 `study_sessions.subject_id`
 * 需要数字（后端要校验它属于在售学科，并按它做「各科学了多久」的聚合）。
 * 为什么读它而不读**路由 state**：这个值在**星图加载那一次**写进来，之后每个下游页面都能直接读到，
 * 不必把路由 state 一路透传下去（深链直接进下游页时路由 state 根本没有）。store 是内存态，
 * 硬刷新同样会丢——但它丢的是**同一个来源**，而路由 state 是在导航链上逐跳丢失。
 */
interface LearnContextState {
  subjectId: number | null;
  subjectName: string | null;
  gradeName: string | null;
  publisher: string | null;
  setContext: (ctx: {
    subjectId: number | null;
    subjectName: string | null;
    gradeName: string | null;
    publisher: string | null;
  }) => void;
}

export const useLearnContextStore = create<LearnContextState>((set) => ({
  subjectId: null,
  subjectName: null,
  gradeName: null,
  publisher: null,
  setContext: (ctx) => set(ctx),
}));
```

- [ ] **Step 4: 让 StarMapPage 写入 `subjectId`**

`apps/web/src/pages/student/StarMapPage.tsx` 的 `setContext` 调用（约 130 行）改为：

```ts
      useLearnContextStore.getState().setContext({
        subjectId,
        subjectName: result.subjectName,
        gradeName: result.gradeName,
        publisher: result.publisher || null,
      });
```

（`subjectId` 是该组件已有的局部变量，来自 `location.state`，见 `StarMapPage.tsx:119`——无需新增变量。）

- [ ] **Step 5: 跑测试确认通过 + 前端全量测试**

```bash
cd apps/web && npx vitest run src/store/learnContextStore.test.ts && npm test
```

Expected: 新用例 PASS；全量 573+ 条仍绿（`StudentLayout` 的解构不受影响）。

- [ ] **Step 6: Commit**

```bash
git add apps/web/src/store/learnContextStore.ts apps/web/src/store/learnContextStore.test.ts apps/web/src/pages/student/StarMapPage.tsx
git commit -m "feat(web): learnContextStore 记住 subjectId（埋点上报用）"
```

---

### Task 10: 前端 `analytics/types.ts` + `sceneMap.ts`

**Files:**
- Create: `apps/web/src/analytics/types.ts`
- Create: `apps/web/src/analytics/sceneMap.ts`
- Test: `apps/web/src/analytics/sceneMap.test.ts`
- Test: `apps/web/src/analytics/types.test.ts`（`newSessionUid` 的 UUID 形状 + 缺 `crypto.randomUUID` 的回退路径 + `sceneKey`；**必须用与后端 `UUID_RE` 同形的手写正则**——前端不许 import 服务端代码，靠注释指明镜像来源）

**Interfaces:**
- Produces:
  - 类型 `StudyModule` / `StudyScene` / `SessionState` / `SessionEvent` / `EndReason` / `ClientState` / `ScreenClass` / `InputType` / `AppShell` / `SceneInfo`
  - `mapScene(pathname: string): SceneInfo`（**唯一真源**：pathname 正则 → module/scene/isStudyScene）

- [ ] **Step 1: 写类型**

Create `apps/web/src/analytics/types.ts`：

```ts
/**
 * 埋点会话的字典（后端 `study-sessions.service.ts` 白名单的**超集**：本文件多出 4 个值）。
 *
 * 服务端是权威：字典**不匹配**的 module/scene 会被 1001 拒掉，而且是**静默**的——
 * 会话根本不会创建，家长端时长永远是空。所以多出来的 4 个值必须小心：
 *
 * - 多出的 `admin` / `parent`（module）与 `parent_dashboard` / `admin_dashboard`（scene）
 *   后端**不认**——它们只在 `isStudyScene: false` 的路由上产出，用于 `page_view` 之类
 *   **非会话事件**的归属（spec §5.1）。
 * - ⚠️ 因此**开会话的闸门只能看 `isStudyScene` / `sceneKey(info) !== null`，
 *   绝不能写成 `module != null`**——后者会把 `admin` / `parent` 送进 `start()`，直接 1001。
 */
export type StudyModule =
  | 'mainline'
  | 'aux_qna'
  | 'training_targeted'
  | 'training_error_practice'
  | 'exam'
  | 'chinese_dictation'
  | 'chinese_interpretation'
  | 'chinese_meaning'
  | 'en_vocabulary'
  | 'admin'
  | 'parent';

export type StudyScene =
  | 'course_detail'
  | 'star_map'
  | 'aux_chat'
  | 'targeted_run'
  | 'error_run'
  | 'exam_run'
  | 'dictation_run'
  | 'interpretation_run'
  | 'meaning_run'
  | 'vocabulary_run'
  | 'profile'
  | 'rewards'
  | 'parent_dashboard'
  | 'admin_dashboard';

export type SessionState = 'idle' | 'active' | 'hidden' | 'ended';

export type SessionEvent =
  | 'ROUTE_ENTER'
  | 'ROUTE_LEAVE'
  | 'VISIBLE'
  | 'HIDDEN'
  | 'IDLE_TIMEOUT'
  | 'PAGEHIDE';

export type EndReason = 'route_change' | 'pagehide' | 'idle_timeout' | 'closed' | 'hidden_timeout';

export type ClientState = 'visible' | 'hidden';

export type ScreenClass = 'ipad_landscape' | 'desktop' | 'tablet_portrait' | 'mobile';
export type InputType = 'touch' | 'mouse' | 'hybrid';
export type AppShell = 'web' | 'electron';

export interface SceneInfo {
  module: StudyModule | null;
  scene: StudyScene | null;
  /** `true` = 该路由算「学习」，要开会话；配置页/入口页只管看，不算时长。 */
  isStudyScene: boolean;
}

/**
 * 会话标识（`study_sessions.session_uid`）。
 *
 * 必须是**合法 UUID 形状**：后端 `UUID_RE` 只认 `8-4-4-4-12` 十六进制，不合法就直接 1001，
 * 而那意味着**会话静默全丢**（没有任何提示，家长端时长永远是空）。
 *
 * 为什么不能只用 `crypto.randomUUID()`：它**只在安全上下文**存在。`http://localhost` 算安全，
 * 但本产品的主断点是 **iPad 横屏**，开发时通常用 `http://192.168.x.x:5173` 这类局域网地址打开——
 * 那不是安全上下文，`randomUUID` 是 undefined。所以回退分支**不是**防御性代码，是会被真实走到的。
 *
 * `crypto.getRandomValues` 不受安全上下文限制，用它拼 v4 形状；只有连它都没有时才退到 Math.random。
 */
export function newSessionUid(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }

  const bytes = new Uint8Array(16);
  if (typeof crypto !== 'undefined' && typeof crypto.getRandomValues === 'function') {
    crypto.getRandomValues(bytes);
  } else {
    for (let i = 0; i < 16; i += 1) bytes[i] = Math.floor(Math.random() * 256);
  }
  // 按 RFC 4122 打上 v4 的版本位与变体位——形状对了后端才收
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;

  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
```

- [ ] **Step 2: 写失败测试**

Create `apps/web/src/analytics/sceneMap.test.ts`：

```ts
import { describe, it, expect } from 'vitest';
import { mapScene } from './sceneMap';

describe('mapScene', () => {
  it.each([
    ['/student/course-detail', 'mainline', 'course_detail', true],
    ['/student/course-detail?lessonId=3', 'mainline', 'course_detail', true],
    ['/student/auxiliary', 'aux_qna', 'aux_chat', true],
    ['/student/training/targeted/run', 'training_targeted', 'targeted_run', true],
    ['/student/training/errors/run', 'training_error_practice', 'error_run', true],
    ['/student/training/exam/run/42', 'exam', 'exam_run', true],
    ['/student/training/chinese/dictation/run', 'chinese_dictation', 'dictation_run', true],
    ['/student/training/chinese/interpretation/run', 'chinese_interpretation', 'interpretation_run', true],
    ['/student/training/chinese/meaning/run', 'chinese_meaning', 'meaning_run', true],
    ['/student/training/english/vocabulary/run', 'en_vocabulary', 'vocabulary_run', true],
  ])('%s → %s/%s（学习会话=%s）', (path, module, scene, isStudy) => {
    expect(mapScene(path)).toEqual({ module, scene, isStudyScene: isStudy });
  });

  it.each([
    ['/student/star-map', 'mainline', 'star_map'],
    ['/student/subjects', null, null],
    ['/student/entry', null, null],
    ['/student/profile', null, 'profile'],
    ['/student/rewards', null, 'rewards'],
    ['/parent/dashboard', 'parent', 'parent_dashboard'],
    ['/admin/analytics', 'admin', 'admin_dashboard'],
  ])('%s → 非学习场景，只定位 module/scene', (path, module, scene) => {
    expect(mapScene(path)).toEqual({ module, scene, isStudyScene: false });
  });

  it.each([['/login'], ['/register'], ['/'], ['/unknown/path']])(
    '%s → 完全不记（module/scene 都是 null）',
    (path) => {
      expect(mapScene(path)).toEqual({ module: null, scene: null, isStudyScene: false });
    },
  );

  it('配置页不算学习会话（避免把「挑题 10 分钟」算成学习时长）', () => {
    expect(mapScene('/parent/students/11/config').isStudyScene).toBe(false);
    expect(mapScene('/student/star-map').isStudyScene).toBe(false);
  });

  it('忽略 query 与 hash（同页带参数跳转不应重开会话）', () => {
    expect(mapScene('/student/training/targeted/run?session=9#top')).toEqual(
      mapScene('/student/training/targeted/run'),
    );
  });
});
```

- [ ] **Step 3: 跑测试确认失败**

```bash
cd apps/web && npx vitest run src/analytics/sceneMap.test.ts
```

Expected: FAIL —— 模块不存在。

- [ ] **Step 4: 实现 `sceneMap.ts`**

Create `apps/web/src/analytics/sceneMap.ts`：

```ts
import type { SceneInfo, StudyModule, StudyScene } from './types';

/** 一条映射规则：正则命中即返回（**按顺序**匹配，具体路径必须在通配之前）。 */
interface Rule {
  pattern: RegExp;
  module: StudyModule | null;
  scene: StudyScene | null;
  isStudyScene: boolean;
}

/**
 * 路由 → scene 的**唯一真源**（spec §5.3）。
 *
 * 服务端**不维护第二份表**：它按 route 前缀推导自己的 module（与前端的 pathname 无关）。
 * 因此这里改规则不需要同步后端——但 `module` / `scene` 的**取值**必须落在后端白名单内
 * （`study-sessions.service.ts` 的 `STUDY_MODULES` / `STUDY_SCENES`），否则会话会被 1001 拒掉。
 *
 * 顺序敏感：`/student/training/chinese/dictation/run` 必须排在
 * `/student/training/...` 的通配之前——所以这里**不用**通配，只列具体路径。
 */
const RULES: Rule[] = [
  // ---- 学习场景（开会话）----
  { pattern: /^\/student\/course-detail/, module: 'mainline', scene: 'course_detail', isStudyScene: true },
  { pattern: /^\/student\/auxiliary\/?$/, module: 'aux_qna', scene: 'aux_chat', isStudyScene: true },
  { pattern: /^\/student\/training\/targeted\/run/, module: 'training_targeted', scene: 'targeted_run', isStudyScene: true },
  { pattern: /^\/student\/training\/errors\/run/, module: 'training_error_practice', scene: 'error_run', isStudyScene: true },
  { pattern: /^\/student\/training\/exam\/run/, module: 'exam', scene: 'exam_run', isStudyScene: true },
  { pattern: /^\/student\/training\/chinese\/dictation\/run/, module: 'chinese_dictation', scene: 'dictation_run', isStudyScene: true },
  { pattern: /^\/student\/training\/chinese\/interpretation\/run/, module: 'chinese_interpretation', scene: 'interpretation_run', isStudyScene: true },
  { pattern: /^\/student\/training\/chinese\/meaning\/run/, module: 'chinese_meaning', scene: 'meaning_run', isStudyScene: true },
  { pattern: /^\/student\/training\/english\/vocabulary\/run/, module: 'en_vocabulary', scene: 'vocabulary_run', isStudyScene: true },

  // ---- 非学习场景（只定位，不算时长）----
  { pattern: /^\/student\/star-map/, module: 'mainline', scene: 'star_map', isStudyScene: false },
  { pattern: /^\/student\/profile/, module: null, scene: 'profile', isStudyScene: false },
  { pattern: /^\/student\/rewards/, module: null, scene: 'rewards', isStudyScene: false },
  { pattern: /^\/parent\//, module: 'parent', scene: 'parent_dashboard', isStudyScene: false },
  { pattern: /^\/admin\//, module: 'admin', scene: 'admin_dashboard', isStudyScene: false },

  // ---- 完全不记（module/scene 都是 null）----
  // 学科选择 / 入口选择 / 配置页：家长在「挑题 10 分钟」不该被算成学习时长。
  { pattern: /^\/student\/(subjects|entry)/, module: null, scene: null, isStudyScene: false },
  { pattern: /^\/(login|register)\/?$/, module: null, scene: null, isStudyScene: false },
];

const NOT_TRACKED: SceneInfo = { module: null, scene: null, isStudyScene: false };

/**
 * pathname → `{ module, scene, isStudyScene }`。
 *
 * 先剥掉 query / hash：同页带参数跳转（如翻页 `?page=2`）不应被当成新场景而重开会话。
 * 未命中任何规则 → 完全不记（返回全 null），**不猜**——猜错会污染时长统计。
 */
export function mapScene(pathname: string): SceneInfo {
  const path = pathname.split('?')[0].split('#')[0];
  for (const rule of RULES) {
    if (rule.pattern.test(path)) {
      return { module: rule.module, scene: rule.scene, isStudyScene: rule.isStudyScene };
    }
  }
  return NOT_TRACKED;
}

/** 会话去重键：同一场景的重复 `onRouteChange` 不重开会话。 */
export function sceneKey(info: SceneInfo): string | null {
  if (!info.isStudyScene || !info.module || !info.scene) return null;
  return `${info.module}/${info.scene}`;
}
```

- [ ] **Step 5: 跑测试确认通过**

```bash
cd apps/web && npx vitest run src/analytics/sceneMap.test.ts
```

Expected: PASS（约 25 条）

- [ ] **Step 6: Commit**

```bash
git add apps/web/src/analytics/types.ts apps/web/src/analytics/sceneMap.ts apps/web/src/analytics/sceneMap.test.ts
git commit -m "feat(web): analytics 类型 + sceneMap（pathname → module/scene 唯一真源）"
```

---

### Task 11: 前端 `sessionMachine.ts`

**Files:**
- Create: `apps/web/src/analytics/sessionMachine.ts`
- Test: `apps/web/src/analytics/sessionMachine.test.ts`

**Interfaces:**
- Consumes: `SessionState` / `SessionEvent` / `EndReason` / `ClientState`（Task 10）
- Produces:
  - `interface SessionTransition { state: SessionState; effects: { start: boolean; end: EndReason | null; heartbeat: ClientState | null } }`
  - `transition(prev: SessionState, event: SessionEvent): SessionTransition`

- [ ] **Step 1: 写失败测试**

Create `apps/web/src/analytics/sessionMachine.test.ts`：

```ts
import { describe, it, expect } from 'vitest';
import { transition } from './sessionMachine';

const NO_FX = { start: false, end: null, heartbeat: null };

describe('sessionMachine.transition', () => {
  it('idle + ROUTE_ENTER → active，起会话并立刻发一次 visible 心跳', () => {
    expect(transition('idle', 'ROUTE_ENTER')).toEqual({
      state: 'active',
      effects: { start: true, end: null, heartbeat: 'visible' },
    });
  });

  it('active + IDLE_TIMEOUT → hidden，发 hidden 心跳（暂停计时但不断会话）', () => {
    expect(transition('active', 'IDLE_TIMEOUT')).toEqual({
      state: 'hidden',
      effects: { start: false, end: null, heartbeat: 'hidden' },
    });
  });

  it('hidden + VISIBLE → active，恢复计时', () => {
    expect(transition('hidden', 'VISIBLE')).toEqual({
      state: 'active',
      effects: { start: false, end: null, heartbeat: 'visible' },
    });
  });

  it('active + HIDDEN → hidden（visibilitychange 切后台）', () => {
    expect(transition('active', 'HIDDEN')).toEqual({
      state: 'hidden',
      effects: { start: false, end: null, heartbeat: 'hidden' },
    });
  });

  it('active + ROUTE_LEAVE → ended（reason=route_change）', () => {
    expect(transition('active', 'ROUTE_LEAVE')).toEqual({
      state: 'ended',
      effects: { start: false, end: 'route_change', heartbeat: null },
    });
  });

  it('hidden + ROUTE_LEAVE → ended（reason=route_change）', () => {
    expect(transition('hidden', 'ROUTE_LEAVE').effects.end).toBe('route_change');
  });

  it('active + PAGEHIDE → ended（reason=pagehide）', () => {
    expect(transition('active', 'PAGEHIDE')).toEqual({
      state: 'ended',
      effects: { start: false, end: 'pagehide', heartbeat: null },
    });
  });

  it('hidden + PAGEHIDE → ended（reason=pagehide）', () => {
    expect(transition('hidden', 'PAGEHIDE').effects.end).toBe('pagehide');
  });

  it('ended + ROUTE_ENTER → active：连续走两个学习场景不必回 idle', () => {
    expect(transition('ended', 'ROUTE_ENTER')).toEqual({
      state: 'active',
      effects: { start: true, end: null, heartbeat: 'visible' },
    });
  });

  it.each([
    ['idle', 'ROUTE_LEAVE'],
    ['idle', 'VISIBLE'],
    ['idle', 'HIDDEN'],
    ['idle', 'IDLE_TIMEOUT'],
    ['idle', 'PAGEHIDE'],
    ['ended', 'ROUTE_LEAVE'],
    ['ended', 'VISIBLE'],
    ['ended', 'HIDDEN'],
    ['ended', 'IDLE_TIMEOUT'],
    ['ended', 'PAGEHIDE'],
    ['hidden', 'HIDDEN'],
    ['hidden', 'IDLE_TIMEOUT'],
  ] as const)('幂等/忽略：%s + %s 不产生任何副作用', (state, event) => {
    expect(transition(state, event)).toEqual({ state, effects: NO_FX });
  });

  it('active + VISIBLE 是空操作（已经在前台，不该重复发心跳）', () => {
    expect(transition('active', 'VISIBLE')).toEqual({ state: 'active', effects: NO_FX });
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

```bash
cd apps/web && npx vitest run src/analytics/sessionMachine.test.ts
```

Expected: FAIL —— 模块不存在。

- [ ] **Step 3: 实现**

Create `apps/web/src/analytics/sessionMachine.ts`：

```ts
import type { ClientState, EndReason, SessionEvent, SessionState } from './types';

export interface SessionEffects {
  /** 要新开一段会话（`sessionUid` 由 tracker 生成）。 */
  start: boolean;
  /** 要结束当前会话（`null` = 不结束）。 */
  end: EndReason | null;
  /** 要发一次心跳（`null` = 不发）。 */
  heartbeat: ClientState | null;
}

export interface SessionTransition {
  state: SessionState;
  effects: SessionEffects;
}

// 空操作迁移共用的哨兵。**冻结**：它是被多处按引用返回的同一对象，
// 将来若有调用方就地改写它，后续所有空操作迁移都会静默带上脏副作用。
const NO_EFFECTS: SessionEffects = Object.freeze({ start: false, end: null, heartbeat: null });

/**
 * 纯 reducer（spec §7.4 的状态机）。**不碰 DOM、不碰网络、不读时钟**——
 * 所有副作用由 tracker 按 `effects` 执行，因此这里可以表驱动地穷举测试。
 *
 * 状态：`idle | active | hidden | ended`
 *
 * ```
 * idle    --ROUTE_ENTER-->  active   起会话 + 首次心跳
 * active  --IDLE_TIMEOUT--> hidden   120s 无输入 → 暂停计时
 * hidden  --VISIBLE-->      active   恢复计时
 * active  --HIDDEN-->       hidden   visibilitychange
 * hidden  --VISIBLE-->      active
 * active|hidden --ROUTE_LEAVE|PAGEHIDE--> ended  带 end_reason
 * ended   --ROUTE_ENTER-->  active   （学习页 A → 学习页 B 是 end 后立刻 start）
 * ```
 *
 * `hidden` 期间**不结束会话**：用户切出去看一眼消息就回来，不该被算成两次学习；
 * 但也不计时（服务端只在 `client_state = 'visible'` 时累加秒数）。
 */
export function transition(prev: SessionState, event: SessionEvent): SessionTransition {
  switch (prev) {
    case 'idle':
      return event === 'ROUTE_ENTER'
        ? { state: 'active', effects: { start: true, end: null, heartbeat: 'visible' } }
        : { state: 'idle', effects: NO_EFFECTS };

    case 'active':
      switch (event) {
        case 'IDLE_TIMEOUT':
          return { state: 'hidden', effects: { start: false, end: null, heartbeat: 'hidden' } };
        case 'HIDDEN':
          return { state: 'hidden', effects: { start: false, end: null, heartbeat: 'hidden' } };
        case 'ROUTE_LEAVE':
          return { state: 'ended', effects: { start: false, end: 'route_change', heartbeat: null } };
        case 'PAGEHIDE':
          return { state: 'ended', effects: { start: false, end: 'pagehide', heartbeat: null } };
        // VISIBLE / ROUTE_ENTER 已在前台：空操作，不重复发心跳
        default:
          return { state: 'active', effects: NO_EFFECTS };
      }

    case 'hidden':
      switch (event) {
        case 'VISIBLE':
          return { state: 'active', effects: { start: false, end: null, heartbeat: 'visible' } };
        case 'ROUTE_LEAVE':
          return { state: 'ended', effects: { start: false, end: 'route_change', heartbeat: null } };
        case 'PAGEHIDE':
          return { state: 'ended', effects: { start: false, end: 'pagehide', heartbeat: null } };
        default:
          return { state: 'hidden', effects: NO_EFFECTS };
      }

    case 'ended':
      return event === 'ROUTE_ENTER'
        ? { state: 'active', effects: { start: true, end: null, heartbeat: 'visible' } }
        : { state: 'ended', effects: NO_EFFECTS };
  }
}
```

- [ ] **Step 4: 跑测试确认通过**

```bash
cd apps/web && npx vitest run src/analytics/sessionMachine.test.ts
```

Expected: PASS（**22 条**——9 个整形状 `it` + 12 个 `it.each` 幂等/忽略格 + 1 个 `active + VISIBLE` 空操作）。

⚠️ 覆盖面说明：4 状态 × 6 事件 = **24 格**，本表显式断言 **22 格**，缺的两格是 `active + ROUTE_ENTER` 与 `hidden + ROUTE_ENTER`（都落在 `default` 分支 → 状态不变、无副作用）。缺它们是因为**这两格在生产里不可达**：`onRouteChange` 对同一场景会先去重、对不同场景一定先发 `ROUTE_LEAVE`（把状态推回 `idle`）再发 `ROUTE_ENTER`，而 `hidden` 蕴含 `sessionUid != null`（`resetLocalState` 同时清 uid 与状态）。留着未断言，是为了不把「不可达行为」写成契约；Task 12 有一条**顺序钉子**（hidden → 切场景 → 必须先 end 再 start）守着这个前提。

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/analytics/sessionMachine.ts apps/web/src/analytics/sessionMachine.test.ts
git commit -m "feat(web): analytics 会话状态机（纯 reducer，表驱动）"
```

---

### Task 12: 前端 `tracker.ts`

**Files:**
- Create: `apps/web/src/analytics/tracker.ts`
- Test: `apps/web/src/analytics/tracker.test.ts`

**Interfaces:**
- Consumes: `mapScene` / `sceneKey`（Task 10）、`transition`（Task 11）、`startStudySession` / `heartbeatStudySession` / `endStudySession`（Task 14，**本任务先按下面的签名 import，Task 14 落地实现**）
- Produces:
  - `interface StudySessionTransport { start(body): Promise<unknown>; heartbeat(uid, state): Promise<unknown>; end(uid, reason): Promise<unknown> }`
  - `setEnabled(v: boolean): void`
  - `setTransport(t: StudySessionTransport): void`
  - `setSubjectIdProvider(fn: () => number | null): void`
  - `onRouteChange(info: SceneInfo): void`
  - `notifyInput(): void`
  - `setVisibility(visible: boolean): void`
  - `onPageHide(): void`
  - `collectScreenClass(w, h)` / `collectInputType(matches)` / `collectAppShell(ua)` / `collectDeviceInfo()`
  - `__resetForTests(): void`
  - 常量 `HEARTBEAT_INTERVAL_MS = 30_000`、`IDLE_TIMEOUT_MS = 120_000`

> **执行顺序提醒**：本任务 import `@/services/api` 的三个会话方法，它们由 Task 14 落地。若按顺序执行，请**先做 Task 14 的 api.ts 部分**（只加方法与类型，不加页面），或在 Task 12 之前先跑一次 `npx tsc -b` 确认 import 解析。两条路都可以，但不要留下编译不过的中间态。

- [ ] **Step 1: 写失败测试**

Create `apps/web/src/analytics/tracker.test.ts`：

```ts
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as tracker from './tracker';

function makeTransport() {
  return {
    start: vi.fn().mockResolvedValue(undefined),
    heartbeat: vi.fn().mockResolvedValue(undefined),
    end: vi.fn().mockResolvedValue(undefined),
  };
}

const STUDY = { module: 'training_targeted', scene: 'targeted_run', isStudyScene: true } as const;
const NOT_STUDY = { module: null, scene: 'profile', isStudyScene: false } as const;

let transport: ReturnType<typeof makeTransport>;

beforeEach(() => {
  vi.useFakeTimers();
  tracker.__resetForTests();
  transport = makeTransport();
  tracker.setTransport(transport);
  tracker.setSubjectIdProvider(() => 7);
  // jsdom 没有 matchMedia；单指触屏 → touch
  vi.stubGlobal('matchMedia', (q: string) => ({ matches: q.includes('pointer: coarse)') }));
  tracker.setEnabled(true);
});

afterEach(() => {
  tracker.__resetForTests();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('tracker 会话生命周期', () => {
  it('进入学习场景 → start，设备信息**一次性**带上', async () => {
    tracker.onRouteChange(STUDY);
    await vi.advanceTimersByTimeAsync(0);

    expect(transport.start).toHaveBeenCalledTimes(1);
    const body = transport.start.mock.calls[0][0];
    expect(body.module).toBe('training_targeted');
    expect(body.scene).toBe('targeted_run');
    expect(body.subjectId).toBe(7);
    expect(body.screenClass).toBeTruthy();
    expect(body.inputType).toBe('touch');
    expect(body.appShell).toBe('web');
    expect(body.sessionUid).toMatch(/[0-9a-f-]{8,}/i);
  });

  it('30s 心跳只发 state，**不重复带设备字段**', async () => {
    tracker.onRouteChange(STUDY);
    await vi.advanceTimersByTimeAsync(30_000);

    expect(transport.heartbeat).toHaveBeenCalledWith(expect.any(String), 'visible');
    const args = transport.heartbeat.mock.calls[0];
    expect(args).toHaveLength(2); // (uid, state) —— 没有第三个「设备」参数
  });

  it('同一学习场景重复调用不重开会话（query 变化不该算新会话）', async () => {
    tracker.onRouteChange(STUDY);
    tracker.onRouteChange(STUDY);
    await vi.advanceTimersByTimeAsync(0);
    expect(transport.start).toHaveBeenCalledTimes(1);
  });

  it('学习场景 A → B：先 end(route_change) 再 start', async () => {
    tracker.onRouteChange(STUDY);
    tracker.onRouteChange({ module: 'en_vocabulary', scene: 'vocabulary_run', isStudyScene: true });
    await vi.advanceTimersByTimeAsync(0);

    expect(transport.end).toHaveBeenCalledWith(expect.any(String), 'route_change');
    expect(transport.start).toHaveBeenCalledTimes(2);
  });

  it('hidden 状态下切学习场景：仍必须先 end 再 start', async () => {
    // 顺序钉子：状态机的 `hidden + ROUTE_ENTER` 是**死格**（状态不变、不 start）。
    // 若 onRouteChange 不先发 ROUTE_LEAVE，切场景时会静默**开不出新会话**，
    // 而且因为各入口都以 sessionUid 为闸门，之后整个 SPA 生命周期都不会再有会话。
    tracker.onRouteChange(STUDY);
    await vi.advanceTimersByTimeAsync(125_000); // 空闲 → hidden
    const firstUid = transport.start.mock.calls[0][0].sessionUid;

    tracker.onRouteChange({ module: 'en_vocabulary', scene: 'vocabulary_run', isStudyScene: true });
    await vi.advanceTimersByTimeAsync(0);

    expect(transport.end).toHaveBeenCalledWith(firstUid, 'route_change');
    expect(transport.start).toHaveBeenCalledTimes(2);
    expect(transport.start.mock.calls[1][0].module).toBe('en_vocabulary');
  });

  it('离开到非学习场景 → end(route_change)，不再 start', async () => {
    tracker.onRouteChange(STUDY);
    tracker.onRouteChange(NOT_STUDY);
    await vi.advanceTimersByTimeAsync(0);
    expect(transport.end).toHaveBeenCalledWith(expect.any(String), 'route_change');
    expect(transport.start).toHaveBeenCalledTimes(1);
  });

  it('120s 无输入 → 发 hidden 心跳（暂停计时但不断会话）', async () => {
    tracker.onRouteChange(STUDY);
    await vi.advanceTimersByTimeAsync(120_000 + 5_000);

    expect(transport.heartbeat).toHaveBeenCalledWith(expect.any(String), 'hidden');
    expect(transport.end).not.toHaveBeenCalled();
  });

  it('hidden 后用户有输入 → 发 visible 心跳恢复计时', async () => {
    tracker.onRouteChange(STUDY);
    await vi.advanceTimersByTimeAsync(125_000);
    tracker.notifyInput();
    await vi.advanceTimersByTimeAsync(0);
    expect(transport.heartbeat).toHaveBeenLastCalledWith(expect.any(String), 'visible');
  });

  it('页面隐藏 → hidden 心跳；恢复可见 → visible 心跳', async () => {
    tracker.onRouteChange(STUDY);
    tracker.setVisibility(false);
    expect(transport.heartbeat).toHaveBeenLastCalledWith(expect.any(String), 'hidden');
    tracker.setVisibility(true);
    expect(transport.heartbeat).toHaveBeenLastCalledWith(expect.any(String), 'visible');
  });

  it('pagehide → end(pagehide)', async () => {
    tracker.onRouteChange(STUDY);
    tracker.onPageHide();
    await vi.advanceTimersByTimeAsync(0);
    expect(transport.end).toHaveBeenCalledWith(expect.any(String), 'pagehide');
  });

  it('未启用（非学生角色）时不发任何请求', async () => {
    tracker.setEnabled(false);
    tracker.onRouteChange(STUDY);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(transport.start).not.toHaveBeenCalled();
    expect(transport.heartbeat).not.toHaveBeenCalled();
  });

  it('传输失败不冒泡（埋点绝不打断学习）', async () => {
    transport.start.mockRejectedValue(new Error('offline'));
    expect(() => tracker.onRouteChange(STUDY)).not.toThrow();
    await expect(vi.advanceTimersByTimeAsync(0)).resolves.toBeUndefined();
  });
});

describe('tracker 设备分档', () => {
  it('屏幕档对齐 iPad 横屏主断点', () => {
    expect(tracker.collectScreenClass(1366, 1024)).toBe('desktop');
    expect(tracker.collectScreenClass(1024, 768)).toBe('ipad_landscape');
    expect(tracker.collectScreenClass(768, 1024)).toBe('tablet_portrait');
    expect(tracker.collectScreenClass(390, 844)).toBe('mobile');
  });

  it('输入类型：粗+细 → hybrid，只粗 → touch，其余 → mouse', () => {
    expect(tracker.collectInputType((q) => q.includes('coarse') || q.includes('fine'))).toBe('hybrid');
    expect(tracker.collectInputType((q) => q.includes('coarse'))).toBe('touch');
    expect(tracker.collectInputType(() => false)).toBe('mouse');
  });

  it('Electron 壳识别', () => {
    expect(tracker.collectAppShell('Mozilla/5.0 ... Electron/31.0.0')).toBe('electron');
    expect(tracker.collectAppShell('Mozilla/5.0 ... Chrome/126.0.0.0')).toBe('web');
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

```bash
cd apps/web && npx vitest run src/analytics/tracker.test.ts
```

Expected: FAIL —— 模块不存在。

- [ ] **Step 3: 实现**

Create `apps/web/src/analytics/tracker.ts`：

```ts
import { endStudySession, heartbeatStudySession, startStudySession } from '@/services/api';
import { sceneKey } from './sceneMap';
import { transition } from './sessionMachine';
import { newSessionUid } from './types';
import type {
  AppShell,
  ClientState,
  EndReason,
  InputType,
  SceneInfo,
  ScreenClass,
  SessionEvent,
  SessionState,
} from './types';

/** 与后端 `study-sessions.service.ts` 的常量对齐（心跳间隔 30s、空闲阈值 120s）。 */
export const HEARTBEAT_INTERVAL_MS = 30_000;
export const IDLE_TIMEOUT_MS = 120_000;
/** 空闲检测的轮询间隔：120s 阈值不必每秒查，5s 粒度足够，且省电。 */
const IDLE_CHECK_INTERVAL_MS = 5_000;
/** 用户活动节流：只在活动停下来时更新 `lastInputAt`，避免 scroll 每次都进回调。 */
const INPUT_THROTTLE_MS = 5_000;

export interface StudySessionStartBody {
  sessionUid: string;
  module: string;
  scene: string;
  subjectId?: number;
  refType?: string;
  refId?: number;
  screenClass?: ScreenClass;
  inputType?: InputType;
  appShell?: AppShell;
}

export interface StudySessionTransport {
  start(body: StudySessionStartBody): Promise<unknown>;
  heartbeat(uid: string, state: ClientState): Promise<unknown>;
  end(uid: string, reason: EndReason): Promise<unknown>;
}

/** 默认传输走 `api.ts`（带 Authorization 的 `fetch`）。测试用 `setTransport` 注入假实现。 */
const defaultTransport: StudySessionTransport = {
  start: (body) => startStudySession(body),
  heartbeat: (uid, state) => heartbeatStudySession(uid, state),
  end: (uid, reason) => endStudySession(uid, reason),
};

let enabled = false;
let transport: StudySessionTransport = defaultTransport;
let subjectIdProvider: () => number | null = () => null;

let state: SessionState = 'idle';
let currentKey: string | null = null;
/** 当前场景的完整信息。开会话必须同时知道 module/scene，而 `currentKey` 只是个去重键。 */
let currentInfo: SceneInfo | null = null;
let sessionUid: string | null = null;
let lastInputAt = 0;
let lastInputRecordedAt = 0;
let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
let idleTimer: ReturnType<typeof setInterval> | null = null;

// ---------------------------------------------------------------- 对外开关

/** 角色闸门：只有学生端启动会话（家长/管理端只落 `page_view`，属 Phase 2）。 */
export function setEnabled(value: boolean): void {
  enabled = value;
  if (!value) {
    // 退出登录 / 角色变化：把在跑的会话收掉，别让它挂到惰性收尾（会白记 5 分钟）
    if (sessionUid) endSession('closed');
    else resetLocalState();
  }
}

/** 测试缝：注入假传输。 */
export function setTransport(next: StudySessionTransport): void {
  transport = next;
}

/** 学科 id 由 `learnContextStore` 提供（见 Task 9），避免 tracker 直接依赖 store。 */
export function setSubjectIdProvider(fn: () => number | null): void {
  subjectIdProvider = fn;
}

/** 测试缝：把模块级状态复位（模块单例会在用例之间残留）。 */
export function __resetForTests(): void {
  disarmTimers();
  transport = defaultTransport;
  subjectIdProvider = () => null;
  enabled = false;
  resetLocalState();
}

// ---------------------------------------------------------------- 路由 / 事件

/**
 * 路由变化。**唯一**的会话开关入口——由 `AnalyticsShell` 的 `useLocation` 副作用驱动。
 *
 * 去重：同一 `module/scene` 重复调用是 no-op（React 严格模式会双跑 effect，
 * 翻页/改 query 也不该被算成新会话）。
 *
 * 开会话**只经状态机**（`runTransition('ROUTE_ENTER')` → `effects.start`），
 * 这里不直接建会话——否则「谁负责开会话」就有两个答案，迟早重复开会话。
 */
export function onRouteChange(info: SceneInfo): void {
  if (!enabled) return;

  const key = sceneKey(info);
  if (key !== null && key === currentKey && sessionUid) return;
  if (sessionUid) runTransition('ROUTE_LEAVE');

  currentKey = key;
  currentInfo = info;
  if (key !== null) runTransition('ROUTE_ENTER');
}

/** 用户活动（节流）。用于空闲检测与「hidden → active」的恢复。 */
export function notifyInput(): void {
  if (!enabled || !sessionUid) return;
  const now = Date.now();
  if (now - lastInputRecordedAt < INPUT_THROTTLE_MS) return;
  lastInputRecordedAt = now;
  lastInputAt = now;
  applyEffect({ visibility: true });
}

/** `document.visibilitychange`。 */
export function setVisibility(visible: boolean): void {
  if (!enabled || !sessionUid) return;
  applyEffect({ visibility: visible });
}

/** `window.pagehide`。 */
export function onPageHide(): void {
  if (!enabled || !sessionUid) return;
  applyEffect({ pageHide: true });
}

// ---------------------------------------------------------------- 内部

/**
 * 真正建会话（生成 uid、采设备信息、发首次 `start`）。
 * **只由 `runTransition` 在 `effects.start` 为真时调用**——这是全模块唯一的开会话点。
 */
function beginSession(): void {
  const info = currentInfo;
  if (!info?.module || !info.scene) return;

  sessionUid = newSessionUid();
  lastInputAt = Date.now();
  lastInputRecordedAt = lastInputAt;

  const subjectId = subjectIdProvider();
  const device = collectDeviceInfo();
  void transport
    .start({
      sessionUid,
      module: info.module,
      scene: info.scene,
      ...(subjectId !== null ? { subjectId } : {}),
      ...device,
    })
    .catch(() => {
      /* 埋点失败静默：绝不打断学习 */
    });

  armTimers();
}

/** 收尾当前会话（若有）。所有「结束」都走这里，避免多处各写一遍。 */
function endSession(reason: EndReason): void {
  const uid = sessionUid;
  resetLocalState();
  if (!uid) return;
  void transport.end(uid, reason).catch(() => {
    /* 静默 */
  });
}

function sendHeartbeat(next: ClientState): void {
  const uid = sessionUid;
  if (!uid) return;
  void transport.heartbeat(uid, next).catch(() => {
    /* 同上 */
  });
}

/**
 * 把「输入 / 可见性 / pagehide」映射成状态机事件并执行副作用。
 * 心跳**由状态机产出**，不再由调用点各自决定发什么——这是「唯一真源」的落点。
 */
function applyEffect(input: { visibility?: boolean; pageHide?: boolean }): void {
  let event: 'VISIBLE' | 'HIDDEN' | 'PAGEHIDE' | null = null;
  if (input.pageHide) event = 'PAGEHIDE';
  else if (input.visibility !== undefined) event = input.visibility ? 'VISIBLE' : 'HIDDEN';

  if (!event) return;
  // 已在前台时的「恢复可见」是空操作，只刷新活跃时间；不发多余心跳。
  if (event === 'VISIBLE' && state === 'active') {
    lastInputAt = Date.now();
    return;
  }
  runTransition(event);
}

/**
 * 执行一次状态机迁移——**全部副作用的唯一出口**：`start` / `end` / `heartbeat`
 * 都由这里按 `effects` 执行。调用点（路由变化、可见性、pagehide、空闲）只负责把事件喂进来，
 * 自己不做任何网络或状态操作。这样「谁负责开会话/结束会话」永远只有一个答案。
 */
function runTransition(event: SessionEvent): void {
  const next = transition(state, event);
  state = next.state;

  if (next.effects.start) beginSession();
  if (next.effects.end) return endSession(next.effects.end);
  if (next.effects.heartbeat) sendHeartbeat(next.effects.heartbeat);
}

function armTimers(): void {
  disarmTimers();
  heartbeatTimer = setInterval(() => {
    if (state === 'active' || state === 'hidden') sendHeartbeat(state === 'active' ? 'visible' : 'hidden');
  }, HEARTBEAT_INTERVAL_MS);

  idleTimer = setInterval(() => {
    if (state === 'active' && Date.now() - lastInputAt >= IDLE_TIMEOUT_MS) runTransition('IDLE_TIMEOUT');
  }, IDLE_CHECK_INTERVAL_MS);
}

function disarmTimers(): void {
  if (heartbeatTimer !== null) clearInterval(heartbeatTimer);
  if (idleTimer !== null) clearInterval(idleTimer);
  heartbeatTimer = null;
  idleTimer = null;
}

function resetLocalState(): void {
  disarmTimers();
  state = 'idle';
  currentKey = null;
  currentInfo = null;
  sessionUid = null;
  lastInputAt = 0;
  lastInputRecordedAt = 0;
}

// ---------------------------------------------------------------- 设备分档

/**
 * 屏幕档：对齐 `UX-UI设计文档` 的 iPad 横屏主断点（≥1024px）。
 * 只在会话开始时取一次——会话中途转屏不改（一段连续学习用哪块屏不重要）。
 */
export function collectScreenClass(width: number, height: number): ScreenClass {
  if (width >= 1280) return 'desktop';
  if (width >= 1024 && width > height) return 'ipad_landscape';
  if (width >= 768) return 'tablet_portrait';
  return 'mobile';
}

/** 指针类型：粗+细同时存在（触屏笔记本）→ hybrid。 */
export function collectInputType(matches: (query: string) => boolean): InputType {
  const coarse = matches('(pointer: coarse)');
  const fine = matches('(pointer: fine)');
  if (coarse && fine) return 'hybrid';
  if (coarse) return 'touch';
  return 'mouse';
}

/** Electron 壳：UA 里有 `Electron` 标记（双保险，主判定仍看 UA）。 */
export function collectAppShell(ua: string): AppShell {
  return /Electron/i.test(ua) ? 'electron' : 'web';
}

export function collectDeviceInfo(): {
  screenClass: ScreenClass;
  inputType: InputType;
  appShell: AppShell;
} {
  const matches = (query: string) =>
    typeof window !== 'undefined' && typeof window.matchMedia === 'function'
      ? window.matchMedia(query).matches
      : false;
  return {
    screenClass: collectScreenClass(window.innerWidth, window.innerHeight),
    inputType: collectInputType(matches),
    appShell: collectAppShell(navigator.userAgent),
  };
}
```

> **设计要点**：**所有副作用都从 `runTransition` 出**——`effects.start` / `effects.end` / `effects.heartbeat` 三个都由它执行，`onRouteChange`、`applyEffect`、空闲定时器只负责把事件喂进状态机，自己不做网络调用、也不改 `state`。
>
> 这样「谁负责开会话」只有一个答案：`runTransition` → `beginSession()`。开会话需要完整的 `SceneInfo`（module/scene），所以 tracker 用一个 `currentInfo` 模块变量持有当前场景；`onRouteChange` 在调 `ROUTE_ENTER` **之前**把它设好（顺序不能反）。
>
> 反面教材（本计划初稿的写法，已废弃）：让 `onRouteChange` 直接调 `startCurrent()`、把 `state = 'active'` 写死、并让 `runTransition` 声明「不处理 effects.start」。那会让 `effects.start` 成为**永远不会被读的死代码**，且 `state` 有第二个写入点（绕过状态机）——两个都会在后续维护里变成 bug 源。
>
> `ROUTE_ENTER` 带 `heartbeat: 'visible'`（开完会话立刻补一次心跳）不是为了凑数：`start` 那条 INSERT 用的是库默认 `client_state='visible'`，若标签页是**在后台被打开/恢复**的，这一次心跳至少会把后端的 `client_state` 拉正、`heartbeat_count` 从 0 起算。
> ⚠️ **已知边界（本批不修，记入终审）**：`AnalyticsShell` 只在收到 `visibilitychange` **事件**时上报可见性，**不读挂载时的初始 `document.visibilityState`**。所以「页面在后台标签里被打开」的场景下，开头最多 ≤120s（直到空闲定时器把它判成 hidden）会被算进时长。要修的话是在 shell 挂载时把初始可见性同步给 tracker；影响有限（仅后台加载场景、且上界 120s），故未纳入本批。

- [ ] **Step 4: 跑测试确认通过**

```bash
cd apps/web && npx vitest run src/analytics/tracker.test.ts
```

Expected: PASS（**16 条**——10 条生命周期 + 3 条设备分档 + 1 条「hidden 状态下切场景仍必须先 end 再 start」的顺序钉子 + 2 条不变）。若 `screenClass` 断言失败，检查 jsdom 的 `window.innerWidth`（默认 1024×768 → `ipad_landscape`）。

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/analytics/tracker.ts apps/web/src/analytics/tracker.test.ts
git commit -m "feat(web): analytics tracker（会话编排 + 心跳定时器 + 设备分档）"
```

---

### Task 13: `AnalyticsShell` + 路由包壳

**Files:**
- Create: `apps/web/src/analytics/AnalyticsShell.tsx`
- Modify: `apps/web/src/routes/index.tsx`
- Test: `apps/web/src/analytics/AnalyticsShell.test.tsx`

**Interfaces:**
- Consumes: `mapScene`（Task 10）、`tracker`（Task 12）、`useLearnContextStore`（Task 9）
- Produces: `<AnalyticsShell />`（pathless 壳，渲染 `<Outlet />`）

- [ ] **Step 1: 写失败测试**

Create `apps/web/src/analytics/AnalyticsShell.test.tsx`：

```tsx
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, waitFor } from '@testing-library/react';
import { createMemoryRouter, RouterProvider } from 'react-router-dom';
import AnalyticsShell from './AnalyticsShell';
import * as tracker from './tracker';
import { useLearnContextStore } from '@/store/learnContextStore';

function makeTransport() {
  return {
    start: vi.fn().mockResolvedValue(undefined),
    heartbeat: vi.fn().mockResolvedValue(undefined),
    end: vi.fn().mockResolvedValue(undefined),
  };
}

function renderAt(path: string) {
  const router = createMemoryRouter(
    [
      {
        element: <AnalyticsShell />,
        children: [{ path: '/student/training/targeted/run', element: <div>run</div> }],
      },
    ],
    { initialEntries: [path] },
  );
  return render(<RouterProvider router={router} />);
}

let transport: ReturnType<typeof makeTransport>;

beforeEach(() => {
  vi.stubGlobal('matchMedia', () => ({ matches: false }));
  transport = makeTransport();
  tracker.__resetForTests();
  tracker.setTransport(transport);
});

afterEach(() => {
  cleanup();
  tracker.__resetForTests();
  vi.unstubAllGlobals();
  localStorage.clear();
  useLearnContextStore.setState({ subjectId: null, subjectName: null, gradeName: null, publisher: null });
});

describe('AnalyticsShell', () => {
  it('学生角色进入学习页 → 起会话，并把 subjectId 带进 start', async () => {
    localStorage.setItem('userRole', 'student');
    useLearnContextStore.setState({ subjectId: 7, subjectName: '数学', gradeName: null, publisher: null });
    renderAt('/student/training/targeted/run');

    await waitFor(() => expect(transport.start).toHaveBeenCalledTimes(1));
    expect(transport.start.mock.calls[0][0].subjectId).toBe(7);
  });

  it('非学生角色（家长）→ 不启动会话', async () => {
    localStorage.setItem('userRole', 'parent');
    renderAt('/student/training/targeted/run');
    await new Promise((r) => setTimeout(r, 0));
    expect(transport.start).not.toHaveBeenCalled();
  });

  it('pagehide → end(pagehide)', async () => {
    localStorage.setItem('userRole', 'student');
    renderAt('/student/training/targeted/run');
    await waitFor(() => expect(transport.start).toHaveBeenCalled());

    window.dispatchEvent(new Event('pagehide'));
    await waitFor(() => expect(transport.end).toHaveBeenCalledWith(expect.any(String), 'pagehide'));
  });

  it('document 隐藏 → hidden 心跳', async () => {
    localStorage.setItem('userRole', 'student');
    Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true });
    renderAt('/student/training/targeted/run');
    await waitFor(() => expect(transport.start).toHaveBeenCalled());

    document.dispatchEvent(new Event('visibilitychange'));
    await waitFor(() =>
      expect(transport.heartbeat).toHaveBeenCalledWith(expect.any(String), 'hidden'),
    );
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

```bash
cd apps/web && npx vitest run src/analytics/AnalyticsShell.test.tsx
```

Expected: FAIL —— 模块不存在。

- [ ] **Step 3: 实现**

Create `apps/web/src/analytics/AnalyticsShell.tsx`：

```tsx
import { useEffect } from 'react';
import { Outlet, useLocation } from 'react-router-dom';
import { useLearnContextStore } from '@/store/learnContextStore';
import { mapScene } from './sceneMap';
import * as tracker from './tracker';

/**
 * 埋点全局壳（spec §7.2）。
 *
 * **不是** `App.tsx`：那个组件在 `RouterProvider` **之外**，拿不到 `useLocation`。
 * 正确落点是在 `createBrowserRouter` 的根上包一层 **pathless wrapper route**——
 * 这样它同时覆盖布局页（`StudentLayout` 下的）与全屏沉浸页（训练/考试/课程详情都不在
 * `StudentLayout` 下），也覆盖 `RequireRole` 之下的一切。
 *
 * `routeTable.tsx` **不改**：它的测试用 `createMemoryRouter(routes)` 直接挂真实表，
 * 往里加组件会破坏「纯配置」的约束。
 *
 * 副作用分两段 effect，顺序不能颠倒：
 * 1. 先配好 enabled / transport / subjectId 提供者；
 * 2. 再按路由变化驱动会话（若反了，首个路由变化会因为 `enabled=false` 被丢掉）。
 */
export default function AnalyticsShell() {
  const location = useLocation();

  useEffect(() => {
    tracker.setSubjectIdProvider(() => useLearnContextStore.getState().subjectId);
    tracker.setEnabled(localStorage.getItem('userRole') === 'student');
    return () => tracker.setEnabled(false);
  }, []);

  useEffect(() => {
    tracker.onRouteChange(mapScene(location.pathname));
  }, [location.pathname]);

  useEffect(() => {
    const onVisibility = () => tracker.setVisibility(document.visibilityState === 'visible');
    const onPageHide = () => tracker.onPageHide();
    const onInput = () => tracker.notifyInput();

    document.addEventListener('visibilitychange', onVisibility);
    window.addEventListener('pagehide', onPageHide);
    window.addEventListener('pointerdown', onInput, { passive: true });
    window.addEventListener('keydown', onInput);
    window.addEventListener('scroll', onInput, { passive: true });
    window.addEventListener('touchstart', onInput, { passive: true });

    return () => {
      document.removeEventListener('visibilitychange', onVisibility);
      window.removeEventListener('pagehide', onPageHide);
      window.removeEventListener('pointerdown', onInput);
      window.removeEventListener('keydown', onInput);
      window.removeEventListener('scroll', onInput);
      window.removeEventListener('touchstart', onInput);
    };
  }, []);

  return <Outlet />;
}
```

- [ ] **Step 4: 路由包壳**

`apps/web/src/routes/index.tsx` 全文改为：

```tsx
import { createBrowserRouter, RouterProvider } from 'react-router-dom';
import { routes } from './routeTable';
import AnalyticsShell from '../analytics/AnalyticsShell';

/**
 * 路由引导：真正的路由表在 `./routeTable`（单独成文件是为了让路由级测试能用
 * `createMemoryRouter(routes)` 直接挂载真实表；本文件只保留浏览器 router 单例）。
 *
 * `AnalyticsShell` 是 **pathless wrapper**（无 `path`、渲染 `<Outlet/>`）：
 * 包在真实路由表外面，就能拿到 `useLocation` 而**不修改** `routeTable.tsx`。
 * 它必须在这里、而不是 `App.tsx`——后者在 `RouterProvider` 之外。
 */
const router = createBrowserRouter([{ element: <AnalyticsShell />, children: routes }]);

export function AppRouter() {
  return <RouterProvider router={router} />;
}
```

- [ ] **Step 5: 跑测试 + 全量前端测试**

```bash
cd apps/web && npx vitest run src/analytics/AnalyticsShell.test.tsx && npm test
```

Expected: 新用例 PASS；全量仍绿（`routeTable.test.tsx` 直接挂 `routes`，不含 shell，不受影响）。

- [ ] **Step 6: Commit**

```bash
git add apps/web/src/analytics/AnalyticsShell.tsx apps/web/src/analytics/AnalyticsShell.test.tsx apps/web/src/routes/index.tsx
git commit -m "feat(web): AnalyticsShell + 路由包壳（会话采集接进真实路由）"
```

---

### Task 14: `api.ts` 会话方法与家长端点类型

**Files:**
- Modify: `apps/web/src/services/api.ts`

**Interfaces:**
- Produces:
  - `startStudySession(body): Promise<{ sessionUid: string; startedAt: string }>`
  - `heartbeatStudySession(uid, state): Promise<{ activeSeconds: number | null }>`
  - `endStudySession(uid, reason): Promise<{ activeSeconds: number | null; endedAt: string | null }>`
  - `ParentStudyTime` / `getParentStudyTime(studentId, from?, to?)`
  - `ParentTodayUsage` / `getParentTodayUsage(studentId)`

- [ ] **Step 1: 追加类型与方法**

在 `apps/web/src/services/api.ts` 的「// --- Parent: 学情可见性…」段之后（`getParentReport` 之后、`ParentErrorQuestion` 之前）插入：

```ts
// --- Parent: 学习时长（会话口径，埋点 Phase 1A） ---
// ⚠️ 与 `ParentDashboardStudent.activeDays7`（四路时间戳代理）是**两套口径**，
// 必须并列展示、文案区分，不得相互替换（spec §10 第 1 条）。

export interface ParentStudyTime {
  totalSeconds: number;
  /** 会话口径的「有学习的天数」，与 `activeDays7` 刻意不同。 */
  activeDays: number;
  byDay: Array<{ date: string; seconds: number }>;
  byModule: Array<{ module: string; seconds: number }>;
  bySubject: Array<{ subjectId: number; seconds: number }>;
  /** 口径标记：永远是 'sessions'，用于 UI 上明确这是会话时长。 */
  source: 'sessions';
}

export interface ParentTodayUsage {
  date: string;
  activeSeconds: number;
  /** `null` = 家长未设限（不是「上限 0 分钟」）。 */
  limitMinutes: number | null;
  /** `>=` 判定：用满上限即算超出。 */
  exceeded: boolean;
  byModule: Array<{ module: string; seconds: number }>;
}

export function getParentStudyTime(
  studentId: number,
  from?: string,
  to?: string,
): Promise<ParentStudyTime> {
  const qs = new URLSearchParams();
  if (from) qs.set('from', from);
  if (to) qs.set('to', to);
  const suffix = qs.toString() ? `?${qs.toString()}` : '';
  return fetchApi<ParentStudyTime>(`/parent/students/${studentId}/study-time${suffix}`);
}

export function getParentTodayUsage(studentId: number): Promise<ParentTodayUsage> {
  return fetchApi<ParentTodayUsage>(`/parent/students/${studentId}/today-usage`);
}
```

在文件末尾（家长段之后）追加会话采集方法：

```ts
// --- 学习会话采集（student 角色，埋点 Phase 1A） ---
//
// ⚠️ 枚举**不在这里声明**：`ClientState` / `EndReason` 的**唯一真源**是
// `apps/web/src/analytics/types.ts`（该文件本就是「后端封闭字典的前端镜像」）。
// 早先版本在本文件重复声明了 `StudySessionClientState` / `StudySessionEndReason`，
// 造成同一份后端枚举有两个前端声明——后端改一个、漏改另一个时**类型检查抓不到**，
// 运行期静默 1001、会话全丢。已合并。改本文件时不要再把它们加回来。
import type { ClientState, EndReason } from '@/analytics/types';

export interface StartStudySessionBody {
  sessionUid: string;
  module: string;
  scene: string;
  subjectId?: number;
  refType?: string;
  refId?: number;
  screenClass?: string;
  inputType?: string;
  appShell?: string;
}

/** `@Post` 默认 201；`fetchApi` 只判 `code === 0`，无需特殊处理。 */
export function startStudySession(
  body: StartStudySessionBody,
): Promise<{ sessionUid: string; startedAt: string }> {
  return fetchApi<{ sessionUid: string; startedAt: string }>('/study-sessions', {
    method: 'POST',
    body: JSON.stringify(body),
  });
}

export function heartbeatStudySession(
  uid: string,
  state: ClientState,
): Promise<{ activeSeconds: number | null }> {
  return fetchApi<{ activeSeconds: number | null }>(
    `/study-sessions/${encodeURIComponent(uid)}/heartbeat`,
    { method: 'PATCH', body: JSON.stringify({ state }) },
  );
}

export function endStudySession(
  uid: string,
  reason: EndReason,
): Promise<{ activeSeconds: number | null; endedAt: string | null }> {
  return fetchApi<{ activeSeconds: number | null; endedAt: string | null }>(
    `/study-sessions/${encodeURIComponent(uid)}/end`,
    { method: 'PATCH', body: JSON.stringify({ reason }) },
  );
}
```

- [ ] **Step 2: 构建校验**

```bash
cd apps/web && npm run build
```

Expected: `tsc -b` + `vite build` 通过。**这一步同时验证 Task 12 的 import**（`startStudySession` 等已存在）。

- [ ] **Step 3: Commit**

```bash
git add apps/web/src/services/api.ts
git commit -m "feat(web): api 层补会话采集方法与家长学习时长类型"
```

---

### Task 15: 时长格式化 + 家长仪表盘两张新卡

**Files:**
- Create: `apps/web/src/utils/duration.ts`
- Test: `apps/web/src/utils/duration.test.ts`
- Modify: `apps/web/src/pages/parent/ParentDashboardPage.tsx`
- Test: `apps/web/src/pages/parent/ParentDashboardPage.test.tsx`（补用例 + 补 mock）

**Interfaces:**
- Consumes: `getParentStudyTime` / `getParentTodayUsage`（Task 14）
- Produces: `formatDuration(seconds: number): string`（如 `2 小时 5 分` / `48 分钟` / `0 分钟`）

- [ ] **Step 1: 写 `formatDuration` 测试**

Create `apps/web/src/utils/duration.test.ts`：

```ts
import { describe, it, expect } from 'vitest';
import { formatDuration } from './duration';

describe('formatDuration', () => {
  it('不足 1 分钟 → 「不足 1 分钟」（不显示 0 分钟，那读起来像没学）', () => {
    expect(formatDuration(0)).toBe('不足 1 分钟');
    expect(formatDuration(59)).toBe('不足 1 分钟');
  });

  it('整分钟', () => {
    expect(formatDuration(60)).toBe('1 分钟');
    expect(formatDuration(48 * 60)).toBe('48 分钟');
  });

  it('小时 + 分钟', () => {
    expect(formatDuration(3661)).toBe('1 小时 1 分');
    expect(formatDuration(2 * 3600 + 5 * 60)).toBe('2 小时 5 分');
  });

  it('整小时不带「0 分」', () => {
    expect(formatDuration(2 * 3600)).toBe('2 小时');
  });

  it('负数 / NaN 兜底为「不足 1 分钟」（不抛错，页面不该被脏数据打崩）', () => {
    expect(formatDuration(-5)).toBe('不足 1 分钟');
    expect(formatDuration(Number.NaN)).toBe('不足 1 分钟');
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

```bash
cd apps/web && npx vitest run src/utils/duration.test.ts
```

Expected: FAIL —— 模块不存在。

- [ ] **Step 3: 实现**

Create `apps/web/src/utils/duration.ts`：

```ts
/**
 * 秒 → 中文时长文案。家长端多处共用（仪表盘卡片 / 报告页数字卡 / 每日柱状图 tooltip）。
 *
 * 不足 1 分钟显示「不足 1 分钟」而不是「0 分钟」：后者读起来像「今天没学」，
 * 与「学了 40 秒」是两回事——和 `rate: null → 暂无数据` 是同一条纪律。
 */
export function formatDuration(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 60) return '不足 1 分钟';

  const totalMinutes = Math.round(seconds / 60);
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;

  if (hours === 0) return `${minutes} 分钟`;
  if (minutes === 0) return `${hours} 小时`;
  return `${hours} 小时 ${minutes} 分`;
}
```

- [ ] **Step 4: 跑测试确认通过**

```bash
cd apps/web && npx vitest run src/utils/duration.test.ts
```

Expected: PASS

- [ ] **Step 5: 给仪表盘加两张卡**

`apps/web/src/pages/parent/ParentDashboardPage.tsx`：

**5a. import 区**加：

```tsx
import {
  ApiError,
  getParentDashboard,
  getParentStudyTime,
  getParentTodayUsage,
  type ParentDashboard,
  type ParentDashboardStudent,
  type ParentStudyTime,
  type ParentTodayUsage,
} from '@/services/api';
import { formatDuration } from '@/utils/duration';
```

**5b. 在 `SubjectCard` 之后、`StudentPanel` 之前**新增学习时长区块组件：

```tsx
/**
 * 学习时长区块（会话口径）。
 *
 * ⚠️ 它与同页的「近 7 天活跃 N 天」是**两套口径**（spec §10）：
 * 旧活跃 = 四路时间戳代理（答题/积分/考试/对话），新时长 = 显式会话。
 * 孩子挂机不答题时旧口径不活跃、新口径有时长；两者数字不同是**正常的**。
 * 因此这里**并列展示 + 文案区分**，绝不替换或合并。
 */
function StudyTimePanel({
  studentId,
  study,
  usage,
}: {
  studentId: number;
  study: ParentStudyTime | null;
  usage: ParentTodayUsage | null;
}) {
  return (
    <div className="mb-4 grid gap-4 md:grid-cols-2">
      <Card className="p-5" data-testid={`dashboard-study-time-${studentId}`}>
        <h3 className="text-base font-bold text-[var(--text-primary)]">学习时长（近 7 天）</h3>
        <p className="mt-2 text-2xl font-black text-[var(--text-primary)]">
          {study ? formatDuration(study.totalSeconds) : '暂无数据'}
        </p>
        <p className="mt-1 text-xs text-[var(--text-tertiary)]">
          会话口径：只统计进入学习页且有操作的时间，与「近 7 天活跃天数」不是同一口径。
        </p>
      </Card>

      <Card className="p-5" data-testid={`dashboard-today-usage-${studentId}`}>
        <h3 className="text-base font-bold text-[var(--text-primary)]">今日已用</h3>
        <p className="mt-2 text-2xl font-black text-[var(--text-primary)]">
          {usage ? formatDuration(usage.activeSeconds) : '暂无数据'}
        </p>
        <p className="mt-1 text-xs text-[var(--text-tertiary)]">
          {usage
            ? usage.limitMinutes === null
              ? '家长未设置每日上限'
              : `每日上限 ${usage.limitMinutes} 分钟${usage.exceeded ? ' · 已达上限' : ''}`
            : ' '}
        </p>
      </Card>
    </div>
  );
}
```

**5c. `StudentPanel` 里加取数与派生**（放在 `const goto = ...` 之前）：

```tsx
  const [study, setStudy] = useState<{ studentId: number; value: ParentStudyTime } | null>(null);
  const [usage, setUsage] = useState<{ studentId: number; value: ParentTodayUsage } | null>(null);

  /**
   * 派生数据带 `studentId` 归属：切 Tab 不重挂载本组件，只在 `useEffect` 里清空
   * 会让上一帧画出**上一个孩子**的时长（effect 在 commit 之后才跑）。
   * 按当前 `studentId` 比对后派生即可，不需要也不应该 setState(null)。
   */
  const studyValue = study && study.studentId === student.studentId ? study.value : null;
  const usageValue = usage && usage.studentId === student.studentId ? usage.value : null;

  useEffect(() => {
    let cancelled = false;
    const id = student.studentId;
    void Promise.all([getParentStudyTime(id), getParentTodayUsage(id)])
      .then(([studyRes, usageRes]) => {
        if (cancelled) return;
        setStudy({ studentId: id, value: studyRes });
        setUsage({ studentId: id, value: usageRes });
      })
      .catch(() => {
        // 时长是**增值信息**：取不到不影响既有概览显示，静默降级为「暂无数据」
      });
    return () => {
      cancelled = true;
    };
  }, [student.studentId]);
```

并且在 `StudentPanel` 的 `return` 里，把 `<SubjectCard>` 那个网格**之前**插入：

```tsx
      <StudyTimePanel studentId={student.studentId} study={studyValue} usage={usageValue} />
```

同时确认 `useEffect` 已从 react 导入（该文件已有 `import { useEffect, useState } from 'react';`）。

**5d. 顶栏那行「近 7 天活跃」保持不变**——它是旧口径，必须并存（spec §10）。

- [ ] **Step 6: 补页面测试**

`apps/web/src/pages/parent/ParentDashboardPage.test.tsx`：
1. import 区把两个新方法加进来，并像既有的 `getDashboardMock` 一样取出 mock 句柄：

```tsx
import {
  getParentDashboard,
  getParentStudyTime,
  getParentTodayUsage,
  getUnreadMessageCount,
  listMyStudents,
  type MyStudentItem,
  type ParentDashboard,
} from '@/services/api';

const getStudyTimeMock = vi.mocked(getParentStudyTime);
const getTodayUsageMock = vi.mocked(getParentTodayUsage);
```

2. `vi.mock('@/services/api', ...)` 的返回对象里补 `getParentStudyTime: vi.fn(), getParentTodayUsage: vi.fn()`；

3. `beforeEach` 里给两个 mock 设默认值：

```tsx
  getStudyTimeMock.mockReset();
  getStudyTimeMock.mockResolvedValue({
    totalSeconds: 5400,
    activeDays: 2,
    byDay: [{ date: '2026-09-19', seconds: 5400 }],
    byModule: [{ module: 'en_vocabulary', seconds: 5400 }],
    bySubject: [],
    source: 'sessions',
  });
  getTodayUsageMock.mockReset();
  getTodayUsageMock.mockResolvedValue({
    date: '2026-09-19',
    activeSeconds: 1800,
    limitMinutes: 30,
    exceeded: true,
    byModule: [{ module: 'en_vocabulary', seconds: 1800 }],
  });
```

4. 补三条用例：

```tsx
  it('学习时长与活跃天数**并列**展示，文案区分口径（不许替换）', async () => {
    renderAt('/parent/dashboard');
    await waitFor(() => expect(screen.getByTestId('dashboard-study-time-11')).toBeTruthy());

    // 新卡：会话口径
    expect(screen.getByTestId('dashboard-study-time-11').textContent).toContain('1 小时 30 分');
    expect(screen.getByTestId('dashboard-study-time-11').textContent).toContain('会话口径');
    // 旧口径仍在，未被替换
    expect(screen.getByText(/近 7 天活跃/)).toBeTruthy();
  });

  it('今日已用：达到上限时提示', async () => {
    renderAt('/parent/dashboard');
    await waitFor(() => expect(screen.getByTestId('dashboard-today-usage-11')).toBeTruthy());

    const text = screen.getByTestId('dashboard-today-usage-11').textContent ?? '';
    expect(text).toContain('30 分钟'); // 每日上限 30 分钟
    expect(text).toContain('已达上限');
  });

  it('时长取数失败时静默降级为「暂无数据」，不影响概览', async () => {
    getStudyTimeMock.mockRejectedValue(new Error('boom'));
    getTodayUsageMock.mockRejectedValue(new Error('boom'));
    renderAt('/parent/dashboard');
    await waitFor(() => expect(screen.getByTestId('dashboard-study-time-11')).toBeTruthy());
    expect(screen.getByTestId('dashboard-study-time-11').textContent).toContain('暂无数据');
    // 概览主体仍在
    expect(screen.getByTestId('dashboard-student-11')).toBeTruthy();
  });
```

- [ ] **Step 7: 跑测试**

```bash
cd apps/web && npx vitest run src/utils/duration.test.ts src/pages/parent/ParentDashboardPage.test.tsx
```

Expected: PASS

- [ ] **Step 8: Commit**

```bash
git add apps/web/src/utils/duration.ts apps/web/src/utils/duration.test.ts apps/web/src/pages/parent/ParentDashboardPage.tsx apps/web/src/pages/parent/ParentDashboardPage.test.tsx
git commit -m "feat(parent): 仪表盘学习时长/今日已用卡片（与活跃天数并列，不替换）"
```

---

### Task 16: 报告页学习时长卡 + 每日趋势图

**Files:**
- Modify: `apps/web/src/pages/parent/ParentReportPage.tsx`
- Test: `apps/web/src/pages/parent/ParentReportPage.test.tsx`（补用例 + 补 mock）

**Interfaces:**
- Consumes: `getParentStudyTime`（Task 14）、`formatDuration`（Task 15）
- 报告窗口 `data.windowStart` / `data.windowEnd` 是**含两端**的 `YYYY-MM-DD`，与 `study-time` 的 `from`/`to` 语义一致，可直接透传。

- [ ] **Step 1: 加取数与派生**

`apps/web/src/pages/parent/ParentReportPage.tsx`：

**1a.** import 区加：

```tsx
import { getParentReport, getParentStudyTime, type ParentLearningReport, type ParentReportPeriod, type ParentStudyTime } from '@/services/api';
import { formatDuration } from '@/utils/duration';
```

**1b.** 组件内、既有 `useEffect` 之后加第二个 effect（**依赖报告窗口**，而不是 period——窗口由服务端算，前端不重复实现）：

```tsx
  const [study, setStudy] = useState<{ studentId: number; period: ParentReportPeriod; value: ParentStudyTime } | null>(null);
  const studyValue =
    study && study.studentId === studentId && study.period === period ? study.value : null;

  useEffect(() => {
    // 窗口要等报告回来才知道（服务端算的，前端不重复实现窗口逻辑）
    if (studentId === null || !data) return;
    let cancelled = false;
    void getParentStudyTime(studentId, data.windowStart, data.windowEnd)
      .then((res) => {
        if (cancelled) return;
        setStudy({ studentId, period, value: res });
      })
      .catch(() => {
        // 增值信息：取不到就整块不渲染（下方 studyValue === null 分支），不打断报告
      });
    return () => {
      cancelled = true;
    };
  }, [studentId, period, data]);
```

**1c.** 在 `report-stats` 那个 `<Card>` 的数字卡里，**保留**「活跃天数」，并新增一张：

```tsx
              <StatCard label="活跃天数" value={String(data.stats.activeDays)} />
              <StatCard
                label="学习时长（会话）"
                value={studyValue ? formatDuration(studyValue.totalSeconds) : '暂无数据'}
              />
```

（「活跃天数」是四路时间戳代理，「学习时长（会话）」是显式会话——两者**并列**且标签区分，见 spec §10。）

**1d.** 在「正确率趋势」卡之后插入一张新卡：

```tsx
          <Card className="p-5" data-testid="report-study-time">
            <h2 className="mb-3 text-base font-bold text-[var(--text-primary)]">
              每日学习时长
              <span className="ml-2 text-xs font-normal text-[var(--text-tertiary)]">
                （会话口径，只统计进入学习页且有操作的时间）
              </span>
            </h2>
            {studyValue === null ? (
              <p className="text-sm text-[var(--text-secondary)]">暂无学习时长数据</p>
            ) : (
              <>
                <p className="mb-3 text-sm text-[var(--text-secondary)]">
                  {`本期合计 ${formatDuration(studyValue.totalSeconds)}，会话口径下有学习的天数 ${studyValue.activeDays} 天`}
                </p>
                <ChartBar
                  points={studyValue.byDay.map((d) => ({
                    label: shortDay(d.date),
                    value: Math.round(d.seconds / 60),
                  }))}
                  emptyText="本期还没有学习会话"
                />
              </>
            )}
          </Card>
```

> 柱状图的值用**分钟**（不是秒）：秒的数量级在刻度上读不出意义。

- [ ] **Step 2: 补页面测试**

`apps/web/src/pages/parent/ParentReportPage.test.tsx`：
1. `vi.mock('@/services/api', ...)` 里补 `getParentStudyTime: vi.fn()`；
2. `beforeEach` 设默认值：

```tsx
  getStudyTimeMock.mockReset();
  getStudyTimeMock.mockResolvedValue({
    totalSeconds: 5400,
    activeDays: 2,
    byDay: [
      { date: '2026-09-15', seconds: 3600 },
      { date: '2026-09-16', seconds: 1800 },
    ],
    byModule: [{ module: 'mainline', seconds: 5400 }],
    bySubject: [{ subjectId: 1, seconds: 5400 }],
    source: 'sessions',
  });
```

3. 补用例（页面里有两个 `ChartBar`——「各学科答题量」与「每日学习时长」，所以新用例**必须**用 `within` 限定到学习时长卡内，不能用全局 `getByTestId('chart-bar')`；同时把 `within` 加进 testing-library 的 import）：

```tsx
  it('学习时长与活跃天数并列；每日柱状图按窗口日期喂给 ChartBar', async () => {
    renderAt('/parent/report');
    await waitFor(() => expect(screen.getByTestId('report-study-time')).toBeTruthy());

    // 旧口径仍在一张独立卡里
    expect(screen.getByText('活跃天数')).toBeTruthy();
    // 新口径：数字卡 + 每日柱状
    expect(screen.getByText('学习时长（会话）')).toBeTruthy();
    expect(screen.getByText('1 小时 30 分')).toBeTruthy();

    // 报告页有两个 ChartBar，必须限定到学习时长卡内取
    const bars = within(screen.getByTestId('report-study-time')).getByTestId('chart-bar');
    expect(bars.getAttribute('data-count')).toBe('2');
    expect(bars.textContent).toContain('09-15:60'); // 3600s → 60 分钟
  });

  it('时长取数失败 → 该卡显示「暂无学习时长数据」，报告主体不受影响', async () => {
    getStudyTimeMock.mockRejectedValue(new Error('boom'));
    renderAt('/parent/report');
    await waitFor(() => expect(screen.getByTestId('report-study-time')).toBeTruthy());
    expect(screen.getByTestId('report-study-time').textContent).toContain('暂无学习时长数据');
    expect(screen.getByTestId('report-stats')).toBeTruthy();
  });
```

- [ ] **Step 3: 跑测试**

```bash
cd apps/web && npx vitest run src/pages/parent/ParentReportPage.test.tsx
```

Expected: PASS

- [ ] **Step 4: 提交**

```bash
git add apps/web/src/pages/parent/ParentReportPage.tsx apps/web/src/pages/parent/ParentReportPage.test.tsx
git commit -m "feat(parent): 报告页学习时长数字卡 + 每日学习时长柱状图"
```

---

### Task 17: 文档同步（硬清单）

**Files:**
- Modify: `docs/API接口与数据流设计文档.md`
- Modify: `docs/api/openapi.yaml`
- Modify: `docs/K12智学系统-数据库设计文档.md`
- Modify: `docs/ai-core-changelog.md`
- Modify: `CLAUDE.md`

**Interfaces:**
- Consumes: 全部实现（Task 1–16）
- **规则**：`docs/API接口与数据流设计文档.md` 与 `docs/api/openapi.yaml` 是**互为对照、必须同步**的两份（CLAUDE.md 的同步铁律）。以 API 设计文档为主稿。

- [ ] **Step 1: API 设计文档补端点**

在 `docs/API接口与数据流设计文档.md`：
1. **§4.13 Parent 下**新增两行（与既有 5 个家长端点同表）：

| method | path | 说明 |
|---|---|---|
| GET | `/api/parent/students/:id/study-time` | query `from`/`to`（`YYYY-MM-DD`，缺省近 7 天）。返回 `{totalSeconds, activeDays, byDay[], byModule[], bySubject[], source:'sessions'}`。**口径标注**：会话口径，与 `dashboard.activeDays7` 的四路时间戳代理**并存不替换**（见 §6.25）。 |
| GET | `/api/parent/students/:id/today-usage` | 返回 `{date, activeSeconds, limitMinutes\|null, exceeded, byModule[]}`。`limitMinutes` 取自 `controls.daily_time_limit_minutes`，为 NULL 时 `exceeded=false`；`exceeded` 用 `>=`。 |

2. **新增 §4.23「学习会话采集（StudySessions）」**，逐字列出三个端点与校验规则（`sessionUid` 必填 UUID；`module`/`scene` 白名单；设备字段非法存 NULL 不报错；心跳未命中静默 200 返回 `{activeSeconds: null}`；`@Post` 默认 **201**）。

3. **新增 §6.25 数据流「会话心跳 → 学习时长聚合」**：前端 `AnalyticsShell` → `POST /api/study-sessions` → 30s `PATCH .../heartbeat`（`visible`/`hidden`）→ `PATCH .../end`；服务端按 `last_heartbeat_at` 差值累加，**单次封顶 45s**；`active` 且心跳超 5 分钟由 `closeStale` 惰性收尾；家长端读侧走 `parent-analytics.repo.ts`，只统计已结束（含孤儿）会话。**并写明与旧口径的关系**。

- [ ] **Step 2: openapi.yaml 逐字段同步**

在 `docs/api/openapi.yaml`：
1. `paths` 下新增 `/parent/students/{studentId}/study-time` 与 `/parent/students/{studentId}/today-usage`（**必须是 parent 角色的安全定义**，与同文件既有家长端点一致）；
2. 新增 `/study-sessions`（post）、`/study-sessions/{uid}/heartbeat`（patch）、`/study-sessions/{uid}/end`（patch）；
3. `components.schemas` 新增 `StudyTimeSummary` / `TodayUsageSummary` / `StartStudySessionRequest` / `HeartbeatRequest` / `EndSessionRequest`，字段名与实现**逐字对应**（`totalSeconds` / `activeDays` / `byDay[{date,seconds}]` / `byModule[{module,seconds}]` / `bySubject[{subjectId,seconds}]` / `source`；`date` / `activeSeconds` / `limitMinutes`(nullable) / `exceeded` / `byModule`）；
4. 补 `201` 响应（`@Post` 默认 201，本仓无端点用 `@HttpCode` 覆盖）。

- [ ] **Step 3: 核对两份文档端点清单**

```bash
cd /Users/lichao/Downloads/claude/imooc/ai_k12
grep -n "study-sessions\|study-time\|today-usage" docs/API接口与数据流设计文档.md
grep -n "study-sessions\|study-time\|today-usage" docs/api/openapi.yaml
```

Expected: 两份都出现 3 个采集端点 + 2 个家长端点，路径字符串完全一致。

- [ ] **Step 4: 数据库设计文档 + changelog + CLAUDE.md**

1. `docs/K12智学系统-数据库设计文档.md`：新增 `study_sessions` 表设计（照 schema.sql 的列 + 索引 + 三条口径注释：服务端累计秒数、设备只到类别、iPad 校正）。
2. `docs/ai-core-changelog.md`：顶部追加一条 `2026-09-XX 埋点 Phase 1A：学习时长端到端`，记录：新增表与端点、`§10 并存不替换` 的硬约束、`active_seconds` 封顶 45s 的理由（不封顶会把「关标签 2 小时」算成 2 小时）、`closeStale` 惰性收尾、`subject_id` 改从 `learnContextStore` 取（spec §7.3 原写法的偏差已修正）、`behavior_events` 留 Phase 2。
3. 根 `CLAUDE.md`：顺手订正两处**已过期的测试计数**（本批之前就漂了，Task 8 实测暴露）：`## Development Commands` 里 `apps/web/` 段写 `vitest（107 tests）`、`apps/server/` 段写 `vitest（748 tests / 67 files）`——以 Task 18 实测的数字为准改（Task 8 时后端是 1263 tests / 103 files）。然后「工程约定」节补一条——

```markdown
- **埋点（学习会话）的两条纪律**：`active_seconds` **只由服务端**按 `last_heartbeat_at` 差值累加、**单次封顶 45s**（客户端上报的秒数一律不采信；不封顶时「关标签 2 小时」会被算成 2 小时）；埋点写入**永不阻断主链路**（`study_sessions` 直写但必须 catch，失败只 warn）。家长端「学习时长（会话）」与既有「近 7 天活跃天数」是**两套口径、并存不替换**（spec §10），UI 必须并列展示并区分文案。
```

- [ ] **Step 5: Commit**

```bash
git add docs/API接口与数据流设计文档.md docs/api/openapi.yaml docs/K12智学系统-数据库设计文档.md docs/ai-core-changelog.md CLAUDE.md
git commit -m "docs: 同步埋点 Phase 1A（采集端点 §4.23 / 数据流 §6.25 / 新表 / changelog）"
```

---

### Task 18: 终验

**Files:** 无（只跑命令）

- [ ] **Step 1: 后端全量测试 + 构建**

```bash
cd /Users/lichao/Downloads/claude/imooc/ai_k12/apps/server && npm test && npm run build
```

Expected: 全绿（Phase 0 的 1166 条 + 本计划新增约 50 条）；构建通过。

- [ ] **Step 2: 前端全量测试 + 构建 + lint**

```bash
cd /Users/lichao/Downloads/claude/imooc/ai_k12/apps/web && npm test && npm run build && npm run lint
```

Expected: 全绿（573 条 + 本计划新增约 60 条）；构建与 lint 通过。

> ⚠️ 既有已知问题：`routes/routeTable.test.tsx` 的「主轨侧边导航不含辅轨入口」在本地 **18:00–06:00 跑必红**（`StudentLayout` 挂载时按挂钟切主题），**与本批无关**，别算到新改动头上（见 `docs/家长端学情批-完成情况与待办清单.md` §1.5 / §3.3 第 6 项）。

- [ ] **Step 3: 端到端冒烟（独立端口 + 按 PID 收尾）**

```bash
cd /Users/lichao/Downloads/claude/imooc/ai_k12/apps/server
PORT=3199 node dist/main.js &
SERVER_PID=$!
sleep 2
# 1) 采集端点存在且鉴权生效（401，不是 500）
curl -s -o /dev/null -w "study-sessions -> %{http_code}\n" -X POST http://localhost:3199/api/study-sessions -H 'Content-Type: application/json' -d '{}'
# 2) 家长端点存在（401）
curl -s -o /dev/null -w "study-time -> %{http_code}\n" http://localhost:3199/api/parent/students/1/study-time
curl -s -o /dev/null -w "today-usage -> %{http_code}\n" http://localhost:3199/api/parent/students/1/today-usage
kill $SERVER_PID
```

Expected: 三行都是 `401`。**不要**用 `pkill -f 'node dist/main.js'`（会杀掉你本机在跑的服务）。

- [ ] **Step 4: 迁移幂等复查**

```bash
cd /Users/lichao/Downloads/claude/imooc/ai_k12
mysql -u ai_k12 -pai_k12 ai_k12 < tools/db/migrations/2026-09-21_study_sessions.sql
mysql -u ai_k12 -pai_k12 ai_k12 --vertical -e "SHOW COLUMNS FROM study_sessions" | grep -c "active_seconds\|client_state\|platform_class"
```

Expected: 第二次执行无报错；计数 `3`。

- [ ] **Step 5: 真机验证（手动）**

1. 学生端登录，进 `/student/training/targeted/run` 停留 ~90s，切后台 30s 再回来，然后回星图。
2. 库内确认：

```bash
mysql -u ai_k12 -pai_k12 ai_k12 --vertical -e "SELECT session_uid, module, scene, status, client_state, active_seconds, heartbeat_count, platform_class, browser, screen_class, input_type, app_shell, end_reason FROM study_sessions ORDER BY id DESC LIMIT 3"
```

Expected: 有 1 行 `status='ended'`、`end_reason='route_change'`；`active_seconds` 大致等于真实前台停留秒数（**明显小于**「从进入到离开的墙钟时间」——切后台那段不计）；`platform_class` / `browser` 已解析（iPad 上应是 `ipad` 而非 `mac`）。

3. 家长端打开仪表盘：应同时看到「近 7 天活跃 N 天」（旧口径）与「学习时长（近 7 天）」（新口径），两个数字**可以不同**——这正是 spec §10 要的效果。报告页的「每日学习时长」柱状图应出现今天的柱子。

- [ ] **Step 6: Commit（若 Step 5 有微调）**

```bash
git add -A
git commit -m "chore(analytics): Phase 1A 终验微调"
```

---

## Self-Review

**Spec 覆盖（§12 Phase 1 的前半 + §10）**

| spec 要求 | 落在 |
|---|---|
| §12 Phase 1-1：`study_sessions` 建表（含 5 个设备画像列） | Task 1 |
| §12 Phase 1-1：`StudySessionsService` + 采集端点 | Task 4、5 |
| §12 Phase 1-1：服务端 UA 粗分类工具 | Task 2 |
| §12 Phase 1-2：前端 `analytics/` + `routes/index.tsx` 包壳 | Task 9–13（**收敛**：不含 `beacon.ts`/事件队列，见「范围裁剪」） |
| §12 Phase 1-6：家长端点 + 家长页卡片（学习时长部分） | Task 6–8、15、16 |
| §4.2 iPad `mac + touch → ipad` 校正 | Task 2、4（含两个方向的单测） |
| §4.2 心跳封顶 45s / idle 120s / 5min 惰性收尾 | Task 3、4 |
| §8.1 三个采集端点的校验与幂等语义 | Task 4、5 |
| §8.2 `study-time` / `today-usage` 的返回形状与边界 | Task 7、8 |
| §8.4 dashboard / reports **响应体不动** | Global Constraints + Task 15/16（新数据走独立端点） |
| §10 并存不替换 + `rate=null` 不写 0 | Global Constraints + Task 7、15、16 |
| §15 必测用例（UA 表驱动 + memoize、`sceneMap` 表驱动、`sessionMachine` 表驱动、`tracker` 假传输 + fake timers、`AnalyticsShell`、`StudySessionsService`、每个新页面渲染测试） | Task 2、3、4、10、11、12、13、15、16 |
| §15 文档同步 | Task 17 |

**未覆盖（有意留给 Phase 1B / Phase 2）**：`special_practice_logs` + 三个专项判题点、`MasteryService` + `student_knowledge_mastery` 回写、`goals.metric` + `/parent/goals` 真页、`specials` / `mastery` / `goals/attainment` 端点与卡片（**Phase 1B**）；`behavior_events` / `EventsService` / `/api/track/events` / `page_view` / ops 仪表盘（**Phase 2**）。`/devices` 报表属运营面（Phase 2），但设备列本批已开始采集（spec §12 Phase 2 的说明）。

**Placeholder 扫描**：Step 里出现的 `...` 仅有一处（Task 1 Step 2 的 schema.sql 粘贴说明），并已显式标注「不要真的写省略号，两处必须逐字一致」。其余步骤均含可执行代码或明确命令。

**类型一致性**：`StudySessionInsertInput`（Task 3）↔ `StudySessionsService.start` 的 insert 参数（Task 4）字段名一致；`StudyTimeSummary` / `TodayUsageSummary`（Task 8 的 DTO）↔ `study-time.service.ts` 返回值（Task 7）↔ `api.ts` 的 `ParentStudyTime` / `ParentTodayUsage`（Task 14）字段一致（服务端的 `byDay[].day` 在 service 里映射为 `byDay[].date`，前端只认 `date`）；`StudySessionTransport`（Task 12）↔ `api.ts` 三个方法名一致；`SceneInfo`（Task 10）↔ `mapScene` 返回 ↔ `tracker.onRouteChange` 入参一致。

**已知偏离 spec（评审可否决）**：① 前端不含 `beacon.ts` / 事件队列（理由见「范围裁剪」）；② 迁移文件拆成 `2026-09-21_study_sessions.sql`（spec §4.9 原写 `2026-09-21_study_sessions_events.sql`，但 `behavior_events` 表已归 Phase 2，混在一个文件里会名不副实）；③ 心跳加入 `AnalyticsInterceptor` 跳过名单（spec §6.2 未列，但不跳过会与 §11 的 `api_request_logs` 容量估算矛盾）；④ `subject_id` 从扩展后的 `learnContextStore` 取（spec §7.3 说从该 store 取，但该 store 当时并没有这个字段——本计划把缺的字段补上，而不是改走 `location.state`）。
