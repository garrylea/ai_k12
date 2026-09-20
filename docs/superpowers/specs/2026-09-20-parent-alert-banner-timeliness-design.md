# 家长端走神预警「及时可见」批 · 设计

日期：2026-09-20
状态：**待实施**
相关：`docs/superpowers/specs/2026-09-20-parent-controls-and-alerts-design.md`（走神预警的来源批）、`docs/superpowers/specs/2026-09-19-analytics-instrumentation-design.md`（心跳与 `study_sessions`）、`docs/API接口与数据流设计文档.md` §6.28、`docs/api/openapi.yaml`
代码锚点：`apps/server/src/modules/analytics/study-sessions.service.ts`、`apps/server/src/database/repositories/study-sessions.repo.ts`、`apps/server/src/modules/parent-insights/`、`apps/web/src/analytics/tracker.ts`、`apps/web/src/components/layout/ParentLayout.tsx`

---

## 1. 背景与问题（实测证据）

用户 2026-09-20 实测「学生进入语文专项训练 → 同浏览器开新 tab → 另一浏览器登家长号等 1 小时」，结果**家长侧毫无感知**。查库还原（student_id=7，阈值 2/5 分钟）：

| 时间 | 事件 | 证据 |
|---|---|---|
| 18:03:19 | 会话 13 变 `away`，**之后再无任何心跳**（共 2 次）、无 `end` | `study_sessions` id=13 |
| 18:15:28 | **idle 预警落库**（18:08 开始 + 120s 检测 + 5min 阈值 = 7 分钟口径） | `safety_alerts` id=25 |
| 19:26:27 | 第二条 idle 预警落库 | id=26 |

暴露三个问题：

1. **无推送感知**：预警只存在于 `safety_alerts` 表与 P6.9 预警页；家长在任何页面干等都不会「收到」任何东西。
2. **away 漏报盲区**：学生端后台 tab 被浏览器冻结/丢弃（或 tab 关闭时无 keepalive 的 `end` fetch 被取消）→ 心跳全断。而阈值判定**只在心跳与 `end` 两个时点**执行（CLAUDE.md 已记录「无 `end` 的崩溃会话不判」），`closeStale` 惰性收尾也不判 → **「学生切走后一直不回来」这个家长最需要的场景永远报不出来**。
3. **idle 口径与文案不符**：家长设「无操作 5 分钟」，实际 7 分钟才报（前端写死 `IDLE_TIMEOUT_MS=120_000` 的检测窗口叠加在阈值之上），预警文案里的分钟数也不含那 2 分钟。

## 2. 用户裁决记录（2026-09-20，实施时不得推翻）

| # | 裁决 | 理由（用户原话） |
|---|---|---|
| 1 | 家长端用 **30s 轮询 + 全局 Banner**，不建 WebSocket/SSE | 「我更倾向于 banner 警告」；评估后用户认可：预警数据源本身 30s 粒度（学生心跳），轮询端到端最坏 ~60s，与 WS 只差 30s，却避免引入全仓第一条长连接；将来移动端换传输层时 banner 的「未读 API + store」形状不用动 |
| 2 | Banner **点击即已读**：点击 → 跳 `/parent/alerts` + 标记已读 + Banner 消失；多条聚合成「有 N 条新预警」；**无 X 关闭钮** | 「当用户点了 banner 查看信息后，banner 消失」 |
| 3 | 「无操作 N 分钟」改为**字面语义**：N 分钟就报，不再 +2 分钟 | 「无操作 5 分钟也应该直接报警」 |
| 4 | 「离开页面 N 分钟」保持字面语义（本来就是从离开时刻起算），但**必须修掉盲区**让它在学生 tab 死掉时也能报出来 | 「定的是离开页面两分钟，那到了 2 分钟就应该报警」 |

**明确不做**：WebSocket/SSE 推送基础设施、系统级推送（APNs/FCM）、Banner 的「不看不消失」关闭钮、多孩分孩子 banner（聚合展示即可，详情在预警页看）。

## 3. 设计

### 3.1 服务端：`closeStale` 补判（修 away 盲区）

`StudySessionsService.closeStale()`（家长端查询前必跑的惰性收尾）增加一步：**收尾前先取命中行里 `client_state='hidden'` 的（student_id, hidden_reason, hidden_since）**，逐条走既有的 `maybeRecordHiddenAlert` 判定，再关闭。

- 实现落点：`repo.closeStale` 从裸 `UPDATE` 改为「先 SELECT 命中行 → UPDATE → 返回被关会话的挂机信息」（或 UPDATE 前先 SELECT，两者在同一连接上顺序执行；无并发正确性问题——重复判定被 30 分钟去重窗口兜住）。
- 判定复用 `maybeRecordHiddenAlert`（现为 private，保持在 `StudySessionsService` 内，不外提）。
- **不重复刷屏**：`closeStale` 只把会话关一次；`SafetyAlertsService` 的 30 分钟去重窗口照旧。
- 调用方不变：`study-time.service.ts` 的 `closeStaleQuietly`（家长学情查询）+ 新增的 unread 轮询端点（§3.3）。

### 3.2 服务端：idle 判定改字面语义

`maybeRecordHiddenAlert` 中 `reason='idle'` 分支：

```
有效经过秒数 = (now - hidden_since) + CLIENT_IDLE_DETECTION_SECONDS   // = 120
```

