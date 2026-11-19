-- 教研角色与内容纠错 —— 数据库迁移（2026-11-19）
-- 用途：admins 增加 role 列（admin|researcher）；auth_sessions.role 枚举追加 researcher；
--       新建内容纠错审计表 content_audit_logs。
-- 幂等：列 / 枚举 / 建表均先查 information_schema，已存在则 SELECT 1 跳过，可重复执行。
-- 注意：researcher 只能追加在 auth_sessions.role 枚举末尾，不改存量值序数。

-- 1) admins.role
SET @col := (SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'admins' AND COLUMN_NAME = 'role');
SET @ddl := IF(@col = 0,
  'ALTER TABLE admins ADD COLUMN role ENUM(''admin'',''researcher'') NOT NULL DEFAULT ''admin''',
  'SELECT 1');
PREPARE stmt FROM @ddl; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- 2) auth_sessions.role 扩枚举（researcher 追加末尾，不改存量序数）
SET @enum := (SELECT COLUMN_TYPE FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'auth_sessions' AND COLUMN_NAME = 'role');
SET @ddl := IF(@enum LIKE '%researcher%', 'SELECT 1',
  'ALTER TABLE auth_sessions MODIFY COLUMN role ENUM(''admin'',''parent'',''student'',''researcher'') NOT NULL');
PREPARE stmt FROM @ddl; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- 3) 审计表
CREATE TABLE IF NOT EXISTS content_audit_logs (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  actor_id BIGINT NOT NULL,
  actor_role VARCHAR(16) NOT NULL,
  actor_name VARCHAR(50) DEFAULT NULL,
  action VARCHAR(32) NOT NULL,
  target_type VARCHAR(16) NOT NULL,
  target_id BIGINT NOT NULL,
  paper_id BIGINT DEFAULT NULL,
  before_json JSON DEFAULT NULL,
  after_json JSON DEFAULT NULL,
  note VARCHAR(255) DEFAULT NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  KEY idx_cal_target (target_type, target_id),
  KEY idx_cal_actor (actor_id),
  KEY idx_cal_created (created_at),
  KEY idx_cal_paper (paper_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
