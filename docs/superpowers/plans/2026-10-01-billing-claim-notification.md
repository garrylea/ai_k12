# 订阅裁决结果通知（批④补丁）实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.
> 进度台账续写 `/.superpowers/sdd/progress.md`，新开节「裁决通知补丁」。

**Spec:** `docs/superpowers/specs/2026-10-01-billing-claim-notification-design.md`（列定义、错误码、状态机以其为准）

**Goal:** 修复批④人工验收两缺陷——①家长被驳回后全端不可见（订单历史缺 rejected 徽标、无跨页通知）；②管理端待裁决红点处理后不消失（AdminNav 一次性拉取 + 「切页重挂」错误假设）。落地方案：新表 `billing_notices` 未读持久化 + 家长顶栏裁决结果条 + 管理端红点 Zustand 联动。

**Architecture:** 裁决状态迁移的三个代码挂点（approveClaim duplicate 补挂分支 / rejectClaim / finalizePaidOrder claim 闭环挂点）写通知行，失败只 warn 不阻断裁决；家长端两个端点（拉未读 / ack 已读）；前端 `BillingNoticeBar` 独立组件进 `ParentLayout` 顶栏（与 AlertBanner/SubscriptionNoticeBar 并列）；管理端角标改 Zustand store，AdminBillingPage 裁决后主动 refresh。

**Tech Stack:** NestJS + mysql2 + React 18 + Zustand；无新依赖。

## Global Constraints

- 迁移幂等 + 同步 `tools/db/schema.sql`；`updated_at` 列级 `ON UPDATE CURRENT_TIMESTAMP(3)`，不建触发器
- `LIMIT ?` 不走占位符（本计划 listUnread 用字面量 `LIMIT 50`，天然避开）
- 错误码：2002 非法状态 / 1001 参数 / 1002 不存在 / 1005 归属
- 通知写入失败 **catch + logger.warn，绝不阻断裁决主链路**（对齐「埋点不阻断主链路」仓规）
- 前端：无 emoji、CSS 变量配色、组件测试 `afterEach(cleanup)`、线性 SVG
- 每任务独立 commit；服务端验收 `npx vitest run src/modules/billing && npx tsc --noEmit`，批尾全量
- ack 端点显式 `@HttpCode(200)`——本仓第二处覆盖，CLAUDE.md「唯一覆盖」表述随 Task 7 同步

## 文件结构总览

```
Create:
  tools/db/migrations/2026-10-01_billing_notices.sql
  apps/server/src/database/repositories/billing-notices.repo.ts
  apps/web/src/pages/parent/BillingNoticeBar.tsx        (+ .test.tsx)
  apps/web/src/store/adminBillingBadgeStore.ts
  apps/web/src/components/layout/AdminNav.test.tsx      （AdminNav 无既有测试，改动必须补）
Modify:
  tools/db/schema.sql                                   （9.5 节尾加表）
  apps/server/src/modules/billing/billing.service.ts    （注入 repo + notifyClaimResult + 3 挂点 + 2 方法）
  apps/server/src/modules/billing/billing.controller.ts （+2 端点）
  apps/server/src/modules/billing/billing.module.ts     （注册 repo）
  apps/server/src/modules/billing/billing.service.test.ts / billing.controller.test.ts
  apps/web/src/services/api.ts                          （+2 函数 + BillingNoticeView）
  apps/web/src/components/layout/ParentLayout.tsx / AdminNav.tsx
  apps/web/src/pages/parent/ParentSubscriptionPage.tsx / AdminBillingPage.tsx
  若干家长页 *.test.tsx（api mock 补一行）
```

---

### Task 1: 迁移——billing_notices 表

**Files:**
- Create: `tools/db/migrations/2026-10-01_billing_notices.sql`
- Modify: `tools/db/schema.sql`（「9.5 订阅与计费」节尾，`subscription_adjustments` 之后）

**Interfaces:**
- Produces: 表 `billing_notices`，列 `id BIGINT PK AI / parent_id INT NOT NULL FK→parents(id) / type ENUM('claim_approved','claim_rejected') NOT NULL / order_no VARCHAR(64) NOT NULL / reason VARCHAR(200) NULL / is_read TINYINT(1) NOT NULL DEFAULT 0 / created_at DATETIME(3) DEFAULT CURRENT_TIMESTAMP(3) / updated_at DATETIME(3) DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3)`，`KEY idx_parent_unread (parent_id, is_read, id)`

- [ ] **Step 1: 写迁移**

