# 订阅收费（①）数据层 + 订阅状态 + 学生端硬门禁 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 建立 3 张订阅/计费表、按家长全家的订阅状态机（trial/active/expired 纯函数推导）、家长注册送试用钩子、学生端 SubscriptionGuard 硬门禁与 `GET /api/quota/subscription` 读端点。

**Architecture:** `family_subscriptions` 每家长一行 upsert，`effectiveStatus(now)` 纯函数为唯一状态真源（DB `status` 列冗余仅供运营）；门禁是全局 Nest Guard（JwtAuthGuard/RolesGuard 之后），豁免清单钉死 + 护栏测试。零调度，全部惰性。

**Tech Stack:** NestJS + mysql2（`pool.execute`，分页 `LIMIT ?` 必须 `pool.query`，见工程约定）、vitest。

**Spec:** `docs/superpowers/specs/2026-09-29-subscription-billing-design.md`（端点形状、错误码 2xxx、豁免清单以其为准）

## Global Constraints

- 迁移手工 apply、必须幂等；新增表同时进 `tools/db/schema.sql`
- 错误码：`2001` 订阅失效；统一 `ForbiddenException({ code: 2001, message: ... })` 形态（与仓内 1002/1005 同款）
- 试用截止时刻**当刻仍有效**（`now <= trial_ends_at` 为 trialing）
- `updated_at` 一律列级 `ON UPDATE CURRENT_TIMESTAMP(3)`，不建触发器
- 测试 `globals: false` 不适用于服务端（服务端 vitest 正常配）；组件类测试才需手动 `afterEach(cleanup)`
- 不用 emoji；提交信息中文

---

### Task 1: 迁移 SQL + schema.sql 同步 + plans seed

**Files:**
- Create: `tools/db/migrations/2026-09-29_subscription_billing.sql`
- Modify: `tools/db/schema.sql`（在「9. 奖励」节之后追加「9.5 订阅与计费」节）

**Interfaces:**
- Produces: 表 `subscription_plans` / `family_subscriptions` / `orders`（列定义见 spec §2，此处逐字落地）；plans seed 两行（month=2000 分 / year=19800 分——占位价，上线前家长自行 UPDATE，spec §2.1 约定）

- [ ] **Step 1: 写迁移 SQL**

```sql
-- 2026-09-29 订阅收费：套餐 / 家庭订阅 / 订单（spec 2026-09-29-subscription-billing-design.md §2）
-- 幂等：CREATE TABLE IF NOT EXISTS + ON DUPLICATE KEY UPDATE id=id 回填

CREATE TABLE IF NOT EXISTS subscription_plans (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  plan_code VARCHAR(20) NOT NULL,
  name VARCHAR(50) NOT NULL,
  price_cents INT NOT NULL,
  duration_days INT NOT NULL,
  is_active TINYINT(1) NOT NULL DEFAULT 1,
  sort_order SMALLINT NOT NULL DEFAULT 0,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  UNIQUE KEY uk_subscription_plans_code (plan_code)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS family_subscriptions (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  parent_id BIGINT NOT NULL,
  status VARCHAR(10) NOT NULL DEFAULT 'trialing', -- 冗余列仅供运营 SQL；代码以 effectiveStatus 推导为准
  trial_ends_at DATETIME(3) DEFAULT NULL,
  current_period_end DATETIME(3) DEFAULT NULL,
  plan_code VARCHAR(20) DEFAULT NULL,
  source VARCHAR(10) NOT NULL DEFAULT 'trial',
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  UNIQUE KEY uk_family_subscriptions_parent (parent_id),
  CONSTRAINT fk_family_subscriptions_parent FOREIGN KEY (parent_id) REFERENCES parents (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS orders (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  order_no VARCHAR(32) NOT NULL,
  parent_id BIGINT NOT NULL,
  plan_id BIGINT NOT NULL,
  plan_snapshot JSON NOT NULL,
  amount_cents INT NOT NULL,
  payment_status VARCHAR(10) NOT NULL DEFAULT 'pending',
  channel VARCHAR(10) NOT NULL,
  channel_trade_no VARCHAR(64) DEFAULT NULL,
  channel_qr_content VARCHAR(255) DEFAULT NULL,
  paid_at DATETIME(3) DEFAULT NULL,
  cancelled_at DATETIME(3) DEFAULT NULL,
  expires_at DATETIME(3) NOT NULL,
  coupon_code VARCHAR(32) DEFAULT NULL,          -- 本期预留不写
  coupon_discount_cents INT DEFAULT NULL,        -- 本期预留不写
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  UNIQUE KEY uk_orders_no (order_no),
  UNIQUE KEY uk_orders_trade_no (channel_trade_no),
  KEY idx_orders_parent_status (parent_id, payment_status, id),
  CONSTRAINT fk_orders_parent FOREIGN KEY (parent_id) REFERENCES parents (id) ON DELETE CASCADE,
  CONSTRAINT fk_orders_plan FOREIGN KEY (plan_id) REFERENCES subscription_plans (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- plans seed（占位价，上线前 UPDATE price_cents）
INSERT INTO subscription_plans (plan_code, name, price_cents, duration_days, is_active, sort_order)
VALUES ('month', '月卡', 2000, 30, 1, 1), ('year', '年卡', 19800, 365, 1, 2)
ON DUPLICATE KEY UPDATE id = id;

-- 存量家长回填 7 天试用（重复执行不重复插；新家长走注册钩子，不依赖此句）
INSERT INTO family_subscriptions (parent_id, status, trial_ends_at, source)
SELECT p.id, 'trialing', DATE_ADD(NOW(3), INTERVAL 7 DAY), 'trial'
FROM parents p
LEFT JOIN family_subscriptions fs ON fs.parent_id = p.id
WHERE fs.id IS NULL
ON DUPLICATE KEY UPDATE id = id;
```

