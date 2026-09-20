# 管理员手动清理 30 天前的预警 + `safety_alerts` 补索引

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 管理员端新增「预警数据」页，可预览并**手动清理 30 天前的预警**（含未读）；同时给 `safety_alerts` 补两个索引，消掉家长端列表的 filesort 与清理时的全表扫。

**关联 spec**：`docs/superpowers/specs/2026-09-20-parent-controls-and-alerts-design.md`（下称 **spec**）。本批**不改判题/预警判定口径**，只加「保留期清理入口 + 索引」；spec §9 已知限制需补一行「预警无自动保留期」。

**上游**：本批属 `feat/parent-controls-and-alerts` 分支（HEAD `4cb7816`，Task 0–7 已完成）。Task 8/9/10（家长端行为管控页 / 文档同步 / 端到端走查）**不在本计划范围**。

---

## 已锁定的决策（用户 2026-09-20 确认，勿自行改回）

| 决策 | 选定 | 理由 |
|---|---|---|
| 清理范围 | **全删（含未读）** | 符合「清理一个月前」的字面意思；未读的也永久堆积就等于没解决问题。预览里显示未读数让管理员心里有数 |
| 时间阈值 | **固定 30 天**（接口不带参数） | 杜绝「填 0 就删库」。要改就改常量 |
| 索引 | **加两个** | 两条查询路径各需一个；写入代价可忽略（预警每天最多几百条） |

---

## 背景（已实测确认，实施时别凭印象）

- `safety_alerts` 目前**无任何清理**：`safety-alerts.repo.ts` 只有 INSERT/SELECT/UPDATE，全仓无 `DELETE FROM safety_alerts`；全仓**无任何 scheduler**（`@nestjs/schedule` / `@Cron` / `node-cron` / `SchedulerRegistry` 零命中，且 `package.json` 里没有）。
- 去重窗口 `(student_id, type)` 30 分钟（`safety-alerts.service.ts:25`）→ 每孩子每天上限约 240 条，**无上限增长**（约 87k 行/年/孩子）。
- 列表查询 `WHERE parent_id=? ... ORDER BY created_at DESC, id DESC` 只有 `(parent_id, is_read)` 索引 → **filesort**。
- spec §9 未记录「无保留期」这条 → 本次一并补上。

---

## 全局约束（动手前先读一遍）

- **`LIMIT ?` 必须用 `pool.query`，不能用 `pool.execute`**：MySQL 预处理语句直接拒（`ER_WRONG_ARGUMENTS Incorrect arguments to mysqld_stmt_execute`）。本批新增查询**无 `LIMIT`**，但别顺手把既有列表查询改回 `execute`（Task 6 的 Critical 事故，只有真库端到端能发现）。
- **无迁移运行器 → 手工 apply 且必须幂等**：索引守卫用 `information_schema.STATISTICS` + `PREPARE`/`EXECUTE`/`DEALLOCATE`；**守卫条件用 `> 0` 而不是 `= 1`**（STATISTICS 每个索引列返回一行，这是本仓记录过的坑）。
- **新索引必须同时进 `tools/db/schema.sql`**，与迁移保持一致。
- **仓储内不得出现 `NOW(` / `CURDATE(`**：cutoff 由调用方算好传入（与 `existsRecent` 同口径；其测试有 `not.toMatch(/NOW\s*\(|CURDATE\s*\(/i)` 钉子）。
- **绝不在 `AdminModule` 里重复 provide `SafetyAlertsRepository`**：`safety-alerts.module.ts` 的注释明确警告会分裂实例、破坏去重语义。只 `imports` 模块、注入其导出的仓储。
- **`RowDataPacket` 有 index signature，会吞掉类型错误**：`COUNT(*)` 回来是字符串、`SUM(...)` 空集回来是 `NULL` → 必须 `Number(...)` 显式转，别指望 `tsc` 拦。
- **起后端 `node dist/main.js`**；冒烟用**独立端口 + 按 PID 收尾**，**别** `pkill -f 'node dist/main.js'`（用户本机有自己的服务在跑，见 `CLAUDE.md`）。
- **`npm run build` 会覆盖用户正在服务的 `dist/`**（ENV-1 后端 :3001 / ENV-2 前端 :5173 均正跑本分支构建）→ 构建后**主动披露**，不擅自回退。
- **UI**：不用 emoji、图标必须线性 SVG；admin 页配色照既有惯例（`bg-white rounded-2xl border border-gray-200` + 内联 `style={{ color: 'var(--text-primary)' }}`），**admin 页不用 `Card` 组件**（已核实零使用）。
- **测试**：`globals: false` → 多用例文件自己 `afterEach(cleanup())`；变异验证**不要用 `git checkout` 还原**（未提交时会把修复本身抹掉）→ 备份到 `/tmp` 用 `cp` 还原并核 md5。

