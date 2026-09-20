# 家长端「管得住」批：行为管控 P6.6 / 异常预警中心 P6.9 / 账号设置 P6.10

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让家长能设「多久没操作算走神」的灵敏度、能在一个页面里看到孩子触发的全部预警（闲聊 / 情绪 / 敏感 / 切走 / 发呆）并标记已读，同时把 P6.10 的账号信息只读 + 改密码 + 退出补齐。

**设计真源**：`docs/superpowers/specs/2026-09-20-parent-controls-and-alerts-design.md`（下称 **spec**）。本计划是它的任务级拆解，**契约与裁决一律以 spec 为准**，本文件只负责「按什么顺序、改哪些文件、怎么验证」。spec 与本计划冲突时 → 停下来问用户，不要自行裁决。

**Task 0 已完成**（2026-09-20）：`<!--topic:off-->` 标记验证门 3/3 通过 → 采用**方案 A**（模型自报标记）。提示词已改（`tutoring/math/auxiliary.md`、`mainline.md`），验证脚本在 `src/ai-core/__tests__/off-topic-marker.ts`。

## Global Constraints

> 本节每条都是硬规则，每个任务的要求都隐含包含。**动手前先读一遍。**

**用户已裁决（spec §1.1，共 10 条，勿自行改回）**

1. 范围 = P6.6 + P6.9 + P6.10 一批交付；P6.10 只做「账号信息只读 + 修改密码 + 退出登录」。
2. 预警**只写 `safety_alerts`**，**不写 `parent_messages`**（站内信表无 `student_id`，多孩分不清）。
3. 闲聊判定**由模型自报标记**，不靠关键词正则。
4. 闲聊**不硬拦**，交给模型温和引导。
5. 走神信号**分开记**「页面被切走」与「前台无操作」，**两类都报**。
6. 等待时长**家长可调，不写死**。
7. 每日最大使用时长、禁用时段：**本批不做**，页面上也不出现。
8. 辅线访问开关：**撤掉**（不做门禁）。
9. 拍照解题开关：**撤掉**。
10. `ai.service.ts:153` 的 TODO **保留不删**；`controls` 的 `alert_level` / `auxiliary_enabled` / `photo_search_enabled` 三列**保留、不标废弃**。

**spec §1.2 的 UX 偏差（已在 spec 记录，本批按裁决执行）**：UX §P6.6 的四项（每日时长 / 禁用时段 / 辅线开关 / 拍照开关）本批**不做**；P6.6 页实际内容是「预警灵敏度 + 奖励兑换只读入口」。

**埋点与旁路写入纪律（`CLAUDE.md` 硬规则，本批最容易踩）**

- **预警写入永不阻断主链路**：整段 try/catch，失败只 `logger.warn`。辅导链路用 `void` 不 `await`；心跳路径绝不拖长 `active_seconds` 的累加与心跳响应。
- **`active_seconds` 语义不变**：本批新增的 4 个 `study_sessions` 列**不参与**既有学习时长口径（`parent-analytics.repo.ts` 的 `EFFECTIVE_SESSION` 不动）。
- **⚠️ `study_sessions` 的 SET 列顺序是承重的**：MySQL 单表 `SET` 从左到右求值、后读的是**新值**。`active_seconds` 那段既有顺序**不得打乱**（`study-sessions.repo.ts:101-123` 有原文注释 + 顺序钉子用例）。新增列必须插在正确位置。
- **`hidden_reason` / `hidden_since` 的维护也必须遵守同一顺序**：判定「这一段连续挂机多久」要读**旧** `hidden_since`，所以 `hidden_since` 的赋值必须排在读它的表达式**之后**。

**DB 约定**

- 时间列 `DATETIME(3)`；`updated_at` 用**列级** `ON UPDATE CURRENT_TIMESTAMP(3)`（**不加触发器**）。
- **无迁移运行器 → 手工 apply 且必须幂等**：加列/加索引一律 `information_schema` + `PREPARE` 守卫（照 `tools/db/migrations/2026-09-22_special_practice_logs_and_goals.sql:39-71`）。
- 新列**必须同时进 `tools/db/schema.sql`**。
- 不删既有数据、不改既有列语义。

**代码约定**

- **错误码是内联字面量**（本仓无集中式错误码文件）：`1001` 入参/冲突、`1002` 不存在、`1003` 认证失败、`1005` 无权。抛错形态是 Nest 内建异常 + `{ code, message }` 对象。
- **`Nest` 的 `@Post` 默认 201**；本批新增端点里 `PUT`/`PATCH`/`GET` 按实际记（`PUT` 默认 200、`PATCH` 默认 200）。
- **DI 坑**：带 `@Injectable()` 的类若构造函数有**接口类型**参数，运行时会被写成 `Object` → Nest 找不到 token → **启动直接失败**。`TutoringCapability` **不是** `@Injectable()`（走 `useFactory` + `new`），所以它的 `deps` 里放接口类型是安全的。
- **家长端派生状态必须带 `studentId` 归属**（`data: { studentId, value }`，读取时一并比较）；**列表页换孩子必须回第 1 页**。
- **测试**：`globals: false` → 多用例文件自己 `afterEach(cleanup())` 并复位 Zustand 单例；**仓储测试不许只断言「自己传了什么 payload」**，凡「参数顺序 ↔ 列清单」的映射都要用 `zipInsert` 按列名配对断言；每个新组件/页面补渲染测试。
- **UI**：不用 emoji、图标必须是线性 SVG、家长端配色只用 `style.md` §2.3 那套（CSS 变量名是 `--brand-500` / `--bg-card` / `--text-primary` / `--error` 等，**没有** `--brand-p-500` 这种名字）。
- **环境**：起后端 `node dist/main.js`；冒烟用**独立端口 + 按 PID 收尾**，**别** `pkill -f 'node dist/main.js'`（用户本机有自己的服务在跑，见 `CLAUDE.md`）。
- ⚠️ **既有夜间红**：`apps/web/src/routes/routeTable.test.tsx` 的「主轨侧边导航不含辅轨入口」断言 `[data-theme="student-day"]`，18:00–06:00 跑必红。**别算到本批头上、也别顺手改它。**

## 现状要点（写计划时已核实，实施时别凭印象）

| 事实 | 位置 |
|---|---|
| `ParentNav` **已有 10 项**，含「行为管控」`/parent/controls`、「账号设置」`/parent/account` | `ParentNav.tsx:78-88, 100-110` |
| `/parent/controls`、`/parent/alerts`、`/parent/account` 三条路由**已注册**，均指向 `Placeholder` | `routeTable.tsx:332, 334, 335` |
| 假 Banner：`const hasAlert = true;` + 写死标题 + CTA **无 onClick** | `ParentLayout.tsx:32, 37-52` |
| `SafetyAlertsRepository` **已存在但零注入**（无任何 module provide） | `safety-alerts.repo.ts`；`index.ts:31` 仅 re-export |
| `SafetyAlertRow.type` 枚举**不含** `away`/`idle` | `types.ts:82` |
| `controls.repo.ts` 的 `update` 白名单**只有** `pointsPerYuan` / `rewardRedemptionEnabled`；`findByStudent` **只 SELECT 两列** | `controls.repo.ts:53, 96` |
| `ParentsRepository` **没有** `updatePassword` | `parents.repo.ts` |
| `dashboard.service.ts` 的 `unreadAlerts` **硬编码 0**（两处），且测试钉着 | `:85, :90`；`dashboard.service.test.ts:179-184` |
| `study-sessions.repo.ts` 的 `heartbeat` **已有 `subjectId`**（P6.5 做的），参数 `[state, subjectId, sessionUid, studentId]` | `:124-150` |
| `TutoringCapability` 只在 `ai.module.ts:35-40` 用 `useFactory` 装配；`studentId`/`dialogueId` 都是 **string** | `ai.module.ts`；`ai-core/types.ts:425-437` |
| `saveMessages` 返回 `Promise<void>`，**不透出 message id**；全仓无「取最后一条 assistant 消息」查询 | `services/conversation/index.ts:122` |
| `SafetyGuard.detectAnomalyType` 只会返回 `emotional` / `sensitive`（**`abusive` 实际不可达**） | `safety-guard.ts:145-153` |
| `sceneMap` 已把整个 `/parent/*` 归为非学习场景（`isStudyScene: false`）→ 新家长页不会开学习会话 | `sceneMap.ts:38` |
| `base/` **没有 `EmptyState`**；空态是页面内手写 `<Card data-testid="...-empty">` | `base/index.ts` |
| 家长端 CSS 变量真源 | `src/styles/global.css:156-181` |

## File Structure

**新建（后端）**

| 文件 | 职责 |
|---|---|
| `tools/db/migrations/2026-09-20_parent_controls_and_alerts.sql` | `controls` +2 列、`study_sessions` +4 列；幂等 |
| `apps/server/src/modules/safety/safety-alerts.service.ts` | 预警**唯一写入口**：去重窗口 + `parent_id` 解析 + best-effort；面向家长文案的唯一真源 |
| `apps/server/src/modules/safety/safety-alerts.module.ts` | provide + export `SafetyAlertsService` / `SafetyAlertsRepository` |
| `apps/server/src/modules/safety/safety-alerts.service.test.ts` | 去重、归属解析、失败吞错、文案映射 |
| `apps/server/src/modules/parent-insights/controls.service.ts` + `.test.ts` | P6.6 灵敏度读写（校验链见 spec §4.1/§4.2） |
| `apps/server/src/modules/parent-insights/alerts.service.ts` + `.test.ts` | P6.9 列表 / 标记已读（spec §4.3/§4.4） |

**新建（前端）**

| 文件 | 职责 |
|---|---|
| `apps/web/src/pages/parent/ParentAlertsPage.tsx` + `.test.tsx` | 预警中心（spec §5.2 状态机） |
| `apps/web/src/pages/parent/ParentControlsPage.tsx` + `.test.tsx` | 行为管控（spec §5.3 状态机） |
| `apps/web/src/pages/parent/ParentAccountPage.tsx` + `.test.tsx` | 账号设置（spec §5.4 状态机） |

**修改（后端）**

| 文件 | 改什么 |
|---|---|
| `tools/db/schema.sql` | `controls` 段 +2 列；`study_sessions` 段 +4 列 |
| `apps/server/src/database/repositories/types.ts` | `SafetyAlertRow.type` 加 `'away' \| 'idle'` |
| `apps/server/src/database/repositories/safety-alerts.repo.ts` | 加 `existsRecent` / `listByParent`（分页+筛选+带孩子名）/ `findById` |
| `apps/server/src/database/repositories/controls.repo.ts` | `ControlsSnapshot`/`ControlsPatch` 加两个分钟数；`findByStudent` SELECT 加两列；`update` 白名单加两列；新增 `findAlertThresholds` |
| `apps/server/src/database/repositories/parents.repo.ts` | 加 `updatePassword` |
| `apps/server/src/database/repositories/study-sessions.repo.ts` | `heartbeat`/`end` 增加 4 列的维护 + 阈值判定所需的回读 |
| `apps/server/src/modules/analytics/analytics.controller.ts` | `HeartbeatSchema` 加可选 `reason` |
| `apps/server/src/modules/analytics/study-sessions.service.ts` | 透传 `reason`；阈值判定 + 写预警（`SafetyAlertsService`） |
| `apps/server/src/modules/analytics/analytics.module.ts` | import `SafetyAlertsModule`；provide `ControlsRepository` |
| `apps/server/src/ai-core/infra/safety-guard.ts` | **删** off_topic 硬阻断与辅线豁免（保留 anomaly 分支与 `countConsecutiveOffTopic`） |
| `apps/server/src/ai-core/capabilities/tutoring.capability.ts` | `parseContent` 剥离标记并返回 `offTopic`；`recordSafetySignals`；两条入口传 `safetyFlag` |
| `apps/server/src/ai-core/types.ts` | `SaveMessageEntry` 加可选 `safetyFlag` |
| `apps/server/src/services/conversation/index.ts` | `:144` 改 `Number(msg.safetyFlag ?? (msg.type === 'block' ? 1 : 0))`（**外层 `Number(...)` 必需**，理由见 Step 3） |
| `apps/server/src/modules/conversations/conversations.service.ts` | `:199` 同上 |
| `apps/server/src/modules/ai/ai.module.ts` | import `SafetyAlertsModule`；factory 注入 `SafetyAlertsService` 传给 `TutoringCapability` |
| `apps/server/src/modules/parent-insights/parent-insights.controller.ts` | 加 controls / alerts 四端点 |
| `apps/server/src/modules/parent-insights/parent-insights.module.ts` | import `SafetyAlertsModule`；provide 两个新 service |
| `apps/server/src/modules/parent-insights/dashboard.service.ts` | `unreadAlerts` 改真查 |
| `apps/server/src/modules/parent-insights/dto/parent-insights.dto.ts` | 加 `ParentAlertItem` / `ParentAlertPage` / `ParentControls` |
| `apps/server/src/modules/parent/parent.controller.ts` | 加 `GET account` / `PATCH password` |
| `apps/server/src/modules/parent/parent.service.ts` | 注入 `ParentsRepository`；加 `getAccount` / `changePassword` |
| `apps/server/src/modules/parent/parent.module.ts` | provide `ParentsRepository` |
| `apps/server/src/database/repositories/index.ts` | 新仓储/类型 barrel 导出（如缺） |

**修改（前端）**

