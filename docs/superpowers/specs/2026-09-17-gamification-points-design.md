# 闯关积分与段位体系 · 设计

日期：2026-09-17
状态：**待实施**
相关：`docs/K12智学系统-产品需求文档.md`、`docs/API接口与数据流设计文档.md`、`docs/api/openapi.yaml`、`apps/server/src/modules/points/`（新建）、`apps/web/src/components/business/`、`tools/db/migrations/`

---

## 1. 定位与边界

把系统从「只有主线学完一课有庆祝页」升级为完整的闯关游戏：

**学生完成 8 类任务得积分 → 积分累计升 9 个段位 → 家长可配分值/上限 → 家长可把积分兑成钱或奖励。**

**边界**：

- 积分是**平台级**的，不分学科、不分轨道——主线、训练轨的任务汇入同一个积分池，段位全局唯一。
- 积分**不影响**任何既有门禁：不清零错题、不替代错题本、不参与主线解锁判定。它是纯激励层，加在既有流程**旁边**而不是里面。
- 辅线答疑（`auxiliary`）**不产生积分**——答疑不是「完成任务」。
- 语文古诗文专项仍是独立子系统（不入错题本、不参与门禁），但它**参与积分**——这是本次唯一新增的跨子系统耦合点，且是单向的（专项只调 `PointsService`，不被积分反向影响）。

---

## 2. 调研结论（决定了工程难度）

1. **积分/段位/奖励在代码里完全不存在**。后端无表无端点；前端 `RewardCard.tsx` 是死组件；`/student/profile`、`/student/rewards`、`/parent/rewards` 三个路由全是 `Placeholder`（`routes/index.tsx:339/366/367`）。
2. **7 个训练任务里只有「数学卷子」有会话级的完成事件**（`exams.service.ts:356 markSubmitted`，天然幂等）。其余 6 项没有会话概念——但**只有 2 项真的需要**（`math_targeted` / `en_vocabulary`，因为它们是「档位打包价」）；另外 4 项（错题订正、默写、解释、含义）的判题函数本身就是天然的逐目标发分点，见 §6.1。
3. **单元检测、期中考试、期末考试在代码里不存在**。只有 `units.is_midterm_boundary`（`units.repo.ts:45`）和 `next_unlock_type` 字段，而 `nextUnlockType` 实际只会是 `'lesson'` / `'practice'`（`progress.service.ts:294`）。→ **本期不给这三个节点发分**。
4. **家长端缺「当前查看哪个孩子」的上下文**。`ParentLayout.tsx:56` 的下拉是硬编码假数据。→ 动工前必须先补。
5. **`chinese_passages` 没有体裁列**（`schema.sql:309`，当初特意「不加体裁列」）。要分古诗/古文必须新增 `genre`。
6. `targeted` 现可自由选 1–20 题（`training.service.ts:480`）、背单词可自由选 10–20 词（`vocabulary.controller.ts:65`）。已裁决改为**档位即可选项**。

---

## 3. 定案清单

用户逐条裁决过。改这里之前先确认不是把某个刻意的决定「统一」掉了。

| # | 议题 | 结论 |
|---|---|---|
| 1 | 给分口径 | **完成即给，不看对错**（做错也全额给） |
| 2 | 段位升降 | **只升不降**。段位按「累计获得」算；兑换只扣「可用余额」 |
| 3 | 防刷分 | 每个任务都能配「每日最多 N 次」；英语默认 2，其余默认不限 |
| 4 | 庆祝强度 | 两级：小任务 → 右下角 `+N 分` 轻反馈；大任务（交卷）/ 升段位 → 全屏庆祝 |
| 5 | 兑换操作者 | **家长端操作**，学生端只能看；线下给现金，不走支付 |
| 6 | 古诗文体裁 | `chinese_passages` 新增 `genre` 列（`'poem'`/`'prose'`），**人工标定** |
| 7 | 档位匹配 | **档位即可选项**：学生开练只能在家长配的档位里选，不许自由填数 |
| 8 | 古诗文单位 | 三类专项统一按「**一篇**」给分（含义专项选 3 首 = 3×分值） |
| 9 | 主线范围 | 纳入，但**只给「学完一课」**发分（单元检测/期中期末未实现，见 §2.3） |
| 10 | 错题口径 | 两条路径共用一条规则 `error_fix`，靠 `main_error_books` 清零影响行数去重（见 §6.5） |
| 11 | 分段位阈值 | **全局固定**，家长不可调 |
| 12 | 庆祝动画 | **Canvas 粒子烟花**，约 3 秒自动结束（不用 `✦✧` 装饰字符、不用图片素材） |
| 13 | 分期 | 「古诗含义」专项先实施（**代码已完成**，见 §10 前置 A），之后积分体系一次性接全 8 类任务 |

### 3.1 段位表（固定，不可配）

| 序 | code | 名称 | 累计积分门槛 |
|---|---|---|---|
| 1 | `pichai` | 劈柴 | 0 |
| 2 | `zhutie` | 铸铁 | 500 |
| 3 | `qingtong` | 青铜 | 1200 |
| 4 | `baiyin` | 白银 | 2000 |
| 5 | `huangjin` | 黄金 | 3000 |
| 6 | `bojin` | 铂金 | 5000 |
| 7 | `zuanshi` | 钻石 | 8000 |
| 8 | `xingyao` | 星耀 | 12000 |
| 9 | `wangzhe` | 王者 | 20000 |

段位常量写在 `apps/server/src/modules/points/levels.ts`（**单一真源**），前端不重复定义——学生端/家长端都从接口拿。

### 3.2 任务与默认分值（家长可改，每学生一套）

