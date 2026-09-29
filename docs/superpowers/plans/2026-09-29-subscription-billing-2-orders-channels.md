# 订阅收费（②）订单 + 支付渠道 + 回调 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** orders 状态机（pending→paid/cancelled/expired）+ 微信 Native / 支付宝当面付适配器 + 免 JWT 验签回调 + confirm-paid 主动查单兜底 + admin mark-paid + `/api/quota/plans`、`/api/quota/usage`。

**Architecture:** 渠道差异收敛进 `PayChannelAdapter`（统一产出二维码/查单/验签回调）；置 paid 与订阅续期同事务（`FOR UPDATE` 行锁）；`channel_trade_no` UNIQUE + 已 paid 幂等返回双保险；超时惰性翻转，零调度。

**Tech Stack:** NestJS + mysql2 + node:crypto（RSA-SHA256 签名/验签、AES-256-GCM 解密）+ vitest（渠道用 Mock 适配器，真渠道联调留人工验收）。

**Spec:** `docs/superpowers/specs/2026-09-29-subscription-billing-design.md` §3/§5/§7。错误码：2002 状态不允许 / 2003 渠道异常 / 2004 未确认支付 / 2005 套餐不存在。

## Global Constraints

- **`LIMIT ?` 占位符必须 `pool.query`，不得 `pool.execute`**（仓内血泪约定，有护栏测试）
- Nest `@Post` 默认 201：`POST /orders` 记 201；**回调端点必须 `@HttpCode(200)`**（渠道要求）
- 回调免 JWT：`req.user` 为 undefined，SubscriptionGuard/登录取证天然放行；验签自证身份
- 渠道密钥本期走 env（`.env`）；DB 化配置留后续（模型配置先例），spec §5.2 已注明
- 响应统一 `{code, message, data}` 由既有拦截器包装；controller 直接返回 data
- 新端点全部进批③的 API 文档 v4.14 / openapi，本批不改文档

---

### Task 1: 渠道适配器接口 + Mock + 工厂 + 配置

**Files:**
- Create: `apps/server/src/modules/billing/pay-channel.types.ts`
- Create: `apps/server/src/modules/billing/adapters/mock-pay.adapter.ts`
- Create: `apps/server/src/modules/billing/adapters/wechat-native-pay.adapter.ts`（Task 3 填实现，先建骨架）
- Create: `apps/server/src/modules/billing/adapters/alipay-qr-pay.adapter.ts`（同上）
- Create: `apps/server/src/modules/billing/pay-signing.ts`

**Interfaces:**
- Produces（Task 2/4 依赖）:

```typescript
// pay-channel.types.ts
export type PayChannel = 'wechat' | 'alipay';

export interface ChannelOrderResult {
  tradeNo: string;          // 渠道交易号/预下单号
  qrContent: string | null; // 二维码内容（code_url / qr_code）
  redirectUrl: string | null; // 支付宝跳转形态降级用
}

export interface ChannelQueryResult {
  paid: boolean;
  tradeNo: string | null;
  amountCents: number | null;
}

export interface CallbackPayload {
  orderNo: string;      // 商户单号 out_trade_no
  tradeNo: string;      // 渠道交易号
  paid: boolean;        // trade_state/TRADE_SUCCESS 判定
  amountCents: number;
}

export interface ChannelHttpResponse { httpStatus: number; body: string; contentType: string }

export interface PayChannelAdapter {
  channel: PayChannel;
  createOrder(input: { orderNo: string; amountCents: number; description: string }): Promise<ChannelOrderResult>;
  queryOrder(orderNo: string): Promise<ChannelQueryResult>;
  verifyCallback(headers: Record<string, string | string[] | undefined>, rawBody: Buffer): Promise<CallbackPayload>;
  successResponse(): ChannelHttpResponse;   // 微信 200 {"code":"SUCCESS"}；支付宝 200 "success"
  failureResponse(message: string): ChannelHttpResponse; // 微信 500 {"code":"FAIL"}；支付宝 200 "failure"
}
```

- [ ] **Step 1: 写 `pay-signing.ts`**（两个适配器共用，node:crypto）

