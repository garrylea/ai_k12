-- K12 智学系统 — 数据库初始化脚本
-- 依据：docs/K12智学系统-数据库设计文档.md（版本 v1.2）
-- 范围：MVP 全部表（§3.1 ~ §3.9、§3.11），不含 P2 计费相关表（§3.10）
-- 数据库：MySQL 9.7.1 LTS（文档约定）
-- 字符集：utf8mb4

SET NAMES utf8mb4;
SET FOREIGN_KEY_CHECKS = 0;

-- ============================================================
-- 1. 用户与权限
-- ============================================================

CREATE TABLE IF NOT EXISTS parents (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  phone VARCHAR(20) NOT NULL,
  password_hash VARCHAR(255) NOT NULL,
  name VARCHAR(50) DEFAULT NULL,
  avatar_url VARCHAR(500) DEFAULT NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  deleted_at DATETIME(3) DEFAULT NULL,
  UNIQUE KEY uniq_parents_phone (phone, deleted_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS students (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  parent_id BIGINT NOT NULL,
  username VARCHAR(50) NOT NULL,
  password_hash VARCHAR(255) NOT NULL,
  name VARCHAR(50) DEFAULT NULL,
  age SMALLINT NOT NULL,
  grade VARCHAR(20) NOT NULL,
  school_level VARCHAR(10) NOT NULL,
  avatar_url VARCHAR(500) DEFAULT NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  deleted_at DATETIME(3) DEFAULT NULL,
  UNIQUE KEY uniq_students_username (username, deleted_at),
  KEY idx_students_parent_id (parent_id),
  CONSTRAINT fk_students_parent_id FOREIGN KEY (parent_id) REFERENCES parents (id) ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS student_settings (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  student_id BIGINT NOT NULL,
  theme_mode VARCHAR(10) NOT NULL DEFAULT 'auto',
  school VARCHAR(10) NOT NULL DEFAULT 'primary',
  font_size_level VARCHAR(10) NOT NULL DEFAULT 'medium',
  motion_enabled TINYINT(1) NOT NULL DEFAULT 1,
  sound_enabled TINYINT(1) NOT NULL DEFAULT 1,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  UNIQUE KEY uniq_student_settings_student_id (student_id),
  CONSTRAINT fk_student_settings_student_id FOREIGN KEY (student_id) REFERENCES students (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS devices (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  user_id BIGINT NOT NULL,
  user_type VARCHAR(10) NOT NULL,
  device_name VARCHAR(100) DEFAULT NULL,
  token_hash VARCHAR(255) NOT NULL,
  last_active_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  expires_at DATETIME(3) NOT NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  KEY idx_devices_user (user_type, user_id),
  KEY idx_devices_token_hash (token_hash)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ============================================================
-- 2. 内容与课程
-- ============================================================

CREATE TABLE IF NOT EXISTS subjects (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  name VARCHAR(50) NOT NULL,
  code VARCHAR(20) NOT NULL,
  grade_bands TEXT DEFAULT NULL,
  icon_url VARCHAR(500) DEFAULT NULL,
  sort_order SMALLINT NOT NULL DEFAULT 0,
  is_active TINYINT(1) NOT NULL DEFAULT 1,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  UNIQUE KEY uniq_subjects_code (code)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 基础种子数据（引用数据）：K12 全学科。INSERT IGNORE 保证重复执行幂等。
-- 教材结构（textbook_versions/semesters/units/lessons）与 cards/questions 为派生数据，由 db_loader 入库，不在此 seed。
INSERT IGNORE INTO subjects (name, code, grade_bands, sort_order, is_active) VALUES
  ('数学',      'math',      'primary,junior,senior', 1, 1),
  ('语文',      'chinese',   'primary,junior,senior', 2, 1),
  ('英语',      'english',   'primary,junior,senior', 3, 1),
  ('物理',      'physics',   'junior,senior',         4, 1),
  ('化学',      'chemistry', 'junior,senior',         5, 1),
  ('生物',      'biology',   'junior,senior',         6, 1),
  ('历史',      'history',   'junior,senior',         7, 1),
  ('地理',      'geography', 'junior,senior',         8, 1),
  ('道德与法治','politics',  'junior,senior',         9, 1);

CREATE TABLE IF NOT EXISTS textbook_versions (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  subject_id BIGINT NOT NULL,
  name VARCHAR(100) NOT NULL,
  code VARCHAR(50) NOT NULL,
  grade_band VARCHAR(20) NOT NULL,
  publisher VARCHAR(100) DEFAULT NULL,
  is_active TINYINT(1) NOT NULL DEFAULT 1,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  UNIQUE KEY uniq_textbook_versions_code (code),
  KEY idx_textbook_versions_subject_grade (subject_id, grade_band),
  CONSTRAINT fk_textbook_versions_subject_id FOREIGN KEY (subject_id) REFERENCES subjects (id) ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS semesters (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  textbook_version_id BIGINT NOT NULL,
  name VARCHAR(50) NOT NULL,
  grade VARCHAR(20) NOT NULL,
  term VARCHAR(10) NOT NULL,
  sort_order SMALLINT NOT NULL DEFAULT 0,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  UNIQUE KEY uniq_semesters_version_grade_term (textbook_version_id, grade, term),
  CONSTRAINT fk_semesters_textbook_version_id FOREIGN KEY (textbook_version_id) REFERENCES textbook_versions (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS units (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  semester_id BIGINT NOT NULL,
  name VARCHAR(100) NOT NULL,
  sort_order SMALLINT NOT NULL DEFAULT 0,
  is_midterm_boundary TINYINT(1) NOT NULL DEFAULT 0,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  KEY idx_units_semester_sort (semester_id, sort_order),
  CONSTRAINT fk_units_semester_id FOREIGN KEY (semester_id) REFERENCES semesters (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS lessons (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  unit_id BIGINT NOT NULL,
  name VARCHAR(200) NOT NULL,
  sort_order SMALLINT NOT NULL DEFAULT 0,
  is_unit_last TINYINT(1) NOT NULL DEFAULT 0,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  KEY idx_lessons_unit_sort (unit_id, sort_order),
  CONSTRAINT fk_lessons_unit_id FOREIGN KEY (unit_id) REFERENCES units (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS knowledge_points (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  subject_id BIGINT NOT NULL,
  parent_kp_id BIGINT DEFAULT NULL,
  name VARCHAR(200) NOT NULL,
  code VARCHAR(50) DEFAULT NULL,
  grade_band VARCHAR(20) NOT NULL,
  difficulty SMALLINT DEFAULT NULL,
  description TEXT DEFAULT NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  KEY idx_kp_subject_grade (subject_id, grade_band),
  KEY idx_kp_parent (parent_kp_id),
  CONSTRAINT fk_knowledge_points_subject_id FOREIGN KEY (subject_id) REFERENCES subjects (id) ON DELETE RESTRICT,
  CONSTRAINT fk_knowledge_points_parent_kp_id FOREIGN KEY (parent_kp_id) REFERENCES knowledge_points (id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS cards (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  lesson_id BIGINT NOT NULL,
  sort_order SMALLINT NOT NULL DEFAULT 0,
  card_type VARCHAR(20) NOT NULL,
  title VARCHAR(200) DEFAULT NULL,
  content TEXT NOT NULL,
  content_metadata TEXT DEFAULT NULL,
  -- AI 生成的题目提示缓存（JSON 字符串：{ "<题目文本>": "<提示文本>", ... }）。
  -- Card 级共享（不分学生）：同一题对所有人都用同一提示，省 AI。首次点提示时由
  -- PracticeService.getHint 调 HintCapability 生成并写回，后续命中直返。
  hints TEXT DEFAULT NULL,
  knowledge_point_ids TEXT DEFAULT NULL,
  textbook_page VARCHAR(20) DEFAULT NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  UNIQUE KEY uniq_cards_lesson_sort (lesson_id, sort_order),
  KEY idx_cards_kp_ids (lesson_id, sort_order),
  KEY idx_cards_lesson_type_sort (lesson_id, card_type, sort_order),
  CONSTRAINT fk_cards_lesson_id FOREIGN KEY (lesson_id) REFERENCES lessons (id) ON DELETE CASCADE,
  CONSTRAINT chk_cards_card_type CHECK (card_type IN ('concept','example','practice','explore','summary','reading'))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS questions (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  subject_id BIGINT NOT NULL,
  group_id VARCHAR(50) DEFAULT NULL,
  group_order SMALLINT DEFAULT NULL,
  type VARCHAR(20) NOT NULL,
  difficulty SMALLINT NOT NULL,
  content TEXT NOT NULL,
  options TEXT DEFAULT NULL,
  answer TEXT NOT NULL,
  explanation TEXT DEFAULT NULL,
  material_text TEXT DEFAULT NULL,
  material_url TEXT DEFAULT NULL,
  grade_band VARCHAR(20) DEFAULT NULL,
  source VARCHAR(200) DEFAULT NULL,
  source_year SMALLINT DEFAULT NULL,
  content_hash CHAR(64) DEFAULT NULL,
  is_active TINYINT(1) NOT NULL DEFAULT 1,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  KEY idx_q_subject_type_diff (subject_id, type, difficulty),
  KEY idx_q_grade (grade_band),
  KEY idx_q_group (group_id, group_order),
  UNIQUE KEY uniq_q_content_hash (content_hash),
  CONSTRAINT fk_questions_subject_id FOREIGN KEY (subject_id) REFERENCES subjects (id) ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS question_knowledge_points (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  question_id BIGINT NOT NULL,
  knowledge_point_id BIGINT NOT NULL,
  role VARCHAR(10) NOT NULL DEFAULT 'primary',
  weight NUMERIC(3,2) NOT NULL DEFAULT 1.00,
  UNIQUE KEY uniq_qkp_q_kp (question_id, knowledge_point_id),
  KEY idx_qkp_kp_role (knowledge_point_id, role),
  CONSTRAINT fk_qkp_question_id FOREIGN KEY (question_id) REFERENCES questions (id) ON DELETE CASCADE,
  CONSTRAINT fk_qkp_knowledge_point_id FOREIGN KEY (knowledge_point_id) REFERENCES knowledge_points (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS knowledge_relations (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  src_id BIGINT NOT NULL,
  dst_id BIGINT NOT NULL,
  relation_type VARCHAR(20) NOT NULL,
  weight NUMERIC(3,2) NOT NULL DEFAULT 1.00,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  UNIQUE KEY uniq_kr_src_dst_type (src_id, dst_id, relation_type),
  KEY idx_kr_dst_id (dst_id),
  CONSTRAINT fk_kr_src_id FOREIGN KEY (src_id) REFERENCES knowledge_points (id) ON DELETE CASCADE,
  CONSTRAINT fk_kr_dst_id FOREIGN KEY (dst_id) REFERENCES knowledge_points (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ============================================================
-- 3. 知识图谱掌握度
-- ============================================================

CREATE TABLE IF NOT EXISTS student_knowledge_mastery (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  student_id BIGINT NOT NULL,
  knowledge_point_id BIGINT NOT NULL,
  mastery_score NUMERIC(4,3) NOT NULL DEFAULT 0.000,
  error_count INTEGER NOT NULL DEFAULT 0,
  correct_count INTEGER NOT NULL DEFAULT 0,
  level SMALLINT NOT NULL DEFAULT 0,
  last_seen_at DATETIME(3) DEFAULT NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  UNIQUE KEY uniq_skm_student_kp (student_id, knowledge_point_id),
  KEY idx_skm_student_mastery (student_id, mastery_score),
  KEY idx_skm_student_level (student_id, level),
  CONSTRAINT fk_skm_student_id FOREIGN KEY (student_id) REFERENCES students (id) ON DELETE CASCADE,
  CONSTRAINT fk_skm_knowledge_point_id FOREIGN KEY (knowledge_point_id) REFERENCES knowledge_points (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ============================================================
-- 4. 学习进度
-- ============================================================

CREATE TABLE IF NOT EXISTS progress (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  student_id BIGINT NOT NULL,
  subject_id BIGINT NOT NULL,
  textbook_version_id BIGINT NOT NULL,
  current_semester_id BIGINT DEFAULT NULL,
  current_unit_id BIGINT DEFAULT NULL,
  current_lesson_id BIGINT DEFAULT NULL,
  current_card_sort SMALLINT DEFAULT NULL,
  next_unlock_type VARCHAR(20) NOT NULL DEFAULT 'lesson',
  is_clear TINYINT(1) NOT NULL DEFAULT 0,
  status VARCHAR(20) NOT NULL DEFAULT 'not_started',
  started_at DATETIME(3) DEFAULT NULL,
  last_active_at DATETIME(3) DEFAULT NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  UNIQUE KEY uniq_progress_student_subject (student_id, subject_id),
  KEY idx_progress_student (student_id),
  CONSTRAINT fk_progress_student_id FOREIGN KEY (student_id) REFERENCES students (id) ON DELETE CASCADE,
  CONSTRAINT fk_progress_subject_id FOREIGN KEY (subject_id) REFERENCES subjects (id) ON DELETE RESTRICT,
  CONSTRAINT fk_progress_textbook_version_id FOREIGN KEY (textbook_version_id) REFERENCES textbook_versions (id) ON DELETE RESTRICT,
  CONSTRAINT fk_progress_current_semester_id FOREIGN KEY (current_semester_id) REFERENCES semesters (id) ON DELETE SET NULL,
  CONSTRAINT fk_progress_current_unit_id FOREIGN KEY (current_unit_id) REFERENCES units (id) ON DELETE SET NULL,
  CONSTRAINT fk_progress_current_lesson_id FOREIGN KEY (current_lesson_id) REFERENCES lessons (id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ============================================================
-- 5. 评测
-- ============================================================

CREATE TABLE IF NOT EXISTS homeworks (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  lesson_id BIGINT NOT NULL,
  subject_id BIGINT NOT NULL,
  title VARCHAR(200) DEFAULT NULL,
  question_ids TEXT NOT NULL,
  total_score SMALLINT NOT NULL DEFAULT 100,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  UNIQUE KEY uniq_homeworks_lesson (lesson_id),
  CONSTRAINT fk_homeworks_lesson_id FOREIGN KEY (lesson_id) REFERENCES lessons (id) ON DELETE CASCADE,
  CONSTRAINT fk_homeworks_subject_id FOREIGN KEY (subject_id) REFERENCES subjects (id) ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS homework_submissions (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  homework_id BIGINT NOT NULL,
  student_id BIGINT NOT NULL,
  status VARCHAR(20) NOT NULL DEFAULT 'in_progress',
  total_score NUMERIC(5,1) DEFAULT NULL,
  correct_count SMALLINT DEFAULT NULL,
  total_count SMALLINT DEFAULT NULL,
  started_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  submitted_at DATETIME(3) DEFAULT NULL,
  graded_at DATETIME(3) DEFAULT NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  KEY idx_hw_sub_student_status (student_id, status),
  KEY idx_hw_sub_homework_student (homework_id, student_id),
  CONSTRAINT fk_hw_sub_homework_id FOREIGN KEY (homework_id) REFERENCES homeworks (id) ON DELETE RESTRICT,
  CONSTRAINT fk_hw_sub_student_id FOREIGN KEY (student_id) REFERENCES students (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS assessments (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  subject_id BIGINT NOT NULL,
  type VARCHAR(20) NOT NULL,
  title VARCHAR(200) NOT NULL,
  scope_unit_ids TEXT DEFAULT NULL,
  scope_semester_id BIGINT DEFAULT NULL,
  question_ids TEXT NOT NULL,
  time_limit_minutes SMALLINT NOT NULL DEFAULT 30,
  total_score SMALLINT NOT NULL DEFAULT 100,
  difficulty_distribution TEXT DEFAULT NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  KEY idx_assessments_subject_type (subject_id, type),
  CONSTRAINT fk_assessments_subject_id FOREIGN KEY (subject_id) REFERENCES subjects (id) ON DELETE RESTRICT,
  CONSTRAINT fk_assessments_scope_semester_id FOREIGN KEY (scope_semester_id) REFERENCES semesters (id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS assessment_submissions (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  assessment_id BIGINT NOT NULL,
  student_id BIGINT NOT NULL,
  status VARCHAR(20) NOT NULL DEFAULT 'in_progress',
  total_score NUMERIC(5,1) DEFAULT NULL,
  correct_count SMALLINT DEFAULT NULL,
  total_count SMALLINT DEFAULT NULL,
  started_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  submitted_at DATETIME(3) DEFAULT NULL,
  graded_at DATETIME(3) DEFAULT NULL,
  auto_saved_at DATETIME(3) DEFAULT NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  KEY idx_as_sub_student_status (student_id, status),
  KEY idx_as_sub_assessment_student (assessment_id, student_id),
  CONSTRAINT fk_as_sub_assessment_id FOREIGN KEY (assessment_id) REFERENCES assessments (id) ON DELETE RESTRICT,
  CONSTRAINT fk_as_sub_student_id FOREIGN KEY (student_id) REFERENCES students (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS answers (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  submission_type VARCHAR(20) NOT NULL,
  submission_id BIGINT NOT NULL,
  question_id BIGINT NOT NULL,
  question_order SMALLINT NOT NULL,
  answer_text TEXT DEFAULT NULL,
  attachments TEXT DEFAULT NULL,
  is_correct TINYINT(1) DEFAULT NULL,
  score NUMERIC(5,1) DEFAULT NULL,
  max_score NUMERIC(5,1) NOT NULL,
  grading_method VARCHAR(10) DEFAULT NULL,
  feedback TEXT DEFAULT NULL,
  graded_at DATETIME(3) DEFAULT NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  UNIQUE KEY uniq_answers_sub_q (submission_type, submission_id, question_id),
  KEY idx_answers_submission (submission_type, submission_id),
  CONSTRAINT fk_answers_question_id FOREIGN KEY (question_id) REFERENCES questions (id) ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ============================================================
-- 6. 错题本
-- ============================================================

CREATE TABLE IF NOT EXISTS main_error_books (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  student_id BIGINT NOT NULL,
  subject_id BIGINT NOT NULL,
  question_id BIGINT DEFAULT NULL,
  level SMALLINT NOT NULL DEFAULT 1,
  is_cleared TINYINT(1) NOT NULL DEFAULT 0,
  source VARCHAR(20) NOT NULL,
  source_ref_id BIGINT DEFAULT NULL,
  wrong_answer_text TEXT DEFAULT NULL,
  cleared_at DATETIME(3) DEFAULT NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  KEY idx_me_student_subject (student_id, subject_id),
  KEY idx_me_student_cleared (student_id, is_cleared),
  KEY idx_me_student_level (student_id, is_cleared, level),
  CONSTRAINT fk_me_student_id FOREIGN KEY (student_id) REFERENCES students (id) ON DELETE CASCADE,
  CONSTRAINT fk_me_subject_id FOREIGN KEY (subject_id) REFERENCES subjects (id) ON DELETE RESTRICT,
  CONSTRAINT fk_me_question_id FOREIGN KEY (question_id) REFERENCES questions (id) ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS error_redo_logs (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  error_book_type VARCHAR(10) NOT NULL,
  error_item_id BIGINT NOT NULL,
  student_id BIGINT NOT NULL,
  answer_text TEXT DEFAULT NULL,
  attachments TEXT DEFAULT NULL,
  is_correct TINYINT(1) NOT NULL,
  error_level_before SMALLINT NOT NULL,
  error_level_after SMALLINT NOT NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  KEY idx_erl_error_item (error_book_type, error_item_id),
  CONSTRAINT fk_erl_student_id FOREIGN KEY (student_id) REFERENCES students (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS variation_questions (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  original_error_item_id BIGINT NOT NULL,
  error_book_type VARCHAR(10) NOT NULL,
  student_id BIGINT NOT NULL,
  question_id BIGINT NOT NULL,
  difficulty SMALLINT NOT NULL,
  validator_passed TINYINT(1) NOT NULL DEFAULT 0,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  KEY idx_vq_error_item (error_book_type, original_error_item_id),
  CONSTRAINT fk_vq_student_id FOREIGN KEY (student_id) REFERENCES students (id) ON DELETE CASCADE,
  CONSTRAINT fk_vq_question_id FOREIGN KEY (question_id) REFERENCES questions (id) ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ============================================================
-- 7. AI 对话
-- ============================================================

CREATE TABLE IF NOT EXISTS ai_dialogues (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  student_id BIGINT NOT NULL,
  subject_id BIGINT DEFAULT NULL,
  track VARCHAR(10) NOT NULL,
  card_id BIGINT DEFAULT NULL,
  knowledge_point_id BIGINT DEFAULT NULL,
  title VARCHAR(200) DEFAULT NULL,
  status VARCHAR(10) NOT NULL DEFAULT 'active',
  flow_state VARCHAR(30) NOT NULL DEFAULT 'idle',  -- P1 图片两阶段状态机: idle|awaiting_selection|awaiting_confirmation
  pending_question TEXT DEFAULT NULL,              -- P1 已转录待确认的题干
  pending_questions TEXT DEFAULT NULL,             -- P1 多题时的全部转录 JSON
  consecutive_fail_count SMALLINT NOT NULL DEFAULT 0,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  deleted_at DATETIME(3) DEFAULT NULL,
  KEY idx_dlg_student_track (student_id, track),
  KEY idx_dlg_student_card (student_id, track, card_id),
  CONSTRAINT fk_dlg_student_id FOREIGN KEY (student_id) REFERENCES students (id) ON DELETE CASCADE,
  CONSTRAINT fk_dlg_subject_id FOREIGN KEY (subject_id) REFERENCES subjects (id) ON DELETE SET NULL,
  CONSTRAINT fk_dlg_card_id FOREIGN KEY (card_id) REFERENCES cards (id) ON DELETE SET NULL,
  CONSTRAINT fk_dlg_knowledge_point_id FOREIGN KEY (knowledge_point_id) REFERENCES knowledge_points (id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS ai_messages (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  dialogue_id BIGINT NOT NULL,
  role VARCHAR(10) NOT NULL,
  content TEXT NOT NULL,
  reasoning TEXT DEFAULT NULL,
  type VARCHAR(20) DEFAULT NULL,
  attachments TEXT DEFAULT NULL,
  model VARCHAR(50) DEFAULT NULL,
  token_input INTEGER DEFAULT NULL,
  token_output INTEGER DEFAULT NULL,
  response_time_ms INTEGER DEFAULT NULL,
  safety_flag TINYINT(1) NOT NULL DEFAULT 0,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  deleted_at DATETIME(3) DEFAULT NULL,
  KEY idx_msg_dialogue_order (dialogue_id, created_at),
  KEY idx_msg_safety (dialogue_id, safety_flag),
  CONSTRAINT fk_msg_dialogue_id FOREIGN KEY (dialogue_id) REFERENCES ai_dialogues (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS safety_alerts (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  student_id BIGINT NOT NULL,
  parent_id BIGINT NOT NULL,
  type VARCHAR(20) NOT NULL,
  level VARCHAR(10) NOT NULL DEFAULT 'info',
  message TEXT NOT NULL,
  dialogue_id BIGINT DEFAULT NULL,
  message_id BIGINT DEFAULT NULL,
  context TEXT DEFAULT NULL,
  is_read TINYINT(1) NOT NULL DEFAULT 0,
  read_at DATETIME(3) DEFAULT NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  KEY idx_sa_parent_unread (parent_id, is_read),
  KEY idx_sa_student (student_id),
  CONSTRAINT fk_sa_student_id FOREIGN KEY (student_id) REFERENCES students (id) ON DELETE CASCADE,
  CONSTRAINT fk_sa_parent_id FOREIGN KEY (parent_id) REFERENCES parents (id) ON DELETE CASCADE,
  CONSTRAINT fk_sa_dialogue_id FOREIGN KEY (dialogue_id) REFERENCES ai_dialogues (id) ON DELETE SET NULL,
  CONSTRAINT fk_sa_message_id FOREIGN KEY (message_id) REFERENCES ai_messages (id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ============================================================
-- 8. 家长与监控
-- ============================================================

CREATE TABLE IF NOT EXISTS learning_reports (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  student_id BIGINT NOT NULL,
  subject_id BIGINT DEFAULT NULL,
  period VARCHAR(10) NOT NULL,
  period_ref_id BIGINT DEFAULT NULL,
  content TEXT NOT NULL,
  generated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  KEY idx_lr_student_period (student_id, period, generated_at DESC),
  CONSTRAINT fk_lr_student_id FOREIGN KEY (student_id) REFERENCES students (id) ON DELETE CASCADE,
  CONSTRAINT fk_lr_subject_id FOREIGN KEY (subject_id) REFERENCES subjects (id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS goals (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  student_id BIGINT NOT NULL,
  subject_id BIGINT DEFAULT NULL,
  title VARCHAR(200) NOT NULL,
  period VARCHAR(10) NOT NULL,
  target_value SMALLINT NOT NULL,
  reminder_enabled TINYINT(1) NOT NULL DEFAULT 0,
  is_active TINYINT(1) NOT NULL DEFAULT 1,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  KEY idx_goals_student (student_id, is_active),
  CONSTRAINT fk_goals_student_id FOREIGN KEY (student_id) REFERENCES students (id) ON DELETE CASCADE,
  CONSTRAINT fk_goals_subject_id FOREIGN KEY (subject_id) REFERENCES subjects (id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS controls (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  student_id BIGINT NOT NULL,
  daily_time_limit_minutes SMALLINT DEFAULT NULL,
  disabled_hours TEXT DEFAULT NULL,
  reward_redemption_enabled TINYINT(1) NOT NULL DEFAULT 1,
  auxiliary_enabled TINYINT(1) NOT NULL DEFAULT 1,
  photo_search_enabled TINYINT(1) NOT NULL DEFAULT 1,
  alert_level VARCHAR(10) NOT NULL DEFAULT 'standard',
  break_reminder_minutes SMALLINT DEFAULT NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  UNIQUE KEY uniq_controls_student (student_id),
  CONSTRAINT fk_controls_student_id FOREIGN KEY (student_id) REFERENCES students (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ============================================================
-- 9. 奖励
-- ============================================================

CREATE TABLE IF NOT EXISTS rewards (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  student_id BIGINT NOT NULL,
  subject_id BIGINT DEFAULT NULL,
  type VARCHAR(10) NOT NULL,
  name VARCHAR(100) NOT NULL,
  description VARCHAR(300) DEFAULT NULL,
  trigger_level VARCHAR(10) NOT NULL,
  trigger_ref_id BIGINT DEFAULT NULL,
  status VARCHAR(20) NOT NULL DEFAULT 'available',
  claimed_at DATETIME(3) DEFAULT NULL,
  redeemed_at DATETIME(3) DEFAULT NULL,
  fulfilled_at DATETIME(3) DEFAULT NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  deleted_at DATETIME(3) DEFAULT NULL,
  KEY idx_rewards_student_status (student_id, status),
  KEY idx_rewards_parent_pending (student_id, status),
  CONSTRAINT fk_rewards_student_id FOREIGN KEY (student_id) REFERENCES students (id) ON DELETE CASCADE,
  CONSTRAINT fk_rewards_subject_id FOREIGN KEY (subject_id) REFERENCES subjects (id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ============================================================
-- 10. 基础设施
-- ============================================================

CREATE TABLE IF NOT EXISTS uploaded_files (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  uploader_id BIGINT NOT NULL,
  uploader_type VARCHAR(10) NOT NULL,
  url VARCHAR(500) NOT NULL,
  mime_type VARCHAR(50) NOT NULL,
  size_bytes BIGINT NOT NULL,
  source VARCHAR(20) NOT NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  KEY idx_uf_uploader (uploader_type, uploader_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS extract_tasks (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  file_id BIGINT NOT NULL,
  student_id BIGINT DEFAULT NULL,
  provider VARCHAR(20) NOT NULL,
  status VARCHAR(20) NOT NULL DEFAULT 'pending',
  result TEXT DEFAULT NULL,
  error_message TEXT DEFAULT NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  KEY idx_et_status (status),
  CONSTRAINT fk_et_file_id FOREIGN KEY (file_id) REFERENCES uploaded_files (id) ON DELETE RESTRICT,
  CONSTRAINT fk_et_student_id FOREIGN KEY (student_id) REFERENCES students (id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ============================================================
-- 11. updated_at 自动触发器
-- ============================================================

DROP TRIGGER IF EXISTS trg_parents_updated_at;
CREATE TRIGGER trg_parents_updated_at
BEFORE UPDATE ON parents
FOR EACH ROW
SET NEW.updated_at = CURRENT_TIMESTAMP(3);

DROP TRIGGER IF EXISTS trg_students_updated_at;
CREATE TRIGGER trg_students_updated_at
BEFORE UPDATE ON students
FOR EACH ROW
SET NEW.updated_at = CURRENT_TIMESTAMP(3);

DROP TRIGGER IF EXISTS trg_student_settings_updated_at;
CREATE TRIGGER trg_student_settings_updated_at
BEFORE UPDATE ON student_settings
FOR EACH ROW
SET NEW.updated_at = CURRENT_TIMESTAMP(3);

DROP TRIGGER IF EXISTS trg_subjects_updated_at;
CREATE TRIGGER trg_subjects_updated_at
BEFORE UPDATE ON subjects
FOR EACH ROW
SET NEW.updated_at = CURRENT_TIMESTAMP(3);

DROP TRIGGER IF EXISTS trg_textbook_versions_updated_at;
CREATE TRIGGER trg_textbook_versions_updated_at
BEFORE UPDATE ON textbook_versions
FOR EACH ROW
SET NEW.updated_at = CURRENT_TIMESTAMP(3);

DROP TRIGGER IF EXISTS trg_semesters_updated_at;
CREATE TRIGGER trg_semesters_updated_at
BEFORE UPDATE ON semesters
FOR EACH ROW
SET NEW.updated_at = CURRENT_TIMESTAMP(3);

DROP TRIGGER IF EXISTS trg_units_updated_at;
CREATE TRIGGER trg_units_updated_at
BEFORE UPDATE ON units
FOR EACH ROW
SET NEW.updated_at = CURRENT_TIMESTAMP(3);

DROP TRIGGER IF EXISTS trg_lessons_updated_at;
CREATE TRIGGER trg_lessons_updated_at
BEFORE UPDATE ON lessons
FOR EACH ROW
SET NEW.updated_at = CURRENT_TIMESTAMP(3);

DROP TRIGGER IF EXISTS trg_cards_updated_at;
CREATE TRIGGER trg_cards_updated_at
BEFORE UPDATE ON cards
FOR EACH ROW
SET NEW.updated_at = CURRENT_TIMESTAMP(3);

DROP TRIGGER IF EXISTS trg_knowledge_points_updated_at;
CREATE TRIGGER trg_knowledge_points_updated_at
BEFORE UPDATE ON knowledge_points
FOR EACH ROW
SET NEW.updated_at = CURRENT_TIMESTAMP(3);

DROP TRIGGER IF EXISTS trg_questions_updated_at;
CREATE TRIGGER trg_questions_updated_at
BEFORE UPDATE ON questions
FOR EACH ROW
SET NEW.updated_at = CURRENT_TIMESTAMP(3);

DROP TRIGGER IF EXISTS trg_student_knowledge_mastery_updated_at;
CREATE TRIGGER trg_student_knowledge_mastery_updated_at
BEFORE UPDATE ON student_knowledge_mastery
FOR EACH ROW
SET NEW.updated_at = CURRENT_TIMESTAMP(3);

DROP TRIGGER IF EXISTS trg_progress_updated_at;
CREATE TRIGGER trg_progress_updated_at
BEFORE UPDATE ON progress
FOR EACH ROW
SET NEW.updated_at = CURRENT_TIMESTAMP(3);

DROP TRIGGER IF EXISTS trg_homeworks_updated_at;
CREATE TRIGGER trg_homeworks_updated_at
BEFORE UPDATE ON homeworks
FOR EACH ROW
SET NEW.updated_at = CURRENT_TIMESTAMP(3);

DROP TRIGGER IF EXISTS trg_homework_submissions_updated_at;
CREATE TRIGGER trg_homework_submissions_updated_at
BEFORE UPDATE ON homework_submissions
FOR EACH ROW
SET NEW.updated_at = CURRENT_TIMESTAMP(3);

DROP TRIGGER IF EXISTS trg_assessments_updated_at;
CREATE TRIGGER trg_assessments_updated_at
BEFORE UPDATE ON assessments
FOR EACH ROW
SET NEW.updated_at = CURRENT_TIMESTAMP(3);

DROP TRIGGER IF EXISTS trg_assessment_submissions_updated_at;
CREATE TRIGGER trg_assessment_submissions_updated_at
BEFORE UPDATE ON assessment_submissions
FOR EACH ROW
SET NEW.updated_at = CURRENT_TIMESTAMP(3);

DROP TRIGGER IF EXISTS trg_answers_updated_at;
CREATE TRIGGER trg_answers_updated_at
BEFORE UPDATE ON answers
FOR EACH ROW
SET NEW.updated_at = CURRENT_TIMESTAMP(3);

DROP TRIGGER IF EXISTS trg_main_error_books_updated_at;
CREATE TRIGGER trg_main_error_books_updated_at
BEFORE UPDATE ON main_error_books
FOR EACH ROW
SET NEW.updated_at = CURRENT_TIMESTAMP(3);

DROP TRIGGER IF EXISTS trg_ai_dialogues_updated_at;
CREATE TRIGGER trg_ai_dialogues_updated_at
BEFORE UPDATE ON ai_dialogues
FOR EACH ROW
SET NEW.updated_at = CURRENT_TIMESTAMP(3);

DROP TRIGGER IF EXISTS trg_goals_updated_at;
CREATE TRIGGER trg_goals_updated_at
BEFORE UPDATE ON goals
FOR EACH ROW
SET NEW.updated_at = CURRENT_TIMESTAMP(3);

DROP TRIGGER IF EXISTS trg_controls_updated_at;
CREATE TRIGGER trg_controls_updated_at
BEFORE UPDATE ON controls
FOR EACH ROW
SET NEW.updated_at = CURRENT_TIMESTAMP(3);

DROP TRIGGER IF EXISTS trg_rewards_updated_at;
CREATE TRIGGER trg_rewards_updated_at
BEFORE UPDATE ON rewards
FOR EACH ROW
SET NEW.updated_at = CURRENT_TIMESTAMP(3);

DROP TRIGGER IF EXISTS trg_extract_tasks_updated_at;
CREATE TRIGGER trg_extract_tasks_updated_at
BEFORE UPDATE ON extract_tasks
FOR EACH ROW
SET NEW.updated_at = CURRENT_TIMESTAMP(3);

SET FOREIGN_KEY_CHECKS = 1;