| task_code | 名称 | tier_key 语义 | 默认档位 → 分值 | 默认每日上限 |
|---|---|---|---|---|
| `mainline_lesson` | 学完一课 | `default` | 10 | 不限 |
| `math_paper` | 数学卷子一套 | `default` | 50 | 不限 |
| `math_targeted` | 数学专项 | 题数 | `1`→2 / `3`→8 / `5`→15 / `10`→35 | 5 |
| `error_fix` | 错题订正 | `default` | 3 | 不限 |
| `cn_dictation` | 古诗文默写 | 体裁 | `poem`→2 / `prose`→5 | 不限 |
| `cn_interpretation` | 古诗文翻译 | 体裁 | `poem`→3 / `prose`→6 | 不限 |
| `cn_meaning` | 古诗情感 | `default` | 4 | 不限 |
| `en_vocabulary` | 英语背单词 | 词数 | `10`→2 / `15`→4 / `20`→7 | 2 |

**关于数学专项的档位**：用户原话只给了「1 题 2 分、3 题 8 分」两档，本设计补了 `5`→15、`10`→35 两档，以覆盖现有 UI 的常用范围（现在 `TargetedConfigPage.tsx:25` 是 `[3,5,8,10]`）。实施时该常量会被删除、改读 `GET /api/points/me/rules`。

**关于数学专项的每日上限（Task 12 review 补）**：四档共用 `5` 次（与 `en_vocabulary` 三档共用 `2` 次同一口径，按 `task_code` 计数、不分档位）。§6.4 已明确接受「开一个 N 题会话立刻 complete 就等于做完 N 题」，而档位由**学生自选**、幂等键又按 `sessionId`（每次开练都是新 key）——若 `dailyLimit` 不限，把题池缩到 1 题就能用 `10` 档（35 分）反复 complete 无限刷。每日上限是主要（也是唯一）防刷手段，必须给上。注意 `DEFAULT_RULES` 经 `insertIgnoreBatch`（`INSERT IGNORE`）写入，**只对未初始化过规则的新学生生效**，不回溯修正存量学生。

---

## 4. 数据模型

### 4.1 `chinese_passages` 加一列

```sql
ALTER TABLE chinese_passages
  ADD COLUMN genre VARCHAR(10) DEFAULT NULL;  -- 'poem' 诗/词 | 'prose' 文言文；NULL = 未标定，不发分
```

- 迁移 `tools/db/migrations/2026-09-17_gamification_points.sql`（`information_schema` + `PREPARE` 幂等包裹），**同时折回 `tools/db/schema.sql:309`**。
- 标定方式：在 `tools/data-refinery/src/dictation_cli.py` 加两个扁平 flag——`--export-genre` 出待标定清单（Markdown，空体裁标「待定」）、`--set-genre` 写回（`--id <n> --genre poem|prose` 单篇，或 `--input <file>` 批量，每行 `id<TAB>poem|prose`）。**工具只读写、不用 LLM 猜**。
- **`genre IS NULL` 的篇目 → 不发分**（不是猜、也不是默认按古诗处理）。发分前校验，日志留痕。
- 刻意**不复用** `sentence_meanings` 的有无来推体裁：那是「含义数据是否就绪」，和体裁是两件事（`schema.sql:319-321` 已明记「只做诗词」由该列实现，勿混）。

### 4.2 `controls` 加一列（兑换汇率）

```sql
ALTER TABLE controls
  ADD COLUMN points_per_yuan SMALLINT NOT NULL DEFAULT 20;  -- 多少积分换 1 元
```

- 与既有 `controls.reward_redemption_enabled`（`schema.sql:851`）配合：开关关了 → 兑换端点直接 400。
- 该表 `UNIQUE (student_id)`，行由 `students.repo.ts:108` 建默认行时创建；缺行时懒初始化补。

### 4.3 新增 6 张表

> 6 张 = 积分核心三张（`point_rules` / `point_ledger` / `student_points`）＋ 兑换两张（`reward_catalog` / `point_redemptions`）＋ 会话一张（`training_sessions`）。

全部**无外键指向内容表**（与 `chinese_passages` / `english_words` 同规矩：内容表可全量重灌），只挂 `students(id)`。

#### `point_rules` — 家长可配的分值表

```sql
CREATE TABLE IF NOT EXISTS point_rules (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  student_id BIGINT NOT NULL,
  task_code  VARCHAR(40) NOT NULL,
  tier_key   VARCHAR(20) NOT NULL DEFAULT 'default',
  tier_label VARCHAR(30) NOT NULL,          -- 展示名，如「10 词」「古诗」「3 题」
  points     INT NOT NULL,
  daily_limit SMALLINT DEFAULT NULL,        -- NULL = 不限
  sort_order SMALLINT NOT NULL DEFAULT 0,
  is_active  TINYINT(1) NOT NULL DEFAULT 1,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  UNIQUE KEY uniq_point_rules (student_id, task_code, tier_key),
  CONSTRAINT fk_point_rules_student FOREIGN KEY (student_id) REFERENCES students (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
```

**一张表装三种档位维度**靠 `tier_key` 字符串，语义由 `task_code` 决定（词数 / 题数 / 体裁 / `default`）。

**初始化策略：懒初始化 + 幂等补齐**。默认值常量表在 `apps/server/src/modules/points/default-rules.ts`。任何读写该学生规则的入口先跑一次 `INSERT IGNORE ... SELECT`，把默认常量里缺失的 `(task_code, tier_key)` 补上。

- 好处：新增任务/档位**零迁移**，老学生自动补行。
- 代价：改了代码里的默认值不会回溯已初始化的学生——**有意接受**。因为家长本就要自己调；且初始值一旦被家长改过，本来就不该被代码改动覆盖。

#### `point_ledger` — 积分流水（**唯一真源**）

