-- 2026-09-16 语文古诗文「解释（翻译）」专项：chinese_passages 增加三列内容列。
--
-- 背景：解释专项按「三行对译」作答（原文 → 该句关键字词 → 整句翻译），
-- 判题粒度是**逐句**。三列各承载什么：
--   key_terms       重点字词：JSON 数组，每项 {term, gloss, src, sentenceIndex}
--                   sentenceIndex 指向 sentences 的下标（「这个字词属于哪一句」）
--   sentences       逐句：JSON 数组，每项 {text, translation}
--                   不变式 ''.join(text) == body 逐字相等（含标点），入库自检断言
--   full_translation 整篇译文（TEXT，不是 JSON）
--
-- 字词由用户整理后交给内容管线（tools/data-refinery/src/interpretation_cli.py）；
-- 译文混合模式：输入给了就用输入的，没给由管线调本地 LLM 生成。
--
-- 幂等：先查列是否存在，不存在才 ADD。注意这里**只有 ADD COLUMN，没有任何 DELETE/DROP**
-- —— 2026-09-15 那次迁移因级联删题静默清空 50 行的教训见
-- docs/superpowers/plans/2026-09-15-chinese-passages-standalone.md Task 9。

-- ---- key_terms ----
SET @has_col := (
  SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE()
    AND TABLE_NAME = 'chinese_passages'
    AND COLUMN_NAME = 'key_terms'
);
SET @ddl := IF(
  @has_col = 0,
  'ALTER TABLE chinese_passages ADD COLUMN key_terms JSON DEFAULT NULL AFTER body',
  'SELECT 1'
);
PREPARE stmt FROM @ddl;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

-- ---- sentences ----
SET @has_col := (
  SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE()
    AND TABLE_NAME = 'chinese_passages'
    AND COLUMN_NAME = 'sentences'
);
SET @ddl := IF(
  @has_col = 0,
  'ALTER TABLE chinese_passages ADD COLUMN sentences JSON DEFAULT NULL AFTER key_terms',
  'SELECT 1'
);
PREPARE stmt FROM @ddl;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

-- ---- full_translation ----
SET @has_col := (
  SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE()
    AND TABLE_NAME = 'chinese_passages'
    AND COLUMN_NAME = 'full_translation'
);
SET @ddl := IF(
  @has_col = 0,
  'ALTER TABLE chinese_passages ADD COLUMN full_translation TEXT DEFAULT NULL AFTER sentences',
  'SELECT 1'
);
PREPARE stmt FROM @ddl;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;