- [ ] **Step 2: schema.sql 同步**——把上面三张表与 seed 原样追加进 `tools/db/schema.sql` 的「9. 奖励」节之后，节标题 `-- 9.5 订阅与计费`。注意 `orders` 注释补一行：`-- coupon_* 本期预留不写（spec §2.3）`。

- [ ] **Step 3: 本机 apply 并验证幂等**（用户本机 MySQL，直接执行不问询——迁移是本仓常规操作）

```bash
mysql -h localhost -u root ai_k12 < tools/db/migrations/2026-09-29_subscription_billing.sql 2>/dev/null || mysql ai_k12 < tools/db/migrations/2026-09-29_subscription_billing.sql
# 再跑一遍验证幂等不报错，且行数不变：
mysql --vertical ai_k12 -e "SELECT plan_code, price_cents FROM subscription_plans ORDER BY sort_order; SELECT COUNT(*) AS sub_rows FROM family_subscriptions;"
```

Expected: 两行套餐（2000/19800）；`sub_rows` = 家长数；第二遍执行无错误。

- [ ] **Step 4: Commit**

```bash
git add tools/db/migrations/2026-09-29_subscription_billing.sql tools/db/schema.sql
git commit -m "feat(billing): 订阅收费三表迁移（plans/family_subscriptions/orders）+ 套餐 seed + 存量家长试用回填"
```

---

### Task 2: `effectiveStatus` 纯函数 + 计费配置

**Files:**
- Create: `apps/server/src/modules/billing/billing.config.ts`
- Create: `apps/server/src/modules/billing/subscription-status.ts`
- Test: `apps/server/src/modules/billing/subscription-status.test.ts`

**Interfaces:**
- Produces（Task 3/4/⑤批② 依赖）:
  - `TRIAL_DAYS: number`（`SUBSCRIPTION_TRIAL_DAYS` env，默认 7）
  - `ORDER_PENDING_TTL_MINUTES = 120`
  - `SUBSCRIPTION_EXPIRING_SOON_DAYS = 7`
  - `type SubscriptionStatus = 'trialing' | 'active' | 'expired'`
  - `effectiveStatus(now: Date, t: { trialEndsAt: Date | null; currentPeriodEnd: Date | null }): SubscriptionStatus`
  - `daysRemaining(now: Date, end: Date): number`（ceil，≥0）

- [ ] **Step 1: 写失败测试**