```sql
CREATE TABLE IF NOT EXISTS point_ledger (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  student_id BIGINT NOT NULL,
  kind       VARCHAR(16) NOT NULL,          -- 'earn' | 'redeem'
  task_code  VARCHAR(40) NOT NULL,          -- kind='redeem' 时固定 'redeem'
  tier_key   VARCHAR(20) NOT NULL DEFAULT 'default',
  points     INT NOT NULL,                  -- earn 正数 / redeem 负数
  dedupe_key VARCHAR(120) NOT NULL,
  title      VARCHAR(60) NOT NULL,          -- 展示文案快照，如「英语背单词 · 10 词」
  ref_type   VARCHAR(24) DEFAULT NULL,
  ref_id     BIGINT DEFAULT NULL,
  redemption_id BIGINT DEFAULT NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  UNIQUE KEY uniq_point_ledger_dedupe (dedupe_key),
  KEY idx_point_ledger_student_time (student_id, created_at),
  KEY idx_point_ledger_daily (student_id, task_code, kind, created_at),
  CONSTRAINT fk_point_ledger_student FOREIGN KEY (student_id) REFERENCES students (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
```

- `dedupe_key` 唯一键是**幂等的唯一实现**：`INSERT` 撞键 → 说明已发过，回查返回首次结果，**不报错**。
- `title` 存**快照**：家长改了分值/档位名后，历史流水不能跟着变（否则孩子看到的「+2」和实际不符）。
- `idx_point_ledger_daily` 服务每日上限计数：`COUNT(*) WHERE student_id=? AND task_code=? AND kind='earn' AND created_at >= ? AND created_at < ?`——**两个边界由应用层算好传参，不在 SQL 里用 `CURDATE()`**（见 §4.4）。

#### `student_points` — 快照（读优化，可重建）

```sql
CREATE TABLE IF NOT EXISTS student_points (
  student_id BIGINT PRIMARY KEY,
  total_earned INT NOT NULL DEFAULT 0,      -- = SUM(points) WHERE kind='earn'
  balance      INT NOT NULL DEFAULT 0,      -- = SUM(points) 全部
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  CONSTRAINT fk_student_points_student FOREIGN KEY (student_id) REFERENCES students (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
```

- **段位不落库**，由 `total_earned` 对照 §3.1 常量实时算——少一处不一致源，且段位不可配。
- 快照存在的理由：家长端要多孩子列表、学生端每次进页面都读，`SUM` 全表流水不划算。
- 一致性：与流水**同事务**更新；另提供 `npx tsx src/scripts/rebuild-student-points.ts` 从流水重算（快照坏了可重建）。

#### `reward_catalog` — 家长配的奖励清单

```sql
CREATE TABLE IF NOT EXISTS reward_catalog (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  student_id BIGINT NOT NULL,
  name        VARCHAR(100) NOT NULL,
  description VARCHAR(300) DEFAULT NULL,
  points_cost INT NOT NULL,
  min_level_code VARCHAR(20) DEFAULT NULL,  -- 达到某段位才可兑；NULL = 无门槛
  is_active   TINYINT(1) NOT NULL DEFAULT 1,
  sort_order  SMALLINT NOT NULL DEFAULT 0,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  KEY idx_reward_catalog_student (student_id, is_active),
  CONSTRAINT fk_reward_catalog_student FOREIGN KEY (student_id) REFERENCES students (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
```

#### `point_redemptions` — 兑换单

```sql
CREATE TABLE IF NOT EXISTS point_redemptions (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  student_id BIGINT NOT NULL,
  type       VARCHAR(10) NOT NULL,          -- 'cash' | 'reward'
  points_spent INT NOT NULL,
  cash_amount  DECIMAL(10,2) DEFAULT NULL,  -- type='cash' 时的金额快照
  reward_catalog_id BIGINT DEFAULT NULL,
  reward_name VARCHAR(100) DEFAULT NULL,    -- 快照（catalog 改名/删除不影响历史）
  status     VARCHAR(16) NOT NULL DEFAULT 'pending',  -- pending | fulfilled
  note       VARCHAR(200) DEFAULT NULL,
  ledger_id  BIGINT DEFAULT NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  fulfilled_at DATETIME(3) DEFAULT NULL,
  KEY idx_point_redemptions_student (student_id, status, created_at),
  CONSTRAINT fk_point_redemptions_student FOREIGN KEY (student_id) REFERENCES students (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
```

#### `training_sessions` — 训练会话（只服务 `math_targeted` / `en_vocabulary`）

> 只给「档位打包价」的两个任务用——原因见 §6.1/§6.2。其余 6 个任务各有天然发分点，**不写这张表**。

```sql
CREATE TABLE IF NOT EXISTS training_sessions (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  student_id BIGINT NOT NULL,
  task_code  VARCHAR(40) NOT NULL,
  subject_id BIGINT DEFAULT NULL,
  tier_key   VARCHAR(20) NOT NULL DEFAULT 'default',
  expected_count SMALLINT NOT NULL DEFAULT 1,   -- 本次应完成的目标数（题数）
  judged_count   SMALLINT NOT NULL DEFAULT 0,   -- 审计留痕：实际判过几题
  status     VARCHAR(16) NOT NULL DEFAULT 'in_progress',  -- in_progress | completed | abandoned
  ref_type   VARCHAR(24) DEFAULT NULL,          -- 'question' | 'passage' | 'paper'
  ref_id     BIGINT DEFAULT NULL,
  started_at   DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  completed_at DATETIME(3) DEFAULT NULL,
  KEY idx_training_sessions_student (student_id, status, started_at),
  CONSTRAINT fk_training_sessions_student FOREIGN KEY (student_id) REFERENCES students (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
```

