-- 2026-09-13 修复 questions.content_hash 唯一索引漂移。
--
-- 成因：questions 由 CREATE TABLE IF NOT EXISTS 创建，对早已存在的库是空操作，
-- 故 schema.sql 新增的键（含 UNIQUE KEY uniq_q_content_hash）永远补不到老库。
-- 后果：answer_importer / 种子脚本的 ON DUPLICATE KEY UPDATE 静默插重复；
-- questions.repo.ts::findOrCreate 依赖 ER_DUP_ENTRY 兜并发竞态的保护失效。
--
-- 幂等：先查 information_schema 是否已有覆盖 content_hash 的**唯一**索引，没有才建。
-- 不 DROP 同列上遗留的非唯一索引（冗余但无害，避免破坏性操作）。
-- 注意：若库中已存在重复 content_hash，本迁移会以 ER_DUP_ENTRY 报错——这是**期望的**
-- 响亮失败。先跑下面注释里的诊断查询清理重复，再重跑本迁移。
--
--   SELECT content_hash, COUNT(*) c FROM questions
--   WHERE content_hash IS NOT NULL GROUP BY content_hash HAVING c > 1;

SET @has_uniq := (
  SELECT COUNT(*) FROM (
    SELECT INDEX_NAME
    FROM information_schema.STATISTICS
    WHERE TABLE_SCHEMA = DATABASE()
      AND TABLE_NAME = 'questions'
      AND NON_UNIQUE = 0
    GROUP BY INDEX_NAME
    -- COUNT(*)=1 且唯一列就是 content_hash：即「**单列**唯一索引」。
    -- 不能用「某行 NON_UNIQUE=0」判定——复合唯一索引（如 UNIQUE (content_hash, source)）
    -- 在 STATISTICS 里每一列都记 NON_UNIQUE=0，但并不让 content_hash 单独唯一，
    -- 那样会静默跳过本迁移、漏洞照旧。
    HAVING COUNT(*) = 1 AND MIN(COLUMN_NAME) = 'content_hash'
  ) AS uniq_single_col
);

SET @ddl := IF(
  @has_uniq = 0,
  'ALTER TABLE questions ADD UNIQUE KEY uniq_q_content_hash (content_hash)',
  'SELECT 1'
);

PREPARE stmt FROM @ddl;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;
