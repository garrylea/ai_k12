-- 2026-09-15 语文古诗文专项独立化：dictation_passages → chinese_passages，摘除 question_id。
--
-- 用法：mysql -u ai_k12 -pai_k12 ai_k12 < tools/db/migrations/2026-09-15_chinese_passages.sql
--   **不要加 --force / -f**：下面第 0 步的两道中止闸门靠「语句报错让 mysql 停下」实现，
--   --force 会忽略错误继续往下执行，等于把闸门拆掉（实测：加 --force 后闸门报 1146，
--   脚本仍继续执行到删除步骤）。不加 --force 时首错即停、退出码 1。
--   **必须先选库**（脚本全程依赖 DATABASE()）：不选库时闸门 0a 静默通过、
--   0b 在 DELETE 之前就报 ERROR 1046 停下（行为是安全的，只是错误信息不够直白）。
--
-- 背景：默写专项当初「贴着 questions 表」建（每篇挂一行 questions，错题本/隐藏题/提示缓存
-- 都挂 question_id）。2026-09-15 用户裁决：古诗文专项是**独立子系统**——不挂 questions、
-- 不进错题本、不参与主线清零门禁（PRD §6.3 / §7.4）。
-- 设计见 docs/superpowers/specs/2026-09-15-chinese-interpretation-special-design.md §6。
--
-- 步骤：
--   0. 两道中止闸门（见下，**在任何删除之前**）
--   1. 清 main_error_books(source='dictation')
--   1.5 摘 dictation_passages 自己的 CASCADE 外键（**必须在 2 之前**，见 1.5 步的警告）
--   2. 删 questions(type='poem_dictation')
--   3. dictation_passages 改名 chinese_passages
--   4. 摘 question_id 的唯一键与列，并改名其余索引
--   5. 加 is_active
--
-- **步骤顺序里有三处硬约束，其余是选择**（别照抄成「全是 FK 逼的」）：
--   · 1 → 2：硬约束。main_error_books.question_id 是 ON DELETE RESTRICT，不先清就被拦。
--   · 1.5 → 2：**最要命的硬约束**。dictation_passages 自己的 fk_dp_question 是
--     ON DELETE CASCADE，不先摘掉，第 2 步删题会把全部篇目行**级联清空**（静默数据丢失，
--     2026-09-15 实库踩过，靠备份恢复——详见 1.5 步的注释）。
--   · 4a → 4b：硬约束。MySQL 不允许在 FK 仍使用该索引时 DROP INDEX（1.5 已在改名前
--     摘掉了外键，故改名后只剩唯一键→列这一个顺序约束）。
--   · 1/2 排在 3 之前：**选择**（先清数据再改名更直观）。代价是下面的 @first_run
--     把「清理」与「改名」耦合成同一个开关。
--
-- 引用 questions(id) 的外键分三类：
--   ON DELETE CASCADE（第 2 步删题时跟着自动清）：
--     **dictation_passages 自己（fk_dp_question）← 必须先摘，见 1.5，否则篇目全丢**
--     question_hints / student_hidden_questions / question_self_assessments /
--     paper_questions / question_knowledge_points（这些本来就该跟着清，无风险）
--   ON DELETE RESTRICT（**有行就被拦、整个脚本中断**——「能否成功取决于数据而非 schema」）：
--     main_error_books（第 1 步已清）/ answers / aux_error_books / exam_answers / variation_questions
--   ON DELETE SET NULL（有行则静默把外键置空，不报错但会改数据）：
--     practice_results / ai_dialogues
-- 实测（2026-09-15，本库）：这 50 行在上列 RESTRICT 四张与 SET NULL 两张里**全部 0 行**。
--
-- 执行前置检查（换库执行前必跑，六列应全为 0；任一非 0 就停下来人工判断）：
--   SELECT
--     (SELECT COUNT(*) FROM answers              WHERE question_id IN (SELECT id FROM questions WHERE type='poem_dictation')) AS answers,
--     (SELECT COUNT(*) FROM aux_error_books      WHERE question_id IN (SELECT id FROM questions WHERE type='poem_dictation')) AS aux_error_books,
--     (SELECT COUNT(*) FROM exam_answers         WHERE question_id IN (SELECT id FROM questions WHERE type='poem_dictation')) AS exam_answers,
--     (SELECT COUNT(*) FROM variation_questions  WHERE question_id IN (SELECT id FROM questions WHERE type='poem_dictation')) AS variation_questions,
--     (SELECT COUNT(*) FROM practice_results     WHERE question_id IN (SELECT id FROM questions WHERE type='poem_dictation')) AS practice_results,
--     (SELECT COUNT(*) FROM ai_dialogues         WHERE question_id IN (SELECT id FROM questions WHERE type='poem_dictation')) AS ai_dialogues;
--   ⚠️ aux_error_books **不在 tools/db/schema.sql 里**（线上漂移表），按 schema.sql 新建的库上
--      这条会报 ERROR 1146 而不是返回 0 —— 那种库上本迁移本来也无事可做。
--
-- 停用态不承接（**已知取舍，非疏漏**）：第 5 步新增的 is_active 一律 DEFAULT 1，
-- **不承接 questions.is_active**（第 1、2 步已先删了题行，第 5 步才加列，顺序上无法回填）。
-- 本库实测 50 行的 questions.is_active 全为 1，故影响为 0；换库前请确认：
--   SELECT COUNT(*) FROM questions WHERE type='poem_dictation' AND is_active = 0;
--
-- 幂等：每步先查 information_schema。跑第二遍时 @first_run=0 → 1/1.5/2/3 跳过；
--   1.5 的守卫查 dictation_passages（已不存在）→ 0 → 跳过；
--   表内已无 uniq_dp_question / question_id，索引已改名，is_active 已在 → 4–5 全跳过。
--   **唯一不能自愈的是下面第 0 步的闸门一**（表名撞车）。
--
-- ⚠️ 不可恢复（第 1、2 步删的是学生数据与题库行）。执行前先备份到**持久目录**：
--   mkdir -p tools/db/backups
--   mysqldump -u ai_k12 -pai_k12 ai_k12 main_error_books questions dictation_passages \
--     > tools/db/backups/20260915_chinese_passages.sql
--   （本仓 2026-08-26 有过一次教训：备份写在 /tmp 被系统清理删掉，业务数据丢失。
--     见 docs/ai-core-changelog.md 2026-08-28~29 条目 ③「今后备份一律放持久目录」。）