```sql
-- 订阅裁决结果通知（批④补丁）：approve/reject/自动闭环各落一行未读，家长 ack 后 is_read=1。
-- 无 (order_no,type) 唯一键：同单「驳回→重新主张→通过」两条通知均为有效事件，防重靠只在状态迁移时写入。
CREATE TABLE IF NOT EXISTS billing_notices (
  id         BIGINT       NOT NULL AUTO_INCREMENT,
  parent_id  INT          NOT NULL COMMENT '家长 id（通知归属）',
  type       ENUM('claim_approved','claim_rejected') NOT NULL COMMENT '裁决结果',
  order_no   VARCHAR(64)  NOT NULL COMMENT '关联订单号',
  reason     VARCHAR(200) NULL COMMENT '驳回原因；approve 为 NULL',
  is_read    TINYINT(1)   NOT NULL DEFAULT 0 COMMENT '0=未读；ack 后置 1',
  created_at DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  KEY idx_parent_unread (parent_id, is_read, id),
  CONSTRAINT fk_billing_notices_parent FOREIGN KEY (parent_id) REFERENCES parents (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci COMMENT='订阅裁决结果通知（批④补丁）';
```

- [ ] **Step 2: schema.sql 同步**——同一定义（含 COMMENT）插进 9.5 节尾；注意迁移与 schema.sql 逐列一致（批④备查：claim_status 曾漂移，勿重蹈）
- [ ] **Step 3: 本机 apply 两遍验证幂等**——`mysql ai_k12 < tools/db/migrations/2026-10-01_billing_notices.sql` 连跑两次均不报错；`SHOW CREATE TABLE billing_notices --vertical` 目检列与 KEY
- [ ] **Step 4: Commit** — `git commit -m "feat(billing): billing_notices 裁决结果通知表"`

### Task 2: repo + service 通知挂点

**Files:**
- Create: `apps/server/src/database/repositories/billing-notices.repo.ts`
- Modify: `apps/server/src/modules/billing/billing.service.ts`（构造注入 + `notifyClaimResult` + 3 个挂点）
- Modify: `apps/server/src/modules/billing/billing.module.ts`（providers 注册）
- Test: `apps/server/src/modules/billing/billing.service.test.ts`（mkDeps/mkSvc 补第 8 参 + 新用例）

**Interfaces:**
- Consumes: Task 1 的表
- Produces:
  - `BillingNoticesRepository`：`insert({parentId, type, orderNo, reason}): Promise<void>`、`listUnread(parentId): Promise<NoticeRow[]>`、`findById(id): Promise<NoticeRow | null>`、`markRead(id, parentId): Promise<void>`；`NoticeRow = { id, parent_id, type, order_no, reason, is_read, created_at, updated_at }`
  - `BillingService` 构造第 8 参 `noticesRepo: BillingNoticesRepository`（**全仓唯一手工构造点是 billing.service.test.ts:72 的 mkSvc，别处靠 DI**）
  - 私有 `notifyClaimResult(order, type, reason)`：INSERT + catch warn

- [ ] **Step 1: 写失败测试**（先补 mock 骨架再写用例）

`mkDeps()` 加 `noticesRepo: { insert: vi.fn().mockResolvedValue(undefined), listUnread: vi.fn().mockResolvedValue([]), findById: vi.fn().mockResolvedValue(null), markRead: vi.fn().mockResolvedValue(undefined) }`；`mkSvc` 末尾追加 `d.noticesRepo as never`。用例（挂 `describe('BillingService 裁决通知')`）：

