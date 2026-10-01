# 订阅裁决结果通知（批④补丁）设计

> 日期：2026-10-01。批④（2026-09-30-subscription-billing-4）人工验收发现两处缺陷，本 spec 修复。
> 上游 spec：`2026-09-30-subscription-batch4-design.md`（claim 列定义、状态机、错误码口径沿用，不重复）。

## 0. 缺陷与用户裁决

**缺陷一（家长侧驳回不可见）**：家长「我已付款」转人工后，管理员驳回，家长收不到任何提示。现状只有两个展示口：①支付弹层（轮询带回 rejected，但弹层关闭即停轮询）；②订单历史仅给 `pending_review` 加「人工核实中」徽标（`ParentSubscriptionPage.tsx:532`），`rejected` 行无任何标记。

**缺陷二（管理端红点不消失）**：`AdminNav` 角标挂载时拉一次（`AdminNav.tsx:28-40`），注释假设「approve/reject 后切页重挂自然刷新」——**假设错误**：`AdminNav` 在管理端布局、路由之外，切页不重挂，红点只在整页刷新/重登后消失。批④计划 Task 7 原文「approve → 行消失、角标减」未实现且偏离未披露。

**用户裁决（2026-10-01）**：
1. 可见性做到「跨页提示条 + 服务端未读持久化」（持久化选方案 A 新表）。
2. 已读时机：家长点「知道了」才消（不做进页自动已读）。
3. 通知事件：裁决两态都发——admin 通过、admin 驳回、回调/自动查单自动闭环 approved；**不含** `adminMarkPaid` 直通（无 claim 的手工标记，裁决口径外）。

## 1. 数据模型

新表 `billing_notices`（家长维度的订阅裁决结果通知，一次性事件、非会话消息）：

```sql
CREATE TABLE IF NOT EXISTS billing_notices (
  id         BIGINT       NOT NULL AUTO_INCREMENT,
  parent_id  INT          NOT NULL,
  type       ENUM('claim_approved','claim_rejected') NOT NULL,
  order_no   VARCHAR(64)  NOT NULL,
  reason     VARCHAR(200) NULL,                -- 驳回原因；approve 为 NULL
  is_read    TINYINT(1)   NOT NULL DEFAULT 0,  -- 0=未读；ack 后置 1
  created_at DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3)
             ON UPDATE CURRENT_TIMESTAMP(3),   -- 列级 ON UPDATE（仓规，勿建触发器）
  PRIMARY KEY (id),
  KEY idx_parent_unread (parent_id, is_read, id),
  CONSTRAINT fk_billing_notices_parent FOREIGN KEY (parent_id) REFERENCES parents(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
```

- 迁移：`tools/db/migrations/2026-10-01_billing_notices.sql`，幂等（`CREATE TABLE IF NOT EXISTS`），本机 apply 两遍验证。
- 同步 `tools/db/schema.sql`「9.5 订阅与计费」节尾。
- 不设 `(order_no, type)` 唯一键：同一单可「驳回 → 家长重新主张 → 通过」，两条通知都是有效事件；防重靠**只在状态迁移发生时写入**（见 §2.1）。

## 2. 后端

### 2.1 写入挂点（三处，均在 `billing.service.ts`）

| 挂点 | 位置 | type | reason |
|---|---|---|---|
| `approveClaim` 成功 | `markClaim(order.id,'approved')`（:428）之后 | `claim_approved` | NULL |
| `rejectClaim` 成功 | `markClaim(order.id,'rejected',…)`（:451）之后 | `claim_rejected` | **方法入参 `reason` 原文**（不是拼接后的 claim_note） |
| `finalizePaidOrder` claim 自动闭环 | `claim_status==='pending_review' → 'approved'` 挂点（:511）之后 | `claim_approved` | NULL |

- **防重靠状态迁移唯一性**：approve/reject 均有 `claim_status==='pending_review'` 前置闸（否则 2002），重复调用进不来；finalize 挂点只在迁移真正发生时执行（finalize 幂等重入走 `duplicate` 分支不落挂点）。无需额外去重逻辑。
- **失败不阻断裁决主链路**（对齐「埋点不阻断主链路」仓规）：通知 INSERT 失败 `catch + logger.warn`（带 orderNo/parent_id/type），裁决结果照常返回。
- `order_no` 从挂点处的 order 行取，`parent_id` 同源（order.parent_id），不额外回读。
- 边界确认：一单「驳回 → 家长再次确认 → 通过」产生 `claim_rejected` + `claim_approved` 两行通知，**属预期**。

