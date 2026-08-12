-- 迁移：main_error_books 新增 question_n 列（卡内复合题号，错题清零用）
-- 适用：已在运行的 ai_k12 数据库（schema.sql 已同步更新）
-- 执行：mysql -u ai_k12 -p ai_k12 < tools/db/migrations/2026-08-12_add_main_error_books_question_n.sql
--
-- 说明：question_n 优先从 practice_results 回填（同 student+card+question_id/题面）。
--       practice_results 缺失的历史行（如 08-11 持久化功能上线前的错题）由
--       apps/server/src/scripts/backfill-error-question-n.ts 按 card.content_metadata 文本匹配补全。

-- 1. 新增列
ALTER TABLE main_error_books
  ADD COLUMN question_n VARCHAR(20) DEFAULT NULL AFTER source_ref_id;

-- 2. 从 practice_results 回填：question_id 非空且匹配的行
UPDATE main_error_books me
  JOIN practice_results pr ON pr.student_id = me.student_id
    AND pr.card_id = me.source_ref_id
    AND pr.question_id IS NOT NULL
    AND pr.question_id = me.question_id
SET me.question_n = pr.question_n
WHERE me.question_n IS NULL
  AND me.source = 'practice'
  AND me.question_id IS NOT NULL;

-- 3. 从 practice_results 回填：question_id 为空、按题面匹配的行
UPDATE main_error_books me
  JOIN practice_results pr ON pr.student_id = me.student_id
    AND pr.card_id = me.source_ref_id
    AND pr.question_id IS NULL
    AND pr.question_text = me.wrong_answer_text
SET me.question_n = pr.question_n
WHERE me.question_n IS NULL
  AND me.source = 'practice'
  AND me.question_id IS NULL
  AND me.wrong_answer_text IS NOT NULL;