```typescript
function mkPaidOrder(): OrderRow {
  return mkOrder({ claim_status: 'pending_review' }); // orders.repo 的 OrderRow 已有 claim 三列（批④ Task 1）
}

it('rejectClaim 成功 → insert 被调 type=claim_rejected、reason=入参原文（非拼接 claim_note）', async () => {
  const d = mkDeps();
  d.ordersRepo.findByOrderNo.mockResolvedValue(mkOrder({ claim_status: 'pending_review', claim_note: '微信号 xx 已转账' }));
  await mkSvc(d).rejectClaim('ORD1', 9, '账上没收到钱');
  expect(d.ordersRepo.markClaim).toHaveBeenCalledWith(11, 'rejected', '微信号 xx 已转账；驳回：账上没收到钱');
  expect(d.noticesRepo.insert).toHaveBeenCalledWith(
    { parentId: 3, type: 'claim_rejected', orderNo: 'ORD1', reason: '账上没收到钱' },
  );
});

it('rejectClaim 无 reason → notice reason=null', async () => {
  const d = mkDeps();
  d.ordersRepo.findByOrderNo.mockResolvedValue(mkOrder({ claim_status: 'pending_review' }));
  await mkSvc(d).rejectClaim('ORD1', 9);
  expect(d.noticesRepo.insert).toHaveBeenCalledWith({ parentId: 3, type: 'claim_rejected', orderNo: 'ORD1', reason: null });
});

it('approveClaim 走 finalize（paid 路径）→ finalize 挂点 insert claim_approved', async () => {
  const d = mkDeps();
  d.ordersRepo.findByOrderNo.mockResolvedValue(mkPaidOrder());
  await mkSvc(d).approveClaim('ORD1', 9);
  expect(d.noticesRepo.insert).toHaveBeenCalledWith({ parentId: 3, type: 'claim_approved', orderNo: 'ORD1', reason: null });
});

it('approveClaim duplicate 补挂路径（已 paid 但 claim 仍 pending_review）→ insert claim_approved 恰一次', async () => {
  const d = mkDeps();
  d.ordersRepo.findByOrderNo.mockResolvedValue(mkOrder({ claim_status: 'pending_review', payment_status: 'paid' }));
  await mkSvc(d).approveClaim('ORD1', 9);
  expect(d.ordersRepo.markPaidTx).not.toHaveBeenCalled(); // duplicate 分支不重复入账
  expect(d.noticesRepo.insert).toHaveBeenCalledTimes(1);
  expect(d.noticesRepo.insert).toHaveBeenCalledWith({ parentId: 3, type: 'claim_approved', orderNo: 'ORD1', reason: null });
});

it('渠道回调 finalize（claim pending_review）→ 挂点 insert claim_approved', async () => {
  const d = mkDeps();
  d.ordersRepo.findByOrderNo.mockResolvedValue(mkPaidOrder());
  d.mockAdapter.verifyCallback.mockResolvedValue({ orderNo: 'ORD1', tradeNo: 'T1', paid: true, amountCents: 2000 });
  await mkSvc(d).handleCallback('mock', 'payload'); // 若签名不同以现有回调用例为准，照抄其驱动方式
  expect(d.noticesRepo.insert).toHaveBeenCalledWith({ parentId: 3, type: 'claim_approved', orderNo: 'ORD1', reason: null });
});

it('claim 已 approved 的重复 finalize → 不 insert（迁移未发生）', async () => {
  const d = mkDeps();
  d.ordersRepo.findByOrderNo.mockResolvedValue(mkOrder({ claim_status: 'approved' }));
  await mkSvc(d).finalizePaidOrder(mkOrder({ claim_status: 'approved' }), 'T1');
  expect(d.ordersRepo.markClaim).not.toHaveBeenCalled();
  expect(d.noticesRepo.insert).not.toHaveBeenCalled();
});

it('通知 insert 抛错 → approve/reject 主链路不受影响（不抛、结果照常返回）', async () => {
  const d = mkDeps();
  d.ordersRepo.findByOrderNo.mockResolvedValue(mkOrder({ claim_status: 'pending_review' }));
  d.noticesRepo.insert.mockRejectedValue(new Error('db down'));
  await expect(mkSvc(d).rejectClaim('ORD1', 9, 'x')).resolves.toBeUndefined();
});
```

（注：`mkOrder` 现无 claim 列默认值——`OrderRow` 含 `claim_status/claimed_at/claim_note`，在 `mkOrder` 基础对象里补 `claim_status: null, claimed_at: null, claim_note: null`。）

- [ ] **Step 2: 跑失败** — `npx vitest run src/modules/billing/billing.service.test.ts`，预期新用例全红（noticesRepo 未注入/insert 未被调）
- [ ] **Step 3: 实现**

repo（照 `subscription-adjustments.repo.ts` 模式）：

```typescript
import { Inject, Injectable } from '@nestjs/common';
import type { Pool, RowDataPacket } from 'mysql2/promise';

export type BillingNoticeType = 'claim_approved' | 'claim_rejected';

export interface BillingNoticeRow extends RowDataPacket {
  id: number; parent_id: number; type: BillingNoticeType; order_no: string;
  reason: string | null; is_read: number; created_at: Date; updated_at: Date;
}

@Injectable()
export class BillingNoticesRepository {
  constructor(@Inject('DATABASE_POOL') private readonly pool: Pool) {}

  async insert(input: { parentId: number; type: BillingNoticeType; orderNo: string; reason: string | null }): Promise<void> {
    await this.pool.execute(
      `INSERT INTO billing_notices (parent_id, type, order_no, reason) VALUES (?, ?, ?, ?)`,
      [input.parentId, input.type, input.orderNo, input.reason],
    );
  }

  /** LIMIT 用字面量（仓规：不走 `LIMIT ?` 占位符）。 */
  async listUnread(parentId: number): Promise<BillingNoticeRow[]> {
    const [rows] = await this.pool.query<BillingNoticeRow[]>(
      `SELECT id, parent_id, type, order_no, reason, is_read, created_at, updated_at
         FROM billing_notices WHERE parent_id = ? AND is_read = 0 ORDER BY id DESC LIMIT 50`,
      [parentId],
    );
    return rows;
  }

  async findById(id: number): Promise<BillingNoticeRow | null> {
    const [rows] = await this.pool.execute<BillingNoticeRow[]>(
      `SELECT id, parent_id, type, order_no, reason, is_read, created_at, updated_at FROM billing_notices WHERE id = ?`,
      [id],
    );
    return rows[0] ?? null;
  }

  async markRead(id: number, parentId: number): Promise<void> {
    await this.pool.execute(`UPDATE billing_notices SET is_read = 1 WHERE id = ? AND parent_id = ?`, [id, parentId]);
  }
}
```

service 三处改动：