| 文件 | 改什么 |
|---|---|
| `apps/web/src/services/api.ts` | 加 6 个函数 + 类型（controls 读/写、alerts 列表/标记已读、account、password） |
| `apps/web/src/analytics/types.ts` | 加 `HiddenReason = 'away' \| 'idle'` |
| `apps/web/src/analytics/sessionMachine.ts` | `SessionEffects.heartbeat` 改 `{ state, reason }` |
| `apps/web/src/analytics/tracker.ts` | 心跳带上 `reason` |
| `apps/web/src/components/layout/ParentLayout.tsx` | 删假 Banner，改真预警 Banner |
| `apps/web/src/components/layout/ParentNav.tsx` | 加「异常预警」入口（第 11 项） |
| `apps/web/src/pages/parent/ParentChatLogsPage.tsx` | 计数/标签文案「闲聊」→「偏离学习」（`safety_flag` 双来源，Task 5 Step 3） |
| `apps/web/src/routes/routeTable.tsx` | 三条 Placeholder 换成真页 |
| 既有测试 | `ParentLayout.test.tsx` / `ParentNav.test.tsx` / `sessionMachine.test.ts` / `tracker.test.ts` / `routeTable.test.tsx` / `dashboard.service.test.ts` / `safety-guard.test.ts` / `safety-classification.ts` 同步 |

**文档**

| 文件 | 改什么 |
|---|---|
| `docs/API接口与数据流设计文档.md` | §4.13 四个路径转已实现 + 新增 `/password`；§7 页面→端点映射；UX 偏差批注（spec §1.2） |
| `docs/api/openapi.yaml` | 四路径转实现；订正 `Controls` / `Alert.type` / `ParentAccount`；新增 `/parent/password` |
| `docs/K12智学系统-数据库设计文档.md` | `controls` +2 列、`study_sessions` +4 列、`safety_alerts.type` 枚举、**`ai_messages.safety_flag` 语义变更**、三列「预留未用」 |
| `docs/UX-UI设计文档.md` | §P6.6 / §P6.9 批注；侧栏清单补「异常预警」 |
| `docs/ai-core-changelog.md` | 本批日志（日期 + 变更 + 10 条裁决 + Task 0 结果） |
| `CLAUDE.md` | 只留仍生效约束（预警只写 `safety_alerts`、走神两口径、`safety_flag` 语义变更），保持 ~15KB |
| `docs/家长端学情批-完成情况与待办清单.md` | §6 标已完成；写入 §1.1 裁决与 §1.2 偏差 |

---

### Task 1: 迁移与 schema —— `controls` +2 列、`study_sessions` +4 列、类型枚举

**Files:**
- Create: `tools/db/migrations/2026-09-20_parent_controls_and_alerts.sql`
- Modify: `tools/db/schema.sql`（`controls` 段在 :861、`study_sessions` 段在 :1244）
- Modify: `apps/server/src/database/repositories/types.ts`（`SafetyAlertRow.type` 在 :82）

**Interfaces:**
- Produces: `controls.alert_away_minutes` / `controls.alert_idle_minutes`（`SMALLINT NOT NULL DEFAULT 5 / 15`）；`study_sessions.hidden_away_seconds` / `hidden_idle_seconds` / `hidden_since` / `hidden_reason`；`SafetyAlertRow['type']` 含 `'away' | 'idle'`

**口径（写进 SQL 注释）**
- 两个阈值列的默认值 = spec §3.6「标准」档：`alert_away_minutes=5`、`alert_idle_minutes=15`。
- `hidden_*_seconds` 是**会话内累计**（`INT NOT NULL DEFAULT 0`），与 `active_seconds` 并列但**不参与**学习时长口径。
- `hidden_since` 是**当前连续挂机段的起点**（`DATETIME(3) DEFAULT NULL`，回到 visible 时置 NULL）；`hidden_reason` 是**当前段的原因**（`VARCHAR(10) DEFAULT NULL`，`away` / `idle`）。
- 为什么不复用 `end_reason`：`end_reason` 是**会话级**的（一个会话只有一个），而挂机段可以有很多个。

- [ ] **Step 1: 写迁移**

创建 `tools/db/migrations/2026-09-20_parent_controls_and_alerts.sql`：

```sql
-- 2026-09-20 家长端「管得住」批：controls 预警灵敏度 + study_sessions 走神两口径
--
-- 做什么：
--   1) controls 加 alert_away_minutes（默认 5）、alert_idle_minutes（默认 15）
--   2) study_sessions 加 hidden_away_seconds / hidden_idle_seconds / hidden_since / hidden_reason
--
-- 为什么：
--   * 家长要能调「多久没操作算走神」（spec 裁决 6：报警时间可设置，不要写死）。
--   * 走神要分「页面被切走(away)」与「前台无操作(idle)」两类，各自累计（spec 裁决 5）。
--     此前两类在客户端状态机里被合并成同一个 hidden，原因丢失（spec §2.3）。
--   * hidden_since 用来回答「当前这一段连续挂机多久了」——判定时机是**阈值处就报**，
--     不等挂机段结束（学生切走后再不回来，正是家长最需要知道的场景）。
--   * 新列**不参与**既有 active_seconds 的学习时长口径（parent-analytics.repo.ts 不动）。
--
-- 幂等：加列全部带 information_schema 守卫；重复 apply 无副作用。
-- 回滚：ALTER TABLE controls DROP COLUMN alert_away_minutes, DROP COLUMN alert_idle_minutes;
--       ALTER TABLE study_sessions DROP COLUMN hidden_away_seconds, DROP COLUMN hidden_idle_seconds,
--                                DROP COLUMN hidden_since, DROP COLUMN hidden_reason;

-- ── 1. controls：预警灵敏度两个阈值 ──
SET @col_exists := (
  SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'controls' AND COLUMN_NAME = 'alert_away_minutes'
);
SET @ddl := IF(@col_exists = 0,
  'ALTER TABLE controls ADD COLUMN alert_away_minutes SMALLINT NOT NULL DEFAULT 5 COMMENT ''切走多少分钟写 away 预警（家长可调 1..180）''',
  'DO 0');
PREPARE stmt FROM @ddl; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @col_exists := (
  SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'controls' AND COLUMN_NAME = 'alert_idle_minutes'
);
SET @ddl := IF(@col_exists = 0,
  'ALTER TABLE controls ADD COLUMN alert_idle_minutes SMALLINT NOT NULL DEFAULT 15 COMMENT ''前台无操作多少分钟写 idle 预警（家长可调 1..180）''',
  'DO 0');
PREPARE stmt FROM @ddl; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- ── 2. study_sessions：走神两口径累计 + 当前连续挂机段 ──
SET @col_exists := (
  SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'study_sessions' AND COLUMN_NAME = 'hidden_away_seconds'
);
SET @ddl := IF(@col_exists = 0,
  'ALTER TABLE study_sessions ADD COLUMN hidden_away_seconds INT NOT NULL DEFAULT 0 COMMENT ''会话内累计「页面不可见」秒数；不参与 active_seconds 口径''',
  'DO 0');
PREPARE stmt FROM @ddl; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @col_exists := (
  SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'study_sessions' AND COLUMN_NAME = 'hidden_idle_seconds'
);
SET @ddl := IF(@col_exists = 0,
  'ALTER TABLE study_sessions ADD COLUMN hidden_idle_seconds INT NOT NULL DEFAULT 0 COMMENT ''会话内累计「前台无操作」秒数；不参与 active_seconds 口径''',
  'DO 0');
PREPARE stmt FROM @ddl; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @col_exists := (
  SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'study_sessions' AND COLUMN_NAME = 'hidden_since'
);
SET @ddl := IF(@col_exists = 0,
  'ALTER TABLE study_sessions ADD COLUMN hidden_since DATETIME(3) DEFAULT NULL COMMENT ''当前连续挂机段起点；回到 visible 时置 NULL''',
  'DO 0');
PREPARE stmt FROM @ddl; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @col_exists := (
  SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'study_sessions' AND COLUMN_NAME = 'hidden_reason'
);
SET @ddl := IF(@col_exists = 0,
  'ALTER TABLE study_sessions ADD COLUMN hidden_reason VARCHAR(10) DEFAULT NULL COMMENT ''当前挂机段原因 away|idle；回到 visible 时置 NULL''',
  'DO 0');
PREPARE stmt FROM @ddl; EXECUTE stmt; DEALLOCATE PREPARE stmt;
```

- [ ] **Step 2: 手工 apply**

```bash
cd /Users/lichao/Downloads/claude/imooc/ai_k12
mysql -h127.0.0.1 -uai_k12 -pai_k12 ai_k12 < tools/db/migrations/2026-09-20_parent_controls_and_alerts.sql && echo "APPLY OK"
```

Expected: `APPLY OK`，无输出报错。

> ⚠️ 本机 mysql 9.5 非交互 `-e` 下不认 `\G`，要看表结构用 `--vertical`。

- [ ] **Step 3: 验证（4 项断言）+ 幂等复跑**

```bash
cd /Users/lichao/Downloads/claude/imooc/ai_k12
mysql -h127.0.0.1 -uai_k12 -pai_k12 ai_k12 -N -e "
SELECT CONCAT('controls_new_cols=', COUNT(*)) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='controls'
    AND COLUMN_NAME IN ('alert_away_minutes','alert_idle_minutes');
SELECT CONCAT('ss_new_cols=', COUNT(*)) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='study_sessions'
    AND COLUMN_NAME IN ('hidden_away_seconds','hidden_idle_seconds','hidden_since','hidden_reason');
SELECT CONCAT('away_default=', COLUMN_DEFAULT) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='controls' AND COLUMN_NAME='alert_away_minutes';
SELECT CONCAT('idle_default=', COLUMN_DEFAULT) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='controls' AND COLUMN_NAME='alert_idle_minutes';
" 2>/dev/null
mysql -h127.0.0.1 -uai_k12 -pai_k12 ai_k12 < tools/db/migrations/2026-09-20_parent_controls_and_alerts.sql && echo "RE-APPLY OK（幂等）"
```

Expected: `controls_new_cols=2`、`ss_new_cols=4`、`away_default=5`、`idle_default=15`、`RE-APPLY OK`。

- [ ] **Step 4: 同步 `tools/db/schema.sql`**

**(a)** `controls` 段（:861-877）在 `break_reminder_minutes` 之后、`created_at` 之前插入两行：

```sql
  alert_away_minutes SMALLINT NOT NULL DEFAULT 5 COMMENT '切走多少分钟写 away 预警（家长可调 1..180）',
  alert_idle_minutes SMALLINT NOT NULL DEFAULT 15 COMMENT '前台无操作多少分钟写 idle 预警（家长可调 1..180）',
```

**(b)** `study_sessions` 段（:1244-1274）在 `end_reason` 之后、`platform_class` 之前插入四行：

```sql
  hidden_away_seconds INT       NOT NULL DEFAULT 0 COMMENT '会话内累计「页面不可见」秒数；不参与 active_seconds 口径',
  hidden_idle_seconds INT       NOT NULL DEFAULT 0 COMMENT '会话内累计「前台无操作」秒数；不参与 active_seconds 口径',
  hidden_since        DATETIME(3) DEFAULT NULL COMMENT '当前连续挂机段起点；回到 visible 时置 NULL',
  hidden_reason       VARCHAR(10) DEFAULT NULL COMMENT '当前挂机段原因 away|idle；回到 visible 时置 NULL',
```

- [ ] **Step 5: 验证两处列清单一致**

```bash
cd /Users/lichao/Downloads/claude/imooc/ai_k12
for c in alert_away_minutes alert_idle_minutes; do
  mysql -h127.0.0.1 -uai_k12 -pai_k12 ai_k12 -N -e \
    "SELECT CONCAT('$c: db=', COUNT(*)) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='controls' AND COLUMN_NAME='$c'" 2>/dev/null
done
grep -c "alert_away_minutes\|alert_idle_minutes" tools/db/schema.sql
grep -c "hidden_away_seconds\|hidden_idle_seconds\|hidden_since\|hidden_reason" tools/db/schema.sql
```

Expected: 两条 db 计数都是 1；`schema.sql` 的 `grep -c` 分别 ≥ 2 与 ≥ 4。

- [ ] **Step 6: 改 `types.ts` 的枚举**

`apps/server/src/database/repositories/types.ts:82`：

```ts
  type: 'off_topic' | 'emotional' | 'sensitive' | 'abusive' | 'away' | 'idle';
```

（`abusive` **保留**：`pickGentleBlockMessage` 仍映射它，虽然 `detectAnomalyType` 目前不可达。）

- [ ] **Step 7: 提交**

```bash
git add tools/db/migrations/2026-09-20_parent_controls_and_alerts.sql tools/db/schema.sql \
        apps/server/src/database/repositories/types.ts
git commit -m "feat(db): controls 预警灵敏度两列 + study_sessions 走神两口径四列"
```

---

### Task 2: 预警写入口 —— `SafetyAlertsRepository` 扩展 + `SafetyAlertsService`

**Files:**
- Modify: `apps/server/src/database/repositories/safety-alerts.repo.ts`
- Create: `apps/server/src/modules/safety/safety-alerts.service.ts` + `.module.ts` + `safety-alerts.service.test.ts`
- Modify: `apps/server/src/database/repositories/index.ts`（如新类型需导出）

**Interfaces:**
- Produces（Task 4 / Task 5 / Task 6 依赖）：
  - `SafetyAlertsRepository.existsRecent(studentId: number, type: SafetyAlertType, since: Date): Promise<boolean>`
  - `SafetyAlertsRepository.listByParent(parentId, filters: { studentId?: number; unreadOnly?: boolean }, limit, offset): Promise<{ items: SafetyAlertRowWithStudentName[]; total: number }>`
  - `SafetyAlertsRepository.findById(id: number): Promise<SafetyAlertRow | null>`
  - `SafetyAlertsService.record(input: RecordSafetyAlertInput): void`（**同步返回、fire-and-forget、永不抛**）
  - `SafetyAlertsService.messageFor(type, minutes?): string`（面向家长文案的**唯一真源**，spec §3.4 表）
