-- 2026-09-20 家长端「管得住」批：controls 预警灵敏度 + study_sessions 走神两口径
--
-- 做什么：
--   1) controls 加 alert_away_minutes（默认 5）、alert_idle_minutes（默认 15）
--   2) study_sessions 加 hidden_away_seconds / hidden_idle_seconds / hidden_since / hidden_reason
--
-- 为什么：
--   * 家长要能调「多久没操作算走神」（spec 裁决 6：报警时间可设置，不要写死）。
--   * 走神要分「页面被切走(away)」与「前台无操作(idle)」两类，各自累计（spec 裁决 5）。
--     此前两类在客户端状态机里被合并成同一个 hidden，原因丢失（spec §2.3）。
--   * hidden_since 用来回答「当前这一段连续挂机多久了」——判定时机是**阈值处就报**，
--     不等挂机段结束（学生切走后再不回来，正是家长最需要知道的场景）。
--   * 新列**不参与**既有 active_seconds 的学习时长口径（parent-analytics.repo.ts 不动）。
--
-- 幂等：加列全部带 information_schema 守卫；重复 apply 无副作用。
-- 回滚：ALTER TABLE controls DROP COLUMN alert_away_minutes, DROP COLUMN alert_idle_minutes;
--       ALTER TABLE study_sessions DROP COLUMN hidden_away_seconds, DROP COLUMN hidden_idle_seconds,
--                                DROP COLUMN hidden_since, DROP COLUMN hidden_reason;

-- ── 1. controls：预警灵敏度两个阈值 ──
SET @col_exists := (
  SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'controls' AND COLUMN_NAME = 'alert_away_minutes'
);
SET @ddl := IF(@col_exists = 0,
  'ALTER TABLE controls ADD COLUMN alert_away_minutes SMALLINT NOT NULL DEFAULT 5 COMMENT ''切走多少分钟写 away 预警（家长可调 1..180）''',
  'DO 0');
PREPARE stmt FROM @ddl; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @col_exists := (
  SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'controls' AND COLUMN_NAME = 'alert_idle_minutes'
);
SET @ddl := IF(@col_exists = 0,
  'ALTER TABLE controls ADD COLUMN alert_idle_minutes SMALLINT NOT NULL DEFAULT 15 COMMENT ''前台无操作多少分钟写 idle 预警（家长可调 1..180）''',
  'DO 0');
PREPARE stmt FROM @ddl; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- ── 2. study_sessions：走神两口径累计 + 当前连续挂机段 ──
SET @col_exists := (
  SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'study_sessions' AND COLUMN_NAME = 'hidden_away_seconds'
);
SET @ddl := IF(@col_exists = 0,
  'ALTER TABLE study_sessions ADD COLUMN hidden_away_seconds INT NOT NULL DEFAULT 0 COMMENT ''会话内累计「页面不可见」秒数；不参与 active_seconds 口径''',
  'DO 0');
PREPARE stmt FROM @ddl; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @col_exists := (
  SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'study_sessions' AND COLUMN_NAME = 'hidden_idle_seconds'
);
SET @ddl := IF(@col_exists = 0,
  'ALTER TABLE study_sessions ADD COLUMN hidden_idle_seconds INT NOT NULL DEFAULT 0 COMMENT ''会话内累计「前台无操作」秒数；不参与 active_seconds 口径''',
  'DO 0');
PREPARE stmt FROM @ddl; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @col_exists := (
  SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'study_sessions' AND COLUMN_NAME = 'hidden_since'
);
SET @ddl := IF(@col_exists = 0,
  'ALTER TABLE study_sessions ADD COLUMN hidden_since DATETIME(3) DEFAULT NULL COMMENT ''当前连续挂机段起点；回到 visible 时置 NULL''',
  'DO 0');
PREPARE stmt FROM @ddl; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @col_exists := (
  SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'study_sessions' AND COLUMN_NAME = 'hidden_reason'
);
SET @ddl := IF(@col_exists = 0,
  'ALTER TABLE study_sessions ADD COLUMN hidden_reason VARCHAR(10) DEFAULT NULL COMMENT ''当前挂机段原因 away|idle；回到 visible 时置 NULL''',
  'DO 0');
PREPARE stmt FROM @ddl; EXECUTE stmt; DEALLOCATE PREPARE stmt;