```typescript
import { createSign, createVerify, createDecipheriv } from 'node:crypto';

export function rsaSha256Sign(privateKeyPem: string, data: string): string {
  const signer = createSign('RSA-SHA256');
  signer.update(data);
  return signer.sign(privateKeyPem, 'base64');
}

export function rsaSha256Verify(publicKeyPem: string, data: string, signatureB64: string): boolean {
  try {
    const verifier = createVerify('RSA-SHA256');
    verifier.update(data);
    return verifier.verify(publicKeyPem, signatureB64, 'base64');
  } catch {
    return false;
  }
}

/** 微信回调 resource 解密：AES-256-GCM，key=APIv3 key(32B)，nonce，AAD=associated_data */
export function wechatAesGcmDecrypt(apiV3Key: string, nonce: string, aad: string, ciphertextB64: string): string {
  const buf = Buffer.from(ciphertextB64, 'base64');
  const data = buf.subarray(0, buf.length - 16);
  const authTag = buf.subarray(buf.length - 16);
  const decipher = createDecipheriv('aes-256-gcm', Buffer.from(apiV3Key, 'utf8'), Buffer.from(nonce, 'utf8'));
  decipher.setAuthTag(authTag);
  decipher.setAAD(Buffer.from(aad, 'utf8'));
  return Buffer.concat([decipher.update(data), decipher.final()]).toString('utf8');
}

export function randomNonce(): string {
  return Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
}
```

- [ ] **Step 2: 写 MockPayAdapter**（测试/无商户号环境兜底）：`createOrder` 返回 `{tradeNo: 'MOCK-'+orderNo, qrContent: 'mock://pay/'+orderNo, redirectUrl: null}`；`queryOrder` 按构造开关 `autoPaid` 返回；`verifyCallback` 解析 rawBody JSON `{orderNo, tradeNo, paid, amountCents}`；success/failure 返回 JSON。

- [ ] **Step 3: 渠道未配置语义**——真实适配器构造时读 env（Task 3/4 列清单），任何必需项缺失 → `createOrder/queryOrder` 直接 `throw new HttpException({ code: 2003, message: '支付渠道未配置' }, 503)`。工厂（`billing.module.ts` providers）始终注册真实适配器 + Mock；`MockPayAdapter` 仅在 `NODE_ENV==='test'` 或 `BILLING_USE_MOCK==='1'` 时被 `BillingService` 选用。

- [ ] **Step 4: Commit** — `git commit -m "feat(billing): 渠道适配器接口 + 签名工具 + Mock 适配器"`

---

### Task 2: wechat-native-pay.adapter.ts（微信 Native 扫码，APIv3）

**Files:**
- Create（实现）: `apps/server/src/modules/billing/adapters/wechat-native-pay.adapter.ts`
- Test: `apps/server/src/modules/billing/adapters/wechat-native-pay.adapter.test.ts`

**Interfaces:**
- Consumes: Task 1 的类型与 `pay-signing.ts`
- Produces: `WechatNativePayAdapter implements PayChannelAdapter`（`channel='wechat'`）

env 清单（缺一即 2003）：`WXPAY_MCHID`、`WXPAY_APPID`、`WXPAY_SERIAL_NO`、`WXPAY_PRIVATE_KEY_PATH`、`WXPAY_APIV3_KEY`、`WXPAY_PLATFORM_CERT_PATH`、`WXPAY_NOTIFY_URL`。

- [ ] **Step 1: 写适配器**（要点全列，fetch + node:crypto，无第三方 SDK）

