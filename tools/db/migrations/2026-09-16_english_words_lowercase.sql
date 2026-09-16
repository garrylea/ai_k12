-- 2026-09-16 英语词库：word 统一小写。
--
-- 背景：`english_words.word` 用的是 `utf8mb4_unicode_ci`（**大小写不敏感**），
-- 所以唯一键 uniq_english_words_word 本来就把 `China` 和 `china` 当成同一个词 ——
-- 两个不同大小写的词**根本存不进来**，只会互相覆盖。库里因此留下一批大写开头的行
-- （教材单词表里的专名：Bill/Tom/Sydney/China/Green…）。
--
-- 按用户 2026-09-16 裁决：**统一小写**。这样数据与唯一键的语义一致，
-- 也不再出现「同一个词两种写法」的隐性歧义。
--
-- 安全性：因为唯一键本就大小写不敏感，**不可能存在只差大小写的两行**，
-- 所以 LOWER() 不会撞唯一键，也不会丢行。下面先断言这一点，再更新。
--
-- 幂等：LOWER() 对小写串是空操作，重跑安全。

-- ---- 前置断言：若存在只差大小写的两行，立刻中止（说明唯一键语义被改过）----
SET @dupes := (
  SELECT COUNT(*) FROM (
    SELECT LOWER(word) AS lw FROM english_words GROUP BY LOWER(word) HAVING COUNT(*) > 1
  ) t
);
SET @ddl := IF(
  @dupes > 0,
  'SELECT * FROM `中止：存在只差大小写的重复行，请先人工合并再跑本迁移`',
  'SELECT 1'
);
PREPARE stmt FROM @ddl;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

-- ---- 更新 ----
UPDATE english_words SET word = LOWER(word) WHERE word <> BINARY LOWER(word);
UPDATE english_words SET root_key = LOWER(root_key) WHERE root_key IS NOT NULL AND root_key <> BINARY LOWER(root_key);

-- ---- 自检：应打印 0 ----
SELECT COUNT(*) AS 仍含大写的词数_应为0 FROM english_words WHERE word <> BINARY LOWER(word);
SELECT COUNT(*) AS 仍含大写的族键数_应为0 FROM english_words WHERE root_key IS NOT NULL AND root_key <> BINARY LOWER(root_key);
