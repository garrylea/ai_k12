# 家长端走神预警「及时可见」批 · 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让家长端在走神预警产生后 ~60s 内通过顶部 Banner 看到（30s 轮询 + 点击即已读），修掉「学生后台 tab 冻结导致 away 永远漏报」的盲区（`closeStale` 补判），并把「无操作 N 分钟」改为字面语义（去掉 +2 分钟检测窗口）。

**Architecture:** 三层改动：① `study_sessions` 仓储/服务的 `closeStale` 返回被关会话的挂机信息并由服务补判阈值；② `maybeRecordHiddenAlert` 对 `idle` 加 120s 检测窗口补偿；③ 新 `GET /parent/alerts/unread` 轮询端点（自带补判）+ 前端 `AlertBanner` 替换 `ParentLayout` 既有 banner。

**Tech Stack:** NestJS（server）+ React 19 / React Router 6（web）+ Vitest 双端。

**Spec:** `docs/superpowers/specs/2026-09-20-parent-alert-banner-timeliness-design.md`

**全局约束（每个任务都适用）：**
- 埋点纪律：`closeStale` 补判链路跑在家长查询路径上，失败只 warn、绝不 500；`maybeRecordHiddenAlert` 整段 try/catch 永不 reject。
- 测试与文档同步铁律：本计划 Task 7 必须与代码同批完成，不得留到「以后补」。
- 服务端测试命令在 `apps/server/` 下执行，前端在 `apps/web/` 下执行。

---

### Task 1: 仓储 `closeStale` 返回被关会话的挂机信息

**Files:**
- Modify: `apps/server/src/database/repositories/study-sessions.repo.ts`（`closeStale`，约 284-295 行）
- Test: `apps/server/src/database/repositories/study-sessions.repo.test.ts`（`describe('StudySessionsRepository.closeStale')`，约 405 行起）

- [ ] **Step 1: 改造既有测试 + 写失败的新测试**

既有两条用例断言 `await repo.closeStale(9)).toBe(3)` 且 `mock.calls[0]` 是 UPDATE —— 行为变更后 SELECT 会排在 UPDATE 之前。把它们改造成新签名，并新增「返回 hidden 段信息」用例。把 `describe('StudySessionsRepository.closeStale')` 整块替换为：

```ts
describe('StudySessionsRepository.closeStale', () => {
  it('按学生收尾：end_reason=closed、ended_at=最后一次心跳', async () => {
    const pool = mockPool({ affectedRows: 3 });
    const repo = new StudySessionsRepository(pool as any);
    const result = await repo.closeStale(9);
    expect(result.closedCount).toBe(3);
    expect(result.hidden).toEqual([]);

    // SELECT 在前（取挂机信息）、UPDATE 在后（收尾）
    const [selectSql, selectParams] = pool.execute.mock.calls[0];
    expect(selectSql).toMatch(/^SELECT/i);
    expect(selectSql).toContain('hidden_since');
    expect(selectParams).toEqual([9]);

    const [sql, params] = pool.execute.mock.calls[1];
    expect(sql).toContain("status = 'ended', end_reason = 'closed', ended_at = last_heartbeat_at");
    expect(sql).toContain("WHERE status = 'active' AND last_heartbeat_at < NOW(3) - INTERVAL 5 MINUTE");
    expect(sql).toContain('AND student_id = ?');
    expect(params).toEqual([9]);
  });

  it('不传 studentId → 全库收尾（夜间兜底用）', async () => {
    const pool = mockPool({ affectedRows: 0 });
    const repo = new StudySessionsRepository(pool as any);
    await repo.closeStale();
    const [, updateParams] = pool.execute.mock.calls[1];
    const [updateSql] = pool.execute.mock.calls[1];
    expect(updateSql).not.toContain('student_id = ?');
    expect(updateParams).toEqual([]);
  });

  it('返回被关会话里 hidden 段的信息（供 service 补判），visible / 无挂机的不返回', async () => {
    const since = new Date('2026-09-20T18:03:19.869Z');
    const pool = mockPool({
      affectedRows: 3,
      rows: [
        { student_id: 7, client_state: 'hidden', hidden_reason: 'away', hidden_since: since },
        { student_id: 7, client_state: 'visible', hidden_reason: null, hidden_since: null },
        { student_id: 8, client_state: 'hidden', hidden_reason: 'idle', hidden_since: since },
      ],
    });
    const repo = new StudySessionsRepository(pool as any);
    const result = await repo.closeStale(7);
    expect(result.closedCount).toBe(3);
    expect(result.hidden).toEqual([
      { studentId: 7, hiddenReason: 'away', hiddenSince: since },
      { studentId: 8, hiddenReason: 'idle', hiddenSince: since },
    ]);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd apps/server && npx vitest run src/database/repositories/study-sessions.repo.test.ts`
Expected: 新用例 FAIL（`result.hidden` 为 undefined / `closedCount` undefined），既有用例 FAIL（`.toBe(3)` 收到对象）。

- [ ] **Step 3: 实现**

`study-sessions.repo.ts` 中 `StudySessionInsertInput` 接口之后加两个导出类型：

```ts
/** `closeStale` 返回的被关会话挂机段信息（供 service 补判阈值）。 */
export interface ClosedHiddenSession {
  studentId: number;
  hiddenReason: string;
  hiddenSince: Date;
}

export interface CloseStaleResult {
  closedCount: number;
  hidden: ClosedHiddenSession[];
}
```

把 `closeStale` 整个方法替换为（docstring 保留原有关键内容并追加新说明）：

