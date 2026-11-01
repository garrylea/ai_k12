-- 专项练习作答历史（一期：学生端查看 + 数据落库）
-- 与 exam_sessions / exam_answers 对称，但专项不限时、无 paper_id
-- spec: docs/superpowers/specs/2026-11-01-special-practice-answer-history-design.md
-- 幂等：CREATE TABLE IF NOT EXISTS

CREATE TABLE IF NOT EXISTS special_practice_sessions (
  id             BIGINT AUTO_INCREMENT PRIMARY KEY,
  session_uid    CHAR(36)     NOT NULL,
  student_id     BIGINT       NOT NULL,
  subject_id     BIGINT       NOT NULL,
  module         VARCHAR(32)  NOT NULL COMMENT 'chinese_dictation|chinese_interpretation|chinese_meaning|en_vocabulary|math_targeted|physics_targeted|chemistry_targeted',
  title          VARCHAR(120) DEFAULT NULL,
  question_count SMALLINT     NOT NULL DEFAULT 0,
  started_at     DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  completed_at   DATETIME(3)  DEFAULT NULL,
  created_at     DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at     DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  UNIQUE KEY uniq_sps_uid (session_uid),
  KEY idx_sps_student_time (student_id, started_at),
  CONSTRAINT fk_sps_student FOREIGN KEY (student_id) REFERENCES students (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS special_answer_records (
  id              BIGINT AUTO_INCREMENT PRIMARY KEY,
  session_id      BIGINT      NOT NULL,
  question_id     BIGINT      DEFAULT NULL COMMENT '数学/物理/化学非空；语文三专项/英语背词为 NULL',
  ref_type        VARCHAR(24) DEFAULT NULL COMMENT 'question|passage|word',
  ref_id          BIGINT      DEFAULT NULL COMMENT 'passage_id / word_id',
  sentence_index  SMALLINT    DEFAULT NULL COMMENT '解释/含义专项逐句',
  question_order  SMALLINT    NOT NULL,
  answer_text     TEXT,
  is_correct      TINYINT(1)  DEFAULT NULL COMMENT 'NULL=在途/未判',
  score           DECIMAL(3,2) DEFAULT NULL,
  method          VARCHAR(20) DEFAULT NULL COMMENT 'exact|ai|self_assess|unanswered|failed',
  analysis        TEXT,
  judged_at       DATETIME(3) DEFAULT NULL,
  created_at      DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at      DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  UNIQUE KEY uniq_sar_session_q (session_id, question_id),
  KEY idx_sar_session (session_id),
  KEY idx_sar_student_question (question_id),
  CONSTRAINT fk_sar_session FOREIGN KEY (session_id) REFERENCES special_practice_sessions (id) ON DELETE CASCADE,
  CONSTRAINT fk_sar_question FOREIGN KEY (question_id) REFERENCES questions (id) ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