**与既有 `rewards` 表（`schema.sql:871`）的分工——勿混**：`rewards` 是 PRD §7.3「课级/单元级奖励发放」的实例记录（平台按闯关节点发的奖励），本期**不动它**；`point_redemptions` 是「用积分换」的兑换单。两者语义不同，后期若要合并另开 spec。

### 4.4 幂等键（发分去重）

| task_code | dedupe_key | 说明 |
|---|---|---|
| `mainline_lesson` | `lesson:<studentId>:<lessonId>` | **不带日期**——一课只能算一次（主线是单向前进） |
| `math_paper` | `paper:<sessionId>` | 用 `exam_sessions.id` |
| `math_targeted` | `tsess:<sessionId>` | 每次开练是新会话、新题单，同日多次开受每日上限约束 |
| `error_fix` | `err:<studentId>:<questionId>:<YYYY-MM-DD>` | 带日期：跨天可再次订正同题得分 |
| `cn_dictation` | `dict:<studentId>:<passageId>:<YYYY-MM-DD>` | |
| `cn_interpretation` | `interp:<studentId>:<passageId>:<YYYY-MM-DD>` | |
| `cn_meaning` | `meaning:<studentId>:<passageId>:<YYYY-MM-DD>` | |
| `en_vocabulary` | `vsess:<sessionId>` | |
| 兑换 | `redeem:<redemptionId>` | |

**自然日的算法——照抄仓内既有约定，不要在 SQL 里用 `CURDATE()`。**

`student-word-progress.repo.ts:92` 与 `vocabulary.service.ts:140` 都明确注释过原因：**DB 会话时区与应用时区可能不一致，用 `CURDATE()` 会算错一天**。既有实现是「应用层算出服务器本地时区的当日 00:00，作为参数传给 SQL」：

```ts
/** 服务器本地时区的当日 00:00。刻意不用 SQL 的 CURDATE()（DB 会话时区可能与应用不一致）。 */
private startOfToday(): Date {
  const now = this.now();
  return new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 0, 0, 0);
}
```

本设计沿用：`startOfToday()` 取当天 00:00，`startOfTomorrow()` 取次日 00:00，两个都作为绑定参数传进 SQL。`dedupe_key` 里的 `<YYYY-MM-DD>` 也用同一套本地日期格式化（照抄既有实现，别引第三方库）。

**不要去改 `connection.ts` 的会话时区**——那会改变全应用 `NOW(3)` 的取值，blast radius 远超本功能。

---

## 5. 段位计算

```ts
// apps/server/src/modules/points/levels.ts
export const LEVELS = [
  { code: 'pichai',    name: '劈柴', threshold: 0 },
  { code: 'zhutie',    name: '铸铁', threshold: 500 },
  { code: 'qingtong',  name: '青铜', threshold: 1200 },
  { code: 'baiyin',    name: '白银', threshold: 2000 },
  { code: 'huangjin',  name: '黄金', threshold: 3000 },
  { code: 'bojin',     name: '铂金', threshold: 5000 },
  { code: 'zuanshi',   name: '钻石', threshold: 8000 },
  { code: 'xingyao',   name: '星耀', threshold: 12000 },
  { code: 'wangzhe',   name: '王者', threshold: 20000 },
] as const;
```

- `levelOf(totalEarned)`：取 `threshold <= totalEarned` 的最大档。**只升不降**是 `total_earned` 单调递增的必然结果（兑换只写 `kind='redeem'` 的负流水，不减 `total_earned`）。
- `progressPercent` = `(totalEarned - cur.threshold) / (next.threshold - cur.threshold) * 100`，满级时 `100`。
- 无「降级」逻辑，也不需要：`total_earned` 语义上不可回退。

---

## 6. 完成事件与埋点

### 6.1 先按「发分粒度」把 8 个任务分两类

这是本节的关键切分——**大部分任务根本不需要新的「完成事件」基建**。

**甲类 · 逐目标发分**（每完成一个「目标物」发一次分，有天然事件点，**不需要会话表**）：

| 任务 | 目标物 | 发分事件点 | 单次分值 |
|---|---|---|---|
| `cn_dictation` | 一篇 | `training.controller.ts:175 dictation/judge` 判完 | 按该篇 `genre` 取档 |
| `cn_interpretation` | 一篇 | `training.controller.ts:240` 判完 | 按该篇 `genre` 取档 |
| `cn_meaning` | 一篇（整篇答完） | 该篇**最后一个可作答句**判完时（`meaning.controller.ts:57`；不是 `sentences.length - 1`，见 §7.2） | `default` 档 |
| `error_fix` | 一题 | `judge-core.service.ts:204` 清零成功 | `default` 档 |

- 分值是「**篇数/题数 × 单位分**」——所以`cn_meaning` 一次选 3 首就是 3 × 4 = 12 分，`dictation` 一轮 5 篇就按各自体裁累加。
- 判题端点**直接把 `pointsAwarded` 放进响应**，前端立刻弹轻反馈，不用等会话收尾。
- 幂等由 `dedupe_key`（带 `passageId`/`questionId`）保证，重判同一篇不会重复给分。

**乙类 · 按会话整批发分**（分值由学生开练时选的**档位**决定，需要会话表）：

| 任务 | 为什么要会话表 |
|---|---|
| `math_targeted` | 档位（1/3/5/10 题）决定总分——「3 题 8 分」是**打包价**，逐题发分就退化成线性「每题 2 分」，把溢价设计抵消掉。必须整批发。 |
| `en_vocabulary` | 同理（10/15/20 词三档）。 |

**丙类 · 既有完整事件点，直接埋**：

| 任务 | 埋点 |
|---|---|
| `math_paper` | `exams.service.ts:356 markSubmitted` 之后（`exam_sessions.id` 当 ref） |
| `mainline_lesson` | `progress.service.ts:283-291` 两个 return 分支都要发 |