-- ==== 0a. 闸门一：两表并存就中止（**必须在任何删除之前**） ====
-- 触发路径：本迁移之前有人把 tools/db/schema.sql 重放到实库（install_mysql.sh 对已有库
-- 也会无脑重放，见其 apply_schema），而 schema.sql 现在已含 CREATE TABLE IF NOT EXISTS
-- chinese_passages —— 于是会在 populated 的 dictation_passages 旁边建出一张**空**
-- chinese_passages。此时第 3 步 RENAME 必报 ERROR 1050，而第 1、2 步已经删完数据，
-- 且重跑必然同样失败（不自愈）。故这里先中止。
-- 处置：人工判断该 DROP 掉哪张（空的那张可安全 DROP），再重跑本脚本。
SET @both_exist := (
  SELECT COUNT(*) FROM information_schema.TABLES
  WHERE TABLE_SCHEMA = DATABASE()
    AND TABLE_NAME IN ('dictation_passages', 'chinese_passages')
);
SET @ddl := IF(
  @both_exist = 2,
  'SELECT 1 FROM __ABORT_two_tables_exist_read_migration_header__',
  'SELECT 1'
);
PREPARE stmt FROM @ddl; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- ==== 0b. 闸门二：挂在默写题上但 source 不为 dictation 的错题行 ====
-- 第 1 步按 source='dictation' 删、不是按 question_id 删。若存在挂在 poem_dictation 题上
-- 却是别的 source 的错题行，第 1 步会漏删、第 2 步被 RESTRICT 拦停，且重跑同样失败。
-- 本库实测 0 行（source 分布：exam 134 / targeted 5 / dictation 7）。这类行属学生数据，
-- 不该由脚本擅自删，故中止交人工判断。
SET @stray_eb := (
  SELECT COUNT(*) FROM main_error_books
  WHERE source <> 'dictation'
    AND question_id IN (SELECT id FROM questions WHERE type = 'poem_dictation')
);
SET @ddl := IF(
  @stray_eb > 0,
  'SELECT 1 FROM __ABORT_error_book_rows_with_other_source_read_header__',
  'SELECT 1'
);
PREPARE stmt FROM @ddl; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- 是否首次执行：老表还在 = 还没跑过。跑过之后老表已改名，存量清理不再重复。
SET @first_run := (
  SELECT COUNT(*) FROM information_schema.TABLES
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'dictation_passages'
);

