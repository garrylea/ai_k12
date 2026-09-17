# 闯关积分与段位体系 · 后端实施计划（三份之一）

- 日期：2026-09-17
- 依据：`docs/superpowers/specs/2026-09-17-gamification-points-design.md`
- 状态：**待实施**（本文只做后端；前端学生端/家长端另两份计划，均依赖本文）

---

## 0. 三份计划的切分与依赖

| 计划 | 内容 | 依赖 |
|---|---|---|
| **本文** | 迁移 + `points` 模块 + 8 个任务埋点 + 学生端/家长端全部端点 | 无（可独立交付，`curl` 能走通「发分 → 段位 → 兑换」） |
| 计划二 | 学生端积分 UI（段位图标 / UserBadge / LevelPanel / 庆祝页 / 个人中心 / 奖励册） | 本文的端点 |
| 计划三 | 家长端积分管理 UI（当前学生上下文 / 分值配置页 / 兑换页） | 本文的端点；复用计划二的 `LevelIcon` |

**三份计划都依赖的前置**：`chinese_passages.genre` 人工标定（本文 Task 1 建列 + Task 11 定工具，但**标定是数据工作，需用户参与**）。未标定的篇目不发分（`awardReason='genre_unset'`），所以标定没做完也能先把代码跑通。

---

## 1. 全局约束（每条都要遵守）

### 1.1 spec 定案，勿「统一」掉

1. **完成即给分，不看对错**——做错也全额给。
2. **段位只升不降**：按 `total_earned` 算；兑换只写负流水扣 `balance`，绝不动 `total_earned`。
3. **每日上限 = 当天该 `task_code` 的 `kind='earn'` 流水条数上限**。`daily_limit IS NULL` = 不限。
4. **档位即可选项**：分值由「档位」决定，学生不能自由填题数。
5. **甲类逐目标发分 / 乙类按会话整批 / 丙类既有事件点**——分类见 §7，别混用。
6. **段位阈值全局固定**，家长不可调；家长只能调分值与每日上限。

### 1.2 仓内硬规则（踩过坑的）

1. **不在 SQL 里用 `CURDATE()` / `DATE(NOW())`**——DB 会话时区与应用时区可能不一致（`student-word-progress.repo.ts:92`、`vocabulary.service.ts:140` 都注释过）。**在 Node 里算好本地日边界，作为绑定参数传进 SQL**。
2. **不要去改 `connection.ts` 的会话时区**——会改变全应用 `NOW(3)` 的取值，blast radius 远超本功能。
3. **原生 SQL + `mysql2/promise`**，无 ORM。行类型 `interface XxxRow extends RowDataPacket` 写在 repo 文件里，桶导出到 `src/database/repositories/index.ts`。
4. **迁移必须幂等**（`CREATE TABLE IF NOT EXISTS` 天然幂等；`ADD COLUMN` 用 `information_schema` + `PREPARE` 包裹），**且必须同步折回 `tools/db/schema.sql`**。无迁移运行器，手工 `mysql < file` apply。
5. **Nest `@Post` 默认返回 201**，不是 200；`openapi.yaml` 按实际记。
6. **新增模块要在 `app.module.ts:22` 附近的 `imports` 数组里注册**（现有 15 个模块，加在末尾）。
7. **不带 `@Injectable()` 的类**（如 ai-core capabilities）是零参实例化，避开「接口类型参数被 Nest 当 token」的 DI 坑。`points` 模块的 service 是常规 `@Injectable()`，构造函数参数**一律用具体类**，不要用 interface 类型（否则必须加 `@Optional()`）。
8. **测试与文档同步铁律**：测试断言与 config/设计文档冲突时，**测试错**，改测试。
9. **组件改动必须补渲染测试**（本文是后端，不适用；计划二/三适用）。
10. **`DatabaseModule` 是 `@Global()`**，`'DATABASE_POOL'` 可直接 `@Inject`，repo 无需导入模块。

---

## 2. 数据模型

### Task 1: 迁移文件 + `schema.sql` 同步

**Files:**
- Create: `tools/db/migrations/2026-09-17_gamification_points.sql`
- Modify: `tools/db/schema.sql`（`chinese_passages` 在 :309、`controls` 在 :851；5 张新表追加到文件末尾 `admin_notifications` 之后）

**要建的东西**：2 个 `ADD COLUMN` + 5 张 `CREATE TABLE`（完整 DDL 见 spec §4.1–4.3，逐字照抄，不要自行改字段名）。

**幂等写法**（照抄 `tools/db/migrations/2026-09-16_chinese_interpretation_columns.sql:19-32` 的 `information_schema` + `PREPARE` 模式）：

```sql
-- chinese_passages.genre：体裁。'poem' 诗/词 | 'prose' 文言文；NULL = 未标定，不发分。
SET @col_exists := (
  SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'chinese_passages' AND COLUMN_NAME = 'genre'
);
SET @sql := IF(@col_exists = 0,
  'ALTER TABLE chinese_passages ADD COLUMN genre VARCHAR(10) DEFAULT NULL COMMENT ''poem 诗/词 | prose 文言文；NULL = 未标定，不发分''',
  'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;
```

`controls.points_per_yuan` 用同一模式（`SMALLINT NOT NULL DEFAULT 20`）。

**6 张表**（`point_rules` / `point_ledger` / `student_points` / `reward_catalog` / `point_redemptions` / `training_sessions`）：spec §4.3 的 `CREATE TABLE` 块**逐字复制**。注意三处别漏：

- `point_ledger.dedupe_key` 的 `UNIQUE KEY uniq_point_ledger_dedupe`
- `point_ledger` 的 `KEY idx_point_ledger_daily (student_id, task_code, kind, created_at)`——每日上限计数靠它
- 全部 6 张表**只挂 `students(id)` 外键**，**不要**指向 `questions` / `chinese_passages` / `exam_sessions` 等业务表

**`schema.sql` 同步**：`chinese_passages` 的 `body TEXT` 行后面加 `genre VARCHAR(10) DEFAULT NULL` 并加注释；`controls` 的 `reward_redemption_enabled` 附近加 `points_per_yuan SMALLINT NOT NULL DEFAULT 20`；6 张表 DDL 追加到文件末尾。

**验证：**

```bash
cd /Users/lichao/Downloads/claude/imooc/ai_k12
mysql -uai_k12 -pai_k12 ai_k12 < tools/db/migrations/2026-09-17_gamification_points.sql
mysql -uai_k12 -pai_k12 ai_k12 < tools/db/migrations/2026-09-17_gamification_points.sql   # 第二遍必须不报错（幂等）
mysql -uai_k12 -pai_k12 ai_k12 -e "SHOW COLUMNS FROM chinese_passages LIKE 'genre'; SHOW TABLES LIKE 'point_%'; SHOW TABLES LIKE '%points%'; SHOW TABLES LIKE '%training_sessions%'; SHOW TABLES LIKE 'reward_catalog';"
```

期望：第二遍无报错；`genre` 列存在；`point_rules` / `point_ledger` / `student_points` / `point_redemptions` / `reward_catalog` / `training_sessions` 六张表都在。

**提交**：`feat(db): 积分体系迁移（5 表 + genre 列 + 兑换汇率列）`

---

## 3. `points` 模块骨架

新建目录 `apps/server/src/modules/points/`。

### Task 2: `levels.ts` + `default-rules.ts`（纯常量与纯函数，先写测试）

**Files:**
- Create: `apps/server/src/modules/points/levels.ts`
- Create: `apps/server/src/modules/points/default-rules.ts`
- Test: `apps/server/src/modules/points/levels.test.ts`

`levels.ts`：