- Consumes: `StudentsRepository.findById`（拿 `parentId`）

**三条口径（写进代码注释）**
1. **`record` 是同步 void**：内部 `void this.doRecord(input).catch(() => {})`。辅导链路是同步上下文，不能因为它是 async 就让调用方 `await`。
2. **去重窗口 30 分钟**（spec §3.5）：同一 `student_id` + 同一 `type` 在窗口内只写一条。心跳每 30 秒一次，不去重会刷屏。`since` 由**服务层算好**（`new Date(Date.now() - 30*60*1000)`），仓储不写 `NOW()` 以外的业务窗口。
3. **`parent_id` 由服务层解析**（`studentsRepo.findById`）——仓储的 `create` 要求它，而调用方（ai-core / analytics）只知道 `studentId`。学生不存在 → 跳过并 `warn`（不抛）。

- [ ] **Step 1: 扩展仓储**

在 `safety-alerts.repo.ts` 追加（保留既有 `create` / `findByParent` / `markRead` 不动）：

```ts
  /** 去重窗口：同一学生 + 同一 type 在 `since` 之后是否已写过一条（spec §3.5，30 分钟）。 */
  async existsRecent(studentId: number, type: string, since: Date): Promise<boolean> {
    const [rows] = await this.pool.execute<(RowDataPacket & { n: number | string })[]>(
      `SELECT COUNT(*) AS n FROM safety_alerts
       WHERE student_id = ? AND type = ? AND created_at >= ?`,
      [studentId, type, since],
    );
    return Number(rows[0]?.n ?? 0) > 0;
  }

  async findById(id: number): Promise<SafetyAlertRow | null> {
    const [rows] = await this.pool.execute<SafetyAlertRow[]>(
      `SELECT * FROM safety_alerts WHERE id = ? LIMIT 1`,
      [id],
    );
    return rows[0] ?? null;
  }

  /**
   * 家长端列表（join students 取孩子名）。
   * 排序固定 `created_at DESC, id DESC`（同一毫秒的稳定次序）；半开区间不涉及。
   * 孤儿行理论上不可能（两个 FK 都是 ON DELETE CASCADE），但 `studentName` 仍按可空处理。
   */
  async listByParent(
    parentId: number,
    filters: { studentId?: number; unreadOnly?: boolean },
    limit: number,
    offset: number,
  ): Promise<{ items: SafetyAlertRowWithStudentName[]; total: number }> {
    const where: string[] = ['sa.parent_id = ?'];
    const params: Array<number> = [parentId];
    if (filters.studentId !== undefined) { where.push('sa.student_id = ?'); params.push(filters.studentId); }
    if (filters.unreadOnly) where.push('sa.is_read = 0');
    const clause = where.join(' AND ');

    const [countRows] = await this.pool.execute<(RowDataPacket & { n: number | string })[]>(
      `SELECT COUNT(*) AS n FROM safety_alerts sa WHERE ${clause}`, params,
    );
    const [rows] = await this.pool.execute<SafetyAlertRowWithStudentName[]>(
      `SELECT sa.*, s.name AS student_name
       FROM safety_alerts sa LEFT JOIN students s ON s.id = sa.student_id
       WHERE ${clause}
       ORDER BY sa.created_at DESC, sa.id DESC
       LIMIT ? OFFSET ?`,
      [...params, limit, offset],
    );
    return { items: rows, total: Number(countRows[0]?.n ?? 0) };
  }
```

并在同文件顶部加类型：

```ts
/** 列表行：预警本体 + join 出来的孩子名（取不到就是「未知学生」，不做非空断言）。 */
export interface SafetyAlertRowWithStudentName extends SafetyAlertRow {
  student_name: string | null;
}
```

- [ ] **Step 2: 写服务**

`modules/safety/safety-alerts.service.ts`：

```ts
import { Injectable, Logger } from '@nestjs/common';
import { StudentsRepository } from '../../database/repositories/students.repo.js';
import { SafetyAlertsRepository } from '../../database/repositories/safety-alerts.repo.js';

/**
 * 预警类型。**与 `SafetyAlertRow['type']` 同源**（`database/repositories/types.ts`），
 * `abusive` 一并保留 —— 虽然 `SafetyGuard.detectAnomalyType` 目前不可达它，但它是
 * `SafetyAlertRow` 的合法取值；漏掉会让 `messageFor` 落到 `undefined`（安全功能里
 * 静默返回 undefined 不可接受，2026-09-20 Task 2 评审指出）。
 */
export type SafetyAlertType = 'off_topic' | 'emotional' | 'sensitive' | 'abusive' | 'away' | 'idle';

export interface RecordSafetyAlertInput {
  studentId: number;
  dialogueId: number | null;
  type: SafetyAlertType;
  level: 'info' | 'warning' | 'critical';
  /** 面向家长的文案；调用方**不要**自己拼，用 `messageFor()`。 */
  message: string;
  /** 上下文片段：闲聊/情绪/敏感 = 学生消息截断 200 字；走神 = 「切走 N 分钟」。 */
  context: string | null;
}

/** 去重窗口（spec §3.5）。 */
const DEDUPE_WINDOW_MS = 30 * 60 * 1000;
/** 上下文片段截断长度。 */
const CONTEXT_MAX = 200;

@Injectable()
export class SafetyAlertsService {
  private readonly logger = new Logger(SafetyAlertsService.name);

  constructor(
    private readonly alertsRepo: SafetyAlertsRepository,
    private readonly studentsRepo: StudentsRepository,
  ) {}

  /**
   * 写一条预警。**同步返回、fire-and-forget、永不抛**（spec §6 不变量）。
   *
   * 为什么同步：调用点在辅导链路（同步上下文）与心跳路径（不能拖长响应）上，
   * 让它们 `await` 一个 INSERT + 一次去重 SELECT 是没必要的等待。
   */
  record(input: RecordSafetyAlertInput): void {
    void this.doRecord(input).catch((err) => {
      this.logger.warn(`预警写入失败（已忽略）：${String(err)}`);
    });
  }

  private async doRecord(input: RecordSafetyAlertInput): Promise<void> {
    try {
      const since = new Date(Date.now() - DEDUPE_WINDOW_MS);
      if (await this.alertsRepo.existsRecent(input.studentId, input.type, since)) return;

      const student = await this.studentsRepo.findById(input.studentId);
      if (!student) {
        this.logger.warn(`预警跳过：学生 ${input.studentId} 不存在`);
        return;
      }

      await this.alertsRepo.create({
        parent_id: student.parentId,
        student_id: input.studentId,
        dialogue_id: input.dialogueId,
        message_id: null,
        type: input.type,
        level: input.level,
        message: input.message,
        context: input.context ? input.context.slice(0, CONTEXT_MAX) : null,
      });
    } catch (err) {
      this.logger.warn(`预警写入失败（已忽略）：${String(err)}`);
    }
  }

  /** 面向家长的文案（spec §3.4 表，**唯一真源**，调用方别自己拼）。六个类型全覆盖，无 `default`。 */
  messageFor(type: SafetyAlertType, minutes?: number): string {
    switch (type) {
      case 'off_topic': return '检测到孩子在学习中发起了与学习无关的闲聊';
      case 'emotional': return '检测到孩子出现情绪发泄类输入';
      case 'sensitive': return '检测到敏感内容输入，建议尽快关注';
      // `abusive` 无独立文案，与 `SafetyGuard.pickGentleBlockMessage` 的既有约定一致（→ 复用敏感文案）
      case 'abusive': return '检测到敏感内容输入，建议尽快关注';
      case 'away': return `孩子离开了学习页面 ${minutes ?? 0} 分钟`;
      case 'idle': return `孩子在学习页面 ${minutes ?? 0} 分钟无操作`;
    }
  }

  /** 走神的 context 文案（与 message 同源，别在调用点重复拼）。 */
  awayContext(type: 'away' | 'idle', minutes: number): string {
    return type === 'away' ? `切走 ${minutes} 分钟` : `无操作 ${minutes} 分钟`;
  }
}
```

`modules/safety/safety-alerts.module.ts`：

```ts
import { Module } from '@nestjs/common';
import { SafetyAlertsService } from './safety-alerts.service.js';
import { SafetyAlertsRepository } from '../../database/repositories/safety-alerts.repo.js';
import { StudentsRepository } from '../../database/repositories/students.repo.js';

/**
 * 预警写入口的共享模块。三个消费方：
 *   - `AIModule`（辅导链路：闲聊 / 情绪 / 敏感）
 *   - `AnalyticsModule`（心跳链路：走神）
 *   - `ParentInsightsModule`（家长端列表 / 标记已读，直接用 `SafetyAlertsRepository`）
 * 注意：**不要**在别的模块重复 provide 这两个仓储/服务（会分裂实例与去重语义）。
 */
@Module({
  providers: [SafetyAlertsService, SafetyAlertsRepository, StudentsRepository],
  exports: [SafetyAlertsService, SafetyAlertsRepository],
})
export class SafetyAlertsModule {}
```

- [ ] **Step 3: 测试**

`modules/safety/safety-alerts.service.test.ts` 必测：
1. 去重命中（`existsRecent` 回 true）→ **不调 `create`**。
2. 学生不存在 → 不调 `create`、不抛。
3. 正常路径 → `create` 收到 `parent_id`（来自 `findById`）、`message_id: null`、`context` 截断到 200 字。
4. `record` 在 `create` reject 时**不抛**（同步调用不炸调用方）。
5. `messageFor` 五个 type 的文案逐字断言（含 `away`/`idle` 的分钟数插值）。
6. `existsRecent` 的 `since` 是**应用层算的 Date**（断言 SQL 里不含 `NOW()` / `CURDATE()`，且 params[2] 是 Date）。

- [ ] **Step 4: 跑测试 + 类型检查**

```bash
cd apps/server && npx vitest run src/modules/safety src/database/repositories/safety-alerts.repo.test.ts 2>/dev/null || npx vitest run src/modules/safety && npx tsc --noEmit
```

Expected: 全绿；`tsc` 无输出。

- [ ] **Step 5: 提交**

```bash
git add apps/server/src/modules/safety apps/server/src/database/repositories/safety-alerts.repo.ts
git commit -m "feat(safety): 预警写入口 SafetyAlertsService（去重 + parentId 解析 + best-effort）"
```

---

### Task 3: `ControlsRepository` 扩展（两个阈值列）

**Files:**
- Modify: `apps/server/src/database/repositories/controls.repo.ts`
- Modify: `apps/server/src/database/repositories/controls.repo.test.ts`

**Interfaces:**
- Produces（Task 4 / Task 6 依赖）：
  - `ControlsSnapshot` 加 `alertAwayMinutes: number` / `alertIdleMinutes: number`
  - `ControlsPatch` 加同名可选字段
  - `findAlertThresholds(studentId: number): Promise<{ awayMinutes: number; idleMinutes: number }>`
- ⚠️ **`ensure` 必须保持无副作用**（既有测试 `controls.repo.test.ts:26-27` 钉着）。

**口径**
- `findByStudent` 的 SELECT 从两列扩到四列（`points_per_yuan, reward_redemption_enabled, alert_away_minutes, alert_idle_minutes`），返回映射加两个 `Number(...)`（NULL 兜底 5 / 15）。
- `update` 的白名单加两条 `sets.push`（照既有 `pointsPerYuan` 写法）。
- `findAlertThresholds` 单独一条轻量 SELECT（心跳路径每 30 秒调一次，**不要**顺手读其它列）。

- [ ] **Step 1: 改仓储**（按上面口径）

- [ ] **Step 2: 补测试**

必测：
1. `findByStudent` 断言 SQL 含四列、返回对象含两个新字段。
2. `update({ alertAwayMinutes: 2, alertIdleMinutes: 5 })` → SQL 的 SET 含两列、params 顺序正确。
3. `update({})` 空 patch → 返回 0、**不发 SQL**（既有行为）。
4. `findAlertThresholds` → 只 SELECT 两列、无数据回 `{ awayMinutes: 5, idleMinutes: 15 }`。
5. `ensure` 无副作用断言**保持**。

- [ ] **Step 3: 跑测试 + 类型检查 + 提交**

```bash
cd apps/server && npx vitest run src/database/repositories/controls.repo.test.ts && npx tsc --noEmit
git add apps/server/src/database/repositories/controls.repo.ts apps/server/src/database/repositories/controls.repo.test.ts
git commit -m "feat(controls): 仓储支持预警灵敏度两个阈值列"
```

---

### Task 4: 走神采集 —— 前端状态机/协议 + 服务端累计 + 阈值判定写预警

**Files:**
- Modify: `apps/web/src/analytics/types.ts`、`sessionMachine.ts`、`tracker.ts`
- Modify: `apps/web/src/analytics/sessionMachine.test.ts`、`tracker.test.ts`
- Modify: **`apps/web/src/services/api.ts`**（`heartbeatStudySession` 加第 4 个参数 `reason` —— 漏了它 `reason` 到不了 wire、功能静默失效，2026-09-20 实施时补上）
- Modify: `apps/server/src/modules/analytics/analytics.controller.ts`、`study-sessions.service.ts`、`analytics.module.ts`
- Modify: `apps/server/src/database/repositories/study-sessions.repo.ts` + `.test.ts`
- Modify: `apps/server/src/modules/analytics/study-sessions.service.test.ts`

**Interfaces:**
- `HiddenReason = 'away' | 'idle'`（前端 `analytics/types.ts` 新增，**唯一声明**，`services/api.ts` 从这导入）
- `SessionEffects.heartbeat: { state: ClientState; reason: HiddenReason | null } | null`（`reason` 仅 `state==='hidden'` 时有意义）
- `StudySessionsRepository.heartbeat(sessionUid, studentId, state, subjectId, reason: HiddenReason | null)`
- `StudySessionsRepository.end(...)` **返回值同样追加** `hiddenSince` / `hiddenReason`（`end` 路径也要判阈值，brief 原文只写了 heartbeat 的变更，2026-09-20 实施时补上）
- `StudySessionsService.heartbeat(input: { studentId; sessionUid; state; subjectId?; reason? })`

