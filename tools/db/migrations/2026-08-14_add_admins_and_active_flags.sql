-- 2026-08-14 三角色账号体系：admins 表 + parents/students is_active。
-- 一次性运行；幂等性靠 IF NOT EXISTS / 条件判断（MySQL 8 无 ADD COLUMN IF NOT EXISTS，重复跑会报错，可忽略）。

CREATE TABLE IF NOT EXISTS admins (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  username VARCHAR(50) NOT NULL,
  password_hash VARCHAR(255) NOT NULL,
  name VARCHAR(50) DEFAULT NULL,
  is_active TINYINT(1) NOT NULL DEFAULT 1,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  deleted_at DATETIME(3) DEFAULT NULL,
  UNIQUE KEY uniq_admins_username (username, deleted_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

ALTER TABLE parents ADD COLUMN is_active TINYINT(1) NOT NULL DEFAULT 1 AFTER avatar_url;
ALTER TABLE students ADD COLUMN is_active TINYINT(1) NOT NULL DEFAULT 1 AFTER school_level;

-- 历史行兜底：age/school_level 缺失的按 grade 回填（grade 为空则置小学，最保守）。
UPDATE students SET school_level = CASE
    WHEN grade LIKE '小学%' THEN 'primary'
    WHEN grade IN ('初一','初二','初三') THEN 'junior'
    WHEN grade IN ('高一','高二','高三') THEN 'senior'
    ELSE 'primary' END
  WHERE school_level IS NULL OR school_level = '';
UPDATE students SET age = 11 WHERE age IS NULL OR age = 0;
