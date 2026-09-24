# PC App 学习管控（1/3）：后端与数据层 — 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 落地「一次学习会话」的记录与「单次学习锁定」的服务端能力：`controls` 列改名、两张新表、`device-control` 模块的 5 个新端点、`controls` 扩展与 `today-usage` 收缩，并同步 API 契约。

**Architecture:** 新建 `apps/server/src/modules/device-control/`（学生端 3 端点 + 家长端 2 端点）。会话的「一个学生同时只有一个进行中」由 **DB 层条件式 VIRTUAL 生成列 + 唯一键**保证，不靠 check-then-insert。管控状态**不复用埋点表** `study_sessions`。

**Tech Stack:** NestJS + TypeScript ESM（`.js` 后缀导入）+ mysql2/promise + Zod + Vitest + MySQL 8/9。

## Global Constraints

- **不使用 emoji**；任何图标用线性 SVG。
- **控制器不手工包 `{code, message, data}`** —— 全局 `ResponseInterceptor` 统一包；controller 直接返回 service 结果。
- **越界一律拒绝，不静默钳制**：参数越界给 400/1001（`BadRequestException`）或 409/1001（`ConflictException`），**不要** clamp 到边界。
- **业务错误码**：入参不合法 `1001`；学生不存在 `1002`；无权操作该学生 `1005`。
- **测试与文档同步铁律**：测试断言与 config / types / 设计文档冲突时**测试错** —— 改测试，不改设计文档。
- **迁移必须幂等**，手工 apply（本仓无迁移运行器）；新建的表/列**同时**写进 `tools/db/schema.sql`。
- **`updated_at` 一律列级** `ON UPDATE CURRENT_TIMESTAMP(3)`，**不建触发器**。
- **生成列必须 VIRTUAL，不能 STORED**（STORED 要重建整表，会被外键以 ERROR 1215 挡住）；**验证生成列必须用真表**，临时表没有外键会得假阳性。
- **`@Post` 默认返回 201**。本设计唯一的例外是 §5.1 的取或建端点，它显式 `@HttpCode(200)`。
- **不用 WebSocket**（2026-09-21 用户裁决），全部走 HTTP。
- **时间戳格式**：本模块对外一律 ISO 8601 字符串（`Date.prototype.toISOString()`），`null` 原样返回 `null`。

> **本计划对应**：`docs/superpowers/specs/2026-09-23-pc-app-study-lockdown-design.md` §4、§5、§9（API 契约部分）。
> **后续计划**：`…-2-client-lock-and-shell.md`（学生端锁定与 Electron 壳）、`…-3-parent-ui-and-docs.md`（家长端 UI 与文档收尾）。

---

## 文件结构

| 文件 | 责任 |
|---|---|
| `tools/db/migrations/2026-09-23_learning_sessions_and_session_lock.sql` | 改名列 + 两张新表（幂等） |
| `tools/db/schema.sql` | 同步列名与两表（**改，不新建全量脚本**） |
| `apps/server/src/database/repositories/controls.repo.ts` | `findDailyTimeLimit` → `findSessionLockMinutes`；白名单加锁定时长列 |
| `apps/server/src/modules/parent-insights/controls.service.ts` | 锁定时长的范围校验（1..480，允许 `null`） |
| `apps/server/src/modules/parent-insights/dto/parent-insights.dto.ts` | `ParentControls` 加 `sessionLockMinutes`；`TodayUsageSummary` 收缩 |
| `apps/server/src/modules/parent-insights/parent-insights.controller.ts` | `ControlsPatchSchema` 加字段 |
| `apps/server/src/modules/parent-insights/study-time.service.ts` | `getTodayUsage` 收缩，摘掉 `ControlsRepository` 依赖 |
| `apps/server/src/database/repositories/learning-sessions.repo.ts` | **新建**：会话 CRUD + 轮询事务 |
| `apps/server/src/database/repositories/device-commands.repo.ts` | **新建**：命令插入（消费在会话 repo 的事务里，见 Task 7） |
| `apps/server/src/modules/device-control/learning-sessions.service.ts` | **新建**：取或建 / 结束 / 轮询编排 |
| `apps/server/src/modules/device-control/device-commands.service.ts` | **新建**：家长下发命令 |
| `apps/server/src/modules/device-control/dto/device-control.dto.ts` | **新建**：本模块所有响应类型 |
| `apps/server/src/modules/device-control/device-control.controller.ts` | **新建**：学生端 3 端点 |
| `apps/server/src/modules/device-control/device-control-parent.controller.ts` | **新建**：家长端 2 端点 |
| `apps/server/src/modules/device-control/device-control.module.ts` | **新建**：模块装配 |
| `apps/server/src/app.module.ts` | 注册 `DeviceControlModule` |
| `docs/API接口与数据流设计文档.md` + `docs/api/openapi.yaml` | 契约同步（Task 10） |

**为什么把家长端两个端点也放进 `device-control` 而不是 `parent-insights`**：`CLAUDE.md` 硬规则——学情四页是**只读实时聚合**，「**不要往这四个端点里加写入逻辑**」。`POST device-commands` 是写，放进去会破坏该模块边界。`controls` 的字段扩展则**留在 `parent-insights`**（那是 `controls` 表本来的家）。

---

## Task 1: 数据库迁移与 schema 同步

**Files:**
- Create: `tools/db/migrations/2026-09-23_learning_sessions_and_session_lock.sql`
- Modify: `tools/db/schema.sql:866`（列改名）、`:881` 之后（插入两表）

**Interfaces:**
- Produces: 表 `learning_sessions`（列 `id, student_id, app_shell, started_at, last_seen_at, ended_at, lock_minutes, lock_expires_at, unlocked_at, unlocked_by_parent_id, active_student_id(VIRTUAL), created_at, updated_at`）、表 `device_commands`（列 `id, student_id, command, status, issued_by_parent_id, created_at, consumed_at`）、列 `controls.session_lock_minutes`

- [ ] **Step 1: 写迁移文件**

创建 `tools/db/migrations/2026-09-23_learning_sessions_and_session_lock.sql`：

```sql
-- 日期：2026-09-23 主旨：PC App 学习管控 —— controls 改名列 + learning_sessions / device_commands 两表
-- 设计：docs/superpowers/specs/2026-09-23-pc-app-study-lockdown-design.md §4
--
-- 做什么：
--   1. controls.daily_time_limit_minutes 改名为 session_lock_minutes。语义从「每日累计上限」
--      改成「单次登录起算的禁登出窗口」，列名必须跟着变 —— 名字继续叫 daily 就是在撒谎。
--      （该列实测恒为 NULL：读侧已接、写侧从未实现，所以改名不丢数据。）
--   2. 新建 learning_sessions：一次学生登录 → 退出的记录，同时是锁定窗口的载体。
--   3. 新建 device_commands：家长 → 学生端的命令队列（本期只有 unlock）。
--
-- 为什么 learning_sessions 要条件式 VIRTUAL 生成列：
--   让「一个学生同时只有一个进行中的学习会话」由 DB 强制，而不是 check-then-insert。
--   客户端重启后再 POST 取或建会撞唯一键 → 服务层回读既有行返回**同一个** lock_expires_at
--   ⇒ 「重启不重置时钟」有了数据库级保证。同款先例：remediation_sets.active_student_id
--   （2026-09-22_remediation_sets_active_unique.sql）。
--   **必须 VIRTUAL 不能 STORED**：STORED 要重建整表，表上的外键会让 ALTER 报 ERROR 1215。
--   ⚠️ 别用临时表验证：临时表没有外键，STORED 在临时表上能过，会得出假阳性。
--
-- 幂等：改名列带 information_schema 守卫；表用 CREATE TABLE IF NOT EXISTS。重复执行无副作用。
-- 回滚：
--   ALTER TABLE controls CHANGE COLUMN session_lock_minutes daily_time_limit_minutes SMALLINT DEFAULT NULL;
--   DROP TABLE device_commands; DROP TABLE learning_sessions;

-- ── 1. controls 改名列（旧列存在且新列不存在才改）──
SET @old_exists := (
  SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'controls'
    AND COLUMN_NAME = 'daily_time_limit_minutes'
);
SET @new_exists := (
  SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'controls'
    AND COLUMN_NAME = 'session_lock_minutes'
);
SET @ddl := IF(@old_exists = 1 AND @new_exists = 0,
  'ALTER TABLE controls CHANGE COLUMN daily_time_limit_minutes session_lock_minutes SMALLINT DEFAULT NULL COMMENT ''单次学习锁定分钟数（1..480）：学生登录起该时间内禁止登出；NULL = 未设锁''',
  'DO 0');
PREPARE stmt FROM @ddl; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- ── 2. learning_sessions ──
CREATE TABLE IF NOT EXISTS learning_sessions (
  id                    BIGINT AUTO_INCREMENT PRIMARY KEY,
  student_id            BIGINT      NOT NULL,
  app_shell             VARCHAR(10) NOT NULL DEFAULT 'electron' COMMENT '复用埋点既有枚举 web|electron；本期只有 electron 写入',
  started_at            DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  last_seen_at          DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) COMMENT '由学生端轮询刷新（轮询兼心跳）；判「在线」的唯一依据',
  ended_at              DATETIME(3) DEFAULT NULL COMMENT 'NULL = 进行中。不设 end_kind：本设计不区分异常退出，结束只有一种语义',
  lock_minutes          SMALLINT    DEFAULT NULL COMMENT '开始时的快照；家长事后改设置不影响本次',
  lock_expires_at       DATETIME(3) DEFAULT NULL,
  unlocked_at           DATETIME(3) DEFAULT NULL,
  unlocked_by_parent_id BIGINT      DEFAULT NULL,
  active_student_id     BIGINT AS (IF(ended_at IS NULL, student_id, NULL)) VIRTUAL COMMENT '生成列（条件式）：仅进行中时等于 student_id，供唯一键实现「每学生至多一个进行中的学习会话」；已结束保持 NULL 不参与唯一性',
  created_at            DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at            DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  KEY idx_lsessions_student_started (student_id, started_at),
  UNIQUE KEY uniq_lsessions_active (active_student_id),
  CONSTRAINT fk_lsessions_student_id FOREIGN KEY (student_id) REFERENCES students (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ── 3. device_commands ──
-- command 用 VARCHAR + 服务端白名单，不用 ENUM：单取值的 ENUM 就是死枚举，将来加命令要改 schema。
CREATE TABLE IF NOT EXISTS device_commands (
  id                  BIGINT AUTO_INCREMENT PRIMARY KEY,
  student_id          BIGINT      NOT NULL,
  command             VARCHAR(20) NOT NULL COMMENT '服务端白名单，本期 [''unlock'']',
  status              VARCHAR(10) NOT NULL DEFAULT 'pending' COMMENT 'pending | consumed | expired',
  issued_by_parent_id BIGINT      NOT NULL,
  created_at          DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  consumed_at         DATETIME(3) DEFAULT NULL,
  KEY idx_dcommands_pending (student_id, status, created_at),
  CONSTRAINT fk_dcommands_student_id FOREIGN KEY (student_id) REFERENCES students (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
```

- [ ] **Step 2: 同步 `tools/db/schema.sql`**

把 `tools/db/schema.sql:866` 的

```sql
  daily_time_limit_minutes SMALLINT DEFAULT NULL,
```

改为

```sql
  session_lock_minutes SMALLINT DEFAULT NULL COMMENT '单次学习锁定分钟数（1..480）：学生登录起该时间内禁止登出；NULL = 未设锁',
```

并在 `controls` 表定义结束（`schema.sql:881` 的 `) ENGINE=InnoDB …;`）之后，追加 Step 1 里第 2、3 节的两条 `CREATE TABLE IF NOT EXISTS`（**原样复制**，含注释）。

- [ ] **Step 3: 应用迁移（第一次）**

Run:
```bash
mysql -h127.0.0.1 -uai_k12 -pai_k12 ai_k12 < tools/db/migrations/2026-09-23_learning_sessions_and_session_lock.sql
```
Expected: 无输出、退出码 0。若报 `Unknown database` 或拒连，先核对 `apps/server/.env` 的 `DB_*`。

- [ ] **Step 4: 验证结果**

Run:
```bash
mysql -h127.0.0.1 -uai_k12 -pai_k12 ai_k12 --vertical -e "
SELECT COLUMN_NAME, COLUMN_TYPE, EXTRA FROM information_schema.COLUMNS
 WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME='learning_sessions' AND COLUMN_NAME='active_student_id';"
```
Expected: `EXTRA` 含 **`VIRTUAL GENERATED`**（不是 `STORED GENERATED`）。这是本任务最容易出错的一处。