### 6.2 会话表只服务两个任务

`training_sessions` 仅由 `math_targeted` 与 `en_vocabulary` 使用：

- 对应 `start` 端点（`training.controller.ts:116`、`vocabulary.controller.ts:56`）建一条 `status='in_progress'`，**把后端实际生成的题单规模写进 `expected_count`**。
- 前端做完调 `POST /api/training/sessions/:id/complete` 发分。
- **幂等**：`UPDATE ... SET status='completed' WHERE id=? AND student_id=? AND status='in_progress'`；`affectedRows === 0` 时回查 `point_ledger` 返回首次结果（**不报错**——前端重试要能拿到同样的返回）。
- **防伪造的关键**：发分按**会话里记录的档位**算，不按前端传来的档位算。学生改不了自己开练时后端实际发了多少题。

对比过的另两个方案：

- **各模块自建状态**：规则分散，家长改分值要动六个模块；幂等各写各的必漏。
- **纯前端上报**：后端改动最小，但「完成即给分」意味着上报即得分，没有第二道闸。

**为什么甲类不用会话表却依然安全**：甲类的分值是「单位分 × 实际篇数」，而发分点就在判题函数里——判了几篇就发几份，**没有可以虚报的空间**。会话表解决的是「档位打包价」特有的信任问题，甲类不存在。

### 6.3 每日上限的统一口径

**每日上限 = 当天该 `task_code` 的 `kind='earn'` 流水条数上限。**

- `en_vocabulary` 一轮 = 1 条 → 家长填 2 = 每天最多两轮 ✓
- `cn_dictation` 一篇 = 1 条 → 家长填 5 = 每天最多 5 篇
- `math_targeted` 一个会话 = 1 条

一句话给孩子解释：「今天这个任务最多拿 N 次分」。三种档位维度共用同一套计数，不需要额外状态。

### 6.4 防伪造

只对乙类（`math_targeted` / `en_vocabulary`）有意义，因为只有它们听前端一句「我做完了」。

- `complete` 校验：会话属于本人 + `status='in_progress'`。防住「随便 POST 一个假 task_code 刷分」。
- **分值取自会话记录，不取前端入参**——`expected_count` 与档位在建会话时由后端写入，学生改不了自己实际做了几题/几个词。
- **审计留痕**：`complete` 时把 `judged_count`（判题次数，由 `/api/training/judge` 带 `sessionId` 时累加）与 `expected_count` 一起存进流水备注，**不阻断发分**（因为「完成即给分」，做了 1 题就该得 1 题的分），家长端可在流水里看到异常。
- **明确记录为已知限制**：因为「完成即给分、不看对错」，「开一个 N 题会话立刻 complete」在语义上就等于「做完 N 题」，给分是**正确行为**。每日上限（§6.3）是主要防刷手段。

### 6.5 `error_fix` 的精确定义

用户认为「主线清零的错题」和「错题专项的错题」是两回事。实际按 PRD §7.4/§6.3，**错题专项拉取的正是主线错题本里未清零的题**——同一个池子，靠 `source` 区分来源但共享清零状态。

因此**不做两条规则**，只做一条 `error_fix`，发分条件精确绑定为：

> `main_error_books.repo.ts:108 clearUnclearedByStudentQuestionId` 的 **`affectedRows > 0`**

即「**确实清掉了一条未清零的错题**」。

- 首次就答对（本无错题）→ `affectedRows = 0` → **不发分** ✓
- 错题重做答对 → `affectedRows > 0` → **发分** ✓
- 已清零后再做对 → `affectedRows = 0` → 不重复发分 ✓

需把该方法返回值从 `Promise<void>` 改为 `Promise<number>`（返回 `affectedRows`），改动极小。无论入口是错题专项还是主线清零阶段，都走这一个函数，天然不会双重给分。

---

## 7. 端点契约

新建后端模块 `apps/server/src/modules/points/`（controller / service / module / dto / `levels.ts` / `default-rules.ts`），拥有 `point_rules`、`point_ledger`、`student_points`、`reward_catalog`、`point_redemptions` 五张表，导出 `PointsService` 供 `progress`、`practice`、`training`、`exams` 模块注入。

> ⚠️ 本仓 Nest `@Post` 默认返回 **201**，不是 200；openapi.yaml 按实际记。
> ⚠️ 新增模块要在 `app.module.ts:22` 注册。

### 7.1 学生端（`@Roles('student')`）

| 方法 | 路径 | 返回 |
|---|---|---|
| GET | `/api/points/me` | `{ balance, totalEarned, todayEarned, level:{code,name,index,threshold}, nextLevel:{code,name,threshold}\|null, pointsToNextLevel:number, progressPercent:number }` |
| GET | `/api/points/me/ledger?page&pageSize` | `{ items:[{id,kind,title,points,createdAt,refType}], total, page, pageSize }` |
| GET | `/api/points/me/rules` | `{ tasks:[{taskCode,taskName,tiers:[{tierKey,tierLabel,points,dailyLimit,completedToday,remainingToday}]}] }` |
| GET | `/api/points/me/rewards` | `{ balance, level, items:[{id,name,description,pointsCost,minLevelCode,minLevelName,affordable,levelOk,gap}] }` |

- `pointsToNextLevel`：已满级（王者）时为 `null`。
- `remainingToday`：`dailyLimit == null` 时为 `null`。
- `me/rules` 是**档位即可选项**的实现基础——各训练配置页靠它渲染可选档位，学生端**不再硬编码** `COUNT_OPTIONS`。
- `minLevelName`（**2026-09-18 补，任务五实施时新增**）：`minLevelCode` 对应的段位名，无门槛或脏 code 时为 `null`。加它是为了让奖励册能写出「段位不够（需达到 XX）」而**不必在前端维护段位表**（§3.1：段位表单一真源在 `levels.ts`）。脏 code 一律 `null`，前端回退成「更高段位」——**不编造名字**。它与计划三要加的 `GET /api/points/levels` 不重复：那个是给家长端「9 选 1」下拉用的全量表，这个是学生端逐项的名称。