**⚠️ 本任务最高风险点：SET 列顺序**

`study-sessions.repo.ts:101-123` 的注释说明「MySQL 单表 SET 从左到右求值、后面读到的是新值」。本任务要在**保持既有顺序**的前提下插入新表达式。目标顺序：

```
SET hidden_away_seconds = hidden_away_seconds
      + IF(client_state = 'hidden' AND hidden_reason = 'away',
           GREATEST(0, LEAST(TIMESTAMPDIFF(SECOND, last_heartbeat_at, NOW(3)), 45)), 0),
    hidden_idle_seconds = hidden_idle_seconds
      + IF(client_state = 'hidden' AND hidden_reason = 'idle',
           GREATEST(0, LEAST(TIMESTAMPDIFF(SECOND, last_heartbeat_at, NOW(3)), 45)), 0),
    active_seconds = active_seconds
      + IF(client_state = 'visible',
           GREATEST(0, LEAST(TIMESTAMPDIFF(SECOND, last_heartbeat_at, NOW(3)), 45)), 0),
    client_state = ?,
    hidden_reason = ?,
    hidden_since = IF(? = 'hidden', COALESCE(hidden_since, NOW(3)), NULL),
    subject_id = COALESCE(subject_id, ?),
    heartbeat_count = heartbeat_count + 1,
    last_heartbeat_at = NOW(3)
```

**⚠️ 差值的基点必须是 `last_heartbeat_at`，不是 `hidden_since`**（2026-09-20 实施时踩到）：三个累计列都是「**距上次心跳**的增量、单次封顶 45s」，与既有 `active_seconds` 完全同源。若改用 `hidden_since` 作基点，挂机段内每 30 秒的心跳都会按「距本段起点」重算并加满 45s → **系统性偏大 ~1.6×**（实测 45 → 90 → 135）。`hidden_since` 的用途是**另一个**：给服务层判「这一段连续挂机多久了」用（阈值判定），**不参与秒数累加**。

**为什么两个累计列必须排在 `client_state` / `hidden_reason` 之前**：它们要读**本次上报前**的 `client_state` 与 `hidden_reason`。一旦排到后面，读到的就是本次刚写的新值 → 静默算错（既有 `active_seconds` 的坑同源）。`hidden_since` 的赋值本身不参与任何 IF 求值，但**保持它排在累计列之后**，让「哪条表达式读旧值」一眼可辨。

**参数数组（逐位对应，共 6 个）**：`[state, reason, state, subjectId, sessionUid, studentId]`
- `client_state = ?` ← `state`
- `hidden_reason = ?` ← `reason`（**visible 时传 `null`**，即 `state === 'hidden' ? reason : null`）
- `hidden_since = IF(? = 'hidden', ...)` ← `state`（同一个值第二次出现）
- `subject_id = COALESCE(subject_id, ?)` ← `subjectId`
- WHERE 的 `session_uid = ?` / `student_id = ?` ← 后两个

> ⚠️ 实施时**先写 SQL 再数占位符**：SET 里 4 个 `?` + WHERE 2 个 = 6 个，与上面 6 个参数**逐位**核对。**不要凭记忆**（`state` 出现两次，最容易漏）。

- [ ] **Step 1: 前端类型与状态机**

`analytics/types.ts` 加：

```ts
/**
 * 挂机原因（spec §3.3）。**唯一声明**：服务端 `HeartbeatSchema` 的 `reason` 枚举、
 * 前端 tracker 上报都从这里取——改这里必须同时改后端。
 * `away` = 页面被切走（visibilitychange）；`idle` = 前台无操作（120s 无输入）。
 */
export type HiddenReason = 'away' | 'idle';
```

`sessionMachine.ts` 把 `SessionEffects.heartbeat` 从 `ClientState | null` 改为：

```ts
  /** 要发一次心跳（`null` = 不发）。`reason` 仅在 `state === 'hidden'` 时有意义。 */
  heartbeat: { state: ClientState; reason: HiddenReason | null } | null;
```

四处产出点：
- `active + IDLE_TIMEOUT` → `{ state: 'hidden', reason: 'idle' }`
- `active + HIDDEN` → `{ state: 'hidden', reason: 'away' }`
- `hidden + VISIBLE` → `{ state: 'visible', reason: null }`
- `idle/ended + ROUTE_ENTER` → `{ state: 'visible', reason: null }`

**`hidden` 状态对后续事件的处理不变**（`HIDDEN` / `IDLE_TIMEOUT` 仍是空操作）——spec §9 已记录副作用：先 idle 后切走时该段仍记为 `idle`。

- [ ] **Step 2: 前端 tracker**

- `sendHeartbeat(next: { state, reason })` → `transport.heartbeat(uid, next.state, subjectIdProvider(), next.reason)`
- `StudySessionTransport.heartbeat` 签名加第 4 个参数 `reason: HiddenReason | null`
- `armTimers` 的 30s 周期心跳：`sendHeartbeat({ state: state === 'active' ? 'visible' : 'hidden', reason: state === 'hidden' ? /* 上一次已知的 reason */ : null })`

> 周期心跳没有新事件可喂状态机，所以**需要一个模块级变量记住「当前挂机段的原因」**（`currentHiddenReason`），在 `runTransition` 收到 `effects.heartbeat` 时同步更新，`resetLocalState()` 里清空。**别**在 tick 里重新推断。

- [ ] **Step 3: 前端测试**

- `sessionMachine.test.ts`：四条产出点的 `heartbeat` 形状改断言（`toEqual` 的对象形状变了 → 必红，改它）；`NO_FX` 常量同步。
- `tracker.test.ts`：`makeTransport` 的 `heartbeat` mock 加第 4 参数；凡 `toEqual([uid, 'visible', 7])` 的用例改为 `toEqual([uid, 'visible', 7, null])`；`hidden` 的用例改为 `toEqual([uid, 'hidden', 7, 'idle'])` / `'away'`（按触发路径）。**新增**：① `IDLE_TIMEOUT` 触发的心跳 `reason='idle'`；② `setVisibility(false)` 触发的心跳 `reason='away'`；③ 回到 visible 后 `reason=null`。

- [ ] **Step 4: 服务端协议与透传**

- `analytics.controller.ts` 的 `HeartbeatSchema`（:34-37）加 `reason: z.enum(['away', 'idle']).optional()`（**可选**是为兼容旧客户端；spec §3.3）。
- `study-sessions.service.ts` 的 `heartbeat` 入参加 `reason?: string`；**缺失**归一为 `null`（同 `subjectId` 的处理）。⚠️ **非法值到不了 service**：HTTP 路径上 `HeartbeatSchema.reason` 是 `z.enum(['away','idle']).optional()`，非法值在 controller 层就 400/1001（service 的宽容只服务非 HTTP 调用方）。
- **⚠️ `reason` 必须在 service 侧再归一一次**：`state === 'hidden' ? pick(HIDDEN_REASONS, input.reason) : null`。`repo.heartbeat` 是薄 SQL 层、不做归一，手搓 `{"state":"visible","reason":"away"}`（Zod 合法）会落成 `client_state='visible'` + `hidden_reason='away'` 的坏组合，违反 `study_sessions.hidden_reason` 的列不变量（spec §3.3「回到 visible 时置 NULL」）。**2026-09-20 实施时漏了这层归一，评审 M-2 指出后补上。**
- `study-sessions.service.ts` 在心跳与结束两条路径上做**阈值判定**（spec §3.3「判定时机两处，缺一不可」）：
  - 条件：`client_state==='hidden'` 且 `TIMESTAMPDIFF(SECOND, hidden_since, NOW(3)) >= 对应阈值`
  - 阈值来自 `ControlsRepository.findAlertThresholds(studentId)`
  - 命中 → `void this.safetyAlerts.record({ studentId, dialogueId: null, type: reason, level: 'info', message: this.safetyAlerts.messageFor(reason, minutes), context: this.safetyAlerts.awayContext(reason, minutes) })`
  - **`end` 路径也要判**：覆盖「学生最小化后直接关掉页面」（`pagehide` 触发 end，之后不再有心跳）。
  - **⚠️ 判定方法（`maybeRecordHiddenAlert`）的调用点一律 `void`、不得 `await`**（2026-09-20 实施时写成 `await`，评审 I-1 指出）。理由见上面 Global Constraints 的「预警写入永不阻断主链路」：它内部 `await findAlertThresholds`（一次 DB 往返），学生 hidden 时每 30 秒的心跳都会多等这一次往返；前端 fire-and-forget，用户无感、日志看不出。`void` 安全的前提是该方法**永不 reject**（整段 try/catch 含 `await` 的拒绝）——**先确认这一点再改**，并在 docstring 里写明「调用方一律 `void`、不得 `await`」防止后人「顺手 await 一下好测试」改回去。测试侧对应改用 `await vi.waitFor(() => expect(safety.record).toHaveBeenCalledWith(...))`，**不要**只删 `await` 留同步断言（会在写入前跑，恒假/不稳定）。
- `analytics.module.ts`：import `SafetyAlertsModule`；providers 加 `ControlsRepository`；`StudySessionsService` 构造函数注入 `SafetyAlertsService` 与 `ControlsRepository`。

- [ ] **Step 5: 服务端仓储**

按上面「目标顺序」改写 `heartbeat`，并让 `end` 也在置 `status='ended'` 前累加最后一段挂机秒数（同一 SET 顺序规则）。

`heartbeat` 需要回读 `hidden_*` 与 `hidden_since` 供 service 判定 → 让 `heartbeat` 返回：

```ts
  Promise<{ activeSeconds: number; hiddenSince: Date | null; hiddenReason: string | null } | null>
```

（既有调用方只读 `activeSeconds`，加字段是向后兼容的；但 **`study-sessions.service.test.ts` 与 controller 的返回形状断言要同步**。）

- [ ] **Step 6: 服务端测试**

- `study-sessions.repo.test.ts`：**顺序钉子用例必须同步**（params 位置变了 → 会红，这是好事）；新增：`away` 只累加 `hidden_away_seconds`、`idle` 只累加 `hidden_idle_seconds`、`hidden_since` 建立与回到 visible 清空、`hidden_reason` 维护。
  - **⚠️ 映射必须按列名配对断言，不许只断言参数数组字面量**（Global Constraints 的「仓储测试」条 + 2026-09-22 的 `goals` 事故）。本语句是最容易错的一类：`state` 出现两次、占位符还藏在 `IF(...)` / `COALESCE(...)` **内部**。做法：写一个 `zipSet(sql, params)`——**按顶层逗号切分 SET 赋值子句（算括号深度，别在 `IF(...)` 内部的逗号上切）→ 取子句首部列名 → 把子句内的 `?` 依序归到该列名下**——断言 `{ client_state: 'hidden', hidden_reason: 'away', hidden_since: 'hidden', subject_id: 2 }`，再用 `restAfterSet` 断言 WHERE 的两项 `['uid-1', 9]`。⚠️ **不能照抄 `controls.repo.test.ts` 的 `zipSet`**（它用 `(\w+)\s*=\s*\?` 只认「列 = ?」，会漏掉 `IF(...)`/`COALESCE(...)` 里的两列，而它们恰恰是最容易写反的一对）。`end` 同理：`zipSet` = `{ end_reason }`、`restAfterSet` = `['uid-1', 9]`。
  - **⚠️ 「`IF` ↔ 列」要就近断言**：把 `hidden_away_seconds` 的赋值子句单独取出，断言其内含 `hidden_reason = 'away'`；`hidden_idle_seconds` 的子句内含 `'idle'`。只断言整条 SQL 里同时出现 `'away'` 与 `'idle'` 拦不住两条 `IF` 对调（对调后两个字符串都还在，只是挂错列 → 两口径互换）。
  - **⚠️ 别留「断言自己传进去的实参」的恒真断言**（如 `expect(params[1]).toBe('idle')`、`expect(params[2]).toBe('hidden')`）——把 SQL 里对应那段删掉仍全绿。改成语义断言（按列名配对 / 就近断言子句内容）。
  - **⚠️ 用变异验证断言非空转**：把「`hidden_since` 与 `subject_id` 子句对调」「两条累计列的 `IF` 守卫对调」各做一次，确认新断言**必红**再还原。2026-09-20 首次实施时这两类对调能让全部旧断言**全绿**（评审 I-2 逐条推演，修复时实跑确认）。
- `study-sessions.service.test.ts`：新增：阈值命中写预警（`type='away'`/`'idle'`、`level='info'`）；未命中不写；`findAlertThresholds` 的分钟数真的生效（改小阈值 → 更早报）；`end` 路径也判；`state='visible'` + `reason='away'` → 落库 `hidden_reason` 为 `null`（M-2 的归一）。
  - 因为判定是 `void` 出去的：命中写入的断言用 `await vi.waitFor(...)`；「未达阈值不写」要先 `await flushAsync()`（让出一个宏任务）**再断言「没写」**，否则是恒真。
  - **「预警写入失败不阻断心跳」这条用例必须保持有意义**：`void` 之后「心跳仍返回 200」由构造保证、不再是被测行为。断言重心移到真正还在被测的三件事：① 心跳响应本身正常；② 失败被 `logger.warn` 吞掉；③ **`void` 出去的那个 promise 没有逃逸成 unhandled rejection**（`void` 引入的新风险，用 run 级 `process.on('unhandledRejection')` 探针钉住——这是唯一能观测到它的方式）。再加一条「判定被挂住时心跳仍立刻返回、放行后才写预警」的用例，直接钉「心跳路径不 `await` 判定」这条硬约束。