---

## 一、后端

### Task 1 — 仓储加两个方法

**Files:** `apps/server/src/database/repositories/safety-alerts.repo.ts`（改）、`safety-alerts.repo.test.ts`（改）

- [ ] 新增 `countOlderThan(cutoff: Date): Promise<{ total: number; unread: number }>`

```ts
// SELECT COUNT(*) AS n, SUM(is_read = 0) AS unread FROM safety_alerts WHERE created_at < ?
// 注意：0 行时 SUM(...) 返回 NULL → 必须 Number(rows[0]?.unread ?? 0)
```

- [ ] 新增 `deleteOlderThan(cutoff: Date): Promise<number>`

```ts
// DELETE FROM safety_alerts WHERE created_at < ?
// pool.execute<ResultSetHeader> → result.affectedRows
```

参照既有 `affectedRows` 模式：`student-hidden-questions.repo.ts:28-34`。

- [ ] 测试钉子：SQL 形状含 `created_at < ?`；参数就是传入的 `Date`；`SUM(is_read=0)` 为 `NULL` 时返回 `0`；`COUNT` 字符串转数字；`deleteOlderThan` 返回 `affectedRows`；两者 SQL **不得含 `NOW(`**。

### Task 2 — 新建 `AdminAlertsService`

**Files:** `apps/server/src/modules/admin/admin-alerts.service.ts`（新建）、`admin-alerts.service.test.ts`（新建）

```ts
const RETENTION_DAYS = 30;   // 固定，不接受入参

preview(): Promise<{ retentionDays: number; cutoff: string; total: number; unread: number }>
purge():   Promise<{ retentionDays: number; cutoff: string; deleted: number }>
```

- [ ] `cutoff = new Date(Date.now() - RETENTION_DAYS * 24 * 60 * 60 * 1000)`，ISO 字符串返回给前端展示。
- [ ] 无 scheduler、无定时任务——**只由管理员手动触发**。
- [ ] 测试钉子：`cutoff = now - 30 天`（用容差窗口断言，照 `safety-alerts.service.test.ts:146-147` 的 before/after 写法）；`preview` 透传仓储结果；`purge` 返回 `deleted`。

### Task 3 — 两个端点（加在既有 `AdminController`）

**Files:** `apps/server/src/modules/admin/admin.controller.ts`（改）+ 其测试（改）

`AdminController` 已带 `@Controller('api/admin')` + `@UseGuards(JwtAuthGuard, RolesGuard)` + `@Roles('admin')`。

| 方法 | 路径 | 校验 | 逻辑 | 状态 | 返回 |
|---|---|---|---|---|---|
| `GET` | `/api/admin/alerts/expired` | 无入参 | `preview()` | **200** | `{ retentionDays: 30, cutoff: "<ISO>", total: N, unread: M }` |
| `DELETE` | `/api/admin/alerts/expired` | 无入参 | `purge()` | **200** | `{ retentionDays: 30, cutoff: "<ISO>", deleted: K }` |

- [ ] 两者同一资源（「已过期预警」）：`GET` 看有多少、`DELETE` 清掉。对称、自解释。
- [ ] 用 `@Delete`（→ 200）而不是 `@Post`（→ 201，对「清理」语义不对）。**本仓无端点用 `@HttpCode` 覆盖**，保持惯例。
- [ ] 无错误分支（无入参、固定 30 天）。唯一失败面是 DB 异常 → 走全局过滤器 → 5000。
- [ ] 不需要 Zod（无 body / 无 query）。

### Task 4 — 模块装配

**Files:** `apps/server/src/modules/admin/admin.module.ts`（改）