```typescript
// subscription-status.test.ts
import { describe, it, expect } from 'vitest';
import { effectiveStatus, daysRemaining } from './subscription-status.js';

const D = (s: string) => new Date(s);

describe('effectiveStatus', () => {
  it('试用期内 -> trialing；截止当刻仍有效', () => {
    const t = { trialEndsAt: D('2026-10-06T00:00:00Z'), currentPeriodEnd: null };
    expect(effectiveStatus(D('2026-09-29T00:00:00Z'), t)).toBe('trialing');
    expect(effectiveStatus(D('2026-10-06T00:00:00Z'), t)).toBe('trialing');
  });
  it('试用过期且无付费 -> expired', () => {
    const t = { trialEndsAt: D('2026-10-06T00:00:00Z'), currentPeriodEnd: null };
    expect(effectiveStatus(D('2026-10-06T00:00:01Z'), t)).toBe('expired');
  });
  it('付费期内 -> active（优先于 trial 时刻）', () => {
    const t = { trialEndsAt: D('2026-09-01T00:00:00Z'), currentPeriodEnd: D('2026-10-29T00:00:00Z') };
    expect(effectiveStatus(D('2026-09-29T00:00:00Z'), t)).toBe('active');
  });
  it('付费过期 -> expired（含两者皆 null：无行/从未付费）', () => {
    expect(effectiveStatus(D('2026-11-01T00:00:00Z'), { trialEndsAt: null, currentPeriodEnd: D('2026-10-29T00:00:00Z') })).toBe('expired');
    expect(effectiveStatus(D('2026-09-29T00:00:00Z'), { trialEndsAt: null, currentPeriodEnd: null })).toBe('expired');
  });
});

describe('daysRemaining', () => {
  it('向上取整且不为负', () => {
    expect(daysRemaining(D('2026-09-29T00:00:00Z'), D('2026-09-30T01:00:00Z'))).toBe(2); // 25h -> ceil 2
    expect(daysRemaining(D('2026-09-29T00:00:00Z'), D('2026-09-29T00:00:00Z'))).toBe(0);
    expect(daysRemaining(D('2026-09-30T00:00:00Z'), D('2026-09-29T00:00:00Z'))).toBe(0);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd apps/server && npx vitest run src/modules/billing/subscription-status.test.ts`
Expected: FAIL（模块不存在）

- [ ] **Step 3: 最小实现**

```typescript
// billing.config.ts
export const TRIAL_DAYS = Number(process.env.SUBSCRIPTION_TRIAL_DAYS ?? 7);
export const ORDER_PENDING_TTL_MINUTES = 120;
export const SUBSCRIPTION_EXPIRING_SOON_DAYS = 7;

// subscription-status.ts
export type SubscriptionStatus = 'trialing' | 'active' | 'expired';

export interface SubscriptionTimes {
  trialEndsAt: Date | null;
  currentPeriodEnd: Date | null;
}

export function effectiveStatus(now: Date, t: SubscriptionTimes): SubscriptionStatus {
  if (t.currentPeriodEnd != null && now.getTime() <= t.currentPeriodEnd.getTime()) return 'active';
  if (t.trialEndsAt != null && now.getTime() <= t.trialEndsAt.getTime()) return 'trialing';
  return 'expired';
}

export function daysRemaining(now: Date, end: Date): number {
  const diff = end.getTime() - now.getTime();
  if (diff <= 0) return 0;
  return Math.ceil(diff / 86_400_000);
}
```

- [ ] **Step 4: 跑测试通过** — 同 Step 2 命令，Expected: PASS

- [ ] **Step 5: Commit** — `git commit -m "feat(billing): effectiveStatus 纯函数 + 计费配置常量"`

---

### Task 3: 仓储层（family-subscriptions / subscription-plans）

**Files:**
- Create: `apps/server/src/database/repositories/family-subscriptions.repo.ts`
- Create: `apps/server/src/database/repositories/subscription-plans.repo.ts`
- Modify: `apps/server/src/database/repositories/index.ts`（追加两个 export，跟随现有文件风格）
- Test: `apps/server/src/database/repositories/family-subscriptions.repo.test.ts`（连本机 DB，参照 `reward-catalog.repo.test.ts` 的现有写法）

**Interfaces:**
- Produces:
  - `FamilySubscriptionsRepository`:
    - `findByParentId(parentId: number): Promise<{trial_ends_at: Date|null; current_period_end: Date|null} | null>`
    - `findByStudentId(studentId: number): Promise<{trial_ends_at: Date|null; current_period_end: Date|null} | null>`（students JOIN）
    - `upsertTrial(parentId: number, trialEndsAt: Date, conn?: PoolConnection): Promise<void>`（`INSERT ... ON DUPLICATE KEY UPDATE id = id`——只兜底补行，不覆盖已有）
    - `renewWithinTx(conn: PoolConnection, parentId: number, planCode: string, durationDays: number, now: Date): Promise<{ currentPeriodEnd: Date }>`（见 Step 2 SQL）
  - `SubscriptionPlansRepository`:
    - `listActive(): Promise<PlanRow[]>`（`{id, plan_code, name, price_cents, duration_days}`，`is_active=1 ORDER BY sort_order`）
    - `findActiveByCode(planCode: string): Promise<PlanRow | null>`