```ts
export const LEVELS = [
  { code: 'pichai',   name: '劈柴', threshold: 0 },
  { code: 'zhutie',   name: '铸铁', threshold: 500 },
  { code: 'qingtong', name: '青铜', threshold: 1200 },
  { code: 'baiyin',   name: '白银', threshold: 2000 },
  { code: 'huangjin', name: '黄金', threshold: 3000 },
  { code: 'bojin',    name: '铂金', threshold: 5000 },
  { code: 'zuanshi',  name: '钻石', threshold: 8000 },
  { code: 'xingyao',  name: '星耀', threshold: 12000 },
  { code: 'wangzhe',  name: '王者', threshold: 20000 },
] as const;

export type LevelCode = (typeof LEVELS)[number]['code'];

export interface LevelInfo { code: LevelCode; name: string; index: number; threshold: number }

function toInfo(i: number): LevelInfo {
  return { code: LEVELS[i].code, name: LEVELS[i].name, index: i, threshold: LEVELS[i].threshold };
}

/**
 * 取 threshold <= totalEarned 的最大档（从后往前找第一个命中）。
 * totalEarned 单调递增 → 段位只升不降，**不需要也不该有降级逻辑**。
 * 负数按 0 处理（脏数据兜底），返回劈柴。
 */
export function levelOf(totalEarned: number): LevelInfo {
  const earned = Math.max(0, totalEarned);
  for (let i = LEVELS.length - 1; i >= 0; i--) {
    if (LEVELS[i].threshold <= earned) return toInfo(i);
  }
  return toInfo(0);
}

/** 下一档；已满级（王者）返回 null。 */
export function nextLevelOf(totalEarned: number): LevelInfo | null {
  const cur = levelOf(totalEarned);
  return cur.index === LEVELS.length - 1 ? null : toInfo(cur.index + 1);
}

/** 距下一档还差多少分；满级返回 null。 */
export function pointsToNextLevel(totalEarned: number): number | null {
  const next = nextLevelOf(totalEarned);
  return next === null ? null : next.threshold - Math.max(0, totalEarned);
}

/**
 * 当前档内进度百分比 0-100（整数，四舍五入）。
 * 分母 = next.threshold - cur.threshold；满级直接 100，避免除零。
 */
export function progressPercent(totalEarned: number): number {
  const cur = levelOf(totalEarned);
  const next = nextLevelOf(totalEarned);
  if (next === null) return 100;
  const span = next.threshold - cur.threshold;
  if (span <= 0) return 100;
  const done = Math.max(0, totalEarned) - cur.threshold;
  return Math.min(100, Math.max(0, Math.round((done / span) * 100)));
}

/** 用 totalEarned 反查是否跨档：award 前 oldEarned → award 后 newEarned。 */
export function detectLevelUp(
  oldEarned: number,
  newEarned: number,
): { from: LevelInfo; to: LevelInfo } | null {
  const from = levelOf(oldEarned);
  const to = levelOf(newEarned);
  return to.index > from.index ? { from, to } : null;
}
```

`default-rules.ts`：spec §3.2 的表格转成常量数组。

```ts
export interface DefaultRule {
  taskCode: string;
  taskName: string;      // 规则表里没有 task_name 列，taskName 只用于拼流水 title 与前端分组
  tierKey: string;
  tierLabel: string;
  points: number;
  dailyLimit: number | null;
  sortOrder: number;
}

export const TASK_NAMES: Record<string, string> = {
  mainline_lesson: '学完一课',
  math_paper: '数学卷子一套',
  math_targeted: '数学专项',
  error_fix: '错题订正',
  cn_dictation: '古诗文默写',
  cn_interpretation: '古诗文翻译',
  cn_meaning: '古诗情感',
  en_vocabulary: '英语背单词',
};

export const DEFAULT_RULES: DefaultRule[] = [
  { taskCode: 'mainline_lesson',   taskName: '学完一课',     tierKey: 'default', tierLabel: '一课',   points: 10, dailyLimit: null, sortOrder: 10 },
  { taskCode: 'math_paper',        taskName: '数学卷子一套', tierKey: 'default', tierLabel: '一套',   points: 50, dailyLimit: null, sortOrder: 20 },
  { taskCode: 'math_targeted',     taskName: '数学专项',     tierKey: '1',       tierLabel: '1 题',   points: 2,  dailyLimit: null, sortOrder: 30 },
  { taskCode: 'math_targeted',     taskName: '数学专项',     tierKey: '3',       tierLabel: '3 题',   points: 8,  dailyLimit: null, sortOrder: 31 },
  { taskCode: 'math_targeted',     taskName: '数学专项',     tierKey: '5',       tierLabel: '5 题',   points: 15, dailyLimit: null, sortOrder: 32 },
  { taskCode: 'math_targeted',     taskName: '数学专项',     tierKey: '10',      tierLabel: '10 题',  points: 35, dailyLimit: null, sortOrder: 33 },
  { taskCode: 'error_fix',         taskName: '错题订正',     tierKey: 'default', tierLabel: '一题',   points: 3,  dailyLimit: null, sortOrder: 40 },
  { taskCode: 'cn_dictation',      taskName: '古诗文默写',   tierKey: 'poem',    tierLabel: '古诗',   points: 2,  dailyLimit: null, sortOrder: 50 },
  { taskCode: 'cn_dictation',      taskName: '古诗文默写',   tierKey: 'prose',   tierLabel: '古文',   points: 5,  dailyLimit: null, sortOrder: 51 },
  { taskCode: 'cn_interpretation', taskName: '古诗文翻译',   tierKey: 'poem',    tierLabel: '古诗',   points: 3,  dailyLimit: null, sortOrder: 60 },
  { taskCode: 'cn_interpretation', taskName: '古诗文翻译',   tierKey: 'prose',   tierLabel: '古文',   points: 6,  dailyLimit: null, sortOrder: 61 },
  { taskCode: 'cn_meaning',        taskName: '古诗情感',     tierKey: 'default', tierLabel: '一篇',   points: 4,  dailyLimit: null, sortOrder: 70 },
  { taskCode: 'en_vocabulary',     taskName: '英语背单词',   tierKey: '10',      tierLabel: '10 词',  points: 2,  dailyLimit: 2,    sortOrder: 80 },
  { taskCode: 'en_vocabulary',     taskName: '英语背单词',   tierKey: '15',      tierLabel: '15 词',  points: 4,  dailyLimit: 2,    sortOrder: 81 },
  { taskCode: 'en_vocabulary',     taskName: '英语背单词',   tierKey: '20',      tierLabel: '20 词',  points: 7,  dailyLimit: 2,    sortOrder: 82 },
];
```

> **给计划二的提示**：`math_targeted` 的档位从现有的 `[3,5,8,10]`（`TargetedConfigPage.tsx:25`）变成 `[1,3,5,10]`——**新增 1 题档、去掉 8 题档**。「1 题 2 分」是用户明确要的（spec §3.2 已注明）；去掉 8 题是因为它与「档位即可选项」的整数档不齐。前端那个 `COUNT_OPTIONS` 常量届时整个删掉、改读 `GET /api/points/me/rules`，所以真正生效的是本表的 `DEFAULT_RULES`。

**测试**（`levels.test.ts`，纯函数无需 mock）：

- `levelOf(0)` → 劈柴；`levelOf(499)` → 劈柴；`levelOf(500)` → 铸铁；`levelOf(1199)` → 铸铁；`levelOf(1200)` → 青铜；`levelOf(19999)` → 星耀；`levelOf(20000)` → 王者；`levelOf(999999)` → 王者
- `nextLevelOf(20000)` → `null`；`pointsToNextLevel(20000)` → `null`；`progressPercent(20000)` → 100
- `progressPercent(250)` → 50（劈柴 0 → 铸铁 500）
- `detectLevelUp(490, 510)` → `{ from: 劈柴, to: 铸铁 }`；`detectLevelUp(500, 510)` → `null`（没跨档）