```typescript
// 构造函数末尾追加参数（DI：类类型参数，metadata 正常，无 @Optional 需要）
constructor(...现有 7 参..., private readonly noticesRepo: BillingNoticesRepository) { ... }

/** 裁决结果通知（spec §2.1）：只在实际迁移发生处调用；失败 warn 不阻断。 */
private async notifyClaimResult(order: OrderRow, type: 'claim_approved' | 'claim_rejected', reason: string | null): Promise<void> {
  try {
    await this.noticesRepo.insert({ parentId: order.parent_id, type, orderNo: order.order_no, reason });
  } catch (err) {
    this.logger.warn(`[billing] 裁决通知落库失败（不阻断裁决）orderNo=${order.order_no} type=${type}: ${err}`);
  }
}
```

挂点 ①：`approveClaim` duplicate 分支（现 :426-432），`markClaim` 成功后调 `await this.notifyClaimResult(order, 'claim_approved', null);`（放 try 内、markClaim 之后——markClaim 失败则不通知）；挂点 ②：`rejectClaim`（:451 markClaim 之后）调 `await this.notifyClaimResult(order, 'claim_rejected', reason ?? null);`；挂点 ③：`finalizePaidOrder` claim 闭环挂点（:511-517，markClaim 成功后）调 `await this.notifyClaimResult(order, 'claim_approved', null);`。**approveClaim 的 paid 路径经 finalize 挂点覆盖，勿重复插**。

module：`providers` 加 `BillingNoticesRepository`（不加 exports——仅 service 内部消费）。

- [ ] **Step 4: 跑通过** — `npx vitest run src/modules/billing && npx tsc --noEmit` 全绿（若 `billing.module.test.ts` 装配钉子精确断言 providers 数组，同步补该 repo）
- [ ] **Step 5: Commit** — `git commit -m "feat(billing): 裁决迁移落 billing_notices 通知（approve/reject/自动闭环三挂点，失败不阻断）"`

### Task 3: 家长端两通知端点

**Files:**
- Modify: `apps/server/src/modules/billing/billing.service.ts`（+`listUnreadNotices` / `ackNotice`）
- Modify: `apps/server/src/modules/billing/billing.controller.ts`（+2 路由）
- Test: `billing.service.test.ts` / `billing.controller.test.ts` 追加

**Interfaces:**
- Consumes: Task 2 的 repo 四方法
- Produces:
  - `BillingService.listUnreadNotices(parentId: number): Promise<{ items: { id: number; type: BillingNoticeType; orderNo: string; reason: string | null; createdAt: string }[]; total: number }>`（createdAt = `ISO(row.created_at)`，文件内已有 `ISO()` helper）
  - `BillingService.ackNotice(parentId: number, rawId: unknown): Promise<{ ok: true }>`
  - `GET /api/billing/notices/unread`（200）与 `POST /api/billing/notices/:id/ack`（**@HttpCode(200)**），类级 `@Roles('parent')` 已有

- [ ] **Step 1: 写失败测试**

service 用例：

```typescript
describe('BillingService 通知端点', () => {
  const ROW = { id: 5, parent_id: 3, type: 'claim_rejected', order_no: 'ORD1', reason: '没收到钱', is_read: 0, created_at: new Date('2026-10-01T08:00:00Z'), updated_at: new Date() };

  it('listUnreadNotices → items 映射 camelCase + total=items.length', async () => {
    const d = mkDeps();
    d.noticesRepo.listUnread.mockResolvedValue([ROW, { ...ROW, id: 4, reason: null, type: 'claim_approved' }]);
    const res = await mkSvc(d).listUnreadNotices(3);
    expect(res.total).toBe(2);
    expect(res.items[0]).toEqual({ id: 5, type: 'claim_rejected', orderNo: 'ORD1', reason: '没收到钱', createdAt: '2026-10-01T08:00:00.000Z' });
  });

  it('ackNotice：非正整数 id → 400/1001；不存在 → 404/1002；他人通知 → 403/1005', async () => {
    const d = mkDeps();
    await expect(mkSvc(d).ackNotice(3, 'abc')).rejects.toMatchObject({ status: 400, response: { code: 1001 } });
    await expect(mkSvc(d).ackNotice(3, 0)).rejects.toMatchObject({ status: 400, response: { code: 1001 } });
    d.noticesRepo.findById.mockResolvedValue(null);
    await expect(mkSvc(d).ackNotice(3, 5)).rejects.toMatchObject({ status: 404, response: { code: 1002 } });
    d.noticesRepo.findById.mockResolvedValue(ROW);
    await expect(mkSvc(d).ackNotice(999, 5)).rejects.toMatchObject({ status: 403, response: { code: 1005 } });
  });

  it('ackNotice：已读幂等（不调 markRead）→ 200 {ok:true}；未读 → markRead(id, parentId) 双条件', async () => {
    const d = mkDeps();
    d.noticesRepo.findById.mockResolvedValue(ROW);
    await expect(mkSvc(d).ackNotice(3, 5)).resolves.toEqual({ ok: true });
    expect(d.noticesRepo.markRead).toHaveBeenCalledWith(5, 3);
    d.noticesRepo.findById.mockResolvedValue({ ...ROW, is_read: 1 });
    expect(d.noticesRepo.markRead).toHaveBeenCalledTimes(1); // 上一次的调用数
    await expect(mkSvc(d).ackNotice(3, 5)).resolves.toEqual({ ok: true });
    expect(d.noticesRepo.markRead).toHaveBeenCalledTimes(1); // 幂等不再 UPDATE
  });
});
```

