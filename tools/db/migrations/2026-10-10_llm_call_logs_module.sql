-- ============================================================
-- llm_call_logs 加 module 列（LLM 账本按学习模块归因）
-- 设计：docs/superpowers/specs/2026-10-10-llm-module-attribution-design.md §2.1
-- ============================================================
-- module = HTTP 请求模块（api 第一段，复用 moduleFromRoute：/api/practice/... → practice），
-- 与 api_request_logs.module 同源同值域；后台任务（解释缓存 / 标题生成 / 探活）无 HTTP 上下文 → NULL。
-- 历史行不回填（无可靠来源），上线前的行恒 NULL，报表单列「后台任务/未归因」。
--
-- 幂等：MySQL 8/9 没有 ADD COLUMN / ADD INDEX IF NOT EXISTS，
-- 列与索引各写一段 information_schema + PREPARE 守卫（与 2026-09-20_analytics_ledger.sql
-- 的带守卫 DROP 同套路，方向相反）；两段独立守卫，覆盖「列加了、索引没加」的中间态。

-- 1) 列：module
SET @has_col := (SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'llm_call_logs' AND COLUMN_NAME = 'module');
SET @ddl := IF(@has_col = 0,
  'ALTER TABLE llm_call_logs ADD COLUMN module VARCHAR(32) DEFAULT NULL COMMENT ''HTTP 请求模块（api 第一段，同 api_request_logs.module）；后台任务为 NULL'' AFTER scene',
  'SELECT 1');
PREPARE stmt FROM @ddl; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- 2) 索引：idx_lcl_module_time (module, created_at)
SET @has_idx := (SELECT COUNT(*) FROM information_schema.STATISTICS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'llm_call_logs' AND INDEX_NAME = 'idx_lcl_module_time');
SET @ddl := IF(@has_idx = 0,
  'ALTER TABLE llm_call_logs ADD KEY idx_lcl_module_time (module, created_at)',
  'SELECT 1');
PREPARE stmt FROM @ddl; EXECUTE stmt; DEALLOCATE PREPARE stmt;
