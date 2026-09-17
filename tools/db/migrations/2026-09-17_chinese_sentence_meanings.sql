-- 2026-09-17 语文古诗文「含义」专项：chinese_passages 增加 sentence_meanings 列。
--
-- 承载每句的「深层含义」与「作者情感」，**与 sentences 下标对齐**的 JSON 数组：
--   [{"meaning": "…", "emotion": "…"}, …]
--   某一句没有含义数据时该位置写 null（不是省略——省略会让后面整体错位）。
--
-- 为什么是独立新列、而不是并进 sentences JSON：
--   interpretation_loader.py 是全量 `UPDATE chinese_passages SET sentences=%s …`，
--   并进去的话重跑一次解释管线就会把含义数据整列抹掉。分列存是硬要求。
--
-- 只给诗词篇目灌数据，文言文留 NULL —— 「只做诗词」由数据有无实现，不加体裁列。
--
-- 幂等：先查 information_schema.COLUMNS 再 ADD（照 2026-09-16_chinese_interpretation_columns.sql 写法）。
-- 本文件**只有 ADD COLUMN，没有任何 DELETE / DROP**。

SET @has_col := (
  SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE()
    AND TABLE_NAME = 'chinese_passages'
    AND COLUMN_NAME = 'sentence_meanings'
);
SET @ddl := IF(
  @has_col = 0,
  'ALTER TABLE chinese_passages ADD COLUMN sentence_meanings JSON DEFAULT NULL AFTER sentences',
  'SELECT 1'
);
PREPARE stmt FROM @ddl;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;