- [ ] **Step 7: 跑测试 + 类型检查（两端）**

```bash
cd apps/server && npx vitest run src/modules/analytics src/database/repositories/study-sessions.repo.test.ts && npx tsc --noEmit
cd apps/web && npx vitest run src/analytics && npx tsc -b
```

Expected: 全绿；`tsc` 无输出。**若顺序钉子用例变红且不是「参数位置」原因** → 说明 SET 顺序被改错，回去对齐注释。

- [ ] **Step 8: 提交**

```bash
git add apps/web/src/analytics apps/server/src/modules/analytics \
        apps/server/src/database/repositories/study-sessions.repo.ts \
        apps/server/src/database/repositories/study-sessions.repo.test.ts
git commit -m "feat(analytics): 走神分 away/idle 两口径累计 + 阈值处写预警"
```

---

### Task 5: ai-core —— 删 off_topic 硬阻断 + 标记剥离 + `safety_flag` + 两条预警写入

**Files:**
- Modify: `apps/server/src/ai-core/infra/safety-guard.ts`
- Modify: `apps/server/src/ai-core/capabilities/tutoring.capability.ts` + `.test.ts`
- Modify: `apps/server/src/ai-core/types.ts`（`SaveMessageEntry` 加 `safetyFlag?`）
- Modify: `apps/server/src/services/conversation/index.ts:152`
- Modify: `apps/server/src/modules/conversations/conversations.service.ts:207`
- Modify: `apps/server/src/modules/ai/ai.module.ts`
- Modify: `apps/server/src/ai-core/infra/safety-guard.test.ts`、`apps/server/src/ai-core/__tests__/safety-classification.ts`
- Modify: `apps/web/src/pages/parent/ParentChatLogsPage.tsx` + `.test.tsx`、`apps/web/src/services/api.ts`（`:2338` 注释）—— 见 Step 3 的文案口径

**Interfaces:**
- `TutoringCapabilityDeps` 加 `safetyAlerts?: SafetyAlertSink`（**接口类型放这里是安全的**：`TutoringCapability` 不是 `@Injectable()`，走 `useFactory` + `new`，不会发 `design:paramtypes`）
- `SafetyAlertSink.record(input): void`（同步、永不抛——由 `SafetyAlertsService.record` 结构性地满足）
- `parseContent` 返回加 `offTopic: boolean`

**三条口径**
1. **闲聊不硬拦**（spec §3.1 / 裁决 4）：`safety-guard.ts` 的 off_topic 分支改为 `shouldBlock: false`、**不带 `alertPayload`**；**删掉辅线豁免段**（:65-72，已无豁免对象）。anomaly 分支**原样保留**（继续 `shouldBlock` + `blockResponse`）。
2. **`countConsecutiveOffTopic` 与 `safetyConfig.safety.off_topic.*` 保留但不再被 `check()` 调用**（spec §9，含其单测）。
3. **⚠️ 必须同时回写 `ai_messages.safety_flag`**（spec §3.2）：闲聊不再产生 `block` 消息 ⇒ 若不回写，家长端「对话回放」的闲聊标签与计数会**全部归零**。

- [ ] **Step 1: `safety-guard.ts`**

删掉 :65-72 的辅线豁免，把 :83-106 的 off_topic 分支替换为：

```ts
    // 2026-09-20：闲聊**不再硬阻断**（spec §3.1）。关键词分类器对语文/英语理解题误判率
    // 过高（实测 6/12，spec §2.1），拿它当门禁会把正常学习提问拒掉。改由模型自报标记
    // （spec §3.2）判定并写入预警 —— 这里只如实报告「与学习无关」，不拦、不报警。
    // 辅线豁免段随之删除：既然两条轨都不拦，就没有「豁免」这回事了。
    if (classification.classification === 'off_topic') {
      return {
        isLearningRelated: false,
        classification: 'off_topic',
        alertLevel: 'none',
        shouldBlock: false,
      };
    }
```

anomaly 分支（:108-125）**不动**（继续阻断 + `alertPayload`）。

- [ ] **Step 2: `tutoring.capability.ts`**

**(a)** `TutoringCapabilityDeps` 加 sink：

```ts
/**
 * 预警类型（写入 `safety_alerts.type`）。比 spec §3.1 的三类多一个 `abusive`：
 * `SafetyGuard.detectAnomalyType` 的返回类型是 `AnomalyType`（含 `abusive`），
 * anomaly 分支把 `alertPayload.type` 原样透传到这里，不收窄就无法通过 `tsc`；
 * `SafetyAlertsService.messageFor('abusive')` 也已覆盖（→ 敏感文案），与
 * `pickGentleBlockMessage` 的 abusive→sensitive 约定同源。运行时不可达（检测器不发它）。
 */
export type SafetyAlertSignalType = 'off_topic' | 'emotional' | 'sensitive' | 'abusive';

/**
 * 预警写入的抽象（spec §3.1）。实现在 `modules/safety/SafetyAlertsService`，
 * 由 `ai.module.ts` 的 factory 注入 —— ai-core 不依赖 Nest/DB。
 * **约定：`record` 同步返回且永不抛**（实现方负责吞错）。
 */
export interface SafetyAlertSink {
  record(input: {
    studentId: number;
    dialogueId: number | null;
    type: SafetyAlertSignalType;
    level: 'info' | 'warning' | 'critical';
    message: string;
    context: string | null;
  }): void;
}

export interface TutoringCapabilityDeps {
  modelClient?: ModelClient;
  safetyAlerts?: SafetyAlertSink;
}
```

> **⚠️ union 抽成 `SafetyAlertSignalType` 别名（勿写回内联字面量）**：该 union 在 `SafetyAlertSink.record`、
> `recordSafetySignals`、`PARENT_MESSAGE` 三处出现，抽别名才能保证键集一致（`PARENT_MESSAGE` 是
> `Record<SafetyAlertSignalType, string>`，漏一个键 `tsc` 就报）。理由见下条。

> **⚠️ union 必须含 `'abusive'`**（Task 5 实现时踩过）：`SafetyGuard.detectAnomalyType` 的返回类型是
> `AnomalyType = 'emotional' | 'sensitive' | 'abusive'`，anomaly 分支把 `alertPayload.type` **原样透传**
> 到 sink，不收窄就过不了 `tsc`。`SafetyAlertsService.messageFor('abusive')` 已覆盖（→ 敏感文案），与
> `pickGentleBlockMessage` 的 abusive→sensitive 约定同源。**运行时不可达** —— `detectAnomalyType`
> 只可能返回 `'emotional'`/`'sensitive'`，从不返回 `abusive`。
> 同理 `SafetyAlert.level` 的类型是更宽的 `AlertLevel`（含 `'none'`），而 sink 只收 `'info' | 'warning' | 'critical'`；
> 调用点用 `alert.level === 'critical' ? 'critical' : 'warning'` 收窄。**收窄是安全的**：anomaly 分支的
> `alertLevel` 与 `alertPayload.level` 是**同一个三目表达式**（`safety-guard.ts:90` 与 `:95`），取值恒为
> `'warning' | 'critical'`，收窄对这两个值恒等（只有 `SafetyAlert.level` 更宽才需要收窄）。

构造函数存 `this.safetyAlerts = deps?.safetyAlerts`。

**(b)** `parseContent` 剥离标记：

```ts
/**
 * 模型自报的闲聊标记（spec §3.2）：HTML 注释形式（学生端渲染不可见）。
 * - **检测**只认「最后一个非空行、且该行只有标记」（不带 `m`/`g`，逐行全等判断）。
 * - **剥离**删掉所有**独占一行**的标记（不管在第几行）；夹在句子中间的不匹配、保持原样。
 */
const OFF_TOPIC_MARKER_LINE = /^[ \t]*<!--\s*topic:off\s*-->[ \t]*$/;
/**
 * 全局剥离：只删**独占一行**的标记，连同其**前导**换行；后随换行由 `(?=\r?\n|$)` 保留，
 * 以维持正文行结构（`第一段\n<!--M-->\n第二段` → `第一段\n第二段`）。
 *
 * ⚠️ `\r?` **不是可删的多余代码**：检测走 `trimEnd()`（`\r` 属空白，故能识别 CRLF 的末行），
 * 剥离若只认 `\n` 就会与检测**口径不对称** —— 模型若用 CRLF 换行，末行标记会「判了闲聊却
 * 剥不掉」，标记残留进学生可见内容与持久化历史，违反 spec §3.2 的核心要求。
 */
const OFF_TOPIC_MARKER_STRIP = /(?:^|\r?\n)[ \t]*<!--\s*topic:off\s*-->[ \t]*(?=\r?\n|$)/g;

/** 标记是否落在「最后一个非空行」且独占该行（spec §3.2）。 */
function isOffTopicMarkerOnLastLine(content: string): boolean {
  const trimmed = content.trimEnd();
  return OFF_TOPIC_MARKER_LINE.test(trimmed.slice(trimmed.lastIndexOf('\n') + 1));
}

  private parseContent(rawContent: string): {
    content: string;
    structuredQuestion?: StructuredQuestionOutput;
    offTopic: boolean;
  } {
    const parsed = this.responseParser.parse({ rawContent, mode: 'text' });
    let content = parsed.rawText ?? rawContent;

    // 先剥标记（它比 JSON 块更靠后，且闲聊轮次不会有 JSON 块）。
    // 检测：只认「最后一个非空行独占」（spec §3.2）—— 位置不合法（中段/内联）不判闲聊。
    // 剥离：凡是**独占一行**的标记都删掉（不管在第几行），标记永不进学生可见内容与历史。
    const offTopic = isOffTopicMarkerOnLastLine(content);
    const stripped = content.replace(OFF_TOPIC_MARKER_STRIP, '');
    if (stripped !== content) {
      content = stripped.replace(/\n{3,}/g, '\n\n').trim();
    }

    let structuredQuestion: StructuredQuestionOutput | undefined;
    const jsonBlock = this.responseParser.extractJsonBlock(content);
    if (jsonBlock) {
      const result = StructuredQuestionOutputSchema.safeParse(jsonBlock);
      if (result.success) {
        structuredQuestion = result.data;
        content = this.responseParser.stripJsonBlock(content);
      }
    }
    return { content, structuredQuestion, offTopic };
  }
```

**(c)** `recordSafetySignals`（私有，**唯一写预警入口**）：

```ts
  /**
   * 写一条预警。**整段 try/catch + 同步调用**（spec §6 不变量：预警写入永不阻断主链路）。
   * `tutor` / `tutorStream` / `prepare` 三处共用这**唯一**入口，别各写一份。
   */
  private recordSafetySignals(input: {
    studentId: string;
    dialogueId: string;
    type: SafetyAlertSignalType;
    level: 'info' | 'warning' | 'critical';
    studentMessage: string;
  }): void {
    const sink = this.safetyAlerts;
    if (!sink) return;                       // 未接线（测试/脚本）→ 静默跳过
    try {
      const studentId = Number(input.studentId);
      if (!Number.isFinite(studentId)) return;
      const dialogueId = Number(input.dialogueId);
      sink.record({
        studentId,
        dialogueId: Number.isFinite(dialogueId) ? dialogueId : null,
        type: input.type,
        level: input.level,
        message: PARENT_MESSAGE[input.type],
        context: input.studentMessage.slice(0, 200),
      });
    } catch (err) {
      // sink 本身永不抛；这里是双保险
      console.warn('[tutoring] 预警写入失败（已忽略）:', err instanceof Error ? err.message : err);
    }
  }
```

其中 `PARENT_MESSAGE` 是与 `SafetyAlertsService.messageFor` **逐字一致**的常量表（spec §3.4）。⚠️ **两份文案会漂移** → 加一条测试断言两边一致（在 `tutoring.capability.test.ts` 里对 `off_topic`/`emotional`/`sensitive` 三条逐字比对 `SafetyAlertsService.messageFor`）。

**(d)** 三个调用点（同一入口，别各写一份）：

- `tutor()`：`const { content, structuredQuestion, offTopic } = this.parseContent(...)`；`saveMessages` 的 assistant 条目加 `safetyFlag: offTopic`；随后 `if (offTopic) this.recordSafetySignals({ ... })`。
- `tutorStream()`：同（`:197` 之后），并在 `yield { type:'done', ... }` 之前调。
- `prepare()`：在 anomaly 的 `shouldBlock` 分支里、`saveMessages` **之后**调 `recordSafetySignals`。**取 `type`/`level` 时消费 `safetyResult.alertPayload`**（`alertPayload.type` / `alertPayload.level`）—— **这是 `alertPayload` 第一次被真正消费**（spec §2.2；brief 也硬要求「真的把它用起来，而不是另起一套」）。
  > 原 plan 这一句自相矛盾：既说「`type` 取 `safetyResult.anomalyType`、`level` 取 `safetyResult.alertLevel`」，又说「`alertPayload` 第一次被消费」。**两者逐值等价** —— `alertPayload.type === anomalyType`、`alertPayload.level === alertLevel`（同一三目表达式，`safety-guard.ts:83-99`），所以**行为中性**；但只有取 `alertPayload` 才满足 spec §2.2 的「消费」意图。实现选择消费 `alertPayload`，并由变异证明（把 `alertPayload.type` 改成与派生值不同的值 → 用例 RED）。

- [ ] **Step 3: `safety_flag` 回写 + 家长端文案口径（用户 2026-09-20 裁决）**

**取值规则（两处写同一表达式，保持一致）**：

```
safety_flag = Number(msg.safetyFlag ?? (msg.type === 'block' ? 1 : 0))
```