- [ ] **Step 1: 写 family-subscriptions.repo.ts**

```typescript
import { Injectable } from '@nestjs/common';
import type { Pool, PoolConnection, RowDataPacket } from 'mysql2/promise';
import { DatabaseService } from '../../database/database.service.js';

interface TimesRow extends RowDataPacket { trial_ends_at: Date | null; current_period_end: Date | null }

@Injectable()
export class FamilySubscriptionsRepository {
  private pool: Pool;
  constructor(database: DatabaseService) { this.pool = database.pool; }

  async findByParentId(parentId: number) {
    const [rows] = await this.pool.execute<TimesRow[]>(
      `SELECT trial_ends_at, current_period_end FROM family_subscriptions WHERE parent_id = ?`,
      [parentId],
    );
    return rows[0] ?? null;
  }

  async findByStudentId(studentId: number) {
    const [rows] = await this.pool.execute<TimesRow[]>(
      `SELECT fs.trial_ends_at, fs.current_period_end
       FROM students st JOIN family_subscriptions fs ON fs.parent_id = st.parent_id
       WHERE st.id = ?`,
      [studentId],
    );
    return rows[0] ?? null;
  }

  async upsertTrial(parentId: number, trialEndsAt: Date, conn?: PoolConnection) {
    const executor = conn ?? this.pool;
    await executor.execute(
      `INSERT INTO family_subscriptions (parent_id, status, trial_ends_at, source)
       VALUES (?, 'trialing', ?, 'trial')
       ON DUPLICATE KEY UPDATE id = id`,
      [parentId, trialEndsAt],
    );
  }

  /**
   * 付费续期——调用方事务内执行（与订单置 paid 同生共死）。
   * 行锁 + 「期内顺延 / 过期从 now 起算」；同步写冗余 status/plan_code/source。
   * 注意：锁与读必须走同一 conn（FOR UPDATE 读到的是锁窗口内的行，事务外 pool 读会绕开锁语义）。
   */
  async renewWithinTx(
    conn: PoolConnection, parentId: number, planCode: string, durationDays: number, now: Date,
  ): Promise<{ currentPeriodEnd: Date }> {
    const [locked] = await conn.execute<RowDataPacket[]>(
      `SELECT current_period_end FROM family_subscriptions WHERE parent_id = ? FOR UPDATE`,
      [parentId],
    );
    const currentEnd = (locked[0]?.current_period_end as Date | undefined) ?? null;
    const base = currentEnd != null && currentEnd.getTime() > now.getTime() ? currentEnd : now;
    const end = new Date(base.getTime() + durationDays * 86_400_000);
    if (locked.length === 0) {
      // 行不存在（异常态：付费时无行）——补偿插入
      await conn.execute(
        `INSERT INTO family_subscriptions (parent_id, status, current_period_end, plan_code, source)
         VALUES (?, 'active', ?, ?, 'order')`,
        [parentId, end, planCode],
      );
      return { currentPeriodEnd: end };
    }
    await conn.execute(
      `UPDATE family_subscriptions
       SET current_period_end = ?, status = 'active', plan_code = ?, source = 'order'
       WHERE parent_id = ?`,
      [end, planCode, parentId],
    );
    return { currentPeriodEnd: end };
  }
}
```

（`upsertTrial` 无事务直接 `pool.execute` 即可；`renewWithinTx` 全程只走传入的 `conn`。）

- [ ] **Step 2: 写 subscription-plans.repo.ts**（两个查询方法，`pool.execute`，形状照 Step 1 风格）

- [ ] **Step 3: repos/index.ts 追加 export**

- [ ] **Step 4: repo 集成测试**（连本机 DB；用一个固定测试家长 id 范围 `900000+`，用例内自行 INSERT/DELETE parents 行，测 `upsertTrial` 幂等、`renewWithinTx` 期内顺延不吞天数、`findByStudentId` JOIN 命中）。参照 `reward-catalog.repo.test.ts` 现有 beforeAll/afterAll 清理模式。

- [ ] **Step 5: 跑测试 + Commit** — `npx vitest run src/database/repositories/family-subscriptions.repo.test.ts` PASS 后 `git commit -m "feat(billing): 订阅/套餐仓储（含事务续期 renewWithinTx）"`

---

### Task 4: SubscriptionsService + 注册送试用钩子