- [ ] `imports: [CommonModule, SafetyAlertsModule]`
- [ ] `providers` 加 `AdminAlertsService`
- [ ] ⚠️ **绝不重复 provide `SafetyAlertsRepository`**（见全局约束）。

---

## 二、数据库

### Task 5 — 迁移 + schema

**Files:** `tools/db/migrations/2026-09-20_safety_alerts_retention_indexes.sql`（新建）、`tools/db/schema.sql`（改）

- [ ] 迁移文件头按惯例写：做什么 / 为什么 / 幂等 / 回滚。
- [ ] 两个索引，各用 `information_schema.STATISTICS` 幂等守卫（`> 0`）：

| 索引 | 服务哪条查询 |
|---|---|
| `idx_sa_parent_created (parent_id, created_at)` | 家长端列表 + 顶部 Banner：`WHERE parent_id=? [AND is_read=0] ORDER BY created_at DESC` → 免 filesort |
| `idx_sa_created_at (created_at)` | 本次的 `countOlderThan` / `deleteOlderThan`（`WHERE created_at < ?`）→ 区间扫描而非全表扫 |

- [ ] `tools/db/schema.sql` 的 `safety_alerts` CREATE TABLE（约 `:803-822`）补上同样两行 `KEY`，与迁移一致。

---

## 三、前端

### Task 6 — API 封装

**Files:** `apps/web/src/services/api.ts`（改）

在 admin 段（约 `:832` 与 `:834` 之间）加：

```ts
export interface AdminAlertRetentionPreview {
  retentionDays: number; cutoff: string; total: number; unread: number;
}
export function getExpiredAlertStats(): Promise<AdminAlertRetentionPreview>
  // fetchApi('/admin/alerts/expired')
export function purgeExpiredAlerts(): Promise<{ retentionDays: number; cutoff: string; deleted: number }>
  // fetchApi('/admin/alerts/expired', { method: 'DELETE' })
```

### Task 7 — 新建 `AdminAlertsPage`

**Files:** `apps/web/src/pages/admin/AdminAlertsPage.tsx`（新建）、`AdminAlertsPage.test.tsx`（新建）

**状态机：**

```
挂载 → GET /admin/alerts/expired
├─ 加载中        → Skeleton（照 AdminDashboardPage 的写法：白卡 + Skeleton）
├─ 失败          → 虚线边框错误卡「预警数据加载失败」+ toast('error')
└─ 就绪          → 信息卡：
                    · 「30 天前的预警」大数字 = total
                    · 副行「其中未读 M 条」
                    · 截止时间 cutoff（本地化展示）
                    · 按钮「清理 30 天前的预警」
                       ├─ total === 0 → disabled（没东西可清）
                       └─ total > 0  → 打开 ConfirmDialog
                            message = 「确认清理 30 天前的预警 N 条（其中未读 M 条）？此操作不可恢复。」
                            ├─ 确认 → DELETE → toast('success', `已清理 N 条`) → 重新拉取统计
                            └─ 取消 → 关闭，不发请求
```

- [ ] 样式照 admin 页惯例（见全局约束）；确认框用 `ConfirmDialog`（`title="提示："`），照 `AdminAccountsPage.tsx:251-262` 的「把计数插进 message」写法。
- [ ] `data-testid`：`alerts-stats-loading` / `alerts-stats-error` / `alerts-stats` / `alerts-purge-btn`。
- [ ] 测试钉子：四态（加载/失败/就绪/`total=0` 时按钮 disabled）；点按钮出确认框且 message 含条数；**确认 → 调 DELETE + toast + 重新拉统计**；**取消 → 不调 DELETE**。

### Task 8 — 侧栏 + 路由

**Files:** `apps/web/src/components/layout/AdminNav.tsx`（改）、`apps/web/src/routes/routeTable.tsx`（改）、`routeTable.test.tsx`（改）

- [ ] `navItems` 追加 `{ to: '/admin/alerts', label: '预警数据' }`（无图标，与该文件现有 6 项一致）。
- [ ] `routeTable.tsx` 加 import + admin children 加 `{ path: 'alerts', element: <AdminAlertsPage /> }`。
- [ ] 测试：加 admin 会话 + admin API mock，断言 `/admin/alerts` 渲染真页（非占位）且侧栏「预警数据」指向 `/admin/alerts`。

---

