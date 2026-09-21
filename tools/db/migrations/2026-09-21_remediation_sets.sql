-- 日期：2026-09-21 主旨：错题补偿套题（相似题专项练习）三表
-- 设计：docs/superpowers/specs/2026-09-21-remediation-set-design.md

-- 做什么：
--   1. remediation_sets：套题头（每学生每学科至多一条 active；全对后整行删除，无其他状态）
--   2. remediation_groups：组（(set_id, kp_id, type, difficulty) 唯一 = 三元组追加合并去重键）
--   3. remediation_set_items：组内题目（is_correct 答对标记；points_awarded 首答发分防重）

-- 为什么：
--   - 套题自清零（spec §2 决策 7）状态必须落库才能跨会话续做
--   - ai_pending_count 记 AI 补题缺口：fire-and-forget 进程重启会悬挂，读取端惰性重试（spec §5.1）
--   - question_id 外键 RESTRICT（先例 variation_questions.fk_vq_question_id）：
--     db_loader full-reload 有业务数据守卫，--purge-business-data 按 FK 安全序清理
--   - 无 subject 外键（同 training_sessions——subjects 是 seed 维表，业务表不挂）

-- 幂等：CREATE TABLE IF NOT EXISTS，重复执行无副作用。
-- 回滚：DROP TABLE remediation_set_items; DROP TABLE remediation_groups; DROP TABLE remediation_sets;

CREATE TABLE IF NOT EXISTS remediation_sets (
  id         BIGINT AUTO_INCREMENT PRIMARY KEY,
  student_id BIGINT      NOT NULL,
  subject_id BIGINT      NOT NULL COMMENT '首期恒数学（MATH_SUBJECT_ID=1）',
  status     VARCHAR(16) NOT NULL DEFAULT 'active' COMMENT 'active（全对后整行删除）',
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  KEY idx_rsets_student (student_id, status),
  CONSTRAINT fk_rsets_student_id FOREIGN KEY (student_id) REFERENCES students (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS remediation_groups (
  id                 BIGINT AUTO_INCREMENT PRIMARY KEY,
  set_id             BIGINT      NOT NULL,
  kp_id              BIGINT      NOT NULL COMMENT '触发原错题的 primary 知识点',
  type               VARCHAR(20) NOT NULL,
  difficulty         SMALLINT    NOT NULL,
  origin_question_id BIGINT      NOT NULL COMMENT '触发本组的原错题（审计）',
  ai_pending_count   SMALLINT    NOT NULL DEFAULT 0 COMMENT 'AI 补题缺口；补完/失败清零，>0 且无 in-flight = 进程重启悬挂',
  created_at         DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  UNIQUE KEY uniq_rgroups_triple (set_id, kp_id, type, difficulty),
  CONSTRAINT fk_rgroups_set_id FOREIGN KEY (set_id) REFERENCES remediation_sets (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS remediation_set_items (
  id               BIGINT AUTO_INCREMENT PRIMARY KEY,
  group_id         BIGINT      NOT NULL,
  question_id      BIGINT      NOT NULL,
  is_correct       TINYINT(1)  NOT NULL DEFAULT 0 COMMENT '套题自清零标记：答对置 1',
  points_awarded   TINYINT(1)  NOT NULL DEFAULT 0 COMMENT '首答发分防重（dedupe_key rem:<id> 兜底）',
  attempts         SMALLINT    NOT NULL DEFAULT 0,
  last_answered_at DATETIME(3) DEFAULT NULL,
  created_at       DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  UNIQUE KEY uniq_ritems_group_question (group_id, question_id),
  KEY idx_ritems_group (group_id, is_correct),
  CONSTRAINT fk_ritems_group_id FOREIGN KEY (group_id) REFERENCES remediation_groups (id) ON DELETE CASCADE,
  CONSTRAINT fk_ritems_question_id FOREIGN KEY (question_id) REFERENCES questions (id) ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