```bash
mysql -h127.0.0.1 -uai_k12 -pai_k12 ai_k12 -e "SHOW INDEX FROM learning_sessions WHERE Key_name='uniq_lsessions_active';"
mysql -h127.0.0.1 -uai_k12 -pai_k12 ai_k12 -e "SHOW COLUMNS FROM controls LIKE 'session_lock_minutes';"
```
Expected: 前者有 1 行 `Non_unique=0`；后者有 1 行。

- [ ] **Step 5: 幂等复验（第二次跑）**

Run:
```bash
mysql -h127.0.0.1 -uai_k12 -pai_k12 ai_k12 < tools/db/migrations/2026-09-23_learning_sessions_and_session_lock.sql
```
Expected: 与第一次一样成功、无报错（守卫生效）。

- [ ] **Step 6: Commit**

```bash
git add tools/db/migrations/2026-09-23_learning_sessions_and_session_lock.sql tools/db/schema.sql
git commit -m "feat(db): controls 列改名 session_lock_minutes + learning_sessions / device_commands 两表"
```

---

## Task 2: `controls.repo.ts` 改名与白名单

**Files:**
- Modify: `apps/server/src/database/repositories/controls.repo.ts`
- Test: `apps/server/src/database/repositories/controls.repo.test.ts`（若不存在则新建；先确认）

**Interfaces:**
- Consumes: `controls.session_lock_minutes`（Task 1）
- Produces:
  - `interface ControlsSnapshot { pointsPerYuan: number; rewardRedemptionEnabled: boolean; alertAwayMinutes: number; alertIdleMinutes: number; sessionLockMinutes: number | null }`
  - `interface ControlsPatch { …; sessionLockMinutes?: number | null }`
  - `findSessionLockMinutes(studentId: number): Promise<number | null>`
  - `update(studentId, patch): Promise<number>`

- [ ] **Step 1: 确认是否已有该 repo 的测试文件**

Run:
```bash
ls apps/server/src/database/repositories/ | grep -i controls
```
Expected: 只有 `controls.repo.ts`（本仓仓储层普遍无单测，业务规则在 service 层测）。**若确实没有**，本任务的测试写在 Task 3 的 service 测试里，跳过本任务的 Step 2–4，直接做 Step 5。

- [ ] **Step 2: 改 `ControlsSnapshot` 与 `ControlsPatch`（若上一步判定需要测）**

在 `apps/server/src/database/repositories/controls.repo.ts` 的 `ControlsSnapshot` 末尾加：

```ts
  /** 单次学习锁定分钟数（1..480）。`null` = 家长未设锁 → 学生可自由登出。 */
  sessionLockMinutes: number | null;
```

在 `ControlsPatch` 末尾加：

```ts
  /** `null` 是合法值（= 解除设置），不是「不动」；「不动」用 `undefined`。 */
  sessionLockMinutes?: number | null;
```

- [ ] **Step 3: 改名 `findDailyTimeLimit` → `findSessionLockMinutes` 并重写注释**

把 `controls.repo.ts:111-131` 整段（含 docblock）替换为：

```ts
  /**
   * 读单次学习锁定分钟数。**无行 / 列为 NULL → 返回 null**（= 未设锁，学生可自由登出）。
   *
   * 不复用 `findByStudent`：那个方法的本职是兑换 + 预警四列，而本方法跑在**学生登录**
   * 这条路径上（`POST /api/student/learning-sessions`），只取一个列。和 `findAlertThresholds`
   * 同一个形态。
   *
   * 语义：这是个**单次登录起算的墙钟窗口**（1..480 分钟），不是每日累计。到点自动解除，
   * 家长也可随时用 `device_commands` 的 `unlock` 提前解除。列名由 2026-09-23 迁移从
   * `daily_time_limit_minutes` 改来——旧名字和旧语义已在同一批改动中废除。
   */
  async findSessionLockMinutes(studentId: number): Promise<number | null> {
    const [rows] = await this.pool.execute<
      (RowDataPacket & { session_lock_minutes: number | null })[]
    >(
      `SELECT session_lock_minutes FROM controls WHERE student_id = ? LIMIT 1`,
      [studentId],
    );
    const value = rows[0]?.session_lock_minutes;
    return value === null || value === undefined ? null : Number(value);
  }
```

- [ ] **Step 4: `findByStudent` 带上新列**

把 `controls.repo.ts:63-83` 的 SELECT 与返回对象改为：

```ts
  async findByStudent(studentId: number): Promise<ControlsSnapshot> {
    const [rows] = await this.pool.execute<
      (RowDataPacket & {
        points_per_yuan: number;
        reward_redemption_enabled: number;
        alert_away_minutes: number;
        alert_idle_minutes: number;
        session_lock_minutes: number | null;
      })[]
    >(
      `SELECT points_per_yuan, reward_redemption_enabled, alert_away_minutes, alert_idle_minutes, session_lock_minutes
       FROM controls WHERE student_id = ? LIMIT 1`,
      [studentId],
    );
    const row = rows[0];
    return {
      pointsPerYuan: Number(row?.points_per_yuan ?? 20),
      rewardRedemptionEnabled: Number(row?.reward_redemption_enabled ?? 1) === 1,
      alertAwayMinutes: Number(row?.alert_away_minutes ?? 5),
      alertIdleMinutes: Number(row?.alert_idle_minutes ?? 15),
      // 缺失/无行 → null（= 未设锁），**不是** 0：0 不是合法锁定时长（下限 1），
      // 拿 0 兜底会让「没设」和「设成 0」混淆，而后者根本不允许存在。
      sessionLockMinutes:
        row?.session_lock_minutes === null || row?.session_lock_minutes === undefined
          ? null
          : Number(row.session_lock_minutes),
    };
  }
```

- [ ] **Step 5: `update()` 白名单加新列（注意参数数组要能装 `null`）**

把 `controls.repo.ts:141-168` 的 `update` 改为：

```ts
  async update(studentId: number, patch: ControlsPatch): Promise<number> {
    const sets: string[] = [];
    // 允许 null（= 清空锁定时长），所以参数类型从 Array<number|string> 放宽。
    const params: Array<number | string | null> = [];
    if (patch.pointsPerYuan !== undefined) {
      sets.push('points_per_yuan = ?');
      params.push(patch.pointsPerYuan);
    }
    if (patch.rewardRedemptionEnabled !== undefined) {
      sets.push('reward_redemption_enabled = ?');
      params.push(patch.rewardRedemptionEnabled ? 1 : 0);
    }
    if (patch.alertAwayMinutes !== undefined) {
      sets.push('alert_away_minutes = ?');
      params.push(patch.alertAwayMinutes);
    }
    if (patch.alertIdleMinutes !== undefined) {
      sets.push('alert_idle_minutes = ?');
      params.push(patch.alertIdleMinutes);
    }
    if (patch.sessionLockMinutes !== undefined) {
      sets.push('session_lock_minutes = ?');
      params.push(patch.sessionLockMinutes);
    }
    if (sets.length === 0) return 0;

    params.push(studentId);
    const [result] = await this.pool.execute<ResultSetHeader>(
      `UPDATE controls SET ${sets.join(', ')} WHERE student_id = ?`,
      params,
    );
    return result.affectedRows;
  }
```

- [ ] **Step 6: 复验已无 `findDailyTimeLimit` 引用**

Run:
```bash
cd apps/server && grep -rn "findDailyTimeLimit\|daily_time_limit" src/ || echo "NO REFERENCES"
```
Expected: `NO REFERENCES`。**若还有引用**（`study-time.service.ts:61` 一定有），本任务先不 commit，做完 Task 4 再一起提交——两处必须同时改，否则 server 编译不过。

- [ ] **Step 7: Commit（与 Task 3、Task 4 合并提交亦可）**

```bash
git add apps/server/src/database/repositories/controls.repo.ts
git commit -m "refactor(controls): findDailyTimeLimit 改为 findSessionLockMinutes，白名单加锁定时长列"
```

---

## Task 3: `sessionLockMinutes` 暴露给家长端（service + controller + DTO）

**Files:**
- Modify: `apps/server/src/modules/parent-insights/dto/parent-insights.dto.ts`
- Modify: `apps/server/src/modules/parent-insights/controls.service.ts`
- Modify: `apps/server/src/modules/parent-insights/parent-insights.controller.ts:82-92`
- Test: `apps/server/src/modules/parent-insights/controls.service.test.ts`、`apps/server/src/modules/parent-insights/parent-insights.controller.test.ts`

**Interfaces:**
- Consumes: `ControlsSnapshot.sessionLockMinutes`、`ControlsPatch.sessionLockMinutes`（Task 2）
- Produces:
  - `export interface ParentControls { alertAwayMinutes: number; alertIdleMinutes: number; sessionLockMinutes: number | null }`
  - `export const SESSION_LOCK_MINUTES_MIN = 1` / `SESSION_LOCK_MINUTES_MAX = 480`
  - `export interface ControlsUpdatePatch { alertAwayMinutes?: number; alertIdleMinutes?: number; sessionLockMinutes?: number | null }`

- [ ] **Step 1: 写失败的测试（service 层）**

在 `apps/server/src/modules/parent-insights/controls.service.test.ts` 的 `SNAPSHOT` 常量里加一行、并新增用例：

```ts
const SNAPSHOT = {
  pointsPerYuan: 20,
  rewardRedemptionEnabled: true,
  alertAwayMinutes: 3,
  alertIdleMinutes: 22,
  sessionLockMinutes: 60,
};
```

```ts
describe('ControlsService：单次学习锁定（spec §5.6）', () => {
  it('get 回读时带上 sessionLockMinutes', async () => {
    const repo = mkRepo();
    const out = await mkSvc(repo).get(11);
    expect(out.sessionLockMinutes).toBe(60);
  });

  it('未设锁 → sessionLockMinutes 为 null（不是 0）', async () => {
    const repo = mkRepo();
    (repo.findByStudent as any).mockResolvedValue({ ...SNAPSHOT, sessionLockMinutes: null });
    expect((await mkSvc(repo).get(11)).sessionLockMinutes).toBeNull();
  });

  it('update 接受 null（= 解除设置），并真的写库', async () => {
    const repo = mkRepo();
    await mkSvc(repo).update(11, { sessionLockMinutes: null });
    expect(repo.update).toHaveBeenCalledWith(11, { sessionLockMinutes: null });
  });

  it.each([0, 481, -1, 1.5, Number.NaN])('update 拒绝越界值 %s（409/1001，不写库）', async (bad) => {
    const repo = mkRepo();
    await expect(mkSvc(repo).update(11, { sessionLockMinutes: bad as number })).rejects.toMatchObject({
      status: 409,
      response: { code: 1001 },
    });
    expect(repo.update).not.toHaveBeenCalled();
  });

  it('只给 sessionLockMinutes 也算「有字段」（不能报「没有要更新的字段」）', async () => {
    const repo = mkRepo();
    await expect(mkSvc(repo).update(11, { sessionLockMinutes: 30 })).resolves.toBeDefined();
  });
});
```

同时把原有那条 `expect(Object.keys(out).sort()).toEqual(['alertAwayMinutes', 'alertIdleMinutes'])` 改为：

```ts
    expect(Object.keys(out).sort()).toEqual([
      'alertAwayMinutes',
      'alertIdleMinutes',
      'sessionLockMinutes',
    ]);
```

- [ ] **Step 2: 跑测试，确认失败**

Run:
```bash
cd apps/server && npx vitest run src/modules/parent-insights/controls.service.test.ts
```
Expected: FAIL —— `out.sessionLockMinutes` 为 `undefined`、越界值未被拒绝。

- [ ] **Step 3: 实现 `controls.service.ts`**

把 `controls.service.ts` 顶部常量与接口改为：

```ts
/** 预警灵敏度可调范围（spec §4.2）：1..180 分钟。 */
export const ALERT_MINUTES_MIN = 1;
export const ALERT_MINUTES_MAX = 180;

/**
 * 单次学习锁定可调范围（spec §5.6）：1..480 分钟（8 小时）。
 *
 * 上限取 480 的理由：覆盖长时段自习；代价是「设 480 + 断网」会让最长 8 小时无法登出——
 * 这是**有意的严格性**（拔网线不解锁，否则等于白送逃逸通道），必须在家长端文案里说清。
 */
export const SESSION_LOCK_MINUTES_MIN = 1;
export const SESSION_LOCK_MINUTES_MAX = 480;

/** 本端点认这三个字段；兑换汇率/开关归 `PUT .../points/settings`，不在这里。 */
export interface ControlsUpdatePatch {
  alertAwayMinutes?: number;
  alertIdleMinutes?: number;
  /** `null` = 解除设置（合法值）；`undefined` = 不动。 */
  sessionLockMinutes?: number | null;
}
```

