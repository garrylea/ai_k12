-- 2026-11-26 主观题自评确定性：作答行增加内部结算状态。
-- 语义见 docs/superpowers/specs/2026-11-26-self-assess-default-incorrect-design.md §2
-- 取值：default_incorrect|confirmed_correct|confirmed_incorrect；NULL=非本设计路径/旧数据
-- 幂等：先查列是否存在，不存在才 ADD。
SET @has_col := (
  SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE()
    AND TABLE_NAME = 'special_answer_records'
    AND COLUMN_NAME = 'self_assess_state'
);
SET @ddl := IF(
  @has_col = 0,
  "ALTER TABLE special_answer_records ADD COLUMN self_assess_state VARCHAR(24) DEFAULT NULL COMMENT 'default_incorrect|confirmed_correct|confirmed_incorrect；NULL=非本设计/旧数据' AFTER method",
  'SELECT 1'
);
PREPARE stmt FROM @ddl;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;
