-- 2026-09-17 闯关积分与段位体系：2 列 + 6 表（积分 5 张 + 训练会话 1 张）。
--
-- 背景：系统原本只有「主线学完一课有庆祝页」，没有任何积分概念——无表、无端点，
-- 前端 RewardCard.tsx 是死组件。本次把它升级为完整的闯关游戏：
--   学生完成 8 类任务得积分 → 积分累计升 9 个段位 → 家长可配分值/上限 → 家长可兑钱或奖励。
--
-- 定位：积分是**平台级**的独立激励层，加在既有流程**旁边**而不是里面——
--   不清零错题、不替代错题本、不参与主线解锁判定（主线清零那道门禁不受影响）。
--   语文古诗文专项与英语背单词仍是独立子系统，但它们参与积分（本次唯一的跨子系统耦合点，
--   且是单向的：专项只调 PointsService，不被积分反向影响）。
--
-- 两条新增列，各服务一个用途：
--   chinese_passages.genre      体裁，决定默写/翻译按哪一档发分（'poem' / 'prose'）
--   controls.points_per_yuan    兑换汇率，多少积分换 1 元（配合既有的 reward_redemption_enabled）
--
-- 六张新表（point_rules / point_ledger / student_points / reward_catalog / point_redemptions
-- / training_sessions）**只挂 students(id) 外键，不指向任何内容表**——与 chinese_passages /
-- english_words 同规矩：内容表（questions / chinese_passages / english_words）会被管线全量
-- 重灌，一旦有入向外键就会把 re-load 卡死。这是刻意的、设计已定案的决定，勿「统一」掉。
--
-- 幂等策略：ADD COLUMN 用 information_schema + PREPARE/EXECUTE/DEALLOCATE 包裹（照抄
-- 2026-09-16_chinese_interpretation_columns.sql），CREATE TABLE 天然幂等。
-- **本文件只有 ADD/CREATE，没有任何 DELETE/DROP**——2026-09-15 那次迁移因级联删题
-- 静默清空 50 行的教训见 docs/superpowers/plans/2026-09-15-chinese-passages-standalone.md Task 9。
--
-- 应用方式：`mysql -uai_k12 -pai_k12 ai_k12 < tools/db/migrations/2026-09-17_gamification_points.sql`
-- 同一份 DDL 已折回 tools/db/schema.sql（install_mysql.sh 只跑 schema.sql，两者不许漂移）。
-- 设计见 docs/superpowers/specs/2026-09-17-gamification-points-design.md §4.1–4.3。

-- ============================================================
-- 1. 新增列
-- ============================================================

-- ---- chinese_passages.genre：体裁 ----
-- 'poem' 诗/词 | 'prose' 文言文；NULL = 未标定，不发分（不猜、不默认按古诗处理）。
-- 刻意**不复用** sentence_meanings 的有无来推体裁：那是「含义数据是否就绪」，两件事。
SET @has_col := (
  SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE()
    AND TABLE_NAME = 'chinese_passages'
    AND COLUMN_NAME = 'genre'
);
SET @ddl := IF(
  @has_col = 0,
  'ALTER TABLE chinese_passages ADD COLUMN genre VARCHAR(10) DEFAULT NULL COMMENT ''poem 诗/词 | prose 文言文；NULL = 未标定，不发分''',
  'SELECT 1'
);
PREPARE stmt FROM @ddl;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

-- ---- controls.points_per_yuan：兑换汇率 ----
-- 多少积分换 1 元。与既有 controls.reward_redemption_enabled 配合：开关关了 → 兑换端点直接 400。
SET @has_col := (
  SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE()
    AND TABLE_NAME = 'controls'
    AND COLUMN_NAME = 'points_per_yuan'
);
SET @ddl := IF(
  @has_col = 0,
  'ALTER TABLE controls ADD COLUMN points_per_yuan SMALLINT NOT NULL DEFAULT 20 COMMENT ''多少积分换 1 元''',
  'SELECT 1'
);
PREPARE stmt FROM @ddl;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

-- ============================================================
-- 2. 新增表（6 张：积分 5 张 + 训练会话 1 张）
-- ============================================================

-- ---- point_rules：家长可配的分值表 ----
-- 一张表装三种档位维度靠 tier_key 字符串，语义由 task_code 决定（词数 / 题数 / 体裁 / 'default'）。
-- 初始化策略：懒初始化 + 幂等补齐（读写的入口先跑 INSERT IGNORE ... SELECT 补默认档位），
-- 新增任务/档位**零迁移**；代价是改了代码里的默认值不会回溯已初始化的学生——有意接受。
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

