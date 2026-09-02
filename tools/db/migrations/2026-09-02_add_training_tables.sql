-- 2026-09-02_add_training_tables.sql
-- 训练模块（考试/专项/错题练习）基础表。设计：docs/superpowers/specs/2026-09-02-math-training-module-design.md
-- 幂等：CREATE TABLE IF NOT EXISTS / ALTER 前检查 information_schema。

-- 试卷（爬取试卷的归组实体；source_key = published JSONL 相对路径，幂等键）
CREATE TABLE IF NOT EXISTS exam_papers (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  subject_id BIGINT NOT NULL,
  title VARCHAR(200) NOT NULL,
  grade VARCHAR(20) DEFAULT NULL,
  grade_band VARCHAR(20) DEFAULT NULL,
  semester VARCHAR(20) DEFAULT NULL,
  year SMALLINT DEFAULT NULL,
  district VARCHAR(50) DEFAULT NULL,
  exam_type VARCHAR(30) DEFAULT NULL,
  source_key VARCHAR(200) NOT NULL,
  question_count SMALLINT NOT NULL DEFAULT 0,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  UNIQUE KEY uniq_ep_source_key (source_key),
  CONSTRAINT fk_ep_subject FOREIGN KEY (subject_id) REFERENCES subjects (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 试卷-题目关联（多对多：content_hash 去重后同一题可属多卷；question_no 按 JSONL 行序）
CREATE TABLE IF NOT EXISTS paper_questions (
  paper_id BIGINT NOT NULL,
  question_id BIGINT NOT NULL,
  question_no SMALLINT NOT NULL,
  group_id VARCHAR(50) DEFAULT NULL,
  group_order SMALLINT DEFAULT NULL,
  PRIMARY KEY (paper_id, question_id),
  KEY idx_pq_question (question_id),
  CONSTRAINT fk_pq_paper FOREIGN KEY (paper_id) REFERENCES exam_papers (id) ON DELETE CASCADE,
  CONSTRAINT fk_pq_question FOREIGN KEY (question_id) REFERENCES questions (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 题级提示缓存（镜像 cards.hints 语义；训练题无卡，按 question_id 缓存）
CREATE TABLE IF NOT EXISTS question_hints (
  question_id BIGINT NOT NULL,
  hint TEXT NOT NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (question_id),
  CONSTRAINT fk_qh_question FOREIGN KEY (question_id) REFERENCES questions (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 考试会话（服务器权威计时：deadline_at；状态 in_progress | submitted）
CREATE TABLE IF NOT EXISTS exam_sessions (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  student_id BIGINT NOT NULL,
  paper_id BIGINT NOT NULL,
  subject_id BIGINT NOT NULL,
  status VARCHAR(20) NOT NULL DEFAULT 'in_progress',
  duration_minutes SMALLINT NOT NULL,
  started_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  deadline_at DATETIME(3) NOT NULL,
  submitted_at DATETIME(3) DEFAULT NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  KEY idx_es_student_status (student_id, status),
  CONSTRAINT fk_es_paper FOREIGN KEY (paper_id) REFERENCES exam_papers (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 考试逐题作答（is_correct NULL = 在途/未判；method: exact|ai|unanswered|failed）
CREATE TABLE IF NOT EXISTS exam_answers (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  session_id BIGINT NOT NULL,
  question_id BIGINT NOT NULL,
  question_order SMALLINT NOT NULL,
  answer_text TEXT,
  is_correct TINYINT(1) DEFAULT NULL,
  method VARCHAR(10) DEFAULT NULL,
  analysis TEXT,
  error_type VARCHAR(20) DEFAULT NULL,
  judged_at DATETIME(3) DEFAULT NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  UNIQUE KEY uniq_ea_session_q (session_id, question_id),
  CONSTRAINT fk_ea_session FOREIGN KEY (session_id) REFERENCES exam_sessions (id) ON DELETE CASCADE,
  CONSTRAINT fk_ea_question FOREIGN KEY (question_id) REFERENCES questions (id) ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