controller 用例（照本文件既有「路由形状 + 直接实例化」两段式）：

```typescript
describe('BillingController 通知端点', () => {
  it('GET notices/unread 挂 api/billing 下；POST notices/:id/ack 显式 @HttpCode(200)', () => {
    expect(Reflect.getMetadata(PATH_METADATA, BillingController.prototype.listUnreadNotices)).toBe('notices/unread');
    const ack = BillingController.prototype.ackNotice;
    expect(Reflect.getMetadata(PATH_METADATA, ack)).toBe('notices/:id/ack');
    expect(Reflect.getMetadata(HTTP_CODE_METADATA, ack)).toBe(200);
    expect(Reflect.getMetadata(METHOD_METADATA, ack)).toBe(RequestMethod.POST);
  });

  it('ack：service 1002 原样冒泡', async () => {
    const svc = { ackNotice: vi.fn().mockRejectedValue(new HttpException({ code: 1002, message: '通知不存在' }, 404)) };
    const ctrl = makeBillingController(svc, { getStatusView: vi.fn() });
    await expect(ctrl.ackNotice('5', PARENT)).rejects.toMatchObject({ response: { code: 1002 } });
    expect(svc.ackNotice).toHaveBeenCalledWith(7, '5');
  });

  it('listUnreadNotices：身份透传 user.sub', async () => {
    const svc = { listUnreadNotices: vi.fn().mockResolvedValue({ items: [], total: 0 }) };
    const ctrl = makeBillingController(svc, { getStatusView: vi.fn() });
    await expect(ctrl.listUnreadNotices(PARENT)).resolves.toEqual({ items: [], total: 0 });
    expect(svc.listUnreadNotices).toHaveBeenCalledWith(7);
  });
});
```

- [ ] **Step 2: 跑失败**（路由形状/方法不存在的红）
- [ ] **Step 3: 实现**

service：

```typescript
/** 家长未读裁决通知（spec §2.3）：无分页，上限 50 由 repo 保证；total=items.length。 */
async listUnreadNotices(parentId: number) {
  const rows = await this.noticesRepo.listUnread(parentId);
  return {
    items: rows.map((r) => ({ id: r.id, type: r.type, orderNo: r.order_no, reason: r.reason, createdAt: ISO(r.created_at) })),
    total: rows.length,
  };
}

/** ack 已读：1001 非法 id / 1002 不存在 / 1005 他人通知；已读幂等不重复 UPDATE。 */
async ackNotice(parentId: number, rawId: unknown): Promise<{ ok: true }> {
  const id = typeof rawId === 'number' ? rawId : Number(rawId);
  if (!Number.isInteger(id) || id < 1) {
    throw new BadRequestException({ code: 1001, message: '参数错误' });
  }
  const row = await this.noticesRepo.findById(id);
  if (!row) throw new NotFoundException({ code: 1002, message: '通知不存在' });
  if (row.parent_id !== parentId) throw new ForbiddenException({ code: 1005, message: '无权操作该通知' });
  if (row.is_read !== 1) {
    await this.noticesRepo.markRead(id, parentId);
    this.logger.log(`[BILLING] notice ack：noticeId=${id} parentId=${parentId} time=${new Date().toISOString()}`);
  }
  return { ok: true };
}
```

（`ForbiddenException` 若未 import 则补；`ISO` 是文件内既有 helper。）

controller（`BillingController` 类内追加）：

```typescript
/** 家长未读裁决通知（spec §2.3）：跨页提示条数据源，挂载 + 30s 轮询拉取。 */
@Get('notices/unread')
listUnreadNotices(@CurrentUser() user: JwtUser) {
  return this.billingService.listUnreadNotices(user.sub);
}

/** 「知道了」标已读。幂等；显式 200（状态迁移语义，本仓第二处 @HttpCode 覆盖）。 */
@Post('notices/:id/ack')
@HttpCode(200)
ackNotice(@Param('id') id: string, @CurrentUser() user: JwtUser) {
  return this.billingService.ackNotice(user.sub, id);
}
```

- [ ] **Step 4: 跑通过** — `npx vitest run src/modules/billing && npx tsc --noEmit`
- [ ] **Step 5: Commit** — `git commit -m "feat(billing): 家长未读裁决通知端点（unread 列表 + ack 已读幂等）"`

### Task 4: 前端——api + BillingNoticeBar + ParentLayout 接入

**Files:**
- Modify: `apps/web/src/services/api.ts`（confirmBillingOrderPaid 之后、管理端注释块之前插一段）
- Create: `apps/web/src/pages/parent/BillingNoticeBar.tsx` + `BillingNoticeBar.test.tsx`
- Modify: `apps/web/src/components/layout/ParentLayout.tsx`（AlertBanner 与 SubscriptionNoticeBar 之间挂载）
- Modify: 既有家长页测试的 api mock（凡 mock 了 `getSubscriptionStatus` 的文件——SubscriptionNoticeBar 挂载即拉的同款原因）

