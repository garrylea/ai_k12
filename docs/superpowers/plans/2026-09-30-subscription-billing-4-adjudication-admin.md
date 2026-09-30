# 订阅收费批④（裁决链路 + 自动到账 + 试用管理）实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.
> 本计划在新 session 执行；进度台账续写 `/.superpowers/sdd/progress.md`（已有订阅收费前三批记录，本批新开节「批④」）。

**Goal:** 家长扫码后零点击自动到账（真渠道）；线下转账渠道（个人微信收款 + 管理员裁决手工开通，当前主路径）（pending 轮询时限频主动查渠道）；「我已付款」未获渠道确认时转管理员裁决（claim 状态机 + 管理端列表/角标/通过/驳回）；管理员全权管理试用与订阅天数（含审计表）。

**Architecture:** 自动查单是出站调用（本机部署形态下回调不可达的唯一到账途径），挂在既有订单详情轮询上、内存 Map 限频 10s/单；裁决复用 `finalizePaidOrder`（4b5bd64 后 markPaidTx 已放行 pending|expired）与 `adminMarkPaid`（adminId 留痕已有）；管理员调整走新审计表 `subscription_adjustments`。

**Tech Stack:** NestJS + mysql2 + React 18；无新依赖。

**Spec:** `docs/superpowers/specs/2026-09-30-subscription-batch4-design.md`（列定义、状态机、错误码以其为准）

## Global Constraints

- 迁移幂等 + 同步 `tools/db/schema.sql`；`updated_at` 列级 ON UPDATE
- `LIMIT ?` 分页必须 `pool.query`（仓规）
- 错误码：2002 非法状态 / 1001 参数 / 1002 不存在 / 1005 归属；查单渠道异常在**读路径必须吞掉**（不污染家长轮询）
- claim 相关所有写路径 logger 留痕（带 orderNo/adminId）
- 前端：无 emoji、CSS 变量、`afterEach(cleanup)`、线性 SVG
- 每任务独立 commit；服务端验收 `npx vitest run src/modules/billing && npx tsc --noEmit`，批尾全量

---

### Task 1: 迁移——orders claim 三列 + subscription_adjustments 表

**Files:**
- Create: `tools/db/migrations/2026-09-30_billing_claims_and_adjustments.sql`
- Modify: `tools/db/schema.sql`（orders 表定义加 3 列；「9.5 订阅与计费」节尾加新表）

**Interfaces:**
- Produces: `orders.claim_status VARCHAR(12) NULL`（`pending_review`/`rejected`/`approved`）、`orders.claimed_at DATETIME(3) NULL`、`orders.claim_note VARCHAR(200) NULL`；新表 `subscription_adjustments`（列见 spec §1：parent_id FK、admin_id、type(`trial_set`|`grant_days`)、trial_ends_at NULL、delta_days NULL、reason VARCHAR(200) NULL、created_at/updated_at，KEY (parent_id, id)）

- [ ] **Step 1: 写迁移**（`ALTER TABLE orders ADD COLUMN ... `每列前用 information_schema 判断的幂等写法，或直接 `ADD COLUMN IF NOT EXISTS`——MySQL 9 不支持 IF NOT EXISTS for ADD COLUMN，须用存储过程/条件 ALTER：参照仓内既有迁移的条件式 ALTER 先例 `grep -l "information_schema" tools/db/migrations/`）；新表 `CREATE TABLE IF NOT EXISTS`
- [ ] **Step 2: schema.sql 同步**（orders 三列插在 `coupon_*` 之后；新表加在 9.5 节尾）
- [ ] **Step 3: 本机 apply 两遍验证幂等**（mysql ai_k12 < 迁移文件；注意连接参数看 `apps/server/.env` 的 DB_*，验证查询加 `--vertical`）
- [ ] **Step 4: Commit** — `git commit -m "feat(billing): orders claim 三列 + subscription_adjustments 审计表"`

### Task 2: 自动查单（pending 轮询时限频查渠道）

**Files:**
- Modify: `apps/server/src/modules/billing/billing.service.ts`（getOrderDetail 的 pending 分支）
- Test: `apps/server/src/modules/billing/billing.service.test.ts` 追加

**Interfaces:**
- Produces: `BillingService.getOrder` 行为变更——pending && channel ∈ {wechat,alipay} 时触发限频渠道查单；私有方法 `maybeQueryChannel(order: OrderRow): Promise<void>`（内存 `Map<string, number>` 限频 10_000ms；查到 paid → `finalizePaidOrder(order, tradeNo, now)`；任何渠道异常 catch + logger.warn 吞掉）

