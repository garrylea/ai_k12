# 埋点 Phase 2「Ops 产品面」实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use subagent-driven-development (recommended) or executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 行为事件采集（behavior_events 建表 + EventsService + `/api/track/events` + 前端显式事件）+ 运营端 11 个聚合端点 + admin 分析 8 页。

**Architecture:** 单分支 `feat/analytics-phase2-ops` 一波合并。服务端在既有 `modules/analytics/` 内扩展（EventsService 写事件、ops-analytics 三件套读聚合）；前端在既有 `analytics/tracker.ts` 上加事件队列通道，admin 页面新目录 `pages/admin/analytics/`。spec：`docs/superpowers/specs/2026-10-09-analytics-phase2-ops-design.md`（下称 **delta spec**），母 spec `2026-09-19-analytics-instrumentation-design.md`。

**Tech Stack:** NestJS + mysql2（Pool 注入）、React Router + vitest（jsdom、globals:false）、recharts（经 ChartLine/ChartBar 封装）。

## Global Constraints（每条都在 spec 定过死，所有任务隐含遵守）

- 隐私三道锁：① `EVENT_TIER` 是 tier 唯一真源、未登记事件拒写、调用方不可覆盖；② `parent-analytics.repo.ts` 一切查询硬编码 `tier='parent'`；③ 守卫测试断言该文件不含 `hint_requested`/`answer_revealed`/`self_assess_answered`/`consecutive_failures`/`study_session_idle`。
- 任何埋点异常**不许让请求 500**：`EventsService.track()` 吞掉一切异常只 `console.warn`。
- 「正确率」类指标 `answered=0 → null`，不许写 0；`usage_source='unavailable'` 不许当 0 求和；凡「量不到」写 NULL 不写 0。
- 时间窗 `from,to`（YYYY-MM-DD，缺省近 7 天）**应用层**算窗口再传参，禁用 `CURDATE()`。
- 分页 20/页，`page` 从 1 起；`LIMIT ?` 与多行 INSERT **必须走 `pool.query`**（不能用 `pool.execute`，护栏测试 `database/repositories/llm-usage.repo.test.ts:12` 是先例）。
- llm 聚合**按 model_key**，不按 model_id（母 spec 陷阱 #5）。
- 白名单参数越界 → 400/1001（`BadRequestException({code:1001,...})`，走 `parseInput` 模式，Zod 裸 parse 会 500）。
- 新增 admin 端点全部 `@Roles('admin')` + `@UseGuards(JwtAuthGuard, RolesGuard)`；样式全 token、禁灰阶快捷写法、不引入 emoji。
- 迁移幂等 `CREATE TABLE IF NOT EXISTS`，手工 apply，**必须同步 `tools/db/schema.sql`**。
- 测试纪律：`globals:false` 显式 import；多用例文件 `afterEach(() => cleanup())`；「参数顺序↔列清单」的 INSERT 按列名配对断言。
- 起服务用 `node dist/main.js`（tsx DI 是坏的）；冒烟独立端口 + 按 PID 收尾，**别 pkill**。

---

## File Structure（新建/修改全景）

```
tools/db/migrations/2026-10-09_behavior_events.sql        [新建] 建表迁移
tools/db/schema.sql                                        [修改] behavior_events DDL（1352-1470 一带的 analytics 表区）
docs/K12智学系统-数据库设计文档.md                          [修改] 新表章节
apps/server/src/database/repositories/
  behavior-events.repo.ts            [新建] insertMany（多行 INSERT，列名配对）
  behavior-events.repo.test.ts       [新建]
apps/server/src/modules/analytics/
  events.service.ts                  [新建] EVENT_TIER 字典 + CLIENT_ALLOWED_EVENTS + track()
  events.service.test.ts             [新建]
  track.controller.ts                [新建] POST /api/track/events
  track.controller.test.ts           [新建]
  ops-analytics.repo.ts              [新建] 11 端点全部只读 SQL
  ops-analytics.repo.test.ts         [新建]
  ops-analytics.service.ts           [新建] 窗口计算、白名单校验、漏斗步骤定义
  ops-analytics.service.test.ts      [新建]
  admin-analytics.controller.ts      [新建] 11 个 GET，@Roles('admin')
  analytics.module.ts                [修改] 注册上述 provider/controller
  analytics.controller.ts            [修改] AnalyticsInterceptor skip 名单核对
apps/server/src/modules/practice/judge-core.service.ts     [修改] 5 个事件挂载 + 连错 Map
apps/server/src/modules/points/points.service.ts           [修改] points_awarded
apps/server/src/modules/practice/practice.controller.ts    [修改] hint_requested（:66）
apps/server/src/modules/training/training.controller.ts    [修改] hint_requested（:115）
apps/server/src/modules/exams/exams.service.ts             [修改] exam_submitted（:231）
apps/server/src/modules/training/{training.service.ts, meaning.service.ts, vocabulary.service.ts} [修改] special_unit_judged（:257/:507/:290/:464）
apps/server/src/database/repositories/study-sessions.repo.ts [修改] closeStale 返回收尾行（:305）
apps/server/src/modules/analytics/study-sessions.service.ts  [修改] closeStale 兜底发事件
apps/server/src/modules/analytics/analytics.module.ts        [修改] setLlmCallSink 回调里判 isFallback → llm_fallback_triggered
apps/web/src/services/api.ts                                 [修改] trackEvents + adminAnalytics 组
apps/web/src/analytics/tracker.ts                            [修改] 事件队列 + trackEvent + 节流 + session 两事件
apps/web/src/hooks/useAuxChat.ts                             [修改] ai_message_sent（:234 send）
apps/web/src/hooks/useDiscussChat.ts                         [修改] ai_message_sent（send）
apps/web/src/components/business/practice/QuestionRunner.tsx [修改] answer_revealed（:371-378 self_assess 展示参考答案处）
apps/web/src/components/layout/AdminNav.tsx                  [修改] navItems 加「数据分析」
apps/web/src/routes/routeTable.tsx                           [修改] /admin/analytics 8 条子路由
apps/web/src/pages/admin/analytics/                          [新建] shared.tsx + 8 页 + 各自 .test.tsx
docs/API接口与数据流设计文档.md / docs/api/openapi.yaml / docs/ai-core-changelog.md  [修改]
```

---

### Task 1: behavior_events 建表（迁移 + schema + DB 文档）

**Files:**
- Create: `tools/db/migrations/2026-10-09_behavior_events.sql`
- Modify: `tools/db/schema.sql`（插到 analytics 表区，`special_practice_logs` 之前）
- Modify: `docs/K12智学系统-数据库设计文档.md`

**Interfaces:**
- Produces: 表 `behavior_events`（列与索引见下，delta spec §2 = 母 spec §4.3 原文）

- [ ] **Step 1: 写迁移文件**

```sql
-- 2026-10-09_behavior_events.sql
-- 埋点 Phase 2：行为事件流（母 spec 2026-09-19-analytics-instrumentation-design.md §4.3 原文 DDL）。
-- 幂等：CREATE TABLE IF NOT EXISTS。手工 apply：
--   mysql -u root -p ai_k12 < tools/db/migrations/2026-10-09_behavior_events.sql
CREATE TABLE IF NOT EXISTS behavior_events (
  id           BIGINT AUTO_INCREMENT PRIMARY KEY,
  actor_role   VARCHAR(10)  NOT NULL DEFAULT 'student' COMMENT 'student|parent|admin|system',
  student_id   BIGINT       DEFAULT NULL COMMENT 'admin/parent/匿名事件为 NULL',
  event        VARCHAR(40)  NOT NULL COMMENT '封闭字典，见母 spec §5.2',
  tier         VARCHAR(8)   NOT NULL COMMENT 'parent|ops —— 写时由字典决定，调用方不可覆盖',
  module       VARCHAR(32)  DEFAULT NULL,
  scene        VARCHAR(40)  DEFAULT NULL,
  subject_id   BIGINT       DEFAULT NULL,
  ref_type     VARCHAR(24)  DEFAULT NULL,
  ref_id       BIGINT       DEFAULT NULL,
  session_uid  CHAR(36)     DEFAULT NULL COMMENT '关联 study_sessions.session_uid',
  request_id   VARCHAR(64)  DEFAULT NULL COMMENT '关联 api_request_logs.request_id',
  source       VARCHAR(8)   NOT NULL COMMENT 'server|client',
  props        JSON         DEFAULT NULL COMMENT '只放低基数补充，禁止塞自由文本',
  client_ts_ms BIGINT       DEFAULT NULL COMMENT '仅参考，以 created_at 为准',
  created_at   DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  KEY idx_be_student_event_time (student_id, event, created_at),
  KEY idx_be_event_time         (event, created_at),
  KEY idx_be_module_time        (module, created_at),
  KEY idx_be_tier_time          (tier, created_at),
  KEY idx_be_session            (session_uid),
  CONSTRAINT fk_be_student_id FOREIGN KEY (student_id) REFERENCES students (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
```

- [ ] **Step 2: schema.sql 同步**——把同一 DDL（去掉注释头）插入 `tools/db/schema.sql` 的 analytics 表区（`special_practice_logs` 建表语句之前，约 :1470 处），加一行区块注释 `-- ---- behavior_events：行为事件流（母 spec §4.3；2026-10-09 Phase 2） ----`。

- [ ] **Step 3: apply 到本机库并验幂等**

Run: `mysql -u root -p ai_k12 < tools/db/migrations/2026-10-09_behavior_events.sql && mysql -u root -p ai_k12 < tools/db/migrations/2026-10-09_behavior_events.sql && mysql -u root -p ai_k12 --vertical -e "SHOW CREATE TABLE behavior_events\G" | head -5`
Expected: 两次执行都无报错；`SHOW CREATE TABLE` 能看到表。（本机 mysql 9.5 非交互 `-e` 不认 `\G`，必须 `--vertical`。）

- [ ] **Step 4: DB 设计文档**——`docs/K12智学系统-数据库设计文档.md` 在 analytics 三表（study_sessions 等）之后加 `behavior_events` 小节：用途一句话 + 列表 + 「tier 写时定、家长端查询硬过滤」注记 + 版本号递增。

- [ ] **Step 5: Commit**

```bash
git add tools/db/migrations/2026-10-09_behavior_events.sql tools/db/schema.sql docs/K12智学系统-数据库设计文档.md
git commit -m "feat(analytics): behavior_events 建表（迁移+schema+DB文档）"
```

---

### Task 2: BehaviorEventsRepository + EventsService（字典与三道锁）

**Files:**
- Create: `apps/server/src/database/repositories/behavior-events.repo.ts`
- Create: `apps/server/src/database/repositories/behavior-events.repo.test.ts`
- Create: `apps/server/src/modules/analytics/events.service.ts`
- Create: `apps/server/src/modules/analytics/events.service.test.ts`
- Modify: `apps/server/src/modules/analytics/analytics.module.ts`（providers 加两个类）
- Create: `apps/server/src/database/repositories/parent-analytics.privacy-guard.test.ts`

**Interfaces:**
- Produces（后续任务依赖）:
  - `EVENT_TIER: { [event: string]: 'parent' | 'ops' }`——17 个键（母 spec §5.2 除 `study_session_heartbeat` 外全部；`card_flipped` 在册但本期无发射点）。
  - `CLIENT_ALLOWED_EVENTS: ReadonlySet<string>`——7 个 client 可上报事件。
  - `type TrackEventInput = { event: string; actorRole?: string; studentId?: number | null; module?: string | null; scene?: string | null; subjectId?: number | null; refType?: string | null; refId?: number | null; sessionUid?: string | null; requestId?: string | null; source: 'server' | 'client'; props?: Record<string, unknown> | null; clientTsMs?: number | null }`。
  - `EventsService.track(input: TrackEventInput): void`——同步返回、fire-and-forget、绝不抛。
  - `EventsService.recordMany(inputs: TrackEventInput[]): { accepted: number; rejected: number }`——采集端点用，**会抛**（校验失败计 rejected，DB 失败向上抛 500）。
  - `BehaviorEventsRepository.insertMany(rows: BehaviorEventRow[]): Promise<void>`——多行 INSERT，占位符动态，走 `pool.query`。

- [ ] **Step 1: 写 repo 失败测试**

```ts
// apps/server/src/database/repositories/behavior-events.repo.test.ts
import { describe, expect, it, vi } from 'vitest';
import { BehaviorEventsRepository } from './behavior-events.repo.js';

function makePool() {
  return { query: vi.fn(async () => [[]]) } as any;
}

describe('BehaviorEventsRepository', () => {
  it('insertMany 走 pool.query（不用 execute）且按列名配对占位符', async () => {
    const pool = makePool();
    const repo = new BehaviorEventsRepository(pool);
    await repo.insertMany([
      { actor_role: 'student', student_id: 7, event: 'answer_submitted', tier: 'parent', source: 'server' },
      { actor_role: 'student', student_id: 7, event: 'page_view', tier: 'ops', source: 'client', props: JSON.stringify({ route: '/x' }) },
    ]);
    expect(pool.query).toHaveBeenCalledTimes(1);
    const [sql, params] = pool.query.mock.calls[0];
    expect(sql).toContain('INSERT INTO behavior_events');
    // 列清单与 VALUES 占位符数量一致（2 行 × 15 列）
    expect(sql.match(/\?/g)!.length).toBe(30);
    expect(params).toHaveLength(30);
    expect(params).toContain('answer_submitted');
  });

  it('空数组直接返回不执行 SQL', async () => {
    const pool = makePool();
    await new BehaviorEventsRepository(pool).insertMany([]);
    expect(pool.query).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd apps/server && npx vitest run src/database/repositories/behavior-events.repo.test.ts`
Expected: FAIL（模块不存在）

