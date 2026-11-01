-- 考试逐题得分比例（多选部分得分）：1.00 全对 / 0.50 选对不全 / 0.00 错或空
-- 主观题（is_correct NULL）与在途行保持 NULL。正确率 = SUM(score) / 客观题数。
-- 幂等：列已存在时跳过。
SET @col := (SELECT COUNT(*) FROM information_schema.COLUMNS
             WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'exam_answers'
               AND COLUMN_NAME = 'score');
SET @ddl := IF(@col = 0,
  'ALTER TABLE exam_answers ADD COLUMN score DECIMAL(3,2) DEFAULT NULL COMMENT ''客观题得分比例：1=全对 0.5=选对不全 0=错；主观题 NULL'' AFTER is_correct',
  'SELECT 1');
PREPARE stmt FROM @ddl;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;