> **⚠️ 外层 `Number(...)` 必需，别当多余代码删掉**（Task 5 实现时踩过）：
> `safetyFlag` 是 `boolean`，`??` 会**原样返回它**（`true` 而非 `1`），而 `safety_alerts` /
> `ai_messages.safety_flag` 的列类型是 INT。**`tsc` 不报这个错** —— `AiMessageRow extends
> RowDataPacket` 带 `[column: string]: any` 索引签名（`types.ts:26`），而 `createMany` 的入参是
> `Omit<AiMessageRow, …>`；`Omit` 用 `keyof`（被索引签名撑成 `string | number`）把具名属性
> **全部抹成 `any`**，于是类型检查不再约束 `safety_flag`。评审已用最小探针复现：带索引签名无错、
> 去掉索引签名立刻 `TS2322: Type 'boolean' is not assignable to type 'number'`。
> 不加 `Number(...)` 的后果：单测断言 `= 1` 直接红，且真库里靠 mysql2 转义把 `true` 写进 INT 列。
> （两处**不是逐字相同**而是**语义等价**：`services/conversation/index.ts` 有 `msg` 对象，
> `modules/conversations/conversations.service.ts` 是位置参数、没有 `msg`——Step 2(d) 的 `prepare()` 条目
> 也处理过同类「两处语义等价、但非逐字相同」的判断，别把这种不一致当 bug。）

**⚠️ 删掉 off_topic 硬阻断后，`safety_flag = 1` 有 两个来源**（不是 spec §9 措辞里说的单一来源）：

1. 模型自报标记 `offTopic === true`（闲聊）；
2. `type === 'block'`（**现在只剩 anomaly**：情绪 / 敏感被阻断）。

**用户裁决（2026-09-20）**：**两类都计入**，并把家长端文案从「闲聊」改成「偏离学习」（两类都是「偏离学习」，原文案会把情绪/敏感轮次误标成闲聊）。逐处改：

| 文件:行 | 现在 | 改成 |
|---|---|---|
| `ParentChatLogsPage.tsx:410` | `{`闲聊 ${item.blockCount}`}` | `{`偏离学习 ${item.blockCount}`}` |
| `ParentChatLogsPage.tsx:66` | `<Tag variant="hard">闲聊/偏离学习</Tag>` | `<Tag variant="hard">偏离学习</Tag>` |
| `ParentChatLogsPage.tsx:58` | 注释「闲聊/偏离学习：红色边框…」 | 注释说明两个来源（标记 / anomaly 阻断） |
| `services/api.ts:2338` | 注释「该会话里 `safety_flag = 1` 的消息数（闲聊/偏离学习）」 | 注释说明两个来源 |
| `ParentChatLogsPage.test.tsx:127` | 断言 `'闲聊/偏离学习'` | 断言 `'偏离学习'`（**测试同步，不是放宽断言**） |

**另**：`ai-core/types.ts` 的 `SaveMessageEntry`（:610-623）加 `safetyFlag?: boolean;`（注释说明语义变更：从「被硬阻断的轮次」→「被模型判为闲聊 **或** 被阻断的轮次」）。
`services/conversation/index.ts:152` 与 `modules/conversations/conversations.service.ts:207` 都改成上面那个表达式。

- [ ] **Step 4: 模块接线**

`ai.module.ts`：import `SafetyAlertsModule`；factory 改为

```ts
    {
      provide: TutoringCapability,
      useFactory: (conversationService: ConversationService, safetyAlerts: SafetyAlertsService) =>
        new TutoringCapability(conversationService, { safetyAlerts }),
      inject: [ConversationService, SafetyAlertsService],
    },
```

- [ ] **Step 5: 测试改写 + 新增**

- `safety-guard.test.ts`：该文件**原本就没有** `check()`/`shouldBlock` 断言（plan 原写「删」是错的，无可删 —— GAP-1）→ 改为**新增**三条 `check()` 用例：① 主线 off_topic 不再阻断；② **辅线 off_topic 同样走统一的 off_topic 分支**（⚠️ 断言必须能区分两个分支：`classification === 'off_topic'` **且** `isLearningRelated === false`；**不能只断言 `shouldBlock === false`** —— 被删的旧辅线豁免段返回体也是 `shouldBlock: false`，只断言它则把豁免段注入回去仍全绿，是**假钉**，钉不住 spec §3.1 的「删掉辅线豁免段」）；③ anomaly 仍阻断 + `alertPayload`。
- `__tests__/safety-classification.ts`：off_topic 用例（:47-56）改为断言「不再判 shouldBlock」（注释说明原因）。
- `tutoring.capability.test.ts`：新增 ① 标记被识别并从 `content` 剥离；② 标记**不进历史**（`saveMessages` 收到的 assistant content 不含标记）；③ 无标记时不写预警；④ **两条入口（`tutor` / `tutorStream`）都覆盖**；⑤ `safetyFlag` 正确回写（`offTopic` → `true`）；⑥ anomaly 轮次也写预警且 `level='critical'`（sensitive）；⑦ 文案表与 `SafetyAlertsService.messageFor` 逐字一致。
  另补（F4/F5 位置与剥离边界的钉子）：④c 标记独占**最后一个非空行** → 判闲聊 + 内容不含标记；④d 标记独占一行但在**正文中段** → **不**判闲聊（本次收紧的钉子）；④e 标记**夹在句子中间** → **不**判闲聊；⑤c 模型写了两遍标记 → 两处都不残留（全局替换承重）；⑤d 标记在第一行 → content 不以换行开头。
- `services/conversation` 与 `modules/conversations` 的既有测试：新增「`safetyFlag` 显式传入时优先于 `type==='block'` 推导；未传时行为不变」。**再补一条**：`safetyFlag=true`（闲聊，`type='socratic'`）与 `type='block'`（anomaly）**都**落成 `safety_flag = 1`（两类口径）。
- `ParentChatLogsPage.test.tsx`：`:127` 的断言改 `'偏离学习'`；新增「计数文案是『偏离学习 N』、不含『闲聊』」（钉住本次文案口径变更）。

- [ ] **Step 6: 跑测试 + 类型检查 + 重新跑标记验证门**

```bash
cd apps/server && npx vitest run src/ai-core src/services/conversation src/modules/conversations && npx tsc --noEmit
npx tsx src/ai-core/__tests__/off-topic-marker.ts   # 期望 3/3（观测点已前移，见下方说明）
cd ../web && npx vitest run src/pages/parent/ParentChatLogsPage.test.tsx && npx tsc -b
```

> **⚠️ 不能「原样重跑」这条门 —— 观测点必须前移**（Task 5 实现时踩过）：旧门的唯一观测点是
> `result.message.content` 里有没有标记，而 **Task 5 Step 2 的 `parseContent` 正是要把标记从这里剥掉**
> —— 二者互斥，原样重跑**必然 2/3**，而且脚本会打印**误导性的**「方案 A 不通过，需切方案 B（并行 LLM 分类器）」。
> 所以 `off-topic-marker.ts` 已改为从**标记的唯一下游消费者**观测：注入一个**假 sink**，断言
> sample③ 真的写出一条 `off_topic` 预警（sample①② 不写），并**新增**「标记不残留于学生端内容」断言
> （旧门没有这条）。这是**更强**的验证（信号真的产生 + 内容真的干净），不是放宽。
> 另：脚本的 `studentId` 从 `'test_student'` 改为 `'1'` —— `recordSafetySignals` 对非有限数**静默 return**
> （`Number('test_student') = NaN`），不改则门永远收不到信号。生产路径不会踩这个坑（JWT `sub` 是数字）。
> ⚠️ 该文件**不在本 Task 的 Files 清单里**，但在 `git add apps/server/src/ai-core` 的路径范围内；
> 不改它则本 Step 永久 2/3 且输出误导结论。

- [ ] **Step 7: 提交**

```bash
git add apps/server/src/ai-core apps/server/src/services/conversation \
        apps/server/src/modules/conversations apps/server/src/modules/ai/ai.module.ts \
        apps/web/src/pages/parent/ParentChatLogsPage.tsx \
        apps/web/src/pages/parent/ParentChatLogsPage.test.tsx apps/web/src/services/api.ts
git commit -m "feat(ai-core): 闲聊改模型自报标记（不硬拦）+ safety_flag 双来源 + 家长端文案改「偏离学习」"
```

---

### Task 6: 家长端后端 —— controls / alerts / account / password 端点 + `unreadAlerts` 真查

**Files:**
- Create: `apps/server/src/modules/parent-insights/controls.service.ts` + `.test.ts`
- Create: `apps/server/src/modules/parent-insights/alerts.service.ts` + `.test.ts`
- Modify: `apps/server/src/modules/parent-insights/parent-insights.controller.ts` + `.test.ts`
- Modify: `apps/server/src/modules/parent-insights/parent-insights.module.ts`
- Modify: `apps/server/src/modules/parent-insights/dashboard.service.ts` + `.test.ts`
- Modify: `apps/server/src/modules/parent-insights/dto/parent-insights.dto.ts`
- Modify: `apps/server/src/database/repositories/parents.repo.ts`（加 `updatePassword`）
- Modify: `apps/server/src/modules/parent/parent.controller.ts` / `parent.service.ts` / `parent.module.ts`

> **清单订正（Fix 1，评审 §3-5）**：上面的原始清单漏了三个**实际必须改**的文件，而 Step 4（本文件 :1077-1079）又明文要求「加一个新仓储方法（如 `countUnread`）」：
> - `apps/server/src/database/repositories/safety-alerts.repo.ts` + `.test.ts` —— `countUnread(parentId, studentId?)` 的落点。Fix 1 另在此文件把 `listByParent` 的列表查询从 `pool.execute` 改成 `pool.query`（`LIMIT ?` 走预处理语句会被 MySQL 拒，端点对真库每调必 500）。
> - `apps/server/src/modules/parent/parent.service.test.ts` —— 必测 #5/#6（`getAccount` / `changePassword`）的落点；`mkSvc` 是位置参数，加第 6 个依赖时必须同步改这里。
> - `apps/server/src/database/repositories/limit-placeholder.guard.test.ts` —— Fix 1 新增的全仓形态护栏（扫 `*.repo.ts`，断言含 `LIMIT ?` 的内联 SQL 不走 `execute`）。

**Interfaces:**
- 四个端点契约见 **spec §4.1–§4.4**（校验链、错误码、返回形状**逐条照做**，不在这里重复）
- `GET /api/parent/account`、`PATCH /api/parent/password` 见 **spec §4.5–§4.6**

**端点归属（本计划定案，spec 未指定）**
- `controls` / `alerts` → `parent-insights.controller.ts`（它已是 `@Controller('api/parent')` + `@Roles('parent')`，且已有 `students/:studentId/...` 模式与 `parentService.requireOwnedStudent`）
- `account` / `password` → `parent.controller.ts`（账号级、非按学生；`ParentService` 加 `ParentsRepository`）

> ⚠️ 两个 controller 都是 `@Controller('api/parent')`，**新增路径不得与既有路径撞车**。既有路径清单见本计划「现状要点」与 `parent-insights.controller.ts:98-259` / `parent.controller.ts:37-102`。

- [ ] **Step 1: `ControlsService`（spec §4.1/§4.2）**

校验链照 spec 逐条实现：至少一个字段（409/1001）→ 范围 1..180（409/1001）。`PUT` 逻辑 `ensure` → `update` → **回读** `findByStudent` → 返回完整对象。响应形状**只含两个阈值**（`{ alertAwayMinutes, alertIdleMinutes }`）。

> **归属分层（Fix 1 订正 —— 本计划原文 Step 1/2 与 Step 3 自相矛盾，评审 §3-5）**
> **按学生的归属校验（404/1002 / 403/1005）在 controller，不在 service。** 与 `parent-points.controller.ts` 的钉子用例（「每个端点的第一件事都是 `requireOwnedStudent`」）同源，也与 `parent-insights.controller.ts` 既有 10 个 handler 一致。
> 原文把这段写在 Step 1/2 的 service 校验链里、Step 3 又写「controller 每个 handler 都先 `requireOwnedStudent`」——同一道校验两处归属，照 Step 1/2 实现会**重复查库**、错误码来源也会分叉。所以 `ControlsService` 只管「至少一个字段 + 范围 + `ensure`/`update`/回读」。
> **例外（预警归属）：`PATCH alerts/:alertId/read` 的 `alert.parent_id === parentId` 只能留在 service** —— 该端点没有 `studentId`，必须先 `findById` 拿到 `parent_id` 才判得了，controller 无从下手（见 Step 2）。

- [ ] **Step 2: `AlertsService`（spec §4.3/§4.4）**

- `list(parentId, { studentId?, unreadOnly?, page, pageSize })`：调 `alertsRepo.listByParent`；映射 DTO（`studentName` 取不到 → 前端显示「未知学生」，后端不做非空断言）。**不在 service 里做归属校验**（`studentId` 的归属由 controller 先做，见 Step 1 的分层说明）。
- `markRead(parentId, alertId)`：`alertId` 正整数（409/1001）→ `findById` 不存在（404/1002）→ `parent_id !== parentId`（403/1005）→ `markRead`（幂等）。**预警归属只能留在这里**（理由见 Step 1 的例外说明）。

- [ ] **Step 3: controller + module + DTO**

