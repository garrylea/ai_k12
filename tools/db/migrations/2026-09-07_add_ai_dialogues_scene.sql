-- 迁移：ai_dialogues 新增 scene（会话场景分型）与 question_id（训练讲一讲按题锚）列
-- 适用：已在运行的 ai_k12 数据库（tools/db/schema.sql 已同步更新）
-- 执行：mysql -u ai_k12 -p ai_k12 < tools/db/migrations/2026-09-07_add_ai_dialogues_scene.sql
--
-- 背景：各系统（辅线答疑 / 课堂练习讲一讲 / 卡片思辨答疑 / 训练讲一讲）共用 ai_dialogues 一张表，
-- 此前只有 track(mainline/auxiliary) 可区分，导致训练「讲一讲」会话（track=auxiliary）与辅线答疑
-- 会话混在同一列表。新增 scene 按“使用场景”分型，列表按 scene 过滤。

-- 1. 新增列（scene 默认 aux_qna = 辅线答疑；question_id 供训练讲一讲按题 find-or-create）
ALTER TABLE ai_dialogues
  ADD COLUMN scene VARCHAR(30) NOT NULL DEFAULT 'aux_qna' AFTER track,
  ADD COLUMN question_id BIGINT DEFAULT NULL AFTER card_id;

-- 2. 新增查询索引（支撑 (student, track, scene, question_id) 按题 find-or-create）
ALTER TABLE ai_dialogues
  ADD KEY idx_dlg_student_scene_question (student_id, track, scene, question_id);

-- 3. 可选外键（ON DELETE SET NULL：题目删除时仅解锚，不级联删会话）
ALTER TABLE ai_dialogues
  ADD CONSTRAINT fk_dlg_question_id FOREIGN KEY (question_id) REFERENCES questions (id) ON DELETE SET NULL;

-- 4. 存量回填
-- 4.1 auxiliary：学生消息带「这道题目是：…」题面前缀的 → 训练讲一讲（旧实现把题面前缀进每条学生消息）；
--     其余 auxiliary 会话 → 辅线答疑（保持默认 aux_qna，无需 UPDATE）。
UPDATE ai_dialogues d
SET d.scene = 'aux_training'
WHERE d.track = 'auxiliary'
  AND EXISTS (
    SELECT 1 FROM ai_messages m
    WHERE m.dialogue_id = d.id
      AND m.role = 'user'
      AND m.content LIKE '这道题目是：%'
  );

-- 4.2 mainline：能被 main_error_books.dialogue_id 锚定的是题目级「讲一讲」；
--     其余 mainline（卡片级思辨答疑等）→ mainline_card（对默认值覆写）。
UPDATE ai_dialogues d
  JOIN main_error_books me ON me.dialogue_id = d.id
SET d.scene = 'mainline_question'
WHERE d.track = 'mainline';

UPDATE ai_dialogues
SET scene = 'mainline_card'
WHERE track = 'mainline' AND scene = 'aux_qna';