### 7.2 训练发分

**乙类 · 整批发分**（只 `math_targeted` / `en_vocabulary`）：

| 方法 | 路径 | 说明 |
|---|---|---|
| POST | `/api/training/sessions/:id/complete` | 201。返回 `{ pointsAwarded, balance, totalEarned, levelUp:{from,to}\|null, reason? }`。`reason` ∈ `'daily_limit'`（`pointsAwarded=0`，**不报错**）\| `'already_completed'` \| `'no_rule'` \| `'tier_inactive'` \| `'award_failed'` |

- **`award_failed`（Task 12 review 补）**：发分引擎抛错（DB 故障）时的降级返回，**仍是 2xx、不报错**（积分不该阻断学习路径）。区别于其它 reason：`balance` / `totalEarned` 回 **`null`** 而不是 0 —— 真实余额不是 0，回 0 会被前端当成合法快照覆盖掉本地积分。这条路径**不把会话置 `completed`**（award 先于 `completeOwned`），会话留在 `in_progress`、没有任何流水行，**下一次 `complete` 会用同一个幂等键 `tsess/vsess:<sessionId>` 补发且只补发一次**。前端见到 `award_failed` 应提示「积分补发中」，并在下次进入该会话/重试时再调一次 `complete`（客户端看到 2xx 不会自动重试）。

- 这两个任务的 `start` 端点返回体加 `sessionId`。
- `POST /api/training/judge` 加**可选**入参 `sessionId`（只用于累加 `judged_count` 审计，不传也能判题）。

**甲类 · 逐目标发分**（`cn_dictation` / `cn_interpretation` / `cn_meaning` / `error_fix`）：**不新增端点**，在既有判题响应里追加两个字段：

```ts
{ ...原有判题结果, pointsAwarded: number,
  awardReason?: 'daily_limit' | 'no_rule' | 'tier_inactive' | 'genre_unset' | 'not_cleared' }
```

> `tier_inactive`（家长停用了该档位）**必须在枚举里**：`award()` 的第 3 步会返回它，
> 漏掉就得往枚举外塞一个值。`duplicate` 则**刻意不在枚举内**——幂等命中本次未入账，
> 一律静默、`pointsAwarded=0`，报出去前端会弹假 `+N 分`。

前端拿到 `pointsAwarded > 0` 就弹轻反馈；`= 0` 且带 `awardReason` 时静默或显示「今日该任务积分已达上限」。`error_fix` 的 `pointsAwarded` 要透传到 `judge-core` 的各调用方（`training.controller.ts`、`practice` 的判题入口、`exams` 的补判路径——补判路径**不参与发分**，避免考试补判冒出积分）。

**`cn_meaning` 的「整篇答完」判定**：该篇**最后一个可作答句**判完时发分。前端不需要额外调用——`judge` 响应里自然带上。

> ⚠️ 「最后一个可作答句」**不是** `sentences.length - 1`：末句可能没有标准含义（`sentence_meanings[i] == null`，`answerable:false`、根本不出题），按下标 `length - 1` 判定会让这类篇目**永远拿不到分**。正确口径是「最大的 `i` 使 `meanings[i] != null`」，实现在 `meaning.service.ts`（`task-11` 落实时修正本条，原写法有误）。

**`cn_interpretation` 的「整篇答完」判定**：与含义专项同理，发分点绑定「被判的是**最后一句**」（`interpretation.service` 据 `sentenceIndex` 与该篇最大句下标比较），中间句一律 `pointsAwarded=0`——否则学生只答第一句就能拿一整篇的分。同一判定也是 `fullTranslation` 只在最后一句下发的原因（提前给整篇译文等于泄题）；判题本身仍是**逐句**的，学生答完一句立即知道对错。