- [ ] **Step 1: 写失败测试**（mock adapter/ordersRepo/finalize）：①pending 单 10s 内二次 GET 只查一次渠道（vi.useFakeTimers 推进）；②渠道 paid → finalize 被调且 DB 状态变 paid；③渠道抛 2003 类异常 → GET 正常返回 DB 状态不抛；④expired 单渠道 paid → finalize（markPaidTx 已放行）；⑤channel='mock' 不触发查单
- [ ] **Step 2: 跑失败 → 实现 → 通过**。实现骨架：

```typescript
// billing.service.ts 私有成员
private channelCheckAt = new Map<string, number>();
private static CHANNEL_CHECK_INTERVAL_MS = 10_000;

private async maybeQueryChannel(order: OrderRow): Promise<void> {
  if (order.payment_status !== 'pending') return;
  if (order.channel !== 'wechat' && order.channel !== 'alipay') return;
  const now = Date.now();
  const last = this.channelCheckAt.get(order.order_no) ?? 0;
  if (now - last < BillingService.CHANNEL_CHECK_INTERVAL_MS) return;
  this.channelCheckAt.set(order.order_no, now);
  try {
    const adapter = this.resolveAdapter(order.channel); // 注意：此处必须拿真实渠道适配器，不走 BILLING_USE_MOCK 的 mock 映射（同 resolveCallbackAdapter 口径，见 4b5bd64）
    const r = await adapter.queryOrder(order.order_no);
    if (r.paid) {
      await this.finalizePaidOrder(order, r.tradeNo ?? `query-${order.order_no}`, new Date());
      this.channelCheckAt.delete(order.order_no);
    }
  } catch (err) {
    this.logger.warn(`[BILLING] 自动查单失败（不影响家长读路径）: ${order.order_no} ${err}`);
  }
}
```

- [ ] **Step 3: Commit** — `git commit -m "feat(billing): 订单详情 pending 时限频自动查渠道（扫码零点击到账）"`

### Task 3: 裁决链路（claim 状态机）后端

**Files:**
- Modify: `apps/server/src/modules/billing/billing.service.ts`（confirmPayment 2004 分支落 claim；finalize 成功路径若 claim=pending_review → approved；新增 admin claims 列表 + approve/reject）
- Modify: `apps/server/src/database/repositories/orders.repo.ts`（claim 读写 + 列表查询）
- Modify: `apps/server/src/modules/billing/admin-billing.controller.ts`
- Modify: `apps/server/src/modules/billing/billing.controller.ts`（confirm-paid body 加可选 `note?`）
- Test: 两个 test 文件追加

**Interfaces:**
- Produces:
  - `confirmPayment(parentId, orderNo, note?)`：2004 分支改为——落 claim（`claim_status='pending_review'`、`claimed_at=now`、note ≤200 字存 `claim_note`，重复点击刷新时间戳幂等）后抛 2004，message 改「渠道尚未确认，已转人工核实」；响应体（成功路径）与 2004 错误体均带 `claimStatus`
  - `finalizePaidOrder` 成功后：若该单 claim_status='pending_review' → 置 `'approved'`（放 finalize 事务外一条 UPDATE 即可，失败只 warn）
  - `listClaims(status, page, pageSize)`：JOIN parents（手机号）分页列表 `{items: {orderNo, parentPhone, planName, amountCents, claimStatus, claimedAt, claimNote, paymentStatus}, total, page, pageSize}`
  - `approveClaim(orderNo, adminId)`：claim 必须为 pending_review（否则 2002）；复用 `adminMarkPaid` 语义（markPaidTx 已放行 pending|expired；cancelled → 2002）+ `claim_status='approved'`
  - `rejectClaim(orderNo, adminId, reason?)`：claim 必须为 pending_review（否则 2002）→ `'rejected'`，reason 追加到 claim_note 尾部（`原note；驳回：reason`，截断 200）