-- ==== 1. 清默写错题本行 ====
SET @ddl := IF(
  @first_run = 1,
  "DELETE FROM main_error_books WHERE source = 'dictation'",
  'SELECT 1'
);
PREPARE stmt FROM @ddl; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- ==== 1.5 摘 dictation_passages 自己的外键（**必须在第 2 步删题之前**） ====
-- ⚠️⚠️ 这是本迁移最重要的顺序约束，2026-09-15 在实库上真的踩过：
--   dictation_passages.question_id 的外键 fk_dp_question 是 **ON DELETE CASCADE**
--   （它就是「引用 questions 的表」之一，和 student_hidden_questions 同类）。
--   若先执行第 2 步 DELETE FROM questions，级联会把 dictation_passages 的全部篇目行
--   **一起清空**——表结构迁移成功、数据全丢、无任何报错。初版迁移正是这样丢的 50 行，
--   靠备份才恢复。此步骤必须排在任何对 questions 的 DELETE 之前。
SET @has_fk := (
  SELECT COUNT(*) FROM information_schema.TABLE_CONSTRAINTS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'dictation_passages'
    AND CONSTRAINT_NAME = 'fk_dp_question'
);
SET @ddl := IF(
  @has_fk > 0,
  'ALTER TABLE dictation_passages DROP FOREIGN KEY fk_dp_question',
  'SELECT 1'
);
PREPARE stmt FROM @ddl; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- ==== 2. 删 poem_dictation 题行 ====
-- 前置：第 1.5 步已摘掉 dictation_passages 的 CASCADE 外键，本步不会再级联清篇目。
-- student_hidden_questions / question_hints / question_self_assessments 仍由 CASCADE 跟着清（这些表本来就该清）。
SET @ddl := IF(
  @first_run = 1,
  "DELETE FROM questions WHERE type = 'poem_dictation'",
  'SELECT 1'
);
PREPARE stmt FROM @ddl; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- ==== 3. 表改名 ====
SET @ddl := IF(
  @first_run = 1,
  'RENAME TABLE dictation_passages TO chinese_passages',
  'SELECT 1'
);
PREPARE stmt FROM @ddl; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- ==== 4a. 摘 question_id 上的唯一键（外键已在 1.5 摘掉，改名后直接摘键） ====
SET @has_uniq_qid := (
  SELECT COUNT(*) FROM information_schema.STATISTICS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'chinese_passages'
    AND INDEX_NAME = 'uniq_dp_question'
);
-- ⚠️ 判据用 > 0 而不是 = 1：information_schema.STATISTICS 对索引是**每列一行**，
-- 复合索引会返回多行（uniq_dp_work 2 行、idx_dp_filter 3 行），写 = 1 会静默跳过。
-- 本仓 2026-09-13_ensure_uniq_q_content_hash.sql 已记过同一个坑。
SET @ddl := IF(
  @has_uniq_qid > 0,
  'ALTER TABLE chinese_passages DROP INDEX uniq_dp_question',
  'SELECT 1'
);
PREPARE stmt FROM @ddl; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- ==== 4b. 摘列 ====
SET @has_col_qid := (
  SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'chinese_passages'
    AND COLUMN_NAME = 'question_id'
);
SET @ddl := IF(
  @has_col_qid > 0,
  'ALTER TABLE chinese_passages DROP COLUMN question_id',
  'SELECT 1'
);
PREPARE stmt FROM @ddl; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- ==== 4c. 索引改名（跟新表名对齐；旧名留着会误导后来人以为还挂着 questions） ====
SET @has_idx_work := (
  SELECT COUNT(*) FROM information_schema.STATISTICS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'chinese_passages'
    AND INDEX_NAME = 'uniq_dp_work'
);
-- ⚠️ > 0，不是 = 1：uniq_dp_work 是复合索引，在 STATISTICS 里有 2 行（work_title, semester）。
SET @ddl := IF(
  @has_idx_work > 0,
  'ALTER TABLE chinese_passages RENAME INDEX uniq_dp_work TO uniq_chinese_passages_work',
  'SELECT 1'
);
PREPARE stmt FROM @ddl; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @has_idx_filter := (
  SELECT COUNT(*) FROM information_schema.STATISTICS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'chinese_passages'
    AND INDEX_NAME = 'idx_dp_filter'
);
-- ⚠️ > 0，不是 = 1：idx_dp_filter 有 3 列（grade_band, semester, sort_order）→ 3 行。
SET @ddl := IF(
  @has_idx_filter > 0,
  'ALTER TABLE chinese_passages RENAME INDEX idx_dp_filter TO idx_chinese_passages_filter',
  'SELECT 1'
);
PREPARE stmt FROM @ddl; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- ==== 5. 加 is_active ====
-- 停用开关归本表自己管。注意：**不承接 questions.is_active**，见文件头「停用态不承接」。
SET @has_is_active := (
  SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'chinese_passages'
    AND COLUMN_NAME = 'is_active'
);
SET @ddl := IF(
  @has_is_active = 0,
  'ALTER TABLE chinese_passages ADD COLUMN is_active TINYINT(1) NOT NULL DEFAULT 1 AFTER memorize_required',
  'SELECT 1'
);
PREPARE stmt FROM @ddl; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SELECT 'migration 2026-09-15_chinese_passages done' AS result;