- [ ] **Step 3: 实现 repo**

```ts
// apps/server/src/database/repositories/behavior-events.repo.ts
import { Inject } from '@nestjs/common';
import type { Pool } from 'mysql2/promise';

export const BEHAVIOR_EVENT_COLUMNS = [
  'actor_role', 'student_id', 'event', 'tier', 'module', 'scene', 'subject_id',
  'ref_type', 'ref_id', 'session_uid', 'request_id', 'source', 'props', 'client_ts_ms',
] as const;
// 注：created_at 由 DB DEFAULT CURRENT_TIMESTAMP(3) 填，不在 INSERT 列里。

export type BehaviorEventRow = {
  [K in (typeof BEHAVIOR_EVENT_COLUMNS)[number]]: string | number | null;
};

export class BehaviorEventsRepository {
  constructor(@Inject('DATABASE_POOL') private readonly pool: Pool) {}

  async insertMany(rows: BehaviorEventRow[]): Promise<void> {
    if (rows.length === 0) return;
    const placeholders = rows.map(() => `(${BEHAVIOR_EVENT_COLUMNS.map(() => '?').join(',')})`).join(',');
    const params = rows.flatMap((row) => BEHAVIOR_EVENT_COLUMNS.map((col) => row[col] ?? null));
    await this.pool.query(
      `INSERT INTO behavior_events (${BEHAVIOR_EVENT_COLUMNS.join(',')}) VALUES ${placeholders}`,
      params,
    );
  }
}
```

- [ ] **Step 4: 跑 repo 测试确认通过**

Run: `cd apps/server && npx vitest run src/database/repositories/behavior-events.repo.test.ts`
Expected: PASS（2 例）

- [ ] **Step 5: 写 EventsService 失败测试**

```ts
// apps/server/src/modules/analytics/events.service.test.ts
import { afterEach, describe, expect, it, vi } from 'vitest';
import { EventsService, EVENT_TIER, CLIENT_ALLOWED_EVENTS } from './events.service.js';

function makeDeps() {
  const insertMany = vi.fn(async () => undefined);
  const svc = new EventsService({ insertMany } as any);
  return { svc, insertMany };
}

describe('EventsService', () => {
  afterEach(() => vi.restoreAllMocks());

  it('EVENT_TIER 字典 = 17 项，且 5 个 ops 难堪信号在册', () => {
    expect(Object.keys(EVENT_TIER)).toHaveLength(17);
    for (const e of ['hint_requested', 'answer_revealed', 'self_assess_answered', 'consecutive_failures', 'study_session_idle']) {
      expect(EVENT_TIER[e]).toBe('ops');
    }
    expect(EVENT_TIER['answer_submitted']).toBe('parent');
  });

  it('CLIENT_ALLOWED_EVENTS 恰为 7 项（session 2 + 显式 5）', () => {
    expect([...CLIENT_ALLOWED_EVENTS].sort()).toEqual([
      'ai_message_sent', 'answer_revealed', 'card_flipped', 'page_view',
      'study_session_ended', 'study_session_idle', 'study_session_started',
    ].sort());
  });

  it('track：tier 由字典决定，调用方传 tier 无效', () => {
    const { svc, insertMany } = makeDeps();
    svc.track({ event: 'answer_submitted', source: 'server', studentId: 7 } as any);
    expect(insertMany.mock.calls[0][0][0]).toMatchObject({ tier: 'parent' });
  });

  it('track：未登记事件拒写', () => {
    const { svc, insertMany } = makeDeps();
    svc.track({ event: 'not_in_dict', source: 'server' } as any);
    expect(insertMany).not.toHaveBeenCalled();
  });

  it('track：repo 抛错只 warn 不冒泡', () => {
    const { svc, insertMany } = makeDeps();
    insertMany.mockRejectedValueOnce(new Error('db down'));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(() => svc.track({ event: 'points_awarded', source: 'server', studentId: 1 })).not.toThrow();
    expect(warn).toHaveBeenCalled();
  });

  it('recordMany：校验失败计 rejected 不整体失败', () => {
    const { svc, insertMany } = makeDeps();
    const r = svc.recordMany([
      { event: 'page_view', source: 'client', studentId: 7 } as any,
      { event: 'answer_submitted', source: 'client', studentId: 7 } as any, // 服务端权威事件，client 白名单外
      { event: 'nope', source: 'client', studentId: 7 } as any,             // 字典外
    ]);
    expect(r).toEqual({ accepted: 1, rejected: 2 });
    expect(insertMany.mock.calls[0][0]).toHaveLength(1);
    expect(insertMany.mock.calls[0][0][0]).toMatchObject({ event: 'page_view', tier: 'ops' });
  });

  it('recordMany：DB 失败向上抛（controller 转 500）', async () => {
    const { svc, insertMany } = makeDeps();
    insertMany.mockRejectedValueOnce(new Error('db down'));
    expect(() => svc.recordMany([{ event: 'page_view', source: 'client', studentId: 7 } as any])).toThrow();
  });
});
```

- [ ] **Step 6: 跑测试确认失败**

Run: `cd apps/server && npx vitest run src/modules/analytics/events.service.test.ts`
Expected: FAIL

- [ ] **Step 7: 实现 EventsService**

```ts
// apps/server/src/modules/analytics/events.service.ts
import { Injectable } from '@nestjs/common';
import { BehaviorEventsRepository, type BehaviorEventRow } from '../../database/repositories/behavior-events.repo.js';

/** 母 spec §5.2 字典（study_session_heartbeat 不落事件流故不在册）。唯一真源，调用方不可覆盖 tier。 */
export const EVENT_TIER = {
  study_session_started: 'parent',
  study_session_ended: 'parent',
  study_session_idle: 'ops',
  page_view: 'ops',
  answer_submitted: 'parent',
  hint_requested: 'ops',
  answer_revealed: 'ops',
  self_assess_answered: 'ops',
  consecutive_failures: 'ops',
  card_flipped: 'ops',          // 本期无发射点（全仓无翻卡 UI），保留字典位
  ai_message_sent: 'parent',
  error_book_added: 'parent',
  error_book_cleared: 'parent',
  points_awarded: 'parent',
  exam_submitted: 'parent',
  special_unit_judged: 'parent',
  llm_fallback_triggered: 'ops',
} as const;

export type BehaviorEventName = keyof typeof EVENT_TIER;
export type EventTier = (typeof EVENT_TIER)[BehaviorEventName];

/** client 可上报白名单（delta spec §6）：服务端权威事件（answer_submitted 等）伪造直接拒。 */
export const CLIENT_ALLOWED_EVENTS: ReadonlySet<string> = new Set<string>([
  'study_session_started', 'study_session_ended', 'page_view',
  'card_flipped', 'answer_revealed', 'ai_message_sent', 'study_session_idle',
]);

export type TrackEventInput = {
  event: string;
  actorRole?: string;
  studentId?: number | null;
  module?: string | null;
  scene?: string | null;
  subjectId?: number | null;
  refType?: string | null;
  refId?: number | null;
  sessionUid?: string | null;
  requestId?: string | null;
  source: 'server' | 'client';
  props?: Record<string, unknown> | null;
  clientTsMs?: number | null;
};

const MODULE_WHITELIST = new Set([
  'mainline', 'aux_qna', 'training_targeted', 'training_error_practice', 'exam',
  'chinese_dictation', 'chinese_interpretation', 'chinese_meaning', 'en_vocabulary',
  'admin', 'parent',
]);
const SCENE_WHITELIST = new Set([
  'course_detail', 'star_map', 'aux_chat', 'targeted_run', 'error_run', 'exam_run',
  'dictation_run', 'interpretation_run', 'meaning_run', 'vocabulary_run',
  'profile', 'rewards', 'parent_dashboard', 'admin_dashboard',
]);
const ACTOR_ROLES = new Set(['student', 'parent', 'admin', 'system']);

function sanitize(input: TrackEventInput): BehaviorEventRow | null {
  const tier = (EVENT_TIER as Record<string, EventTier | undefined>)[input.event];
  if (!tier) return null; // 未登记 → 拒写
  const module = input.module && MODULE_WHITELIST.has(input.module) ? input.module : null;
  const scene = input.scene && SCENE_WHITELIST.has(input.scene) ? input.scene : null;
  let props: string | null = null;
  if (input.props && Object.keys(input.props).length > 0) {
    const json = JSON.stringify(input.props);
    if (json.length > 2048) return null; // props 超限 → 拒写该条
    props = json;
  }
  return {
    actor_role: input.actorRole && ACTOR_ROLES.has(input.actorRole) ? input.actorRole : 'student',
    student_id: input.studentId ?? null,
    event: input.event,
    tier,
    module, scene,
    subject_id: input.subjectId ?? null,
    ref_type: input.refType ?? null,
    ref_id: input.refId ?? null,
    session_uid: input.sessionUid ?? null,
    request_id: input.requestId ?? null,
    source: input.source,
    props,
    client_ts_ms: input.clientTsMs ?? null,
  };
}

@Injectable()
export class EventsService {
  constructor(private readonly repo: BehaviorEventsRepository) {}

  /** 服务端打点入口：fire-and-forget，一切异常只 warn（埋点永不影响主链路）。 */
  track(input: TrackEventInput): void {
    const row = sanitize(input);
    if (!row) return;
    void this.repo.insertMany([row]).catch((err) => {
      console.warn('[events] track failed:', (err as Error)?.message);
    });
  }

  /** 采集端点入口：逐条校验计 rejected；DB 失败向上抛（由 controller 变 500）。 */
  recordMany(inputs: TrackEventInput[]): { accepted: number; rejected: number } {
    const rows: BehaviorEventRow[] = [];
    let rejected = 0;
    for (const input of inputs) {
      const row = sanitize(input);
      if (row) rows.push(row); else rejected += 1;
    }
    if (rows.length > 0) {
      // 同步调用链里发起，但不 await——controller 负责整体 await 一次以便 500 语义。
      return { accepted: rows.length, rejected, _pending: this.repo.insertMany(rows) } as any;
    }
    return { accepted: 0, rejected };
  }
}
```

> ⚠️ 上面的 `_pending` hack 是错的——不要用。正确做法：`recordMany` 声明为 `async`，`await this.repo.insertMany(rows)` 后返回计数。测试 Step 5 里两条「不抛 / 抛」用例按 async/await 改写（`await expect(...).resolves.toEqual(...)` 与 `await expect(...).rejects.toThrow()`）。实现与测试都按 async 版本落。

- [ ] **Step 8: 跑 EventsService 测试确认通过**

Run: `cd apps/server && npx vitest run src/modules/analytics/events.service.test.ts`
Expected: PASS（7 例，含 async 改写后的 recordMany 两例）

- [ ] **Step 9: 隐私守卫测试（三道锁之三）**

```ts
// apps/server/src/database/repositories/parent-analytics.privacy-guard.test.ts
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/** delta spec §3 第 3 锁：家长端查询源码绝不出现 ops 难堪信号事件名。 */
describe('parent-analytics.repo 隐私守卫', () => {
  it('不含任何 ops-only 事件名字符串', () => {
    const src = readFileSync(new URL('./parent-analytics.repo.ts', import.meta.url), 'utf8');
    for (const banned of ['hint_requested', 'answer_revealed', 'self_assess_answered', 'consecutive_failures', 'study_session_idle']) {
      expect(src).not.toContain(banned);
    }
  });
});
```

Run: `cd apps/server && npx vitest run src/database/repositories/parent-analytics.privacy-guard.test.ts`
Expected: PASS（现在就该绿——锁是防未来的）

- [ ] **Step 10: 模块注册**——`analytics.module.ts` providers 加 `BehaviorEventsRepository, EventsService`（imports 处从 `../../database/repositories/behavior-events.repo.js` 引入）。

- [ ] **Step 11: tsc + 提交**

Run: `cd apps/server && npx tsc --noEmit`
Expected: 0 error

```bash
git add apps/server/src/database/repositories/behavior-events.repo.ts apps/server/src/database/repositories/behavior-events.repo.test.ts apps/server/src/database/repositories/parent-analytics.privacy-guard.test.ts apps/server/src/modules/analytics/events.service.ts apps/server/src/modules/analytics/events.service.test.ts apps/server/src/modules/analytics/analytics.module.ts
git commit -m "feat(analytics): EventsService 事件字典与隐私三道锁 + BehaviorEventsRepository"
```

---

### Task 3: 采集端点 POST /api/track/events

**Files:**
- Create: `apps/server/src/modules/analytics/track.controller.ts`
- Create: `apps/server/src/modules/analytics/track.controller.test.ts`
- Modify: `apps/server/src/modules/analytics/analytics.module.ts`（controllers 加 TrackController）
- Modify: `apps/server/src/modules/analytics/analytics.controller.ts`（确认 interceptor skip 名单含 `/api/track/events`，缺则补）

**Interfaces:**
- Consumes: `EventsService.recordMany`（Task 2）、`SubjectsRepository`（analytics.module 已有 provider，study-sessions 同款校验用）
- Produces: `POST /api/track/events` → 201 `{accepted:number, rejected:number}`（ResponseInterceptor 包 `{code:0,message:'ok',data}`）；越界 400/1001

- [ ] **Step 1: 写 controller 失败测试**