- `parent-insights.controller.ts` 加 4 个 handler（`@Get('students/:studentId/controls')`、`@Put('students/:studentId/controls')`、`@Get('alerts')`、`@Patch('alerts/:alertId/read')`）。**按学生的归属校验在 controller**：前三个（凡带 `studentId` 的）第一件事就是 `requireOwnedStudent`；`PATCH alerts/:alertId/read` 不带 `studentId`，其预警归属在 `AlertsService`（见 Step 2）。
- `GET alerts` 的 `studentId` 是**可选** query 参数：用 `parseOptionalPositiveInt`（`../points/pagination.util.js`，未传/空串 → `undefined` = 不筛选），**不要**写成 `parsePositiveInt(studentId, 'studentId', 1)` —— `1` 恰好是合法学生 id，空串会静默变成「按 1 号孩子筛选」并去校验归属（Fix 1 修的 Minor 3-3）。
- `parent-insights.module.ts`：import `SafetyAlertsModule`；providers 加 `ControlsService` / `AlertsService`（`SafetyAlertsRepository` 由 `SafetyAlertsModule` 导出）。
- `dto/parent-insights.dto.ts` 加 `ParentControls` / `ParentAlertItem` / `ParentAlertPage`，并把 `DashboardStudent.unreadAlerts` 的注释「本期恒 0」改掉。

- [ ] **Step 4: `unreadAlerts` 改真查**

`dashboard.service.ts:85,90` 改为真查（未读 = `is_read = 0` 的 `safety_alerts` 数）：顶层 = 该家长全部孩子未读；学生级 = 该孩子未读。用一个新仓储方法（`countUnread(parentId, studentId?)`）或复用 `listByParent` 的 count。**改 `dashboard.service.test.ts:179-184`** 那条「恒为 0」的用例为真查后的行为。

> ⚠️ **不要为了拿 count 而调 `listByParent`**：它带 `LIMIT ? OFFSET ?`，真库上只有走 `pool.query` 才执行得动（`pool.execute` 会报 `Incorrect arguments to mysqld_stmt_execute`；本仓铁律见 `parent-insights.repo.ts:210-211`）。这也是本计划推荐独立 `countUnread` 的原因之一 —— 仪表盘只要一个数字，不该顺手取一整页行。

- [ ] **Step 5: account / password**

- `parents.repo.ts` 加 `updatePassword(id: number, passwordHash: string): Promise<void>`（照 `admins.repo.ts:41`）。
- `parent.service.ts` 注入 `ParentsRepository`，加：
  - `getAccount(parentId)` → `findById`；不存在 → 404/1002；返回 `{ id, name, phone }`（**不含**订阅/额度/订单）
  - `changePassword(parentId, oldPassword, newPassword)` → 照 `admin-dashboard.service.ts:37-47`（新密码 6..32 → 409/1001；旧密码 bcrypt 比对失败 → 401/1003；新旧相同 → 409/1001；`bcrypt.hash(newPassword, 10)`）
- `parent.controller.ts` 加 `@Get('account')` / `@Patch('password')`（Zod schema 照 spec §4.6）。
- `parent.module.ts` providers 加 `ParentsRepository`。

- [ ] **Step 6: 测试**

必测（每条对应一个真实翻车点）：
1. `controls` PUT：空 patch → 409/1001 **且不写库**；越界 0/181 → 409/1001；合法 → 回读后返回完整对象。
2. `controls`：归属失败 → 403/1005 **不写库**（不泄漏存在性）。
3. `alerts` 列表：`studentId` 非本家长 → 403/1005；分页参数默认值；空结果 `items: []`、`total: 0`（**不是错误**）。
4. `alerts` 标记已读：不存在 → 404/1002；非本家长 → 403/1005 **且不改库**；重复标记幂等。
5. `account`：返回**只有** `id/name/phone` 三个字段（断言 `Object.keys`）。
6. `password`：旧密码错 → 401/1003；新旧相同 → 409/1001；长度越界 → 409/1001；成功 → `updatePassword` 收到 bcrypt hash（不是明文）。
7. `dashboard.unreadAlerts`：真查（造 2 条未读 → 回 2）。

- [ ] **Step 7: 跑测试 + 类型检查 + 启动冒烟**

```bash
cd apps/server && npx vitest run src/modules/parent-insights src/modules/parent && npx tsc --noEmit && npm run build
PORT=3119 node dist/main.js > /tmp/boot_pc.log 2>&1 & echo $! > /tmp/boot_pc.pid
sleep 6 && grep -E "successfully started|can't resolve" /tmp/boot_pc.log
grep -E "Mapped \{(GET|PUT|PATCH|POST) /api/parent" /tmp/boot_pc.log | sort
kill $(cat /tmp/boot_pc.pid) && rm -f /tmp/boot_pc.pid /tmp/boot_pc.log
```

Expected: 启动成功、6 条新路由 mapped（controls GET/PUT、alerts GET、alerts PATCH read、account GET、password PATCH）、无 `can't resolve`。
⚠️ **按 PID 收尾**（用户本机有自己的 `node dist/main.js` 在跑，**绝不能** `pkill`）。

- [ ] **Step 8: 提交**

```bash
git add apps/server/src/modules/parent-insights apps/server/src/modules/parent \
        apps/server/src/database/repositories/parents.repo.ts
git commit -m "feat(parent): 行为管控/预警中心/账号设置端点 + dashboard 未读预警真查"
```

---

### Task 7: 前端 —— api 层 + 真 Banner + 预警中心页 + 侧栏入口

**Files:**
- Modify: `apps/web/src/services/api.ts`
- Modify: `apps/web/src/components/layout/ParentLayout.tsx` + `.test.tsx`
- Modify: `apps/web/src/components/layout/ParentNav.tsx` + `.test.tsx`
- Create: `apps/web/src/pages/parent/ParentAlertsPage.tsx` + `.test.tsx`
- Modify: `apps/web/src/routes/routeTable.tsx`（`/parent/alerts` 换真页）

**Interfaces（api 层，全部新增）**

```ts
export interface ParentAlertItem {
  id: number; studentId: number; studentName: string | null;
  // 必须与后端 6 值一致（含 `abusive`）：后端 DTO 用的是 `SafetyAlertRow['type']`，
  // 若前端收窄成 5 值，遇到 `abusive` 行会缺分支而 tsc 不报（见 Task 6 报告 §9 硬要求）。
  type: 'off_topic' | 'emotional' | 'sensitive' | 'abusive' | 'away' | 'idle';
  level: 'info' | 'warning' | 'critical';
  message: string; context: string | null; dialogueId: number | null;
  isRead: boolean; createdAt: string;
}
export interface ParentAlertPage { items: ParentAlertItem[]; total: number; page: number; pageSize: number; }

export function getParentAlerts(params: { studentId?: number; unreadOnly?: boolean; page?: number; pageSize?: number }): Promise<ParentAlertPage>
export function markParentAlertRead(alertId: number): Promise<null>
```

- [ ] **Step 1: api 层**（上面两个 + Task 8 的三个 controls/account 函数可一并加）

- [ ] **Step 2: 真 Banner（spec §5.1 状态机）**

`ParentLayout.tsx`：删 `const hasAlert = true;` 与假文案。改为：

```
读 useParentStudentStore.studentId
├─ studentId == null          → 不渲染（不请求）
└─ studentId != null
   └─ GET /api/parent/alerts?studentId=&unreadOnly=1&pageSize=1
      ├─ 加载中 / 失败          → 不渲染（静默，不占位不抖动）
      ├─ items[0].level ∈ {warning, critical} → 渲染 Banner（标题=message，描述=「点击查看详情，建议适时介入」）
      └─ 其它（空 / 只有 info）  → 不渲染
```

- CTA **补上 `onClick` → `navigate('/parent/alerts')`**（现在是死按钮）
- 刷新时机沿用既有 `location.pathname` 依赖模式（与未读数一致）
- ⚠️ **派生状态带 `studentId` 归属**（切孩子不重挂载）：存 `{ studentId, item }`

- [ ] **Step 3: 侧栏入口**

`ParentNav.tsx` 的 `navItems` 加第 11 项「异常预警」→ `/parent/alerts`（复用 `NavIcon`，线性 SVG，无 emoji）。位置放在「AI 对话回放」之后、「目标设定」之前（监管类聚在一起）。

⚠️ `ParentNav.test.tsx` 的 `expected` 数组要同步加一项；用例标题里的「10 个入口」改成 11。

- [ ] **Step 4: 预警中心页（spec §5.2 状态机）**

四态（加载 Skeleton / 失败重试卡 / 空态 / 列表）+ 交互（只看未读筛选 → 回第 1 页并重拉；换孩子 → 回第 1 页并重拉；标记已读 → 就地更新不整页重拉；有 `dialogueId` → 「查看对话」跳 `/parent/chat-logs`）。

- 建议行动按 `type` **前端静态映射**（spec §3.4：不入库）
- 空态文案区分「暂无预警」与「当前筛选下没有预警 + 清除筛选」
- 列表默认**全部孩子**（带孩子名），支持按孩子筛选（spec §3.7）
- 家长端全程日间：**不加** `data-theme`、不用 `.student-theme-container`

- [ ] **Step 5: 路由换真页**

`routeTable.tsx:334` 的 `{ path: 'alerts', element: <Placeholder title="异常预警中心 P6.9" /> }` → `<ParentAlertsPage />`。

- [ ] **Step 6: 测试**

- `ParentLayout.test.tsx`：**改写** `:76-83` 那条「假 Banner 仍在」用例 → 三条：有 `warning`/`critical` 未读时渲染；无或只有 `info` 时不渲染；请求失败时不渲染。mock 加 `getParentAlerts`。
- `ParentNav.test.tsx`：`expected` 加「异常预警」项。
- `ParentAlertsPage.test.tsx`（新建）：四态、筛选回第 1 页、换孩子回第 1 页、标记已读就地更新、`dialogueId` 链接、多孩不串（派生状态带 `studentId`）。
- `routeTable.test.tsx`：`/parent/alerts` 渲染真页（断言无 `PLACEHOLDER_TEXT`）、侧栏「异常预警」指向 `/parent/alerts`。

- [ ] **Step 7: 跑测试 + 类型检查 + lint + build**

```bash
cd apps/web && npx vitest run src/pages/parent src/components/layout src/routes && npx tsc -b && npm run lint && npm run build
```

- [ ] **Step 8: 提交**

```bash
git add apps/web/src/services/api.ts apps/web/src/components/layout \
        apps/web/src/pages/parent/ParentAlertsPage.tsx apps/web/src/pages/parent/ParentAlertsPage.test.tsx \
        apps/web/src/routes/routeTable.tsx apps/web/src/routes/routeTable.test.tsx
git commit -m "feat(parent): 真预警 Banner + 异常预警中心页 + 侧栏入口"
```

---

### Task 8: 前端 —— 行为管控页 + 账号设置页

**Files:**
- Create: `apps/web/src/pages/parent/ParentControlsPage.tsx` + `.test.tsx`
- Create: `apps/web/src/pages/parent/ParentAccountPage.tsx` + `.test.tsx`
- Modify: `apps/web/src/routes/routeTable.tsx`（两条 Placeholder 换真页）
- Modify: `apps/web/src/routes/routeTable.test.tsx`

**Interfaces（api 层）**

```ts
export interface ParentControls { alertAwayMinutes: number; alertIdleMinutes: number; }
export function getParentControls(studentId: number): Promise<ParentControls>
export function putParentControls(studentId: number, patch: Partial<ParentControls>): Promise<ParentControls>
export interface ParentAccount { id: number; name: string; phone: string; }
export function getParentAccount(): Promise<ParentAccount>
export function changeParentPassword(oldPassword: string, newPassword: string): Promise<null>
```

- [ ] **Step 1: 行为管控页（spec §5.3 状态机）**

- 两个数据源：`GET .../controls` + `GET .../points/settings`（后者只读展示「奖励兑换」状态）
- 预设档**纯前端常量**（spec §3.6）：宽松 15/30、标准 5/15、严格 2/5 —— 点预设只填输入框，**不改服务端**
- 手动改输入 → 预设高亮消失
- 保存：本地校验 1..180 整数 → 失败不发请求；**无改动 → 按钮 disabled**（避免 P6.5 那种「零反馈」）；**只发改动字段**；成功 → `toast('success', 回显服务端返回的值)` + 重置 dirty；失败 → `toast('error', 服务端 message)`
- 奖励兑换卡片 → 「去奖励管理」链接 → `/parent/rewards`
- 数字输入用基座 `Input`（`border-2` + `focus-within` 变蓝，一眼看得出能改）
- `studentId == null` → 空态「请先选择孩子」
- **派生状态带 `studentId` 归属**

- [ ] **Step 2: 账号设置页（spec §5.4 状态机）**

- `GET /account` 加载中 Skeleton / 失败重试卡 / 就绪 → 账号信息卡（姓名、手机号**只读**）+ 修改密码卡 + 退出登录（复用 `LogoutButton`）
- 改密码：本地校验（旧密码非空、新密码 6..32、两次一致）→ 不发请求；提交 → 按钮 loading/禁用；成功 → `toast('success','密码已修改')` + 清空三个输入框；失败 → `toast('error', 服务端 message)`，**1003 时给旧密码框标错**（用 `Input` 的 `error` prop）

- [ ] **Step 3: 路由换真页**

`routeTable.tsx:332` `/parent/controls` → `ParentControlsPage`；`:335` `/parent/account` → `ParentAccountPage`。

- [ ] **Step 4: 测试**

- `ParentControlsPage.test.tsx`（新建）：预设填值；手动改 → 预设高亮消失；本地校验 0/181 → 不发请求；**无改动 → 保存 disabled**；**只发改动字段**（断言 `putParentControls` 收到的 patch 只有改过的那一个键）；toast 回显服务端值；points 失败只影响该卡片；切孩子不串。
- `ParentAccountPage.test.tsx`（新建）：信息只读（三个字段渲染、无可编辑控件）；密码三段校验（旧空 / 新 <6 / 新 >32 / 两次不一致 → 不发请求）；1003 → 旧密码框标错；成功 → 清空输入框 + toast。
- `routeTable.test.tsx`：两条新用例（渲染真页、无占位文案）。

- [ ] **Step 5: 跑测试 + 类型检查 + lint + build**

