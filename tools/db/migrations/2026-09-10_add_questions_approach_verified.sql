-- 2026-09-10 题目内容更新工具：新增解题思路列 + 人工/AI 核验标记。
-- approach        解题思路：方法/切入点概述（考点判断、选什么方法、关键转化），
--                 与 explanation（完整分步过程）分离。
-- answer_verified 由 answer_importer 成功写入任一字段（answer/approach/explanation/type）
--                 时置 1，用于与管线提取的原始数据（0）区分。
ALTER TABLE questions
  ADD COLUMN approach TEXT DEFAULT NULL AFTER explanation,
  ADD COLUMN answer_verified TINYINT(1) NOT NULL DEFAULT 0;