### 7.3 家长端（`@Roles('parent')`，全部复用 `ParentService.requireOwnedStudent`）

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/parent/students/:id/points` | 概览，同 §7.1 第一行 |
| GET | `/api/parent/students/:id/points/rules` | 按任务分组的全部规则 |
| PUT | `/api/parent/students/:id/points/rules` | 批量保存 `{ rules:[{taskCode,tierKey,points,dailyLimit,isActive}] }`，一个事务；`points` 须 `>=0` 且 `<=9999` |
| GET | `/api/parent/students/:id/points/ledger?page` | 流水 |
| GET | `/api/parent/students/:id/reward-catalog` | 奖励清单 |
| PUT | `/api/parent/students/:id/reward-catalog` | 批量保存（含增删改，无 `id` 视为新增） |
| POST | `/api/parent/students/:id/points/redeem` | 201。body `{type:'cash', points}` 或 `{type:'reward', catalogId}` |
| GET | `/api/parent/students/:id/redemptions` | 兑换记录 |
| PATCH | `/api/parent/redemptions/:id` | `{status:'fulfilled'\|'pending'}`（只改状态，不动积分）。**路径里没有 `studentId`**：先按 `id` 查出该兑换单的 `student_id` 再做归属校验；不存在 ⇒ 404 `1002` |
| GET | `/api/parent/students/:id/points/settings` | `{ pointsPerYuan, rewardRedemptionEnabled }`（读 `controls`） |
| PUT | `/api/parent/students/:id/points/settings` | 至少给一个字段，否则 400；`pointsPerYuan` 1..9999 |

> 家长端共 **11** 个端点（不是 9 个）。`points/settings` 与 rules 批量保存**分开**——汇率和分值是两个关注点。

**错误码**：`3001` 余额不足 / `3002` 未达段位门槛 / `3003` 奖励已下架 / `3004` 兑换已关闭（`reward_redemption_enabled = 0`）/ `3005` 档位不存在（家长批量保存时某个 `(taskCode, tierKey)` 查不到）。

**兑换规则**：家长输入要花掉的**积分**数，金额由汇率推导——`cashAmount = round(points / pointsPerYuan, 2)`，`pointsPerYuan` 默认 20（即 20 积分 = 1 元）、家长可配。

> 方向不要写反：是「**积分 → 钱**」（用户原话「将积分换成钱」），不是「输入金额再算需要多少积分」。家长端的输入框是积分，展示的金额是推算结果。
>
> 兑换前校验 `balance >= points` 且（若 `min_level_code` 非空）已达该段位；**同事务**写 `point_redemptions` + 负流水 + 更新快照。**流水只写负的 `kind='redeem'` 行、快照只动 `balance`（`earnedDelta = 0`）**——`total_earned` 绝不能被兑换影响，否则「段位只升不降」立刻破。

**已知限制（本期不做）**：兑换**不可撤销**。家长点错只能再兑回去或手工补偿。`point_redemptions.status` 已为后续撤销留了状态位。

---

## 8. 前端改动

### 8.1 学生端

| 文件 | 改动 |
|---|---|
| `components/base/LevelIcon.tsx` | **新建**。9 个内联 SVG（`PATHS: Record<LevelCode, ReactNode>`），`currentColor` 单色 + brand 明度阶区分，**不引入新色板、不用 emoji** |
| `components/business/UserBadge.tsx` | **新建**。头像 + 名字 + 段位小图标 + 积分，点击打开 `LevelPanel`。替换 `EntrySelectPage.tsx:76`、`CourseDetailPage.tsx:658`、`AuxiliaryHomePage.tsx:79` 的 `LogoutButton` username 变体用法。**只用于学生端**——家长端/管理端无积分，保持 `LogoutButton` 原样 |
| `components/business/LevelPanel.tsx` | **新建**。段位图标 + 名称 + 累计/可用 + 距下一档还差多少 + 进度条 + 「查看明细」跳 `/student/profile` |
| `components/business/PointsToast.tsx` + `store/pointsStore.ts` | **新建**。右下角 `+N 分 · 英语背单词 10 词` 队列浮出，2.5s 自动消失 |
| `components/business/FireworksCanvas.tsx` | **新建**。Canvas 2D 粒子烟花，约 120 粒子/波 × 3 波 ≈ 3s，颜色取 CSS 变量随日夜主题，`prefers-reduced-motion` 降级为静态光晕 |
| `components/business/CelebrationOverlay.tsx` | **新建公共组件**。props `{ open, variant:'task'\|'levelup', title, subtitle, pointsAwarded, level?, primaryLabel, onPrimary, autoCloseSeconds? }`。**替换 `CourseDetailPage.tsx:1022-1096` 那段内联庆祝页**（撒花字符 `✦✧＊·◇` 一并换成烟花） |
| `pages/student/ProfilePage.tsx` | **新建**，替换 `routes/index.tsx:366` 的 Placeholder。段位大卡 + 积分概览 + 流水列表（分页）+ 兑换记录 |
| `pages/student/RewardsPage.tsx` | **新建**，替换 `routes/index.tsx:367`。奖励卡片 + 还差多少 + 「找家长兑换」提示 |
| `services/api.ts` | 加 `getMyPoints / getMyLedger / getMyPointRules / getMyRewards / completeTrainingSession` |
| `TargetedRunPage` / `english/VocabularyRunPage` | 题单/词单走完时调 `completeTrainingSession(sessionId)`，按返回决定轻反馈 or 全屏庆祝（**只有这两个走会话**） |
| `ErrorPracticeRunPage` / `chinese/DictationRunPage` / `chinese/InterpretationRunPage` / `chinese/MeaningRunPage` | **不调完成接口**——判题响应里已带 `pointsAwarded`，读它弹轻反馈即可 |
| `ExamResultPage` | 交卷后由后端发分；页面读交卷响应里的积分字段，用**全屏庆祝**（大任务） |
| `CourseDetailPage` | `finishLesson` 的响应加积分字段，用全屏庆祝 |
| `TargetedConfigPage.tsx:25` | **删除** `COUNT_OPTIONS` 常量，改读 `/api/points/me/rules` 渲染档位 |
| `english/VocabularyConfigPage.tsx:14` | 同上（默认档位与现有一致，视觉不变） |

**文案口径**：学生端**不显示**「每日上限已用完」的错误弹窗——超限时任务照常完成、只是 `+0 分`，轻反馈文案写「今日该任务积分已达上限」。

### 8.2 家长端

| 文件 | 改动 |
|---|---|
| `store/parentStudentStore.ts` | **新建**（zustand + localStorage 持久化）。**前置依赖**——没有它家长端所有按学生的页面都没有锚点 |
| `components/layout/ParentLayout.tsx:56` | 硬编码假数据换成真实下拉，切换写 store |
| `pages/parent/ParentPointsPage.tsx` | **新建**，路由走已有占位 `/parent/rewards`。积分概览 + 规则配置表格（照抄 `StudentSubjectConfigPage.tsx` 骨架：按任务分组卡片、行内 `input`、保存按钮、`Modal` 二次确认、`toast`）+ 兑换表单（换钱/换奖励）+ 兑换记录 + 奖励清单管理 |
| `services/api.ts` | 加 §7.3 全部函数 |

**家长端配色**用 `style.md` §2.3 商务白蓝（`Brand-P-500 #2563EB` 等），`data-theme="parent"`，禁夜间。

