-- 道法小问拆题 —— 数据库迁移（2026-11-23）
-- 用途：questions 增加 sub_no（小问序号，0=非小问）与 material_position（材料显示位置）。
-- 幂等：列存在则 SELECT 1 跳过，可重复执行。

SET @col := (SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'questions' AND COLUMN_NAME = 'sub_no');
SET @ddl := IF(@col = 0,
  'ALTER TABLE questions ADD COLUMN sub_no TINYINT UNSIGNED NOT NULL DEFAULT 0 AFTER group_order',
  'SELECT 1');
PREPARE stmt FROM @ddl; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @col := (SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'questions' AND COLUMN_NAME = 'material_position');
SET @ddl := IF(@col = 0,
  'ALTER TABLE questions ADD COLUMN material_position VARCHAR(8) DEFAULT NULL AFTER material_method',
  'SELECT 1');
PREPARE stmt FROM @ddl; EXECUTE stmt; DEALLOCATE PREPARE stmt;
