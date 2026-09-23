-- 日期：2026-09-23 主旨：PC App 学习管控 —— controls 改名列 + learning_sessions / device_commands 两表
-- 设计：docs/superpowers/specs/2026-09-23-pc-app-study-lockdown-design.md §4
--
-- 做什么：
--   1. controls.daily_time_limit_minutes 改名为 session_lock_minutes。语义从「每日累计上限」
--      改成「单次登录起算的禁登出窗口」，列名必须跟着变 —— 名字继续叫 daily 就是在撒谎。
--      （该列实测恒为 NULL：读侧已接、写侧从未实现，所以改名不丢数据。）
--   2. 新建 learning_sessions：一次学生登录 → 退出的记录，同时是锁定窗口的载体。
--   3. 新建 device_commands：家长 → 学生端的命令队列（本期只有 unlock）。
--
-- 为什么 learning_sessions 要条件式 VIRTUAL 生成列：
--   让「一个学生同时只有一个进行中的学习会话」由 DB 强制，而不是 check-then-insert。
--   客户端重启后再 POST 取或建会撞唯一键 → 服务层回读既有行返回**同一个** lock_expires_at
--   ⇒ 「重启不重置时钟」有了数据库级保证。同款先例：remediation_sets.active_student_id
--   （2026-09-22_remediation_sets_active_unique.sql）。
--   **必须 VIRTUAL 不能 STORED**：STORED 要重建整表，表上的外键会让 ALTER 报 ERROR 1215。
--   ⚠️ 别用临时表验证：临时表没有外键，STORED 在临时表上能过，会得出假阳性。
--
-- 幂等：改名列带 information_schema 守卫；表用 CREATE TABLE IF NOT EXISTS。重复执行无副作用。
-- 回滚：
--   ALTER TABLE controls CHANGE COLUMN session_lock_minutes daily_time_limit_minutes SMALLINT DEFAULT NULL;
--   DROP TABLE device_commands; DROP TABLE learning_sessions;

-- ── 1. controls 改名列（旧列存在且新列不存在才改）──
SET @old_exists := (
  SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'controls'
    AND COLUMN_NAME = 'daily_time_limit_minutes'
);
SET @new_exists := (
  SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'controls'
    AND COLUMN_NAME = 'session_lock_minutes'
);
SET @ddl := IF(@old_exists = 1 AND @new_exists = 0,
  'ALTER TABLE controls CHANGE COLUMN daily_time_limit_minutes session_lock_minutes SMALLINT DEFAULT NULL COMMENT ''单次学习锁定分钟数（1..480）：学生登录起该时间内禁止登出；NULL = 未设锁''',
  'DO 0');
PREPARE stmt FROM @ddl; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- ── 2. learning_sessions ──
CREATE TABLE IF NOT EXISTS learning_sessions (
  id                    BIGINT AUTO_INCREMENT PRIMARY KEY,
  student_id            BIGINT      NOT NULL,
  app_shell             VARCHAR(10) NOT NULL DEFAULT 'electron' COMMENT '复用埋点既有枚举 web|electron；本期只有 electron 写入',
  started_at            DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  last_seen_at          DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) COMMENT '由学生端轮询刷新（轮询兼心跳）；判「在线」的唯一依据',
  ended_at              DATETIME(3) DEFAULT NULL COMMENT 'NULL = 进行中。不设 end_kind：本设计不区分异常退出，结束只有一种语义',
  lock_minutes          SMALLINT    DEFAULT NULL COMMENT '开始时的快照；家长事后改设置不影响本次',
  lock_expires_at       DATETIME(3) DEFAULT NULL,
  unlocked_at           DATETIME(3) DEFAULT NULL,
  unlocked_by_parent_id BIGINT      DEFAULT NULL,
  active_student_id     BIGINT AS (IF(ended_at IS NULL, student_id, NULL)) VIRTUAL COMMENT '生成列（条件式）：仅进行中时等于 student_id，供唯一键实现「每学生至多一个进行中的学习会话」；已结束保持 NULL 不参与唯一性',
  created_at            DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at            DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  KEY idx_lsessions_student_started (student_id, started_at),
  UNIQUE KEY uniq_lsessions_active (active_student_id),
  CONSTRAINT fk_lsessions_student_id FOREIGN KEY (student_id) REFERENCES students (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ── 3. device_commands ──
-- command 用 VARCHAR + 服务端白名单，不用 ENUM：单取值的 ENUM 就是死枚举，将来加命令要改 schema。
CREATE TABLE IF NOT EXISTS device_commands (
  id                  BIGINT AUTO_INCREMENT PRIMARY KEY,
  student_id          BIGINT      NOT NULL,
  command             VARCHAR(20) NOT NULL COMMENT '服务端白名单，本期 [''unlock'']',
  status              VARCHAR(10) NOT NULL DEFAULT 'pending' COMMENT 'pending | consumed | expired',
  issued_by_parent_id BIGINT      NOT NULL,
  created_at          DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  consumed_at         DATETIME(3) DEFAULT NULL,
  KEY idx_dcommands_pending (student_id, status, created_at),
  CONSTRAINT fk_dcommands_student_id FOREIGN KEY (student_id) REFERENCES students (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