**Interfaces:**
- Consumes: Task 3 两端点
- Produces:
  - `BillingNoticeView = { id: number; type: 'claim_approved' | 'claim_rejected'; orderNo: string; reason: string | null; createdAt: string }`
  - `listUnreadBillingNotices(): Promise<{ items: BillingNoticeView[]; total: number }>`、`ackBillingNotice(id: number): Promise<{ ok: true }>`
  - `<BillingNoticeBar />`：无 props，全空/首拉失败不渲染 DOM

- [ ] **Step 1: api.ts 增补**

```typescript
// --- 家长端：裁决结果通知（批④补丁；spec §3.2） ---

export interface BillingNoticeView {
  id: number;
  type: 'claim_approved' | 'claim_rejected';
  orderNo: string;
  /** 驳回原因；approve 为 null */
  reason: string | null;
  createdAt: string;
}

/** 未读裁决通知（无分页，服务端上限 50；total=items.length）。首拉失败由组件静默。 */
export function listUnreadBillingNotices(): Promise<{ items: BillingNoticeView[]; total: number }> {
  return fetchApi('/billing/notices/unread');
}

/** 「知道了」标已读。幂等（已读再 ack 仍 200）；1002/1005 由 ApiError 冒泡。 */
export function ackBillingNotice(id: number): Promise<{ ok: true }> {
  return fetchApi(`/billing/notices/${encodeURIComponent(String(id))}/ack`, { method: 'POST' });
}
```

- [ ] **Step 2: 写失败渲染测试**（`BillingNoticeBar.test.tsx`，`afterEach(cleanup)` 铁律）

```typescript
vi.mock('@/services/api', () => ({
  listUnreadBillingNotices: vi.fn(),
  ackBillingNotice: vi.fn(),
}));
// 用例（vi.useFakeTimers 驱动 30s 轮询，act 内 advanceTimersByTimeAsync）：
// ① 两态渲染：approved → 「您的订阅已开通」；rejected → 「管理员未确认本次转账」+ reason 文本
// ② 逐条 ack：点某条「知道了」→ ackBillingNotice(id) 被调、该条 data-testid 消失、另一条保留
// ③ 全部 ack 完 → 容器不渲染（queryByTestId('billing-notice-bar') 为 null）
// ④ 首拉 reject → 不渲染；下一轮轮询成功 → 恢复渲染（spec：首拉失败 hidden，轮询周期重试）
// ⑤ 已展示后再轮询失败 → 列表保留（不打折消失）
// ⑥ ack reject → toast('error', '操作失败，请稍后再试') 且条目保留
```

- [ ] **Step 3: 实现**

```tsx
import { useCallback, useEffect, useState } from 'react';
import { toast } from '@/components/base';
import { ackBillingNotice, listUnreadBillingNotices, type BillingNoticeView } from '@/services/api';

/** 与 AlertBanner 同口径：数据源本身低频，30s 足够。 */
export const NOTICE_POLL_INTERVAL_MS = 30_000;

/**
 * 家长顶栏「裁决结果条」（批④补丁 spec §3.1）：独立组件，与预警（孩子行为）、
 * 订阅状态（付费状态）不合并。首拉失败 → 隐藏（后续轮询周期重试）；
 * 已展示后再失败 → 保留现有列表。逐条「知道了」ack，全空不渲染。
 */
export default function BillingNoticeBar() {
  const [notices, setNotices] = useState<BillingNoticeView[] | null>(null);

  const load = useCallback(() => {
    listUnreadBillingNotices()
      .then((res) => setNotices(res.items))
      .catch(() => {
        /* 首拉失败保持 null（隐藏）；已展示时保留现有列表 */
      });
  }, []);

  useEffect(() => {
    load();
    const timer = setInterval(load, NOTICE_POLL_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [load]);

  const ack = (id: number) => {
    ackBillingNotice(id)
      .then(() => setNotices((prev) => prev?.filter((n) => n.id !== id) ?? prev))
      .catch(() => toast('error', '操作失败，请稍后再试'));
  };

  if (!notices || notices.length === 0) return null;

  return (
    <div data-testid="billing-notice-bar" className="space-y-2 px-6 pt-3">
      {notices.map((n) => (
        <div
          key={n.id}
          className="flex items-center justify-between gap-3 rounded-[var(--radius-button)] border border-[var(--bg-subtle)] bg-white px-4 py-2.5"
        >
          <div className="min-w-0 text-sm">
            {n.type === 'claim_approved' ? (
              <span className="font-medium text-[var(--success)]">您的订阅已开通</span>
            ) : (
              <span className="font-medium text-[var(--error)]">
                管理员未确认本次转账{n.reason ? `：${n.reason}` : ''}
              </span>
            )}
          </div>
          <button
            type="button"
            data-testid={`billing-notice-ack-${n.id}`}
            onClick={() => ack(n.id)}
            className="shrink-0 rounded-md border border-[var(--bg-subtle)] px-3 py-1 text-xs text-[var(--text-secondary)] hover:bg-[var(--bg-subtle)]"
          >
            知道了
          </button>
        </div>
      ))}
    </div>
  );
}
```