### 8.3 段位图标规格

9 个图标都放 `LevelIcon.tsx`（一个文件、9 个 SVG 片段，避免 9 个小文件）。**单色 `currentColor` + brand 明度阶**区分档位，构图从「劈柴」到「王者」递进（柴堆 → 铁砧 → 鼎 → 盾 → 冠 → 翼 → 菱 → 星芒 → 王座）。线宽 2、24×24 viewBox、`stroke-linecap="round"`，与仓内既有图标风格一致。

---

## 9. 测试

### 后端（vitest）

- `points.service.test.ts`：段位边界（0/499/500/1199/1200/…/19999/20000）、幂等（同 `dedupe_key` 二次 award 不重复加分且返回首次结果）、每日上限（第 N+1 次 `pointsAwarded=0, reason='daily_limit'`）、余额不足、**兑换后段位不降**。
- `point-rules.test.ts`：懒初始化补齐缺失档位、家长改值后学生读到新值、`genre IS NULL` 不发分。
- `training-sessions.test.ts`：`complete` 重复调用幂等、非本人会话 404、**分值取自会话记录而非前端入参**。
- 甲类发分：`error_fix` 只在 `affectedRows > 0` 时发分（首次答对不发）、同日同题重判不重复发；`cn_dictation` 按 `genre` 分档、`genre IS NULL` 时 `pointsAwarded=0 + awardReason='genre_unset'`。
- `main-error-books.repo.test.ts`：`clearUnclearedByStudentQuestionId` 返回 `affectedRows`。
- `parent.controller.test.ts`：新增端点角色守卫 + 归属校验。

### 前端（vitest + @testing-library/react）

- `LevelIcon.test.tsx`（9 个 code 都能渲染）、`PointsToast.test.tsx`、`CelebrationOverlay.test.tsx`（`task` / `levelup` 两个 variant）、`FireworksCanvas.test.tsx`（smoke）、`ParentPointsPage.test.tsx`（改值保存调对 API）。

⚠️ 本仓 `globals: false`，**多用例文件必须自己写 `afterEach(() => cleanup())`**。
⚠️ 硬规则：**组件改动必须补一条渲染测试**。`CelebrationOverlay` 抽出来后主线庆祝页是回归重点（参照 `SentenceBlock.test.tsx` 那次 React #31 的教训）。

---

## 10. 实施顺序

1. **前置 A**：「古诗含义」专项——**代码已完成**（`meaning.controller/service` + `MeaningRunPage` 及各自测试，内容管线 `meaning_cli.py` 见 commit `25c6975`/`02b031f`）。**剩余阻塞只有内容**：Task 12 需用户跑 `--export` 拿模板 → 人工填 `sentence_meanings` → `--apply`。未灌内容的篇目抽不到题，但**不阻塞积分体系的开发**（埋点位置不依赖数据）。
2. **前置 B**：`chinese_passages.genre` 迁移 + 标定工具 + 人工标定。
   - 顺带修 `meaning_cli.py` 的导出范围：它现在「含文言文、留空即可」，有了 `genre` 后可按体裁过滤。
3. **前置 C**：家长端 `parentStudentStore` + `ParentLayout` 真实切换。
4. **后端**：`points` 模块（5 表 + 迁移 + 常量 + 懒初始化 + 发分/兑换）+ `training_sessions` 表。
5. **埋点**（按 §6.1 的三类推进，由易到难）：
   - **丙类**（`mainline_lesson` / `math_paper`）——既有事件点直接埋，无新基建，先做来打通「发分 → 落流水 → 段位变化」这条链路。
   - **甲类**（`error_fix` + 语文三个专项）——在既有判题函数/端点里发分，响应加 `pointsAwarded`。
   - **乙类**（`math_targeted` / `en_vocabulary`）——最后做，要动 `training_sessions` + `complete` 端点 + 两个 `start` 端点。
6. **前端学生端**：`LevelIcon` → `UserBadge` / `LevelPanel` → `PointsToast` → `CelebrationOverlay` + `FireworksCanvas` → `ProfilePage` / `RewardsPage` → 各 run 页接完成回调。
7. **前端家长端**：`ParentPointsPage`（配置 + 兑换）。
8. **文档**：PRD 新增 §7.13「闯关积分与段位」；`docs/API接口与数据流设计文档.md` + `docs/api/openapi.yaml` **同步更新**（硬规则）；`docs/ai-core-changelog.md` 记日期流水。

---

## 11. 风险与已接受的取舍

| 风险 | 处置 |
|---|---|
| 单元检测/期中期末未实现 | 本期不发分；`point_rules` 懒初始化让以后加两行配置即可，**零迁移** |
| 前端 `complete` 可伪造 | **只影响乙类两个任务**；分值取自会话记录而非前端入参 + 一次性 + `judged_count` 留痕；每日上限是主防线；已知限制明记 |
| 抽公共庆祝组件会动主线现有流程 | 补 `CelebrationOverlay.test.tsx` 渲染测试；主线那段的撒花字符一并换成烟花 |
| `genre` 未标定的篇目 | 不发分 + 日志留痕，**不猜、不默认** |
| 家长误把分值调成 0 或超大 | 后端校验 `0 <= points <= 9999` |
| 兑换不可撤销 | 已知限制明记；`point_redemptions.status` 已为后续撤销留状态位 |
| 时区不一致导致每日上限跨天错乱 | 沿用 `vocabulary.service.ts:140` 的做法：应用层算本地 00:00 传参，**不在 SQL 用 `CURDATE()`**；也不去改 `connection.ts` 的会话时区 |
| 庆祝动画在 iPad 上卡顿 | Canvas 粒子数上限 120/波、3 秒自动卸载；`prefers-reduced-motion` 降级 |