```ts
  /**
   * 惰性收尾：`active` 且心跳超 5 分钟的会话视为已结束。
   *
   * 为什么需要：用户直接关标签 / 断网时不会有 `end` 请求，会话会永远 `active`——
   * 「今日已用时长」会一直不更新。收尾时 `ended_at = last_heartbeat_at`
   * （不是 NOW），因为最后 5 分钟的实际状态未知，不能白送时长。
   *
   * `studentId` 可选：家长查单人时传（顺带修正那个人）。不传的**全库收尾形态是预留入口**
   * ——当前**无调用方**、夜间定时任务**未实现**（仓库内没有任何调度器），参数留给后续阶段用。
   *
   * 2026-09-20「及时可见」批：先 SELECT 命中行、再 UPDATE，返回**被关会话里 hidden 段的
   * 信息**（student_id / hidden_reason / hidden_since），供 `StudySessionsService.closeStale`
   * 补判走神阈值（spec §3.1：心跳全断的后台冻结 tab 只有这里能得到判定机会）。
   * SELECT 与 UPDATE 之间的并发窗口无害：另一并发收尾抢先关掉时，本侧 UPDATE 命中 0 行、
   * 多判的一次被 `SafetyAlertsService` 的 30 分钟去重窗口兜住。
   */
  async closeStale(studentId?: number): Promise<CloseStaleResult> {
    const where = studentId === undefined ? '' : ' AND student_id = ?';
    const params = studentId === undefined ? [] : [studentId];
    const [rows] = await this.pool.execute<
      (RowDataPacket & {
        student_id: number;
        client_state: string;
        hidden_reason: string | null;
        hidden_since: Date | null;
      })[]
    >(
      `SELECT student_id, client_state, hidden_reason, hidden_since FROM study_sessions
       WHERE status = 'active' AND last_heartbeat_at < NOW(3) - INTERVAL 5 MINUTE${where}`,
      params,
    );
    const hidden: ClosedHiddenSession[] = rows
      .filter((r) => r.client_state === 'hidden' && r.hidden_reason !== null && r.hidden_since !== null)
      .map((r) => ({
        studentId: r.student_id,
        hiddenReason: r.hidden_reason as string,
        hiddenSince: r.hidden_since as Date,
      }));
    const [result] = await this.pool.execute<ResultSetHeader>(
      `UPDATE study_sessions
       SET status = 'ended', end_reason = 'closed', ended_at = last_heartbeat_at
       WHERE status = 'active' AND last_heartbeat_at < NOW(3) - INTERVAL 5 MINUTE${where}`,
      params,
    );
    return { closedCount: result.affectedRows, hidden };
  }
```

- [ ] **Step 4: 跑测试确认通过**

Run: `cd apps/server && npx vitest run src/database/repositories/study-sessions.repo.test.ts`
Expected: PASS（3 用例）。

- [ ] **Step 5: 跑服务层测试确认只影响预期范围**

Run: `cd apps/server && npx vitest run src/modules/analytics/study-sessions.service.test.ts`
Expected: 可能有 FAIL —— `makeRepo` 里 `closeStale: vi.fn().mockResolvedValue(0)` 的默认 mock 现在返回的是裸数字而 service 将消费新形状。若 fail，把默认改为 `vi.fn().mockResolvedValue({ closedCount: 0, hidden: [] })`（Task 3 会再动它）。改完应 PASS。

- [ ] **Step 6: Commit**

```bash
git add apps/server/src/database/repositories/study-sessions.repo.ts apps/server/src/database/repositories/study-sessions.repo.test.ts apps/server/src/modules/analytics/study-sessions.service.test.ts
git commit -m "feat(analytics): closeStale 返回被关会话的挂机信息（补判数据源，Task 1）"
```

---

### Task 2: `idle` 判定改字面语义（+120s 检测窗口补偿）

**Files:**
- Modify: `apps/server/src/modules/analytics/study-sessions.service.ts`（`maybeRecordHiddenAlert`，约 254-281 行）
- Test: `apps/server/src/modules/analytics/study-sessions.service.test.ts`（`describe('StudySessionsService.heartbeat')` 内追加）

- [ ] **Step 1: 写失败的测试**

在 `describe('StudySessionsService.heartbeat')` 的「idle 段达到 idle 阈值 → 写 idle 预警」用例之后追加：

```ts
  it('idle 字面语义：hidden_since 3分50秒前 + 120s 检测窗口 = 5分50秒 ≥ 阈值 5 → 报，文案分钟数按有效值', async () => {
    // spec §3.2：家长口径的「无操作 N 分钟」从最后一次操作起算。hidden_since 建立时
    // 距最后一次操作已过了 120s 前端检测窗口，必须补回去（2026-09-20 裁决，去 7 分钟口径）。
    const since = new Date(Date.now() - (3 * 60_000 + 50_000));
    const repo = makeRepo({
      heartbeat: vi.fn().mockResolvedValue({ activeSeconds: 100, hiddenSince: since, hiddenReason: 'idle' }),
    });
    const safety = makeSafety();
    const controls = makeControls({
      findAlertThresholds: vi.fn().mockResolvedValue({ awayMinutes: 2, idleMinutes: 5 }),
    });
    const service = makeService(repo, makeSubjects(), safety, controls);

    await service.heartbeat({ studentId: 9, sessionUid: baseInput().sessionUid, state: 'hidden', reason: 'idle' });

    await vi.waitFor(() => expect(safety.record).toHaveBeenCalledTimes(1));
    // 有效经过 = 230s + 120s = 350s → 分钟数 5（不是 3）
    expect(safety.record).toHaveBeenCalledWith(expect.objectContaining({ type: 'idle', message: 'msg:idle:5' }));
  });

  it('idle 字面语义：有效值未达阈值 → 不报（2 分钟前挂机 + 120s = 4 分钟 < 5）', async () => {
    const since = new Date(Date.now() - 2 * 60_000);
    const repo = makeRepo({
      heartbeat: vi.fn().mockResolvedValue({ activeSeconds: 100, hiddenSince: since, hiddenReason: 'idle' }),
    });
    const safety = makeSafety();
    const controls = makeControls({
      findAlertThresholds: vi.fn().mockResolvedValue({ awayMinutes: 2, idleMinutes: 5 }),
    });
    const service = makeService(repo, makeSubjects(), safety, controls);

    await service.heartbeat({ studentId: 9, sessionUid: baseInput().sessionUid, state: 'hidden', reason: 'idle' });

    await flushAsync();
    expect(controls.findAlertThresholds).toHaveBeenCalledWith(9);
    expect(safety.record).not.toHaveBeenCalled();
  });
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd apps/server && npx vitest run src/modules/analytics/study-sessions.service.test.ts`
Expected: 第一条新用例 FAIL（当前口径 230s < 300s 不写预警）；第二条 PASS（当前也不写）。

- [ ] **Step 3: 实现**

`study-sessions.service.ts` 顶部（`END_REASONS` 常量附近）加导出常量：

```ts
/**
 * 前端空闲检测窗口（秒），与 `apps/web/src/analytics/tracker.ts` 的
 * `IDLE_TIMEOUT_MS = 120_000` **同源镜像**——改一处必须同步另一处。
 *
 * 为什么需要：`hidden_since` 是客户端 120s 无操作判定之后才建立的，若直接拿
 * `now - hidden_since` 与家长阈值比较，家长感知的「无操作时长」= 120s + 阈值。
 * 2026-09-20 裁决改字面语义（spec §3.2）：idle 判定把窗口补回去；
 * away 的 `hidden_since` 就是离开时刻，无需补偿。
 * 已知边界：阈值 ≤ 2 分钟时 idle 实际生效值约为 2 分钟（检测窗口即下限）。
 */
export const CLIENT_IDLE_DETECTION_SECONDS = 120;
```

