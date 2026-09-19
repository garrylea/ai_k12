-- 2026-09-22 埋点 Phase 1B：special_practice_logs 建表 + goals 加 metric 列与唯一键
--
-- 做什么：
--   1) 新建 special_practice_logs（专项练习日志，spec §4.4）——语文三专项 + 英语背单词的判题流水
--   2) goals 加 metric 列（spec §4.7），并把 NULL 历史行按 daily_study_minutes 回填
--   3) 给 goals 加唯一键 uniq_goals_student_metric (student_id, metric)，供「按 metric upsert」
--
-- 为什么：
--   * special_practice_logs 是独立子系统：只挂 student_id 一个外键，ref_id 故意不设外键
--     （内容表全量重灌会被入向外键卡死，同 student_word_progress.word_id 的教训）
--   * goals.metric 为 NULL 的历史行按 daily_study_minutes 解释（spec §4.7 原文）
--   * 写端点走「按 metric upsert」，必须有唯一键可 ON DUPLICATE KEY
--
-- 幂等：建表用 IF NOT EXISTS；加列/加索引/回填/去重全部带守卫，可重复执行
-- 回滚：DROP TABLE special_practice_logs；ALTER TABLE goals DROP KEY uniq_goals_student_metric,
--       DROP COLUMN metric（无数据损失——metric 是本批新加的）

-- ── 1. 专项练习日志 ──────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS special_practice_logs (
  id             BIGINT AUTO_INCREMENT PRIMARY KEY,
  student_id     BIGINT       NOT NULL,
  module         VARCHAR(32)  NOT NULL COMMENT 'chinese_dictation|chinese_interpretation|chinese_meaning|en_vocabulary',
  subject_id     BIGINT       DEFAULT NULL,
  ref_type       VARCHAR(24)  NOT NULL COMMENT 'passage|word',
  ref_id         BIGINT       DEFAULT NULL COMMENT 'passage_id / word_id；**故意不设外键**（同 student_word_progress.word_id）',
  ref_key        VARCHAR(128) DEFAULT NULL COMMENT '篇目标题 / 词面快照，便于排查与无 id 场景',
  sentence_index SMALLINT     DEFAULT NULL COMMENT '解释/含义专项逐句；默写/背词为 NULL',
  verdict        VARCHAR(20)  NOT NULL COMMENT 'correct|incorrect|off_target|unanswered|undetermined',
  is_correct     TINYINT(1)   DEFAULT NULL COMMENT 'correct=1 / incorrect=0 / 其它 NULL（沿用「空答案不计对错」）',
  error_counted  TINYINT(1)   NOT NULL DEFAULT 0 COMMENT '必须复用 normalize-english.util 的 progressDelta 判决',
  session_uid    CHAR(36)     DEFAULT NULL,
  created_at     DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  KEY idx_spl_student_module_time (student_id, module, created_at),
  KEY idx_spl_student_ref         (student_id, module, ref_id),
  KEY idx_spl_time                (created_at),
  CONSTRAINT fk_spl_student_id FOREIGN KEY (student_id) REFERENCES students (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ── 2. goals 加 metric 列（MySQL 8/9 无 ADD COLUMN IF NOT EXISTS，只能守卫）──
SET @col_exists := (
  SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'goals' AND COLUMN_NAME = 'metric'
);
SET @ddl := IF(@col_exists = 0,
  'ALTER TABLE goals ADD COLUMN metric VARCHAR(40) DEFAULT NULL COMMENT ''daily_study_minutes|daily_words|weekly_passages|weekly_clear_errors''',
  'DO 0');
PREPARE stmt FROM @ddl; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- ── 3. 回填：metric 为 NULL 的历史行 = 每日学习时长目标 ──
UPDATE goals SET metric = 'daily_study_minutes' WHERE metric IS NULL;

-- ── 4. 去重：同一 (student_id, metric) 只留 id 最大的那条，其余停用并清 metric ──
--   必须放在加唯一键之前，否则历史重复行会让 ADD UNIQUE KEY 直接失败。
--   用派生表而不是 IN (SELECT ... FROM goals)，绕过 MySQL「不能在同一语句里更新并查询同表」的限制。
UPDATE goals g
  JOIN (
    SELECT student_id, metric, MAX(id) AS keep_id
    FROM goals WHERE metric IS NOT NULL
    GROUP BY student_id, metric HAVING COUNT(*) > 1
  ) d ON g.student_id = d.student_id AND g.metric = d.metric AND g.id <> d.keep_id
SET g.is_active = 0, g.metric = NULL;

-- ── 5. goals 加唯一键 (student_id, metric) ──
SET @idx_exists := (
  SELECT COUNT(*) FROM information_schema.STATISTICS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'goals' AND INDEX_NAME = 'uniq_goals_student_metric'
);
SET @ddl := IF(@idx_exists = 0,
  'ALTER TABLE goals ADD UNIQUE KEY uniq_goals_student_metric (student_id, metric)',
  'DO 0');
PREPARE stmt FROM @ddl; EXECUTE stmt; DEALLOCATE PREPARE stmt;