把 `update` 的「至少一个字段」判断与校验循环改为：

```ts
  async update(studentId: number, patch: ControlsUpdatePatch): Promise<ParentControls> {
    if (
      patch.alertAwayMinutes === undefined &&
      patch.alertIdleMinutes === undefined &&
      patch.sessionLockMinutes === undefined
    ) {
      throw new ConflictException({ code: 1001, message: '没有要更新的字段' });
    }
    const alertEntries: Array<[string, number | undefined]> = [
      ['alertAwayMinutes', patch.alertAwayMinutes],
      ['alertIdleMinutes', patch.alertIdleMinutes],
    ];
    for (const [name, value] of alertEntries) {
      if (value === undefined) continue;
      if (!Number.isInteger(value) || value < ALERT_MINUTES_MIN || value > ALERT_MINUTES_MAX) {
        throw new ConflictException({
          code: 1001,
          message: `${name} 必须是 ${ALERT_MINUTES_MIN}-${ALERT_MINUTES_MAX} 的整数（收到 ${value}）`,
        });
      }
    }
    // null 是合法值（解除设置），只在非 null 时校验范围。
    if (patch.sessionLockMinutes !== undefined && patch.sessionLockMinutes !== null) {
      const value = patch.sessionLockMinutes;
      if (
        !Number.isInteger(value) ||
        value < SESSION_LOCK_MINUTES_MIN ||
        value > SESSION_LOCK_MINUTES_MAX
      ) {
        throw new ConflictException({
          code: 1001,
          message: `sessionLockMinutes 必须是 ${SESSION_LOCK_MINUTES_MIN}-${SESSION_LOCK_MINUTES_MAX} 的整数或 null（收到 ${value}）`,
        });
      }
    }

    await this.controlsRepo.ensure(studentId);
    await this.controlsRepo.update(studentId, patch);
    return this.snapshot(studentId);
  }
```

把 `snapshot` 改为：

```ts
  /** 只取这三个字段（`findByStudent` 的兑换两列在此丢弃，勿透传）。 */
  private async snapshot(studentId: number): Promise<ParentControls> {
    const controls = await this.controlsRepo.findByStudent(studentId);
    return {
      alertAwayMinutes: controls.alertAwayMinutes,
      alertIdleMinutes: controls.alertIdleMinutes,
      sessionLockMinutes: controls.sessionLockMinutes,
    };
  }
```

并更新类级 docblock 里「响应**只含两个阈值**」那句为「响应含**预警两个阈值 + 单次学习锁定分钟数**；兑换汇率/开关仍不在此」。

- [ ] **Step 4: 实现 DTO 与 controller schema**

`apps/server/src/modules/parent-insights/dto/parent-insights.dto.ts` 的 `ParentControls`：

```ts
/**
 * 行为管控（spec §4.1/§4.2/§5.6）。
 * **不含兑换状态**：奖励兑换归 `GET .../points/settings`，同一字段不许两个归属。
 */
export interface ParentControls {
  alertAwayMinutes: number;
  alertIdleMinutes: number;
  /** 单次学习锁定分钟数（1..480）；`null` = 未设锁（学生可自由登出）。 */
  sessionLockMinutes: number | null;
}
```

`parent-insights.controller.ts:89-92` 的 `ControlsPatchSchema` 改为：

```ts
const ControlsPatchSchema = z.object({
  alertAwayMinutes: z.number().int().min(1).max(180).optional(),
  alertIdleMinutes: z.number().int().min(1).max(180).optional(),
  // null 必须显式允许（解除设置），故用 .nullable() 而不是 .nullish()——
  // nullish 会让 undefined 也通过，虽然语义上等价，但显式写更清楚。
  sessionLockMinutes: z.number().int().min(1).max(480).nullable().optional(),
});
```

⚠️ **范围必须在两处都有**（controller 的 Zod 是 400/409 的第一道、service 是最后一道）——这是该端点既有设计，别只留一处。

- [ ] **Step 5: 跑测试**

Run:
```bash
cd apps/server && npx vitest run src/modules/parent-insights/controls.service.test.ts src/modules/parent-insights/parent-insights.controller.test.ts
```
Expected: PASS。`parent-insights.controller.test.ts` 里 `makeController` 的 controls mock 若断言了返回字段，一并补 `sessionLockMinutes`。

- [ ] **Step 6: Commit**

```bash
git add apps/server/src/modules/parent-insights/ apps/server/src/database/repositories/controls.repo.ts
git commit -m "feat(parent-controls): 行为管控暴露 sessionLockMinutes（1..480，允许 null）"
```

---

## Task 4: `today-usage` 收缩（废除每日上限）

**Files:**
- Modify: `apps/server/src/modules/parent-insights/study-time.service.ts:48-72`（并删掉 `ControlsRepository` 注入）
- Modify: `apps/server/src/modules/parent-insights/dto/parent-insights.dto.ts`（`TodayUsageSummary`）
- Modify: `apps/server/src/modules/parent-insights/parent-insights.module.ts`（`StudyTimeService` 依赖变了，`ControlsRepository` 仍需为 `ControlsService` 保留）
- Test: `apps/server/src/modules/parent-insights/study-time.service.test.ts`

**Interfaces:**
- Produces: `export interface TodayUsageSummary { date: string; activeSeconds: number; byModule: Array<{ module: string; seconds: number }> }`
- Consumes: 无（本任务**移除**对 `ControlsRepository.findDailyTimeLimit` 的依赖）

- [ ] **Step 1: 改测试（先让旧的期望失败）**

`study-time.service.test.ts`：把 `makeControls` 与三参构造全部改掉。整体替换这两处：

```ts
const makeSessions = () =>
  ({ closeStale: vi.fn().mockResolvedValue({ closedCount: 0, hidden: [] }) } as unknown as StudySessionsService);
```

并把所有 `new StudyTimeService(repo, makeControls(null), makeSessions())` 改为 `new StudyTimeService(repo, makeSessions())`，删除 `makeControls` 定义与 `import type { ControlsRepository }`。

把整个 `describe('StudyTimeService.getTodayUsage')` 替换为：

```ts
describe('StudyTimeService.getTodayUsage（spec §5.7：每日上限概念已废除）', () => {
  it('只回 date / activeSeconds / byModule —— 不再有 limitMinutes 与 exceeded', async () => {
    const service = new StudyTimeService(makeRepo(), makeSessions());
    const out = await service.getTodayUsage(9);
    expect(Object.keys(out).sort()).toEqual(['activeSeconds', 'byModule', 'date']);
    expect(out.activeSeconds).toBe(3661);
    expect(out.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(out.byModule).toEqual([{ module: 'en_vocabulary', seconds: 600 }]);
  });

  it('今日已用只取**单日**窗口（今天 00:00 → 次日 00:00），不是近 7 天', async () => {
    const repo = makeRepo();
    const service = new StudyTimeService(repo, makeSessions());
    await service.getTodayUsage(9);

    const [, from, toExclusive] = (repo.getStudyTimeTotal as any).mock.calls[0];
    expect(from.getHours()).toBe(0);
    expect(from.getMinutes()).toBe(0);
    expect(from.getSeconds()).toBe(0);
    expect((toExclusive.getTime() - from.getTime()) / 3_600_000).toBe(24);
  });
});
```

- [ ] **Step 2: 跑测试，确认失败**

Run:
```bash
cd apps/server && npx vitest run src/modules/parent-insights/study-time.service.test.ts
```
Expected: FAIL —— 构造参数个数不符 / `limitMinutes` 仍存在。

- [ ] **Step 3: 改 `study-time.service.ts`**

删掉 `import { ControlsRepository } from '../../database/repositories/controls.repo.js';` 与构造函数的第三个参数，把构造改为：

```ts
  constructor(
    @Inject(ParentAnalyticsRepository) private readonly repo: ParentAnalyticsRepository,
    @Inject(StudySessionsService) private readonly sessions: StudySessionsService,
  ) {}
```

把 `getTodayUsage` 整体替换为：

```ts
  /**
   * 今日已用时长（spec §8.2，2026-09-23 收缩）。
   *
   * **不再返回 `limitMinutes` / `exceeded`**：`controls.daily_time_limit_minutes` 已在
   * 2026-09-23 改名 `session_lock_minutes` 并改成「单次登录起算的禁登出窗口」，
   * 「每日累计上限」这个概念不存在了。留着这两个字段就是撒谎——家长会以为还有每日上限。
   * 想看孩子今天用了多久，看 `activeSeconds`；想限制，用「单次学习锁定」。
   */
  async getTodayUsage(studentId: number): Promise<TodayUsageSummary> {
    const today = toDayString(startOfDaysAgo(0));
    const window = resolveRange(today, today);
    await this.closeStaleQuietly(studentId);

    const [activeSeconds, byModule] = await Promise.all([
      this.repo.getStudyTimeTotal(studentId, window.start, window.endExclusive),
      this.repo.getStudyTimeByModule(studentId, window.start, window.endExclusive),
    ]);

    return { date: today, activeSeconds, byModule };
  }
```

- [ ] **Step 4: 改 DTO**

`parent-insights.dto.ts` 的 `TodayUsageSummary` 替换为：

```ts
/**
 * 今日已用时长（spec §8.2，2026-09-23 收缩）。
 * **不含上下限对比**：「每日累计上限」概念已废除，限制改由「单次学习锁定」承担（spec §5.6）。
 */
export interface TodayUsageSummary {
  date: string;
  activeSeconds: number;
  byModule: Array<{ module: string; seconds: number }>;
}
```

- [ ] **Step 5: 跑全量 server 测试与编译**

Run:
```bash
cd apps/server && npm test && npx tsc --noEmit
```
Expected: 全绿、tsc 无输出。若 `parent-insights.module.ts` 报依赖解析错误，检查 `StudyTimeService` 是否已不再需要第三个 provider（`ControlsRepository` 仍要保留——`ControlsService` 在用）。

- [ ] **Step 6: Commit**

```bash
git add apps/server/src/modules/parent-insights/
git commit -m "refactor(parent-insights): today-usage 收缩，移除每日上限的 limitMinutes/exceeded"
```

---

## Task 5: `device-control` 模块 + 会话仓储 + 学生端「取或建」

**Files:**
- Create: `apps/server/src/database/repositories/learning-sessions.repo.ts`
- Create: `apps/server/src/modules/device-control/dto/device-control.dto.ts`
- Create: `apps/server/src/modules/device-control/learning-sessions.service.ts`
- Create: `apps/server/src/modules/device-control/device-control.controller.ts`
- Create: `apps/server/src/modules/device-control/device-control.module.ts`
- Modify: `apps/server/src/app.module.ts:53` 之后
- Test: `apps/server/src/modules/device-control/learning-sessions.service.test.ts`、`apps/server/src/modules/device-control/device-control.controller.test.ts`

**Interfaces:**
- Consumes: `ControlsRepository.findSessionLockMinutes`（Task 2）、`controls.session_lock_minutes`（Task 1）
- Produces:
  - `export interface LearningSessionRow extends RowDataPacket { id: number; student_id: number; app_shell: string; started_at: Date; last_seen_at: Date; ended_at: Date | null; lock_minutes: number | null; lock_expires_at: Date | null; unlocked_at: Date | null; unlocked_by_parent_id: number | null }`
  - `LearningSessionsRepository.findOpen(studentId): Promise<LearningSessionRow | null>`
  - `LearningSessionsRepository.insertOpen(input: { studentId: number; appShell: string; lockMinutes: number | null }): Promise<LearningSessionRow>`
  - `LearningSessionsRepository.touch(studentId: number): Promise<void>`
  - `LearningSessionsRepository.endById(id: number, studentId: number): Promise<void>`
  - `LearningSessionsRepository.findByIdForStudent(id: number, studentId: number): Promise<LearningSessionRow | null>`
  - `LearningSessionRow → StudentSessionView`（见 DTO）
  - `LearningSessionsService.openOrGet(studentId: number): Promise<StudentSessionView>`

- [ ] **Step 1: 写 DTO 文件**

创建 `apps/server/src/modules/device-control/dto/device-control.dto.ts`：

```ts
/**
 * device-control 模块的对外响应类型（spec `2026-09-23-pc-app-study-lockdown-design.md` §5）。
 * 纯 TypeScript interface，无装饰器；必须与 `docs/api/openapi.yaml` 保持一致。
 */

/** `POST /api/student/learning-sessions` 的响应（spec §5.1）。 */
export interface StudentSessionView {
  id: number;
  startedAt: string;
  /** 开始时的快照；`null` = 本次未设锁。 */
  lockMinutes: number | null;
  lockExpiresAt: string | null;
  unlockedAt: string | null;
}
```

- [ ] **Step 2: 写失败的 service 测试**