`maybeRecordHiddenAlert` 中，把

```ts
      const elapsedSeconds = Math.floor((Date.now() - hiddenSince.getTime()) / 1000);
```

替换为：

```ts
      const rawElapsedSeconds = Math.floor((Date.now() - hiddenSince.getTime()) / 1000);
      // idle 的家长口径是「从最后一次操作起算」（spec §3.2）：hidden_since 建立时距最后一次
      // 操作已过了 120s 检测窗口，补回去才是家长理解的「无操作 N 分钟」。
      const elapsedSeconds =
        hiddenReason === 'idle' ? rawElapsedSeconds + CLIENT_IDLE_DETECTION_SECONDS : rawElapsedSeconds;
```

（`minutes` 的计算 `Math.floor(elapsedSeconds / 60)` 在后面，不用动——它自动用上有效值。）

- [ ] **Step 4: 跑测试确认全部通过**

Run: `cd apps/server && npx vitest run src/modules/analytics/study-sessions.service.test.ts`
Expected: PASS。既有 idle 用例（16 分钟 > 15）在新口径下有效值 18 分钟，仍过；away 用例全部不受影响。

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/modules/analytics/study-sessions.service.ts apps/server/src/modules/analytics/study-sessions.service.test.ts
git commit -m "feat(analytics): idle 走神判定改字面语义（+120s 检测窗口补偿，Task 2）"
```

---

### Task 3: `StudySessionsService.closeStale` 补判阈值

**Files:**
- Modify: `apps/server/src/modules/analytics/study-sessions.service.ts`（`closeStale`，约 287-289 行）
- Test: `apps/server/src/modules/analytics/study-sessions.service.test.ts`（新增 describe 块）

- [ ] **Step 1: 写失败的测试**

在 `describe('StudySessionsService.end')` 之后追加：

```ts
describe('StudySessionsService.closeStale（补判）', () => {
  it('收尾出的 hidden 会话超阈值 → 补写预警（后台 tab 冻结 / end 丢失场景）', async () => {
    const since = new Date(Date.now() - 30 * 60_000); // 30 分钟前开始挂机
    const repo = makeRepo({
      closeStale: vi.fn().mockResolvedValue({
        closedCount: 1,
        hidden: [{ studentId: 9, hiddenReason: 'away', hiddenSince: since }],
      }),
    });
    const safety = makeSafety();
    const service = makeService(repo, makeSubjects(), safety, makeControls());

    const closed = await service.closeStale(9);

    expect(closed).toBe(1);
    expect(safety.record).toHaveBeenCalledWith({
      studentId: 9,
      dialogueId: null,
      type: 'away',
      level: 'info',
      message: 'msg:away:30',
      context: 'ctx:away:30',
    });
  });

  it('收尾出的 hidden 会话走 idle 补偿口径', async () => {
    const since = new Date(Date.now() - (3 * 60_000 + 50_000));
    const repo = makeRepo({
      closeStale: vi.fn().mockResolvedValue({
        closedCount: 1,
        hidden: [{ studentId: 9, hiddenReason: 'idle', hiddenSince: since }],
      }),
    });
    const safety = makeSafety();
    const controls = makeControls({
      findAlertThresholds: vi.fn().mockResolvedValue({ awayMinutes: 2, idleMinutes: 5 }),
    });
    const service = makeService(repo, makeSubjects(), safety, controls);

    await service.closeStale(9);

    expect(safety.record).toHaveBeenCalledWith(expect.objectContaining({ type: 'idle', message: 'msg:idle:5' }));
  });

  it('无 hidden 段 → 不查阈值、不写预警；返回值仍是收尾条数', async () => {
    const repo = makeRepo({
      closeStale: vi.fn().mockResolvedValue({ closedCount: 2, hidden: [] }),
    });
    const controls = makeControls();
    const service = makeService(repo, makeSubjects(), makeSafety(), controls);

    await expect(service.closeStale(9)).resolves.toBe(2);
    expect(controls.findAlertThresholds).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd apps/server && npx vitest run src/modules/analytics/study-sessions.service.test.ts`
Expected: 前两条 FAIL（当前 `closeStale` 不判阈值、`safety.record` 不被调）。

- [ ] **Step 3: 实现**

把 `StudySessionsService.closeStale` 替换为：

```ts
  /**
   * 惰性收尾（家长端查询前；不传 studentId 的全库形态是**预留入口**，当前无调用方、
   * 夜间定时任务未实现）。见 repo 的同名方法。
   *
   * 2026-09-20「及时可见」批（spec §3.1）：收尾出的 hidden 段逐条补判走神阈值——
   * 这是「心跳全断的会话」（后台 tab 被浏览器冻结 / 关闭时 end fetch 被取消）**唯一**的
   * 判定机会。`await` 而不是 `void`：本方法跑在家长查询路径（30s 轮询 / 学情 GET），不是
   * 学生心跳热路径；且轮询端点希望「本次收尾出的预警」直接出现在本次响应里。
   * `maybeRecordHiddenAlert` 整段 try/catch 永不 reject，`await` 不引入新失败面。
   */
  async closeStale(studentId?: number): Promise<number> {
    const { closedCount, hidden } = await this.repo.closeStale(studentId);
    for (const session of hidden) {
      await this.maybeRecordHiddenAlert(session.studentId, session.hiddenReason, session.hiddenSince);
    }
    return closedCount;
  }
```

- [ ] **Step 4: 跑测试确认通过**

Run: `cd apps/server && npx vitest run src/modules/analytics/study-sessions.service.test.ts`
Expected: PASS（含新 describe 3 条）。

- [ ] **Step 5: 跑学情侧测试确认 `closeStaleQuietly` 调用方不受影响**

Run: `cd apps/server && npx vitest run src/modules/parent-insights/study-time.service.test.ts`
Expected: PASS（`closeStaleQuietly` 的 mock 是 `closeStale: vi.fn().mockResolvedValue(...)`，若其默认形状是裸数字导致 FAIL，同步改为 `{ closedCount: n, hidden: [] }`）。

- [ ] **Step 6: Commit**

```bash
git add apps/server/src/modules/analytics/study-sessions.service.ts apps/server/src/modules/analytics/study-sessions.service.test.ts apps/server/src/modules/parent-insights/study-time.service.test.ts
git commit -m "feat(analytics): closeStale 补判走神阈值（修后台 tab 冻结漏报盲区，Task 3）"
```

---

### Task 4: 新端点 `GET /parent/alerts/unread`（自带补判）

**Files:**
- Modify: `apps/server/src/modules/parent-insights/dto/parent-insights.dto.ts`（`ParentAlertPage` 之后加两个接口）
- Modify: `apps/server/src/modules/parent-insights/alerts.service.ts`
- Modify: `apps/server/src/modules/parent-insights/parent-insights.controller.ts`（`@Get('alerts')` 之前插入新 handler）
- Test: `apps/server/src/modules/parent-insights/alerts.service.test.ts`
- Test: `apps/server/src/modules/parent-insights/parent-insights.controller.test.ts`

- [ ] **Step 1: DTO**

`parent-insights.dto.ts` 的 `ParentAlertPage` 接口之后追加：

```ts
/** 轮询用的未读预警条目（spec §3.3：banner 只需要展示字段，不带 context/dialogueId）。 */
export interface ParentUnreadAlertItem {
  id: number;
  type: string;
  level: string;
  message: string;
  studentName: string | null;
  createdAt: Date;
}

/** `GET /parent/alerts/unread` 响应：items 截最新 5 条，total 是未读总数。 */
export interface ParentUnreadAlerts {
  items: ParentUnreadAlertItem[];
  total: number;
}
```

- [ ] **Step 2: 写失败的服务测试**

`alerts.service.test.ts` 顶部 import 区补：

```ts
import type { StudentsRepository } from '../../database/repositories/students.repo.js';
import type { StudySessionsService } from '../analytics/study-sessions.service.js';
```

在该文件既有 describe 块之后追加（沿用该文件既有的 `SafetyAlertsRepository` 假实现方式；若文件里已有 `makeRepo` 风格的工厂，按其形态对齐）：

```ts
describe('AlertsService.unread（轮询端点 + 补判）', () => {
  function makeUnreadDeps() {
    const alertsRepo = {
      listByParent: vi.fn().mockResolvedValue({
        items: [
          {
            id: 26, student_id: 7, student_name: '小刚', type: 'idle', level: 'info',
            message: '孩子在学习页面 5 分钟无操作', context: '无操作 5 分钟',
            dialogue_id: null, is_read: 0, created_at: new Date('2026-09-20T19:26:27Z'),
          },
        ],
        total: 1,
      }),
    } as unknown as SafetyAlertsRepository;
    const sessions = { closeStale: vi.fn().mockResolvedValue(1) } as unknown as StudySessionsService;
    const studentsRepo = {
      findByParentId: vi.fn().mockResolvedValue([{ id: 7 }, { id: 8 }]),
    } as unknown as StudentsRepository;
    return { alertsRepo, sessions, studentsRepo };
  }

  it('先补判（名下每个孩子各一次 closeStale）再查未读；items 只带展示字段', async () => {
    const { alertsRepo, sessions, studentsRepo } = makeUnreadDeps();
    const service = new AlertsService(alertsRepo, sessions, studentsRepo);

    const result = await service.unread(4);

    expect(sessions.closeStale).toHaveBeenCalledTimes(2);
    expect(sessions.closeStale).toHaveBeenCalledWith(7);
    expect(sessions.closeStale).toHaveBeenCalledWith(8);
    expect(alertsRepo.listByParent).toHaveBeenCalledWith(4, { unreadOnly: true }, 5, 0);
    expect(result).toEqual({
      items: [
        {
          id: 26, type: 'idle', level: 'info',
          message: '孩子在学习页面 5 分钟无操作',
          studentName: '小刚', createdAt: new Date('2026-09-20T19:26:27Z'),
        },
      ],
      total: 1,
    });
  });

  it('补判失败只 warn、不 500，仍返回未读列表', async () => {
    const { alertsRepo, studentsRepo } = makeUnreadDeps();
    const sessions = { closeStale: vi.fn().mockRejectedValue(new Error('db down')) } as unknown as StudySessionsService;
    const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const service = new AlertsService(alertsRepo, sessions, studentsRepo);

    try {
      const result = await service.unread(4);
      expect(result.total).toBe(1);
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('补判失败'));
    } finally {
      warn.mockRestore();
    }
  });
});
```

（若该测试文件尚无 `Logger` import，从 `@nestjs/common` 补。）

- [ ] **Step 3: 跑测试确认失败**

Run: `cd apps/server && npx vitest run src/modules/parent-insights/alerts.service.test.ts`
Expected: FAIL（`AlertsService` 构造函数只收 1 参 / 无 `unread` 方法）。

- [ ] **Step 4: 实现 AlertsService**

`alerts.service.ts` 全量改造（import 区新增 + 构造函数 + `unread` 方法 + 映射函数）：

```ts
import {
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { SafetyAlertsRepository } from '../../database/repositories/safety-alerts.repo.js';
import type { SafetyAlertRowWithStudentName } from '../../database/repositories/safety-alerts.repo.js';
import { StudentsRepository } from '../../database/repositories/students.repo.js';
import { StudySessionsService } from '../analytics/study-sessions.service.js';
import type {
  ParentAlertItem,
  ParentAlertPage,
  ParentUnreadAlertItem,
  ParentUnreadAlerts,
} from './dto/parent-insights.dto.js';
```

类内：

```ts
@Injectable()
export class AlertsService {
  private readonly logger = new Logger(AlertsService.name);

  constructor(
    private readonly alertsRepo: SafetyAlertsRepository,
    @Inject(StudySessionsService) private readonly sessions: StudySessionsService,
    @Inject(StudentsRepository) private readonly studentsRepo: StudentsRepository,
  ) {}
```

（`list` / `markRead` 保持不动。）在 `markRead` 之后追加：

```ts
  /**
   * 轮询端点（spec §3.3）：家长端 Banner 每 30s 拉一次。**先补判再查**——
   * 对名下每个孩子跑一次 `closeStale`（内部会补判走神阈值），后台 tab 冻结的学生端
   * 也能在一个轮询周期内把预警送进 banner。
   *
   * 嵌在业务流里的写入：整段 catch、失败只 warn、绝不把轮询打成 500。
   */
  async unread(parentId: number): Promise<ParentUnreadAlerts> {
    try {
      const students = await this.studentsRepo.findByParentId(parentId);
      await Promise.all(students.map((s) => this.sessions.closeStale(s.id)));
    } catch (err) {
      this.logger.warn(`unread 轮询的补判失败（已忽略，按现状返回未读）：${String(err)}`);
    }
    const { items, total } = await this.alertsRepo.listByParent(parentId, { unreadOnly: true }, 5, 0);
    return { items: items.map(toUnreadItem), total };
  }
```

文件底部 `toAlertItem` 之后追加：

```ts
/** 轮询 DTO：只带 banner 展示字段（spec §3.3），不带 context/dialogueId/isRead。 */
function toUnreadItem(row: SafetyAlertRowWithStudentName): ParentUnreadAlertItem {
  return {
    id: row.id,
    type: row.type,
    level: row.level,
    message: row.message,
    studentName: row.student_name ?? null,
    createdAt: row.created_at,
  };
}
```

**注意（DI 铁律，CLAUDE.md）**：`StudySessionsService` 与 `StudentsRepository` 都是类 token，`ParentInsightsModule` 已分别 `imports: [AnalyticsModule]`（导出 `StudySessionsService`）且 `providers` 里有 `StudentsRepository`，**模块文件不用改**。

- [ ] **Step 5: 跑服务测试确认通过**

Run: `cd apps/server && npx vitest run src/modules/parent-insights/alerts.service.test.ts`
Expected: PASS。

- [ ] **Step 6: 写失败的控制器测试**

`parent-insights.controller.test.ts` 中 `makeController` 的 `alerts` 假实现补一个方法：

```ts
  const alerts = {
    list: vi.fn().mockResolvedValue({ items: [], total: 0, page: 1, pageSize: 20 }),
    markRead: vi.fn().mockResolvedValue(undefined),
    unread: vi.fn().mockResolvedValue({ items: [], total: 0 }),
  } as unknown as AlertsService;
```

追加 describe 块：

```ts
describe('ParentInsightsController 未读轮询端点', () => {
  it('GET alerts/unread：不做学生归属校验（家长维度），直接透传 user.sub', async () => {
    const requireOwned = vi.fn();
    const { controller, alerts } = makeController(requireOwned);

    await controller.listUnreadAlerts(USER);

    expect(requireOwned).not.toHaveBeenCalled();
    expect(alerts.unread).toHaveBeenCalledWith(3);
  });
});
```

- [ ] **Step 7: 跑测试确认失败**

Run: `cd apps/server && npx vitest run src/modules/parent-insights/parent-insights.controller.test.ts`
Expected: FAIL（`controller.listUnreadAlerts` 不是函数）。

- [ ] **Step 8: 实现控制器 handler**

`parent-insights.controller.ts`：import 区把 `ParentAlertPage` 的类型 import 扩为同时取 `ParentUnreadAlerts`（该文件从 `./dto/parent-insights.dto.js` import 类型的既有行上补）。在 `@Get('alerts')` 的 handler **之前**插入（同方法前缀无路径冲突，放前面只为可读性）：

```ts
  /**
   * 未读预警轮询（spec §3.3，家长端 Banner 30s 一次）。家长维度、不看单个孩子，
   * 因此**不做** `requireOwnedStudent`；service 内部先对名下全部孩子跑 `closeStale`
   * 补判（失败只 warn）。空结果是正常态。
   */
  @Get('alerts/unread')
  async listUnreadAlerts(@CurrentUser() user: JwtUser): Promise<ParentUnreadAlerts> {
    return this.alertsService.unread(user.sub);
  }
```

- [ ] **Step 9: 跑控制器测试 + 全模块回归**

Run: `cd apps/server && npx vitest run src/modules/parent-insights/`
Expected: PASS。

- [ ] **Step 10: 启动冒烟（真库验证端点）**

Run: `cd apps/server && npm run build && node dist/main.js`（后台起），然后：

```bash
curl -s -X POST http://localhost:3000/auth/login -H 'Content-Type: application/json' \
  -d '{"username":"<家长账号>","password":"<密码>"}' | jq -r .accessToken
curl -s http://localhost:3000/parent/alerts/unread -H "Authorization: Bearer <token>" | jq
```

Expected: 200，`{ items: [...], total: N }`；库里那两条未读 idle 预警（id 25/26）应出现在 items 里。验证后停掉服务。

- [ ] **Step 11: Commit**

```bash
git add apps/server/src/modules/parent-insights/
git commit -m "feat(parent): GET /parent/alerts/unread 轮询端点（自带 closeStale 补判，Task 4）"
```

---

### Task 5: 前端 API 层 `getParentUnreadAlerts`

**Files:**
- Modify: `apps/web/src/services/api.ts`（`markParentAlertRead` 附近，约 2430-2436 行）

- [ ] **Step 1: 加类型与函数**

在 `ParentAlertPage` 相关类型附近（`markParentAlertRead` 之前）追加：

```ts
/** 轮询用的未读预警（spec §3.3：banner 只需要展示字段）。 */
export interface ParentUnreadAlertItem {
  id: number;
  type: string;
  level: string;
  message: string;
  studentName: string | null;
  createdAt: string;
}

export interface ParentUnreadAlerts {
  items: ParentUnreadAlertItem[];
  total: number;
}

export function getParentUnreadAlerts(): Promise<ParentUnreadAlerts> {
  return fetchApi<ParentUnreadAlerts>('/parent/alerts/unread');
}
```

- [ ] **Step 2: 类型检查**

Run: `cd apps/web && npx tsc -b`
Expected: 无错误。

- [ ] **Step 3: Commit**

```bash
git add apps/web/src/services/api.ts
git commit -m "feat(web): getParentUnreadAlerts API（Task 5）"
```

---

### Task 6: `AlertBanner` 组件 + 替换 `ParentLayout` 既有 banner

**Files:**
- Create: `apps/web/src/components/business/AlertBanner.tsx`
- Create: `apps/web/src/components/business/AlertBanner.test.tsx`
- Modify: `apps/web/src/components/layout/ParentLayout.tsx`
- Modify: `apps/web/src/components/layout/ParentLayout.test.tsx`

- [ ] **Step 1: 写失败的组件测试**

`apps/web/src/components/business/AlertBanner.test.tsx`：

```tsx
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import { createMemoryRouter, RouterProvider } from 'react-router-dom';
import AlertBanner, { ALERT_POLL_INTERVAL_MS } from './AlertBanner';
import {
  getParentUnreadAlerts,
  markParentAlertRead,
  type ParentUnreadAlerts,
} from '@/services/api';

vi.mock('@/services/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/services/api')>();
  return {
    ...actual,
    getParentUnreadAlerts: vi.fn(),
    markParentAlertRead: vi.fn().mockResolvedValue(null),
  };
});

const getParentUnreadAlertsMock = vi.mocked(getParentUnreadAlerts);
const markParentAlertReadMock = vi.mocked(markParentAlertRead);

function unread(over: Partial<ParentUnreadAlerts> = {}): ParentUnreadAlerts {
  return {
    items: [
      {
        id: 26,
        type: 'idle',
        level: 'info',
        message: '孩子在学习页面 5 分钟无操作',
        studentName: '小刚',
        createdAt: '2026-09-20T19:26:27.728Z',
      },
    ],
    total: 1,
    ...over,
  };
}

function renderBanner() {
  const router = createMemoryRouter([
    {
      path: '/parent',
      element: <AlertBanner />,
      children: [{ path: 'alerts', element: <div>预警中心页</div> }],
    },
  ], { initialEntries: ['/parent'] });
  return render(<RouterProvider router={router} />);
}

beforeEach(() => {
  vi.useFakeTimers();
  getParentUnreadAlertsMock.mockReset().mockResolvedValue(unread());
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('AlertBanner', () => {
  it('有未读 → 渲染 Banner（info 走神 → warning 橙色档，标题=消息本身）', async () => {
    renderBanner();
    expect(await screen.findByText('孩子在学习页面 5 分钟无操作')).toBeInTheDocument();
  });

  it('多条未读 → 聚合标题「有 N 条新预警，最新：…」', async () => {
    getParentUnreadAlertsMock.mockResolvedValue(
      unread({
        items: [
          { id: 27, type: 'idle', level: 'info', message: 'B 消息', studentName: null, createdAt: '2026-09-20T19:30:00Z' },
          { id: 26, type: 'idle', level: 'info', message: 'A 消息', studentName: '小刚', createdAt: '2026-09-20T19:26:27Z' },
        ],
        total: 7,
      }),
    );
    renderBanner();
    expect(await screen.findByText('有 7 条新预警，最新：B 消息')).toBeInTheDocument();
  });

  it('最新一条是 warning/critical → Banner 用 danger 档（红色）', async () => {
    getParentUnreadAlertsMock.mockResolvedValue(
      unread({
        items: [{ id: 1, type: 'off_topic', level: 'warning', message: '闲聊预警', studentName: '小刚', createdAt: '2026-09-20T19:00:00Z' }],
        total: 1,
      }),
    );
    renderBanner();
    await screen.findByText('闲聊预警');
    // danger 档的类名来自 base Banner 的 typeStyles
    expect(document.querySelector('.bg-\\[var\\(--error\\)\\]')).not.toBeNull();
  });

  it('无未读 / 请求失败 → 不渲染任何东西', async () => {
    getParentUnreadAlertsMock.mockResolvedValue({ items: [], total: 0 });
    const { container } = renderBanner();
    await waitFor(() => expect(getParentUnreadAlertsMock).toHaveBeenCalledTimes(1));
    expect(container.querySelector('button')).toBeNull();

    getParentUnreadAlertsMock.mockRejectedValue(new Error('net'));
    await vi.advanceTimersByTimeAsync(ALERT_POLL_INTERVAL_MS);
    expect(container.querySelector('button')).toBeNull();
  });

  it('每 30s 轮询一次', async () => {
    renderBanner();
    await waitFor(() => expect(getParentUnreadAlertsMock).toHaveBeenCalledTimes(1));
    await vi.advanceTimersByTimeAsync(ALERT_POLL_INTERVAL_MS);
    expect(getParentUnreadAlertsMock).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(ALERT_POLL_INTERVAL_MS);
    expect(getParentUnreadAlertsMock).toHaveBeenCalledTimes(3);
  });

  it('点击「立即查看」→ 对每条未读发标已读、清掉 Banner、跳 /parent/alerts', async () => {
    getParentUnreadAlertsMock.mockResolvedValue(
      unread({
        items: [
          { id: 27, type: 'idle', level: 'info', message: 'B', studentName: null, createdAt: '2026-09-20T19:30:00Z' },
          { id: 26, type: 'idle', level: 'info', message: 'A', studentName: null, createdAt: '2026-09-20T19:26:27Z' },
        ],
        total: 2,
      }),
    );
    renderBanner();
    const button = await screen.findByRole('button', { name: '立即查看' });
    fireEvent.click(button);

    await waitFor(() => expect(markParentAlertReadMock).toHaveBeenCalledTimes(2));
    expect(markParentAlertReadMock).toHaveBeenCalledWith(26);
    expect(markParentAlertReadMock).toHaveBeenCalledWith(27);
    // 乐观清掉 + 跳预警页
    expect(screen.queryByRole('button', { name: '立即查看' })).toBeNull();
    await waitFor(() => expect(screen.getByText('预警中心页')).toBeInTheDocument());
  });

  it('标已读请求失败 → 静默（仍跳转，下次轮询可能再出现）', async () => {
    markParentAlertReadMock.mockRejectedValue(new Error('net'));
    renderBanner();
    fireEvent.click(await screen.findByRole('button', { name: '立即查看' }));
    await waitFor(() => expect(screen.getByText('预警中心页')).toBeInTheDocument());
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd apps/web && npx vitest run src/components/business/AlertBanner.test.tsx`
Expected: FAIL（组件文件不存在）。

- [ ] **Step 3: 实现组件**

`apps/web/src/components/business/AlertBanner.tsx`：

```tsx
import { useCallback, useEffect, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { Banner } from '@/components/base';
import { getParentUnreadAlerts, markParentAlertRead, type ParentUnreadAlerts } from '@/services/api';

/**
 * 轮询间隔（spec §3.4）：预警数据源（学生心跳）本身就是 30s 粒度，更快的轮询没有意义。
 * 后台标签页会被浏览器节流到约 1 次/分钟，回前台的下一次轮询立刻补上，可接受。
 */
export const ALERT_POLL_INTERVAL_MS = 30_000;

/**
 * 家长端全局预警 Banner（「及时可见」批，spec §3.4）：
 * 30s 轮询 + 路由切换即刷 → 有未读就挂在所有家长页顶部；**点击即已读**（2026-09-20
 * 用户裁决：点了 banner 查看信息后 banner 消失，不提供「不看不消失」的关闭钮）。
 *
 * 覆盖家长名下**全部孩子**、**全部级别**（含 info 级走神——上一批「info 只进列表页」
 * 的裁决被本批显式推翻）；配色按最新一条的 level 映射：warning/critical → danger（红），
 * 其余（info 走神）→ warning（橙）。
 */
export default function AlertBanner() {
  const navigate = useNavigate();
  const location = useLocation();
  const [unread, setUnread] = useState<ParentUnreadAlerts | null>(null);

  const load = useCallback(() => {
    getParentUnreadAlerts()
      .then(setUnread)
      .catch(() => {
        /* 轮询失败静默：保持上次值，不打扰 */
      });
  }, []);

  // 挂载即查 + 路由切换即刷（读预警返回后立刻反映「已读完」）
  useEffect(() => {
    load();
  }, [load, location.pathname]);

  useEffect(() => {
    const timer = setInterval(load, ALERT_POLL_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [load]);

  if (!unread || unread.total === 0 || unread.items.length === 0) return null;

  const latest = unread.items[0];
  const title = unread.total > 1 ? `有 ${unread.total} 条新预警，最新：${latest.message}` : latest.message;
  const type = latest.level === 'warning' || latest.level === 'critical' ? 'danger' : 'warning';

  const handleClick = () => {
    // 点击即已读：乐观清掉 + 跳转；标已读失败静默（下次轮询会再出现，可接受）
    setUnread(null);
    void Promise.allSettled(unread.items.map((alert) => markParentAlertRead(alert.id)));
    navigate('/parent/alerts');
  };

  return (
    <Banner
      type={type}
      title={title}
      description={`${latest.studentName ?? '孩子'} · 点击查看详情并标记已读`}
      action={
        <button
          type="button"
          onClick={handleClick}
          className="px-4 py-1.5 bg-white text-[var(--error)] rounded-md text-sm font-semibold hover:bg-gray-50 shrink-0"
        >
          立即查看
        </button>
      }
    />
  );
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `cd apps/web && npx vitest run src/components/business/AlertBanner.test.tsx`
Expected: PASS（7 用例）。注意 `globals: false` 铁律——本文件已自带 `afterEach(cleanup)`。

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/components/business/AlertBanner.tsx apps/web/src/components/business/AlertBanner.test.tsx
git commit -m "feat(web): AlertBanner 组件（30s 轮询 + 点击即已读，Task 6）"
```

- [ ] **Step 6: 改造 ParentLayout（替换旧 banner 逻辑）**

`ParentLayout.tsx`：
1. 删除 ` getParentAlerts, type ParentAlertItem ` 的 import（保留 `getUnreadMessageCount`）；
2. 删除 `alert` state、`bannerAlert` 派生值、以及「Banner 与未读数同一刷新时机」那个 `useEffect`（`studentId` 为 null 的分支一并删）；
3. 顶部预警 Banner 的 JSX 块 `{bannerAlert && (<Banner .../>)}` 替换为 `<AlertBanner />`；
4. import 区加 `import AlertBanner from '@/components/business/AlertBanner';`；
5. `Banner` 的 base import 若不再被本文件使用则删除；
6. `studentId` 仍被 `StudentSwitcher` 等使用则保留 `useParentStudentStore`（只删 banner 相关消费）。

改造后的 JSX 骨架（顶部区域）：

```tsx
        <div className="flex-1 flex flex-col overflow-hidden">
          {/* 顶部预警 Banner（最高优先级）：全部孩子的未读预警，30s 轮询，点击即已读 */}
          <AlertBanner />

          {/* 顶部栏 */}
          <header className="h-16 ...">
```

- [ ] **Step 7: 改造 ParentLayout 测试**

`ParentLayout.test.tsx`：
1. mock 区：`getParentAlerts: vi.fn()` 替换为 `getParentUnreadAlerts: vi.fn()`，并 mock `markParentAlertRead: vi.fn().mockResolvedValue(null)`；
2. `beforeEach` 默认：`getParentUnreadAlertsMock.mockReset().mockResolvedValue({ items: [], total: 0 })`；
3. 删除旧的 7 条 banner 用例（「当前孩子有未读 warning → 渲染」「critical 也渲染」「只有 info 或空 → 不渲染」「请求失败 → 静默」「没有孩子 → 不请求不渲染」「点立即查看 → 跳转」「切孩子后不串号」），替换为以下 4 条（banner 的完整行为钉子在 `AlertBanner.test.tsx`，这里只钉「Layout 真的挂了它」）：

```tsx
  it('Banner：有未读预警 → AlertBanner 渲染（不依赖当前选中孩子）', async () => {
    useParentStudentStore.setState({ studentId: null });
    getParentUnreadAlertsMock.mockResolvedValue({
      items: [
        { id: 1, type: 'idle', level: 'info', message: MESSAGE, studentName: '小刚', createdAt: '2026-09-20T10:00:00.000Z' },
      ],
      total: 1,
    });
    renderLayout();
    expect(await screen.findByText(MESSAGE)).toBeInTheDocument();
  });

  it('Banner：无未读 → 不渲染', async () => {
    renderLayout();
    await waitFor(() => expect(getParentUnreadAlertsMock).toHaveBeenCalled());
    expect(screen.queryByRole('button', { name: '立即查看' })).not.toBeInTheDocument();
  });

  it('Banner：点「立即查看」→ 跳 /parent/alerts 且标已读', async () => {
    getParentUnreadAlertsMock.mockResolvedValue({
      items: [
        { id: 1, type: 'idle', level: 'info', message: MESSAGE, studentName: '小刚', createdAt: '2026-09-20T10:00:00.000Z' },
      ],
      total: 1,
    });
    renderLayout();
    fireEvent.click(await screen.findByRole('button', { name: '立即查看' }));
    expect(await screen.findByText('预警中心页')).toBeInTheDocument();
    await waitFor(() => expect(markParentAlertReadMock).toHaveBeenCalledWith(1));
  });

  it('Banner：请求失败 → 静默不渲染（不占位、不抖动）', async () => {
    getParentUnreadAlertsMock.mockRejectedValue(new Error('net'));
    renderLayout();
    await waitFor(() => expect(getParentUnreadAlertsMock).toHaveBeenCalled());
    expect(screen.queryByRole('button', { name: '立即查看' })).not.toBeInTheDocument();
  });
```

（`fireEvent` 若该文件尚未 import 则补；`MESSAGE` 常量与 `alertItem`/`page` 辅助函数若不再被引用则删除。）

- [ ] **Step 8: 跑 Layout 测试 + 类型检查**

Run: `cd apps/web && npx vitest run src/components/layout/ParentLayout.test.tsx && npx tsc -b`
Expected: PASS / 无错误。

- [ ] **Step 9: Commit**

```bash
git add apps/web/src/components/layout/ParentLayout.tsx apps/web/src/components/layout/ParentLayout.test.tsx
git commit -m "feat(web): ParentLayout 挂 AlertBanner 替换旧 banner（全孩子/含 info/轮询，Task 6）"
```

---

### Task 7: 文档同步 + 全量验证

**Files:**
- Modify: `docs/API接口与数据流设计文档.md`（§4 端点清单 + §6.28）
- Modify: `docs/api/openapi.yaml`
- Modify: `CLAUDE.md`（「家长端『管得住』批」段的走神条目）
- Modify: `docs/ai-core-changelog.md`（新条目）

- [ ] **Step 1: API 设计文档**

§4 端点清单的 parent 段加一行（对齐既有行的格式）：

```markdown
| GET | `/parent/alerts/unread` | 家长 | 未读预警轮询（Banner 用；自带 closeStale 补判） | `{ items: [{ id, type, level, message, studentName, createdAt }], total }`，items 截最新 5 条 | MVP |
```

§6.28 **先修订旧口径**（评审补充，2026-09-20）：第 4 条里「家长的 `alert_idle_minutes` 只从 `hidden_since` 起算——两者**相加**才是家长感知的报警延迟（默认档 15 分钟 ⇒ 约 17 分钟）」这句必须改写为新口径（`alert_idle_minutes` 即字面语义，服务端补 120s 检测窗口；阈值 ≤ 2 分钟时生效值约 2 分钟），否则与追加的新小节自相矛盾。然后再追加小节：

```markdown
### 走神预警「及时可见」批变更（2026-09-20）

1. **idle 口径改字面语义**：`alert_idle_minutes` 现在从**最后一次操作**起算（服务端对
   `hidden_since` 补 120s 前端检测窗口，`CLIENT_IDLE_DETECTION_SECONDS`）。已知边界：
   阈值 ≤ 2 分钟时 idle 实际生效值约为 2 分钟（检测窗口即下限）。`away` 不变（离开时刻起算）。
2. **closeStale 补判**：惰性收尾时对被关会话里 `client_state='hidden'` 的段补判阈值——
   覆盖「学生端后台 tab 被浏览器冻结 / 关闭时 end fetch 丢失 → 心跳全断」的漏报盲区。
3. **新端点 `GET /parent/alerts/unread`**：家长端 Banner 每 30s 轮询；服务端先对名下
   全部孩子跑 `closeStale`（补判，失败只 warn）再返回未读（`unreadOnly`，最新 5 条 + 总数）。
   Banner 交互：点击即已读（逐条 `PATCH /parent/alerts/:id/read`）+ 跳预警中心。
```

- [ ] **Step 2: openapi.yaml**

在 `GET /parent/alerts` 的 path 定义之后（同级缩进）加：

```yaml
  /parent/alerts/unread:
    get:
      summary: 未读预警轮询（家长端 Banner）
      description: |
        家长端 Banner 每 30s 轮询一次。服务端先对名下全部孩子执行 closeStale
        （补判走神阈值；失败只 warn，不影响响应），再返回未读预警（最新 5 条 + 总数）。
        与 GET /parent/alerts 的区别：不分页、不看单个孩子、只返回 banner 展示字段。
      tags: [parent]
      security:
        - bearerAuth: []
      responses:
        '200':
          description: 空结果是正常态（items: [] / total: 0）
          content:
            application/json:
              schema:
                type: object
                required: [items, total]
                properties:
                  items:
                    type: array
                    maxItems: 5
                    items:
                      type: object
                      required: [id, type, level, message, studentName, createdAt]
                      properties:
                        id: { type: integer }
                        type: { type: string }
                        level: { type: string, enum: [info, warning, critical] }
                        message: { type: string }
                        studentName: { type: [string, 'null'] }
                        createdAt: { type: string, format: date-time }
                  total: { type: integer }
```

（`tags`/`security` 写法对齐该文件既有 `/parent/alerts` 定义；若文件里 bearerAuth 引用名不同，照既有写法。）

**评审补充（2026-09-20）**：`Controls` schema 的 `alertIdleMinutes` 字段 description 里也留着旧口径（「两者相加才是家长感知的报警延迟」），必须同批改写为新口径（字面语义 + 阈值 ≤ 2 分钟生效值约 2 分钟的边界），与本节 §6.28 的修订一致。

- [ ] **Step 3: CLAUDE.md**

「家长端『管得住』批」段落里找到走神条目（「**走神两个『分钟数』不是一回事**」那条），替换为：

```markdown
- **走神预警「及时可见」批（2026-09-20）**：① idle 阈值已是**字面语义**（从最后一次操作起算；服务端 `CLIENT_IDLE_DETECTION_SECONDS = 120` 镜像前端 `IDLE_TIMEOUT_MS`，**改一处必须同步另一处**）；② 心跳全断的会话（后台 tab 冻结 / end 丢失）由 **`closeStale` 补判**兜底——判定时机现在是**心跳、end、closeStale 三处**；③ 家长端 Banner = `AlertBanner`（`ParentLayout` 顶部、30s 轮询 `GET /parent/alerts/unread`、**点击即已读**、覆盖全部孩子**含 info 级**——上一批「info 只进列表页」的 banner 裁决已被本批推翻，预警列表页行为不变）。`study_sessions` 的 `hidden_*` 四列仍**不参与**学习时长口径；`UPDATE ... SET` 列顺序承重的铁律不变。
```

- [ ] **Step 4: changelog**

`docs/ai-core-changelog.md` 顶部加一条日期条目：背景（1 小时实测无感知的复盘：会话 13 心跳全断 → away 永不判；alerts 25/26 其实已落库但无任何推送面）、本批四项改动、验证结果。

- [ ] **Step 5: 全量回归**

Run: `cd apps/server && npm test`
Expected: 全部 PASS（103+ 文件）。

Run: `cd apps/web && npm test`
Expected: 全部 PASS（72+ 文件）。

Run: `cd apps/web && npm run build`
Expected: 构建成功。

- [ ] **Step 6: 端到端手工验证（真浏览器）**

1. `services.sh` 或 dev 起前后端；
2. 学生端（lc1/123456）进任意学习页 → 切走 tab；
3. 家长端另一浏览器登录 → 停留在任意家长页（如 `/parent/controls`）；
4. Expected：~2 分钟后（away 阈值 2 分钟）顶部出现橙色 Banner；点击 → 跳预警中心、Banner 消失、该预警变为已读。

- [ ] **Step 7: Commit**

```bash
git add docs/API接口与数据流设计文档.md docs/api/openapi.yaml CLAUDE.md docs/ai-core-changelog.md
git commit -m "docs: 同步走神预警「及时可见」批（新端点、idle 字面语义、补判、banner）"
```

---

## 自查记录（写计划时已核对）

1. **Spec 覆盖**：§3.1→Task 1+3；§3.2→Task 2；§3.3→Task 4；§3.4→Task 5+6；§5 文档清单→Task 7；§4 测试→各任务 TDD 步骤。无遗漏。
2. **占位符**：无 TBD/「适当处理」类表述；所有代码步骤给出完整代码。
3. **类型一致性**：`CloseStaleResult`（Task 1 定义）与 `makeRepo` 默认 mock（Task 1 Step 5）、Task 3 消费一致；`ParentUnreadAlerts` 在服务端 DTO（Task 4）与前端 api.ts（Task 5）字段一致（`createdAt` 服务端 Date / 前端 string，与既有 `ParentAlertItem` 同样的传输约定）。
