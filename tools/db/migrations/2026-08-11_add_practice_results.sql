-- 迁移：新建 practice_results 表（课堂练习判题结果持久化）
-- 适用：已在运行的 ai_k12 数据库（schema.sql 已同步更新）
-- 执行：mysql -u ai_k12 -p ai_k12 < tools/db/migrations/2026-08-11_add_practice_results.sql

CREATE TABLE IF NOT EXISTS practice_results (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  student_id BIGINT NOT NULL,
  subject_id BIGINT NOT NULL,
  card_id BIGINT NOT NULL,
  lesson_id BIGINT NOT NULL,
  question_id BIGINT DEFAULT NULL,
  question_n VARCHAR(20) NOT NULL,
  question_text TEXT NOT NULL,
  student_answer TEXT NOT NULL,
  is_correct TINYINT(1) NOT NULL,
  method VARCHAR(10) NOT NULL,
  analysis TEXT DEFAULT NULL,
  error_type VARCHAR(20) DEFAULT NULL,
  judged_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  UNIQUE KEY uniq_pr_student_card_qn (student_id, card_id, question_n),
  KEY idx_pr_student_card (student_id, card_id),
  KEY idx_pr_student_lesson (student_id, lesson_id),
  CONSTRAINT fk_pr_student_id FOREIGN KEY (student_id) REFERENCES students (id) ON DELETE CASCADE,
  CONSTRAINT fk_pr_card_id   FOREIGN KEY (card_id)   REFERENCES cards (id)    ON DELETE CASCADE,
  CONSTRAINT fk_pr_question_id FOREIGN KEY (question_id) REFERENCES questions (id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

DROP TRIGGER IF EXISTS trg_practice_results_updated_at;
CREATE TRIGGER trg_practice_results_updated_at
BEFORE UPDATE ON practice_results
FOR EACH ROW
SET NEW.updated_at = CURRENT_TIMESTAMP(3);
