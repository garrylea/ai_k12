-- 2026-11-28 精选题集（curated question set）：题集 / 题目映射 / 推荐 / 发布 / 已读
-- 设计：docs/superpowers/plans/2026-11-28-curated-question-set.md Task 1
-- 幂等：5 张新表用 CREATE TABLE IF NOT EXISTS；special_practice_sessions 的
--       列 / 索引 / 外键分别在 information_schema 判断后再 ALTER。

CREATE TABLE IF NOT EXISTS featured_question_sets (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  content_key CHAR(64) NOT NULL,
  subject_id BIGINT NOT NULL,
  created_by_student_id BIGINT DEFAULT NULL,
  review_status VARCHAR(16) NOT NULL DEFAULT 'pending',
  question_count SMALLINT NOT NULL,
  reviewed_by BIGINT DEFAULT NULL,
  reviewed_at DATETIME(3) DEFAULT NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3)
    ON UPDATE CURRENT_TIMESTAMP(3),
  UNIQUE KEY uniq_fqs_content_key (content_key),
  KEY idx_fqs_review (review_status, created_at),
  KEY idx_fqs_creator_day (created_by_student_id, created_at),
  CONSTRAINT fk_fqs_subject FOREIGN KEY (subject_id) REFERENCES subjects (id)
    ON DELETE RESTRICT,
  CONSTRAINT fk_fqs_creator FOREIGN KEY (created_by_student_id)
    REFERENCES students (id) ON DELETE SET NULL,
  CONSTRAINT fk_fqs_reviewer FOREIGN KEY (reviewed_by) REFERENCES admins (id)
    ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS featured_question_set_items (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  set_id BIGINT NOT NULL,
  question_id BIGINT NOT NULL,
  sort_order SMALLINT NOT NULL,
  UNIQUE KEY uniq_fqsi_set_question (set_id, question_id),
  UNIQUE KEY uniq_fqsi_set_order (set_id, sort_order),
  KEY idx_fqsi_question (question_id),
  CONSTRAINT fk_fqsi_set FOREIGN KEY (set_id)
    REFERENCES featured_question_sets (id) ON DELETE CASCADE,
  CONSTRAINT fk_fqsi_question FOREIGN KEY (question_id)
    REFERENCES questions (id) ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS featured_question_set_recommendations (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  set_id BIGINT NOT NULL,
  student_id BIGINT NOT NULL,
  student_grade_code VARCHAR(10) NOT NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  UNIQUE KEY uniq_fqsr_set_student (set_id, student_id),
  KEY idx_fqsr_set_grade (set_id, student_grade_code),
  CONSTRAINT fk_fqsr_set FOREIGN KEY (set_id)
    REFERENCES featured_question_sets (id) ON DELETE CASCADE,
  CONSTRAINT fk_fqsr_student FOREIGN KEY (student_id)
    REFERENCES students (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS featured_question_set_publications (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  set_id BIGINT NOT NULL,
  grade_code VARCHAR(10) NOT NULL,
  title VARCHAR(60) NOT NULL,
  reach_count INT NOT NULL,
  status VARCHAR(16) NOT NULL DEFAULT 'published',
  published_by BIGINT NOT NULL,
  published_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  withdrawn_by BIGINT DEFAULT NULL,
  withdrawn_at DATETIME(3) DEFAULT NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3)
    ON UPDATE CURRENT_TIMESTAMP(3),
  UNIQUE KEY uniq_fqsp_set_grade (set_id, grade_code),
  KEY idx_fqsp_grade_status (grade_code, status, published_at),
  CONSTRAINT fk_fqsp_set FOREIGN KEY (set_id)
    REFERENCES featured_question_sets (id) ON DELETE CASCADE,
  CONSTRAINT fk_fqsp_publisher FOREIGN KEY (published_by) REFERENCES admins (id)
    ON DELETE RESTRICT,
  CONSTRAINT fk_fqsp_withdrawer FOREIGN KEY (withdrawn_by) REFERENCES admins (id)
    ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS featured_question_set_reads (
  publication_id BIGINT NOT NULL,
  student_id BIGINT NOT NULL,
  read_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (publication_id, student_id),
  KEY idx_fqsr_student (student_id, read_at),
  CONSTRAINT fk_fqsread_publication FOREIGN KEY (publication_id)
    REFERENCES featured_question_set_publications (id) ON DELETE CASCADE,
  CONSTRAINT fk_fqsread_student FOREIGN KEY (student_id)
    REFERENCES students (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- special_practice_sessions.featured_publication_id：
-- 列 / 索引 / 外键分别以 information_schema 判重后再执行，保证重复执行不报错。
SET @has_col := (
  SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE()
    AND TABLE_NAME = 'special_practice_sessions'
    AND COLUMN_NAME = 'featured_publication_id'
);
SET @ddl := IF(
  @has_col = 0,
  'ALTER TABLE special_practice_sessions ADD COLUMN featured_publication_id BIGINT DEFAULT NULL',
  'SELECT 1'
);
PREPARE stmt FROM @ddl;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

SET @has_idx := (
  SELECT COUNT(*) FROM information_schema.STATISTICS
  WHERE TABLE_SCHEMA = DATABASE()
    AND TABLE_NAME = 'special_practice_sessions'
    AND INDEX_NAME = 'idx_sps_featured_publication'
);
SET @ddl := IF(
  @has_idx = 0,
  'ALTER TABLE special_practice_sessions ADD KEY idx_sps_featured_publication (featured_publication_id)',
  'SELECT 1'
);
PREPARE stmt FROM @ddl;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

SET @has_fk := (
  SELECT COUNT(*) FROM information_schema.TABLE_CONSTRAINTS
  WHERE TABLE_SCHEMA = DATABASE()
    AND TABLE_NAME = 'special_practice_sessions'
    AND CONSTRAINT_NAME = 'fk_sps_featured_publication'
    AND CONSTRAINT_TYPE = 'FOREIGN KEY'
);
SET @ddl := IF(
  @has_fk = 0,
  'ALTER TABLE special_practice_sessions ADD CONSTRAINT fk_sps_featured_publication FOREIGN KEY (featured_publication_id) REFERENCES featured_question_set_publications (id) ON DELETE SET NULL',
  'SELECT 1'
);
PREPARE stmt FROM @ddl;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;
