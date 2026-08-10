-- 迁移：main_error_books 新增 lesson_id 列并回填历史数据
-- 适用：已在运行的 ai_k12 数据库（schema.sql 已同步更新）
-- 执行：mysql -u ai_k12 -p ai_k12 < tools/db/migrations/2026-08-10_add_main_error_books_lesson_id.sql

-- 1. 新增冗余列（可空，用于快速定位某节课的未清零错题）
ALTER TABLE main_error_books
  ADD COLUMN lesson_id BIGINT DEFAULT NULL AFTER source_ref_id;

-- 2. 新增查询索引
ALTER TABLE main_error_books
  ADD KEY idx_me_student_lesson_cleared (student_id, lesson_id, is_cleared);

-- 3. 可选外键（ON DELETE SET NULL，避免删除课时节点时级联误删错题记录）
ALTER TABLE main_error_books
  ADD CONSTRAINT fk_me_lesson_id FOREIGN KEY (lesson_id) REFERENCES lessons (id) ON DELETE SET NULL;

-- 4. 历史数据回填：按来源分别推导 lesson_id
-- 4.1 课堂练习 / 讨论：source_ref_id 即 cards.id
UPDATE main_error_books me
  JOIN cards c ON c.id = me.source_ref_id
SET me.lesson_id = c.lesson_id
WHERE me.source IN ('practice', 'discuss')
  AND me.source_ref_id IS NOT NULL;

-- 4.2 课后作业：source_ref_id 即 homework_submissions.id
UPDATE main_error_books me
  JOIN homework_submissions hs ON hs.id = me.source_ref_id
  JOIN homeworks h ON h.id = hs.homework_id
SET me.lesson_id = h.lesson_id
WHERE me.source = 'homework'
  AND me.source_ref_id IS NOT NULL;

-- 4.3 单元检测/期中/期末（unit_test/midterm/final）无法精确归到单节课，保持 NULL，
--     由单元/学期级门禁单独处理。