创建 `apps/server/src/modules/device-control/learning-sessions.service.test.ts`：

```ts
import { describe, it, expect, vi } from 'vitest';
import { LearningSessionsService } from './learning-sessions.service.js';
import type { LearningSessionsRepository } from '../../database/repositories/learning-sessions.repo.js';
import type { ControlsRepository } from '../../database/repositories/controls.repo.js';

const mkSessionsRepo = () => ({
  findOpen: vi.fn().mockResolvedValue(null),
  insertOpen: vi.fn(),
  touch: vi.fn().mockResolvedValue(undefined),
  endById: vi.fn().mockResolvedValue(undefined),
  findByIdForStudent: vi.fn().mockResolvedValue(null),
});

const mkControlsRepo = (lockMinutes: number | null) =>
  ({ findSessionLockMinutes: vi.fn().mockResolvedValue(lockMinutes) } as unknown as ControlsRepository);

const mkSvc = (
  sessions: ReturnType<typeof mkSessionsRepo>,
  controls: ControlsRepository,
) => new LearningSessionsService(sessions as unknown as LearningSessionsRepository, controls);

const ROW = (over: Record<string, unknown> = {}) => ({
  id: 7,
  student_id: 9,
  app_shell: 'electron',
  started_at: new Date('2026-09-23T01:00:00.000Z'),
  last_seen_at: new Date('2026-09-23T01:00:00.000Z'),
  ended_at: null,
  lock_minutes: 60,
  lock_expires_at: new Date('2026-09-23T02:00:00.000Z'),
  unlocked_at: null,
  unlocked_by_parent_id: null,
  ...over,
});

describe('LearningSessionsService.openOrGet（spec §5.1）', () => {
  it('已有进行中会话 → 原样返回，**不新建、不改 lock_expires_at**（重启不重置时钟）', async () => {
    const sessions = mkSessionsRepo();
    // 关键：这次 findOpen 命中的行，lock_expires_at 是一小时前算好的那个值
    (sessions.findOpen as any).mockResolvedValue(ROW());

    const out = await mkSvc(sessions, mkControlsRepo(60)).openOrGet(9);

    expect(out.id).toBe(7);
    expect(out.lockExpiresAt).toBe('2026-09-23T02:00:00.000Z');
    expect(sessions.insertOpen).not.toHaveBeenCalled();
    // 顺带刷新 last_seen_at（重启也算「还活着」）
    expect(sessions.touch).toHaveBeenCalledWith(9);
  });

  it('无进行中会话 + 家长设了锁 → 新建并快照 lock_minutes', async () => {
    const sessions = mkSessionsRepo();
    (sessions.insertOpen as any).mockResolvedValue(ROW({ lock_expires_at: new Date('2026-09-23T02:00:00.000Z') }));

    const out = await mkSvc(sessions, mkControlsRepo(60)).openOrGet(9);

    expect(sessions.insertOpen).toHaveBeenCalledWith({
      studentId: 9,
      appShell: 'electron',
      lockMinutes: 60,
    });
    expect(out.lockMinutes).toBe(60);
    expect(out.lockExpiresAt).toBe('2026-09-23T02:00:00.000Z');
  });

  it('未设锁 → 新建但 lockMinutes / lockExpiresAt 皆为 null（学生可自由登出）', async () => {
    const sessions = mkSessionsRepo();
    (sessions.insertOpen as any).mockResolvedValue(
      ROW({ lock_minutes: null, lock_expires_at: null }),
    );

    const out = await mkSvc(sessions, mkControlsRepo(null)).openOrGet(9);

    expect(sessions.insertOpen).toHaveBeenCalledWith({
      studentId: 9,
      appShell: 'electron',
      lockMinutes: null,
    });
    expect(out.lockMinutes).toBeNull();
    expect(out.lockExpiresAt).toBeNull();
  });
});
```

- [ ] **Step 3: 跑测试，确认失败**

Run:
```bash
cd apps/server && npx vitest run src/modules/device-control/learning-sessions.service.test.ts
```
Expected: FAIL —— 模块/类不存在。

- [ ] **Step 4: 实现 `learning-sessions.repo.ts`（本步只写 openOrGet 需要的方法）**

创建 `apps/server/src/database/repositories/learning-sessions.repo.ts`：

```ts
import { Injectable, Inject } from '@nestjs/common';
import type { Pool, ResultSetHeader, RowDataPacket } from 'mysql2/promise';

/** `learning_sessions` 一行（spec §4.2）。`ended_at IS NULL` = 进行中。 */
export interface LearningSessionRow extends RowDataPacket {
  id: number;
  student_id: number;
  app_shell: string;
  started_at: Date;
  last_seen_at: Date;
  ended_at: Date | null;
  lock_minutes: number | null;
  lock_expires_at: Date | null;
  unlocked_at: Date | null;
  unlocked_by_parent_id: number | null;
}

export interface InsertOpenInput {
  studentId: number;
  appShell: string;
  lockMinutes: number | null;
}

const SELECT_COLUMNS =
  'id, student_id, app_shell, started_at, last_seen_at, ended_at, lock_minutes, lock_expires_at, unlocked_at, unlocked_by_parent_id';

/** MySQL 唯一键冲突。 */
const ER_DUP_ENTRY = 1062;

/**
 * 一次学习会话（spec §4.2）。
 *
 * 「一个学生同时只有一个进行中的会话」由 **DB 层**唯一键 `uniq_lsessions_active`
 * （条件式 VIRTUAL 生成列 `active_student_id`）保证，**不是** check-then-insert。
 * 因此本仓储的 `insertOpen` 必须处理撞键：回读既有行返回，而不是抛错。
 */
@Injectable()
export class LearningSessionsRepository {
  constructor(@Inject('DATABASE_POOL') private readonly pool: Pool) {}

  /** 找该生**进行中**的会话。无则 null。 */
  async findOpen(studentId: number): Promise<LearningSessionRow | null> {
    const [rows] = await this.pool.execute<LearningSessionRow[]>(
      `SELECT ${SELECT_COLUMNS} FROM learning_sessions
       WHERE student_id = ? AND ended_at IS NULL LIMIT 1`,
      [studentId],
    );
    return rows[0] ?? null;
  }

  /**
   * 新建一条进行中的会话。**撞唯一键（1062）= 已有进行中会话** → 回读并返回那一行。
   *
   * 返回既有行而不是抛错，是「重启不重置时钟」的关键：客户端重启后再调取或建，
   * 会拿到**原来那个** `lock_expires_at`，而不是一个新的一小时。
   *
   * `lock_expires_at` 非 null 时用 SQL 侧 `NOW(3)` 算，避免应用与 DB 时钟不一致。
   *
   * ⚠️ **占位符个数必须恒为 4、与参数数组逐位对应**（2026-09-24 修正）。初稿在未设锁时把
   * 该列拼成字面量 `NULL`，语句只剩 3 个 `?` 却传 2 个参数 → mysql2 的服务端预处理
   * （参数按位置绑定）直接报 `Incorrect arguments to COM_STMT_EXECUTE`。**「未设锁」是绝大多数
   * 学生的默认态**，这条路径一坏整个取或建端点就不可用。四种写法逐一实测后确认：
   * `null` 当参数传（配 `?`）与 `DATE_ADD(NOW(3), INTERVAL ? MINUTE)`（配锁定时长参数）**都可用**，
   * 本机 MySQL 的 `INTERVAL ?` 预处理没有语法问题——所以保留 DB 侧算时钟，只需把 null 走参数。
   */
  async insertOpen(input: InsertOpenInput): Promise<LearningSessionRow> {
    // 未设锁 → 该列就是 NULL；设了锁 → 由 DB 侧时钟算，避免应用与 DB 时钟不一致。
    const expiresFragment =
      input.lockMinutes === null ? '?' : 'DATE_ADD(NOW(3), INTERVAL ? MINUTE)';
    const params: Array<number | string | null> = [
      input.studentId,
      input.appShell,
      input.lockMinutes,
      input.lockMinutes,
    ];

    try {
      const [result] = await this.pool.execute<ResultSetHeader>(
        `INSERT INTO learning_sessions (student_id, app_shell, lock_minutes, lock_expires_at)
         VALUES (?, ?, ?, ${expiresFragment})`,
        params,
      );
      const row = await this.findById(result.insertId);
      if (!row) throw new Error(`learning_sessions ${result.insertId} 插入后读不到`);
      return row;
    } catch (err) {
      if ((err as { errno?: number }).errno === ER_DUP_ENTRY) {
        const existing = await this.findOpen(input.studentId);
        if (existing) return existing;
      }
      throw err;
    }
  }

  /** 按 id 读一行（不限学生）。 */
  async findById(id: number): Promise<LearningSessionRow | null> {
    const [rows] = await this.pool.execute<LearningSessionRow[]>(
      `SELECT ${SELECT_COLUMNS} FROM learning_sessions WHERE id = ? LIMIT 1`,
      [id],
    );
    return rows[0] ?? null;
  }

  /** 刷新「最后一次见到客户端」。轮询端点每 10 秒调一次，兼作心跳。 */
  async touch(studentId: number): Promise<void> {
    await this.pool.execute(
      `UPDATE learning_sessions SET last_seen_at = NOW(3)
       WHERE student_id = ? AND ended_at IS NULL`,
      [studentId],
    );
  }

  /** 结束该生的进行中会话（幂等：没有进行中的行时影响 0 行，调用方不需要区分）。 */
  async endOpen(studentId: number): Promise<void> {
    await this.pool.execute(
      `UPDATE learning_sessions SET ended_at = NOW(3)
       WHERE student_id = ? AND ended_at IS NULL`,
      [studentId],
    );
  }
}
```

- [ ] **Step 5: 实现 `learning-sessions.service.ts`**

```ts
import { Inject, Injectable } from '@nestjs/common';
import { LearningSessionsRepository } from '../../database/repositories/learning-sessions.repo.js';
import type { LearningSessionRow } from '../../database/repositories/learning-sessions.repo.js';
import { ControlsRepository } from '../../database/repositories/controls.repo.js';
import type { StudentSessionView } from './dto/device-control.dto.js';

/** 本期只有 Electron 壳会写；埋点既有枚举是 web|electron，这里复用。 */
export const LEARNING_SESSION_APP_SHELL = 'electron';

/**
 * 把一行映射成对外视图。
 *
 * `toISOString()` 而不是交给 JSON 序列化：`Date` 直接序列化虽也是 ISO，但一旦某个
 * 字段被 mysql2 配成 `dateStrings` 就会退化成 `"2026-09-23 01:00:00.000"`，
 * 前端 `new Date(...)` 在 Safari 上会得到 Invalid Date。显式转换把这个风险钉死。
 */
export function toSessionView(row: LearningSessionRow): StudentSessionView {
  return {
    id: row.id,
    startedAt: row.started_at.toISOString(),
    lockMinutes: row.lock_minutes === null ? null : Number(row.lock_minutes),
    lockExpiresAt: row.lock_expires_at === null ? null : row.lock_expires_at.toISOString(),
    unlockedAt: row.unlocked_at === null ? null : row.unlocked_at.toISOString(),
  };
}

@Injectable()
export class LearningSessionsService {
  constructor(
    @Inject(LearningSessionsRepository) private readonly sessions: LearningSessionsRepository,
    @Inject(ControlsRepository) private readonly controls: ControlsRepository,
  ) {}

  /**
   * 取或建本次学习会话（spec §5.1）。幂等。
   *
   * 顺序很重要：**先查进行中的会话**。命中就直接返回——绝不能在客户端重启时
   * 重新读一遍 `session_lock_minutes` 再算一个新的到期时间，那等于「重启即重置时钟」，
   * 学生只要重启就能无限续时。
   */
  async openOrGet(studentId: number): Promise<StudentSessionView> {
    const open = await this.sessions.findOpen(studentId);
    if (open) {
      await this.sessions.touch(studentId);
      return toSessionView(open);
    }

    const lockMinutes = await this.controls.findSessionLockMinutes(studentId);
    const created = await this.sessions.insertOpen({
      studentId,
      appShell: LEARNING_SESSION_APP_SHELL,
      lockMinutes,
    });
    return toSessionView(created);
  }
}
```

- [ ] **Step 6: 跑 service 测试**

Run:
```bash
cd apps/server && npx vitest run src/modules/device-control/learning-sessions.service.test.ts
```
Expected: PASS。

- [ ] **Step 7: 写 controller + module**

创建 `apps/server/src/modules/device-control/device-control.controller.ts`：

