-- 2026-09-16 英语背单词子系统：新建 english_words + student_word_progress 两张表。
--
-- 定位（与语文古诗文专项同形）：**独立子系统**。作答单位是「词 / 义项」，标准答案是词条
-- 自带属性，不接主线、没有「重做—清零」对象 —— 因此不挂 questions、不进错题本、不参与
-- 主线清零门禁、不用「不再展示」/提示缓存/自评。
--
-- 词源：义务教育英语课程标准（2022年版）附录词汇表（1600 词）
--     + 普通高中英语课程标准（2017年版2020年修订）附录词汇表（3000 词）。
-- 必须用课标官方 PDF 原文，不用百度文库/豆丁转载版（实测存在「内容可能由 AI 生成」的副本）。
--
-- 幂等性：本迁移**只有 CREATE TABLE IF NOT EXISTS，没有任何 ALTER/DELETE/DROP**，
-- 所以重跑天然安全，不需要 information_schema + PREPARE 包裹（那套是给 ADD COLUMN 用的，
-- 见 2026-09-16_chinese_interpretation_columns.sql）。2026-09-15 那次迁移因级联删题静默
-- 清空 50 行的教训见 docs/superpowers/plans/2026-09-15-chinese-passages-standalone.md Task 9
-- ——任何时候都不要用 `mysql --force` 应用迁移。
--
-- 应用方式：
--   mysql -u ai_k12 -pai_k12 ai_k12 < tools/db/migrations/2026-09-16_english_vocabulary.sql
-- tools/db/schema.sql 已同步收录这两张表（建库路径），本文件服务存量库。

-- ---- english_words：词库内容表（无外键，表即完整边界） ----
CREATE TABLE IF NOT EXISTS english_words (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  word VARCHAR(64) NOT NULL,              -- 官方原文大小写；业务键（幂等 upsert 键）
  phonetic VARCHAR(64) DEFAULT NULL,      -- 音标；官方课标附录未必收录，允许 NULL（勿用 LLM 补）
  level VARCHAR(20) NOT NULL,             -- primary|junior|senior_required|senior_elective
  meanings JSON NOT NULL,                 -- [{"pos":"n.","gloss":"地址","extended":false},
                                          --  {"pos":"v.","gloss":"处理；对付（问题）","extended":true,
                                          --   "context":"address the problem","note":"…"}]
  has_extended_sense TINYINT(1) NOT NULL DEFAULT 0,  -- 管线维护；须与 meanings 一致（check 第 6 条）
  root_key VARCHAR(64) DEFAULT NULL,      -- 词根族中心词（= 另一行的 word）；NULL = 无族
                                          -- 不变式：非 NULL 时必须存在 word = root_key 且 verified = 1 的行
  root_affixes JSON DEFAULT NULL,         -- [{"type":"suffix","code":"-less",
                                          --   "gloss":"无…的；没有…的","posHint":"→ 形容词"}]
  error_count INT NOT NULL DEFAULT 0,     -- 全局累计错次，只增；loader 重灌不得触碰
  sort_order INT NOT NULL DEFAULT 0,      -- 课标附录原序
  source_ref VARCHAR(200) DEFAULT NULL,   -- 出处（课标名 + 附录 + 序号），供人工核对
  verified TINYINT(1) NOT NULL DEFAULT 0, -- 内容是否已校验通过
  is_active TINYINT(1) NOT NULL DEFAULT 1,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  UNIQUE KEY uniq_english_words_word (word),
  KEY idx_english_words_pool (level, is_active, verified, sort_order),
  KEY idx_english_words_root (root_key),
  KEY idx_english_words_extended (has_extended_sense)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ---- student_word_progress：学生背词进度（轻量，不做艾宾浩斯排程） ----
-- word_id 上故意不设外键：内容表必须能被内容管线随时全量重灌，入向外键会让 full-reload
-- 的业务数据守卫与重灌互相卡死。student_id 照既有约定挂 students(id)（同 practice_results）。
CREATE TABLE IF NOT EXISTS student_word_progress (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  student_id BIGINT NOT NULL,
  word_id BIGINT NOT NULL,
  learned TINYINT(1) NOT NULL DEFAULT 0,  -- 答对过即置 1（「只出没背过的」靠它）
  wrong_count INT NOT NULL DEFAULT 0,     -- 学生自己的累计错次，可被「移除易错标记」清零
  last_result VARCHAR(20) DEFAULT NULL,   -- correct|off_target|wrong|unanswered|undetermined
  last_seen_at DATETIME(3) DEFAULT NULL,  -- 「今日已背 N」靠它
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  UNIQUE KEY uniq_swp_student_word (student_id, word_id),
  KEY idx_swp_student_seen (student_id, last_seen_at),
  KEY idx_swp_student_wrong (student_id, wrong_count),
  CONSTRAINT fk_swp_student_id FOREIGN KEY (student_id) REFERENCES students (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ---- 应用后自检：两张表各应打印出下面这些列，且 fk 只应有一条（student_id） ----
SELECT TABLE_NAME, COLUMN_NAME, COLUMN_TYPE, IS_NULLABLE, COLUMN_DEFAULT
FROM information_schema.COLUMNS
WHERE TABLE_SCHEMA = DATABASE()
  AND TABLE_NAME IN ('english_words', 'student_word_progress')
ORDER BY TABLE_NAME, ORDINAL_POSITION;

SELECT CONSTRAINT_NAME, TABLE_NAME, COLUMN_NAME, REFERENCED_TABLE_NAME, REFERENCED_COLUMN_NAME
FROM information_schema.KEY_COLUMN_USAGE
WHERE TABLE_SCHEMA = DATABASE()
  AND TABLE_NAME IN ('english_words', 'student_word_progress')
  AND REFERENCED_TABLE_NAME IS NOT NULL;