`ParentLayout.tsx`：import 并在 `<AlertBanner />` 与 `<SubscriptionNoticeBar />` 之间插 `<BillingNoticeBar />`，注释补「裁决结果条（事件通知）」。

- [ ] **Step 4: 既有测试补 mock + 跑通过**——`grep -rl "getSubscriptionStatus: vi.fn" apps/web/src`（ParentLayout.test / 各家长页 test）：每个文件的 api mock 对象补 `listUnreadBillingNotices: vi.fn().mockResolvedValue({ items: [], total: 0 })`；`cd apps/web && npx vitest run && npx tsc -b` 全绿
- [ ] **Step 5: Commit** — `git commit -m "feat(web): 家长顶栏裁决结果条（未读轮询 + 逐条知道了）"`

### Task 5: 订单历史驳回徽标

**Files:**
- Modify: `apps/web/src/pages/parent/ParentSubscriptionPage.tsx`（:532 徽标块之后补 rejected 分支 + claimNote 展示）
- Test: `ParentSubscriptionPage.test.tsx` 追加

**Interfaces:**
- Consumes: `BillingOrderView.claimStatus/claimNote`（已有）
- Produces: pending + `claimStatus==='rejected'` 行渲染 `data-testid="order-claim-rejected-{orderNo}"` 红徽标 + claimNote 次要文字（60 字截断，title 放全文）

- [ ] **Step 1: 写失败测试**

```typescript
it('订单历史 pending + claimStatus=rejected 行加「管理员已驳回」徽标 + claimNote 截断展示', async () => {
  // ordersOf 一张单：claimStatus: 'rejected', claimNote: 'x'.repeat(80) + '；驳回：账上没收到钱'
  // 断言：getByTestId('order-claim-rejected-NO10') 存在、文案「管理员已驳回」；
  //       claimNote 前 60 字 + '…' 出现于行内；title 属性含全文（getByTitle(全文)）
});

it('rejected 行仍可取消（既有按钮不回归）', async () => {
  // 同一 fixture：行内「取消」按钮存在
});
```

- [ ] **Step 2: 实现**——文件内加 helper：

```typescript
/** 60 字截断（驳回原因展示用），title 走全文。 */
function truncate(text: string, max = 60): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}
```

历史行两处改动：①`:532` 徽标块后并列：

```tsx
{item.paymentStatus === 'pending' && item.claimStatus === 'rejected' && (
  <span
    data-testid={`order-claim-rejected-${item.orderNo}`}
    className="rounded-full bg-[var(--bg-subtle)] px-2 py-0.5 text-xs font-medium text-[var(--error)]"
  >
    管理员已驳回
  </span>
)}
```

②左侧 `min-w-0` 块内、单号行之后补（仅 rejected 且有 note 时）：

```tsx
{item.claimStatus === 'rejected' && item.claimNote && (
  <div className="text-xs text-[var(--text-tertiary)]" title={item.claimNote}>
    {truncate(item.claimNote)}
  </div>
)}
```

- [ ] **Step 3: 跑通过** — `npx vitest run src/pages/parent/ParentSubscriptionPage.test.tsx && npx tsc -b`
- [ ] **Step 4: Commit** — `git commit -m "fix(web): 订单历史补「管理员已驳回」徽标与原因展示（批④驳回不可见缺陷）"`

### Task 6: 管理端红点 store 联动

**Files:**
- Create: `apps/web/src/store/adminBillingBadgeStore.ts`
- Modify: `apps/web/src/components/layout/AdminNav.tsx`（删自身 fetch，改 store）
- Modify: `apps/web/src/pages/admin/AdminBillingPage.tsx`（approve/reject 成功后 `refresh()`）
- Create Test: `apps/web/src/components/layout/AdminNav.test.tsx`（AdminNav 无既有测试，组件改动必须补渲染测试——仓规）
- Test: `AdminBillingPage.test.tsx` 追加

**Interfaces:**
- Produces:
  - `useAdminBillingBadgeStore`：`{ pendingCount: number | null; setPendingCount(n): void; refresh(): Promise<void> }`——refresh 拉 `listBillingClaims('pending_review',1,1)`，失败静默保留旧值
  - AdminNav 角标渲染条件不变（`pendingCount !== null && > 0`，`data-testid="billing-pending-badge"`）

- [ ] **Step 1: 写失败测试**

`AdminNav.test.tsx`（新文件）：