### 2.2 repo

新建 `apps/server/src/database/repositories/billing-notices.repo.ts`：
- `insert({parentId, type, orderNo, reason})` → 插一行，返回 id（失败由调用方 catch）。
- `listUnread(parentId)` → `SELECT id,type,order_no,reason,created_at FROM billing_notices WHERE parent_id=? AND is_read=0 ORDER BY id DESC LIMIT 50`（LIMIT 用字面量 50，**不碰 `LIMIT ?` 占位符坑**）。
- `markRead(id, parentId)` → `UPDATE billing_notices SET is_read=1 WHERE id=? AND parent_id=?`（双条件归属校验下推到 SQL），返回受影响行数。
- 注册进 `billing.module`。

### 2.3 端点（挂 admin 之外的家长侧 billing controller）

**`GET /api/parent/billing/notices/unread`**
- 守卫 `@Roles('parent')`；`parentId` 从 JWT user 链取（同既有家长端点惯例）。
- 逐步：无参数无分页 → repo.listUnread → 映射 `{items, total}`。
- 返回 `200`：`{items: [{id, type, orderNo, reason, createdAt}], total}`；`total = items.length`（≤50，UI 不承诺精确总数，未读量级极低）。
- 错误：401 未登录（框架）；403 角色不符（RolesGuard 惯例）。无 1001/1002 路径。

**`POST /api/parent/billing/notices/{id}/ack`**
- 守卫同上。校验顺序：
  1. `id` 非正整数 → `400 / 1001`「参数错误」；
  2. 查无此行 → `404 / 1002`「通知不存在」；
  3. 行归属他人 → `403 / 1005`（markRead 双条件已兜底，service 先读后判给出准确错误码）；
  4. 已读（`is_read=1`）→ **幂等**直接 `200 {ok:true}`，不重复 UPDATE。
- 成功 `200 {ok:true}`；logger.info 留痕（noticeId + parentId）。
- **注意**：Nest `@Post` 默认 201，本端点显式 `@HttpCode(200)`（新增第二处覆盖，须在 API 文档/openapi 记 `'200'`）。

## 3. 家长端 UI

### 3.1 新组件 `BillingNoticeBar`（`apps/web/src/pages/parent/BillingNoticeBar.tsx`）

独立组件（护栏先例：预警=孩子行为、订阅=付费状态、裁决结果=事件通知，三者不合并）。渲染进 `ParentLayout` 顶栏，与 `AlertBanner`、`SubscriptionNoticeBar` 并列（顺序：AlertBanner → BillingNoticeBar → SubscriptionNoticeBar，事件通知紧邻订阅状态条）。

**状态机**：`idle → loading → ready(unread[]) →（逐条 ack → 移除）→ empty(不渲染)`。

- **首拉失败 → `hidden`**（静默，本会话不再打扰；下次进入页面/轮询周期重试）；**后续轮询失败 → 保留现有列表**（已展示的通知不打折消失）。

- 挂载立即拉一次 + 30s 轮询（与 AlertBanner 同口径；轮询失败静默保留现有列表）。
- 每条未读渲染一条横幅：
  - `claim_approved` → 「您的订阅已开通」（成功色）；
  - `claim_rejected` → 「管理员未确认本次转账」+ reason（有则追加展示，错误色）。
  - 每条右侧「知道了」按钮 → `ackBillingNotice(id)` → 成功后从列表移除；失败 toast「操作失败，请稍后再试」并保留条目（下轮轮询/重试可再点）。
- 全部 ack 完（列表空）→ 不渲染任何 DOM。
- 配色走 CSS 变量；无 emoji；线性 SVG 图标（如需）。

### 3.2 api.ts 增补

