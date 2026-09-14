-- 2026-09-13 语文默写：dictation_passages 增加「必背」标志。
--
-- 语义区分（不要混用）：
--   verified           = 内容是否已校验（正文准确）—— 由内容管线自检后置 1
--   memorize_required  = 教学上是否要求背诵 —— 由人后续标定
-- 抽题池 = verified = 1 AND memorize_required = 1。
--
-- 幂等：先查列是否存在，不存在才 ADD。
SET @has_col := (
  SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE()
    AND TABLE_NAME = 'dictation_passages'
    AND COLUMN_NAME = 'memorize_required'
);

SET @ddl := IF(
  @has_col = 0,
  'ALTER TABLE dictation_passages ADD COLUMN memorize_required TINYINT(1) NOT NULL DEFAULT 0 AFTER verified',
  'SELECT 1'
);

PREPARE stmt FROM @ddl;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;
