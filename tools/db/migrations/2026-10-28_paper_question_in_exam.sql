-- ============================================================
-- paper_questions.in_exam：题目是否进入「真题考试」
-- 背景：语文首期只考基础运用 + 古诗文 + 名著，现代文阅读（17-26）与作文（27）暂不进考试
-- ============================================================
-- 为什么不用「有没有 material_text」筛：语文基础运用 1-7 也带材料（科技节文段），
-- 阅读题与材料题无法靠字段区分；用显式标记，后续支持阅读/作文时把它改回 1 即可。
-- 默认 1 = 现有行为（数学/化学卷完全不受影响）。
--
-- 幂等：MySQL 8/9 没有 ADD COLUMN IF NOT EXISTS，用 information_schema + PREPARE 守卫
-- （与 2026-10-10_llm_call_logs_module.sql 同套路）。

-- 1) 列：in_exam
SET @has_col := (SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'paper_questions' AND COLUMN_NAME = 'in_exam');
SET @ddl := IF(@has_col = 0,
  'ALTER TABLE paper_questions ADD COLUMN in_exam TINYINT(1) NOT NULL DEFAULT 1 COMMENT ''是否进入真题考试（0=仅试卷入口可见，不组卷）'' AFTER group_order',
  'SELECT 1');
PREPARE stmt FROM @ddl; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- 2) 首期口径：语文 2025 海淀二模（paper 17）题 17-27（现代文阅读 + 作文）不进考试
--    按 source_key 定位（不写死 paper_id），换库/重建后重跑仍命中同一张卷。
UPDATE paper_questions pq
JOIN exam_papers p ON p.id = pq.paper_id
SET pq.in_exam = 0
WHERE p.subject_id = 2
  AND p.source_key LIKE '语文/初中/second/2025/语文-初三(下)-202507-海淀-模拟二-试卷%'
  AND pq.question_no >= 17;