```ts
// apps/server/src/modules/analytics/track.controller.test.ts
import { afterEach, describe, expect, it, vi } from 'vitest';
import { BadRequestException } from '@nestjs/common';
import { TrackController } from './track.controller.js';

function makeDeps() {
  const recordMany = vi.fn(async () => ({ accepted: 1, rejected: 0 }));
  const subjects = { findOwnedById: vi.fn(async () => ({ id: 5 })) }; // 学生可选学科命中
  const ctl = new TrackController({ recordMany } as any, subjects as any);
  return { ctl, recordMany, subjects };
}
const user = { sub: 7, role: 'student' } as any;

describe('TrackController POST /api/track/events', () => {
  afterEach(() => vi.restoreAllMocks());

  it('合法单条 → accepted 1', async () => {
    const { ctl, recordMany } = makeDeps();
    const r = await ctl.submit(user, { events: [{ event: 'page_view', module: 'mainline', scene: 'course_detail' }] });
    expect(r).toEqual({ accepted: 1, rejected: 0 });
    expect(recordMany.mock.calls[0][0][0]).toMatchObject({ studentId: 7, actorRole: 'student', source: 'client' });
  });

  it('批量 > 50 → 400/1001', async () => {
    const { ctl } = makeDeps();
    const events = Array.from({ length: 51 }, () => ({ event: 'page_view' }));
    await expect(ctl.submit(user, { events })).rejects.toMatchObject({ response: { code: 1001 } });
  });

  it('events 缺失/非数组 → 400/1001（parseInput 模式，不是 500）', async () => {
    const { ctl } = makeDeps();
    await expect(ctl.submit(user, {})).rejects.toBeInstanceOf(BadRequestException);
  });

  it('subjectId 不属于该学生 → 400/1001', async () => {
    const { ctl, subjects } = makeDeps();
    subjects.findOwnedById.mockResolvedValueOnce(null as any);
    await expect(ctl.submit(user, { events: [{ event: 'page_view', subjectId: 999 }] }))
      .rejects.toMatchObject({ response: { code: 1001 } });
  });

  it('subjectId 校验只对带 subjectId 的条目发生', async () => {
    const { ctl, subjects } = makeDeps();
    await ctl.submit(user, { events: [{ event: 'page_view' }] });
    expect(subjects.findOwnedById).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd apps/server && npx vitest run src/modules/analytics/track.controller.test.ts`
Expected: FAIL

- [ ] **Step 3: 实现 controller**

```ts
// apps/server/src/modules/analytics/track.controller.ts
import { Body, BadRequestException, Controller, Post, UseGuards } from '@nestjs/common';
import { z } from 'zod';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard.js';
import { RolesGuard } from '../../common/guards/roles.guard.js';
import { Roles } from '../../common/decorators/roles.js';
import { CurrentUser } from '../../common/decorators/current-user.decorator.js';
import { EventsService, CLIENT_ALLOWED_EVENTS } from './events.service.js';
import type { SubjectsRepository } from '../../database/repositories/subjects.repo.js';

// auth.controller.ts:32 同款模式：裸 parse 会被全局过滤器兜成 500，必须转 400/1001
function parseInput<T>(schema: z.ZodType<T>, body: unknown): T {
  const r = schema.safeParse(body);
  if (!r.success) throw new BadRequestException({ code: 1001, message: '参数有误' });
  return r.data;
}

const TrackEventDto = z.object({
  event: z.string().min(1),
  module: z.string().min(1).optional(),
  scene: z.string().min(1).optional(),
  subjectId: z.number().int().positive().optional(),
  refType: z.string().min(1).optional(),
  refId: z.number().int().optional(),
  sessionUid: z.string().uuid().optional(),
  props: z.record(z.unknown()).optional(),
  clientTsMs: z.number().int().optional(),
});
const TrackBatchDto = z.object({ events: z.array(TrackEventDto).min(1).max(50) });

@Controller('api/track')
@UseGuards(JwtAuthGuard, RolesGuard)
export class TrackController {
  constructor(
    private readonly events: EventsService,
    private readonly subjectsRepo: SubjectsRepository,
  ) {}

  @Post('events')
  @Roles('student')
  async submit(
    @CurrentUser() user: { sub: number; role: string },
    @Body() body: unknown,
  ): Promise<{ accepted: number; rejected: number }> {
    const dto = parseInput(TrackBatchDto, body);
    // subjectId 归属校验（与 study-sessions 同口径）：只对带 subjectId 的条目做
    const subjectIds = [...new Set(dto.events.map((e) => e.subjectId).filter((v): v is number => v != null))];
    for (const subjectId of subjectIds) {
      const ok = await this.subjectsRepo.findOwnedById(user.sub, subjectId).catch(() => null);
      if (!ok) throw new BadRequestException({ code: 1001, message: 'subjectId 不属于该学生' });
    }
    const acceptedInputs = dto.events.map((e) => {
      const { subjectId, ...rest } = e;
      return {
        ...rest,
        subjectId: subjectId ?? null,
        actorRole: 'student' as const,
        studentId: user.sub,
        source: 'client' as const,
      };
    });
    // client 白名单在 recordMany 之外先拒（伪造服务端权威事件 → rejected 计数，不 400）
    const allowed = acceptedInputs.filter((e) => CLIENT_ALLOWED_EVENTS.has(e.event));
    return this.events.recordMany(allowed as any, acceptedInputs.length - allowed.length);
  }
}
```

> ⚠️ `recordMany` 签名在 Task 2 是 `(inputs)`；这里需要 rejected 计入伪造条目。统一改为：Task 2 的 `recordMany(inputs: TrackEventInput[])` **保持不变**，白名单过滤放 `sanitize()` 里——给 `TrackEventInput` 加 `enforceClientWhitelist?: boolean`，采集路径 `recordMany` 内部对 `source==='client'` 的输入一律校验白名单、字典外或白名单外都计 rejected。Step 7 实现与 Step 5 测试相应调整（`recordMany` 里 rejected 的第三个来源）。上面 controller 的 `allowed` 过滤删掉，直接 `return this.events.recordMany(acceptedInputs)`。**以此为准**：白名单判定在 EventsService，controller 不判。

- [ ] **Step 4: 对齐 Task 2 的 recordMany**——`events.service.ts` 的 `sanitize` 加第二参 `source: 'server' | 'client'` 已经在 input 里；`recordMany` 中：`if (input.source === 'client' && !CLIENT_ALLOWED_EVENTS.has(input.event)) { rejected += 1; continue; }`。Task 2 测试里「服务端权威事件 client 伪造」用例正是打这条路径，无需改用例。

- [ ] **Step 5: SubjectsRepository 归属方法核对**——study-sessions 校验 subjectId 用的是 `SubjectsRepository` 哪个方法（`findOwnedById` 为占位名），打开 `apps/server/src/database/repositories/subjects.repo.ts` 找实际方法名并在 controller/test 里替换；若无现成方法，用 `SELECT id FROM subjects WHERE id=? AND ...`（照 study-sessions.service.ts 里的既有校验抄）。

- [ ] **Step 6: interceptor skip 名单**——打开 `apps/server/src/common/interceptors/analytics.interceptor.ts`，确认 skip 数组含 `'/api/track/events'`（母 spec §6.2 要求）；缺则补（挂在 `api_request_logs` 自指放大会污染失败率）。

- [ ] **Step 7: 模块注册 + 测试通过 + tsc**

Run: `cd apps/server && npx vitest run src/modules/analytics/track.controller.test.ts && npx tsc --noEmit`
Expected: PASS + 0 error

- [ ] **Step 8: Commit**

```bash
git add apps/server/src/modules/analytics/track.controller.ts apps/server/src/modules/analytics/track.controller.test.ts apps/server/src/modules/analytics/events.service.ts apps/server/src/modules/analytics/analytics.module.ts apps/server/src/common/interceptors/analytics.interceptor.ts
git commit -m "feat(analytics): POST /api/track/events 批量采集端点（client 白名单+subjectId 归属+50 上限）"
```

---

### Task 4: judge-core 挂载（answer_submitted / consecutive_failures / error_book_added / error_book_cleared / self_assess_answered）

**Files:**
- Modify: `apps/server/src/modules/practice/judge-core.service.ts`
- Modify: `apps/server/src/modules/practice/judge-core.service.test.ts`
- Modify: `apps/server/src/modules/analytics/analytics.module.ts`（exports 加 `EventsService`）
- Modify: judge-core 所在 module（搜 `JudgeCoreService` 的 `@Module` providers 声明处，多为 `practice/practice.module.ts`）——imports 加 `AnalyticsModule`

**Interfaces:**
- Consumes: `EventsService.track`（Task 2）
- Produces: 判题路径每次落 1 条 `answer_submitted`（tier=parent）；错题本新建分支落 `error_book_added`；清零路径落 `error_book_cleared`；self_assess 早退分支落 `self_assess_answered`（tier=ops）；连错 3 触发 `consecutive_failures`（tier=ops）
- module 映射（由 `input.source` 推导，调用方无需改）：

```
'targeted' → 'training_targeted'
'error_practice' | 'remediation' → 'training_error_practice'
'exam' → 'exam'
judgeForPractice（practice.service.ts:101 调用）→ 'mainline'
```

- [ ] **Step 1: 写失败测试**（追加到 `judge-core.service.test.ts`；`makeService`/构造处补第 9 参 `events` mock）

```ts
// makeService 内：const events = overrides.events ?? { track: vi.fn() };
// new JudgeCoreService(..., events);  返回对象带 events

it('判题成功后发 answer_submitted，module 由 source 推导', async () => {
  const { svc, events } = makeService();
  await svc.judgeQuestion({ studentId: 1, subjectId: 1, questionId: 10, studentAnswer: 'B', source: 'targeted' });
  expect(events.track).toHaveBeenCalledWith(expect.objectContaining({
    event: 'answer_submitted', source: 'server', studentId: 1, module: 'training_targeted',
  }));
});

it('连错 3 次触发 consecutive_failures 并清零计数（再错 3 次可再触发）', async () => {
  const { svc, events } = makeService();
  const input = { studentId: 1, subjectId: 1, questionId: 10, studentAnswer: 'x', source: 'error_practice' } as any;
  await svc.judgeQuestion(input); await svc.judgeQuestion(input);
  expect(events.track).not.toHaveBeenCalledWith(expect.objectContaining({ event: 'consecutive_failures' }));
  await svc.judgeQuestion(input); // 第 3 次错
  expect(events.track).toHaveBeenCalledWith(expect.objectContaining({
    event: 'consecutive_failures', module: 'training_error_practice', props: { count: 3 },
  }));
  events.track.mockClear();
  await svc.judgeQuestion(input); // 第 4 次错：计数已清零，不触发
  expect(events.track).not.toHaveBeenCalledWith(expect.objectContaining({ event: 'consecutive_failures' }));
  await svc.judgeQuestion(input); await svc.judgeQuestion(input); // 第 5、6 次
  expect(events.track).toHaveBeenCalledWith(expect.objectContaining({ event: 'consecutive_failures', props: { count: 3 } }));
});

it('judgeForPractice 的 module 是 mainline', async () => {
  const { svc, events } = makeService();
  await svc.judgeForPractice({ studentId: 7, subjectId: 1, questionId: 10, studentAnswer: 'A' } as any, correctQ as any);
  expect(events.track).toHaveBeenCalledWith(expect.objectContaining({ event: 'answer_submitted', module: 'mainline' }));
});

it('错题本新建分支发 error_book_added', async () => {
  const { svc, events, mainError } = makeService();
  mainError.findUnclearedByStudentQuestion.mockResolvedValueOnce(null);
  await svc.judgeQuestion({ studentId: 1, subjectId: 1, questionId: 10, studentAnswer: 'x', source: 'targeted' });
  expect(events.track).toHaveBeenCalledWith(expect.objectContaining({
    event: 'error_book_added', refType: 'question', refId: 10, subjectId: 1,
  }));
});

it('self_assess 早退分支发 self_assess_answered（不重复发 answer_submitted）', async () => {
  const { svc, events } = makeService();
  await svc.judgeQuestion({ studentId: 1, subjectId: 1, questionId: 10, studentAnswer: '我不确定', source: 'targeted' });
  expect(events.track).toHaveBeenCalledWith(expect.objectContaining({ event: 'self_assess_answered' }));
  expect(events.track).not.toHaveBeenCalledWith(expect.objectContaining({ event: 'answer_submitted' }));
});

it('awardErrorFixOnClear 发 error_book_cleared', async () => {
  const { svc, events } = makeService();
  await svc.awardErrorFixOnClear(1, 10, 2);
  expect(events.track).toHaveBeenCalledWith(expect.objectContaining({
    event: 'error_book_cleared', refId: 10, props: { clearedCount: 2 },
  }));
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd apps/server && npx vitest run src/modules/practice/judge-core.service.test.ts`
Expected: FAIL（构造参数不足 / track 未被调用）

- [ ] **Step 3: 实现**（`judge-core.service.ts`）