```typescript
// 下单：POST https://api.mch.weixin.qq.com/v3/pay/transactions/native
// Authorization: WECHATPAY2-SHA256-RSA2048 mchid="{mchid}",nonce_str="{n}",signature="{s}",timestamp="{ts}",serial_no="{serial}"
// 签名串：`POST\n/v3/pay/transactions/native\n{ts}\n{n}\n{body}\n`，商户私钥 RSA-SHA256
// Body: { appid, mchid, description, out_trade_no, notify_url, amount: { total: amountCents } }
// 成功响应 { code_url } -> qrContent；tradeNo 用 out_trade_no 回查前暂存 null（微信下单无 tradeNo，回调才发）——
//   ChannelOrderResult.tradeNo 此时返回 out_trade_no 同值占位会被 UNIQUE 冲突，
//   故微信 createOrder 返回 tradeNo: null，订单行 channel_trade_no 留 NULL，等回调/查单回填。
// 查单：GET /v3/pay/transactions/out-trade-no/{orderNo}?mchid={mchid}
//   签名串：`GET\n/v3/pay/transactions/out-trade-no/{orderNo}?mchid={mchid}\n{ts}\n{n}\n\n`（body 空）
//   响应 { trade_state, transaction_id, amount: { total } }，trade_state === 'SUCCESS' 即 paid
// 回调验签：headers Wechatpay-Timestamp/Nonce/Signature/Serial
//   验签串：`{ts}\n{n}\n{rawBody}\n`，平台证书公钥（WXPAY_PLATFORM_CERT_PATH）RSA-SHA256
//   Serial 与配置证书不符 -> 验签失败（真实多证书轮换留后续）
//   解密 resource：wechatAesGcmDecrypt(apiV3Key, resource.nonce, resource.associated_data, resource.ciphertext)
//   -> { out_trade_no, transaction_id, trade_state, amount: { total } }
//   trade_state 'SUCCESS' -> paid
```

按以上注释逐条实现（每条一个私有方法：`buildAuthHeader(method, urlPath, body)`、`createOrder`、`queryOrder`、`verifyCallback`）。URL path 参与签名必须与请求行完全一致（含 query）。

- [ ] **Step 2: 测试**（生成测试 RSA 密钥对 + 假平台证书，`crypto.generateKeyPairSync('rsa', 2048)`）：
  - `createOrder` 发出的 Authorization 头可用公钥验签还原签名串；body 含 `out_trade_no/amount.total`
  - `verifyCallback`：用私钥签 `{ts}\n{n}\n{raw}\n` 构造 headers → 验签通过；payload 解密出 `out_trade_no/transaction_id/amount.total`；错签 → 抛错（由 service 转 failure 应答）
  - AES-GCM 解密往返：用 APIv3 key 加密样例 resource → decrypt 还原
- [ ] **Step 3: 跑测试 + Commit** — `git commit -m "feat(billing): 微信 Native 适配器（APIv3 下单/查单/回调验签解密）"`

---

### Task 3: alipay-qr-pay.adapter.ts（当面付扫码）

**Files:**
- Create（实现）: `apps/server/src/modules/billing/adapters/alipay-qr-pay.adapter.ts`
- Test: `apps/server/src/modules/billing/adapters/alipay-qr-pay.adapter.test.ts`

**Interfaces:**
- Produces: `AlipayQrPayAdapter implements PayChannelAdapter`（`channel='alipay'`）

env 清单：`ALIPAY_APP_ID`、`ALIPAY_GATEWAY`（默认 `https://openapi.alipay.com/gateway`）、`ALIPAY_APP_PRIVATE_KEY_PATH`、`ALIPAY_ALIPAY_PUBLIC_KEY_PATH`、`ALIPAY_NOTIFY_URL`。

- [ ] **Step 1: 实现**（要点）：

```text
公共参数（form-urlencoded POST 到 gateway）：app_id, method, format=JSON, charset=utf-8,
  sign_type=RSA2, timestamp=「UTC+8 的 yyyy-MM-dd HH:mm:ss」, version=1.0, notify_url, biz_content(JSON)
签名：除 sign 外全部参数按 key ASCII 升序 join `k=v&`，app 私钥 RSA-SHA256 -> base64
当面付下单 method=alipay.trade.precreate，biz_content={out_trade_no, total_amount:「分->元两位小数字符串」},
  subject=description；响应 alipay_trade_precreate_response.code==='10000' 且 qr_code -> qrContent，
  tradeNo = out_trade_no（支付宝无独立预单号，查单按 out_trade_no）
查单 method=alipay.trade.query，biz_content={out_trade_no}；响应 trade_status ∈ {TRADE_SUCCESS, TRADE_FINISHED} 即 paid，
  trade_no/receipt_amount（元字符串转分）
回调（notify_url，form-encoded）：剔除 sign/sign_type 后按 key 升序 join，
  支付宝公钥 RSA-SHA256 验 sign；再校验 out_trade_no、total_amount（元->分 与订单一致，金额校验主责在 service）、
  trade_status ∈ {TRADE_SUCCESS, TRADE_FINISHED}；应答纯文本 success / failure（HTTP 都 200）
```

