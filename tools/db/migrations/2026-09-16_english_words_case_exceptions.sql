-- 2026-09-16 英语词库：小写化后的**正字法例外**回改。
--
-- 上一支迁移把 word 统一小写。但有一类词「写小了在英文里就是错的」，必须保留原形：
--   · **代词 I** —— 英文里永远大写，学生看到 `i` 是错的
--   · **纯首字母缩写** —— UK / USA / PRC / PLA / HSK / DDT / VR / BCE / CE / UN / PM / PE / OK / Mr / Ms / Dr
--   · **约定俗成的混合大小写** —— X-ray / T-shirt / Wi-Fi
-- 人名地名（Adam/Africa/London…）**不在例外内**：写小了只是不规范、不影响学词，按用户要求保持小写。
--
-- ⚠️ **与同形小写词冲突的缩写无法回改**：`word` 的唯一键是大小写不敏感的，
-- 所以 `IT`/`it`、`US`/`us`、`WHO`/`who`、`AM`/`am` 本来就**只能存一行**。
-- 这四组保留**小写**那行（`it` 它 / `us` 我们 / `who` 谁 / `am` 是 —— 对 K12 词义重要得多），
-- 缩写的义项已合并进同一行（如 `it` 现在同时有「它」和「信息技术」）。
-- 要真正分开只能改 word 的排序规则为大小写敏感，属 schema 变更，另行决定。
--
-- 幂等：按 word 精确匹配更新，重跑无副作用。

UPDATE english_words SET word = 'I' WHERE word = 'i';

-- 纯缩写整体大写
UPDATE english_words SET word = UPPER(word)
WHERE word IN ('uk','usa','prc','pla','hsk','ddt','vr','bce','ce','un','pm','pe','ok');
-- ⚠️ 这三个**只首字母大写**（不是整体大写）：MR/MS/DR 是错的，必须写成 Mr/Ms/Dr
UPDATE english_words SET word = 'Mr' WHERE word = 'mr';
UPDATE english_words SET word = 'Ms' WHERE word = 'ms';
UPDATE english_words SET word = 'Dr' WHERE word = 'dr';

-- 约定俗成的混合大小写（只改首字母，其余保持）
UPDATE english_words SET word = 'X-ray' WHERE word = 'x-ray';
UPDATE english_words SET word = 'T-shirt' WHERE word = 't-shirt';
UPDATE english_words SET word = 'Wi-Fi' WHERE word = 'wi-fi';

-- 自检：这几行应各自打印出来（Mr/Ms/Dr 是首字母大写，其余整体大写）
SELECT word FROM english_words
WHERE word IN ('I','UK','USA','PRC','PLA','HSK','DDT','VR','BCE','CE','UN','PM','PE','OK','Mr','Ms','Dr','X-ray','T-shirt','Wi-Fi')
ORDER BY word;

-- 自检：冲突组应仍是小写且两个义项都在
SELECT word, CAST(meanings AS CHAR) AS meanings FROM english_words
WHERE word IN ('it','us','who','am');
