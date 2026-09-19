-- 2026-09-21 埋点 Phase 1A：学习会话（学习时长的唯一真源）。
--
-- 背景（见 docs/superpowers/specs/2026-09-19-analytics-instrumentation-design.md §4.2）：
--   全库此前没有任何时长/会话表；`progress.last_active_at` 只在首次领课时写一次且仓储不读，
--   `devices.last_active_at` 从未写入。家长端只有「近 7 天活跃天数」这一**代理指标**，
--   无法回答「今天学了多久 / 这周比上周多还是少」。
--
-- 口径：
--   * `active_seconds` **只由服务端累计**：心跳时按 `last_heartbeat_at` 差值增量，
--     单次封顶 45s。客户端上报的秒数一律不采信（不封顶时「关标签 2 小时」会被算成 2 小时）。
--   * 设备画像**只到「类别」**，不存任何能唯一定位一台设备的标识（也不存原始 UA 字符串）。
--     `platform_class` / `browser` 由服务端从 User-Agent 粗分类（防客户端伪造）；
--     `screen_class` / `input_type` / `app_shell` 由前端上报（服务端拿不到）。
--   * iPadOS 13+ 的 Safari UA 写的是 `Macintosh`，只看 UA 会把 iPad 误判成 Mac——
--     服务端在写入时应用「platform_class == 'mac' 且 input_type == 'touch' → ipad」校正。
--
-- 幂等：建表用 CREATE TABLE IF NOT EXISTS，重复执行无副作用。
--
-- ⚠️ schema.sql 已同步（无迁移运行器，两处必须一致）。

CREATE TABLE IF NOT EXISTS study_sessions (
  id                BIGINT AUTO_INCREMENT PRIMARY KEY,
  student_id        BIGINT       NOT NULL,
  session_uid       CHAR(36)     NOT NULL COMMENT '前端生成的幂等键',
  module            VARCHAR(32)  NOT NULL COMMENT '低基数枚举，见 spec §5.1',
  scene             VARCHAR(40)  NOT NULL COMMENT '路由级细分，比 module 细',
  subject_id        BIGINT       DEFAULT NULL,
  ref_type          VARCHAR(24)  DEFAULT NULL COMMENT 'lesson|card|paper|passage|word|dialogue',
  ref_id            BIGINT       DEFAULT NULL,
  status            VARCHAR(12)  NOT NULL DEFAULT 'active' COMMENT 'active|ended|abandoned',
  client_state      VARCHAR(10)  NOT NULL DEFAULT 'visible' COMMENT 'visible|hidden（上次心跳时的可见性）',
  active_seconds    INT          NOT NULL DEFAULT 0 COMMENT '服务端累计；客户端上报的秒数一律不采信',
  heartbeat_count   INT          NOT NULL DEFAULT 0,
  started_at        DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  last_heartbeat_at DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  ended_at          DATETIME(3)  DEFAULT NULL,
  end_reason        VARCHAR(20)  DEFAULT NULL COMMENT 'route_change|pagehide|idle_timeout|closed|hidden_timeout',
  platform_class    VARCHAR(20)  DEFAULT NULL COMMENT 'ipad|iphone|android_tablet|android_phone|mac|windows|linux|other（服务端解析 UA）',
  browser           VARCHAR(20)  DEFAULT NULL COMMENT 'chrome|safari|edge|firefox|electron|other（服务端解析 UA）',
  screen_class      VARCHAR(20)  DEFAULT NULL COMMENT 'ipad_landscape|desktop|tablet_portrait|mobile（前端上报）',
  input_type        VARCHAR(10)  DEFAULT NULL COMMENT 'touch|mouse|hybrid（前端上报）',
  app_shell         VARCHAR(10)  DEFAULT NULL COMMENT 'web|electron（前端上报）',
  created_at        DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at        DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  UNIQUE KEY uniq_ss_uid (session_uid),
  KEY idx_ss_student_time   (student_id, started_at),
  KEY idx_ss_student_module (student_id, module, started_at),
  KEY idx_ss_open           (status, last_heartbeat_at),
  KEY idx_ss_platform_time  (platform_class, started_at),
  CONSTRAINT fk_ss_student_id FOREIGN KEY (student_id) REFERENCES students (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