```ts
import { Controller, HttpCode, Param, ParseIntPipe, Patch, Post, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard.js';
import type { JwtUser } from '../../common/guards/jwt-auth.guard.js';
import { RolesGuard } from '../../common/guards/roles.guard.js';
import { Roles } from '../../common/decorators/roles.js';
import { CurrentUser } from '../../common/decorators/current-user.js';
import { LearningSessionsService } from './learning-sessions.service.js';
import type { StudentSessionView } from './dto/device-control.dto.js';

/**
 * 学生端学习会话（spec §5.1/§5.2）。
 *
 * 不手工包 `{code, message, data}` —— 全局 `ResponseInterceptor` 统一包。
 */
@Controller('api/student/learning-sessions')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles('student')
export class DeviceControlController {
  constructor(private readonly sessions: LearningSessionsService) {}

  /**
   * 取或建本次学习会话。**显式 200**（本仓第一个 `@HttpCode` 覆盖）：
   * 该端点是幂等的「取或建」，`@Post` 默认的 201 会误导调用方「每次都在创建」。
   */
  @Post()
  @HttpCode(200)
  async openOrGet(@CurrentUser() user: JwtUser): Promise<StudentSessionView> {
    return this.sessions.openOrGet(user.sub);
  }
}
```

创建 `apps/server/src/modules/device-control/device-control.module.ts`：

```ts
import { Module } from '@nestjs/common';
import { DeviceControlController } from './device-control.controller.js';
import { LearningSessionsService } from './learning-sessions.service.js';
import { LearningSessionsRepository } from '../../database/repositories/learning-sessions.repo.js';
import { ControlsRepository } from '../../database/repositories/controls.repo.js';

/**
 * PC App 学习管控（spec `2026-09-23-pc-app-study-lockdown-design.md`）。
 *
 * `providers` 必须**逐个列出 service 构造函数里注入的全部仓储**，少一个 Nest 启动就抛
 * 「can't resolve dependencies」；`@Inject('DATABASE_POOL')` 来自 `@Global()` 的
 * `DatabaseModule`，不需要在这里 import。
 *
 * `ControlsRepository` 在这里**再列一次**（`ParentInsightsModule` 已列）：仓储是无状态的
 * （只握 pool），多一个实例无害；`AnalyticsModule` 也是这么做的，属既有先例。
 */
@Module({
  controllers: [DeviceControlController],
  providers: [LearningSessionsService, LearningSessionsRepository, ControlsRepository],
})
export class DeviceControlModule {}
```

- [ ] **Step 8: 注册模块**

`apps/server/src/app.module.ts`：加 import

```ts
import { DeviceControlModule } from './modules/device-control/device-control.module.js';
```

并在 `imports` 数组末尾（`KnowledgeGraphModule` 之后，:53 后）加：

```ts
    // PC App 学习管控（2026-09-23）—— 学习会话 + 家长解除命令（学生端 3 + 家长端 2 端点）
    DeviceControlModule,
```

- [ ] **Step 9: 写 controller 测试**

创建 `apps/server/src/modules/device-control/device-control.controller.test.ts`：

```ts
import { describe, it, expect, vi } from 'vitest';
import { DeviceControlController } from './device-control.controller.js';
import type { LearningSessionsService } from './learning-sessions.service.js';

const mkSvc = () =>
  ({
    openOrGet: vi.fn().mockResolvedValue({
      id: 7,
      startedAt: '2026-09-23T01:00:00.000Z',
      lockMinutes: 60,
      lockExpiresAt: '2026-09-23T02:00:00.000Z',
      unlockedAt: null,
    }),
  } as unknown as LearningSessionsService);

const USER = { sub: 9, role: 'student' as const };

describe('DeviceControlController', () => {
  it('openOrGet 用 JWT 里的 studentId，**不接受 body 传学生 id**', async () => {
    const svc = mkSvc();
    const out = await new DeviceControlController(svc).openOrGet(USER);
    expect(svc.openOrGet).toHaveBeenCalledWith(9);
    expect(out.id).toBe(7);
  });
});
```

- [ ] **Step 10: 跑测试 + 编译 + 起服务**

Run:
```bash
cd apps/server && npx vitest run src/modules/device-control && npx tsc --noEmit
```
Expected: PASS + tsc 无输出。

Run（**必须用 dist，不要用 tsx**——`npx tsx src/main.ts` 的 DI 是坏的）：
```bash
cd apps/server && npm run build && node dist/main.js
```
Expected: 启动日志里出现 `api/student/learning-sessions` 路由，无 "can't resolve dependencies"。

- [ ] **Step 11: Commit**

```bash
git add apps/server/src/modules/device-control/ apps/server/src/database/repositories/learning-sessions.repo.ts apps/server/src/app.module.ts
git commit -m "feat(device-control): 模块骨架 + learning_sessions 仓储 + 学生端取或建会话端点"
```

---

## Task 6: `PATCH /api/student/learning-sessions/:id/end`

**Files:**
- Modify: `apps/server/src/database/repositories/learning-sessions.repo.ts`（加 `endById`、`findByIdForStudent`）
- Modify: `apps/server/src/modules/device-control/learning-sessions.service.ts`（加 `end`）
- Modify: `apps/server/src/modules/device-control/device-control.controller.ts`
- Modify: `apps/server/src/modules/device-control/dto/device-control.dto.ts`（加 `EndSessionView`）
- Test: 同上的两个测试文件

**Interfaces:**
- Produces:
  - `export interface EndSessionView { id: number; endedAt: string }`
  - `LearningSessionsRepository.findByIdForStudent(id: number, studentId: number): Promise<LearningSessionRow | null>`
  - `LearningSessionsRepository.endById(id: number, studentId: number): Promise<void>`
  - `LearningSessionsService.end(studentId: number, id: number): Promise<EndSessionView>`

- [ ] **Step 1: 写失败的测试**

在 `learning-sessions.service.test.ts` 追加：

```ts
describe('LearningSessionsService.end（spec §5.2）', () => {
  it('不属于该生的 id → 404/1002（不复用 403，避免泄露「该 id 存在」）', async () => {
    const sessions = mkSessionsRepo();
    (sessions.findByIdForStudent as any).mockResolvedValue(null);

    await expect(
      mkSvc(sessions, mkControlsRepo(null)).end(9, 123),
    ).rejects.toMatchObject({ status: 404, response: { code: 1002 } });
    expect(sessions.endById).not.toHaveBeenCalled();
  });

  it('已结束的会话再调 → 幂等，回原 endedAt，不重复写库', async () => {
    const sessions = mkSessionsRepo();
    (sessions.findByIdForStudent as any).mockResolvedValue(
      ROW({ ended_at: new Date('2026-09-23T01:30:00.000Z') }),
    );

    const out = await mkSvc(sessions, mkControlsRepo(null)).end(9, 7);

    expect(out.endedAt).toBe('2026-09-23T01:30:00.000Z');
    expect(sessions.endById).not.toHaveBeenCalled();
  });

  it('进行中 → 结束并回新时刻', async () => {
    const sessions = mkSessionsRepo();
    (sessions.findByIdForStudent as any)
      .mockResolvedValueOnce(ROW())
      .mockResolvedValueOnce(ROW({ ended_at: new Date('2026-09-23T01:45:00.000Z') }));

    const out = await mkSvc(sessions, mkControlsRepo(null)).end(9, 7);

    expect(sessions.endById).toHaveBeenCalledWith(7, 9);
    expect(out).toEqual({ id: 7, endedAt: '2026-09-23T01:45:00.000Z' });
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd apps/server && npx vitest run src/modules/device-control/learning-sessions.service.test.ts`
Expected: FAIL —— `end` 不存在。

- [ ] **Step 3: 加仓储方法**

在 `learning-sessions.repo.ts` 的 `findById` 之后插入：

```ts
  /** 按 id + 归属学生读一行。**不是自己的 → null**，由服务层翻成 404/1002。 */
  async findByIdForStudent(id: number, studentId: number): Promise<LearningSessionRow | null> {
    const [rows] = await this.pool.execute<LearningSessionRow[]>(
      `SELECT ${SELECT_COLUMNS} FROM learning_sessions WHERE id = ? AND student_id = ? LIMIT 1`,
      [id, studentId],
    );
    return rows[0] ?? null;
  }

  /** 结束指定 id 的会话（带 studentId 双重约束，防止越权结束别人的）。 */
  async endById(id: number, studentId: number): Promise<void> {
    await this.pool.execute(
      `UPDATE learning_sessions SET ended_at = NOW(3)
       WHERE id = ? AND student_id = ? AND ended_at IS NULL`,
      [id, studentId],
    );
  }
```

- [ ] **Step 4: 加 service 方法**

在 `learning-sessions.service.ts` 的 `openOrGet` 之后插入（并在文件顶部 `import { NotFoundException } from '@nestjs/common';` 合并进已有的 `@nestjs/common` 导入）：

```ts
  /**
   * 正常登出：结束本次学习会话（spec §5.2）。幂等。
   *
   * 归属不符一律 **404/1002**（不是 403）：403 会告诉调用方「这个 id 是存在的、只是不是你的」，
   * 属于存在性泄露。404 对两种情况一视同仁。
   */
  async end(studentId: number, id: number): Promise<EndSessionView> {
    const row = await this.sessions.findByIdForStudent(id, studentId);
    if (!row) {
      throw new NotFoundException({ code: 1002, message: '学习会话不存在' });
    }
    if (row.ended_at !== null) {
      // 幂等：已结束就回原时刻，不覆盖（ended_at 是家长端「退出时间」的数据源，不许被重写）。
      return { id: row.id, endedAt: row.ended_at.toISOString() };
    }

    await this.sessions.endById(id, studentId);
    // 回读而不是用 NOW() 猜：真值只有库里有。
    const after = await this.sessions.findByIdForStudent(id, studentId);
    if (!after || after.ended_at === null) {
      throw new NotFoundException({ code: 1002, message: '学习会话不存在' });
    }
    return { id: after.id, endedAt: after.ended_at.toISOString() };
  }
```

在同文件 `import type { StudentSessionView } from './dto/device-control.dto.js';` 一行加上 `EndSessionView`。

- [ ] **Step 5: 加 DTO 与 controller 路由**

`dto/device-control.dto.ts` 追加：

```ts
/** `PATCH /api/student/learning-sessions/:id/end` 的响应（spec §5.2）。 */
export interface EndSessionView {
  id: number;
  endedAt: string;
}
```

`device-control.controller.ts` 追加路由（`EndSessionView` 一并 import）：

```ts
  /** 正常登出。幂等；`:id` 不属于自己 → 404/1002。 */
  @Patch(':id/end')
  async end(
    @CurrentUser() user: JwtUser,
    @Param('id', ParseIntPipe) id: number,
  ): Promise<EndSessionView> {
    return this.sessions.end(user.sub, id);
  }
```

- [ ] **Step 6: 加 controller 测试用例**

`device-control.controller.test.ts` 追加：

```ts
  it('end 透传 studentId 与数字化的 id', async () => {
    const svc = mkSvc();
    (svc as any).end = vi.fn().mockResolvedValue({ id: 7, endedAt: '2026-09-23T01:45:00.000Z' });
    const out = await new DeviceControlController(svc).end(USER, 7);
    expect((svc as any).end).toHaveBeenCalledWith(9, 7);
    expect(out.endedAt).toBe('2026-09-23T01:45:00.000Z');
  });
```

- [ ] **Step 7: 跑测试**

Run: `cd apps/server && npx vitest run src/modules/device-control && npx tsc --noEmit`
Expected: PASS + tsc 无输出。

- [ ] **Step 8: Commit**

```bash
git add apps/server/src/modules/device-control/ apps/server/src/database/repositories/learning-sessions.repo.ts
git commit -m "feat(device-control): 学生端结束学习会话端点（幂等，跨学生 404/1002）"
```

---

## Task 7: `GET /api/student/device-commands`（轮询兼心跳）

**Files:**
- Create: `apps/server/src/database/repositories/device-commands.repo.ts`
- Modify: `apps/server/src/database/repositories/learning-sessions.repo.ts`（轮询事务要跨两张表，方法加在这里）
- Modify: `apps/server/src/modules/device-control/dto/device-control.dto.ts`
- Modify: `apps/server/src/modules/device-control/learning-sessions.service.ts`
- Modify: `apps/server/src/modules/device-control/device-control.controller.ts`
- Test: `apps/server/src/modules/device-control/learning-sessions.service.test.ts`