**Files:**
- Create: `apps/server/src/modules/billing/subscriptions.service.ts`
- Modify: `apps/server/src/modules/auth/auth.service.ts`（家长注册成功路径追加钩子）
- Test: `apps/server/src/modules/billing/subscriptions.service.test.ts`（mock repo）

**Interfaces:**
- Consumes: Task 2/3 的 `effectiveStatus` / `FamilySubscriptionsRepository`
- Produces:
  - `SubscriptionsService.ensureTrial(parentId: number): Promise<void>`（`now + TRIAL_DAYS`，upsert 幂等；失败抛出让注册失败可见）
  - `SubscriptionsService.getStatusView(viewer: {role: 'student'|'parent'|'admin'; sub: number}): Promise<StatusView>`，`StatusView = { status: SubscriptionStatus; planCode: string|null; trialEndsAt: string|null; currentPeriodEnd: string|null; daysRemaining: number; source: string }`——学生按 `findByStudentId`，家长/管理员按 `findByParentId`
  - `SubscriptionsService.renewWithinTx(conn, parentId, planCode, durationDays)`（透传 repo，批② 的 finalize 事务调用）

- [ ] **Step 1: 写失败测试**（mock `FamilySubscriptionsRepository`）：
  - 学生视角：`findByStudentId` 返回 `{trial_ends_at: 未来3天, current_period_end: null}` → `{status:'trialing', daysRemaining:3, trialEndsAt: ISO, currentPeriodEnd:null, planCode:null, source:'trial'}`（ISO 字符串序列化，DTO 不裸露 Date）
  - 无行 → `{status:'expired', ...null 字段, daysRemaining:0}`
  - `ensureTrial` 调 `upsertTrial(parentId, now+7d)`（允许 ±1 分钟误差）

- [ ] **Step 2: 跑失败 → 实现 → 跑通过**（TDD 三步，实现即上述接口的直白组装；Date→ISO 用 `.toISOString()`，DB 返回的 DATETIME 是 Date 对象）

- [ ] **Step 3: 注册钩子**——读 `apps/server/src/modules/auth/auth.service.ts` 的家长注册方法（创建 parents 行处），在 parents 行插入成功后、返回响应前追加：

```typescript
await this.subscriptionsService.ensureTrial(parent.id);
```

（`auth.module.ts` imports 加 `BillingModule` 并 export `SubscriptionsService`；若注册逻辑包在事务里则把 conn 透传给 `ensureTrial(conn, parentId)`——以实际代码为准，保证**注册成功 ⇒ 试用行已存在**。）同批在 `auth.service.test.ts` 补一个用例：注册成功后 `upsertTrial` 被调用。

- [ ] **Step 4: 全量相关测试 + Commit** — `npx vitest run src/modules/billing src/modules/auth` PASS → `git commit -m "feat(billing): SubscriptionsService + 家长注册送 7 天试用钩子"`

---

### Task 5: SubscriptionGuard + 豁免清单护栏

**Files:**
- Create: `apps/server/src/modules/billing/subscription.guard.ts`
- Create: `apps/server/src/modules/billing/subscription.guard.test.ts`
- Modify: `apps/server/src/app.module.ts`（APP_GUARD 注册，顺序在既有 JwtAuthGuard/RolesGuard 之后）

**Interfaces:**
- Consumes: `FamilySubscriptionsRepository.findByStudentId` + `effectiveStatus`
- Produces: 全局 guard；豁免清单常量 `SUBSCRIPTION_EXEMPT: {method: string; pattern: RegExp}[]`

- [ ] **Step 1: 写 guard**

```typescript
import { Injectable, CanActivate, ExecutionContext, ForbiddenException } from '@nestjs/common';
import { FamilySubscriptionsRepository } from '../../database/repositories/family-subscriptions.repo.js';
import { effectiveStatus } from './subscription-status.js';

/**
 * 豁免清单（spec §4 钉死）：学生端在锁定态仍需可用的端点。
 * 护栏测试（subscription.guard.test.ts）扫这份清单——新增学生端点默认被锁，
 * 要豁免必须显式加这里并同步改护栏。
 */
export const SUBSCRIPTION_EXEMPT: { method: string; pattern: RegExp }[] = [
  { method: 'GET', pattern: /^\/api\/progress\/students\/\d+\/star-map$/ }, // 锁后学生仍看星图与锁定态
  { method: 'GET', pattern: /^\/api\/quota\/subscription$/ },               // 锁定页读状态
];

@Injectable()
export class SubscriptionGuard implements CanActivate {
  constructor(private subsRepo: FamilySubscriptionsRepository) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const req = ctx.switchToHttp().getRequest();
    const user = req.user as { sub: number; role: string } | undefined;
    // 无用户（免 JWT 链路，如渠道回调）或非学生角色一律放行——家长必须能进订阅中心
    if (!user || user.role !== 'student') return true;
    const path = req.originalUrl.split('?')[0];
    if (SUBSCRIPTION_EXEMPT.some(e => e.method === req.method && e.pattern.test(path))) return true;
    const row = await this.subsRepo.findByStudentId(user.sub);
    const status = effectiveStatus(new Date(), {
      trialEndsAt: row?.trial_ends_at ?? null,
      currentPeriodEnd: row?.current_period_end ?? null,
    });
    if (status === 'expired') {
      throw new ForbiddenException({ code: 2001, message: '订阅已过期，请联系家长续费' });
    }
    return true;
  }
}
```