```ts
// ① 构造函数追加第 9 参：
constructor(
  ...既有 8 参...,
  private readonly events?: EventsService,   // 可选注入：旧测试少传也不炸；生产由 DI 提供
) {}

// ② source→module 映射 + 打点助手（类内私有）：
private static readonly SOURCE_MODULE: Record<string, string> = {
  targeted: 'training_targeted',
  error_practice: 'training_error_practice',
  remediation: 'training_error_practice',
  exam: 'exam',
};

private trackAnswer(
  studentId: number,
  source: string | undefined,
  isMainline: boolean,
  out: JudgeOutput,
  questionId: number | null,
): void {
  this.events?.track({
    event: 'answer_submitted', source: 'server', studentId,
    module: isMainline ? 'mainline' : (JudgeCoreService.SOURCE_MODULE[source ?? ''] ?? null),
    refType: 'question', refId: questionId,
    props: { verdict: out.verdict, isCorrect: out.isCorrect ?? null, method: out.method ?? null },
  });
}

// 连错计数：进程内存 Map（重启清零可接受，埋点尽力而为）
private failStreak = new Map<string, number>();
private trackStreak(studentId: number, key: string, module: string | null, questionId: number | null): void {
  if (!this.events) return;
  const next = (this.failStreak.get(key) ?? 0) + 1;
  if (next >= 3) {
    this.failStreak.set(key, 0);
    this.events.track({ event: 'consecutive_failures', source: 'server', studentId, module, refType: 'question', refId: questionId, props: { count: next } });
  } else {
    this.failStreak.set(key, next);
  }
}
// streak key：`'c' + cardId ?? 'q' + questionId`（input 上有 cardId 就用 cardId）

// ③ judgeQuestion(:165) 与 judgeForPractice(:299) 在 finishJudge(...) 返回前各插一行：
//    this.trackAnswer(studentId, input.source, false, out, input.questionId);   // judgeQuestion
//    this.trackAnswer(input.studentId, undefined, true, out, input.questionId); // judgeForPractice
//    错误路径（抛错前）与「题目不存在」早退（999 分支）**不打点**——只有真判题才算 submitted。
// ④ self_assess 早退分支（:194-203 与 :326-333）：返回前插
//    this.events?.track({ event: 'self_assess_answered', source: 'server', studentId: input.studentId,
//      module: <同上映射>, refType: 'question', refId: input.questionId,
//      props: { assessment: (out as any).assessment ?? null } });
//    且该分支**不再**调 trackAnswer（else 正常路径才发 answer_submitted）。
// ⑤ 错题本新建分支（:427 mainErrorRepo.create 之后）：
//    this.events?.track({ event: 'error_book_added', source: 'server', studentId,
//      subjectId: input.subjectId, refType: 'question', refId: input.questionId });
//    （:545-547 的 selfAssess 路径 create 同样补一行）
// ⑥ awardErrorFixOnClear(:486) 成功返回前：
//    this.events?.track({ event: 'error_book_cleared', source: 'server', studentId,
//      refType: 'question', refId: questionId, props: { clearedCount: cleared } });
// ⑦ streak 挂接点：trackAnswer 内部，当 out.verdict === 'incorrect' 时调 trackStreak，
//    verdict === 'correct' 时清零该 key（答对重置连错）。
```

- [ ] **Step 4: AnalyticsModule exports + module imports**

```ts
// analytics.module.ts @Module({ ..., exports: [EventsService] })
// judge-core 所在 module（providers 含 JudgeCoreService 的那个）imports 加 AnalyticsModule
```

- [ ] **Step 5: 跑 judge-core 测试全量**

Run: `cd apps/server && npx vitest run src/modules/practice/judge-core.service.test.ts`
Expected: PASS（既有用例不红——events 未传时全部 no-op）

- [ ] **Step 6: Commit**

```bash
git add apps/server/src/modules/practice/judge-core.service.ts apps/server/src/modules/practice/judge-core.service.test.ts apps/server/src/modules/analytics/analytics.module.ts
git commit -m "feat(analytics): judge-core 挂载 answer_submitted/连错/错题本/self_assess 事件"
```

---

### Task 5: points / exam / hint 挂载

**Files:**
- Modify: `apps/server/src/modules/points/points.service.ts`（构造函数加 `events?: EventsService`；`award(:96)` 内**成功路径**（`pointsAwarded > 0`）加 track）
- Modify: `apps/server/src/modules/exams/exams.service.ts`（构造函数加 `events?: EventsService`；`submit(:231)` 成功返回前 track）
- Modify: `apps/server/src/modules/practice/practice.controller.ts:66-69`、`apps/server/src/modules/training/training.controller.ts:115-118`（两个 hint 端点所在 controller 构造函数加 `events?: EventsService`，handler 内 track）
- Modify: `apps/server/src/modules/points/points.service.test.ts`、`apps/server/src/modules/exams/exams.service.test.ts`（构造 mock 补 events）

**Interfaces:**
- Consumes: `EventsService.track`（Task 2）；PointsModule / ExamsModule / PracticeModule / TrainingModule 的 imports 需含 `AnalyticsModule`（缺则补）

- [ ] **Step 1: 失败测试**

```ts
// points.service.test.ts 追加
it('award 成功发 points_awarded；reason 命中不发', async () => {
  const events = { track: vi.fn() };
  const svc = makePointsService({ events });   // 构造 mock 处补第 N 参 events
  await svc.award({ studentId: 7, taskCode: 'lesson_complete', dedupeKey: 'd1', refType: 'lesson', refId: 5 });
  expect(events.track).toHaveBeenCalledWith(expect.objectContaining({
    event: 'points_awarded', source: 'server', studentId: 7,
    refType: 'lesson', refId: 5, props: { taskCode: 'lesson_complete', points: expect.any(Number) },
  }));
  // 走 daily_limit/duplicate 分支的既有用例不变（track 未被调）——用 mockClear 后重断言
});

// exams.service.test.ts 追加
it('submit 成功发 exam_submitted', async () => {
  const events = { track: vi.fn() };
  const svc = makeExamsService({ events });
  await svc.submit(7, 42);
  expect(events.track).toHaveBeenCalledWith(expect.objectContaining({
    event: 'exam_submitted', source: 'server', studentId: 7, module: 'exam',
    refType: 'exam_session', refId: 42,
  }));
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd apps/server && npx vitest run src/modules/points/points.service.test.ts src/modules/exams/exams.service.test.ts`
Expected: FAIL

- [ ] **Step 3: 实现**

```ts
// points.service.ts award(:96) 内，算出 result 且 result.pointsAwarded > 0 时：
this.events?.track({
  event: 'points_awarded', source: 'server', studentId: input.studentId,
  refType: input.refType ?? null, refId: input.refId ?? null,
  props: { taskCode: input.taskCode, points: result.pointsAwarded },
});

// exams.service.ts submit(:231) 返回 ExamSummaryDto 前：
this.events?.track({
  event: 'exam_submitted', source: 'server', studentId,
  module: 'exam', refType: 'exam_session', refId: sessionId,
});

// practice.controller.ts hint(:66-69)：handler 内（取到 user 与 dto 后）
this.events?.track({
  event: 'hint_requested', source: 'server', studentId: user.sub,
  module: 'mainline', scene: 'course_detail',
  refType: 'question', refId: dto.questionId ?? null,
});

// training.controller.ts hint(:115-118)：同款，module 取 dto.source === 'error_practice'
//   ? 'training_error_practice' : 'training_targeted'（dto 无 source 字段则查 HintPracticeDto 实际字段名，
//   有什么用什么；实在没有就传 module: null——scene 由白名单兜成 NULL，不报错）
```

- [ ] **Step 4: 跑两个测试文件 + tsc**