**Interfaces:**
- Produces:
  - `export const DEVICE_COMMANDS = ['unlock'] as const`
  - `export const COMMAND_TTL_MINUTES = 10`
  - `export interface DeviceCommandRow extends RowDataPacket { id: number; student_id: number; command: string; status: string; issued_by_parent_id: number; created_at: Date; consumed_at: Date | null }`
  - `export interface PollView { commands: Array<{ id: number; command: string }>; lock: { sessionId: number; lockExpiresAt: string | null; unlockedAt: string | null } | null }`
  - `LearningSessionsRepository.pollAndConsume(studentId: number): Promise<{ commands: Array<{ id: number; command: string }>; openSession: LearningSessionRow | null }>`
  - `LearningSessionsService.poll(studentId: number): Promise<PollView>`
  - `DeviceCommandsRepository.insert(input: { studentId: number; command: string; issuedByParentId: number }): Promise<DeviceCommandRow>`

- [ ] **Step 1: 写失败的测试**

在 `learning-sessions.service.test.ts` 追加（`mkSessionsRepo` 需补 `pollAndConsume`）：

```ts
describe('LearningSessionsService.poll（spec §5.3）', () => {
  it('无进行中会话 → commands 空、lock 为 null（正常态，不是 404）', async () => {
    const sessions = mkSessionsRepo();
    (sessions.pollAndConsume as any).mockResolvedValue({ commands: [], openSession: null });

    const out = await mkSvc(sessions, mkControlsRepo(null)).poll(9);

    expect(out).toEqual({ commands: [], lock: null });
  });

  it('带回 lock 供客户端对账（服务端是唯一真源）', async () => {
    const sessions = mkSessionsRepo();
    (sessions.pollAndConsume as any).mockResolvedValue({ commands: [], openSession: ROW() });

    const out = await mkSvc(sessions, mkControlsRepo(null)).poll(9);

    expect(out.lock).toEqual({
      sessionId: 7,
      lockExpiresAt: '2026-09-23T02:00:00.000Z',
      unlockedAt: null,
    });
  });

  it('透传认领到的命令', async () => {
    const sessions = mkSessionsRepo();
    (sessions.pollAndConsume as any).mockResolvedValue({
      commands: [{ id: 3, command: 'unlock' }],
      openSession: ROW({ unlocked_at: new Date('2026-09-23T01:20:00.000Z') }),
    });

    const out = await mkSvc(sessions, mkControlsRepo(null)).poll(9);

    expect(out.commands).toEqual([{ id: 3, command: 'unlock' }]);
    expect(out.lock?.unlockedAt).toBe('2026-09-23T01:20:00.000Z');
  });
});
```

并在 `mkSessionsRepo` 返回对象里加一行：

```ts
  pollAndConsume: vi.fn().mockResolvedValue({ commands: [], openSession: null }),
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd apps/server && npx vitest run src/modules/device-control/learning-sessions.service.test.ts`
Expected: FAIL —— `poll` 不存在。

- [ ] **Step 3: 实现跨两表的轮询事务（写在 `learning-sessions.repo.ts`）**

在 `learning-sessions.repo.ts` 顶部加常量与类型：

```ts
/** 命令在 pending 里最长存活多久（分钟）。超时即 `expired`，见 `pollAndConsume`。 */
export const COMMAND_TTL_MINUTES = 10;

export interface PollResult {
  commands: Array<{ id: number; command: string }>;
  openSession: LearningSessionRow | null;
}
```

并在类里加：

```ts
  /**
   * 学生端一次轮询的全部副作用（spec §5.3），**同一个事务**：
   *   1. 惰性过期：把超时的 pending 命令置 expired；
   *   2. 心跳：刷新进行中会话的 last_seen_at（轮询兼心跳，判「在线」的唯一依据）；
   *   3. 取 pending 命令；
   *   4. 认领（consumed）：`WHERE status='pending'` 让认领幂等；
   *   5. `unlock` → 把进行中会话的 unlocked_at / unlocked_by_parent_id 落库。
   *
   * 为什么要事务：4 与 5 必须同生共死——认领了命令却没落 unlocked_at，家长端会显示
   * 「已下发但没生效」，而学生端已经解锁了。
   *
   * 为什么惰性过期而不是定时任务：一条陈旧 unlock 会解锁**将来某次**锁定。过期只是兜底，
   * 主防线是服务端「没有进行中会话就 409，不许下发」（spec §5.4）。
   */
  async pollAndConsume(studentId: number): Promise<PollResult> {
    const conn = await this.pool.getConnection();
    try {
      await conn.beginTransaction();

      await conn.execute(
        `UPDATE device_commands SET status = 'expired'
         WHERE student_id = ? AND status = 'pending'
           AND created_at < DATE_SUB(NOW(3), INTERVAL ${COMMAND_TTL_MINUTES} MINUTE)`,
        [studentId],
      );

      await conn.execute(
        `UPDATE learning_sessions SET last_seen_at = NOW(3)
         WHERE student_id = ? AND ended_at IS NULL`,
        [studentId],
      );

      const [pending] = await conn.execute<
        (RowDataPacket & { id: number; command: string; issued_by_parent_id: number })[]
      >(
        `SELECT id, command, issued_by_parent_id FROM device_commands
         WHERE student_id = ? AND status = 'pending' ORDER BY id`,
        [studentId],
      );

      if (pending.length > 0) {
        const placeholders = pending.map(() => '?').join(', ');
        await conn.execute(
          `UPDATE device_commands SET status = 'consumed', consumed_at = NOW(3)
           WHERE id IN (${placeholders}) AND status = 'pending'`,
          pending.map((row) => row.id),
        );

        const unlock = pending.find((row) => row.command === 'unlock');
        if (unlock) {
          await conn.execute(
            `UPDATE learning_sessions SET unlocked_at = NOW(3), unlocked_by_parent_id = ?
             WHERE student_id = ? AND ended_at IS NULL`,
            [unlock.issued_by_parent_id, studentId],
          );
        }
      }

      const [sessions] = await conn.execute<LearningSessionRow[]>(
        `SELECT ${SELECT_COLUMNS} FROM learning_sessions
         WHERE student_id = ? AND ended_at IS NULL LIMIT 1`,
        [studentId],
      );

      await conn.commit();
      return {
        commands: pending.map((row) => ({ id: row.id, command: row.command })),
        openSession: sessions[0] ?? null,
      };
    } catch (err) {
      // 回滚失败（连接已断）不能顶掉真正的失败原因；吞掉回滚错误，向上抛原始 err
      try {
        await conn.rollback();
      } catch {
        /* 保留原始错误 */
      }
      throw err;
    } finally {
      conn.release();
    }
  }
```

> `COMMAND_TTL_MINUTES` 直接插进 SQL 字符串（不占位符）：它是**本文件内的字面常量整数**，不是入参，没有注入面。
> （初稿的理由写的是「`INTERVAL ? MINUTE` 在部分 mysql2 版本下会报语法错」——2026-09-24 实测**本机不成立**，
> `INTERVAL ?` 的预处理是正常的，见 Task 5 `insertOpen` 的修正说明。这里保留字面量插值只是因为它更简单，
> 不是因为有语法障碍。）

- [ ] **Step 4: 实现 service 的 `poll`**

`dto/device-control.dto.ts` 追加：

```ts
/** `GET /api/student/device-commands` 的响应（spec §5.3）。 */
export interface PollView {
  commands: Array<{ id: number; command: string }>;
  /**
   * 当前进行中会话的锁定状态，供客户端**对账**——本地 `lockExpiresAt` 与服务端不一致时
   * 以服务端为准（例如家长已在别处解除）。无进行中会话 → `null`。
   */
  lock: { sessionId: number; lockExpiresAt: string | null; unlockedAt: string | null } | null;
}
```

`learning-sessions.service.ts` 追加（`PollView` 一并 import）：

```ts
  /**
   * 学生端轮询（spec §5.3）。客户端每 10 秒一次，**兼作心跳**。
   *
   * 空结果是正常态：`{ commands: [], lock: null }`，绝不 404。
   */
  async poll(studentId: number): Promise<PollView> {
    const { commands, openSession } = await this.sessions.pollAndConsume(studentId);
    return {
      commands,
      lock: openSession
        ? {
            sessionId: openSession.id,
            lockExpiresAt:
              openSession.lock_expires_at === null
                ? null
                : openSession.lock_expires_at.toISOString(),
            unlockedAt:
              openSession.unlocked_at === null ? null : openSession.unlocked_at.toISOString(),
          }
        : null,
    };
  }
```

- [ ] **Step 5: 新建 `device-commands.controller.ts`（本端点的路径是 `api/student/device-commands`，不是 `learning-sessions` 的子路径，所以**必须另起一个 controller 类**，不能在 `device-control.controller.ts` 里加）**

创建 `apps/server/src/modules/device-control/device-commands.controller.ts`：

```ts
import { Controller, Get, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard.js';
import type { JwtUser } from '../../common/guards/jwt-auth.guard.js';
import { RolesGuard } from '../../common/guards/roles.guard.js';
import { Roles } from '../../common/decorators/roles.js';
import { CurrentUser } from '../../common/decorators/current-user.js';
import { LearningSessionsService } from './learning-sessions.service.js';
import type { PollView } from './dto/device-control.dto.js';

/** 学生端命令轮询（spec §5.3）。路径是 `api/student/device-commands`，故独立成类。 */
@Controller('api/student/device-commands')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles('student')
export class DeviceCommandsController {
  constructor(private readonly sessions: LearningSessionsService) {}

  /** 轮询（兼心跳）。空结果是正常态：`{ commands: [], lock: null }`。 */
  @Get()
  async poll(@CurrentUser() user: JwtUser): Promise<PollView> {
    return this.sessions.poll(user.sub);
  }
}
```

并把 `device-control.module.ts` 的 `controllers` 改为 `[DeviceControlController, DeviceCommandsController]`。

- [ ] **Step 6: 建 `device-commands.repo.ts`（Task 8 用，本步先落骨架）**

```ts
import { Injectable, Inject } from '@nestjs/common';
import type { Pool, ResultSetHeader, RowDataPacket } from 'mysql2/promise';

/** 本期唯一命令（spec §5.4）。用数组而不是 ENUM 类型：新增命令只改这里。 */
export const DEVICE_COMMANDS = ['unlock'] as const;
export type DeviceCommandName = (typeof DEVICE_COMMANDS)[number];

export interface DeviceCommandRow extends RowDataPacket {
  id: number;
  student_id: number;
  command: string;
  status: 'pending' | 'consumed' | 'expired';
  issued_by_parent_id: number;
  created_at: Date;
  consumed_at: Date | null;
}

/**
 * 家长 → 学生端命令队列（spec §4.3）。
 *
 * 消费（认领 + 落 unlocked_at）在 `LearningSessionsRepository.pollAndConsume` 的事务里，
 * 不在这里——那两个动作必须同生共死。本仓储**只负责插入**。
 */
@Injectable()
export class DeviceCommandsRepository {
  constructor(@Inject('DATABASE_POOL') private readonly pool: Pool) {}

  async insert(input: {
    studentId: number;
    command: DeviceCommandName;
    issuedByParentId: number;
  }): Promise<DeviceCommandRow> {
    const [result] = await this.pool.execute<ResultSetHeader>(
      `INSERT INTO device_commands (student_id, command, issued_by_parent_id) VALUES (?, ?, ?)`,
      [input.studentId, input.command, input.issuedByParentId],
    );
    const [rows] = await this.pool.execute<DeviceCommandRow[]>(
      `SELECT id, student_id, command, status, issued_by_parent_id, created_at, consumed_at
       FROM device_commands WHERE id = ? LIMIT 1`,
      [result.insertId],
    );
    if (!rows[0]) throw new Error(`device_commands ${result.insertId} 插入后读不到`);
    return rows[0];
  }
}
```

- [ ] **Step 7: 跑测试 + 编译**

Run: `cd apps/server && npx vitest run src/modules/device-control && npx tsc --noEmit`
Expected: PASS + tsc 无输出。

- [ ] **Step 8: Commit**

```bash
git add apps/server/src/modules/device-control/ apps/server/src/database/repositories/
git commit -m "feat(device-control): 学生端命令轮询端点（惰性过期+心跳+认领，单事务）"
```

---

## Task 8: `POST /api/parent/students/:studentId/device-commands`（家长下发命令）

**Files:**
- Create: `apps/server/src/modules/device-control/device-commands.service.ts`
- Create: `apps/server/src/modules/device-control/device-control-parent.controller.ts`
- Modify: `apps/server/src/modules/device-control/device-control.module.ts`（加 `ParentModule` import、新 provider/controller）
- Modify: `apps/server/src/modules/device-control/dto/device-control.dto.ts`
- Test: `apps/server/src/modules/device-control/device-commands.service.test.ts`

**Interfaces:**
- Consumes: `ParentService.requireOwnedStudent(parentId, studentId)`（`ParentModule` 已 `exports`）、`DeviceCommandsRepository.insert`（Task 7）、`LearningSessionsRepository.findOpen`（Task 5）
- Produces:
  - `export interface IssuedCommandView { id: number; command: string; status: 'pending'; learningSessionId: number; createdAt: string }`
  - `DeviceCommandsService.issue(studentId: number, parentId: number, command: DeviceCommandName): Promise<IssuedCommandView>`