```bash
cd apps/web && npx vitest run src/pages/parent src/routes && npx tsc -b && npm run lint && npm run build
cd apps/web && TZ=UTC npx vitest run src/pages/parent src/routes   # 防挂钟依赖
```

- [ ] **Step 6: 提交**

```bash
git add apps/web/src/pages/parent/ParentControlsPage.tsx apps/web/src/pages/parent/ParentControlsPage.test.tsx \
        apps/web/src/pages/parent/ParentAccountPage.tsx apps/web/src/pages/parent/ParentAccountPage.test.tsx \
        apps/web/src/routes/routeTable.tsx apps/web/src/routes/routeTable.test.tsx \
        apps/web/src/services/api.ts
git commit -m "feat(parent): 行为管控页（预警灵敏度 + 奖励兑换只读）与账号设置页"
```

---

### Task 9: 文档同步

**Files:** 见上方「文档」表（7 个文件）

**要点**
- **两份 API 文档必须一致**（`CLAUDE.md` 硬规则）：端点清单逐条核对（6 条新端点 + 4 条转实现）。
- `Alert.type` 枚举**以代码为准**：`off_topic|emotional|sensitive|abusive|away|idle`。
- `Controls` schema **收敛为两个字段**（本批端点只读/写这两个）；`ParentAccount` **去掉不存在的** subscription/AIQuota。
- 数据库文档要写清：`ai_messages.safety_flag` 的**语义变更**（「被硬阻断的轮次」→「被模型判为闲聊 **或** 被阻断的轮次」，**两个来源**；家长端文案同步从「闲聊 N」改成「偏离学习 N」，用户 2026-09-20 裁决）；`controls` 三列「预留未用」；`study_sessions` 新四列**不参与**学习时长口径。
- API 文档的 `ParentChatLogItem.blockCount` 注释要改成「`safety_flag = 1` 的消息数（闲聊标记 **或** 被阻断）」，与 `services/api.ts:2338` 的注释一致。
- PRD / UX 的 §P6.6 / §P6.9 加批注（四项不做、侧栏补「异常预警」），**不删需求原文**。
- changelog 记 10 条裁决 + Task 0 的 3/3 结果 + `off_topic` 硬阻断被删的理由（关键词分类器 6/12 误判）。

- [ ] **Step 1: 逐处改，然后脚本核对两份 API 文档**

```bash
cd /Users/lichao/Downloads/claude/imooc/ai_k12
grep -n "parent/alerts\|parent/controls\|parent/account\|parent/password" docs/api/openapi.yaml | head -20
grep -n "parent/alerts\|parent/controls\|parent/account\|parent/password" docs/API接口与数据流设计文档.md | head -20
```

Expected: 两份文档都出现 4 个路径（`alerts/{id}/read` 另计），无遗漏。

- [ ] **Step 2: 提交**

```bash
git add docs/API接口与数据流设计文档.md docs/api/openapi.yaml \
        "docs/K12智学系统-数据库设计文档.md" "docs/UX-UI设计文档.md" \
        docs/ai-core-changelog.md CLAUDE.md "docs/家长端学情批-完成情况与待办清单.md"
git commit -m "docs: 同步家长端「管得住」批（P6.6/P6.9/P6.10 契约、新列、safety_flag 语义变更）"
```

---

### Task 10: 集成验收

**Files:** 无（只跑验证）

- [ ] **Step 1: 真库验证四条链路（事务 + ROLLBACK，不留脏数据）**

```bash
cd /Users/lichao/Downloads/claude/imooc/ai_k12
mysql -h127.0.0.1 -uai_k12 -pai_k12 ai_k12 -t -e "
START TRANSACTION;
-- ① 预警去重：同学生同 type 第二条不写（走 existsRecent 的 SQL 语义）
SELECT CONCAT('dedupe_probe=', COUNT(*)) AS r FROM safety_alerts
  WHERE student_id = 1 AND type = 'away' AND created_at >= NOW(3) - INTERVAL 30 MINUTE;
-- ② 走神两列互不串 + 差值基点是 last_heartbeat_at（不是 hidden_since）
--    造一个「last_heartbeat_at 是 30 秒前、但 hidden_since 是 10 分钟前」的行：
--    正确公式（基点 last_heartbeat_at）→ away 只加 30；错误公式（基点 hidden_since）→ 加满 45。
INSERT INTO study_sessions (student_id, session_uid, module, scene, status, client_state,
                            hidden_since, hidden_reason, last_heartbeat_at,
                            hidden_away_seconds, hidden_idle_seconds)
VALUES (1, '00000000-0000-4000-8000-0000000000aa', 'mainline', 'course_detail', 'active',
        'hidden', NOW(3) - INTERVAL 10 MINUTE, 'away', NOW(3) - INTERVAL 30 SECOND, 0, 0);
UPDATE study_sessions
  SET hidden_away_seconds = hidden_away_seconds
        + IF(client_state = 'hidden' AND hidden_reason = 'away',
             GREATEST(0, LEAST(TIMESTAMPDIFF(SECOND, last_heartbeat_at, NOW(3)), 45)), 0),
      hidden_idle_seconds = hidden_idle_seconds
        + IF(client_state = 'hidden' AND hidden_reason = 'idle',
             GREATEST(0, LEAST(TIMESTAMPDIFF(SECOND, last_heartbeat_at, NOW(3)), 45)), 0),
      active_seconds = active_seconds
        + IF(client_state = 'visible',
             GREATEST(0, LEAST(TIMESTAMPDIFF(SECOND, last_heartbeat_at, NOW(3)), 45)), 0),
      client_state = 'hidden',
      hidden_reason = 'away',
      hidden_since = IF('hidden' = 'hidden', COALESCE(hidden_since, NOW(3)), NULL)
  WHERE session_uid = '00000000-0000-4000-8000-0000000000aa';
SELECT CONCAT('away_only: away=', hidden_away_seconds, ' idle=', hidden_idle_seconds,
              ' active=', active_seconds) AS r
  FROM study_sessions WHERE session_uid = '00000000-0000-4000-8000-0000000000aa';
-- 期望 away=30（若得到 45，说明差值基点被写成了 hidden_since，是 bug）、idle=0、active=0
-- ③ controls 两列默认值与写入
--    ⚠️ controls.student_id 有 FK → students(id)（fk_controls_student_id）：用「不存在的假 id」会
--    ERROR 1452 中断整个脚本，**连 ROLLBACK 都跑不到**（2026-09-20 实施时踩到）。
--    故取一个**真实且尚无 controls 行**的学生：
SET @sid = (SELECT s.id FROM students s LEFT JOIN controls c ON c.student_id = s.id
            WHERE c.student_id IS NULL ORDER BY s.id LIMIT 1);
INSERT INTO controls (student_id) VALUES (@sid) ON DUPLICATE KEY UPDATE student_id = student_id;
SELECT CONCAT('defaults: away=', alert_away_minutes, ' idle=', alert_idle_minutes) AS r
  FROM controls WHERE student_id = @sid;
-- ④ 标记已读幂等
SELECT CONCAT('markread_probe=', COUNT(*)) AS r FROM safety_alerts WHERE id = -1;
ROLLBACK;
" 2>/dev/null
```

Expected: `away_only: away=30 idle=0 active=0`（**只累加 away**、差值基点是 `last_heartbeat_at` 的 30 秒；若得 `away=45` 说明基点写成了 `hidden_since`，是 bug）、`defaults: away=5 idle=15`。

- [ ] **Step 2: 端到端冒烟（真 dev 库，独立端口）**

自签家长 token（`JWT_SECRET` 签 `{sub, role:'parent'}`）：

```bash
cd apps/server && PORT=3120 node dist/main.js > /tmp/smoke_pc.log 2>&1 & echo $! > /tmp/smoke_pc.pid
sleep 6
node -e "const jwt=require('jsonwebtoken');require('dotenv').config();require('fs').writeFileSync('/tmp/p.jwt',jwt.sign({sub:1,role:'parent'},process.env.JWT_SECRET||'k12-dev-secret',{expiresIn:'1h'}))"
T=$(cat /tmp/p.jwt)
SID=$(curl -s -H "Authorization: Bearer $T" localhost:3120/api/parent/students | node -pe "JSON.parse(require('fs').readFileSync(0,'utf8')).data[0].id")
curl -s -H "Authorization: Bearer $T" "localhost:3120/api/parent/students/$SID/controls"; echo
curl -s -X PUT -H "Authorization: Bearer $T" -H 'Content-Type: application/json' -d '{"alertAwayMinutes":2}' "localhost:3120/api/parent/students/$SID/controls"; echo
curl -s -X PUT -H "Authorization: Bearer $T" -H 'Content-Type: application/json' -d '{}' "localhost:3120/api/parent/students/$SID/controls"; echo   # 应 409/1001
curl -s -H "Authorization: Bearer $T" "localhost:3120/api/parent/alerts?unreadOnly=1&pageSize=5"; echo
curl -s -H "Authorization: Bearer $T" localhost:3120/api/parent/account; echo
curl -s -X PATCH -H "Authorization: Bearer $T" -H 'Content-Type: application/json' -d '{"oldPassword":"wrong","newPassword":"newpass123"}' localhost:3120/api/parent/password; echo   # 应 401/1003
kill $(cat /tmp/smoke_pc.pid); rm -f /tmp/smoke_pc.pid /tmp/p.jwt /tmp/smoke_pc.log
```

Expected: controls 回 `{alertAwayMinutes:5,alertIdleMinutes:15}` → PUT 后 `alertAwayMinutes:2`；空 patch **409/1001**；alerts 回分页结构；account 回 `{id,name,phone}`；错旧密码 **401/1003**。
⚠️ **这个 PUT 会真写库**（该孩子的 `alert_away_minutes` 被改成 2）——跑完改回 5，或在报告里说明。**按 PID 收尾**。

- [ ] **Step 3: 门禁**

```bash
cd apps/server && npm test 2>&1 | tail -3 && npx tsc --noEmit && npm run build
cd apps/web && npm test 2>&1 | tail -3 && npx tsc -b && npm run lint && npm run build
```

- [ ] **Step 4: 人工走查清单（交付时一并给出）**

1. 辅线发一条语文理解题 → **不被拒答**（修复验证，§7.4-1）
2. 辅线发一条闲聊 → 模型温和引导，且家长端预警中心出现 `off_topic` 预警
3. 家长端任意页顶部出现红色 Banner → 点 CTA 进预警中心 → 标记已读 → 返回后 Banner 消失
4. 学生端切走 ≥ 5 分钟（可先改小阈值）→ 出现 `away` 预警，且**不弹 Banner**（`info` 级）
5. 改「切走等待时长」为 2 分钟 → 再切走 2 分钟即报警（**阈值真的生效**；注意口径是「最后一次操作后 120 秒 + 阈值」，见 spec §3.3）
6. 改密码：旧密码错 → 报错；旧密码对 → 成功且新密码可登录
7. 多孩：切换孩子 → Banner 与列表按所选孩子变化，列表页回到第 1 页
8. 家长端「行为管控」页数字输入框一眼看得出能改；改完刷新仍在

---

## 完工判据

1. `apps/server`：`npm test` 全绿 + `tsc` 干净 + `build` 成功 + 启动冒烟 6 条新路由 mapped（**按 PID 收尾**）。
2. `apps/web`：`npm test` 全绿（夜间那条既有红除外）+ `tsc -b` + `lint` + `build`。
3. DB：迁移幂等复跑通过；`schema.sql` 与迁移的列清单一致（Task 1 Step 3/5 的数字）。
4. Task 10 Step 1 的真库验证全部符合预期（**事务已回滚**）。
5. Task 10 Step 2 的冒烟 6 条响应形状/错误码符合 spec §4。
6. `off-topic-marker.ts` 仍 3/3；辅线语文题不再被拒答。
7. 两份 API 文档的 6 条新端点一致；PRD/UX 已加批注且**需求原文未删**。
8. 人工走查 8 条全过。

## 已知遗留（写进 changelog，别当没看见）

- **走神在挂机进行中就会报**：不等挂机段结束（「切走后不再回来」正是家长最需要知道的场景）；副作用是学生回来后该条预警仍在。
- **「家长来了迅速切回来」「小窗口摆在旁边」测不到**（spec §9 已在设计阶段向用户说明是天花板）。
- **`idle` 段的计时起点晚 2 分钟**：客户端在最后一次输入后 120 秒才判 hidden，且该 120 秒**写死不接家长配置** → 家长设 15 分钟实际约 17 分钟报警。
- **`hidden_reason` 在极少数情况会贴错标签**：先因 idle 变 hidden、随后标签页又被切走，该段仍记为 `idle`。
- **历史挂机数据无法回填**：4 个新列在迁移前不存在。
- **闲聊预警没有「频繁」语义**：实现为每次发生即报，靠 30 分钟去重兜住频率。
- **`ai_messages.safety_flag` 语义有变（双来源）**：从「被硬阻断的轮次」变为「被模型判为闲聊 **或** 被阻断的轮次」（后者现在只剩情绪/敏感）。家长端计数口径随之变化（**更准确**），文案已改成「偏离学习 N」；**历史数据的口径与新的不一致**。
- **改密码不失效旧 token**：本仓无 token 版本机制，旧 token 7 天内仍有效（与管理员改密码一致）。
- **预警不是实时推送**：无调度器 / WebSocket，家长打开或切换页面时才拉到新预警。
- **`alert_level` / `auxiliary_enabled` / `photo_search_enabled` 仍未被读取**：按裁决 10 保留，DB 文档注明「预留未用」。
- **`countConsecutiveOffTopic` 与 `safety.yaml` 的 `off_topic.escalateThreshold` / `criticalThreshold` 保留但不再被调用**（含其单测）。