- [ ] **Step 2: 测试**（mock repo + 构造 ExecutionContext `{switchToHttp: () => ({getRequest: () => req})}`）：
  - trial 未过期放行；过期 → ForbiddenException 且 `code===2001`
  - `role: 'parent'` / 无 user → 放行且**不查 repo**
  - 星图 GET 放行；同路径 POST 不豁免（仍被查）
  - **护栏**：断言 `SUBSCRIPTION_EXEMPT` 里每一项 method ∈ {GET, POST}、pattern 以 `^\/api\/` 开头且以 `$` 结尾（防手滑写成宽松前缀匹配，豁免面失控）
- [ ] **Step 3: app.module.ts 注册**——在既有 `JwtAuthGuard`/`RolesGuard` 的 APP_GUARD 之后追加 `{ provide: APP_GUARD, useClass: SubscriptionGuard }`。注意：渠道回调（批②）与 auth 是免 JWT 链路，`req.user` 为 undefined，guard 天然放行，无需额外开关。
- [ ] **Step 4: 跑 guard 测试 + 手工冒烟**（后端 `node dist/main.js` 需先 build；或临时 `npx tsx` 验证语义后弃用）——用一个真实学生 JWT curl 一个业务端点（如 `GET /api/points/me`）：试用期内 200；`UPDATE family_subscriptions SET trial_ends_at = NOW() - INTERVAL 1 DAY WHERE parent_id = <该家长>` 后重试 → 403 `{"code":2001}`。冒烟完把时刻改回。
- [ ] **Step 5: Commit** — `git commit -m "feat(billing): SubscriptionGuard 学生端硬门禁 + 豁免清单护栏"`

---

### Task 6: `GET /api/quota/subscription` 读端点

**Files:**
- Create: `apps/server/src/modules/billing/quota.controller.ts`（`@Controller('api/quota')`，`/subscription` 与 `/plans`（Task ②批的 plans/usage 后续补进同 controller））
- Modify: `apps/server/src/modules/billing/billing.module.ts`（Task 4 建模块时顺带建好：providers/exports 齐全）

**Interfaces:**
- Produces: `GET /api/quota/subscription` → 200 `{status, planCode, trialEndsAt, currentPeriodEnd, daysRemaining, source}`（家长查自己、学生查自己家；openapi 形状以此为准）

- [ ] **Step 1: controller**——`@Get('subscription')` + `@UseGuards(JwtAuthGuard, RolesGuard)`（角色不设限：student/parent/admin 都可读），直接 `return this.subscriptionsService.getStatusView(user)`。
- [ ] **Step 2: 测试**——controller 级 mock service：student 请求 → service 收到 `{role:'student', sub}`；200 形状断言。
- [ ] **Step 3: 跑测试 + 全量 + Commit**

```bash
cd apps/server && npx vitest run src/modules/billing && npm test 2>&1 | tail -3
git add -A && git commit -m "feat(billing): GET /api/quota/subscription 订阅状态读端点"
```

Expected: billing 全绿、全量无回归（此批结束时全量必须绿——门禁已生效，任何被锁端点的既有测试若走「student JWT 无订阅行」路径会 403，属预期暴露：修测试夹具给测试家长补 trial 行，**不许**往豁免清单塞业务端点）。

---

### 批① 交付边界

- 完成后：新家长注册即得 7 天试用；试用/订阅期内学生端一切正常；过期即学生端全锁（星图仍可看）；家长端无购买入口（批②③）。
- 不含：orders 下单/支付/回调、plans/usage 端点、前端页面、文档同步（批②③）。