- [ ] **Step 2: 测试**（同 Task 2 手法：生成密钥对、构造签名报文、验证签名串与参数序、金额分↔元换算边界如 `1` -> `"0.01"`、`19800` -> `"198.00"`）
- [ ] **Step 3: 跑测试 + Commit**

---

### Task 4: orders.repo + BillingService 状态机

**Files:**
- Create: `apps/server/src/database/repositories/orders.repo.ts`
- Create: `apps/server/src/modules/billing/billing.service.ts`
- Test: `apps/server/src/modules/billing/billing.service.test.ts`（mock repo/adapter/subs）

**Interfaces:**
- Consumes: 批① `SubscriptionsService.renewWithinTx(conn, parentId, planCode, durationDays, now)`、Task 1 适配器
- Produces:
  - `BillingService.createOrder(parentId, {planCode, channel}): Promise<OrderView>`（2005/2002/2003 语义见 spec §5.2；同套餐同渠道 pending 复用返回；渠道失败抛 2003 且订单保留 pending）
  - `BillingService.listOrders(parentId, page, pageSize)`（读时惰性翻转；`{items, total, page, pageSize}`，items 含 `orderNo/paymentStatus/amountCents/planName/channel/createdAt/expiresAt/paidAt`）
  - `BillingService.getOrder(parentId, orderNo): Promise<OrderDetailView>`（归属 1005；含 `qrContent/redirectUrl` 供弹层复用）
  - `BillingService.cancel(parentId, orderNo)`（非 pending → 2002）
  - `BillingService.confirmPaid(parentId, orderNo)`（查单 paid → finalize；未支付 → 2004；渠道异常 → 2003）
  - `BillingService.finalizePaidOrder(orderRow, tradeNo, now): Promise<'paid' | 'duplicate'>`（**单事务**：`markPaidTx` affectedRows=0 → ROLLBACK 返回 duplicate；否则 `renewWithinTx` 后 COMMIT）
  - `BillingService.handleCallback(channel, headers, rawBody): Promise<ChannelHttpResponse>`（验签→找单→`order.channel !== channel` 视为无效→金额不符 warn+alert 不入账→已 paid 直接 success（幂等）→pending 则 finalize→按适配器返回应答）
  - `BillingService.adminMarkPaid(orderNo)`（channel='manual'，tradeNo=`manual-${orderNo}`，已 paid 幂等成功，非 pending → 2002）
  - orders.repo：`insertOrder / findByOrderNo / findPendingByParent / listByParent(分页) / expireStale() / markPaidTx(conn, orderId, tradeNo, paidAt): Promise<number>`；`ORDER_EXPIRE_MINUTES = 120`

- [ ] **Step 1: 写失败测试**（重点用例，全部 mock 依赖）：
  1. `createOrder`：套餐下架 → 2005；同套餐同渠道已有 pending → 复用返回且**不**新建行、**不**调适配器；换套餐 → 2002；适配器抛错 → 2003 且订单仍 pending
  2. `finalizePaidOrder`：markPaidTx 影响行 1 → 续期被调、COMMIT、返回 'paid'；影响行 0 → ROLLBACK、不续期、返回 'duplicate'
  3. `handleCallback`：金额不符 → 不 finalize、返回 failureResponse；已 paid 订单重复通知 → success 且**不**再 finalize；order.channel 不符 → failure；验签抛错 → failureResponse
  4. `confirmPaid`：查单 paid → finalize 'paid'；未支付 → HttpException 2004
  5. `cancel`：非 pending → 2002；pending → cancelled
  6. `getOrder/listOrders` 先调 `expireStale()`（惰性翻转）