- [ ] **Step 1: 写失败的测试**

创建 `apps/server/src/modules/device-control/device-commands.service.test.ts`：

```ts
import { describe, it, expect, vi } from 'vitest';
import { DeviceCommandsService } from './device-commands.service.js';
import type { LearningSessionsRepository } from '../../database/repositories/learning-sessions.repo.js';
import type { DeviceCommandsRepository } from '../../database/repositories/device-commands.repo.js';

const mkSessions = (open: unknown) =>
  ({ findOpen: vi.fn().mockResolvedValue(open) } as unknown as LearningSessionsRepository);

const mkCommands = () => ({
  insert: vi.fn().mockResolvedValue({
    id: 3,
    student_id: 9,
    command: 'unlock',
    status: 'pending',
    issued_by_parent_id: 5,
    created_at: new Date('2026-09-23T01:10:00.000Z'),
    consumed_at: null,
  }),
});

const mkSvc = (
  sessions: LearningSessionsRepository,
  commands: ReturnType<typeof mkCommands>,
) => new DeviceCommandsService(sessions, commands as unknown as DeviceCommandsRepository);

describe('DeviceCommandsService.issue（spec §5.4）', () => {
  it('**没有进行中会话 → 409/1001**，且不写任何命令', async () => {
    const commands = mkCommands();
    await expect(mkSvc(mkSessions(null), commands).issue(9, 5, 'unlock')).rejects.toMatchObject({
      status: 409,
      response: { code: 1001 },
    });
    expect(commands.insert).not.toHaveBeenCalled();
  });

  it('有进行中会话 → 插 pending 命令，并带上 learningSessionId', async () => {
    const commands = mkCommands();
    const out = await mkSvc(mkSessions({ id: 7 }), commands).issue(9, 5, 'unlock');

    expect(commands.insert).toHaveBeenCalledWith({
      studentId: 9,
      command: 'unlock',
      issuedByParentId: 5,
    });
    expect(out).toEqual({
      id: 3,
      command: 'unlock',
      status: 'pending',
      learningSessionId: 7,
      createdAt: '2026-09-23T01:10:00.000Z',
    });
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd apps/server && npx vitest run src/modules/device-control/device-commands.service.test.ts`
Expected: FAIL —— 类不存在。

- [ ] **Step 3: 实现 service**

```ts
import { ConflictException, Inject, Injectable } from '@nestjs/common';
import { LearningSessionsRepository } from '../../database/repositories/learning-sessions.repo.js';
import { DeviceCommandsRepository } from '../../database/repositories/device-commands.repo.js';
import type { DeviceCommandName } from '../../database/repositories/device-commands.repo.js';
import type { IssuedCommandView } from './dto/device-control.dto.js';

/**
 * 家长下发命令（spec §5.4）。
 *
 * **没有进行中会话就 409**：否则一条命令会悬在那里，解锁掉**将来某次**锁定。
 * `pollAndConsume` 的 10 分钟惰性过期只是兜底，不该当主防线（spec §4.3）。
 */
@Injectable()
export class DeviceCommandsService {
  constructor(
    @Inject(LearningSessionsRepository) private readonly sessions: LearningSessionsRepository,
    @Inject(DeviceCommandsRepository) private readonly commands: DeviceCommandsRepository,
  ) {}

  async issue(
    studentId: number,
    parentId: number,
    command: DeviceCommandName,
  ): Promise<IssuedCommandView> {
    const open = await this.sessions.findOpen(studentId);
    if (!open) {
      throw new ConflictException({
        code: 1001,
        message: '当前没有进行中的学习会话',
      });
    }

    const created = await this.commands.insert({
      studentId,
      command,
      issuedByParentId: parentId,
    });

    return {
      id: created.id,
      command: created.command,
      status: 'pending',
      learningSessionId: open.id,
      createdAt: created.created_at.toISOString(),
    };
  }
}
```

- [ ] **Step 4: 加 DTO 与家长端 controller**

`dto/device-control.dto.ts` 追加：

```ts
/** `POST /api/parent/students/:studentId/device-commands` 的响应（spec §5.4）。 */
export interface IssuedCommandView {
  id: number;
  command: string;
  status: 'pending';
  /** 该命令指向的进行中会话。家长端据此知道「解除了哪一次」。 */
  learningSessionId: number;
  createdAt: string;
}
```

创建 `device-control-parent.controller.ts`：

```ts
import { Body, Controller, Param, ParseIntPipe, Post, UseGuards } from '@nestjs/common';
import { z } from 'zod';
import { BadRequestException } from '@nestjs/common';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard.js';
import type { JwtUser } from '../../common/guards/jwt-auth.guard.js';
import { RolesGuard } from '../../common/guards/roles.guard.js';
import { Roles } from '../../common/decorators/roles.js';
import { CurrentUser } from '../../common/decorators/current-user.js';
import { ParentService } from '../parent/parent.service.js';
import { DeviceCommandsService } from './device-commands.service.js';
import type { IssuedCommandView } from './dto/device-control.dto.js';

const IssueCommandSchema = z.object({
  command: z.enum(['unlock']),
});

/**
 * 家长端设备命令（spec §5.4）。
 *
 * 与 `ParentInsightsController` **共用 `api/parent` 前缀**（Nest 允许多个 controller 共享前缀，
 * `ParentPointsController` 是先例），但**路径不许撞车**——撞了会静默覆盖。
 */
@Controller('api/parent')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles('parent')
export class DeviceControlParentController {
  constructor(
    private readonly parentService: ParentService,
    private readonly commands: DeviceCommandsService,
  ) {}

  /** 归属校验必须是**第一行**，与本仓其余家长端端点一致。 */
  @Post('students/:studentId/device-commands')
  async issue(
    @CurrentUser() user: JwtUser,
    @Param('studentId', ParseIntPipe) studentId: number,
    @Body() body: unknown,
  ): Promise<IssuedCommandView> {
    await this.parentService.requireOwnedStudent(user.sub, studentId);
    const parsed = IssueCommandSchema.safeParse(body);
    if (!parsed.success) {
      const detail = parsed.error.issues
        .map((issue) => `${issue.path.join('.') || 'body'}: ${issue.message}`)
        .join('; ');
      throw new BadRequestException({ code: 1001, message: `入参校验失败：${detail}` });
    }
    return this.commands.issue(studentId, user.sub, parsed.data.command);
  }
}
```

- [ ] **Step 5: 装配模块**

`device-control.module.ts` 改为：

```ts
import { Module } from '@nestjs/common';
import { DeviceControlController } from './device-control.controller.js';
import { DeviceCommandsController } from './device-commands.controller.js';
import { DeviceControlParentController } from './device-control-parent.controller.js';
import { LearningSessionsService } from './learning-sessions.service.js';
import { DeviceCommandsService } from './device-commands.service.js';
import { LearningSessionsRepository } from '../../database/repositories/learning-sessions.repo.js';
import { DeviceCommandsRepository } from '../../database/repositories/device-commands.repo.js';
import { ControlsRepository } from '../../database/repositories/controls.repo.js';
import { ParentModule } from '../parent/parent.module.js';

/**
 * PC App 学习管控（spec `2026-09-23-pc-app-study-lockdown-design.md`）。
 *
 * - `imports: [ParentModule]` —— 家长端 handler 用 `ParentService.requireOwnedStudent`
 *   做归属校验（`ParentModule` 已 `exports: [ParentService]`）。
 * - `providers` 必须**逐个列出 service 构造函数里注入的全部仓储**；`@Inject('DATABASE_POOL')`
 *   来自 `@Global()` 的 `DatabaseModule`，不需要 import。
 * - `ControlsRepository` 在这里**再列一次**（`ParentInsightsModule` 已列）：仓储无状态
 *   （只握 pool），多一个实例无害；`AnalyticsModule` 同样做法。
 */
@Module({
  imports: [ParentModule],
  controllers: [DeviceControlController, DeviceCommandsController, DeviceControlParentController],
  providers: [
    LearningSessionsService,
    DeviceCommandsService,
    LearningSessionsRepository,
    DeviceCommandsRepository,
    ControlsRepository,
  ],
})
export class DeviceControlModule {}
```

- [ ] **Step 6: 跑测试 + 起服务验证路由**

Run: `cd apps/server && npx vitest run src/modules/device-control && npx tsc --noEmit`
Expected: PASS + tsc 无输出。

Run:
```bash
cd apps/server && npm run build && node dist/main.js
```
Expected: 启动无 "can't resolve dependencies"，日志里能看到 `api/parent/students/:studentId/device-commands`。

- [ ] **Step 7: Commit**

```bash
git add apps/server/src/modules/device-control/
git commit -m "feat(device-control): 家长下发解除命令端点（无进行中会话 409/1001）"
```

---

## Task 9: `GET /api/parent/students/:studentId/learning-sessions`（家长端「进出时间」）

**Files:**
- Modify: `apps/server/src/database/repositories/learning-sessions.repo.ts`（加 `listByStudent`、`countByStudent`）
- Create: `apps/server/src/modules/device-control/learning-session-log.service.ts`
- Modify: `apps/server/src/modules/device-control/device-control-parent.controller.ts`
- Modify: `apps/server/src/modules/device-control/dto/device-control.dto.ts`
- Modify: `apps/server/src/modules/device-control/device-control.module.ts`
- Test: `apps/server/src/modules/device-control/learning-session-log.service.test.ts`

**Interfaces:**
- Produces:
  - `export const LEARNING_SESSION_ONLINE_WINDOW_SECONDS = 45`
  - `export interface ParentSessionItem { id: number; startedAt: string; endedAt: string | null; online: boolean; lockMinutes: number | null; lockExpiresAt: string | null; unlockedAt: string | null }`
  - `export interface ParentSessionPage { items: ParentSessionItem[]; total: number }`
  - `LearningSessionLogService.list(studentId: number, days: number, limit: number): Promise<ParentSessionPage>`
  - `LearningSessionsRepository.listByStudent(studentId, since: Date, limit: number): Promise<LearningSessionRow[]>`
  - `LearningSessionsRepository.countByStudent(studentId, since: Date): Promise<number>`

- [ ] **Step 1: 写失败的测试**

创建 `learning-session-log.service.test.ts`：

```ts
import { describe, it, expect, vi } from 'vitest';
import { LearningSessionLogService } from './learning-session-log.service.js';
import type { LearningSessionsRepository } from '../../database/repositories/learning-sessions.repo.js';

const NOW = new Date('2026-09-23T02:00:00.000Z');

const mkRepo = (rows: unknown[], total = rows.length) =>
  ({
    listByStudent: vi.fn().mockResolvedValue(rows),
    countByStudent: vi.fn().mockResolvedValue(total),
  } as unknown as LearningSessionsRepository);

const row = (over: Record<string, unknown> = {}) => ({
  id: 7,
  student_id: 9,
  app_shell: 'electron',
  started_at: new Date('2026-09-23T01:00:00.000Z'),
  last_seen_at: NOW,
  ended_at: null,
  lock_minutes: 60,
  lock_expires_at: new Date('2026-09-23T02:00:00.000Z'),
  unlocked_at: null,
  unlocked_by_parent_id: null,
  ...over,
});

describe('LearningSessionLogService.list（spec §5.5）', () => {
  it('进行中且心跳在 45 秒内 → online: true', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const svc = new LearningSessionLogService(mkRepo([row()]));
    const out = await svc.list(9, 7, 50);
    expect(out.items[0].online).toBe(true);
    expect(out.items[0].endedAt).toBeNull();
    vi.useRealTimers();
  });

  it('进行中但心跳超 45 秒 → online: false（已断开）', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const stale = new Date(NOW.getTime() - 46_000);
    const svc = new LearningSessionLogService(mkRepo([row({ last_seen_at: stale })]));
    expect((await svc.list(9, 7, 50)).items[0].online).toBe(false);
    vi.useRealTimers();
  });

  it('已结束的会话永远 online: false（哪怕 last_seen_at 很新）', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const svc = new LearningSessionLogService(
      mkRepo([row({ ended_at: new Date('2026-09-23T01:30:00.000Z') })]),
    );
    const out = await svc.list(9, 7, 50);
    expect(out.items[0].online).toBe(false);
    expect(out.items[0].endedAt).toBe('2026-09-23T01:30:00.000Z');
    vi.useRealTimers();
  });

  it('空结果是正常态：items 空、total 0（不抛错）', async () => {
    const svc = new LearningSessionLogService(mkRepo([], 0));
    expect(await svc.list(9, 7, 50)).toEqual({ items: [], total: 0 });
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd apps/server && npx vitest run src/modules/device-control/learning-session-log.service.test.ts`
Expected: FAIL —— 类不存在。