**提交**：`feat(points): 段位常量与默认分值规则`

---

### Task 3: 仓储层（4 个 repo）

**Files:**
- Create: `apps/server/src/database/repositories/point-rules.repo.ts`
- Create: `apps/server/src/database/repositories/point-ledger.repo.ts`
- Create: `apps/server/src/database/repositories/student-points.repo.ts`
- Create: `apps/server/src/database/repositories/training-sessions.repo.ts`
- Modify: `apps/server/src/database/repositories/index.ts`（追加桶导出）
- Modify: `apps/server/src/database/repositories/types.ts`（如该文件集中放行类型，则把 4 个 `XxxRow` 加进去；否则行类型就近写在各自 repo 里——**先读该文件确认现状再决定**）

`PointRulesRepository`：
- `findByStudent(studentId): Promise<PointRuleRow[]>`（按 `sort_order` 排序）
- `insertIgnoreBatch(studentId, rules: DefaultRule[]): Promise<void>`——**懒初始化核心**。一条 SQL 插多行 + `INSERT IGNORE`（撞 `uniq_point_rules` 就跳过，不覆盖家长已改的值）
- `updateOne(studentId, taskCode, tierKey, { points, dailyLimit, isActive }): Promise<number>`——返回 `affectedRows`，`0` 说明该 `(taskCode, tierKey)` 不存在
- `findOne(studentId, taskCode, tierKey): Promise<PointRuleRow | null>`

`PointLedgerRepository`：
- `insert(row): Promise<{ id: number; duplicate: boolean }>`——用 `INSERT IGNORE`，`affectedRows === 0` 即撞了 `uniq_point_ledger_dedupe`，此时 `findByDedupeKey` 回查返回首次结果
- `findByDedupeKey(dedupeKey): Promise<PointLedgerRow | null>`
- `countTodayEarned(studentId, taskCode, dayStart: Date, dayEnd: Date): Promise<number>`
- `sumEarned(studentId): Promise<number>`、`sumAll(studentId): Promise<number>`（重建脚本用）
- `listByStudent(studentId, limit, offset): Promise<PointLedgerRow[]>`、`countByStudent(studentId): Promise<number>`

`StudentPointsRepository`：
- `upsertDelta(studentId, earnedDelta: number, balanceDelta: number, conn?)`——`INSERT ... ON DUPLICATE KEY UPDATE total_earned = total_earned + VALUES(total_earned), balance = balance + VALUES(balance)`
- `find(studentId): Promise<{ totalEarned: number; balance: number }>`——**无行时返回 `{ totalEarned: 0, balance: 0 }`**，不要抛错（新学生还没发过分）
- `overwrite(studentId, totalEarned, balance)`（重建脚本用）

`TrainingSessionsRepository`：
- `create(row): Promise<number>`
- `findById(id): Promise<TrainingSessionRow | null>`
- `completeOwned(id, studentId): Promise<number>`——`UPDATE ... SET status='completed', completed_at=NOW(3) WHERE id=? AND student_id=? AND status='in_progress'`，返回 `affectedRows`
- `incrementJudged(id, studentId): Promise<void>`——`UPDATE ... SET judged_count = judged_count + 1 WHERE id=? AND student_id=? AND status='in_progress'`

**关键约束**：`insertIgnoreBatch` 与 `upsertDelta` 必须能在**同一事务**里跑。`mysql2` 的写法是先 `pool.getConnection()` → `conn.beginTransaction()` → 用 `conn.execute` → `commit/rollback/release`。**照抄仓内已有的多语句事务写法**（先 `grep -rn "beginTransaction" apps/server/src` 找现成例子），不要自创。

**测试**（`*.repo.test.ts`，仓内既有 repo 测试是**断言 SQL 字符串**而非连库，照抄这个模式，例如 `main-error-books.repo.test.ts:101`）：
- `insertIgnoreBatch` 生成的 SQL 含 `INSERT IGNORE INTO point_rules`，参数按 rules 顺序展平
- `upsertDelta` 含 `ON DUPLICATE KEY UPDATE total_earned = total_earned + VALUES(total_earned)`
- `countTodayEarned` 的 SQL **不含 `CURDATE`**（钉住 §1.2 第 1 条），用 `created_at >= ? AND created_at < ?`
- `completeOwned` 含 `AND status = 'in_progress'`

**提交**：`feat(points): 积分四张表的仓储层`

---

### Task 4: `PointsService.award()` —— 发分引擎（本文最关键的一步）

**Files:**
- Create: `apps/server/src/modules/points/points.service.ts`
- Test: `apps/server/src/modules/points/points.service.test.ts`

```ts
export interface AwardInput {
  studentId: number;
  taskCode: string;
  tierKey?: string;          // 默认 'default'
  dedupeKey: string;         // 调用方拼，见 spec §4.4
  refType?: string | null;
  refId?: number | null;
}

export type AwardReason = 'daily_limit' | 'no_rule' | 'tier_inactive' | 'duplicate';

export interface AwardResult {
  pointsAwarded: number;     // 实际入账分（0 = 没发）
  balance: number;
  totalEarned: number;
  levelUp: { from: LevelInfo; to: LevelInfo } | null;
  reason?: AwardReason;
}
```

**逐步逻辑**（顺序不能变）：

1. 读该生该 `taskCode` 的规则列表（先跑懒初始化 `insertIgnoreBatch`，见 Task 5，这里假定规则已就位）。
2. 按 `tierKey ?? 'default'` 找规则。找不到 → 返回 `{ pointsAwarded: 0, reason: 'no_rule', ...当前余额 }`，**不抛错**。
3. 规则 `is_active === 0` → `reason: 'tier_inactive'`。
4. **每日上限检查**（仅当 `dailyLimit != null`）：`countTodayEarned(studentId, taskCode, startOfToday(), startOfTomorrow())` ≥ `dailyLimit` → `reason: 'daily_limit'`，`pointsAwarded: 0`。
5. 取发分前的 `totalEarned`（`studentPointsRepo.find`，无行时 0）。
6. 事务：`pointLedgerRepo.insert({...})`
   - `duplicate === true` → 回滚/不提交，回查 `findByDedupeKey` 返回**首次的 `points`** + `reason: 'duplicate'` + 当前余额（**不要**再把余额加上去）。
   - 否则 `studentPointsRepo.upsertDelta(studentId, points, points, conn)`。
7. 提交后读新的 `totalEarned`，`detectLevelUp(oldEarned, newEarned)`。
8. 返回 `{ pointsAwarded: points, balance, totalEarned, levelUp }`。

**时间工具的落点**——照抄 `vocabulary.service.ts:140` 的写法，放在本 service 里：