```ts
type BillingNoticeView = { id: number; type: 'claim_approved'|'claim_rejected'; orderNo: string; reason: string|null; createdAt: string };
listUnreadBillingNotices(): Promise<{items: BillingNoticeView[]; total: number}>;
ackBillingNotice(id: number): Promise<{ok: true}>;
```

### 3.3 订单历史补驳回可见性（`ParentSubscriptionPage.tsx`）

- pending 且 `claimStatus==='rejected'` 的历史行：加红色徽标「管理员已驳回」（`data-testid="order-claim-rejected-{orderNo}"`，样式族同「人工核实中」徽标但用 `--error` 色）。
- 徽标旁次要文字展示 `claimNote`（格式 `原note；驳回：reason`，服务端已截 200），前端超 60 字截断加省略号，title 属性放全文。
- 家长后续路径**沿用既有流程**：取消该单 → 重新下单（既有「取消」按钮 + 下单 2002 引导已覆盖），不新增「重新支付」交互。

## 4. 管理端红点联动

新建 `apps/web/src/store/adminBillingBadgeStore.ts`（Zustand，目录惯例 `store/` 单数）：

```ts
{ pendingCount: number|null, setPendingCount(n), refresh(): Promise<void> }
// refresh: listBillingClaims('pending_review',1,1) → setPendingCount(total)；失败静默保留旧值
```

- `AdminNav`：删除自身 fetch effect，改为挂载时 `refresh()` + 渲染 `store.pendingCount`（null 或 0 不渲染角标；失败静默口径不变）。
- `AdminBillingPage`：approve / reject 成功后调 `refresh()`（approve 后行已消失，红点数同步减；处理完最后一条即消失）。
- 修正 `AdminNav.tsx` 头注释：删掉「切页重挂自然刷新」的错误假设，改为「store 联动，AdminBillingPage 裁决后主动 refresh」。

## 5. 测试口径

**服务端**（`vitest run src/modules/billing` + 全量）：
- 三挂点各一钉：approve/reject/自动闭环成功 → insert 被调且 type/reason 正确；insert 抛错 → 裁决主链路不受影响（approve/reject/finalize 照常返回）。
- reject 落库 reason = 入参原文（非拼接 claim_note）。
- unread：只回自己家长的、只回未读、id 倒序、50 上限、total=items.length。
- ack：幂等（已读再 ack 200 且不再 UPDATE）、1002（不存在）、1005（他人通知）、1001（id 非法）。

**前端**（组件渲染测试，`afterEach(cleanup)` 铁律）：
- `BillingNoticeBar`：两态文案渲染、逐条 ack 后条目消失、全空不渲染、拉取失败静默、ack 失败保留条目；与 AlertBanner/SubscriptionNoticeBar 共存护栏（ParentLayout 渲染下三者互不吞）。
- `AdminNav`：store 化后角标渲染/null 不渲染/失败静默。
- `AdminBillingPage`：approve、reject 成功后 `refresh` 被调。
- `ParentSubscriptionPage`：rejected 行徽标 + claimNote 截断展示；pending_review 徽标回归不破。
- 收尾：server `npm test && npx tsc --noEmit`；web `npm test && npx tsc -b`。

## 6. 文档同步

- API 文档：§4.15（家长订阅节）加两端点（ack 记 `'200'`，`@HttpCode` 覆盖，成为本仓第二处）；§9 日志补 ack 留痕口径。
- `docs/api/openapi.yaml`：+2 op + `BillingNoticeView` schema。
- UX 文档：家长顶栏组件清单补 `BillingNoticeBar` 一行。
- `docs/ai-core-changelog.md`：2026-10-01 节记录两缺陷、用户三裁决、修复要点。
- **CLAUDE.md「API 文档同步规则」节**：「本仓唯一的 `@HttpCode` 覆盖」表述改为列出两处（`learning-sessions` 与本 ack 端点）。
- PRD 不动（未改变付费语义，纯可见性补强）。

## 7. 明确不做（YAGNI）

- `adminMarkPaid` 直通（无 claim）不发通知（用户裁决口径外）。
- 不做家长端通知红点/角标（横幅常驻 + 知道了已覆盖）。
- 不做通知历史页（`is_read=1` 后不可再见）。
- 不做站内信中心 / 短信 / 邮件渠道。