- `CLIENT_IDLE_DETECTION_SECONDS = 120` 作为服务端具名常量，注释注明与前端 `tracker.ts` 的 `IDLE_TIMEOUT_MS = 120_000` **同源镜像**、改一处必须同步另一处。
- 阈值比较与预警文案分钟数都用有效值 → 家长设 5 分钟，第 5 分钟报、文案写 5 分钟。
- `away` 分支不动（`hidden_since` 即离开时刻，已是字面语义）。
- **已知边界**：阈值 ≤ 2 分钟时（页面允许最小 1 分钟），idle 实际生效值约为 2 分钟（检测窗口即下限）。写进 API 文档 §6.28，不加 UI 限制。
- `hidden_idle_seconds` / `hidden_away_seconds` 的**秒数累计口径不动**（与预警判定是两套口径，前者按 `last_heartbeat_at` 差值封顶 45s，与本次改动无关）。

### 3.3 服务端：新端点 `GET /parent/alerts/unread`

- 归属：`parent-insights` 模块（`AlertsService` + controller），鉴权同既有 `GET /parent/alerts`（parent 角色，不传 `studentId` = 全部孩子）。
- 行为：① 取该家长名下全部学生（`studentsRepo.findByParentId`），逐个 `closeStale`（**嵌在业务流里的写入：整段 catch、失败只 warn、绝不阻断响应**）；② 查未读预警。**可见性口径（评审修订，2026-09-20）**：补判出的预警写入在 `maybeRecordHiddenAlert` 内部仍是 `void`（不破坏该方法的调用纪律），与②的 SELECT 存在竞态——通常**下一次轮询**（30s 内）才出现在响应里，而非本次。
- 响应：`{ items: [{ id, type, level, message, studentName, createdAt }] , total }`；`items` 截最新 5 条，`total` 为未读总数（banner 文案用）。`level` 供前端区分 Banner 配色（warning/critical → danger 红、info 走神 → warning 橙）。
- 复用既有 list 仓储的 `unreadOnly` 过滤，不新写查询逻辑。
- **API 文档同步铁律**：`docs/API接口与数据流设计文档.md` §4 端点清单 + §6.28 口径，与 `docs/api/openapi.yaml` 必须同批更新（含 idle 字面语义变更、补判行为、已知边界）。

### 3.4 前端：`ParentLayout` 挂 `AlertBanner` + 30s 轮询

> **实施时发现（2026-09-20，写计划阶段）**：`ParentLayout` 已有一个预警 banner —— 仅在路由切换时刷新、只看**当前选中孩子**、且 `info` 级（走神）被上一批裁决排除（「info 只进列表页」）。本批**用新 `AlertBanner` 替换它**（不是叠两个 banner）：旧裁决被本批用户裁决 2/4 显式推翻（走神必须醒目提示）；旧的「warning/critical → danger 红色」配色习惯保留（按最新一条的 `level` 映射）。旧的「按当前孩子过滤」被「家长名下全部孩子」取代（走神预警不应依赖当前选中了谁）。

新组件 `apps/web/src/components/business/AlertBanner.tsx`，挂在 `ParentLayout` 顶部，**所有家长页生效**（含行为管控页）：

- 轮询：`POLL_INTERVAL_MS = 30_000`（组件内具名常量），挂载即查一次；浏览器后台 tab 节流降到约 1 次/分钟，回前台自动补上，**不做手动暂停逻辑**。
- 展示：有未读 → 顶部 Banner（复用 base `Banner` 组件、parent 主题、无 emoji）：「有 N 条新预警，最新：{最新一条 message}」。
- **点击即已读**：点击 → 对 `items` 每条并发 `PATCH /parent/alerts/:id/read`（`.catch` 静默，失败不阻断跳转）→ 乐观清掉本地未读 → `navigate('/parent/alerts')`。
- 多 tab 同时轮询无需处理（读幂等、标已读幂等）。
- API 层：`api.ts` 加 `getParentUnreadAlerts()`；标已读复用既有 `markParentAlertRead`。

### 3.5 端到端效果（验收口径）

| 场景 | banner 出现时间 |
|---|---|
| 学生心跳活着、阈值到达 | 最坏 ~60s（心跳 0–30s + 轮询 0–30s） |
| 学生 tab 冻结/关闭（心跳全断） | 家长端开着：最坏 ~60s（首个轮询触发补判、下一轮取到）；家长不在线：下次登录后 ~30s 内弹 |
| idle 5 分钟 | 第 5 分钟（不再 +2） |
| away 2 分钟 | 第 2 分钟（心跳活着时 2:00–2:30，原行为不变） |

## 4. 测试

- **服务端**：`closeStale` 补判传递（hidden 会话超阈值 → 预警落库；visible/无挂机会话不判）；idle +120s 有效口径（含文案分钟数）；unread 端点（补判失败只 warn 不 500、items 截断、total 正确）。
- **前端**：`AlertBanner` 渲染钉子（有未读显示、点击标已读 + 跳转、无未读不渲染）；fake timers 轮询周期。
- **组件改动补渲染测试**铁律照旧（CLAUDE.md）。

## 5. 文档同步清单

1. `docs/API接口与数据流设计文档.md`：§4 新端点、§6.28 走神口径改字面语义 + 补判 + 已知边界。
2. `docs/api/openapi.yaml`：`GET /parent/alerts/unread`（MVP 端点）。
3. `CLAUDE.md`「家长端『管得住』批」段：走神两个「分钟数」条目改写（idle 已是字面语义；补判落点在 `closeStale`）。
4. `docs/ai-core-changelog.md`：本批条目（含 1 小时实测事故复盘）。