```ts
/** 服务器本地时区的当日 00:00。刻意不用 SQL 的 CURDATE()（DB 会话时区可能与应用不一致）。 */
private startOfToday(now = this.now()): Date {
  return new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 0, 0, 0);
}

private startOfTomorrow(now = this.now()): Date {
  const d = this.startOfToday(now);
  d.setDate(d.getDate() + 1);
  return d;
}

/** dedupe_key 里的 YYYY-MM-DD，同样用本地时区。**公开**——所有埋点靠它拼 key，
 *  不要在各模块重写一份日期格式化（Task 10/11 会调它）。 */
todayKey(now = this.now()): string {
  const d = this.startOfToday(now);
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${d.getFullYear()}-${mm}-${dd}`;
}
```

`now` 通过构造函数可选注入（`private readonly now: () => Date = () => new Date()`）——**这是让每日上限能测的关键**，否则测不了跨天。

`title`（流水展示文案）拼法：`` `${TASK_NAMES[taskCode]} · ${rule.tierLabel}` ``，例如「英语背单词 · 10 词」。

**测试**（`points.service.test.ts`，mock 4 个 repo）：
- 幂等：`dedupeKey` 已存在 → `pointsAwarded` 为**首次的值**、`reason: 'duplicate'`、`upsertDelta` **未被调用**
- 每日上限：`dailyLimit: 2` + `countTodayEarned` 返回 2 → `pointsAwarded: 0`、`reason: 'daily_limit'`、`insert` 未被调用
- `dailyLimit: null` → 跳过计数，`countTodayEarned` 未被调用
- `no_rule` / `tier_inactive` 两条分支
- 跨档：发分前 `totalEarned = 490`、本次 +10 → `levelUp.from.code === 'pichai'`、`levelUp.to.code === 'zhutie'`
- 未跨档：`500 → 510` → `levelUp === null`
- **兑换后段位不降**（这条放 Task 6 测，但语义钉在这里）：`totalEarned` 不变时 `levelOf` 结果不变

**提交**：`feat(points): 发分引擎（幂等 + 每日上限 + 跨档检测）`

---

### Task 5: 规则懒初始化 + 家长配置读写

**Files:**
- Create: `apps/server/src/modules/points/point-rules.service.ts`
- Test: `apps/server/src/modules/points/point-rules.service.test.ts`

- `ensureRules(studentId): Promise<void>`：读该生已有规则，与 `DEFAULT_RULES` 比对，**只补缺失的 `(taskCode, tierKey)`**，调 `insertIgnoreBatch`。读写规则的每个入口都先跑它。
- `listGrouped(studentId, opts?: { withDailyCounts?: boolean })`：返回按 `taskCode` 分组的规则。`withDailyCounts: true` 时对每个 `taskCode` 查一次 `countTodayEarned`，算出 `completedToday` / `remainingToday`（`dailyLimit == null` 时 `remainingToday = null`）。
- **`listTierKeys(studentId, taskCode): Promise<string[]>`**：返回该生该任务**已启用**（`is_active = 1`）的 `tierKey` 列表，按 `sort_order` 排。**Task 12 的两个 start 端点靠它做档位白名单校验**——没有它「档位即可选项」在后端就落不了地。
- `updateBatch(studentId, rules: Array<{ taskCode; tierKey; points; dailyLimit; isActive }>)`：**一个事务**里逐条 `updateOne`。任一 `affectedRows === 0` → 抛 `BadRequestException({ code: 3005, message: '档位不存在' })` 并回滚。校验 `0 <= points <= 9999`；`dailyLimit` 要么 `null` 要么 `1-99`。

**测试**：
- 库里已有 3 条、默认 15 条 → `insertIgnoreBatch` 只收到缺的 12 条
- 库里已全量 → `insertIgnoreBatch` 调用参数为空数组（或直接不被调）
- **家长改过的值不被覆盖**（钉住「懒初始化不回溯」这个有意决定）
- `updateBatch` 遇到不存在的档位 → 抛 3005
- `listTierKeys(studentId, 'math_targeted')` → `['1','3','5','10']`；家长把 `'5'` 置 `isActive: false` 后 → `['1','3','10']`
- `listTierKeys` 对**从未发过分的全新学生**也要先 `ensureRules` 再查，不能返回空数组（否则开练直接 400）

**提交**：`feat(points): 规则懒初始化与家长批量配置`

---

### Task 6: 兑换（奖励清单 + 兑换单 + 扣分）

**Files:**
- Create: `apps/server/src/database/repositories/reward-catalog.repo.ts`
- Create: `apps/server/src/database/repositories/point-redemptions.repo.ts`
- Create: `apps/server/src/modules/points/redemption.service.ts`
- Test: `apps/server/src/modules/points/redemption.service.test.ts`
- Modify: `apps/server/src/database/repositories/index.ts`（两个 repo 的桶导出）

**仓储一律放 `src/database/repositories/`**，不放 `src/modules/points/`——与仓内既有 20+ 个 repo 一致。

`RedemptionService`：

- `listCatalog(studentId)` / `saveCatalog(studentId, items)`：批量保存，**无 `id` 视为新增**，有 `id` 且属于该生则更新，列表里消失的 `id` 软删（`is_active = 0`）。
- `redeem(studentId, input)`，`input` 为 `{ type: 'cash', points }` 或 `{ type: 'reward', catalogId }`：
  1. 读 `controls`（`grep -rn "controls" apps/server/src` 确认是否已有 repo——`schema.sql:851` 有表但 spec §1 调研说是零代码，**大概需要新建 `src/database/repositories/controls.repo.ts`**，提供 `findByStudent` / `ensure(studentId)` 两个方法）。`reward_redemption_enabled === 0` → 抛 `BadRequestException({ code: 3004, message: '兑换已关闭' })`。
  2. `type: 'cash'`：读 `points_per_yuan`（默认 20），校验 `points > 0`，算 `cashAmount = points / pointsPerYuan`（保留 2 位，`ROUND(..., 2)`）；`type: 'reward'`：读 catalog 行，`is_active === 0` → 抛 `3003`；校验 `min_level_code`（非空时 `levelOf(totalEarned).index >= 该档 index`，不满足 → 抛 `3002`）；`points = row.points_cost`。
  3. 校验 `balance >= points` → 否则抛 `BadRequestException({ code: 3001, message: '积分余额不足' })`。
  4. 事务：插 `point_redemptions`（`status='pending'`）→ 拿 `id` → 插 `point_ledger`（`kind='redeem'`、`task_code='redeem'`、`points = -points`、`dedupe_key = 'redeem:<id>'`、`redemption_id = id`、`title = '兑换 · ' + 名称`）→ `upsertDelta(studentId, 0, -points, conn)` → 回写 `ledger_id`。
  5. 返回兑换单 + 新 `balance` + **`totalEarned`（必须没变）** + `level`（**必须没降**）。
- `listRedemptions(studentId, page)` / `setRedemptionStatus(studentId, id, status)`：只改 `status` / `fulfilled_at`，**绝不动积分**。归属校验：`WHERE student_id = ?`。

`listForStudent(studentId)`（学生端只读）：返回 catalog + 当前 `balance` / `level`，每项算 `affordable`（`balance >= points_cost`）、`levelOk`、`gap`（`max(0, points_cost - balance)`）。

**测试**：
- 余额不足 → 抛 3001，且**没有**任何流水写入
- 换钱：`points = 100`、`points_per_yuan = 20` → `cashAmount = 5.00`
- **兑换后 `totalEarned` 不变 → `levelOf` 结果不变**（段位只升不降的核心钉子）
- `reward_redemption_enabled = 0` → 抛 3004
- 未达 `min_level_code` → 抛 3002
- `setRedemptionStatus('fulfilled')` 不改任何流水

**提交**：`feat(points): 积分兑换（换钱/换奖励 + 流水 + 段位不降）`

---

## 4. 端点

### Task 7: 学生端查询端点

**Files:**
- Create: `apps/server/src/modules/points/points.controller.ts`
- Create: `apps/server/src/modules/points/dto/points.dto.ts`
- Create: `apps/server/src/modules/points/points.module.ts`
- Modify: `apps/server/src/app.module.ts`（`imports` 追加 `PointsModule`）
- Test: `apps/server/src/modules/points/points.controller.test.ts`

`@Controller('api/points')`、`@UseGuards(JwtAuthGuard, RolesGuard)`、`@Roles('student')`。

`points.module.ts` 的装配（**`exports` 必须有，否则其它模块注入不到 `PointsService`**）：

```ts
@Module({
  imports: [ParentModule],   // 拿 ParentService.requireOwnedStudent（Task 8 用）
  controllers: [PointsController, ParentPointsController],
  providers: [
    PointsService, PointRulesService, RedemptionService,
    PointRulesRepository, PointLedgerRepository, StudentPointsRepository,
    TrainingSessionsRepository, RewardCatalogRepository, PointRedemptionsRepository,
    ControlsRepository,
  ],
  exports: [PointsService, PointRulesService],   // 埋点模块注入 PointsService；Task 12 的 start 端点注入 PointRulesService
})
export class PointsModule {}
```

注意 `ParentPointsController` 在 Task 8 才建——Task 7 先只挂 `PointsController`，Task 8 再补。

| 方法 | 路径 | Service 方法 | 返回 |
|---|---|---|---|
| GET | `me` | `getOverview(studentId)` | `{ balance, totalEarned, todayEarned, level, nextLevel, pointsToNextLevel, progressPercent }` |
| GET | `me/ledger?page&pageSize` | `getLedger(studentId, page, pageSize)` | `{ items:[{id,kind,title,points,createdAt,refType}], total, page, pageSize }` |
| GET | `me/rules` | `listGrouped(studentId, { withDailyCounts: true })` | `{ tasks:[{taskCode, taskName, tiers:[{tierKey,tierLabel,points,dailyLimit,completedToday,remainingToday,isActive}]}] }` |
| GET | `me/rewards` | `listForStudent(studentId)` | `{ balance, level, items:[{id,name,description,pointsCost,minLevelCode,affordable,levelOk,gap}] }` |

- `todayEarned` = 当天 `kind='earn'` 的 `SUM(points)`（用 `startOfToday`/`startOfTomorrow` 传参）。
- `page` 默认 1、`pageSize` 默认 20、**`pageSize` 上限 100**（越界 400）。
- **`me/rules` 只返回 `isActive = 1` 的档位**——它是「学生开练能选哪些档」的依据，下架档位不该出现在下拉里。`is_active` 字段仍回传，便于调试。

**测试**（照抄 `meaning.controller.test.ts` 的 controller 测试模式）：
- 无 token → 401；`@Roles('student')` 生效（家长 token 访问 → 403）
- `pageSize=0` / `pageSize=101` / `page='abc'` → 400
- `me` 在 `student_points` 无行时返回全 0 + 劈柴，**不抛 404**

**提交**：`feat(points): 学生端积分查询端点`

---

### Task 8: 家长端端点

**Files:**
- Create: `apps/server/src/modules/points/parent-points.controller.ts`
- Modify: `apps/server/src/modules/points/points.module.ts`（`controllers` 追加）
- Modify: `apps/server/src/modules/parent/parent.service.ts`（`requireOwnedStudent` 从 `private` 改 `public`）
- Modify: `apps/server/src/modules/points/points.module.ts`（`imports` 加 `ParentModule`）
- Test: `apps/server/src/modules/points/parent-points.controller.test.ts`

`@Controller('api/parent')` + `@Roles('parent')`（与 `ParentController` 同前缀，Nest 允许同前缀多 controller）。

**归属校验**：每个端点第一行 `await this.parentService.requireOwnedStudent(parentUserId, studentId)`。因此 `ParentService.requireOwnedStudent` 要改成 public（**只改可见性，不动逻辑**）。

| 方法 | 路径 | Zod schema / 说明 |
|---|---|---|
| GET | `students/:id/points` | 概览 |
| GET | `students/:id/points/rules` | `listGrouped(id, { withDailyCounts: true })` |
| PUT | `students/:id/points/rules` | `z.object({ rules: z.array(z.object({ taskCode: z.string().min(1).max(40), tierKey: z.string().min(1).max(20), points: z.number().int().min(0).max(9999), dailyLimit: z.number().int().min(1).max(99).nullable(), isActive: z.boolean() })).min(1) })` |
| GET | `students/:id/points/ledger?page&pageSize` | 同学生端 |
| GET | `students/:id/reward-catalog` | 奖励清单 |
| PUT | `students/:id/reward-catalog` | `z.object({ items: z.array(z.object({ id: z.number().int().positive().optional(), name: z.string().min(1).max(100), description: z.string().max(300).nullable(), pointsCost: z.number().int().min(1).max(999999), minLevelCode: z.string().max(20).nullable(), isActive: z.boolean(), sortOrder: z.number().int().min(0).max(9999) })) })` |
| POST | `students/:id/points/redeem` | `z.discriminatedUnion('type', [ z.object({ type: z.literal('cash'), points: z.number().int().min(1) }), z.object({ type: z.literal('reward'), catalogId: z.number().int().positive() }) ])` |
| GET | `students/:id/redemptions?page` | 兑换记录 |
| PATCH | `redemptions/:id` | `z.object({ status: z.enum(['pending','fulfilled']) })`——`redemptions/:id` **不带 `students/` 前缀** |
| GET | `students/:id/points/settings` | `{ pointsPerYuan, rewardRedemptionEnabled }`（读 `controls`） |
| PUT | `students/:id/points/settings` | `z.object({ pointsPerYuan: z.number().int().min(1).max(9999).optional(), rewardRedemptionEnabled: z.boolean().optional() })`，至少给一个字段，否则 400 |

> **`points_per_yuan` 的配置端点**（spec §4.2 要求家长可配）走 `points/settings`，**不要塞进 rules 的批量保存**——汇率和分值是两个关注点，混在一个 payload 里以后加设置项时容易打架。该端点落地在 `ControlsRepository.ensure(studentId)` + `update(studentId, patch)`。

**`PATCH redemptions/:id` 的归属校验**：这个路径没有 `studentId`，要**先按 `id` 查兑换单拿到 `student_id`，再 `requireOwnedStudent`**；查不到 → 404 `1002`。

**错误码**：`3001` 余额不足 / `3002` 未达段位 / `3003` 奖励已下架 / `3004` 兑换已关闭 / `3005` 档位不存在。

**测试**：
- 每个端点：无 token 401、学生 token 403
- 操作别人家孩子 → 403 `1005`
- `points: -1` / `points: 10000` / `dailyLimit: 0` → 400
- `redeem` 的 discriminated union：`{type:'cash'}` 缺 `points` → 400

**提交**：`feat(points): 家长端分值与兑换端点`

---

## 5. 埋点接入

### Task 9: 丙类 —— `mainline_lesson` + `math_paper`（先做，打通发分链路）

**Files:**
- Modify: `apps/server/src/modules/progress/progress.service.ts`（`:283-291` 两个 return 分支）
- Modify: `apps/server/src/modules/progress/progress.module.ts`（`imports` 加 `PointsModule`）
- Modify: `apps/server/src/modules/exams/exams.service.ts`（`:356` 之后）
- Modify: `apps/server/src/modules/exams/exams.module.ts`（`imports` 加 `PointsModule`）
- Modify: `apps/server/src/modules/points/points.module.ts`（`exports: [PointsService]`）
- Test: `apps/server/src/modules/progress/progress.service.test.ts`、`apps/server/src/modules/exams/exams.service.test.ts`

**`mainline_lesson`**（`progress.service.ts:283-291`）：

```ts
const nextLesson = await this.contentService.getNextLesson(lessonId);
if (nextLesson) {
  const nextUnitId = nextLesson.unitId !== progress.currentUnitId ? nextLesson.unitId : null;
  await this.progressRepo.advanceLesson(progress.id, nextLesson.id, nextUnitId);
  await this.awardLessonPoints(studentId, lessonId);   // ← 新增
  return { advanced: true, nextLessonId: nextLesson.id };
}
// No more lessons: mark subject completed
await this.progressRepo.markCompleted(progress.id);
await this.awardLessonPoints(studentId, lessonId);     // ← 新增
return { advanced: true, completed: true };
```

私有方法：

```ts
/** 学完一课发分。刻意吞掉异常：积分是激励层，发分失败绝不能挡住主线推进。
 *  dedupe_key 不带日期 —— 一课只能算一次。 */