- [ ] **Step 3: 加仓储查询**

在 `learning-sessions.repo.ts` 类里加：

```ts
  /** 家长端「进出时间」列表：窗口内按开始时间倒序。 */
  async listByStudent(
    studentId: number,
    since: Date,
    limit: number,
  ): Promise<LearningSessionRow[]> {
    const [rows] = await this.pool.execute<LearningSessionRow[]>(
      `SELECT ${SELECT_COLUMNS} FROM learning_sessions
       WHERE student_id = ? AND started_at >= ?
       ORDER BY started_at DESC LIMIT ?`,
      [studentId, since, limit],
    );
    return rows;
  }

  /** 同窗口的总数（不受 limit 影响，供分页/提示）。 */
  async countByStudent(studentId: number, since: Date): Promise<number> {
    const [rows] = await this.pool.execute<(RowDataPacket & { total: number })[]>(
      `SELECT COUNT(*) AS total FROM learning_sessions WHERE student_id = ? AND started_at >= ?`,
      [studentId, since],
    );
    return Number(rows[0]?.total ?? 0);
  }
```

- [ ] **Step 4: 实现 service**

创建 `learning-session-log.service.ts`：

```ts
import { Inject, Injectable } from '@nestjs/common';
import { LearningSessionsRepository } from '../../database/repositories/learning-sessions.repo.js';
import type { LearningSessionRow } from '../../database/repositories/learning-sessions.repo.js';
import type { ParentSessionItem, ParentSessionPage } from './dto/device-control.dto.js';

/**
 * 判「在线」的心跳窗口（秒）。
 *
 * ⚠️ **与客户端轮询间隔成对**：客户端 `LEARNING_SESSION_POLL_MS = 10_000`（10 秒，
 * 见计划 2）。45 秒 = 容忍 4 次丢包/抖动。**改一处必须同步另一处**
 * （沿用本仓 `CLIENT_IDLE_DETECTION_SECONDS` ↔ `IDLE_TIMEOUT_MS` 的镜像纪律）。
 *
 * 这个阈值**只在这一处**：前端不重算，只消费后端下发的 `online`。
 */
export const LEARNING_SESSION_ONLINE_WINDOW_SECONDS = 45;

/**
 * 家长端「进出时间」（spec §5.5）。
 *
 * 这是**新能力**：现有家长端时长全是聚合值（`parent-analytics.repo` 的
 * getStudyTimeTotal / ByDay / ByModule / BySubject / getActiveDays），没有一行返回原始起止时刻；
 * 而 `study_sessions` 是**学习页粒度**（进一个场景一行），不是登录粒度。所以靠
 * `learning_sessions` 而不是去拼 `study_sessions`。
 */
@Injectable()
export class LearningSessionLogService {
  constructor(
    @Inject(LearningSessionsRepository) private readonly sessions: LearningSessionsRepository,
  ) {}

  async list(studentId: number, days: number, limit: number): Promise<ParentSessionPage> {
    const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
    const [rows, total] = await Promise.all([
      this.sessions.listByStudent(studentId, since, limit),
      this.sessions.countByStudent(studentId, since),
    ]);
    return { items: rows.map((row) => this.toItem(row)), total };
  }

  private toItem(row: LearningSessionRow): ParentSessionItem {
    return {
      id: row.id,
      startedAt: row.started_at.toISOString(),
      endedAt: row.ended_at === null ? null : row.ended_at.toISOString(),
      // 后端算好下发，前端不重算阈值。已结束的会话永远不算在线。
      online:
        row.ended_at === null &&
        Date.now() - row.last_seen_at.getTime() <= LEARNING_SESSION_ONLINE_WINDOW_SECONDS * 1000,
      lockMinutes: row.lock_minutes === null ? null : Number(row.lock_minutes),
      lockExpiresAt:
        row.lock_expires_at === null ? null : row.lock_expires_at.toISOString(),
      unlockedAt: row.unlocked_at === null ? null : row.unlocked_at.toISOString(),
    };
  }
}
```

- [ ] **Step 5: 加 DTO**

`dto/device-control.dto.ts` 追加：

```ts
/** 家长端「进出时间」的一行（spec §5.5）。 */
export interface ParentSessionItem {
  id: number;
  startedAt: string;
  /** `null` = 仍在进行中。 */ 
  endedAt: string | null;
  /** 后端算好下发（阈值真源在后端），前端不重算。 */ 
  online: boolean;
  lockMinutes: number | null;
  lockExpiresAt: string | null;
  unlockedAt: string | null;
}

/** `GET /api/parent/students/:studentId/learning-sessions` 的响应（spec §5.5）。 */
export interface ParentSessionPage {
  items: ParentSessionItem[];
  total: number;
}
```

- [ ] **Step 6: 加 controller 路由**

`device-control-parent.controller.ts`：把 `import { Body, Controller, Param, ParseIntPipe, Post, UseGuards }` 补上 `Get` 与 `Query`，并追加：

```ts
  /**
   * 进出时间列表（spec §5.5）。`days` 缺省 7（1..90）、`limit` 缺省 50（1..100）；
   * **越界 400/1001，不静默钳制**（本仓全局纪律）。
   * `parsePositiveInt` 复用 `parent-insights.controller.ts` 里那一个，**勿新写**。
   */
  @Get('students/:studentId/learning-sessions')
  async listSessions(
    @CurrentUser() user: JwtUser,
    @Param('studentId', ParseIntPipe) studentId: number,
    @Query('days') days?: string,
    @Query('limit') limit?: string,
  ): Promise<ParentSessionPage> {
    await this.parentService.requireOwnedStudent(user.sub, studentId);
    return this.logs.list(
      studentId,
      parsePositiveInt(days, 'days', 7, 90),
      parsePositiveInt(limit, 'limit', 50, 100),
    );
  }
```

标签：`ParentSessionPage` 一并加入 type import；`parsePositiveInt` 从 `parent-insights.controller.ts` 的同一 import 源引入；构造函数注入 `private readonly logs: LearningSessionLogService`。

- [ ] **Step 7: 装配模块**

`device-control.module.ts`：`providers` 加 `LearningSessionLogService`。

- [ ] **Step 8: 跑测试 + 编译 + 起服务**

Run: `cd apps/server && npx vitest run src/modules/device-control && npx tsc --noEmit`
Expected: PASS + tsc 无输出。

Run: `cd apps/server && npm run build && node dist/main.js`
Expected: 两个家长端路由都出现在启动日志，无依赖解析错误。

- [ ] **Step 9: 跑全量测试**

Run: `cd apps/server && npm test`
Expected: 全绿。**若 `parent-insights.controller.test.ts` 因 `parsePositiveInt` 或 controls mock 形状报错，按测试错误修测试**（测试断言与设计文档冲突时测试错）。

- [ ] **Step 10: Commit**

```bash
git add apps/server/src/modules/device-control/ apps/server/src/database/repositories/learning-sessions.repo.ts
git commit -m "feat(device-control): 家长端进出时间列表端点（online 由后端算好下发）"
```

---

## Task 10: API 契约同步

**Files:**
- Modify: `docs/API接口与数据流设计文档.md`
- Modify: `docs/api/openapi.yaml`

**Interfaces:**
- Consumes: Task 3、4、5～9 的全部端点与字段
- Produces: 两份文档对同一组端点/字段的一致描述（本仓铁律：**必须同步**）

- [ ] **Step 1: 列出实际路由作为唯一依据**

Run:
```bash
cd apps/server && npm run build && node dist/main.js 2>&1 | grep -iE "learning-sessions|device-commands|students/:studentId" | sort -u
```
Expected: 逐条核对出这 5 条新路由（**以启动日志为准**，不要凭 Task 描述抄）：
- `POST /api/student/learning-sessions`（200，非 201）
- `PATCH /api/student/learning-sessions/:id/end`
- `GET /api/student/device-commands`
- `POST /api/parent/students/:studentId/device-commands`（201）
- `GET /api/parent/students/:studentId/learning-sessions`

- [ ] **Step 2: 改 API 设计文档**

在 `docs/API接口与数据流设计文档.md` 中：
1. §4 端点清单新增一组 **`api/student/learning-sessions` + `api/student/device-commands` + `api/parent/.../device-commands` + `api/parent/.../learning-sessions`**，各条写清：方法、路径、鉴权角色、参数与范围、成功码、错误码（1001 / 1002 / 1005 / 401 / 403）、响应形状（照抄 spec §5.1–5.5）。
2. §4 里 `PUT /api/parent/students/{studentId}/controls` 的 body 与 `GET` 的响应**都加 `sessionLockMinutes`**（1..480 或 `null`）。
3. `GET /api/parent/students/{studentId}/today-usage` 的响应**删掉 `limitMinutes` 与 `exceeded`**。
4. 该端点原有的「`controls.daily_time_limit_minutes`」表述全部改成 `session_lock_minutes`，并注明语义是「单次登录起算」。
5. §5 数据流里补一条「学生登录 → 取或建学习会话 → 轮询兼心跳 → 家长解除 → unlocked_at 落库」的流程说明。

- [ ] **Step 3: 改 `openapi.yaml`**

1. 新增 5 条路径（含 `requestBody`/`responses`/`parameters`），错误响应复用文件里既有的错误 schema。
2. `POST /api/student/learning-sessions` 的 `responses` 写 **`'200'`**（不是 201）——它是本仓唯一的 `@HttpCode` 覆盖，**必须在 yaml 里体现**。
3. `POST /api/parent/students/{studentId}/device-commands` 写 **`'201'`**（Nest `@Post` 默认）。
4. `controls` 的 `GET`/`PUT` schema 补 `sessionLockMinutes`（`integer` + `nullable`，`minimum: 1`、`maximum: 480`）。
5. `today-usage` 响应 schema 删掉 `limitMinutes` / `exceeded`。

- [ ] **Step 4: 逐条核对两档一致（本仓要求「端点路径列表比对」）**

Run:
```bash
cd /Users/lichao/Downloads/claude/imooc/ai_k12 && for p in student/learning-sessions student/device-commands parent/students/\{studentId\}/device-commands parent/students/\{studentId\}/learning-sessions; do printf "%-55s api-doc=%s openapi=%s\n" "$p" "$(grep -c "$p" docs/API接口与数据流设计文档.md)" "$(grep -c "$p" docs/api/openapi.yaml)"; done
```
Expected: 四个路径的 `api-doc` 与 `openapi` 计数都 **> 0**。计数为 0 的那份就是漏了。

- [ ] **Step 5: Commit**

```bash
git add docs/API接口与数据流设计文档.md docs/api/openapi.yaml
git commit -m "docs(api): 同步 PC App 学习管控 5 个端点 + controls 扩展 + today-usage 收缩"
```

---

## 计划自检（写完后的核对结果）

**spec 覆盖**

| spec 章节 | 落在哪个任务 |
|---|---|
| §4.1 列改名 | Task 1、2、3 |
| §4.2 `learning_sessions` | Task 1、5、6、7、9 |
| §4.3 `device_commands` | Task 1、7、8 |
| §4.4 不动的既有资产 | 无任务（**正确地没有**） |
| §5.0 模块落点 | Task 5、8 |
| §5.1 取或建 | Task 5 |
| §5.2 结束 | Task 6 |
| §5.3 轮询 | Task 7 |
| §5.4 家长下发 | Task 8 |
| §5.5 进出时间 | Task 9 |
| §5.6 controls 扩展 | Task 3 |
| §5.7 today-usage 收缩 | Task 4 |
| §9 API 文档 + openapi | Task 10 |
| §9 其余文档（PRD/UX/架构/CLAUDE.md/…） | **计划 3** |
| §6 客户端、§7 家长端 UI | **计划 2 / 计划 3** |

**类型一致性**：`LearningSessionRow` 只在 Task 5 定义、后续任务只读；`toSessionView`（Task 5）与 `LearningSessionLogService.toItem`（Task 9）是**两个不同的映射**（学生视图 vs 家长视图），故意不合并——前者不含 `online`/`last_seen_at`，后者不含 `app_shell`。

**已知风险**
1. `INTERVAL ? MINUTE` 的 mysql2 预处理兼容性（Task 5 Step 4 已给替代方案）。
2. `parsePositiveInt` 的确切文件路径按 Task 9 Step 6 的说明从 `parent-insights.controller.ts` 的 import 取，**不要自己新写一个**（会造出第二套越界语义）。
3. Task 7 的路由前缀问题已在 Step 5 显式处理（独立 controller 类）。
