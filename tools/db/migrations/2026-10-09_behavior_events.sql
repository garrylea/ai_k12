-- 2026-10-09_behavior_events.sql
-- 埋点 Phase 2：行为事件流（母 spec 2026-09-19-analytics-instrumentation-design.md §4.3 原文 DDL）。
-- 幂等：CREATE TABLE IF NOT EXISTS。手工 apply：
--   mysql -u root -p ai_k12 < tools/db/migrations/2026-10-09_behavior_events.sql
CREATE TABLE IF NOT EXISTS behavior_events (
  id           BIGINT AUTO_INCREMENT PRIMARY KEY,
  actor_role   VARCHAR(10)  NOT NULL DEFAULT 'student' COMMENT 'student|parent|admin|system',
  student_id   BIGINT       DEFAULT NULL COMMENT 'admin/parent/匿名事件为 NULL',
  event        VARCHAR(40)  NOT NULL COMMENT '封闭字典，见母 spec §5.2',
  tier         VARCHAR(8)   NOT NULL COMMENT 'parent|ops —— 写时由字典决定，调用方不可覆盖',
  module       VARCHAR(32)  DEFAULT NULL,
  scene        VARCHAR(40)  DEFAULT NULL,
  subject_id   BIGINT       DEFAULT NULL,
  ref_type     VARCHAR(24)  DEFAULT NULL,
  ref_id       BIGINT       DEFAULT NULL,
  session_uid  CHAR(36)     DEFAULT NULL COMMENT '关联 study_sessions.session_uid',
  request_id   VARCHAR(64)  DEFAULT NULL COMMENT '关联 api_request_logs.request_id',
  source       VARCHAR(8)   NOT NULL COMMENT 'server|client',
  props        JSON         DEFAULT NULL COMMENT '只放低基数补充，禁止塞自由文本',
  client_ts_ms BIGINT       DEFAULT NULL COMMENT '仅参考，以 created_at 为准',
  created_at   DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  KEY idx_be_student_event_time (student_id, event, created_at),
  KEY idx_be_event_time         (event, created_at),
  KEY idx_be_module_time        (module, created_at),
  KEY idx_be_tier_time          (tier, created_at),
  KEY idx_be_session            (session_uid),
  CONSTRAINT fk_be_student_id FOREIGN KEY (student_id) REFERENCES students (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
