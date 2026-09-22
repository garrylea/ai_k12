-- 日期：2026-09-22 主旨：remediation_sets 加「每学生每学科至多一条 active」的 DB 级唯一约束
-- 设计：docs/superpowers/specs/2026-09-21-remediation-set-design.md §3

-- 做什么：
--   remediation_sets 加条件式 VIRTUAL 生成列 active_student_id，并加唯一键
--   uniq_rsets_active (active_student_id, subject_id)。
--
-- 为什么：
--   * 原实现是「先 SELECT findActiveByStudent 再 INSERT createSet」的 check-then-insert，
--     表上只有非唯一的 idx_rsets_student (student_id, status)。同一学生在**两个标签页**
--     同时点「生成练习」时，两边都读到 null → 各建一条 active 套题。后果不只是多一套题：
--     学生清掉新的那套（findActiveByStudent 取 id DESC）后，旧套题让三卡页提示条**再次出现**，
--     重做同一批错题；且两套的 item 行 id 不同 → dedupe_key 'rem:<item.id>' 不同 →
--     remediation_question 的 dailyLimit 为 null → **同一批错题被重复发分**。
--   * 为什么是**条件式**（status 非 active 时该列为 NULL）：MySQL 唯一索引把 NULL 视为互不相等，
--     将来若引入 'cleared' 之类状态，多条非 active 行可共存、加键不会因历史行冲突而失败
--     （同 goals.scope_subject_id 的 2026-09-20 先例）。
--   * **为什么用 VIRTUAL 而不是 STORED**：STORED 要重建整表，重建时表上的外键
--     （fk_rsets_student_id）会让 ALTER 报 ERROR 1215。VIRTUAL 不动行数据，加列与加索引都成功。
--     ⚠️ 别用临时表验证这类事：临时表没有外键，STORED 在临时表上能过，会得出假阳性。
--
-- 幂等：加列/加索引都带 information_schema 守卫，重复执行无副作用。
--       ⚠️ 例外：若表里**已有**同一 (student_id, subject_id) 的多条 active 行（本迁移之前并发插入的脏数据），
--       第 2 步 ADD UNIQUE KEY 会以 ERROR 1062 中止（响亮失败，不是静默）。此时需先人工清理重复 active 行
--       （保留 id 最小的那条，其余 DELETE）再重跑；第 1 步的加列已提交，重跑会从第 2 步续上，不会更脏。
-- 回滚：ALTER TABLE remediation_sets DROP KEY uniq_rsets_active, DROP COLUMN active_student_id;

-- ── 1. 加条件式生成列（MySQL 8/9 无 ADD COLUMN IF NOT EXISTS，只能守卫）──
SET @col_active := (
  SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'remediation_sets' AND COLUMN_NAME = 'active_student_id'
);
SET @ddl := IF(@col_active = 0,
  'ALTER TABLE remediation_sets ADD COLUMN active_student_id BIGINT AS (IF(status = ''active'', student_id, NULL)) VIRTUAL COMMENT ''生成列（条件式）：仅 active 时等于 student_id，供唯一键实现「每学生每学科至多一条 active」；非 active 保持 NULL 不参与唯一性''',
  'DO 0');
PREPARE stmt FROM @ddl; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- ── 2. 加唯一键 ──
SET @idx_active := (
  SELECT COUNT(*) FROM information_schema.STATISTICS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'remediation_sets'
    AND INDEX_NAME = 'uniq_rsets_active'
);
SET @ddl := IF(@idx_active = 0,
  'ALTER TABLE remediation_sets ADD UNIQUE KEY uniq_rsets_active (active_student_id, subject_id)',
  'DO 0');
PREPARE stmt FROM @ddl; EXECUTE stmt; DEALLOCATE PREPARE stmt;