private async awardLessonPoints(studentId: number, lessonId: number): Promise<AwardResult | null> {
  try {
    return await this.pointsService.award({
      studentId, taskCode: 'mainline_lesson',
      dedupeKey: `lesson:${studentId}:${lessonId}`,
      refType: 'lesson', refId: lessonId,
    });
  } catch (err) {
    this.logger.warn(`awardLessonPoints failed (student=${studentId}, lesson=${lessonId}): ${err}`);
    return null;
  }
}
```

`AwardResult` 是 Task 4 定义的类型，从 `./dto/points.dto.js`（或 `points.service.js`）导出——**其它模块要 `import type { AwardResult }` 拿到同一个类型，别在各处重新声明一个同形接口**。

`ProgressService` 构造函数注入 `private readonly pointsService: PointsService`。

**关键**：`points.service.ts` 里已有一个「领先后台任务」的做法吗？没有。`ExplanationCacheService` 是 fire-and-forget 的既有例子（`judge-core.service.ts:192` 直接 `this.explanationCache.ensureExplanation(q)` 不 await）。**这里要 `await`**——因为发分结果要跟着响应回前端（提示「+10 分」）。但**必须 try/catch**，别让积分故障阻塞主线（上面已包）。

**响应形状（wire 形状，与 `AwardResult` 不同，别混）**：`updateProgress` 的两个 return 各加一个可选字段

```ts
points?: { awarded: number; balance: number; levelUp: { from: string; to: string } | null }
```

`from` / `to` 是**段位 code 字符串**（`'pichai'` / `'zhutie'`），不是 `LevelInfo` 对象——前端只需要 code 去查图标。映射写在一处：

```ts
const points = result ? {
  awarded: result.pointsAwarded,
  balance: result.balance,
  levelUp: result.levelUp ? { from: result.levelUp.from.code, to: result.levelUp.to.code } : null,
} : undefined;
```

`advanced: false` 的分支**不加**（没发分）。学生端如何消费在计划二。

**`math_paper`**（`exams.service.ts`，`markSubmitted` 之后、`summarize` 之前）：

```ts
await this.examSessionsRepo.markSubmitted(session.id);
const points = await this.awardPaperPoints(session.student_id, session.id);  // ← 新增
const finalAnswers = await this.examSessionsRepo.findAnswersBySession(session.id);
return { ...this.summarize(questions.length, finalAnswers), points };
```

`dedupeKey = \`paper:${session.id}\``、`refType: 'exam_session'`。同样 try/catch。`submit()`（`:225`）已有幂等判重，但 `finalizeSession` 也可能被超时自动收卷路径调用——**dedupe_key 是第二道保险**。