- [ ] **Step 1: 失败测试**：confirm 2004 → claim 落库（note 透传）；重复 confirm 幂等刷新；finalize 成功 → approved 自动闭环；approve（含 expired 单）→ paid + approved；approve cancelled → 2002；reject → rejected + reason 追加；listClaims 形状与分页
- [ ] **Step 2: 跑失败 → 实现 → 通过**（repo 新增：`markClaim(orderId, status, note?)`、`findClaims(status, page, pageSize)` JOIN parents）
- [ ] **Step 3: admin controller 加 3 端点**：`GET /api/admin/billing/orders/claims?status=&page=&pageSize=`（@Roles('admin')，status 缺省 pending_review，非法值 400/1001）、`POST /api/admin/billing/orders/{orderNo}/claims/approve`、`POST .../claims/reject`（body 可带 reason）。**路由顺序**：`claims` 字面路径必须注册在 `:orderNo` 参数路由**之前**（Nest 路由匹配顺序，别被参数路由吞掉）
- [ ] **Step 4: Commit** — `git commit -m "feat(billing): 支付裁决链路——claim 状态机 + admin 列表/通过/驳回"`

### Task 4: 线下转账渠道（家长侧 manual，当前主路径）

**Files:**
- Modify: `apps/server/src/modules/billing/billing.service.ts`（createOrder 放开 manual；confirmPayment 对 manual 跳过查单、note 必填直接落 claim）
- Test: `billing.service.test.ts` 追加

**Interfaces:**
- Produces:
  - `createOrder(parentId, {planCode, channel:'manual'})`：合法；**不走适配器**——订单 pending、`channel_trade_no/channel_qr_content` 均 NULL、无渠道调用；防串单/2h 超时同样适用。返回 OrderView `qrContent=null, redirectUrl=null`
  - `confirmPayment` 对 manual 单：跳过渠道查单（无渠道可查），**note 必填**（空 → 400/1001「请填写转账备注」）→ 直接落 claim `pending_review`（note 存 claim_note）→ 抛 2004（message 同「渠道尚未确认，已转人工核实」，claimStatus='pending_review'）
  - 自动查单（Task 2）天然跳过 manual（channel 白名单外）；admin approve 对 manual 单走既有 `adminMarkPaid`（markPaidTx 放行 pending|expired）
- [ ] **Step 1: 失败测试**：manual 下单成功且无渠道调用、无二维码；manual confirm 无 note → 400/1001；note 有 → claim pending_review；manual 单 GET detail 不触发自动查单；manual 单 2h 超时 expired 照常
- [ ] **Step 2: 跑失败 → 实现 → 通过**
- [ ] **Step 3: Commit** — `git commit -m "feat(billing): 家长侧线下转账渠道（manual）——个人微信收款 + 裁决手工开通"`

### Task 5: 试用 / 订阅管理后端

**Files:**
- Create: `apps/server/src/database/repositories/subscription-adjustments.repo.ts`
- Modify: `apps/server/src/database/repositories/family-subscriptions.repo.ts`（`adjustPeriod(parentId, days, now)`、`setTrial(parentId, trialEndsAt|null, now)`——带 FOR UPDATE 行锁，冗余 status 同步 effectiveStatus 推导）
- Modify: `apps/server/src/modules/billing/subscriptions.service.ts`、`admin-billing.controller.ts`、billing.module（repo 注册 + 装配钉子补）
- Test: 追加

**Interfaces:**
- Produces:
  - `GET /api/admin/billing/families?keyword=&page=&pageSize=` → `{items: {parentId, phone, studentCount, status, planCode, trialEndsAt, currentPeriodEnd}, total, ...}`（keyword 匹配家长手机号/昵称，LIKE）
  - `PUT /api/admin/billing/families/{parentId}/trial` body `{trialEndsAt: string ISO | null}` → upsert trial 行 + adjustments(type='trial_set') 落痕 + logger → 200 StatusView
  - `POST /api/admin/billing/families/{parentId}/grant` body `{days: number, reason?}` → days≠0（0 → 400/1001）；事务：行锁读 → 顺延规则（current_period_end 未来从其顺延 / 否则从 now；**负数扣减同理**，扣到 < now 置 current_period_end=NULL 即过期态）+ adjustments 落痕 + logger → 200 StatusView
- [ ] **Step 1: 失败测试**（mock pool/repo）：trial 设定/收回（null）；grant 正数顺延不吞天数、负数扣减、扣穿置过期；无行家庭 grant → 补偿插入（沿用 renewWithinTx 补偿模式）；adjustments 每次操作落一行；family 列表分页与 keyword
- [ ] **Step 2: 跑失败 → 实现 → 通过**
- [ ] **Step 3: Commit** — `git commit -m "feat(billing): 管理端试用/订阅天数管理（adjustments 审计）"`

