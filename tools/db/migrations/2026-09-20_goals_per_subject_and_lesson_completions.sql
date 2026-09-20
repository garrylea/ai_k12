-- 2026-09-20 P6.5 目标设定补齐：goals 改「按学科」+ 新建 lesson_completions
--
-- 做什么：
--   1) goals 加生成列（**VIRTUAL**，不是 STORED）scope_subject_id = IF(metric IS NULL, NULL, COALESCE(subject_id, 0))（STORED），
--      唯一键从 (student_id, metric) 改到 (student_id, scope_subject_id, metric)
--   2) 新建 lesson_completions（每课完成事件），供「每周完课目标」用
--
-- 为什么：
--   * MySQL 的唯一索引把 NULL 视为互不相等 —— 直接用 (student_id, subject_id, metric)
--     会让 subject_id IS NULL 的行失去唯一性，ON DUPLICATE KEY 静默不命中、重复插行。
--     生成列把 NULL 折成 0，唯一性对真实目标成立（2026-09-20 实测确认）。
--   * 为什么是**条件式**（metric IS NULL 时 scope 也为 NULL）：1B 去重把重复行的 metric
--     清成了 NULL，若这些行的 scope 都算成 0，(student_id, 0, NULL) 会互相冲突，
--     ADD UNIQUE KEY 直接失败（ERROR 1062）。保持 NULL 就回到「NULL 互不相等」，
--     历史停用行继续共存、加键不失败。
--   * metric 变成「按学科」后，(student_id, metric) 这个旧键不再成立（同一 metric
--     在不同学科各有一行）。旧键必须先删，否则同一 metric 只能存一个学科。
--   * **为什么用 VIRTUAL 而不是 STORED**：2026-09-20 实测 —— 在 goals 上加 STORED 生成列
--     直接报 ERROR 1215（Cannot add foreign key constraint）。原因是 STORED 要重建整表，
--     而 goals 上有 fk_goals_student_id / fk_goals_subject_id，重建时外键校验失败；
--     VIRTUAL 不动行数据（只在读/建索引时计算），加列与加索引都成功。
--     ⚠️ 别用临时表验证这类事：临时表没有外键，STORED 在临时表上能过（我踩过）。
--   * 不删任何历史行：subject_id 为 NULL 的历史行（1B 去重时停用的）留着，读侧靠
--     is_active=1 过滤。
--   * lesson_completions.lesson_id 故意不设外键（lessons 会全量重灌）。
--
-- 幂等：加列/加索引/改键全部带 information_schema 守卫；建表 IF NOT EXISTS
-- 回滚：DROP TABLE lesson_completions；
--       ALTER TABLE goals DROP KEY uniq_goals_student_scope_metric,
--                         ADD UNIQUE KEY uniq_goals_student_metric (student_id, metric),
--                         DROP COLUMN scope_subject_id;

-- ── 1. goals：加生成列（MySQL 8/9 无 ADD COLUMN IF NOT EXISTS，只能守卫）──
SET @col_scope := (
  SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'goals' AND COLUMN_NAME = 'scope_subject_id'
);
SET @ddl := IF(@col_scope = 0,
  'ALTER TABLE goals ADD COLUMN scope_subject_id BIGINT AS (IF(metric IS NULL, NULL, COALESCE(subject_id, 0))) VIRTUAL COMMENT ''生成列（条件式）：metric 非空时把 subject_id 的 NULL 折 0，供唯一键用；metric 为空的历史停用行保持 NULL，不参与唯一性''',
  'DO 0');
PREPARE stmt FROM @ddl; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- ── 2. goals：加新唯一键（必须先于删旧键：新键允许同 metric 多学科，旧键不允许）──
SET @idx_new := (
  SELECT COUNT(*) FROM information_schema.STATISTICS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'goals'
    AND INDEX_NAME = 'uniq_goals_student_scope_metric'
);
SET @ddl := IF(@idx_new = 0,
  'ALTER TABLE goals ADD UNIQUE KEY uniq_goals_student_scope_metric (student_id, scope_subject_id, metric)',
  'DO 0');
PREPARE stmt FROM @ddl; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- ── 3. goals：删旧唯一键（它按 (student_id, metric) 约束，会挡住「同 metric 多学科」）──
SET @idx_old := (
  SELECT COUNT(*) FROM information_schema.STATISTICS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'goals'
    AND INDEX_NAME = 'uniq_goals_student_metric'
);
SET @ddl := IF(@idx_old > 0,
  'ALTER TABLE goals DROP KEY uniq_goals_student_metric',
  'DO 0');
PREPARE stmt FROM @ddl; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- ── 4. lesson_completions：每课完成事件（「每周完课目标」的唯一数据源）──
CREATE TABLE IF NOT EXISTS lesson_completions (
  id           BIGINT AUTO_INCREMENT PRIMARY KEY,
  student_id   BIGINT      NOT NULL,
  subject_id   BIGINT      NOT NULL COMMENT '取自 progress.subject_id（该列 NOT NULL）',
  lesson_id    BIGINT      NOT NULL COMMENT 'lessons.id；**故意不设外键**（内容表会全量重灌）',
  completed_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  -- 一课只记一次：完成不可逆，重复上报/重放都靠它幂等（写入用 INSERT IGNORE）
  UNIQUE KEY uniq_lc_student_lesson (student_id, lesson_id),
  KEY idx_lc_student_subject_time (student_id, subject_id, completed_at),
  CONSTRAINT fk_lc_student_id FOREIGN KEY (student_id) REFERENCES students (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