**测试**：
- `progress.service.test.ts`：学完最后一卡（有下一课）→ `pointsService.award` 被调用一次，参数 `taskCode='mainline_lesson'`、`dedupeKey='lesson:<sid>:<lid>'`
- 学完最后一课（无下一课，`markCompleted`）→ 同样被调用
- `advanced: false` 的分支（`reviewing` / `not_current_lesson`）→ **未被调用**
- `pointsService.award` 抛错 → `updateProgress` **仍正常返回**（不冒泡）
- `exams.service.test.ts`：`submit` → `award` 被调用，`dedupeKey='paper:<sessionId>'`

**提交**：`feat(points): 学完一课与交卷发分`

---

### Task 10: 甲类（一）—— `error_fix`

**Files:**
- Modify: `apps/server/src/database/repositories/main-error-books.repo.ts:108-114`（返回 `affectedRows`）
- Modify: `apps/server/src/modules/practice/judge-core.service.ts:201-208`
- Modify: `apps/server/src/modules/practice/practice.module.ts`（`imports` 加 `PointsModule`）
- Test: `apps/server/src/database/repositories/main-error-books.repo.test.ts`、`apps/server/src/modules/practice/judge-core.service.test.ts`

**第一步：repo 返回值改造**

```ts
/** 题中心变体清零：该学生此题所有未清行一次性 is_cleared=1（不限 source）。
 *  返回 affectedRows —— 积分体系据此判定「确实清掉了一条未清零的错题」，
 *  首次就答对的题 affectedRows=0，不发分（见 spec §6.5）。 */
async clearUnclearedByStudentQuestionId(studentId: number, questionId: number): Promise<number> {
  const [result] = await this.pool.execute<ResultSetHeader>(
    `UPDATE main_error_books SET is_cleared = 1, cleared_at = NOW(3)
     WHERE student_id = ? AND is_cleared = 0 AND question_id = ?`,
    [studentId, questionId],
  );
  return result.affectedRows;
}
```

**先 grep 所有调用点**（`grep -rn "clearUnclearedByStudentQuestionId" apps/server/src`），确认改成返回 `number` 后其它调用点不炸（返回值从 `void` 变 `number` 对 `await` 调用点是兼容的）。

**第二步：发分**（`judge-core.service.ts:201-208`）

```ts
} else {
  // 答对 -> 清零该题所有未清错题记录（不限 source；best-effort，失败不阻断）
  try {
    const cleared = await this.mainErrorRepo.clearUnclearedByStudentQuestionId(input.studentId, input.questionId);
    // affectedRows > 0 = 确实清掉了一条未清零的错题 → 发「错题订正」分。
    // 首次就答对（本无错题）affectedRows=0，不发分。考试补判路径不参与（见下）。
    if (cleared > 0 && input.source !== 'exam') {
      await this.awardErrorFix(input.studentId, input.questionId);
    }
  } catch (err) { /* 原样保留 */ }
}
```

`awardErrorFix` 同样 try/catch 吞异常，`dedupeKey = \`err:${studentId}:${questionId}:${ymd}\``（`ymd` 从 `PointsService` 暴露一个公开的 `todayKey()`，别在 judge-core 里重写一份日期格式化）。

**为什么排除 `source === 'exam'`**：考试补判（`exams.service.ts:322` 调 `judgeCore.judgeQuestion({source:'exam'})`）会在交卷时批量补判在途题。若参与发分，学生会因为「考试时留空没提交、交卷时被补判」而额外拿到订正分，语义不对。**考试的分由 `math_paper` 一次性给**。

**测试**：
- repo：`clearUnclearedByStudentQuestionId` 返回 `affectedRows`（mock pool 返回 `[{affectedRows: 2}]` → 断言返回 `2`）
- `cleared = 0` → `pointsService.award` **未被调用**（首次答对不发分）
- `cleared = 1` + `source='error_practice'` → 被调用
- `cleared = 1` + `source='exam'` → **未被调用**
- `award` 抛错 → 判题结果仍正常返回（不冒泡）

**提交**：`feat(points): 错题订正发分（按清零影响行数判定）`

---

### Task 11: 甲类（二）—— 语文三专项

**Files:**
- Modify: `apps/server/src/modules/training/training.controller.ts:175`（`dictation/judge` 加 `@CurrentUser()`）
- Modify: `apps/server/src/modules/training/training.service.ts:158`（`judgeDictation` 加 `studentId`）
- Modify: `apps/server/src/modules/training/training.controller.ts:240`（`interpretation/judge` 加 `@CurrentUser()`）
- Modify: `apps/server/src/modules/training/training.service.ts`（`judgeInterpretation` 加 `studentId`）
- Modify: `apps/server/src/modules/training/meaning.controller.ts:57`（`judge` 加 `@CurrentUser()`）
- Modify: `apps/server/src/modules/training/meaning.service.ts:124`（`judgeMeaning` 加 `studentId`）
- Modify: `apps/server/src/modules/training/training.module.ts`（`imports` 加 `PointsModule`）
- Test: 三个 service 的测试文件各补用例

**共同点**：三个 judge 现在都**不接 `studentId`**，等于无状态纯函数。发分要 `studentId`，所以三处 controller 都要加 `@CurrentUser() user: JwtUser` 并把 `user.sub` 传下去。