- [ ] **Step 2: 跑失败 → 实现 → 通过**。事务骨架：

```typescript
async finalizePaidOrder(order: OrderRow, tradeNo: string, now = new Date()): Promise<'paid' | 'duplicate'> {
  const conn = await this.pool.getConnection();
  try {
    await conn.beginTransaction();
    const affected = await this.ordersRepo.markPaidTx(conn, order.id, tradeNo, now);
    if (affected === 0) { await conn.rollback(); return 'duplicate'; }
    const snap = order.plan_snapshot as { planCode: string; durationDays: number };
    await this.subscriptionsService.renewWithinTx(conn, order.parent_id, snap.planCode, snap.durationDays, now);
    await conn.commit();
    return 'paid';
  } catch (err) { await conn.rollback(); throw err; }
  finally { conn.release(); }
}
```

- [ ] **Step 3: orders.repo 实现**——**分页查询用 `pool.query`**：

```typescript
async listByParent(parentId: number, page: number, pageSize: number) {
  const offset = (page - 1) * pageSize;
  const [[cntRows], [rows]] = await Promise.all([
    this.pool.query<RowDataPacket[]>(`SELECT COUNT(*) AS total FROM orders WHERE parent_id = ?`, [parentId]),
    this.pool.query<RowDataPacket[]>(
      `SELECT * FROM orders WHERE parent_id = ? ORDER BY id DESC LIMIT ? OFFSET ?`,
      [parentId, pageSize, offset], // LIMIT/OFFSET 占位符：必须 pool.query（pool.execute 会被 MySQL 拒）
    ),
  ]);
  return { total: Number(cntRows[0].total), rows: rows as OrderRow[] };
}
```

`markPaidTx`：`UPDATE orders SET payment_status='paid', channel_trade_no=?, paid_at=? WHERE id=? AND payment_status='pending'` → `affectedRows`。

- [ ] **Step 4: Commit** — `git commit -m "feat(billing): 订单状态机 + finalize 事务续期 + 回调处理"`

---

### Task 5: billing.controller（家长端点）+ callback controller + admin mark-paid

**Files:**
- Create: `apps/server/src/modules/billing/billing.controller.ts`（`@Controller('api/billing')`，`@Roles('parent')`）
- Create: `apps/server/src/modules/billing/billing-callback.controller.ts`（`@Controller('api/billing/callback')`，免 JWT/角色）
- Create: `apps/server/src/modules/billing/admin-billing.controller.ts`（`@Controller('api/admin/billing')`，`@Roles('admin')`）
- Modify: `apps/server/src/main.ts`（`NestFactory.create<NestExpressApplication>(AppModule, { rawBody: true })`——回调验签需要原始 body）

**Interfaces:**
- Produces（形状进批③文档任务）:
  - `POST /api/billing/orders` body `{planCode, channel}` → **201** `OrderView {orderNo, paymentStatus, amountCents, qrContent, redirectUrl, expiresAt}`
  - `GET /api/billing/orders?page=&pageSize=` → `{items, total, page, pageSize}`（pageSize 1..50 默认 20，越界 400/1001 不钳制）
  - `GET /api/billing/orders/{orderNo}` → `OrderDetailView`
  - `POST /api/billing/orders/{orderNo}/cancel` → 200 `{orderNo, paymentStatus:'cancelled'}`
  - `POST /api/billing/orders/{orderNo}/confirm-paid` → 200 `{orderNo, paymentStatus:'paid', currentPeriodEnd}`；2004/2003
  - `POST /api/billing/callback/{channel}` → `@HttpCode(200)` 返回适配器应答（微信 JSON / 支付宝纯文本），取参 `@Param('channel') channel: PayChannel` + `@Req() req: RawBodyRequest<Request>`（`req.rawBody!`）+ `@Headers() headers`
  - `POST /api/admin/billing/orders/{orderNo}/mark-paid` → 200；已 paid 幂等成功，非 pending → 2002

