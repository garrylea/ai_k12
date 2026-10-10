# 单点登录互踢 + 预警同段只报一次 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use subagent-driven-development (recommended) or executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** ① 同账号同角色单点登录互踢（新登录后旧 token 下次请求 401/1013）；② away/idle 走神预警从「每 30 分钟重报」改为「同一段挂机只报一次」。

**Architecture:** 互踢 = JWT 加 `seq` claim + 进程内 `SessionRegistry`（仿 `BanRegistry` 模式）+ `auth_sessions` 表持久化，AuthMiddleware O(1) 比对、请求路径零额外 DB 往返。预警 = `SafetyAlertsService.record` 支持调用方传入去重起点 `dedupSince`（传 `hidden_since` 即「同段只报一次」），闲聊等其他类型的 30 分钟去重不变。

**Tech Stack:** NestJS + mysql2/promise（服务端）、React + vitest + testing-library（前端）。

**Spec:** `docs/superpowers/specs/2026-10-10-single-session-login-design.md`

## Global Constraints

- 测试断言与 config/设计文档冲突时**测试错**：改测试，不改 config/文档。
- 组件改动必须补渲染测试，别只靠 tsc + lint + build。
- `@testing-library/react` 多用例文件必须自己写 `afterEach(() => cleanup())`。
- Nest DI：接口类型参数运行时变 `Object`，必须 `@Optional()`；本计划新增依赖全是具体类，无此问题，但新增构造参数后**既有直接 `new` 的测试必须同步补参**。
- 迁移必须幂等（`CREATE TABLE IF NOT EXISTS`），且新表同步进 `tools/db/schema.sql`；含 DDL 的批次收尾跑 `python3 tools/db/schema_reconcile.py`。
- 错误码：**1013 = 已被踢**（1003=未登录/过期、1004=注册冲突、1005=无权访问、1006-1010 已各有归属，勿复用）。
- 前端全局跳转先例：`fetchApi` 里 `code === 2001` → `window.location.assign('/student/locked')` + 返回永不 resolve 的 Promise。1013 照此惯例。
- 服务端测试：`cd apps/server && npx vitest run <file>`；前端：`cd apps/web && npx vitest run <file>`。全量收尾：两端 `npm test`。
- 本机起后端用 `node dist/main.js`（`npx tsx src/main.ts` 的 DI 是坏的），启动前需 `npm run build` 且显式 `export JWT_SECRET`。
- ⚠️ 上线效果：存量已签发 token（无 `seq`）全部失效一次，各端需重新登录——发布说明必须写明。

---

## 批 A：预警同段只报一次

### Task 1: `SafetyAlertsService` 支持 `dedupSince` 去重起点

**Files:**
- Modify: `apps/server/src/modules/safety/safety-alerts.service.ts`
- Test: `apps/server/src/modules/safety/safety-alerts.service.test.ts`

**Interfaces:**
- Consumes: 既有 `alertsRepo.existsRecent(studentId, type, since)`（`since` 是任意 Date，签名不变）。
- Produces: `RecordSafetyAlertInput` 新增可选字段 `dedupSince?: Date`——传入时以它为去重起点（= 同段只报一次）；不传时沿用 30 分钟窗口。后续 Task 2 依赖此字段。

- [ ] **Step 1: 写失败测试**

在 `safety-alerts.service.test.ts` 的既有 `describe` 内新增两例（文件已有 `mkAlerts` / `mkSvc` / `input` / `flush` 辅助，直接用）：

```ts
it('传 dedupSince → 用它作为去重起点（同一段挂机只报一次，2026-10-10 裁决）', async () => {
  const alerts = mkAlerts();
  const svc = mkSvc(alerts);

  const segmentStart = new Date('2026-10-08T14:24:48.751Z');
  svc.record(input({ type: 'idle', dialogueId: null, level: 'info', dedupSince: segmentStart }));
  await flush();

  // 去重起点 = 挂机段起点，而不是 now-30min
  expect(alerts.existsRecent).toHaveBeenCalledWith(9, 'idle', segmentStart);
});

it('不传 dedupSince → 沿用 30 分钟窗口（闲聊等类型行为不变）', async () => {
  const alerts = mkAlerts();
  const svc = mkSvc(alerts);

  const before = Date.now();
  svc.record(input());
  await flush();

  expect(alerts.existsRecent).toHaveBeenCalledTimes(1);
  const [, , since] = alerts.existsRecent.mock.calls[0] as [number, string, Date];
  expect(since.getTime()).toBeGreaterThanOrEqual(before - DEDUPE_WINDOW_MS - 1000);
  expect(since.getTime()).toBeLessThanOrEqual(Date.now() - DEDUPE_WINDOW_MS + 1000);
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd apps/server && npx vitest run src/modules/safety/safety-alerts.service.test.ts`
Expected: 第一例 FAIL——`existsRecent` 收到的是 `now-30min` 而非 `segmentStart`（`dedupSince` 字段尚不存在，被忽略）。

- [ ] **Step 3: 最小实现**

`safety-alerts.service.ts` 两处改动：

① `RecordSafetyAlertInput` 末尾加字段（带注释）：

```ts
export interface RecordSafetyAlertInput {
  // ...既有字段不动...

  /**
   * 去重起点覆盖（2026-10-10「同段只报一次」裁决）：传入时用它替代默认的
   * now-30min 作为 `existsRecent` 的 since。走神预警传 `hidden_since`（挂机段
   * 起点），同一段挂机只报一次；闲聊/情绪/敏感不传，沿用 30 分钟窗口。
   */
  dedupSince?: Date;
}
```