### Task 6: 前端——家长弹层 claim 三态 + 线下转账

**Files:**
- Modify: `apps/web/src/services/api.ts`（`confirmBillingOrderPaid(orderNo, note?)`；`BillingOrderView` 加 `claimStatus?: 'pending_review'|'rejected'|'approved'|null`、`claimNote?`）
- Modify: `apps/web/src/pages/parent/ParentSubscriptionPage.tsx`
- Test: 追加

**Interfaces / 行为：**
- 渠道选择三选：微信支付 / 支付宝 / **线下转账**；选线下转账下单成功后弹层不放二维码，显示「请联系管理员付款（个人微信转账），付款后填写转账备注并点击我已付款」——备注输入框**必填**
- 微信/支付宝渠道在商户号未配置时下单得到 2003「支付渠道未配置」——错误文案直接展示，引导改选线下转账
- 弹层按 `claimStatus` 三态：`pending_review` → 提示「已转人工核实，管理员确认后自动开通」+ 停用「我已付款」按钮；`rejected` → 「管理员未确认本次支付，请核实后重试」+ 重新点亮按钮（备注框可改）；undefined → 现状不变
- 订单历史 pending + claimStatus='pending_review' 行加「人工核实中」徽标

- [ ] **Step 1: 失败测试**（三态渲染 + note 透传 + rejected 后按钮重亮）
- [ ] **Step 2: 实现 → 通过** → **Commit** — `git commit -m "feat(web): 支付弹层裁决三态（转人工/驳回重试）"`

### Task 7: 前端——管理端 AdminBillingPage + 角标

**Files:**
- Create: `apps/web/src/pages/admin/AdminBillingPage.tsx`（骨架参照 `AdminAlertsPage.tsx`）
- Create: `apps/web/src/services/api.ts` 追加 admin 函数：`listBillingClaims(status,page,pageSize)` / `approveBillingClaim(orderNo)` / `rejectBillingClaim(orderNo, reason?)` / `listBillingFamilies(keyword,page,pageSize)` / `setFamilyTrial(parentId, trialEndsAt)` / `grantFamilyDays(parentId, days, reason?)`
- Modify: `apps/web/src/routes/routeTable.tsx`（/admin/billing 挂 admin layout，参照 AdminAlertsPage）+ admin 侧栏加「订阅裁决」项（角标数字 = pending_review 数，惰性拉取，照 SubscriptionNoticeBar 的「失败静默」口径）
- Test: 新文件

**Interfaces / 行为：**
- Tab 1 待裁决：列表（家长手机号/套餐/金额/主张时间/备注）+ 行内「现场核验」（调 `GET /orders/{orderNo}` 的 admin 版——若无 admin 版订单详情则直接触发行刷新并提示，**不新增家长越权端点**）+「通过」（approve → 行消失、角标减）+「驳回」（填原因 → reject）
- Tab 2 家庭订阅：搜索 + 列表 + 「调整试用」（日期控件 / 收回按钮）+「赠送/扣减天数」（数字 + 原因，正负号即方向）→ 成功后行内 StatusView 刷新
- [ ] **Step 1: 失败渲染测试**（claims 列表渲染/角标/approve 后行消失/reject 表单/family 调整表单）
- [ ] **Step 2: 实现 → 通过** → **Commit** — `git commit -m "feat(web): 管理端订阅裁决与家庭订阅管理"`

### Task 8: 收尾

- [ ] **Step 1: 两端全量 + tsc**：`cd apps/server && npm test && npx tsc --noEmit`；`cd apps/web && npm test && npx tsc -b`
- [ ] **Step 2: 文档同步**：API 文档 v4.16（§4.15 补 confirm-paid 的 note/claimStatus 与自动查单行为、§4.17 admin 加 5 端点、§9 日志）、openapi（+5 admin op + schema 变更）、PRD §7.7 注记补「人工裁决与试用管理已实现（2026-09-30）」
- [ ] **Step 3: mock 冒烟**：`BILLING_USE_MOCK=1 node dist/main.js`（build 后）——家长下单 → （mock 无查单语义，跳过自动到账）→ 点我已付款带 note → 管理员列表看到 pending_review → 驳回 → 家长重试 → 管理员通过 → 订阅生效；family 调整试用/赠送天数各一次
- [ ] **Step 4: 台账收尾 + Commit** — `.superpowers/sdd/progress.md` 批④节