- [ ] **Step 1: 写三个 controller**（薄层：参数校验 DTO/管道按仓内既有 controller 风格；callback 里 `channel` 不在 `['wechat','alipay']` → 404/1002）
- [ ] **Step 2: 测试**——callback：mock service，断言 rawBody 透传、微信 success 应答 httpStatus=200；`POST /orders` 返回 201（Nest 默认）；admin mark-paid 归属不经家长校验。
- [ ] **Step 3: main.ts rawBody + module wiring**（`BillingModule` imports 进 `AppModule`；`SubscriptionsService` export 给 `AuthModule` 批①已完成）
- [ ] **Step 4: 全量测试 + Commit** — `npm test` 全绿 → `git commit -m "feat(billing): billing 三组端点 + 免 JWT 验签回调 + admin mark-paid"`

---

### Task 6: `/api/quota/plans` + `/api/quota/usage`（补进批① 的 quota.controller）

**Files:**
- Modify: `apps/server/src/modules/billing/quota.controller.ts`、`subscriptions.service.ts`
- Create: `apps/server/src/database/repositories/llm-usage.repo.ts`（或并入既有 llm-call-logs.repo，先读该文件与 schema.sql 的 `llm_call_logs` 列名——**以真实列名为准，下方 SQL 的列名占位要替换**）
- Test: `subscriptions.service.test.ts` 追加

**Interfaces:**
- Produces:
  - `GET /api/quota/plans` → `[{planCode, name, priceCents, durationDays}]`（家长+学生+admin 可读）
  - `GET /api/quota/usage`（**仅家长**，学生 403/1003）→ `{periodStart, periodEnd, calls, inputTokens, outputTokens, tokensUnknown, byDay}`

- [ ] **Step 1: 口径定死**（写入 service 注释）：`periodEnd = currentPeriodEnd ?? now`；`periodStart = periodEnd - 30 天`（rolling 30 天，**不按订阅周期起算**——orders 未存 period_start，spec §5.1 的「当前订阅周期」以该近似口径落地，批③ PRD 注记写明）；聚合范围 = 该家长名下所有学生。
- [ ] **Step 2: 聚合查询**（NULL 语义仓规：NULL = 量不到，**绝不按 0 混入**，单列计数）：

```sql
SELECT DATE(created_at) AS day, COUNT(*) AS calls,
       SUM(input_tokens) AS input_tokens, SUM(output_tokens) AS output_tokens,
       SUM(input_tokens IS NULL OR output_tokens IS NULL) AS tokens_unknown
FROM llm_call_logs l JOIN students s ON l.student_id = s.id   -- 列名以 schema.sql 实际为准
WHERE s.parent_id = ? AND l.created_at >= ? AND l.created_at < ?
GROUP BY DATE(created_at) ORDER BY day
```

服务层把 `SUM(*)` 的 NULL（窗口内无行/全 NULL）归零、`tokensUnknown` 保留独立计数；`byDay` 补空日为 0 调用（前端画图友好，可省——实施时从简，只回有数据的 day）。
- [ ] **Step 3: 测试**（mock repo）：家长视角聚合形状；学生调 usage → 403/1003；plans 只含 active。
- [ ] **Step 4: 全量 + Commit** — `git commit -m "feat(billing): /api/quota/plans + /usage（AI 用量只展示聚合）"`

---

### Task 7: 批② 收尾

- [ ] **Step 1: 全量测试 + tsc**：`cd apps/server && npm test && npx tsc --noEmit` 全绿
- [ ] **Step 2: 手工冒烟（BILLING_USE_MOCK=1）**：`node dist/main.js` 起服务 → 家长 JWT 下单（mock 码）→ mock 回调 POST（构造 rawBody JSON）→ `GET /api/quota/subscription` 看 `current_period_end` 顺延 → 学生 JWT 打业务端点仍 200；`trial_ends_at` 改过期后 → 403/2001
- [ ] **Step 3: Commit 收尾 + push 由用户决定**（本批无文档同步，批③统一做）

### 批② 交付边界

- 完成后：完整下单→支付→回调→续期链路可用（mock 渠道）；真渠道需在 `.env` 配商户密钥后人工验收（spec §8）。
- 不含：前端页面、文档同步（批③）。
