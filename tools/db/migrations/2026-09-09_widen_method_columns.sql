-- 2026-09-09 判题体系重构：method 列加宽。
-- 执行：mysql -u ai_k12 -p ai_k12 < tools/db/migrations/2026-09-09_widen_method_columns.sql
-- 新枚举值 'self_assess'（11 字符）超出 VARCHAR(10)——practice_results（自评补行）与
-- exam_answers（考试主观题）都会写入，严格模式下会插入报错。
ALTER TABLE practice_results MODIFY method VARCHAR(20) NOT NULL COMMENT "'exact' | 'ai' | 'self_assess' | 'unanswered'";
-- exam_answers.method 原无 COMMENT，保持只改长度避免无谓 diff。
ALTER TABLE exam_answers MODIFY method VARCHAR(20) DEFAULT NULL;