```typescript
vi.mock('@/services/api', () => ({ listBillingClaims: vi.fn() }));
// MemoryRouter 包裹渲染（AdminNav 用 NavLink；LogoutButton 若再依赖 router 上下文同样被覆盖）
// ① store.pendingCount=3 → badge 文本 '3'（先 act 直接 set store，隔离 api）
// ② pendingCount=0 / null → queryByTestId('billing-pending-badge') 为 null
// ③ 挂载触发 refresh → listBillingClaims 被调 ('pending_review', 1, 1)；reject → 静默不抛、badge 保持原状
// ④ >99 → '99+'（set store 直测渲染分支）
// afterEach(cleanup) + 每用例前重置 store（useAdminBillingBadgeStore.setState({ pendingCount: null })）
```

`AdminBillingPage.test.tsx` 追加：

```typescript
it('approve 成功后触发角标 refresh', async () => {
  // render 页面 → 点某行「通过」→ await resolve
  // 断言 useAdminBillingBadgeStore.getState().pendingCount 被 refresh 链路更新
  // （listBillingClaims mock 已在文件里；给 'pending_review',1,1 调用配 total 返回值即可）
});
// reject 同款一钉
```

- [ ] **Step 2: 实现**

store（照 themeStore 风格）：

```typescript
import { create } from 'zustand';
import { listBillingClaims } from '@/services/api';

interface AdminBillingBadgeState {
  /** null = 从未成功拉取（不渲染角标）；失败静默保留旧值。 */
  pendingCount: number | null;
  setPendingCount: (n: number | null) => void;
  refresh: () => Promise<void>;
}

/** 管理端「订阅裁决」红点（批④补丁 spec §4）：AdminNav 读、AdminBillingPage 裁决后主动 refresh。 */
export const useAdminBillingBadgeStore = create<AdminBillingBadgeState>((set) => ({
  pendingCount: null,
  setPendingCount: (n) => set({ pendingCount: n }),
  refresh: async () => {
    try {
      const res = await listBillingClaims('pending_review', 1, 1);
      set({ pendingCount: res.total });
    } catch {
      /* 失败静默：角标永不阻断管理端导航 */
    }
  },
}));
```

`AdminNav.tsx`：删 `useState/useEffect/listBillingClaims` 自拉逻辑，改 `const pendingCount = useAdminBillingBadgeStore((s) => s.pendingCount); const refresh = useAdminBillingBadgeStore((s) => s.refresh);` + `useEffect(() => { void refresh(); }, [refresh]);`；头注释重写：「角标走 adminBillingBadgeStore 联动——AdminBillingPage 裁决后主动 refresh，处理完最后一条即消失；拉取失败静默保留旧值，导航永不因计费接口故障而不可用」（**删掉「切页重挂自然刷新」错误假设**）。

`AdminBillingPage.tsx`：`const refreshBadge = useAdminBillingBadgeStore((s) => s.refresh);`；`handleApprove` 与 `handleReject` 的成功路径 `loadClaims();` 之后各加 `refreshBadge();`。

- [ ] **Step 3: 跑通过** — `npx vitest run src/components/layout/AdminNav.test.tsx src/pages/admin/AdminBillingPage.test.tsx && npx tsc -b`
- [ ] **Step 4: Commit** — `git commit -m "fix(web): 管理端待裁决红点改 store 联动（裁决后即时刷新，修正切页重挂错误假设）"`

### Task 7: 收尾——全量 + 文档 + 冒烟

- [ ] **Step 1: 两端全量 + tsc**——`cd apps/server && npm test && npx tsc --noEmit`；`cd apps/web && npm test && npx tsc -b`
- [ ] **Step 2: 文档同步**
  - API 文档 §4.15 补两端点（GET unread / POST ack，ack 记 `'200'`）；§9 日志补 ack 留痕一行
  - `docs/api/openapi.yaml`：+2 op（`/api/billing/notices/unread`、`/api/billing/notices/{id}/ack`）+ `BillingNoticeView` schema；两文档端点清单核对
  - UX 文档：家长顶栏组件清单补 `BillingNoticeBar`（预警 → 裁决结果 → 订阅状态，三条并列）
  - **CLAUDE.md**「API 文档同步规则」节：「本仓**唯一**的 `@HttpCode` 覆盖」改为两处（`learning-sessions` + 本 ack 端点）
  - `docs/ai-core-changelog.md`：2026-10-01 节记录两缺陷、三裁决、修复要点与冒烟结果
- [ ] **Step 3: mock 冒烟**——build 后 `BILLING_USE_MOCK=1 node dist/main.js`：
  1. 家长 manual 下单 → 填备注点「我已付款」→ 2004 转人工
  2. 管理员驳回（带原因）→ 家长**另一页面**（非订阅页）30s 内顶栏出现「管理员未确认本次转账：原因」
  3. 订单历史该行出现「管理员已驳回」徽标 + 原因
  4. 点「知道了」→ 条目消失；刷新页面不再出现（is_read 持久化）
  5. 再来一单 → 管理员通过 → 顶栏「您的订阅已开通」+ 订阅状态卡生效；管理端红点在通过后消失
- [ ] **Step 4: 台账收尾 + Commit**——`.superpowers/sdd/progress.md` 补丁节（含冒烟结果与披露项）；`git commit -m "docs: 裁决结果通知补丁文档同步（API/openapi/UX/CLAUDE.md/changelog）"`