**`judgeDictation` / `judgeInterpretation`（按体裁取档）**：读篇目的 `genre`。

```ts
// 判题结果算完后
let pointsAwarded = 0;
let awardReason: string | undefined;
if (passage.genre === 'poem' || passage.genre === 'prose') {
  const r = await this.pointsService.award({
    studentId, taskCode: 'cn_dictation', tierKey: passage.genre,
    dedupeKey: `dict:${studentId}:${passage.id}:${this.pointsService.todayKey()}`,
    refType: 'passage', refId: passage.id,
  });
  pointsAwarded = r.pointsAwarded;
  awardReason = r.reason;
} else {
  awardReason = 'genre_unset';   // spec §4.1：未标定体裁不发分，不猜、不默认古诗
  this.logger.warn(`dictation award skipped: genre unset (passageId=${passage.id})`);
}
return { ...判题结果, pointsAwarded, awardReason };
```

解释专项同理（`taskCode: 'cn_interpretation'`、`dedupeKey: interp:<sid>:<pid>:<ymd>`）。`genre` 字段需要 `ChinesePassagesRepository` 的 SELECT 带上——**先读 `chinese-passages.repo.ts` 确认 `SELECT *` 还是列举字段**；若是列举，要在 `findById` / `findVerifiedByIds` / `findRandomVerified` 等所有被用到的方法里补 `genre`。

**`judgeMeaning`（`default` 档，整篇答完时发一次）**：判题是**逐句**的，只有该篇**最后一个可作答句**判完才发分。

```ts
// meanings 已算出（meaning.service.ts:141）
const answerableIndexes = meanings.map((m, i) => (m != null ? i : -1)).filter((i) => i >= 0);
const isLastAnswerable = input.sentenceIndex === answerableIndexes[answerableIndexes.length - 1];
// ...判题逻辑...
const award = isLastAnswerable
  ? await this.pointsService.award({
      studentId, taskCode: 'cn_meaning',
      dedupeKey: `meaning:${studentId}:${passage.id}:${this.pointsService.todayKey()}`,
      refType: 'passage', refId: passage.id,
    })
  : null;
return { ...判题结果, pointsAwarded: award?.pointsAwarded ?? 0, awardReason: award?.reason };
```

**注意**：`meanings[i] == null` 表示该句没有标准含义（`answerable: false`，见 `meaning.service.ts:102`）。所以「整篇答完」= 最后一个 **answerable** 的句下标，不是 `sentences.length - 1`。**这是本任务最容易写错的一处**。

**测试**：
- `genre = 'poem'` → `tierKey: 'poem'`；`genre = null` → `award` **未被调用**且 `awardReason === 'genre_unset'`
- `cn_meaning`：非最后一句 → 未调用；最后一句 → 调用一次
- **最后一句是 `answerable: false` 时应由前一个 answerable 句触发**（构造 `sentences.length = 5`、`meanings[4] = null`、`meanings[3] != null`，断言 `sentenceIndex=3` 发分、`sentenceIndex=4` 不发也不报错）
- `award` 抛错 → 判题结果仍正常返回

**提交**：`feat(points): 语文三专项发分（按体裁/整篇答完）`

---

### Task 12: 乙类 —— `training_sessions` + `complete`，接数学专项与背单词

**Files:**
- Modify: `apps/server/src/modules/training/training.service.ts:480`（`startTargetedPractice` 建会话）
- Modify: `apps/server/src/modules/training/training.controller.ts:116`（返回体带 `sessionId`）
- Modify: `apps/server/src/modules/training/vocabulary.service.ts:154`（`start` 建会话）
- Modify: `apps/server/src/modules/training/vocabulary.controller.ts:56`（返回体带 `sessionId`）
- Modify: `apps/server/src/modules/training/training.controller.ts`（新增 `sessions/:id/complete`）
- Modify: `apps/server/src/modules/training/training.controller.ts:40`（`judge` 加可选 `sessionId`）
- Modify: `apps/server/src/modules/training/training.module.ts`（providers 加 `TrainingSessionsRepository`）
- Test: `apps/server/src/modules/training/training.service.test.ts`、`vocabulary.service.test.ts`

**第一步：`count` 只能是已配档位（把「档位即可选项」落到后端）**

spec §3 定案 7 要求「学生开练只能在家长配的档位里选」。**光改前端不够**——现在两个 start 端点的校验是范围式的（专项 `1-20`、背单词 `10-20`），学生直接传 `count=13` 就绕过了档位设计。要改成**白名单校验**：

```ts
// 两个 start 端点都要加，放在原有范围校验之前
const allowed = await this.pointRulesService.listTierKeys(studentId, 'math_targeted');
// allowed 形如 ['1', '3', '5', '10']（只含 is_active = 1 的档位）
if (!allowed.includes(String(count))) {
  throw new BadRequestException(`题量仅允许 ${allowed.join(' | ')}`);
}
```

背单词同理（`taskCode: 'en_vocabulary'`，`allowed` 形如 `['10','15','20']`）。`listTierKeys` 是 Task 5 的 `PointRulesService` 要新增的公开方法（**先跑 `ensureRules` 再查**，否则新学生拿到空数组、所有请求都 400）。

原有范围校验（`1-20` / `10-20`）**保留**——它是更外层的兜底，防止脏数据把 `count` 撑到离谱值。

**第二步：建会话**

```ts
// startTargetedPractice 里，抽到题之后
const tierKey = String(count);   // 已经过白名单校验，必是已配档位
const sessionId = await this.trainingSessionsRepo.create({
  student_id: input.studentId, task_code: 'math_targeted', subject_id: input.subjectId,
  tier_key: tierKey, expected_count: rows.length, ref_type: 'question', ref_id: null,
});
return { questions: [...], sessionId };
```

`tier_key` 用**前端选的档位**（已校验在白名单内），`expected_count` 用**后端实际抽到的题数**（`rows.length`）——两者可能不等（题池不够时抽不满）。发分按 `tier_key` 走规则，`expected_count` 只作审计留痕。

背单词同理：`tier_key = String(count)`、`task_code: 'en_vocabulary'`、`expected_count = 实际词数`。

**注意**：`TrainingSessionsRepository.create` 的入参用 **snake_case**（`student_id` / `task_code` / `tier_key` / `expected_count` / `ref_type` / `ref_id`），与 `MainErrorBooksRepository.create`（`main-error-books.repo.ts:14-23`）一致——**别自创 camelCase 入参**，仓内 repo 层统一 snake_case。

**`complete` 端点**：

```ts
/** 训练会话完成发分。幂等：重复调用返回首次结果，不报错（前端重试要拿到同样的返回）。 */
@Post('sessions/:id/complete')
async completeSession(@Param('id', ParseIntPipe) id: number, @CurrentUser() user: JwtUser) {
  const session = await this.trainingSessionsRepo.findById(id);
  if (!session || session.student_id !== user.sub) {
    throw new NotFoundException({ code: 1002, message: '训练会话不存在' });
  }
  const affected = await this.trainingSessionsRepo.completeOwned(id, user.sub);
  // affected === 0 → 已完成过。仍走 award（dedupe_key 会挡住重复加分、回首次值）。
  const points = await this.pointsService.award({
    studentId: user.sub, taskCode: session.task_code, tierKey: session.tier_key,
    // 前缀按任务分（spec §4.4）：背单词用 vsess、其余训练会话用 tsess。别写死一个。
    dedupeKey: `${session.task_code === 'en_vocabulary' ? 'vsess' : 'tsess'}:${id}`,
    refType: 'training_session', refId: id,
  });
  return {
    pointsAwarded: points.pointsAwarded, balance: points.balance, totalEarned: points.totalEarned,
    // wire 形状：段位用 code 字符串（同 Task 9），不是 LevelInfo 对象
    levelUp: points.levelUp ? { from: points.levelUp.from.code, to: points.levelUp.to.code } : null,
    ...(affected === 0 || points.reason === 'duplicate' ? { reason: 'already_completed' as const }
        : points.reason ? { reason: points.reason } : {}),
  };
}
```

