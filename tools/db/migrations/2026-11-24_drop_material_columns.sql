-- 删除 questions.material_method / questions.material_position（2026-11-24）
-- 原因：material_position 是学科口径（语文/英语=题干下方，物理/化学/道法=题干上方），
--       改由后端按 subject.code 下发，不再入库；material_method 仅排查用、无读取方，
--       LLM 兜底从未接线。
-- 幂等：列不存在时 SELECT 1 跳过，可重复执行。
-- 回滚：tools/db/backups/20261124_material_columns_rollback.sql（仅存过值的 76 行）。

SET @col := (SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'questions' AND COLUMN_NAME = 'material_method');
SET @ddl := IF(@col > 0,
  'ALTER TABLE questions DROP COLUMN material_method',
  'SELECT 1');
PREPARE stmt FROM @ddl; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @col := (SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'questions' AND COLUMN_NAME = 'material_position');
SET @ddl := IF(@col > 0,
  'ALTER TABLE questions DROP COLUMN material_position',
  'SELECT 1');
PREPARE stmt FROM @ddl; EXECUTE stmt; DEALLOCATE PREPARE stmt;
