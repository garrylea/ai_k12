-- ============================================================
-- variation_questions 加作答两列（错题升级变式，PRD §7.10 接线）
-- 设计：/Users/lichao/.codebuddy/plans/radiant-forging-curie-90JYTSLr.md §1
-- ============================================================
-- is_correct：NULL=待练（pending）；0/1=已作答结果——一次作答即落定，
-- 答错不重出（用户裁决 D1，2026-10-11）；原错题下次再错升级自然生成新变式。
-- answered_at：首次作答时间，与 is_correct 同一 CAS UPDATE 落定。
--
-- 幂等：MySQL 8/9 没有 ADD COLUMN / ADD INDEX IF NOT EXISTS，
-- 列与索引各写一段 information_schema + PREPARE 守卫（与 2026-10-10_llm_call_logs_module.sql
-- 同套路）；三段独立守卫，覆盖「列加了、索引没加」的中间态。

-- 1) 列：is_correct
SET @has_col := (SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'variation_questions' AND COLUMN_NAME = 'is_correct');
SET @ddl := IF(@has_col = 0,
  'ALTER TABLE variation_questions ADD COLUMN is_correct TINYINT(1) DEFAULT NULL COMMENT ''作答结果：NULL=待练（pending）；0=答错（一次落定不重出）；1=答对'' AFTER validator_passed',
  'SELECT 1');
PREPARE stmt FROM @ddl; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- 2) 列：answered_at
SET @has_col := (SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'variation_questions' AND COLUMN_NAME = 'answered_at');
SET @ddl := IF(@has_col = 0,
  'ALTER TABLE variation_questions ADD COLUMN answered_at DATETIME(3) DEFAULT NULL COMMENT ''首次作答时间；与 is_correct 同事务落定'' AFTER is_correct',
  'SELECT 1');
PREPARE stmt FROM @ddl; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- 3) 索引：pending 列表查询（student_id + is_correct）
SET @has_idx := (SELECT COUNT(*) FROM information_schema.STATISTICS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'variation_questions' AND INDEX_NAME = 'idx_vq_student_pending');
SET @ddl := IF(@has_idx = 0,
  'ALTER TABLE variation_questions ADD KEY idx_vq_student_pending (student_id, is_correct)',
  'SELECT 1');
PREPARE stmt FROM @ddl; EXECUTE stmt; DEALLOCATE PREPARE stmt;
