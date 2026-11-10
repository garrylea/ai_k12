-- 学生档案：年级/年龄校准基准日。
-- 用途：每次学生登录按「上次校准时间」数经过的 9 月 1 日与满 12 个月数，
--       自动升年级 / 加年龄（封顶高三）；只有真的写了 grade/age 才刷新本列。
-- 幂等：列已存在时跳过；存量行用 created_at 回填（NULL 时后端也按 created_at 兜底）。
SET @col := (SELECT COUNT(*) FROM information_schema.COLUMNS
             WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'students'
               AND COLUMN_NAME = 'grade_updated_at');
SET @ddl := IF(@col = 0,
  'ALTER TABLE students ADD COLUMN grade_updated_at DATETIME(3) DEFAULT NULL COMMENT ''上次年级/年龄校准时间；NULL 时按 created_at 兜底'' AFTER school_level',
  'SELECT 1');
PREPARE stmt FROM @ddl;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

UPDATE students SET grade_updated_at = created_at WHERE grade_updated_at IS NULL;