## 四、文档同步（硬规则）

**Files:** 见下表

- [ ] `docs/API接口与数据流设计文档.md`：admin 段补两条端点（方法/路径/无参/200/返回形状），与 openapi 互为对照。
- [ ] `docs/api/openapi.yaml`：补 `/admin/alerts/expired` 的 `get` + `delete` 两个 operation + 两个 response schema（都记 `'200'`）。
- [ ] `docs/superpowers/specs/2026-09-20-parent-controls-and-alerts-design.md` §9 已知限制补一行：**预警无自动保留期**，只能管理员手动清理；并记录本次两个索引。
- [ ] `docs/K12智学系统-数据库设计文档.md`：`safety_alerts` 补两个索引（实施时先确认该文档是否已列索引）。

---

## 五、变异验证（每条都要实测 RED 后 `cp` 还原并核 md5）

- [ ] 把 `cutoff` 改成 `new Date()`（不减去 30 天）→ 服务测试 RED
- [ ] 把 `DELETE` 的 `created_at < ?` 改成 `created_at > ?` → 仓储形状钉子 RED
- [ ] 前端确认框「取消」改成也调 DELETE → 取消用例 RED

---

## 六、验证

```bash
cd apps/server && npx vitest run src/modules/admin src/database/repositories/safety-alerts.repo.test.ts
cd apps/server && npm test && npx tsc --noEmit && npm run build
cd apps/web && npx vitest run src/pages/admin src/components/layout src/routes
cd apps/web && npx tsc -b && npm run lint && npm run build
```

**真库 + 真 HTTP 端到端**（本次唯一能证明「只删旧的、不碰新的」的手段）：

1. 事务内插 2 条 `created_at = NOW(3) - INTERVAL 40 DAY`（1 条已读 1 条未读）+ 2 条 `NOW(3)`，**记录 id**；
2. 起独立端口后端（**按 PID 收尾，绝不 `pkill`**），真 admin JWT，`GET /admin/alerts/expired` → 断言 `total`/`unread` 增量正确；
3. `DELETE /admin/alerts/expired` → 断言 `deleted` 等于刚插的旧条数；
4. 复查：**40 天前的行没了、刚插的新行还在、用户既有数据（含 id 14–19 那 6 行）一条没动**；
5. 收尾删掉本次插入的新行。

**索引生效验证**：`EXPLAIN` 家长端列表 SQL，确认 `key = idx_sa_parent_created` 且 `Extra` 无 `Using filesort`。

---

## 七、收尾

- [ ] 删除之前给用户看的 6 行测试数据（`safety_alerts` id 14–19）—— **需用户确认后执行**。
- [ ] SDD ledger（`.superpowers/sdd/progress.md`）记一条。
- [ ] `ENV-1`/`ENV-2`（用户的 :3001/:5173 正跑本分支）依旧有效，本次 `build` 会再次覆盖 `dist/`，**再披露一次**。

---

## 关联未决项（**不在本批范围**，新 session 请勿顺手改）

1. **Banner 遮蔽**：`ParentLayout` 用 `pageSize=1` 且不按 level 过滤，一条**更新的 `info`** 会占掉 `items[0]`，导致未读的 `warning` 永远不显示（已用 id 20 复现后删除）。属 spec §5.1 口径问题。
2. **「查看对话」跳转**：`ParentAlertsPage` 的 `dialogueId` 链接落到对话回放**列表页**，因为不存在 `/parent/chat-logs/:dialogueId` 路由。属 spec §3.6 与 §5.2 不一致。
3. **Task 7 独立复核**：因 subagent 派发 429（配额 2026-09-21 09:40:52 UTC+8 恢复）而欠一次独立评审。
4. **Task 8/9/10**：家长端行为管控页 `/parent/controls` + 账号设置页 `/parent/account`；openapi 4 条旧形状条目订正 + 补 `/parent/password`；端到端走查。

---

## 明确不做

- **不加自动保留期 / 不加 scheduler**（用户选的是「管理员手动清理」；引 `@nestjs/schedule` 是新依赖 + 新子系统，另开一批）。
- 不做「清理前导出备份」、不做审计日志、不做按类型/按孩子筛选清理、不做清理数量上限保护。
- 不给阈值加参数（用户选了固定 30 天）。