**`judge` 加可选 `sessionId`**（只用于审计留痕）：`training.controller.ts:40` 的 `judge` 加 `@CurrentUser()`（**现已无**，先确认）与 `dto.sessionId?`；非空时调 `trainingSessionsRepo.incrementJudged(dto.sessionId, user.sub)`，失败静默（审计不该影响判题）。

**测试**：
- `startTargetedPractice` 返回 `sessionId`；`tierKey` 等于**实际抽到的题数**（题池只有 7 题时 `tierKey='7'`，不是前端传的 `'10'`）
- `completeSession` 首次 → `award` 被调用一次、`reason` 无
- `completeSession` 第二次 → 仍 200/201，`reason: 'already_completed'`，`pointsAwarded` 等于首次值
- 别人家学生的 session → 404 `1002`
- `judge` 带非法 `sessionId` → 判题正常返回（不 500）

**提交**：`feat(points): 训练会话表与整批发分（数学专项/背单词）`

---

### Task 13: 快照重建脚本 + 文档同步

**Files:**
- Create: `apps/server/src/scripts/rebuild-student-points.ts`
- Modify: `docs/API接口与数据流设计文档.md`（新增端点清单 + 数据流）
- Modify: `docs/api/openapi.yaml`（**必须与上文同步**，见 CLAUDE.md 硬规则）
- Modify: `docs/K12智学系统-产品需求文档.md`（新增 §7.13「闯关积分与段位」）
- Modify: `docs/ai-core-changelog.md`（记本次日期流水）
- Modify: `tools/data-refinery/src/dictation_cli.py`（加 `--export-genre` / `--set-genre`）

**重建脚本**（`npx tsx src/scripts/rebuild-student-points.ts`）：

遍历 `SELECT DISTINCT student_id FROM point_ledger`，对每个学生算 `SUM(points) WHERE kind='earn'` 与 `SUM(points)`，`studentPointsRepo.overwrite(studentId, totalEarned, balance)`，打印每行前后对比。**只读流水、不写流水**。用途：快照与流水不一致时手工修复。

**体裁标定工具**（`dictation_cli.py`）：

- `--export-genre`：出待标定清单（`SELECT id, work_title, dynasty, genre FROM chinese_passages WHERE verified = 1 ORDER BY semester, sort_order`），Markdown 表格，`genre` 空的行标 `待定`。
- `--set-genre --id <n> --genre poem|prose`：单篇标定。校验 `genre ∈ {poem, prose}`，`UPDATE` 后打印该篇 `work_title`。
- `--set-genre --input <file>`：批量，文件格式一行一条 `id<TAB>poem|prose`，跳过空行与 `#` 注释。
- **不用 LLM 猜体裁**（spec §4.1：不猜、不默认）。工具只负责读写。

**文档要点**：
- API 文档新增 §4.19（学生端积分 4 个端点）+ §4.20（家长端积分 9 个端点）+ §4.21（训练会话 complete）+ §6.23 数据流；openapi.yaml 同步（**记 `'201'` 给 POST**）。
- PRD §7.13 写清：8 个任务的分值口径、段位表、每日上限语义、兑换规则、**兑换不可撤销**这个已知限制。
- `changelog` 记：本次做了什么、每日上限为何不用 `CURDATE()`、为什么 `error_fix` 排除 exam source、为什么 `cn_meaning` 用最后一个 answerable 句。

**测试**：脚本手工跑一遍，确认打印的前后对比里 `totalEarned`/`balance` 与流水 SUM 一致。

**提交**：`feat(points): 快照重建脚本、体裁标定工具与文档同步`

---

## 6. 验证（全量）

```bash
cd /Users/lichao/Downloads/claude/imooc/ai_k12/apps/server
npm test                    # 期望：748 + 新增用例全绿
npm run build               # tsc + copy-assets
```

起后端（**必须用 `node dist/main.js`**，`npx tsx src/main.ts` 的 DI 是坏的）：

```bash
cd /Users/lichao/Downloads/claude/imooc/ai_k12/apps/server && node dist/main.js
```

手工串一遍端到端（用真实学生 token）：

```bash
BASE=http://localhost:3000/api
TOKEN=<学生 token>
PT=<家长 token>

curl -s -H "Authorization: Bearer $TOKEN" $BASE/points/me | jq
# 期望：balance=0, totalEarned=0, level.code="pichai", nextLevel.code="zhutie", pointsToNextLevel=500

curl -s -H "Authorization: Bearer $TOKEN" $BASE/points/me/rules | jq '.data.tasks[] | {taskCode, tiers: [.tiers[] | {tierKey, points}]}'
# 期望：15 条档位（含 math_targeted 的 1/3/5/10、en_vocabulary 的 10/15/20）

# 家长改分值
curl -s -X PUT -H "Authorization: Bearer $PT" -H 'Content-Type: application/json' \
  -d '{"rules":[{"taskCode":"error_fix","tierKey":"default","points":7,"dailyLimit":5,"isActive":true}]}' \
  $BASE/parent/students/<sid>/points/rules | jq

# 学生端应立即读到新值
curl -s -H "Authorization: Bearer $TOKEN" $BASE/points/me/rules | jq '.data.tasks[] | select(.taskCode=="error_fix")'
# 期望：points=7, dailyLimit=5

# 换钱：余额不足应报 3001
curl -s -X POST -H "Authorization: Bearer $PT" -H 'Content-Type: application/json' \
  -d '{"type":"cash","points":100}' $BASE/parent/students/<sid>/points/redeem | jq
# 期望：code=3001
```

再手工做一次「学完一课」，`GET /points/me` 应看到 `totalEarned=10`、`todayEarned=10`；连做 50 次同一课（`dedupe_key` 不变）应**仍是 10**。

---

## 7. 风险与注意

| 项 | 注意 |
|---|---|
| `clearUnclearedByStudentQuestionId` 改返回值 | `grep -rn` 所有调用点确认兼容；`Promise<void> → Promise<number>` 对 `await` 调用者向后兼容 |
| 循环依赖 | `PointsModule imports ParentModule`（拿 `requireOwnedStudent`）；`ProgressModule` / `PracticeModule` / `TrainingModule` / `ExamsModule` imports `PointsModule`。ParentModule **不**导入这四个中的任何一个，故无环。若 `tsc`/启动报环，改成把归属校验下沉为 `PointsModule` 自己 `@Inject` `StudentsRepository` 的私有方法 |
| 积分故障不能阻塞学习 | **每一个埋点都要 try/catch 吞异常**（Task 9/10/11/12）。主线和判题的可用性优先于积分 |
| DI 坑 | `PointsService` 的构造函数参数**不要用 interface 类型**，否则 Nest 发 `design:paramtypes` 时写成 `Object`、启动直接失败（CLAUDE.md 记过这个坑）。需要注入「当前时间」就用带默认值的具体类型或 `@Optional()` |
| `genres` 未标定 | 不发分 + `logger.warn` 留痕，**不猜、不默认按古诗** |
| 抽不满题 | `tierKey` 用实际题数，可能落空 → `award` 回 `no_rule`、`pointsAwarded: 0`。**如实返回，别偷偷按请求档位给分** |
| 快照漂移 | 快照只增不改语义；不一致时用 Task 13 的脚本从流水重建 |
| 每日上限跨天 | 不用 `CURDATE()`；`now()` 可注入以便测试跨天 |