-- ---- point_ledger：积分流水（唯一真源；段位与快照都由它算） ----
-- dedupe_key 唯一键是**幂等的唯一实现**：INSERT 撞键 → 说明已发过，回查返回首次结果，不报错。
-- title 存**快照**：家长改了分值/档位名后历史流水不能跟着变（否则孩子看到的「+2」和实际不符）。
-- idx_point_ledger_daily 服务每日上限计数，但**两个日界由应用层算好传参**，不在 SQL 里用
-- CURDATE()（DB 会话时区与应用可能不一致，会算错一天——见 spec §4.4 与仓内既有约定）。
CREATE TABLE IF NOT EXISTS point_ledger (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  student_id BIGINT NOT NULL,
  kind       VARCHAR(16) NOT NULL,          -- 'earn' | 'redeem'
  task_code  VARCHAR(40) NOT NULL,          -- kind='redeem' 时固定 'redeem'
  tier_key   VARCHAR(20) NOT NULL DEFAULT 'default',
  points     INT NOT NULL,                  -- earn 正数 / redeem 负数
  dedupe_key VARCHAR(120) NOT NULL,
  title      VARCHAR(60) NOT NULL,          -- 展示文案快照，如「英语背单词 · 10 词」
  -- 来源类型（埋点实际写入的值，勿凭印象改）：
  --   'lesson'（mainline_lesson）| 'exam_session'（math_paper）| 'training_session'（乙类）
  --   | 'passage'（语文三专项）| 'question'（error_fix）；kind='redeem' 时为 NULL
  ref_type   VARCHAR(24) DEFAULT NULL,
  ref_id     BIGINT DEFAULT NULL,
  redemption_id BIGINT DEFAULT NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  UNIQUE KEY uniq_point_ledger_dedupe (dedupe_key),
  KEY idx_point_ledger_student_time (student_id, created_at),
  KEY idx_point_ledger_daily (student_id, task_code, kind, created_at),
  CONSTRAINT fk_point_ledger_student FOREIGN KEY (student_id) REFERENCES students (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ---- student_points：快照（读优化，可从流水重建） ----
-- **段位不落库**，由 total_earned 对照 levels.ts 常量实时算——少一处不一致源，且段位不可配。
-- 快照存在的理由：家长端多孩子列表 + 学生端每次进页面都要读，SUM 全表流水不划算。
-- 一致性：与流水**同事务**更新；另有 rebuild-student-points.ts 可从流水重算。
-- 「只升不降」是 total_earned 单调递增的必然结果（兑换只写 kind='redeem' 负流水，不减它）。
CREATE TABLE IF NOT EXISTS student_points (
  student_id BIGINT PRIMARY KEY,
  total_earned INT NOT NULL DEFAULT 0,      -- = SUM(points) WHERE kind='earn'
  balance      INT NOT NULL DEFAULT 0,      -- = SUM(points) 全部
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  CONSTRAINT fk_student_points_student FOREIGN KEY (student_id) REFERENCES students (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ---- reward_catalog：家长配的奖励清单 ----
-- min_level_code 为 NULL = 无段位门槛；否则达到该段位才可兑。
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

-- ---- point_redemptions：兑换单 ----
-- 与既有 rewards 表**分工勿混**：rewards 是 PRD §7.3「课级/单元级奖励发放」的实例记录
-- （平台按闯关节点发的），本期不动它；本表是「用积分换」的兑换单，语义不同。
-- reward_name / cash_amount 都是**快照**（catalog 改名/删除不影响历史）。
-- 已知限制：本期兑换**不可撤销**，status 已为后续撤销留状态位。
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

-- ---- training_sessions：训练会话（只服务 math_targeted / en_vocabulary） ----
-- 只给「档位打包价」的两个任务用：`3 题 8 分` 是打包价，逐题发分就退化成线性「每题 2 分」，
-- 会把溢价设计抵消掉，必须整批发。其余 6 个任务各有天然发分点（判题函数里判了几篇发几份，
-- 没有可虚报的空间），**不写这张表**。
-- 防伪造的关键：发分按**会话里记录的档位**算，不按前端传来的档位算。
-- expected_count / judged_count 只做审计留痕，不阻断发分（完成即给分，做了 1 题就该得 1 题的分）。
CREATE TABLE IF NOT EXISTS training_sessions (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  student_id BIGINT NOT NULL,
  task_code  VARCHAR(40) NOT NULL,
  subject_id BIGINT DEFAULT NULL,
  tier_key   VARCHAR(20) NOT NULL DEFAULT 'default',
  expected_count SMALLINT NOT NULL DEFAULT 1,   -- 本次应完成的目标数（题数）
  judged_count   SMALLINT NOT NULL DEFAULT 0,   -- 审计留痕：实际判过几题
  status     VARCHAR(16) NOT NULL DEFAULT 'in_progress',  -- in_progress | completed | abandoned
  -- 目标物类型：当前两个乙类任务（math_targeted / en_vocabulary）都写 'question'
  -- （注意与 point_ledger.ref_type 是两套值，那边才有 'exam_session'/'passage' 等）
  ref_type   VARCHAR(24) DEFAULT NULL,
  ref_id     BIGINT DEFAULT NULL,
  started_at   DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  completed_at DATETIME(3) DEFAULT NULL,
  KEY idx_training_sessions_student (student_id, status, started_at),
  CONSTRAINT fk_training_sessions_student FOREIGN KEY (student_id) REFERENCES students (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
