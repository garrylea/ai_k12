-- 2026-09-09 判题体系重构：主观题学生自评留痕表
-- 设计：docs/superpowers/specs/2026-09-09-judging-rework-design.md §7.2
CREATE TABLE IF NOT EXISTS question_self_assessments (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  student_id BIGINT NOT NULL,
  question_id BIGINT NOT NULL,
  assessment VARCHAR(10) NOT NULL,        -- 'correct' | 'incorrect'
  source VARCHAR(20) NOT NULL,            -- 'targeted' | 'error_practice' | 'exam' | 'practice'
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  KEY idx_qsa_student_question (student_id, question_id),
  CONSTRAINT fk_qsa_student FOREIGN KEY (student_id) REFERENCES students (id) ON DELETE CASCADE,
  CONSTRAINT fk_qsa_question FOREIGN KEY (question_id) REFERENCES questions (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
