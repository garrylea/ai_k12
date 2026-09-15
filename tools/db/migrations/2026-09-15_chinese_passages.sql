-- 2026-09-15 语文古诗文专项独立化：dictation_passages → chinese_passages，摘除 question_id。
--
-- 背景：默写专项当初「贴着 questions 表」建（每篇挂一行 questions，错题本/隐藏题/提示缓存
-- 都挂 question_id）。2026-09-15 用户裁决：古诗文专项是**独立子系统**——不挂 questions、
-- 不进错题本、不参与主线清零门禁（PRD §6.3 / §7.4）。
-- 设计见 docs/superpowers/specs/2026-09-15-chinese-interpretation-special-design.md §6。
--
-- 步骤（顺序不可换，由 FK 约束决定）：
--   1. 清 main_error_books(source='dictation') —— 它的 question_id 是 ON DELETE RESTRICT，
--      不先删会挡住第 2 步
--   2. 删 questions(type='poem_dictation')   —— 其余引用表都是 ON DELETE CASCADE，跟着清
--   3. dictation_passages 改名 chinese_passages
--   4. 摘 question_id 列 + 它的唯一键与外键，并改名其余索引
--   5. 加 is_active（取代原 questions.is_active）
--
-- 幂等：每步先查 information_schema。
-- ⚠️ 不可恢复（第 1、2 步删的是学生数据与题库行）。执行前先备份：
--   mysqldump -u ai_k12 -pai_k12 ai_k12 main_error_books questions dictation_passages \
--     > backup_20260915.sql

-- 是否首次执行：老表还在 = 还没跑过。跑过之后老表已改名，存量清理不再重复。
SET @first_run := (
  SELECT COUNT(*) FROM information_schema.TABLES
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'dictation_passages'
);

-- 1. 清默写错题本行
SET @sql := IF(@first_run = 0, 'SELECT 1',
  "DELETE FROM main_error_books WHERE source = 'dictation'");
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- 2. 删 poem_dictation 题行（student_hidden_questions / question_hints /
--    question_self_assessments 由 CASCADE 跟着清）
SET @sql := IF(@first_run = 0, 'SELECT 1',
  "DELETE FROM questions WHERE type = 'poem_dictation'");
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- 3. 表改名
SET @sql := IF(@first_run = 0, 'SELECT 1',
  'RENAME TABLE dictation_passages TO chinese_passages');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- 4a. 摘外键（必须在摘列之前）
SET @has_fk := (
  SELECT COUNT(*) FROM information_schema.TABLE_CONSTRAINTS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'chinese_passages'
    AND CONSTRAINT_NAME = 'fk_dp_question'
);
SET @sql := IF(@has_fk = 0, 'SELECT 1',
  'ALTER TABLE chinese_passages DROP FOREIGN KEY fk_dp_question');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- 4b. 摘 question_id 上的唯一键
SET @has_uniq := (
  SELECT COUNT(*) FROM information_schema.STATISTICS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'chinese_passages'
    AND INDEX_NAME = 'uniq_dp_question'
);
SET @sql := IF(@has_uniq = 0, 'SELECT 1',
  'ALTER TABLE chinese_passages DROP INDEX uniq_dp_question');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- 4c. 摘列
SET @has_col_qid := (
  SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'chinese_passages'
    AND COLUMN_NAME = 'question_id'
);
SET @sql := IF(@has_col_qid = 0, 'SELECT 1',
  'ALTER TABLE chinese_passages DROP COLUMN question_id');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- 4d. 索引改名（跟新表名对齐；旧名留着会误导后来人以为还挂着 questions）
SET @has_idx := (
  SELECT COUNT(*) FROM information_schema.STATISTICS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'chinese_passages'
    AND INDEX_NAME = 'uniq_dp_work'
);
SET @sql := IF(@has_idx = 0, 'SELECT 1',
  'ALTER TABLE chinese_passages RENAME INDEX uniq_dp_work TO uniq_chinese_passages_work');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @has_idx := (
  SELECT COUNT(*) FROM information_schema.STATISTICS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'chinese_passages'
    AND INDEX_NAME = 'idx_dp_filter'
);
SET @sql := IF(@has_idx = 0, 'SELECT 1',
  'ALTER TABLE chinese_passages RENAME INDEX idx_dp_filter TO idx_chinese_passages_filter');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- 5. 加 is_active（取代原 questions.is_active：停用开关归本表自己管）
SET @has_is_active := (
  SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'chinese_passages'
    AND COLUMN_NAME = 'is_active'
);
SET @sql := IF(@has_is_active = 1, 'SELECT 1',
  'ALTER TABLE chinese_passages ADD COLUMN is_active TINYINT(1) NOT NULL DEFAULT 1 AFTER memorize_required');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SELECT 'migration 2026-09-15_chinese_passages done' AS result;