Run: `cd apps/server && npx vitest run src/modules/points/points.service.test.ts src/modules/exams/exams.service.test.ts && npx tsc --noEmit`
Expected: PASS + 0 error

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/modules/points/points.service.ts apps/server/src/modules/points/points.service.test.ts apps/server/src/modules/exams/exams.service.ts apps/server/src/modules/exams/exams.service.test.ts apps/server/src/modules/practice/practice.controller.ts apps/server/src/modules/training/training.controller.ts
git commit -m "feat(analytics): 挂载 points_awarded / exam_submitted / hint_requested"
```

---

### Task 6: special_unit_judged（四个专项写入点）

**Files:**
- Modify: `apps/server/src/modules/training/training.service.ts:257`（默写）、`:507`（解释）
- Modify: `apps/server/src/modules/training/meaning.service.ts:290`（含义）
- Modify: `apps/server/src/modules/training/vocabulary.service.ts:464`（背单词）
- Modify: 各自测试文件（training.service.test.ts / meaning.service.test.ts / vocabulary.service.test.ts）

**Interfaces:**
- Consumes: `EventsService.track`；TrainingModule imports AnalyticsModule（应已具备——判题链路同模块）
- Produces: 每次专项判题落库 `special_practice_logs` 的同时发 1 条 `special_unit_judged`（tier=parent）

- [ ] **Step 1: 失败测试**（以 meaning 为例，其余三处同构、module 换名）

```ts
// meaning.service.test.ts 追加
it('判题写 special_practice_logs 的同时发 special_unit_judged', async () => {
  const events = { track: vi.fn() };
  const svc = makeMeaningService({ events });   // 构造 mock 补 events
  await svc.judge(/* 既有成功路径参数 */);
  expect(events.track).toHaveBeenCalledWith(expect.objectContaining({
    event: 'special_unit_judged', source: 'server', studentId: expect.any(Number),
    module: 'chinese_meaning', refType: 'passage',
    props: { verdict: expect.any(String) },
  }));
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd apps/server && npx vitest run src/modules/training/meaning.service.test.ts`
Expected: FAIL

- [ ] **Step 3: 实现**——四处 `await this.specialLogsRepo.insert({...})` 的**同一作用域**内、insert 成功后加：

```ts
// training.service.ts:257 一带（默写）
this.events?.track({
  event: 'special_unit_judged', source: 'server', studentId,
  module: 'chinese_dictation', refType: 'passage', refId,
  props: { verdict },
});
// training.service.ts:507 一带（解释）→ module: 'chinese_interpretation'
// meaning.service.ts:290 一带（含义）→ module: 'chinese_meaning'
// vocabulary.service.ts:464 一带（背单词）→ module: 'en_vocabulary', refType: 'word', refId: wordId
```

四处构造函数各加 `events?: EventsService`。日志失败不回滚业务的既有 try/catch 语义不变（track 本身也吞异常，双保险）。

- [ ] **Step 4: 四个测试文件全绿 + tsc**

Run: `cd apps/server && npx vitest run src/modules/training/ && npx tsc --noEmit`
Expected: PASS + 0 error

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/modules/training/training.service.ts apps/server/src/modules/training/meaning.service.ts apps/server/src/modules/training/vocabulary.service.ts apps/server/src/modules/training/*.test.ts
git commit -m "feat(analytics): 四个专项判题点挂载 special_unit_judged"
```

---

### Task 7: llm_fallback_triggered（sink 回调）+ study_session_ended 兜底

**Files:**
- Modify: `apps/server/src/modules/analytics/analytics.module.ts`（构造函数 `setLlmCallSink` 回调）
- Modify: `apps/server/src/database/repositories/study-sessions.repo.ts:305`（`closeStale` 改返回收尾行）
- Modify: `apps/server/src/modules/analytics/study-sessions.service.ts:316`（closeStale 发兜底事件）
- Modify: `apps/server/src/database/repositories/study-sessions.repo.test.ts`、`apps/server/src/modules/analytics/study-sessions.service.test.ts`

**Interfaces:**
- Consumes: `LlmCallLogEntry`（`ai-core/infra/llm-call-log.ts:11-31`，字段含 `modelKey`/`scene`/`isFallback`）；`EventsService.track`
- Produces: fallback 记账行额外触发 `llm_fallback_triggered`（props `{scene, toModel}`）；5 分钟惰性收尾每行触发 1 条 `study_session_ended`（`props.endReason='closed'`，activeSeconds 取服务端累计值）

- [ ] **Step 1: 失败测试**

```ts
// study-sessions.service.test.ts 追加
it('closeStale 对每行收尾会话发 study_session_ended 兜底事件', async () => {
  const events = { track: vi.fn() };
  const svc = makeStudySessionsService({ events, closeStaleRows: [
    { student_id: 7, session_uid: 'u1', active_seconds: 300 },
  ] });
  await svc.closeStale();
  expect(events.track).toHaveBeenCalledWith(expect.objectContaining({
    event: 'study_session_ended', source: 'server', studentId: 7,
    sessionUid: 'u1', props: { endReason: 'closed', activeSeconds: 300 },
  }));
});
```

（analytics.module 的 sink 回调改动用**集成冒烟验证**，不单测——见 Task 13。）

- [ ] **Step 2: 跑测试确认失败**

Run: `cd apps/server && npx vitest run src/modules/analytics/study-sessions.service.test.ts`
Expected: FAIL

- [ ] **Step 3: 实现**

```ts
// ① study-sessions.repo.ts closeStale(:305)：由「一条 UPDATE 返回受影响行数」改为：
//    a) SELECT student_id, session_uid, active_seconds FROM study_sessions
//       WHERE status='active' AND last_heartbeat_at < NOW(3) - INTERVAL 5 MINUTE
//       （分页安全：不加 LIMIT，量级 = 掉线会话数，个位数量级）
//    b) 逐条/批量 UPDATE status='ended', end_reason='closed', ended_at=NOW(3) WHERE id IN (...)
//       （沿用 :317/:330 现有 WHERE 条件的 id 集合版；乐观锁条件 status='active' 保留）
//    c) 返回 a) 查到的行数组（类型新增 { student_id: number; session_uid: string; active_seconds: number }[]）
// ② study-sessions.service.ts closeStale(:316)：拿到行数组后
for (const row of rows) {
  this.events?.track({
    event: 'study_session_ended', source: 'server', studentId: row.student_id,
    sessionUid: row.session_uid,
    props: { endReason: 'closed', activeSeconds: row.active_seconds },
  });
}
// ③ analytics.module.ts 构造函数里 setLlmCallSink 回调追加：
setLlmCallSink((entry) => {
  this.telemetry.llmCalls.push(entry);
  if (entry.isFallback) {
    this.eventsService.track({
      event: 'llm_fallback_triggered', source: 'server',
      studentId: entry.studentId ?? null,
      props: { scene: entry.scene ?? null, toModel: entry.modelKey },
    });
  }
});
// （AnalyticsModule 构造函数需注入 EventsService——本模块自己 providers 里有，直接构造参数追加；
//   注意构造顺序：EventsService 必须在回调首次触发前可用，回调只在真实 LLM 调用时触发，无启动顺序问题）
```

- [ ] **Step 4: 测试全绿 + tsc**

Run: `cd apps/server && npx vitest run src/modules/analytics/study-sessions.service.test.ts src/database/repositories/study-sessions.repo.test.ts && npx tsc --noEmit`
Expected: PASS + 0 error（repo 签名变化处，调用方 grep `closeStale` 逐一核对返回值用法）

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/modules/analytics/analytics.module.ts apps/server/src/database/repositories/study-sessions.repo.ts apps/server/src/database/repositories/study-sessions.repo.test.ts apps/server/src/modules/analytics/study-sessions.service.ts apps/server/src/modules/analytics/study-sessions.service.test.ts
git commit -m "feat(analytics): llm_fallback_triggered（sink 回调）+ closeStale 会话结束兜底事件"
```

---

### Task 8: ops 聚合骨架 + /overview + /modules

**Files:**
- Create: `apps/server/src/modules/analytics/ops-analytics.repo.ts` / `.repo.test.ts`
- Create: `apps/server/src/modules/analytics/ops-analytics.service.ts` / `.service.test.ts`
- Create: `apps/server/src/modules/analytics/admin-analytics.controller.ts`
- Modify: `apps/server/src/modules/analytics/analytics.module.ts`（providers + controllers 注册）

**Interfaces:**
- Consumes: `'DATABASE_POOL'` 注入的 `Pool`（repo 基模式同 `special-practice-logs.repo.ts:49`）
- Produces:
  - `parseWindow(from?: string, to?: string): { fromAt: string; toAt: string }`——`'YYYY-MM-DD HH:mm:ss'`，to = to+1 天 00:00（左闭右开）；非法格式 400/1001；缺省近 7 天
  - `OpsAnalyticsService.overview(window)` / `modules(window)`（后续任务逐个加方法）
  - `GET /api/admin/analytics/overview` / `/modules`

**响应形状（逐字段，openapi 就按这个抄）：**

```
GET /overview  →  { dau:number, wau:number, totalSeconds:number, totalAnswers:number,
                    accuracy:number|null, moduleTop:[{module:string, students:number, seconds:number}] }
GET /modules   →  { items:[{ module, students, seconds, answered, correct, accuracy:number|null }] }
```

- [ ] **Step 1: repo 失败测试**

```ts
// ops-analytics.repo.test.ts
import { describe, expect, it, vi } from 'vitest';
import { OpsAnalyticsRepository } from './ops-analytics.repo.js';

function poolWith(rows: any[]) {
  return { query: vi.fn(async () => [rows]) } as any;
}

describe('OpsAnalyticsRepository', () => {
  it('overview：DAU/WAU 按学生去重、时长求和', async () => {
    const pool = poolWith([{ dau: 3, total_seconds: 7200 }]);
    const repo = new OpsAnalyticsRepository(pool);
    const r = await repo.overview({ fromAt: '2026-10-03 00:00:00', toAt: '2026-10-10 00:00:00' });
    const sql: string = pool.query.mock.calls[0][0];
    expect(sql).toContain('COUNT(DISTINCT student_id)');
    expect(r.totalSeconds).toBe(7200);
  });

  it('分页/聚合 SQL 一律 pool.query，不带 execute', async () => {
    const pool = poolWith([]);
    const repo = new OpsAnalyticsRepository(pool);
    await repo.modulesWindow({ fromAt: '2026-10-03 00:00:00', toAt: '2026-10-10 00:00:00' });
    expect(pool.query).toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd apps/server && npx vitest run src/modules/analytics/ops-analytics.repo.test.ts`
Expected: FAIL

- [ ] **Step 3: 实现 repo（overview + modulesWindow）**

```ts
// ops-analytics.repo.ts
import { Inject } from '@nestjs/common';
import type { Pool, RowDataPacket } from 'mysql2/promise';

export type Window = { fromAt: string; toAt: string };

export class OpsAnalyticsRepository {
  constructor(@Inject('DATABASE_POOL') private readonly pool: Pool) {}

  async overview(w: Window): Promise<RowDataPacket[]> {
    // DAU/时长来自 study_sessions；答题来自 special_practice_logs + 判题不落表的 practice 主线
    // ——主线答题数与正确数从 behavior_events 不够（Phase 2 才开始记）。
    // 口径（delta spec §7 表 1）：总答题/正确率取 special_practice_logs ∪ api_request_logs 不合适，
    // 本期以 behavior_events.answer_submitted 为主（上线后数据自增）+ special_practice_logs 补专项：
    // 实现为两查询，service 合并。
    const [sessions] = await this.pool.query<RowDataPacket[]>(
      `SELECT COUNT(DISTINCT CASE WHEN DATE(started_at) = CURDATE() THEN student_id END) AS dau_today,
              COUNT(DISTINCT student_id) AS students,
              COALESCE(SUM(active_seconds), 0) AS total_seconds
         FROM study_sessions
        WHERE status IN ('ended','abandoned') AND started_at >= ? AND started_at < ?`,
      [w.fromAt, w.toAt],
    );
    return sessions;
  }
  // （实现时按此模式补 modulesWindow：GROUP BY module，人数/时长/答题/正确，见 Step 5）
}
```

> ⚠️ `CURDATE()` 在上面 SELECT CASE 里出现——**这违反全局约束**（DB 时区）。实现时把「今日」也算进窗口参数：service 层把 `today 00:00` 作为额外参数 `todayAt` 传入，SQL 写 `started_at >= ?`。**最终 SQL 不允许出现 CURDATE/NOW。**

- [ ] **Step 4: 跑 repo 测试通过**

Run: `cd apps/server && npx vitest run src/modules/analytics/ops-analytics.repo.test.ts`
Expected: PASS

- [ ] **Step 5: service + controller**

```ts
// ops-analytics.service.ts（节选；parseWindow 是全 service 共享）
import { BadRequestException, Injectable } from '@nestjs/common';
import { OpsAnalyticsRepository, type Window } from './ops-analytics.repo.js';

export function parseWindow(from?: string, to?: string): Window {
  const dateRe = /^\d{4}-\d{2}-\d{2}$/;
  const fmt = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  const now = new Date();
  let to = now; let fromD = new Date(now.getTime() - 6 * 86400_000);
  if (to) { if (!dateRe.test(to)) throw new BadRequestException({ code: 1001, message: 'to 格式应为 YYYY-MM-DD' }); to = new Date(`${to}T00:00:00`); }
  if (from) { if (!dateRe.test(from)) throw new BadRequestException({ code: 1001, message: 'from 格式应为 YYYY-MM-DD' }); fromD = new Date(`${from}T00:00:00`); }
  if (fromD > to) throw new BadRequestException({ code: 1001, message: 'from 不能晚于 to' });
  const toAt = `${fmt(new Date(to.getTime() + 86400_000))} 00:00:00`;
  return { fromAt: `${fmt(fromD)} 00:00:00`, toAt };
}

const acc = (correct: number, answered: number) => (answered === 0 ? null : correct / answered);

@Injectable()
export class OpsAnalyticsService {
  constructor(private readonly repo: OpsAnalyticsRepository) {}

  async overview(q: { from?: string; to?: string }) {
    const w = parseWindow(q.from, q.to);
    const [sess, answers] = await Promise.all([
      this.repo.overview(w),
      this.repo.answerTotals(w),          // behavior_events: event='answer_submitted' 总数/正确数
      this.repo.moduleTop(w),             // study_sessions GROUP BY module：人数+时长 Top 5
    ]);
    return {
      dau: sess.dau_today, wau: sess.students,
      totalSeconds: sess.total_seconds,
      totalAnswers: answers.answered, accuracy: acc(answers.correct, answers.answered),
      moduleTop: this.repo.moduleTop(w),  // 按实现整理
    };
  }
  async modules(q: { from?: string; to?: string }) { /* repo.modulesWindow 合并 events 与 special logs 的答题列后 acc() */ }
}
```

> 实现纪律：service 里的 Promise.all 参数与返回结构以「repo 返回行 + service 只做形状组装」为准；上面伪码里的 `answerTotals`/`moduleTop` 必须真的落进 repo（SQL：`SELECT COUNT(*) AS answered, COALESCE(SUM(is_correct=1),0) AS correct FROM behavior_events WHERE event='answer_submitted' AND created_at >= ? AND created_at < ?`）。

```ts
// admin-analytics.controller.ts
import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard.js';
import { RolesGuard } from '../../common/guards/roles.guard.js';
import { Roles } from '../../common/decorators/roles.js';
import { OpsAnalyticsService } from './ops-analytics.service.js';

@Controller('api/admin/analytics')
@UseGuards(JwtAuthGuard, RolesGuard)
export class AdminAnalyticsController {
  constructor(private readonly ops: OpsAnalyticsService) {}

  @Get('overview')
  @Roles('admin')
  overview(@Query() q: { from?: string; to?: string }) { return this.ops.overview(q); }

  @Get('modules')
  @Roles('admin')
  modules(@Query() q: { from?: string; to?: string }) { return this.ops.modules(q); }
  // Task 9-11 在此追加其余 9 个端点
}
```

- [ ] **Step 6: service 测试**（窗口默认值、非法 from 400/1001、answered=0 → accuracy null）

```ts
// ops-analytics.service.test.ts 关键用例
expect(parseWindow().fromAt).toMatch(/\d{4}-\d{2}-\d{2} 00:00:00/);        // 近 7 天
await expect(svc.overview({ from: '2026/01/01' })).rejects.toMatchObject({ response: { code: 1001 } });
const r = await svcWith({ answered: 0, correct: 0 }).overview({});          // mock repo
expect(r.accuracy).toBeNull();
```

- [ ] **Step 7: 全绿 + tsc + Commit**

Run: `cd apps/server && npx vitest run src/modules/analytics/ops-analytics && npx tsc --noEmit`

```bash
git add apps/server/src/modules/analytics/ops-analytics.* apps/server/src/modules/analytics/admin-analytics.controller.ts apps/server/src/modules/analytics/analytics.module.ts
git commit -m "feat(analytics): ops 聚合骨架 + /overview + /modules"
```

---

### Task 9: /funnel + /events

**Files:**
- Modify: `ops-analytics.repo.ts` / `ops-analytics.service.ts` / `admin-analytics.controller.ts`（各加方法/端点）
- Modify: `ops-analytics.repo.test.ts` / `ops-analytics.service.test.ts`

**Interfaces:**
- Produces:
  - `GET /funnel?module=mainline&from&to` → `{ module, steps:[{event, students}], conversions:[number|null] }`；module 白名单 = delta spec §7.1 的 8 个，越界 400/1001
  - `GET /events?event=&module=&page=` → `{ items:[...behavior_events 行], page, pageSize:20, total }`；**全部 tier**（delta spec 裁决 3）

**漏斗步骤表（service 内常量，从 delta spec §7.1 抄死）：**

```ts
const FUNNEL_STEPS: Record<string, string[]> = {
  mainline: ['study_session_started', 'answer_submitted', 'points_awarded'],
  exam: ['study_session_started', 'answer_submitted', 'exam_submitted'],
  training_targeted: ['study_session_started', 'answer_submitted'],
  training_error_practice: ['study_session_started', 'answer_submitted'],
  chinese_dictation: ['study_session_started', 'special_unit_judged'],
  chinese_interpretation: ['study_session_started', 'special_unit_judged'],
  chinese_meaning: ['study_session_started', 'special_unit_judged'],
  en_vocabulary: ['study_session_started', 'special_unit_judged'],
};
```

- [ ] **Step 1: 失败测试**

```ts
// service：白名单越界 1001
await expect(svc.funnel({ module: 'aux_qna' })).rejects.toMatchObject({ response: { code: 1001 } });
// service：每步人数与转化
const r = await svcWithSteps([100, 60, 30]).funnel({ module: 'mainline' });
expect(r.steps.map((s) => s.students)).toEqual([100, 60, 30]);
expect(r.conversions).toEqual([null, 0.6, 0.5]);
// repo：漏斗 SQL 按事件×module 分组去重到人
expect(sql).toContain('COUNT(DISTINCT student_id)');
expect(sql).toContain('event IN');
// repo：/events 分页带 LIMIT ?（走 query 不走 execute）
expect(sql).toContain('LIMIT ?');
```

- [ ] **Step 2: 实现**

```ts
// repo.funnel(w, module)：
//   SELECT event, COUNT(DISTINCT student_id) AS students FROM behavior_events
//    WHERE module = ? AND created_at >= ? AND created_at < ? AND student_id IS NOT NULL
//      AND event IN (<FUNNEL_STEPS[module] 展开占位符>)
//    GROUP BY event
// service 组装成 steps 数组（步骤缺失补 0）+ conversions（第一步 null，之后 prev>0 ? cur/prev : null）
// repo.eventsPage({ event?, module?, fromAt, toAt, offset, limit=20 })：
//   两条 SQL：COUNT(*) + SELECT * WHERE 动态拼接（条件存在才拼），ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?
//   动态条件拼占位符数组（不要字符串插值用户输入——注入面）。
```

- [ ] **Step 3: controller 追加两端点**（模式同 Task 8 Step 5：`@Get('funnel')` / `@Get('events')`，query 透传 service）

- [ ] **Step 4: 全绿 + tsc + Commit**

Run: `cd apps/server && npx vitest run src/modules/analytics/ops-analytics && npx tsc --noEmit`

```bash
git add apps/server/src/modules/analytics/ops-analytics.* apps/server/src/modules/analytics/admin-analytics.controller.ts
git commit -m "feat(analytics): /funnel（8 模块漏斗）+ /events（全 tier 事件流分页）"
```

---

### Task 10: /retention + /devices + /cohort-compare

**Files:**
- Modify: 同 Task 9 三个文件

**Interfaces:**
- Produces:
  - `GET /retention?cohortStart=YYYY-MM-DD` → `{ cohortStart, cohortSize, days:[{offset, retained, rate}] }`（days 缺省 `[1,7,30]`；cohort = 首活跃日 = cohortStart 当天的学生；offset 日 = 该日有 study_session 行）
  - `GET /devices` → `{ distributions:{ platformClass:[{key,students,seconds,sessions,accuracy|null}], screenClass:[...], inputType:[...], appShell:[...], browser:[...] }, multiDevice:[{count,students}], switches:{count,students} }`
  - `GET /cohort-compare?metric=&outcome=` → `{ metric, outcome, groups:[{key, students, value:number|null}], disclaimer:'correlation-not-causation' }`

- [ ] **Step 1: 失败测试（关键口径各一条）**

```ts
// retention：D1 = 首活跃日+1 有会话的学生数 / cohortSize
const r = await svc.retention({ cohortStart: '2026-10-01' });
expect(r.days.find((d) => d.offset === 1)).toMatchObject({ retained: expect.any(Number), rate: expect.any(Number) });
// devices：一个学生多会话只算 1 人
const sql: string = ...;
expect(sql).toContain('COUNT(DISTINCT student_id)');
expect(sql).not.toContain('COUNT(student_id)');   // 防手滑
// cohort-compare：metric/outcome 白名单越界 1001
await expect(svc.cohortCompare({ metric: 'tokens', outcome: 'platform_class' })).rejects.toMatchObject({ response: { code: 1001 } });
// cohort-compare：响应必带免责声明
const r2 = await svcWithGroups().cohortCompare({ metric: 'totalSeconds', outcome: 'platform_class' });
expect(r2.disclaimer).toBe('correlation-not-causation');
```

- [ ] **Step 2: 实现**

```ts
// retention（三段 SQL）：
//   a) cohort：SELECT student_id, MIN(DATE(started_at)) AS first_day FROM study_sessions
//              GROUP BY student_id HAVING first_day = ?   → cohort id 集 + cohortSize
//   b) D{n}：SELECT COUNT(DISTINCT student_id) FROM study_sessions
//            WHERE student_id IN (cohort) AND DATE(started_at) = DATE_ADD(?, INTERVAL {n} DAY)
//   c) rate = retained / cohortSize（cohortSize=0 → rate null）
// devices：5 个维度列各一条 GROUP BY（platform_class/screen_class/input_type/app_shell/browser）：
//   SELECT {col} AS k, COUNT(DISTINCT student_id) AS students, SUM(active_seconds) AS seconds,
//          COUNT(*) AS sessions
//     FROM study_sessions WHERE started_at >= ? AND started_at < ? AND {col} IS NOT NULL
//     GROUP BY {col} ORDER BY students DESC
//   platformClass 额外 LEFT JOIN 判题对错？——简化：accuracy 直接由 behavior_events
//     （event='answer_submitted' AND module=该平台学生…）难以对齐，本期 /devices 的 accuracy
//     只对 platformClass 维度给：另一条 SQL 按 platform_class 分组 SUM(correct)/SUM(answered)，
//     answered=0 → null。其余维度 accuracy 一律 null（页面隐藏该列）。
// multiDevice：SELECT cnt, COUNT(*) AS students FROM (
//     SELECT student_id, COUNT(DISTINCT platform_class) AS cnt FROM study_sessions
//      WHERE started_at >= ? AND started_at < ? GROUP BY student_id HAVING cnt > 1) t GROUP BY cnt
// switches：会话按学生×时间排序，相邻 platform_class 不同即一次切换——
//   SELECT COUNT(*) AS cnt, COUNT(DISTINCT s1.student_id) AS students
//     FROM study_sessions s1 JOIN study_sessions s2
//       ON s1.student_id = s2.student_id AND s2.started_at > s1.started_at
//      AND s2.id = (SELECT MIN(id) FROM study_sessions m WHERE m.student_id = s1.student_id AND m.started_at > s1.started_at)
//    WHERE s1.started_at >= ? AND s1.started_at < ? AND s1.platform_class <> s2.platform_class
// cohort-compare：metric/outcome 白名单 Map（service 常量）：
//   totalSeconds → SUM(active_seconds)；answerCount → behavior_events answer_submitted 计数；
//   accuracy → SUM(is_correct)/COUNT(*)；daysActive → COUNT(DISTINCT DATE(started_at))
//   outcome 维度列：platform_class/screen_class/app_shell（study_sessions）| module（behavior_events）
//   每组 value：metric=totalSeconds/answerCount/daysActive → 学生均值（SUM/人数，人数 0 → null）；
//   accuracy → 组内 acc()
```

- [ ] **Step 3: controller 追加三端点 + 全绿 + tsc + Commit**

Run: `cd apps/server && npx vitest run src/modules/analytics/ops-analytics && npx tsc --noEmit`

```bash
git add apps/server/src/modules/analytics/ops-analytics.* apps/server/src/modules/analytics/admin-analytics.controller.ts
git commit -m "feat(analytics): /retention + /devices + /cohort-compare（按人头去重+免责声明）"
```

---

### Task 11: /quality + /llm-tokens + /llm-calls + /requests

**Files:**
- Modify: 同 Task 9 三个文件

**Interfaces:**
- Produces:
  - `GET /quality` → `{ apiFailureRate, errorCodeDistribution:[{code,count}], llmTimeoutRate, llmFallbackRate, llmAttributionCoverage, questionsWithoutStandardAnswer, kpCoverage:{covered,total,rate}, globalWordErrorRate:{wrong,total,rate}, passageSkipRate:null }`
  - `GET /llm-tokens?groupBy=scene|model|day|student` → `{ groupBy, items:[{key, calls, inputTokens, outputTokens, unavailableCalls}], attributed, unattributed, unavailableCalls }`
  - `GET /llm-calls?scene=&model=&success=&page=` → `{ items, page, pageSize:20, total }`
  - `GET /requests?path=&status=&minLatency=&page=` → `{ items, page, pageSize:20, total }`

- [ ] **Step 1: 失败测试**

```ts
// llm-tokens：groupBy 白名单
await expect(svc.llmTokens({ groupBy: 'cost' as any })).rejects.toMatchObject({ response: { code: 1001 } });
// llm-tokens：按 model_key 聚合（SQL 含 model_key 列，不含 model_id）
expect(sql).toContain('model_key');
// llm-tokens：unavailable 单列不当 0 求和
const r = await svcWithRows([{ grp: 'tutoring', calls: 3, input_tokens: 100, output_tokens: null, usage_source: 'unavailable' }]).llmTokens({ groupBy: 'scene' });
expect(r.items[0]).toMatchObject({ inputTokens: 100, outputTokens: 0, unavailableCalls: 1 });
expect(r.unavailableCalls).toBe(1);
// quality：passageSkipRate 恒 null
expect((await svc.quality({})).passageSkipRate).toBeNull();
// llm-calls / requests：分页 LIMIT ? 走 query
```

- [ ] **Step 2: 实现（SQL 要点）**

```sql
-- llm-tokens（聚合键按 groupBy 切：scene / model_key / DATE(created_at) / student_id）：
SELECT {key} AS grp, COUNT(*) AS calls,
       COALESCE(SUM(CASE WHEN usage_source <> 'unavailable' THEN input_tokens END), 0)  AS input_tokens,
       COALESCE(SUM(CASE WHEN usage_source <> 'unavailable' THEN output_tokens END), 0) AS output_tokens,
       SUM(usage_source = 'unavailable') AS unavailable_calls,
       SUM(student_id IS NOT NULL) AS attributed
  FROM llm_call_logs WHERE created_at >= ? AND created_at < ?
 GROUP BY {key} ORDER BY calls DESC;
-- 附带总览行：attributed = SUM(student_id IS NOT NULL)，unattributed = SUM(student_id IS NULL)
-- 注意：input_tokens/output_tokens 为 NULL（量不到）的行由 usage_source 区分——
--       NULL → 0 的合并只允许发生在「unavailable 已单列」之后，页面把 unavailable 单独展示。

-- quality：
--   apiFailureRate：SELECT SUM(status_code >= 500 OR biz_code NOT IN (0)) / COUNT(*) FROM api_request_logs WHERE ...
--     （口径：HTTP 5xx 或业务 code≠0 记失败；401/403/404 不在表内——母 spec §6.2 覆盖边界）
--   errorCodeDistribution：GROUP BY COALESCE(biz_code, 5001) 失败行
--   llmTimeoutRate：SUM(error_code = 'TimeoutError')/COUNT(*)；llmFallbackRate：SUM(is_fallback)/COUNT(*)
--   llmAttributionCoverage：SUM(student_id IS NOT NULL)/COUNT(*)
--   questionsWithoutStandardAnswer：questions LEFT JOIN answers … WHERE answers.id IS NULL（计划期按实际表结构核列名）
--   kpCoverage：SELECT SUM(has_kp)/COUNT(*) FROM (SELECT q.id, EXISTS(SELECT 1 FROM question_knowledge_points …) AS has_kp FROM questions q) t
--   globalWordErrorRate：SELECT SUM(error_count), COUNT(*) FROM english_words
--   passageSkipRate：响应恒 null（delta spec §7.2；无可靠数据源）

-- llm-calls：SELECT * FROM llm_call_logs WHERE 动态条件 ORDER BY created_at DESC LIMIT ? OFFSET ?（+COUNT）
-- requests：SELECT * FROM api_request_logs WHERE route LIKE ?/status_code=?/latency_ms>=? 动态拼接 LIMIT ? OFFSET ?
```

- [ ] **Step 3: controller 追加四端点 + 全绿 + tsc + Commit**

Run: `cd apps/server && npx vitest run src/modules/analytics/ops-analytics && npx tsc --noEmit`

```bash
git add apps/server/src/modules/analytics/ops-analytics.* apps/server/src/modules/analytics/admin-analytics.controller.ts
git commit -m "feat(analytics): /quality + /llm-tokens + /llm-calls + /requests（unavailable 单列，按 model_key）"
```

---

### Task 12: web api 层（trackEvents + adminAnalytics 组）

**Files:**
- Modify: `apps/web/src/services/api.ts`

**Interfaces:**
- Produces:
  - `trackEvents(events: TrackEventPayload[]): Promise<{accepted:number; rejected:number}>`——POST `/track/events`（fetchApi 自带 `/api` 前缀与 Bearer）
  - `export type AdminAnalyticsWindow = { from?: string; to?: string }`
  - 11 个只读函数（签名逐条见下）

- [ ] **Step 1: 类型与函数**（追加在 admin 分节区，`// --- Admin: Analytics (2026-10-09) ---`）

```ts
export type TrackEventPayload = {
  event: string;
  module?: string;
  scene?: string;
  subjectId?: number;
  refType?: string;
  refId?: number;
  sessionUid?: string;
  props?: Record<string, unknown>;
  clientTsMs?: number;
};

export function trackEvents(events: TrackEventPayload[]): Promise<{ accepted: number; rejected: number }> {
  return fetchApi('/track/events', { method: 'POST', body: JSON.stringify({ events }) });
}

export type AdminAnalyticsWindow = { from?: string; to?: string };
const qs = (w: AdminAnalyticsWindow) => {
  const p = new URLSearchParams();
  if (w.from) p.set('from', w.from);
  if (w.to) p.set('to', w.to);
  const s = p.toString();
  return s ? `?${s}` : '';
};

export type OverviewData = { dau: number; wau: number; totalSeconds: number; totalAnswers: number; accuracy: number | null; moduleTop: { module: string; students: number; seconds: number }[] };
export type ModulesData = { items: { module: string; students: number; seconds: number; answered: number; correct: number; accuracy: number | null }[] };
export type FunnelData = { module: string; steps: { event: string; students: number }[]; conversions: (number | null)[] };
export type RetentionData = { cohortStart: string; cohortSize: number; days: { offset: number; retained: number; rate: number | null }[] };
export type CohortCompareData = { metric: string; outcome: string; groups: { key: string; students: number; value: number | null }[]; disclaimer: string };
export type QualityData = { apiFailureRate: number; errorCodeDistribution: { code: number; count: number }[]; llmTimeoutRate: number; llmFallbackRate: number; llmAttributionCoverage: number; questionsWithoutStandardAnswer: number; kpCoverage: { covered: number; total: number; rate: number | null }; globalWordErrorRate: { wrong: number; total: number; rate: number | null }; passageSkipRate: null };
export type LlmTokensData = { groupBy: string; items: { key: string; calls: number; inputTokens: number; outputTokens: number; unavailableCalls: number }[]; attributed: number; unattributed: number; unavailableCalls: number };
export type Paged<T> = { items: T[]; page: number; pageSize: number; total: number };
export type DeviceDist = { key: string; students: number; seconds: number; sessions: number; accuracy: number | null };
export type DevicesData = { distributions: { platformClass: DeviceDist[]; screenClass: DeviceDist[]; inputType: DeviceDist[]; appShell: DeviceDist[]; browser: DeviceDist[] }; multiDevice: { count: number; students: number }[]; switches: { count: number; students: number } };

export const getAdminOverview = (w: AdminAnalyticsWindow) => fetchApi<OverviewData>(`/admin/analytics/overview${qs(w)}`);
export const getAdminModules = (w: AdminAnalyticsWindow) => fetchApi<ModulesData>(`/admin/analytics/modules${qs(w)}`);
export const getAdminFunnel = (w: AdminAnalyticsWindow & { module: string }) => fetchApi<FunnelData>(`/admin/analytics/funnel?module=${w.module}&${qs(w).slice(1)}`);
export const getAdminRetention = (cohortStart: string) => fetchApi<RetentionData>(`/admin/analytics/retention?cohortStart=${cohortStart}`);
export const getAdminCohortCompare = (w: AdminAnalyticsWindow & { metric: string; outcome: string }) => fetchApi<CohortCompareData>(`/admin/analytics/cohort-compare?metric=${w.metric}&outcome=${w.outcome}&${qs(w).slice(1)}`);
export const getAdminQuality = (w: AdminAnalyticsWindow) => fetchApi<QualityData>(`/admin/analytics/quality${qs(w)}`);
export const getAdminLlmTokens = (w: AdminAnalyticsWindow & { groupBy: string }) => fetchApi<LlmTokensData>(`/admin/analytics/llm-tokens?groupBy=${w.groupBy}&${qs(w).slice(1)}`);
export const getAdminLlmCalls = (w: AdminAnalyticsWindow & { page: number }) => fetchApi<Paged<Record<string, unknown>>>(`/admin/analytics/llm-calls?page=${w.page}&${qs(w).slice(1)}`);
export const getAdminRequests = (w: AdminAnalyticsWindow & { page: number }) => fetchApi<Paged<Record<string, unknown>>>(`/admin/analytics/requests?page=${w.page}&${qs(w).slice(1)}`);
export const getAdminEvents = (w: AdminAnalyticsWindow & { page: number; event?: string; module?: string }) => fetchApi<Paged<Record<string, unknown>>>(`/admin/analytics/events?page=${w.page}${w.event ? `&event=${w.event}` : ''}${w.module ? `&module=${w.module}` : ''}&${qs(w).slice(1)}`);
export const getAdminDevices = (w: AdminAnalyticsWindow) => fetchApi<DevicesData>(`/admin/analytics/devices${qs(w)}`);
```

- [ ] **Step 2: tsc + Commit**

Run: `cd apps/web && npx tsc -b`
Expected: 0 error

```bash
git add apps/web/src/services/api.ts
git commit -m "feat(web): trackEvents 传输与 adminAnalytics 11 端点 API 层"
```

---

### Task 13: tracker 事件队列 + 显式事件挂载

**Files:**
- Modify: `apps/web/src/analytics/tracker.ts`（事件队列 + trackEvent + 节流 + session 两事件）
- Modify: `apps/web/src/analytics/tracker.test.ts`
- Modify: `apps/web/src/hooks/useAuxChat.ts:234`（send）、`apps/web/src/hooks/useDiscussChat.ts`（send）
- Modify: `apps/web/src/components/business/practice/QuestionRunner.tsx:371-378`（self_assess 展示参考答案处）

**Interfaces:**
- Consumes: `trackEvents`（Task 12）；`SceneInfo`（sceneMap）
- Produces:
  - `setEventTransport(t: { sendEvents(events: TrackEventPayload[]): Promise<unknown> }): void`
  - `trackEvent(event: string, fields?: { refType?: string; refId?: number; props?: Record<string, unknown> }): void`——module/scene 自动取当前 SceneInfo，未登录/禁用时 no-op，**永不抛**
  - session 状态机 effects.start/end 时自动入队 `study_session_started`/`study_session_ended`

- [ ] **Step 1: 失败测试**（追加 `tracker.test.ts`；`vi.useFakeTimers()` 惯例已在该文件）

```ts
it('trackEvent 入队并批量经 eventTransport 发送（≥20 或 flushNow）', async () => {
  const sendEvents = vi.fn(async () => ({}));
  tracker.__resetForTests();
  tracker.setEventTransport({ sendEvents });
  for (let i = 0; i < 20; i++) tracker.trackEvent('page_view');
  expect(sendEvents).toHaveBeenCalledTimes(1);
  const body = sendEvents.mock.calls[0][0];
  expect(body).toHaveLength(20);
  expect(body[0]).toMatchObject({ event: 'page_view' });
  expect(body[0].clientTsMs).toBeTypeOf('number');
});

it('page_view 同一路由 30s 内去重', () => {
  const sendEvents = vi.fn(async () => ({}));
  tracker.__resetForTests();
  tracker.setEventTransport({ sendEvents });
  tracker.onRouteChange({ module: 'mainline', scene: 'course_detail', isStudyScene: true }); // 会话路径，同时应入队 page_view
  tracker.onRouteChange({ module: 'mainline', scene: 'course_detail', isStudyScene: true });
  const pages = sendEvents.mock.calls.flatMap((c) => c[0]).filter((e: any) => e.event === 'page_view');
  expect(pages).toHaveLength(1);
});

it('会话 start/end 自动入队 session 两事件（end 带 endReason）', () => {
  const sendEvents = vi.fn(async () => ({}));
  const start = vi.fn(async () => ({}));
  const end = vi.fn(async () => ({}));
  tracker.__resetForTests();
  tracker.setTransport({ start, heartbeat: vi.fn(), end } as any);
  tracker.setEventTransport({ sendEvents });
  tracker.onRouteChange({ module: 'mainline', scene: 'course_detail', isStudyScene: true });
  const names = sendEvents.mock.calls.flatMap((c) => c[0]).map((e: any) => e.event);
  expect(names).toContain('study_session_started');
  tracker.onRouteChange({ module: 'admin', scene: 'admin_dashboard', isStudyScene: false });
  const ended = sendEvents.mock.calls.flatMap((c) => c[0]).find((e: any) => e.event === 'study_session_ended');
  expect(ended.props.endReason).toBeTypeOf('string');
});

it('sendEvents 抛错被吞（.catch）', async () => {
  const sendEvents = vi.fn(async () => { throw new Error('net'); });
  tracker.__resetForTests();
  tracker.setEventTransport({ sendEvents });
  expect(() => tracker.trackEvent('page_view')).not.toThrow();
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd apps/web && npx vitest run src/analytics/tracker.test.ts`
Expected: FAIL（setEventTransport 不存在）

- [ ] **Step 3: 实现 tracker.ts**

```ts
// —— 追加实现（与既有 setTransport(:99)/runTransition(:241)/onRouteChange(:128) 融合）——
let eventTransport: { sendEvents(events: TrackEventPayload[]): Promise<unknown> } | null = null;
let eventQueue: TrackEventPayload[] = [];
let lastScene: SceneInfo | null = null;
const lastPageViewAt = new Map<string, number>();

export function setEventTransport(t: { sendEvents(events: TrackEventPayload[]): Promise<unknown> }) {
  eventTransport = t;
}

function flushEvents(): void {
  if (!eventTransport || eventQueue.length === 0) return;
  const batch = eventQueue;
  eventQueue = [];
  void eventTransport.sendEvents(batch).catch(() => { /* 失败丢弃不重试（delta spec 裁决 4 同款口径） */ });
}

export function trackEvent(event: string, fields?: { refType?: string; refId?: number; props?: Record<string, unknown> }): void {
  if (!eventTransport || !enabled) return;
  eventQueue.push({
    event,
    module: lastScene?.module ?? undefined,
    scene: lastScene?.scene ?? undefined,
    sessionUid: currentUid ?? undefined,
    refType: fields?.refType,
    refId: fields?.refId,
    props: fields?.props,
    clientTsMs: Date.now(),
  });
  if (eventQueue.length >= 20) flushEvents();
}

// onRouteChange(:128) 内：更新 lastScene 后——
//   ① page_view 节流：const key = pathname; const now = Date.now();
//      if (now - (lastPageViewAt.get(key) ?? 0) > 30_000) { lastPageViewAt.set(key, now); trackEvent('page_view'); }
//   ② 路由离开时 flushEvents()（既有会话 end 分支处一并调）。
// onPageHide(:157)：既有逻辑后追加 flushEvents()。
// runTransition(:241-252)：effects.start 分支 beginSession() 后 trackEvent('study_session_started')；
//   effects.end 分支 endSession 处 trackEvent('study_session_ended', { props: { endReason: reason } })。
//   注意顺序：ended 事件要在 currentUid 清空**之前**入队（sessionUid 字段要带上）。
// 10s 定时 flush：armTimers(:264) 里既有 30s 心跳 setInterval 之外加一个
//   setInterval(flushEvents, 10_000).unref?.()（jsdom 无 unref 则容错）。
// AnalyticsShell(:27 配置段) 同 setTransport 处追加 tracker.setEventTransport({ sendEvents: trackEvents })。
// __resetForTests(:109)：追加复位 eventQueue/lastPageViewAt/eventTransport/lastScene/currentUid。
```

- [ ] **Step 4: tracker 测试全绿**

Run: `cd apps/web && npx vitest run src/analytics/tracker.test.ts`
Expected: PASS（既有用例不红）

- [ ] **Step 5: 显式事件挂载（3 处）**

```tsx
// ① QuestionRunner.tsx:371-378 self_assess 提交后展示参考答案处（首次渲染该块时）：
import { trackEvent } from '@/analytics/tracker';
// 在 self_assess 参考答案块的挂载 effect（或提交回调里）：
trackEvent('answer_revealed', { refType: 'question', refId: question.id });

// ② useAuxChat.ts:234 send 成功发起后（内容不入任何字段——只记「发过」）：
trackEvent('ai_message_sent', { refType: 'dialogue', refId: dialogueId, props: { scene: 'aux_chat' } });

// ③ useDiscussChat.ts send：同款，props: { scene: 'course_detail', channel: 'discuss' }。
```

> `card_flipped` 本期**无发射点**（全仓无翻卡 UI，字典占位）。词族展开若未来要算翻卡，另行立项。

- [ ] **Step 6: web 全量测试 + tsc + Commit**

Run: `cd apps/web && npm test && npx tsc -b`
Expected: 全绿

```bash
git add apps/web/src/analytics/tracker.ts apps/web/src/analytics/tracker.test.ts apps/web/src/hooks/useAuxChat.ts apps/web/src/hooks/useDiscussChat.ts apps/web/src/components/business/practice/QuestionRunner.tsx
git commit -m "feat(web): tracker 显式事件队列 + session 两事件 + answer_revealed/ai_message_sent 挂载"
```

---

### Task 14: AdminNav + 路由 + 共享件

**Files:**
- Modify: `apps/web/src/components/layout/AdminNav.tsx:6-15`（navItems）
- Modify: `apps/web/src/routes/routeTable.tsx:101-118`（admin children）
- Create: `apps/web/src/pages/admin/analytics/shared.tsx`
- Create: `apps/web/src/pages/admin/analytics/shared.test.tsx`

**Interfaces:**
- Produces（8 个页面全用它）:
  - `AnalyticsPageShell({ title, description, window, onWindowChange, children })`——页头 + 日期窗（近 7 天默认，两个 `<input type="date">`）+ 子页 tab 条（8 页互链）
  - `useAdminAnalyticsWindow()`——`{ from, to, setFrom, setTo }` state（YYYY-MM-DD，默认今天-6 到今天）
  - `fmtPct(v: number|null)` / `fmtDuration(sec)`——null → '—'；秒 → 'X 小时 Y 分'
- [ ] **Step 1: shared 组件与测试**

```tsx
// shared.tsx（骨架；样式全 token，参照 AdminAlertsPage.tsx:71-78 页头模式）
const TABS = [
  { to: '/admin/analytics', label: '总览' },
  { to: '/admin/analytics/funnel', label: '漏斗' },
  { to: '/admin/analytics/retention', label: '留存' },
  { to: '/admin/analytics/modules', label: '模块' },
  { to: '/admin/analytics/devices', label: '设备' },
  { to: '/admin/analytics/quality', label: '质量' },
  { to: '/admin/analytics/llm-tokens', label: 'Token' },
  { to: '/admin/analytics/events', label: '事件流' },
];
export function AnalyticsPageShell(props: { title: string; description: string; window: { from: string; to: string }; onWindowChange: (w: { from: string; to: string }) => void; children: ReactNode }) {
  return (
    <div>
      <h1 className="text-2xl font-black tracking-tight" style={{ color: 'var(--text-primary)' }}>{props.title}</h1>
      <p className="text-sm mt-1" style={{ color: 'var(--text-secondary)' }}>{props.description}</p>
      <nav aria-label="分析子页">{TABS.map((t) => <NavLink key={t.to} to={t.to}>{t.label}</NavLink>)}</nav>
      <div data-testid="date-range">
        <input type="date" aria-label="开始日期" value={props.window.from} onChange={(e) => props.onWindowChange({ ...props.window, from: e.target.value })} />
        <input type="date" aria-label="结束日期" value={props.window.to} onChange={(e) => props.onWindowChange({ ...props.window, to: e.target.value })} />
      </div>
      {props.children}
    </div>
  );
}
export function useAdminAnalyticsWindow() { /* useState 默认近 7 天，返回 { from, to, setWindow } */ }
export const fmtPct = (v: number | null) => (v == null ? '—' : `${Math.round(v * 100)}%`);
export const fmtDuration = (sec: number) => (sec == null ? '—' : sec < 60 ? `${sec} 秒` : `${Math.floor(sec / 3600)} 小时 ${Math.round((sec % 3600) / 60)} 分`);
```

```tsx
// shared.test.tsx（globals:false 惯例照 AdminAlertsPage.test.tsx:1-2,46-47）
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { AnalyticsPageShell } from './shared';
afterEach(() => cleanup());
describe('AnalyticsPageShell', () => {
  it('渲染 8 个 tab 与日期输入', () => {
    render(<MemoryRouter><AnalyticsPageShell title="总览" description="" window={{ from: '2026-10-03', to: '2026-10-09' }} onWindowChange={() => {}}><div>body</div></AnalyticsPageShell></MemoryRouter>);
    expect(screen.getAllByRole('link')).toHaveLength(8);
    expect(screen.getByLabelText('开始日期')).toBeTruthy();
  });
});
```

- [ ] **Step 2: AdminNav + 路由**

```tsx
// AdminNav.tsx navItems 追加（末尾）：{ to: '/admin/analytics', label: '数据分析' }
// routeTable.tsx admin children 追加（懒加载方式照 children 现有条目写法）：
{ path: 'analytics', element: <AnalyticsOverviewPage /> },
{ path: 'analytics/funnel', element: <AnalyticsFunnelPage /> },
{ path: 'analytics/retention', element: <AnalyticsRetentionPage /> },
{ path: 'analytics/modules', element: <AnalyticsModulesPage /> },
{ path: 'analytics/devices', element: <AnalyticsDevicesPage /> },
{ path: 'analytics/quality', element: <AnalyticsQualityPage /> },
{ path: 'analytics/llm-tokens', element: <AnalyticsLlmTokensPage /> },
{ path: 'analytics/events', element: <AnalyticsEventsPage /> },
```

- [ ] **Step 3: 测试 + tsc + Commit**

Run: `cd apps/web && npx vitest run src/pages/admin/analytics/shared.test.tsx && npx tsc -b`
Expected: PASS（页面文件先建空壳占位以让路由不炸——8 个页面在 Task 15/16 填实；空壳仅 `export default function X(){return null}` 会挂 Shell，临时代码）

```bash
git add apps/web/src/components/layout/AdminNav.tsx apps/web/src/routes/routeTable.tsx apps/web/src/pages/admin/analytics/shared.tsx apps/web/src/pages/admin/analytics/shared.test.tsx
git commit -m "feat(web): 分析页共享件（Shell/日期窗/格式化）+ AdminNav 与 8 条路由"
```

---

### Task 15: Overview / Modules / Funnel / Retention 四页

**Files:**
- Create: `apps/web/src/pages/admin/analytics/AnalyticsOverviewPage.tsx` + `.test.tsx`
- Create: `apps/web/src/pages/admin/analytics/AnalyticsModulesPage.tsx` + `.test.tsx`
- Create: `apps/web/src/pages/admin/analytics/AnalyticsFunnelPage.tsx` + `.test.tsx`
- Create: `apps/web/src/pages/admin/analytics/AnalyticsRetentionPage.tsx` + `.test.tsx`

**页面规格（每页 = Shell + 数据获取 + 呈现；获取模式照 AdminModelsPage `useEffect+Promise.all+cancelled flag`，错误 `toast('error', err.message)`）：**

- **Overview**：4 张指标卡（dau「今日活跃」/ wau「周活跃」/ totalSeconds（fmtDuration）/ accuracy（fmtPct，null → '—'））+ `ChartLine` 趋势线（moduleTop 的 students 按 module 展示为 `ChartBar`）。
- **Modules**：表格 `<table>`，列 = 模块 / 人数 / 时长 / 答题 / 正确数 / 正确率（fmtPct）；空数组 → 「暂无数据」行（**禁**「不足 1 分钟」类反向误读）。
- **Funnel**：模块下拉（8 个白名单值）+ 步骤条（每步 event 中文名 + students + 相对上步 fmtPct 转化，第一步转化列显示 '—'）。
- **Retention**：cohortStart 日期输入 + 表（cohortSize、每行 offset/retained/rate）。

- [ ] **Step 1: Overview 页完整实现**（作为四页模板，其余三页同构替换数据源与呈现）

```tsx
// AnalyticsOverviewPage.tsx
import { useEffect, useState } from 'react';
import { getAdminOverview, type OverviewData, type AdminAnalyticsWindow } from '@/services/api';
import { AnalyticsPageShell, useAdminAnalyticsWindow, fmtPct, fmtDuration } from './shared';
import { ChartBar } from '@/components/business/parent/ChartBar';
import { toast } from '@/components/ui/toast'; // ← toast 导入路径以 AdminModelsPage 实际为准，计划期核对

export default function AnalyticsOverviewPage() {
  const w = useAdminAnalyticsWindow();
  const [data, setData] = useState<OverviewData | null>(null);
  useEffect(() => {
    let cancelled = false;
    getAdminOverview(w as AdminAnalyticsWindow).then((d) => { if (!cancelled) setData(d); }).catch((e: Error) => toast('error', e.message));
    return () => { cancelled = true; };
  }, [w.from, w.to]);
  const cards = [
    { label: '今日活跃', value: data ? String(data.dau) : '…' },
    { label: '周活跃', value: data ? String(data.wau) : '…' },
    { label: '总时长', value: data ? fmtDuration(data.totalSeconds) : '…' },
    { label: '正确率', value: data ? fmtPct(data.accuracy) : '…' },
  ];
  return (
    <AnalyticsPageShell title="数据总览" description="多少人学、学多久、答多少" window={w} onWindowChange={w.setWindow}>
      <div className="grid grid-cols-4 gap-4">{cards.map((c) => (
        <div key={c.label} className="bg-white rounded-2xl border border-gray-200 p-6" data-testid={`card-${c.label}`}>
          <div className="text-sm" style={{ color: 'var(--text-secondary)' }}>{c.label}</div>
          <div className="text-2xl font-black" style={{ color: 'var(--text-primary)' }}>{c.value}</div>
        </div>))}
      </div>
      {data && data.moduleTop.length > 0 && <ChartBar points={data.moduleTop.map((m) => ({ label: m.module, value: m.students }))} emptyText="暂无数据" />}
      {data && data.moduleTop.length === 0 && <p style={{ color: 'var(--text-secondary)' }}>暂无数据</p>}
    </AnalyticsPageShell>
  );
}
```

- [ ] **Step 2: 每页一条渲染测试**（模板；四页各一份，mock 对应 api 函数）

```tsx
// AnalyticsOverviewPage.test.tsx
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { AnalyticsOverviewPage } from './AnalyticsOverviewPage';

vi.mock('@/services/api', () => ({
  getAdminOverview: vi.fn(async () => ({ dau: 3, wau: 9, totalSeconds: 7200, totalAnswers: 40, accuracy: 0.75, moduleTop: [{ module: 'mainline', students: 3, seconds: 3600 }] })),
}));

afterEach(() => cleanup());
describe('AnalyticsOverviewPage', () => {
  it('渲染四卡与模块条', async () => {
    render(<AnalyticsOverviewPage />);
    expect(await screen.findByTestId('card-今日活跃')).toBeTruthy();
    expect(screen.getByTestId('card-正确率').textContent).toContain('75%');
  });
});
```

- [ ] **Step 3: 四页 + 测试全绿 + tsc + Commit**

Run: `cd apps/web && npx vitest run src/pages/admin/analytics/ && npx tsc -b`
Expected: PASS

```bash
git add apps/web/src/pages/admin/analytics/
git commit -m "feat(web): 分析页 Overview/Modules/Funnel/Retention"
```

---

### Task 16: Devices / Quality / LlmTokens / Events 四页

**Files:**
- Create: `apps/web/src/pages/admin/analytics/AnalyticsDevicesPage.tsx` + `.test.tsx`
- Create: `apps/web/src/pages/admin/analytics/AnalyticsQualityPage.tsx` + `.test.tsx`
- Create: `apps/web/src/pages/admin/analytics/AnalyticsLlmTokensPage.tsx` + `.test.tsx`
- Create: `apps/web/src/pages/admin/analytics/AnalyticsEventsPage.tsx` + `.test.tsx`

**页面规格：**

- **Devices**：平台分布表（key 中文映射：desktop/laptop/tablet/mobile/unknown → 桌面/笔记本/平板/手机/未知；列 = 设备/人数/时长/会话数/正确率）+ 多设备分档表 + 切换计数一行。Tab 间用下拉切换 5 个维度（platformClass 默认）。
- **Quality**：指标卡（apiFailureRate / llmTimeoutRate / llmFallbackRate / llmAttributionCoverage 全 fmtPct）+ 错误码分布表 + 内容四指标行（kpCoverage.rate、globalWordErrorRate.rate 用 fmtPct；passageSkipRate 恒 '—'）。
- **LlmTokens**：groupBy 下拉（scene/model/day/student）+ 明细表（key/calls/inputTokens/outputTokens/unavailableCalls）+ 顶部三行汇总（attributed/unattributed/unavailableCalls，注释「用量缺失不计入 0 求和」）。
- **Events**：event/module 两个筛选输入 + 分页表格（时间/event/tier/module/scene/student_id/ref）+ 上一页/下一页（page state）。

- [ ] **Step 1: 四页实现**（模板照 Task 15 Overview 页：useEffect + cancelled + Shell；每页替换数据源/呈现/控件）
- [ ] **Step 2: 每页一条渲染测试**（mock 对应 api；Events 页断言筛选输入存在、LlmTokens 页断言「用量缺失」行存在）
- [ ] **Step 3: 全绿 + tsc + Commit**

Run: `cd apps/web && npm test && npx tsc -b`
Expected: 全绿

```bash
git add apps/web/src/pages/admin/analytics/
git commit -m "feat(web): 分析页 Devices/Quality/LlmTokens/Events"
```

---

### Task 17: 文档同步

**Files:**
- Modify: `docs/API接口与数据流设计文档.md`（§4.24 AdminAnalytics 11 端点：每个端点 method/path/角色/query/校验/错误码/返回形状逐字段；§4.23 补 `POST /api/track/events`；§6 新增两条数据流：①显式事件采集链 ②ops 聚合查询链；版本日志 +0.1）
- Modify: `docs/api/openapi.yaml`（12 个端点逐字段；服务端实现即契约，以 `admin-analytics.controller.ts`/`track.controller.ts` 实际为准反向抄）
- Modify: `docs/K12智学系统-数据库设计文档.md`（Task 1 已建 behavior_events 节，复核）
- Modify: 根 `CLAUDE.md`「工程约定」加一行：`埋点写入一律经 EventsService（EVENT_TIER 字典定 tier、未登记拒写）；家长端查询硬过滤 tier='parent'（隐私三道锁，守卫测试在 parent-analytics.privacy-guard.test.ts）`。若 CLAUDE.md 超 15KB 上限，改为 `docs/constraints/analytics-privacy.md` + CLAUDE.md 一行指针。
- Modify: `docs/ai-core-changelog.md`（末尾追加本批条目：交付内容 + 测试数据 + 踩坑）

- [ ] **Step 1: API 文档**（逐端点：入参表、校验表、错误码表、响应 JSON 示例——从 repo/service 测试里的真实形状抄）
- [ ] **Step 2: openapi.yaml**（12 端点 path + request/response schema；`/api/track/events` 的 batch 50 上限写进 description）
- [ ] **Step 3: CLAUDE.md / changelog**
- [ ] **Step 4: Commit**

```bash
git add docs/API接口与数据流设计文档.md docs/api/openapi.yaml docs/K12智学系统-数据库设计文档.md CLAUDE.md docs/ai-core-changelog.md
git commit -m "docs(analytics): Phase 2 API/openapi/DB/CLAUDE/changelog 同步"
```

---

### Task 18: 全量回归 + 端到端冒烟 + 合并

- [ ] **Step 1: 双端全量测试**

Run: `cd apps/server && npm test && cd ../web && npm test`
Expected: 全绿（夜间 18:00–06:00 跑 web 会红 `routeTable.test.tsx` 主题用例——既有已知问题，`TZ=America/Los_Angeles npm test` 复跑或白天跑）

- [ ] **Step 2: 构建 + 起服务**（⚠️ build 会覆盖用户 dev server 正在服务的 dist——**先跟用户确认**再 build）

Run: `cd apps/server && npm run build && node dist/main.js`（独立端口 `PORT=3101`，日志 /tmp，**按 PID 收尾**）

- [ ] **Step 3: curl 冒烟**（学生 JWT 走登录接口取；admin 用 admin 账号）

```bash
# ① 采集：student token
curl -s -X POST :3101/api/track/events -H "Authorization: Bearer $STUDENT" -H 'Content-Type: application/json' \
  -d '{"events":[{"event":"page_view","module":"mainline","scene":"course_detail"}]}'
#    → {"code":0,...,"data":{"accepted":1,"rejected":0}}
# ② 伪造服务端事件被拒：
curl -s -X POST :3101/api/track/events -H "Authorization: Bearer $STUDENT" -H 'Content-Type: application/json' \
  -d '{"events":[{"event":"answer_submitted"}]}'
#    → data.rejected = 1
# ③ 白名单越界：
curl -s ":3101/api/admin/analytics/funnel?module=aux_qna" -H "Authorization: Bearer $ADMIN"
#    → code 1001
# ④ admin 全端点 200：overview/modules/funnel/retention/devices/quality/llm-tokens/llm-calls/requests/events
# ⑤ 查库验证落行：mysql --vertical -e "SELECT event, tier, source FROM behavior_events ORDER BY id DESC LIMIT 5"
# ⑥ 判题链路：真做一道主线练习 → behavior_events 出现 answer_submitted（tier=parent, module=mainline）
```

- [ ] **Step 4: Commit（如有冒烟修出的补丁）+ 合并准备**

```bash
git checkout main && git merge --no-ff feat/analytics-phase2-ops -m "merge: 埋点 Phase 2 运营面（behavior_events + 采集 + ops 11 端点 + admin 8 页）"
```

> 推送 origin 前先问用户。

---

## Self-Review 结论（已自查）

- **spec 覆盖**：delta spec §2→T1；§3→T2；§6→T3；§4→T4-T7；§5→T13；§7→T8-T11；§8→T14-16；§9→T17；§10→T18+各任务测试。passageSkipRate=null（T11）；card_flipped 无发射点已在 T13 标注。
- **占位符**：`subjects.repo` 归属方法名（T3 Step 5）、toast 导入路径（T15）为「计划期核对既有实现」两处——属按既有代码对齐，非设计缺口。
- **签名一致**：`track`/`recordMany`/`insertMany`/`setEventTransport`/`trackEvent` 在 T2/T3/T12/T13 间一致；`parseWindow`/`Window` 在 T8-T11 一致。