② `doRecord` 里一行改动：

```ts
// 原：const since = new Date(Date.now() - DEDUPE_WINDOW_MS);
const since = input.dedupSince ?? new Date(Date.now() - DEDUPE_WINDOW_MS);
```

- [ ] **Step 4: 跑测试确认通过**

Run: `cd apps/server && npx vitest run src/modules/safety/safety-alerts.service.test.ts`
Expected: 全部 PASS（含既有用例——它们不传 `dedupSince`，行为不变）。

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/modules/safety/safety-alerts.service.ts apps/server/src/modules/safety/safety-alerts.service.test.ts
git commit -m "feat(server): SafetyAlertsRecord 支持 dedupSince 去重起点（同段只报一次的地基）"
```

### Task 2: `maybeRecordHiddenAlert` 传 `hidden_since` + 旧口径文档标注

**Files:**
- Modify: `apps/server/src/modules/analytics/study-sessions.service.ts`（`maybeRecordHiddenAlert`，约 :272-305）
- Test: `apps/server/src/modules/analytics/study-sessions.service.test.ts`
- Modify: `docs/superpowers/specs/2026-09-20-parent-alert-banner-timeliness-design.md`（去重口径标注，见 Step 5）

**Interfaces:**
- Consumes: Task 1 的 `dedupSince?: Date`。
- Produces: 走神预警（away/idle）去重语义 = 「同一段挂机（`hidden_since` 相同）只报一次」。对外 API 无变化。

- [ ] **Step 1: 写失败测试**

在 `study-sessions.service.test.ts` 的阈值判定 describe 内新增（复用文件既有 `makeRepo` / `makeSafety` / `makeControls` / `makeService` / `flushAsync` 辅助，照抄「心跳挂机阈值命中」用例的骨架）：

```ts
it('走神预警写入带 dedupSince=hiddenSince（同段只报一次；旧「30 分钟重报」口径废止）', async () => {
  const since = new Date(Date.now() - 60 * 60_000); // 挂机 1 小时，远超阈值
  const repo = makeRepo({
    heartbeat: vi.fn().mockResolvedValue({ activeSeconds: 300, hiddenSince: since, hiddenReason: 'idle' }),
  });
  const safety = makeSafety();
  const controls = makeControls({
    findAlertThresholds: vi.fn().mockResolvedValue({ awayMinutes: 2, idleMinutes: 15 }),
  });
  const service = makeService(repo, makeSubjects(), safety, controls);

  await service.heartbeat({ studentId: 9, sessionUid: baseInput().sessionUid, state: 'hidden', reason: 'idle' });
  await vi.waitFor(() => expect(safety.record).toHaveBeenCalledTimes(1));

  expect(safety.record).toHaveBeenCalledWith(
    expect.objectContaining({ dedupSince: since }),
  );
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd apps/server && npx vitest run src/modules/analytics/study-sessions.service.test.ts`
Expected: 新例 FAIL——`record` 收到的参数没有 `dedupSince`。

- [ ] **Step 3: 最小实现**

`study-sessions.service.ts` 的 `maybeRecordHiddenAlert` 里 `void this.safetyAlerts.record({...})` 增加 `dedupSince: hiddenSince`：

```ts
void this.safetyAlerts.record({
  studentId,
  dialogueId: null,
  type: hiddenReason,
  level: 'info',
  message: this.safetyAlerts.messageFor(hiddenReason, minutes),
  context: this.safetyAlerts.awayContext(hiddenReason, minutes),
  dedupSince: hiddenSince, // 2026-10-10：同一段挂机只报一次（hidden_since 即段起点）
});
```

同时把该方法的 docstring 里这句更新为：

```
* 30 分钟去重窗口在 `SafetyAlertsService` 里，所以挂机期间每次心跳重复命中也只写一条。
```
→
```
* 去重口径（2026-10-10 裁决，原「30 分钟重报」废止）：`dedupSince = hiddenSince`，
* 即同一段挂机只报一次——页面挂一夜不再每 30 分钟刷一对；学生回到 visible 再挂机
* 是新段（新 hidden_since），照常再报。
```

- [ ] **Step 4: 跑测试确认通过**

Run: `cd apps/server && npx vitest run src/modules/analytics/study-sessions.service.test.ts src/modules/safety/safety-alerts.service.test.ts`
Expected: 全部 PASS。若既有用例断言了 `record` 的**精确**入参形状（少一个字段也算不等），按「测试错」原则把该断言改成 `expect.objectContaining`。

- [ ] **Step 5: 旧口径文档标注（保留原文 + 就地注记）**

`docs/superpowers/specs/2026-09-20-parent-alert-banner-timeliness-design.md` 中涉及「30 分钟去重窗口」的**走神预警**表述（:43-45 附近两处）就地追加注记，原文保留：

```
> ⚠️ 2026-10-10 起废止：away/idle 的去重改为「同一段挂机（hidden_since 相同）只报一次」
>（`dedupSince` 机制，见 plans/2026-10-10-single-session-login-and-alert-dedupe.md 批 A）。
> 闲聊（off_topic）等其他类型的 30 分钟去重**不变**。
```

注意：`docs/UX-UI设计文档.md:537` 与 `parent-controls-and-alerts-design.md` 的「30 分钟去重」说的是**闲聊**，不在本批范围，**不要动**。

- [ ] **Step 6: Commit**

```bash
git add apps/server/src/modules/analytics/study-sessions.service.ts apps/server/src/modules/analytics/study-sessions.service.test.ts docs/superpowers/specs/2026-09-20-parent-alert-banner-timeliness-design.md
git commit -m "feat(server): 走神预警同段只报一次（dedupSince=hiddenSince），废 30 分钟重报口径"
```

---

## 批 B：单点登录互踢

### Task 3: `auth_sessions` 表（迁移 + schema.sql）

**Files:**
- Create: `tools/db/migrations/2026-10-10_auth_sessions.sql`
- Modify: `tools/db/schema.sql`（在表定义按字母序/既有组织方式插入同款 DDL）

**Interfaces:**
- Produces: 表 `auth_sessions(role, user_id, token_seq)`，唯一键 `uk_role_user(role, user_id)`。Task 4 的仓储读写它。

- [ ] **Step 1: 写迁移文件**（幂等）

```sql
-- 2026-10-10 单点登录互踢：每账号一行，token_seq = 当前有效会话序号（登录 +1）。
-- 旧 token 携带的 seq ≠ 当前行值 → AuthMiddleware 401/1013。spec: 2026-10-10-single-session-login-design.md
CREATE TABLE IF NOT EXISTS auth_sessions (
  id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  role ENUM('admin','parent','student') NOT NULL,
  user_id INT UNSIGNED NOT NULL,
  token_seq INT UNSIGNED NOT NULL DEFAULT 1,
  updated_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  UNIQUE KEY uk_role_user (role, user_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
```

- [ ] **Step 2: 应用迁移 + 同步 schema.sql**

```bash
mysql -h localhost -P 3306 -u ai_k12 -pai_k12 ai_k12 < tools/db/migrations/2026-10-10_auth_sessions.sql
```

schema.sql 插入同款 DDL（去掉注释里的「幂等」措辞差异，保持与迁移逐列一致）。

- [ ] **Step 3: 验证**

```bash
mysql --vertical -h localhost -P 3306 -u ai_k12 -pai_k12 ai_k12 -e "SHOW CREATE TABLE auth_sessions\G" 2>&1 | grep -v "Using a password"
```
Expected: 表存在、唯一键 `uk_role_user` 在。

- [ ] **Step 4: Commit**

```bash
git add tools/db/migrations/2026-10-10_auth_sessions.sql tools/db/schema.sql
git commit -m "feat(db): auth_sessions 表（单点登录互踢的 seq 持久层）"
```

### Task 4: `AuthSessionsRepository` + `SessionRegistry` + CommonModule 接线

**Files:**
- Create: `apps/server/src/database/repositories/auth-sessions.repo.ts`
- Create: `apps/server/src/common/guards/session-registry.ts`
- Create: `apps/server/src/common/guards/session-registry.test.ts`
- Create: `apps/server/src/database/repositories/auth-sessions.repo.test.ts`
- Modify: `apps/server/src/common/common.module.ts`

**Interfaces:**
- Produces:
  - `AuthSessionsRepository.bumpAndReturnSeq(role: 'admin'|'parent'|'student', userId: number): Promise<number>`（返回 bump 后的 seq）；`.listAll(): Promise<Array<{ role: 'admin'|'parent'|'student'; user_id: number; token_seq: number }>>`。
  - `SessionRegistry.bump(role, id, seq): void`；`.matches(role, id, seq: number | undefined): boolean`；`.load(rows): void`。Task 5 的中间件与 Task 6 的 AuthService 消费。

- [ ] **Step 1: 写 SessionRegistry 失败测试**（仿 `ban-registry.test.ts`）

```ts
import { describe, it, expect } from 'vitest';
import { SessionRegistry } from './session-registry';

describe('SessionRegistry', () => {
  it('bump 后 matches(同 seq) 为 true，别的 seq 为 false', () => {
    const r = new SessionRegistry();
    r.bump('student', 7, 3);
    expect(r.matches('student', 7, 3)).toBe(true);
    expect(r.matches('student', 7, 2)).toBe(false);
  });

  it('注册表无该账号行 → matches 恒 false（宁踢勿放）', () => {
    const r = new SessionRegistry();
    expect(r.matches('parent', 3, 1)).toBe(false);
  });

  it('旧格式 token（seq undefined）→ false', () => {
    const r = new SessionRegistry();
    r.bump('parent', 3, 1);
    expect(r.matches('parent', 3, undefined)).toBe(false);
  });

  it('role 隔离：同 id 不同角色互不影响', () => {
    const r = new SessionRegistry();
    r.bump('student', 1, 5);
    r.bump('parent', 1, 2);
    expect(r.matches('student', 1, 5)).toBe(true);
    expect(r.matches('parent', 1, 2)).toBe(true);
    expect(r.matches('parent', 1, 5)).toBe(false);
  });

  it('load 整表重建（替换而非合并）', () => {
    const r = new SessionRegistry();
    r.bump('student', 7, 1);
    r.load([{ role: 'student', user_id: 7, token_seq: 4 }]);
    expect(r.matches('student', 7, 4)).toBe(true);
    expect(r.matches('student', 7, 1)).toBe(false);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd apps/server && npx vitest run src/common/guards/session-registry.test.ts`
Expected: FAIL（模块不存在）。

- [ ] **Step 3: 实现 SessionRegistry**

`apps/server/src/common/guards/session-registry.ts`：

```ts
import { Injectable } from '@nestjs/common';

type Role = 'admin' | 'parent' | 'student';

/**
 * 进程内「当前有效会话序号」注册表（仿 BanRegistry 模式，2026-10-10 单点登录互踢）：
 * AuthService 登录成功时 bump（seq 与 auth_sessions 表同点写入），AuthMiddleware
 * O(1) 比对 JWT 携带的 seq；启动时经 CommonModule.onModuleInit 从表全量重建。
 *
 * 单进程假设（家庭自部署单机，spec §4）：多实例部署需换共享存储，本期明确不做。
 * 注册表无该账号行 → matches 恒 false（宁踢勿放：内存/DB 失配时旧 token 一律重登）。
 */
@Injectable()
export class SessionRegistry {
  private seqs = new Map<string, number>();

  private key(role: Role, id: number): string {
    return `${role}:${id}`;
  }

  bump(role: Role, id: number, seq: number): void {
    this.seqs.set(this.key(role, id), seq);
  }

  matches(role: Role, id: number, seq: number | undefined): boolean {
    if (seq === undefined) return false;
    return this.seqs.get(this.key(role, id)) === seq;
  }

  load(rows: Array<{ role: Role; user_id: number; token_seq: number }>): void {
    this.seqs = new Map(rows.map((r) => [`${r.role}:${r.user_id}`, Number(r.token_seq)]));
  }
}
```

- [ ] **Step 4: 写 AuthSessionsRepository 失败测试**

`apps/server/src/database/repositories/auth-sessions.repo.test.ts`（仿同目录其他 repo 测试的假 pool 模式）：

```ts
import { describe, it, expect, vi } from 'vitest';
import { AuthSessionsRepository } from './auth-sessions.repo.js';

const mkPool = () => {
  const execute = vi.fn()
    .mockResolvedValueOnce([{ affectedRows: 1 }, undefined])          // INSERT..ON DUP
    .mockResolvedValueOnce([[{ token_seq: 3 }], undefined]);          // SELECT 回读
  return { pool: { execute } as any, execute };
};

describe('AuthSessionsRepository', () => {
  it('bumpAndReturnSeq：先 upsert（无行插 1 / 有行 +1），再回读 seq', async () => {
    const { pool, execute } = mkPool();
    const repo = new AuthSessionsRepository(pool);

    await expect(repo.bumpAndReturnSeq('student', 7)).resolves.toBe(3);

    const [sql, params] = execute.mock.calls[0] as [string, unknown[]];
    expect(sql).toContain('ON DUPLICATE KEY UPDATE');
    expect(sql).toContain('token_seq = token_seq + 1');
    expect(params).toEqual(['student', 7]);
    expect(execute.mock.calls[1]![1]).toEqual(['student', 7]);
  });

  it('listAll：返回整表行', async () => {
    const execute = vi.fn().mockResolvedValue([
      [{ role: 'student', user_id: 7, token_seq: 3 }],
      undefined,
    ]);
    const repo = new AuthSessionsRepository({ execute } as any);

    await expect(repo.listAll()).resolves.toEqual([
      { role: 'student', user_id: 7, token_seq: 3 },
    ]);
    const [sql] = execute.mock.calls[0] as [string];
    expect(sql).not.toContain('WHERE'); // 全量，无过滤
  });
});
```

- [ ] **Step 5: 跑测试确认失败 → 实现仓储 → 跑测试通过**

Run: `cd apps/server && npx vitest run src/database/repositories/auth-sessions.repo.test.ts src/common/guards/session-registry.test.ts`

`apps/server/src/database/repositories/auth-sessions.repo.ts`：

```ts
import { Injectable, Inject } from '@nestjs/common';
import type { Pool, RowDataPacket } from 'mysql2/promise';

export interface AuthSessionSeqRow {
  role: 'admin' | 'parent' | 'student';
  user_id: number;
  token_seq: number;
}

/**
 * 单点登录互踢的 seq 持久层（2026-10-10）。一行 = 一个登录过的账号，token_seq =
 * 当前有效会话序号；登录 bump +1，旧 token 的 seq 立即失配。
 *
 * bump 的 upsert 与回读是两条语句、非原子：同账号**并发**登录时「最终胜者」由最后
 * 一次 bump 决定，输家 token 的 seq 必然不匹配注册表而被踢——语义正确，无需事务。
 */
@Injectable()
export class AuthSessionsRepository {
  constructor(@Inject('DATABASE_POOL') private readonly pool: Pool) {}

  async bumpAndReturnSeq(role: AuthSessionSeqRow['role'], userId: number): Promise<number> {
    await this.pool.execute(
      `INSERT INTO auth_sessions (role, user_id, token_seq) VALUES (?, ?, 1)
       ON DUPLICATE KEY UPDATE token_seq = token_seq + 1`,
      [role, userId],
    );
    const [rows] = await this.pool.execute<(RowDataPacket & { token_seq: number })[]>(
      `SELECT token_seq FROM auth_sessions WHERE role = ? AND user_id = ?`,
      [role, userId],
    );
    return Number(rows[0]?.token_seq ?? 1);
  }

  /** 启动时 SessionRegistry 全量重建用（一行 = 一个登录过的账号，表很小）。 */
  async listAll(): Promise<AuthSessionSeqRow[]> {
    const [rows] = await this.pool.execute<AuthSessionSeqRow[]>(
      `SELECT role, user_id, token_seq FROM auth_sessions`,
    );
    return rows;
  }
}
```

- [ ] **Step 6: CommonModule 接线（provide + 启动重建）**

`common.module.ts`：providers/exports 各加 `SessionRegistry, AuthSessionsRepository`，构造注入 `sessionRegistry` 与 `authSessionsRepo`，`onModuleInit` 里重建：

```ts
async onModuleInit() {
  // ...既有 banRegistry.load 不动...

  // 启动时从 auth_sessions 重建会话序号注册表。失败 → 注册表为空 → 所有旧 token
  // 视为失配被踢（宁踢勿放，各端重新登录即恢复）；与 ban 的 fail-open 相反，必须
  // 大声记录而不是静默吞掉。
  try {
    this.sessionRegistry.load(await this.authSessionsRepo.listAll());
  } catch (err) {
    Logger.error(`SessionRegistry 启动重建失败（所有旧 token 将被踢，需重新登录）：${String(err)}`);
  }
}
```

（import `Logger` from `@nestjs/common`，类上加 `private readonly logger = new Logger(CommonModule.name);` 则用 `this.logger.error(...)`。）

- [ ] **Step 7: 全量跑 common + repo 相关测试**

Run: `cd apps/server && npx vitest run src/common src/database/repositories`
Expected: 全部 PASS。

- [ ] **Step 8: Commit**

```bash
git add apps/server/src/common/guards/session-registry.ts apps/server/src/common/guards/session-registry.test.ts apps/server/src/database/repositories/auth-sessions.repo.ts apps/server/src/database/repositories/auth-sessions.repo.test.ts apps/server/src/common/common.module.ts
git commit -m "feat(server): SessionRegistry + AuthSessionsRepository（互踢的内存注册表与持久层）"
```

### Task 5: AuthMiddleware seq 校验（401/1013）

**Files:**
- Modify: `apps/server/src/common/guards/jwt-auth.guard.ts`（`JwtUser` 加 `seq?: number`）
- Modify: `apps/server/src/common/middleware/auth.middleware.ts`
- Create: `apps/server/src/common/middleware/auth.middleware.test.ts`

**Interfaces:**
- Consumes: Task 4 的 `SessionRegistry.matches(role, id, seq)`。
- Produces: 鉴权失败语义——seq 失配/缺失 → `UnauthorizedException({ code: 1013, message: '账号已在其他设备登录' })`。Task 7 前端消费该码。

- [ ] **Step 1: 写失败测试**

`apps/server/src/common/middleware/auth.middleware.test.ts`（新文件；该中间件此前无单测，整文件新建，无需 cleanup——纯函数式用例）：

```ts
import { describe, it, expect, vi } from 'vitest';
import { AuthMiddleware } from './auth.middleware.js';
import { SessionRegistry } from '../guards/session-registry.js';

const TOKEN = 'tok';
const bearer = `Bearer ${TOKEN}`;

function mkDeps() {
  return {
    jwtService: { verify: vi.fn() },
    banRegistry: { isBanned: vi.fn().mockReturnValue(false) },
    sessionRegistry: new SessionRegistry(),
  };
}

describe('AuthMiddleware —— 单点登录互踢（seq 校验）', () => {
  it('seq 匹配 → request.user 挂载、放行', () => {
    const d = mkDeps();
    d.jwtService.verify.mockReturnValue({ sub: 7, role: 'student', seq: 3 });
    d.sessionRegistry.bump('student', 7, 3);
    const r = { headers: { authorization: bearer } } as any;
    const next = vi.fn();

    new AuthMiddleware(d.jwtService as any, d.banRegistry as any, d.sessionRegistry).use(r, {} as any, next);

    expect(next).toHaveBeenCalledTimes(1);
    expect(r.user).toMatchObject({ sub: 7, role: 'student' });
  });

  it('seq 失配（已在别处重新登录）→ 401/1013，穿透吞错分支直接抛', () => {
    const d = mkDeps();
    d.jwtService.verify.mockReturnValue({ sub: 7, role: 'student', seq: 2 });
    d.sessionRegistry.bump('student', 7, 3);
    const next = vi.fn();

    expect(() =>
      new AuthMiddleware(d.jwtService as any, d.banRegistry as any, d.sessionRegistry).use(
        { headers: { authorization: bearer } } as any, {} as any, next,
      ),
    ).toThrowError(
      expect.objectContaining({ response: { code: 1013, message: '账号已在其他设备登录' } }),
    );
    expect(next).not.toHaveBeenCalled();
  });

  it('旧格式 token（无 seq，上线前签发）→ 401/1013', () => {
    const d = mkDeps();
    d.jwtService.verify.mockReturnValue({ sub: 7, role: 'student' }); // 无 seq
    d.sessionRegistry.bump('student', 7, 1);
    const next = vi.fn();

    expect(() =>
      new AuthMiddleware(d.jwtService as any, d.banRegistry as any, d.sessionRegistry).use(
        { headers: { authorization: bearer } } as any, {} as any, next,
      ),
    ).toThrowError(expect.objectContaining({ response: expect.objectContaining({ code: 1013 }) }));
  });

  it('无效 token → 保持既有行为：吞掉、user 不挂、放行交给 guard', () => {
    const d = mkDeps();
    d.jwtService.verify.mockImplementation(() => { throw new Error('bad'); });
    const r = { headers: { authorization: bearer } } as any;
    const next = vi.fn();

    new AuthMiddleware(d.jwtService as any, d.banRegistry as any, d.sessionRegistry).use(r, {} as any, next);

    expect(next).toHaveBeenCalledTimes(1);
    expect(r.user).toBeUndefined();
  });

  it('无 Authorization 头 → no-op 放行（公开路由保持开放）', () => {
    const d = mkDeps();
    const next = vi.fn();
    new AuthMiddleware(d.jwtService as any, d.banRegistry as any, d.sessionRegistry).use({ headers: {} } as any, {} as any, next);
    expect(next).toHaveBeenCalledTimes(1);
    expect(d.jwtService.verify).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd apps/server && npx vitest run src/common/middleware/auth.middleware.test.ts`
Expected: FAIL——`AuthMiddleware` 构造函数只收 2 参（第三参 undefined → matches 报错或恒 false 的意外行为）。

- [ ] **Step 3: 实现**

`jwt-auth.guard.ts` 的 `JwtUser` 加一行：

```ts
export interface JwtUser {
  sub: number;
  role: 'admin' | 'parent' | 'student';
  /** 仅学生 token 携带（= parent_id）；家长/管理员无。 */
  familyId?: number;
  parentId?: number;
  /** 会话序号（2026-10-10 单点登录互踢）：与 SessionRegistry 当前值失配 → 401/1013。 */
  seq?: number;
}
```

`auth.middleware.ts`：构造注入 `SessionRegistry`（import 自 `../guards/session-registry.js`）；在两个 ban 检查之后、`(req as ...).user = {...}` 之前插入：

```ts
// 单点登录互踢（2026-10-10）：token 携带的 seq 与注册表当前 seq 失配 = 已在别处重新
// 登录。旧格式 token（无 seq）一律失配 → 上线后存量登录全部重登一次（预期行为）。
// 抛 UnauthorizedException 会被下方 catch 捕获再原样重抛（instanceof 分支），与封禁
// 401 同一条穿透路径，最终由 HttpExceptionFilter 渲染成 { code: 1013, ... }。
if (!this.sessionRegistry.matches(payload.role, payload.sub, payload.seq)) {
  throw new UnauthorizedException({ code: 1013, message: '账号已在其他设备登录' });
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `cd apps/server && npx vitest run src/common`
Expected: 全部 PASS（含既有 ban-registry / roles.guard 用例——中间件构造参数变了，若有**直接 new AuthMiddleware** 的既有测试须同步补第三参，没有则无事）。

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/common/guards/jwt-auth.guard.ts apps/server/src/common/middleware/auth.middleware.ts apps/server/src/common/middleware/auth.middleware.test.ts
git commit -m "feat(server): AuthMiddleware 校验 token seq，失配 401/1013（单点登录互踢核心）"
```

### Task 6: AuthService 登录/注册 bump seq + 模块接线

**Files:**
- Modify: `apps/server/src/modules/auth/auth.service.ts`
- Modify: `apps/server/src/modules/auth/auth.module.ts`
- Modify: `apps/server/src/modules/auth/auth.service.test.ts`

**Interfaces:**
- Consumes: Task 4 的 `AuthSessionsRepository.bumpAndReturnSeq` / `SessionRegistry.bump`。
- Produces: token payload 带 `seq`；`POST /api/auth/login` 与 `POST /api/auth/register` 的返回形状不变（`{ token, user }`），差异只在 token 内容。

- [ ] **Step 1: 更新失败测试**

`auth.service.test.ts`：

① `d` 工厂（第 40-50 行附近的依赖对象）加两项：

```ts
authSessionsRepo: { bumpAndReturnSeq: vi.fn().mockResolvedValue(1) },
sessionRegistry: { bump: vi.fn() },
```

② 既有 sign 断言全部补 `seq: 1`：

```ts
// 原：expect(d.jwtService.sign).toHaveBeenCalledWith({ sub: 1, role: 'admin' });
expect(d.jwtService.sign).toHaveBeenCalledWith({ sub: 1, role: 'admin', seq: 1 });
// parent / student 同理（student 的断言：{ sub: 7, role: 'student', familyId: 3, parentId: 3, seq: 1 }）
```

③ 新增三例：

```ts
it('登录成功 → bump（写库 + 注册表）先于签名，seq 进入 token', async () => {
  d.authSessionsRepo.bumpAndReturnSeq.mockResolvedValue(7);
  await svc.login(<该文件既有学生账号入参>);
  expect(d.authSessionsRepo.bumpAndReturnSeq).toHaveBeenCalledWith('student', 7);
  expect(d.sessionRegistry.bump).toHaveBeenCalledWith('student', 7, 7);
  expect(d.jwtService.sign).toHaveBeenCalledWith(
    expect.objectContaining({ sub: 7, role: 'student', seq: 7 }),
  );
});

it('密码错误 → 不 bump（不产生新会话序号）', async () => {
  // 复用既有「密码错误」用例的 mock 形态（assertPassword 走 bcrypt 假实现）
  await expect(svc.login(<用户名>, <错误密码>)).rejects.toMatchObject({ response: { code: 1003 } });
  expect(d.authSessionsRepo.bumpAndReturnSeq).not.toHaveBeenCalled();
});

it('bump 写库失败 → 登录整体失败（500），绝不签发无 seq / 旧 seq 的 token', async () => {
  d.authSessionsRepo.bumpAndReturnSeq.mockRejectedValue(new Error('db down'));
  await expect(svc.login(<有效入参>)).rejects.toThrow('db down');
  expect(d.jwtService.sign).not.toHaveBeenCalled();
});

it('同账号二次登录 → 第一次的 token seq 失配（互踢语义，服务级链路）', async () => {
  const registry = new SessionRegistry();
  // 用真实 SessionRegistry + bumpAndReturnSeq mock 计数 1、2：
  let n = 0;
  d.authSessionsRepo.bumpAndReturnSeq.mockImplementation(async () => ++n);
  d.sessionRegistry = registry; // d.sessionRegistry 用真实实例注入 svc
  await svc.login(<学生入参>);
  await svc.login(<学生入参>);
  expect(registry.matches('student', 7, 1)).toBe(false); // 第一个 token 已被踢
  expect(registry.matches('student', 7, 2)).toBe(true);
});
```

（尖括号处填该文件既有的账号/密码 mock 入参，与相邻用例保持同一形态。admin/parent 分支的 bump 断言若既有用例覆盖了三种角色登录，各补 `toHaveBeenCalledWith('admin'|'parent', <id>)` 一行即可。）

- [ ] **Step 2: 跑测试确认失败**

Run: `cd apps/server && npx vitest run src/modules/auth/auth.service.test.ts`
Expected: FAIL——`d.authSessionsRepo` 为 undefined（构造缺参）或 sign 断言缺 seq。

- [ ] **Step 3: 实现**

`auth.service.ts`：

① import 并构造注入（放在既有依赖之后）：

```ts
import { AuthSessionsRepository } from '../../database/repositories/auth-sessions.repo.js';
import { SessionRegistry } from '../../common/guards/session-registry.js';
// 构造参数追加：
private authSessionsRepo: AuthSessionsRepository,
private sessionRegistry: SessionRegistry,
```

② 私有方法（放在 `assertPassword` 后）：

```ts
/**
 * 登录 bump（2026-10-10 单点登录互踢）：新登录使该账号所有旧 token 失效。
 * 必须先于签名 await 完成：写库失败直接抛（→ 500），**绝不能**在 seq 未持久化时
 * 签发 token——否则两台设备拿到相同 seq，互踢静默失效（spec §2.3）。
 */
private async bumpSession(role: 'admin' | 'parent' | 'student', id: number): Promise<number> {
  const seq = await this.authSessionsRepo.bumpAndReturnSeq(role, id);
  this.sessionRegistry.bump(role, id, seq);
  return seq;
}
```

③ `login` 三个分支：`assertPassword` 之后、`sign` 之前各加 `const seq = await this.bumpSession('<role>', <id>);`，sign payload 补 `seq`：

```ts
// admin：token: this.jwtService.sign({ sub: admin.id, role: 'admin' as const, seq })
// parent：token: this.jwtService.sign({ sub: parent.id, role: 'parent' as const, seq })
// student：token: this.jwtService.sign({ sub: student.id, role: 'student' as const, familyId: student.parentId, parentId: student.parentId, seq })
```

④ `register`：`ensureTrial` 之后 `const seq = await this.bumpSession('parent', parentId);`，sign 补 `seq`。

`auth.module.ts`：imports 加 `CommonModule`（拿 `SessionRegistry` 与 `AuthSessionsRepository`——两者都在 CommonModule 的 providers/exports 里）：

```ts
import { CommonModule } from '../../common/common.module.js';
// imports: [BillingModule, CommonModule, JwtModule.register({...})]
```

- [ ] **Step 4: 跑测试确认通过**

Run: `cd apps/server && npx vitest run src/modules/auth`
Expected: 全部 PASS。

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/modules/auth/auth.service.ts apps/server/src/modules/auth/auth.module.ts apps/server/src/modules/auth/auth.service.test.ts
git commit -m "feat(server): 登录/注册 bump 会话 seq（同账号同角色互踢生效）"
```

### Task 7: 前端 1013 拦截 + 登录页被踢提示

**Files:**
- Modify: `apps/web/src/services/api.ts`（`fetchApi`，约 :40-69）
- Modify: `apps/web/src/pages/auth/LoginPage.tsx`（:13 的 error 初值）
- Test: `apps/web/src/services/api.test.ts`、`apps/web/src/pages/auth/LoginPage.test.tsx`

**Interfaces:**
- Consumes: 服务端 401 响应体 `{ code: 1013, message: '账号已在其他设备登录', data: null }`（HttpExceptionFilter 渲染）；`authStorage.ts` 既有 `clearAuthSession()`。
- Produces: 全局行为——任意 API 返回 1013 → 清登录态 → 跳 `/login?kicked=1`。三端（学生/家长/管理）与 PC App 共用。

- [ ] **Step 1: 写 api.test.ts 失败测试**（照 2001 用例同款骨架，:368 附近；`stubFetch` / `stubLocationAssign` 为该文件既有辅助）

```ts
it('code=1013 → 清登录态 + window.location.assign 到 /login?kicked=1，Promise 永不 resolve', async () => {
  const assign = stubLocationAssign();
  localStorage.setItem('token', 't');
  sessionStorage.setItem('userRole', 'student');
  stubFetch(401, { code: 1013, message: '账号已在其他设备登录', data: null });

  let outcome: 'resolved' | 'rejected' | 'pending' = 'pending';
  void getMyPoints().then(
    () => { outcome = 'resolved'; },
    () => { outcome = 'rejected'; },
  );

  await vi.waitFor(() => expect(assign).toHaveBeenCalledWith('/login?kicked=1'));
  await new Promise((resolve) => setTimeout(resolve, 20));
  expect(outcome).toBe('pending');
  // 两个 storage 的鉴权键都被清掉
  expect(localStorage.getItem('token')).toBeNull();
  expect(sessionStorage.getItem('userRole')).toBeNull();
});

it('code=1003（token 过期）→ 行为不变，仍抛 ApiError', async () => {
  const assign = stubLocationAssign();
  stubFetch(401, { code: 1003, message: '未登录或 token 已过期', data: null });
  await expect(getMyPoints()).rejects.toMatchObject({ code: 1003 });
  expect(assign).not.toHaveBeenCalled();
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd apps/web && npx vitest run src/services/api.test.ts`
Expected: 1013 例 FAIL——现实现走 `throw new ApiError`，不跳转、不清 storage。

- [ ] **Step 3: 实现 fetchApi 分支**

`api.ts` 顶部加 `import { clearAuthSession } from '@/services/authStorage';`（`getAuthToken` 已从该模块导入，合并进同一行）。`fetchApi` 的 `json.code === 2001` 分支**之前**插入：

```ts
if (json.code === 1013) {
  // 单点登录互踢（2026-10-10）：该账号已在别处重新登录。清本地登录态并回登录页，
  // kicked=1 供登录页展示提示。与 2001 同惯例：返回永不 resolve 的 Promise，页面即将整体跳走。
  clearAuthSession();
  window.location.assign('/login?kicked=1');
  return new Promise<T>(() => {});
}
```

- [ ] **Step 4: 写 LoginPage 失败测试 → 实现**

`LoginPage.test.tsx` 新增两例（渲染方式照该文件既有 helper）：

```ts
it('URL 带 kicked=1 → 页面展示「账号已在其他设备登录，请重新登录」', () => {
  window.history.replaceState(null, '', '/login?kicked=1');
  renderLogin();
  expect(screen.getByText('账号已在其他设备登录，请重新登录')).toBeInTheDocument();
});

it('无 kicked 参数 → 不显示该提示', () => {
  window.history.replaceState(null, '', '/login');
  renderLogin();
  expect(screen.queryByText('账号已在其他设备登录，请重新登录')).toBeNull();
});
```

先跑确认失败（Run: `cd apps/web && npx vitest run src/pages/auth/LoginPage.test.tsx`），然后改 `LoginPage.tsx:13`：

```ts
const [error, setError] = useState(
  new URLSearchParams(window.location.search).get('kicked') === '1'
    ? '账号已在其他设备登录，请重新登录'
    : '',
);
```

（提示复用既有 `error` 红字样式块（:156-158），无需新 UI。用户开始输入后照常可被 `setError('')` 清掉。）

- [ ] **Step 5: 跑两端测试确认通过**

Run: `cd apps/web && npx vitest run src/services/api.test.ts src/pages/auth/LoginPage.test.tsx`
Expected: 全部 PASS。

- [ ] **Step 6: Commit**

```bash
git add apps/web/src/services/api.ts apps/web/src/services/api.test.ts apps/web/src/pages/auth/LoginPage.tsx apps/web/src/pages/auth/LoginPage.test.tsx
git commit -m "feat(web): 401/1013 全局拦截清登录态回登录页，登录页展示被踢提示"
```

### Task 8: 文档同步 + 全量验证 + changelog

**Files:**
- Modify: `docs/API接口与数据流设计文档.md`（§4.1 认证的 401 错误码清单）
- Modify: `docs/api/openapi.yaml`（401 响应描述处）
- Modify: `docs/ai-core-changelog.md`（顶部新条目）

**Interfaces:** 无代码接口；文档与实现一致性的收尾。

- [ ] **Step 1: API 文档补 1013**

§4.1（统一登录）的错误码清单加一行（紧邻 1003）：

```
| 1013 | 401 | 账号已在其他设备登录（单点登录互踢：新登录后旧 token 下次请求失效） |
```

并在 §4.1 或 §5 相应数据流处补一句口径：惰性失效——旧端在**下一次请求**时感知（学习页心跳 30s，其他页面到下次操作）；同浏览器多标签页共用同一登录态不受影响；修改/重置密码不踢已发 token。openapi.yaml 中凡是描述 401/1003 的响应处同步补 1013（`grep -n "1003" docs/api/openapi.yaml` 定位）。

- [ ] **Step 2: schema 对账**

```bash
python3 tools/db/schema_reconcile.py
```
Expected: `auth_sessions` 在账、总表数 75→76、无 diff。

- [ ] **Step 3: 全量测试 + lint**

```bash
cd apps/server && npm test && npm run lint
cd ../web && npm test && npm run lint
```
Expected: 全部 PASS（lint 的 2 个存量 error 在 tracker.test.ts / MobilePointsPage.test.tsx，与本批无关，勿顺手修）。

- [ ] **Step 4: changelog 条目**

`docs/ai-core-changelog.md` 顶部追加 `## 2026-10-10 · 单点登录互踢 + 走神预警同段只报一次`：记录裁决（同账号同角色、401 惰性失效、方案 A token seq、预警同段只报一次）、实现落点、**上线须知**（① 存量 token 全失效需重登；② 本机重启后端须 `npm run build` + `export JWT_SECRET` + `node dist/main.js`；③ `SessionRegistry` 单进程假设）。

- [ ] **Step 5: Commit**

```bash
git add docs/API接口与数据流设计文档.md docs/api/openapi.yaml docs/ai-core-changelog.md
git commit -m "docs: API 文档/openapi 补 401/1013；changelog 记互踢 + 预警去重口径批"
```

---

## 附：手动冒烟清单（实现完成后，用户真机走查）

1. 设备 A 登录学生账号 → 设备 B 登录同一学生账号 → 设备 A 点任意页面 → 弹回登录页并见「账号已在其他设备登录」。
2. 家长手机（PWA）登录 → 家长电脑登录 → 手机端下次轮询（30s 内）被踢回登录页。
3. 同一浏览器开两个标签页 → 均正常使用（共用 token，不互踢）。
4. 修改密码后旧标签页仍可用（不踢，维持现状）。
5. 学生页面挂机不动（> 阈值）→ 家长端只收到**一条**预警；挂一夜不再每 30 分钟刷屏。
