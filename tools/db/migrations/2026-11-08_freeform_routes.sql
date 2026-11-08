-- 2026-11-08 做题入口（freeform）：两条模型路由 + uploaded_files URL 查询索引。
-- 幂等：路由走 ON DUPLICATE KEY UPDATE（uniq_llm_routes = scene+subject）；
--       索引先查 information_schema.statistics，已存在则跳过 DDL。
-- 依赖 llm_models 已有 model_key IN ('local','qwen3.8-max')（外键 fk_llm_routes_primary）。
--
-- 选址口径：拆题要快 → 本地优先、qwen3.8-max 兜底；判题要准 → qwen3.8-max 直出、不设兜底。

INSERT INTO llm_routes (scene, subject, primary_model_key, fallback_model_key)
VALUES
  ('freeform_split', '*', 'local', 'qwen3.8-max'),
  ('freeform_judge', '*', 'qwen3.8-max', NULL)
ON DUPLICATE KEY UPDATE
  primary_model_key = VALUES(primary_model_key),
  fallback_model_key = VALUES(fallback_model_key);

-- uploaded_files 按 (uploader_id, url) 反查：此前只有 (uploader_type, uploader_id)，
-- WHERE url = ? AND uploader_id = ? 会全表扫。
SET @idx_exists := (
  SELECT COUNT(*)
    FROM information_schema.statistics
   WHERE table_schema = DATABASE()
     AND table_name = 'uploaded_files'
     AND index_name = 'idx_uf_uploader_url'
);
SET @ddl := IF(
  @idx_exists = 0,
  'ALTER TABLE uploaded_files ADD INDEX idx_uf_uploader_url (uploader_id, url)',
  'SELECT 1'
);
PREPARE stmt FROM @ddl;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;
