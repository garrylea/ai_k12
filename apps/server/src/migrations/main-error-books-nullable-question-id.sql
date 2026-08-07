-- main_error_books.question_id 原为 NOT NULL；为支持"质量差仅存题面"场景（question_id=null），
-- 改为可空，与 aux_error_books 一致。一次性运行。
ALTER TABLE main_error_books MODIFY question_id BIGINT NULL;
-- 同时去掉外键约束的 RESTRICT 限制（若存在）以便删除/归档，或保持 RESTRICT 但允许 NULL。
-- 注意：FK 约束 question_id -> questions(id) 若为 RESTRICT，NULL 仍可插入（FK 不检查 NULL）。保留即可。
