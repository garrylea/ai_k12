-- K12 智学系统 — 数据库初始化脚本
-- 依据：docs/K12智学系统-数据库设计文档.md（版本 v1.8）
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
  is_active TINYINT(1) NOT NULL DEFAULT 1,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
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
  is_active TINYINT(1) NOT NULL DEFAULT 1,
  avatar_url VARCHAR(500) DEFAULT NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  deleted_at DATETIME(3) DEFAULT NULL,
  UNIQUE KEY uniq_students_username (username, deleted_at),
  KEY idx_students_parent_id (parent_id),
  CONSTRAINT fk_students_parent_id FOREIGN KEY (parent_id) REFERENCES parents (id) ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS admins (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  username VARCHAR(50) NOT NULL,
  password_hash VARCHAR(255) NOT NULL,
  name VARCHAR(50) DEFAULT NULL,
  is_active TINYINT(1) NOT NULL DEFAULT 1,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  deleted_at DATETIME(3) DEFAULT NULL,
  UNIQUE KEY uniq_admins_username (username, deleted_at)
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
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
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
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
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
  edition VARCHAR(50) NOT NULL DEFAULT '' COMMENT '版次标记：书名前导括号内容（如「根据2022年版课程标准修订」），空=旧版（2012 课标）',
  is_active TINYINT(1) NOT NULL DEFAULT 1,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  UNIQUE KEY uniq_textbook_versions_code (code),
  UNIQUE KEY uniq_textbook_versions_edition (subject_id, publisher, grade_band, edition),
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
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
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
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
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
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
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
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
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
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
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
  full_score SMALLINT DEFAULT NULL,
  content TEXT NOT NULL,
  options TEXT DEFAULT NULL,
  answer TEXT NOT NULL,
  explanation TEXT DEFAULT NULL,
  approach TEXT DEFAULT NULL,                       -- 解题思路（方法/切入点概述；折回自 migrations/2026-09-10_add_questions_approach_verified.sql）
  material_text TEXT DEFAULT NULL,
  material_url TEXT DEFAULT NULL,
  grade_band VARCHAR(20) DEFAULT NULL,
  source VARCHAR(200) DEFAULT NULL,
  source_year SMALLINT DEFAULT NULL,
  content_hash CHAR(64) DEFAULT NULL,
  answer_verified TINYINT(1) NOT NULL DEFAULT 0,    -- 人工/AI 核验导入标记（answer_importer 置 1）
  is_active TINYINT(1) NOT NULL DEFAULT 1,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
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

-- ===== 训练模块（考试/专项/错题练习）基础表 =====
-- 折回自 migrations/2026-09-02_add_training_tables.sql（install_mysql.sh 只执行 schema.sql，
-- 迁移需同步折回；先例：textbook_versions 的 edition 4 元组）。
-- 设计：docs/superpowers/specs/2026-09-02-math-training-module-design.md

-- 试卷（爬取试卷的归组实体；source_key = published JSONL 相对路径，幂等键）
CREATE TABLE IF NOT EXISTS exam_papers (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  subject_id BIGINT NOT NULL,
  title VARCHAR(200) NOT NULL,
  grade VARCHAR(20) DEFAULT NULL,
  grade_band VARCHAR(20) DEFAULT NULL,
  semester VARCHAR(20) DEFAULT NULL,
  year SMALLINT DEFAULT NULL,
  district VARCHAR(50) DEFAULT NULL,
  exam_type VARCHAR(30) DEFAULT NULL,
  source_key VARCHAR(200) NOT NULL,
  question_count SMALLINT NOT NULL DEFAULT 0,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  UNIQUE KEY uniq_ep_source_key (source_key),
  CONSTRAINT fk_ep_subject FOREIGN KEY (subject_id) REFERENCES subjects (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 试卷-题目关联（多对多：content_hash 去重后同一题可属多卷；question_no 按 JSONL 行序）
CREATE TABLE IF NOT EXISTS paper_questions (
  paper_id BIGINT NOT NULL,
  question_id BIGINT NOT NULL,
  question_no SMALLINT NOT NULL,
  group_id VARCHAR(50) DEFAULT NULL,
  group_order SMALLINT DEFAULT NULL,
  PRIMARY KEY (paper_id, question_id),
  KEY idx_pq_question (question_id),
  CONSTRAINT fk_pq_paper FOREIGN KEY (paper_id) REFERENCES exam_papers (id) ON DELETE CASCADE,
  CONSTRAINT fk_pq_question FOREIGN KEY (question_id) REFERENCES questions (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 题级提示缓存（镜像 cards.hints 语义；训练题无卡，按 question_id 缓存）
CREATE TABLE IF NOT EXISTS question_hints (
  question_id BIGINT NOT NULL,
  hint TEXT NOT NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (question_id),
  CONSTRAINT fk_qh_question FOREIGN KEY (question_id) REFERENCES questions (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 语文古诗文专项篇目（2026-09-13 建；2026-09-15 独立化——改名自 dictation_passages、
-- 摘除 question_id）。**独立子系统**：不挂 questions、不进错题本、不参与主线清零门禁
-- （PRD §6.3 / §7.4）。**无外键**——本表不指向任何表，也不被任何表指向，表即完整边界。
--
-- 两个专项共用本表，一篇一行，各取各的列：
--   默写抽题池 = verified = 1 AND memorize_required = 1 AND is_active = 1
--   解释抽题池 = verified = 1 AND is_active = 1 AND JSON_LENGTH(sentences) > 0
--                （不设 memorize_required——要背诵不是要理解翻译的必要条件；
--                 多一条「内容就绪」——没切过句的篇目点进去没题目）
-- 设计见 docs/superpowers/specs/2026-09-15-chinese-interpretation-special-design.md §6
-- 与 docs/superpowers/plans/2026-09-16-chinese-interpretation-special.md
CREATE TABLE IF NOT EXISTS chinese_passages (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  work_title VARCHAR(100) NOT NULL,      -- 篇名，如《岳阳楼记》；业务键之一
  author VARCHAR(50) NOT NULL,           -- 作者
  dynasty VARCHAR(20) NOT NULL,          -- 朝代
  body TEXT NOT NULL,                    -- 正文（权威原文，含标点）
  -- 体裁（2026-09-17 建，服务闯关积分）：'poem' 诗/词 | 'prose' 文言文；NULL = 未标定，不发分。
  -- 积分体系里默写/翻译按体裁分档（诗 2 分 / 文言文 5 分），所以必须显式标定——**不猜、也不
  -- 默认按古诗处理**；发分前校验 genre IS NULL 就跳过并留日志。
  -- 刻意**不复用** sentence_meanings 的有无来推体裁：那是「含义数据是否就绪」（只给诗词灌），
  -- 与「这篇是什么体裁」是两件事，勿混（见 docs/superpowers/specs/2026-09-17-gamification-points-design.md §4.1）。
  genre VARCHAR(10) DEFAULT NULL COMMENT 'poem 诗/词 | prose 文言文；NULL = 未标定，不发分',
  -- ---- 解释专项内容（2026-09-16）；字词由人整理后经 interpretation_cli 入库 ----
  key_terms JSON DEFAULT NULL,           -- [{"term":"谪守","gloss":"…","src":"…","sentenceIndex":0}]
                                         -- sentenceIndex 指向 sentences 下标（字词属于哪一句）
  sentences JSON DEFAULT NULL,           -- [{"text":"…","translation":"…"}]；不变式 ''.join(text) == body
  -- 含义专项（2026-09-17）：每句 {"meaning","emotion"}，缺数据写 null（不是省略——
  -- 省略会让后面整体错位）。只给诗词灌，文言文留 NULL——「只做诗词」由数据有无实现；
  -- 体裁另见上方 genre 列（积分按体裁分档），与本列两回事，勿以本列有无反推体裁。
  sentence_meanings JSON DEFAULT NULL,   -- [{"meaning":"…","emotion":"…"}]，与 sentences 下标对齐
  full_translation TEXT DEFAULT NULL,    -- 整篇译文
  grade_band VARCHAR(20) NOT NULL,       -- 'junior'
  grade VARCHAR(20) DEFAULT NULL,        -- '九年级'
  semester VARCHAR(20) NOT NULL,         -- '上册' / '下册'；业务键之一
  sort_order SMALLINT NOT NULL DEFAULT 0,
  source_ref VARCHAR(200) DEFAULT NULL,  -- 教材来源（书名 + 页码）
  verified TINYINT(1) NOT NULL DEFAULT 0,
  -- 教学上是否要求背诵。与 verified 是**两道正交的闸门**：
  --   verified           = 内容是否已校验（正文准确）—— 内容管线自检通过后置 1
  --   memorize_required  = 教学上是否要求背 —— 由人后续标定
  memorize_required TINYINT(1) NOT NULL DEFAULT 0,
  is_active TINYINT(1) NOT NULL DEFAULT 1,  -- 停用开关（取代原 questions.is_active）
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  UNIQUE KEY uniq_chinese_passages_work (work_title, semester),
  KEY idx_chinese_passages_filter (grade_band, semester, sort_order)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 英语背单词词库（2026-09-17 建）。**独立子系统**，与 chinese_passages 同形论证：
-- 作答单位是「词 / 义项」，标准答案是词条自带属性，不接主线、没有「重做—清零」对象
-- ——因此不挂 questions、不进错题本、不参与主线清零门禁、不用「不再展示」/提示缓存/自评。
-- **无外键**：本表不指向任何表，也不被任何表指向（进度表不反向约束它），表即完整边界。
--
-- 词源（必须用课标官方 PDF 原文，不用文库转载版）：
--   义务教育英语课程标准（2022 年版）附录词汇表          → 1600 词
--   普通高中英语课程标准（2017 年版 2020 年修订）附录词汇表 → 3000 词
-- level 存四层，与课标原文一一对应，页面只暴露「仅初中 / 仅高中 / 全部」三档：
--   primary 小学二级(505) / junior 初中三级(~1095)
--   senior_required 高中必修(500) / senior_elective 高中选择性必修(1000)
-- 两表都收录的词 level 归 junior；「仅高中」= 3000 表中不在 1600 表中的词。
--
-- meanings 是不变式约束的核心：必须至少有一个 extended=false 义项；任一 extended=true
-- 义项必须有非空 context（熟词僻义靠「单词 + 锁定僻义的搭配」出题）。has_extended_sense
-- 是冗余列，存在的唯一理由是 MySQL 搜不了 JSON 里的布尔值（JSON_SEARCH 只搜字符串、
-- JSON_CONTAINS 走不了索引），抽题池过滤需要一条能走索引的 WHERE。
--
-- error_count 是**全局**累计错次（只增），供全平台「易错词」排序；学生自己的错次另存
-- student_word_progress.wrong_count（可被学生清除）。内容管线 loader 的
-- ON DUPLICATE KEY UPDATE 子句**必须显式排除 error_count**，否则一次全量重灌会抹掉
-- 全平台的易错统计（同 dictation_loader 特意不更新 memorize_required/is_active 的理据）。
--
-- 设计见 docs/superpowers/specs/2026-09-16-english-vocabulary-special-design.md
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

-- 学生背词进度（轻量，不做艾宾浩斯排程）。唯一的目的是让「只出没背过的」「我错过的词」
-- 「今日已背 N/15」三个筛选成立——没有它，「每天背 10-20 个」就是每天在 1600 词里重抽。
--
-- word_id 上**故意不设外键**：内容表必须能被内容管线随时全量重灌，入向外键会让
-- full-reload 的业务数据守卫跟重灌互相卡死。完整性由管线的 check 与后端测试保证。
-- student_id 则照既有约定挂 students(id)（同 practice_results）。
--
-- wrong_count 是学生自己的累计错次，「移除易错标记」清零的是它——不动 learned，
-- 也不动 english_words.error_count（那是全平台统计，不该被单个学生抹掉）。
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

-- 考试会话（服务器权威计时：deadline_at；状态 in_progress | submitted）
CREATE TABLE IF NOT EXISTS exam_sessions (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  student_id BIGINT NOT NULL,
  paper_id BIGINT NOT NULL,
  subject_id BIGINT NOT NULL,
  status VARCHAR(20) NOT NULL DEFAULT 'in_progress',
  duration_minutes SMALLINT NOT NULL,
  started_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  deadline_at DATETIME(3) NOT NULL,
  submitted_at DATETIME(3) DEFAULT NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  KEY idx_es_student_status (student_id, status),
  CONSTRAINT fk_es_paper FOREIGN KEY (paper_id) REFERENCES exam_papers (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 考试逐题作答（is_correct NULL = 在途/未判；method: exact|ai|self_assess|unanswered|failed）
CREATE TABLE IF NOT EXISTS exam_answers (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  session_id BIGINT NOT NULL,
  question_id BIGINT NOT NULL,
  question_order SMALLINT NOT NULL,
  answer_text TEXT,
  is_correct TINYINT(1) DEFAULT NULL,
  method VARCHAR(20) DEFAULT NULL,         -- 折回自 migrations/2026-09-09_widen_method_columns.sql：容纳 'self_assess'（11 字符）
  analysis TEXT,
  error_type VARCHAR(20) DEFAULT NULL,
  judged_at DATETIME(3) DEFAULT NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  UNIQUE KEY uniq_ea_session_q (session_id, question_id),
  CONSTRAINT fk_ea_session FOREIGN KEY (session_id) REFERENCES exam_sessions (id) ON DELETE CASCADE,
  CONSTRAINT fk_ea_question FOREIGN KEY (question_id) REFERENCES questions (id) ON DELETE RESTRICT
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
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
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
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
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
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
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
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
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
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
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
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
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
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
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
  -- 卡内复合题号（如 "0-1"），错题清零时展示与判题复用所需。
  -- practice/discuss 来源在 judge/startDiscuss 写入时带上；历史行由回填脚本补全。
  question_n VARCHAR(20) DEFAULT NULL,
  -- 错题归属课时：冗余字段，用于按课聚合/统计。
  -- practice/discuss 来源取 cards.lesson_id；homework 取 homeworks.lesson_id；
  -- unit_test/midterm/final 等无法精确归到单节课的场景可留 NULL。
  lesson_id BIGINT DEFAULT NULL,
  wrong_answer_text TEXT DEFAULT NULL,
  -- B方案：关联的 mainline 讨论对话，跨刷新/跨设备续接同一讨论线。
  -- 错题本是「学生+题」的锚，dialogue_id 让重开讨论回到同一对话而非另起。
  dialogue_id BIGINT DEFAULT NULL,
  cleared_at DATETIME(3) DEFAULT NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  KEY idx_me_student_subject (student_id, subject_id),
  KEY idx_me_student_cleared (student_id, is_cleared),
  KEY idx_me_student_level (student_id, is_cleared, level),
  KEY idx_me_student_lesson_cleared (student_id, lesson_id, is_cleared),
  KEY idx_me_dialogue_id (dialogue_id),
  CONSTRAINT fk_me_student_id FOREIGN KEY (student_id) REFERENCES students (id) ON DELETE CASCADE,
  CONSTRAINT fk_me_subject_id FOREIGN KEY (subject_id) REFERENCES subjects (id) ON DELETE RESTRICT,
  CONSTRAINT fk_me_question_id FOREIGN KEY (question_id) REFERENCES questions (id) ON DELETE RESTRICT,
  CONSTRAINT fk_me_lesson_id FOREIGN KEY (lesson_id) REFERENCES lessons (id) ON DELETE SET NULL
  -- 注：dialogue_id 不加 FK 约束（main_error_books 建表早于 ai_dialogues，无法前向引用）。
  -- 作软引用：dialogue 被删时由 PracticeService.startDiscuss 的 try/catch 兜底重建。
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ============================================================
-- 学生「不再展示」清单（专项训练选题排除用）
-- ============================================================

CREATE TABLE IF NOT EXISTS student_hidden_questions (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  student_id BIGINT NOT NULL,
  subject_id BIGINT NOT NULL,
  question_id BIGINT NOT NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  UNIQUE KEY uniq_shq_student_question (student_id, question_id),
  KEY idx_shq_student (student_id),
  KEY idx_shq_student_subject (student_id, subject_id),
  CONSTRAINT fk_shq_student_id FOREIGN KEY (student_id) REFERENCES students (id) ON DELETE CASCADE,
  CONSTRAINT fk_shq_subject_id FOREIGN KEY (subject_id) REFERENCES subjects (id) ON DELETE RESTRICT,
  CONSTRAINT fk_shq_question_id FOREIGN KEY (question_id) REFERENCES questions (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ============================================================
-- 课堂练习判题结果持久化（学生×卡×题，单题重做 upsert）
-- ============================================================
CREATE TABLE IF NOT EXISTS practice_results (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  student_id BIGINT NOT NULL,
  subject_id BIGINT NOT NULL,
  card_id BIGINT NOT NULL,
  lesson_id BIGINT NOT NULL,
  question_id BIGINT DEFAULT NULL,        -- 题库命中时填；未命中 null
  question_n VARCHAR(20) NOT NULL,         -- 卡内复合题号（如 "0-1"），upsert 去重键
  question_text TEXT NOT NULL,             -- 题面（question_id 为空时兜底身份 + 展示）
  student_answer TEXT NOT NULL,
  is_correct TINYINT(1) NOT NULL,
  method VARCHAR(20) NOT NULL,             -- 'exact' | 'ai' | 'self_assess' | 'unanswered'；折回自 migrations/2026-09-09_widen_method_columns.sql
  analysis TEXT DEFAULT NULL,              -- 题解（仅错题，复用判题 analysis）
  error_type VARCHAR(20) DEFAULT NULL,     -- logic|calculation|format|missing|null
  judged_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  UNIQUE KEY uniq_pr_student_card_qn (student_id, card_id, question_n),
  KEY idx_pr_student_card (student_id, card_id),
  KEY idx_pr_student_lesson (student_id, lesson_id),
  CONSTRAINT fk_pr_student_id FOREIGN KEY (student_id) REFERENCES students (id) ON DELETE CASCADE,
  CONSTRAINT fk_pr_card_id   FOREIGN KEY (card_id)   REFERENCES cards (id)    ON DELETE CASCADE,
  CONSTRAINT fk_pr_subject_id FOREIGN KEY (subject_id) REFERENCES subjects (id) ON DELETE RESTRICT,
  CONSTRAINT fk_pr_question_id FOREIGN KEY (question_id) REFERENCES questions (id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 学生主观题自评留痕（判题体系重构 2026-09-09）：short_answer/proof 在 self_assess 模式下
-- 由学生对照参考答案自评对错；每次自评留痕（学情分析 / 自评 vs AI 一致率数据源）。
-- 折回自 migrations/2026-09-09_add_question_self_assessments.sql。
CREATE TABLE IF NOT EXISTS question_self_assessments (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  student_id BIGINT NOT NULL,
  question_id BIGINT NOT NULL,
  assessment VARCHAR(10) NOT NULL,        -- 'correct' | 'incorrect'
  source VARCHAR(20) NOT NULL,            -- 'targeted' | 'error_practice' | 'exam' | 'practice'
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  KEY idx_qsa_student_question (student_id, question_id),
  CONSTRAINT fk_qsa_student FOREIGN KEY (student_id) REFERENCES students (id) ON DELETE CASCADE,
  CONSTRAINT fk_qsa_question FOREIGN KEY (question_id) REFERENCES questions (id) ON DELETE CASCADE
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
  scene VARCHAR(30) NOT NULL DEFAULT 'aux_qna',  -- 会话场景分型: aux_qna(辅线答疑)|aux_training(训练讲一讲)|mainline_question(课堂练习讲一讲)|mainline_card(卡片思辨答疑)
  card_id BIGINT DEFAULT NULL,
  question_id BIGINT DEFAULT NULL,               -- 训练讲一讲按题锚（find-or-create）；question 级讨论由 main_error_books.dialogue_id 锚定
  knowledge_point_id BIGINT DEFAULT NULL,
  title VARCHAR(200) DEFAULT NULL,
  status VARCHAR(10) NOT NULL DEFAULT 'active',
  flow_state VARCHAR(30) NOT NULL DEFAULT 'idle',  -- P1 图片两阶段状态机: idle|awaiting_selection|awaiting_confirmation
  pending_question TEXT DEFAULT NULL,              -- P1 已转录待确认的题干
  pending_questions TEXT DEFAULT NULL,             -- P1 多题时的全部转录 JSON
  consecutive_fail_count SMALLINT NOT NULL DEFAULT 0,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  deleted_at DATETIME(3) DEFAULT NULL,
  KEY idx_dlg_student_track (student_id, track),
  KEY idx_dlg_student_card (student_id, track, card_id),
  KEY idx_dlg_student_scene_question (student_id, track, scene, question_id),
  CONSTRAINT fk_dlg_student_id FOREIGN KEY (student_id) REFERENCES students (id) ON DELETE CASCADE,
  CONSTRAINT fk_dlg_subject_id FOREIGN KEY (subject_id) REFERENCES subjects (id) ON DELETE SET NULL,
  CONSTRAINT fk_dlg_card_id FOREIGN KEY (card_id) REFERENCES cards (id) ON DELETE SET NULL,
  CONSTRAINT fk_dlg_question_id FOREIGN KEY (question_id) REFERENCES questions (id) ON DELETE SET NULL,
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
  KEY idx_sa_parent_created (parent_id, created_at),
  KEY idx_sa_created_at (created_at),
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
  subject_id BIGINT DEFAULT NULL COMMENT '按学科目标；为 NULL 的历史行是迁移前停用行，读侧被 is_active=1 过滤',
  scope_subject_id BIGINT AS (IF(metric IS NULL, NULL, COALESCE(subject_id, 0))) VIRTUAL COMMENT '生成列（条件式，必须 VIRTUAL 不能 STORED——STORED 会重建表并被外键挡住）：metric 非空时把 subject_id 的 NULL 折 0 供唯一键用；metric 为空的历史停用行保持 NULL，不参与唯一性',
  metric VARCHAR(40) DEFAULT NULL COMMENT 'daily_study_minutes|weekly_lessons|daily_words|weekly_passages|weekly_clear_errors',
  title VARCHAR(200) NOT NULL,
  period VARCHAR(10) NOT NULL,
  target_value SMALLINT NOT NULL,
  reminder_enabled TINYINT(1) NOT NULL DEFAULT 0,
  is_active TINYINT(1) NOT NULL DEFAULT 1,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  KEY idx_goals_student (student_id, is_active),
  UNIQUE KEY uniq_goals_student_scope_metric (student_id, scope_subject_id, metric),
  CONSTRAINT fk_goals_student_id FOREIGN KEY (student_id) REFERENCES students (id) ON DELETE CASCADE,
  CONSTRAINT fk_goals_subject_id FOREIGN KEY (subject_id) REFERENCES subjects (id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS controls (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  student_id BIGINT NOT NULL,
  daily_time_limit_minutes SMALLINT DEFAULT NULL,
  disabled_hours TEXT DEFAULT NULL,
  reward_redemption_enabled TINYINT(1) NOT NULL DEFAULT 1,   -- 兑换总开关：关了兑换端点直接 400
  -- 兑换汇率：多少积分换 1 元（家长可配）。与上面开关配合使用。
  points_per_yuan SMALLINT NOT NULL DEFAULT 20 COMMENT '多少积分换 1 元',
  auxiliary_enabled TINYINT(1) NOT NULL DEFAULT 1,
  photo_search_enabled TINYINT(1) NOT NULL DEFAULT 1,
  alert_level VARCHAR(10) NOT NULL DEFAULT 'standard',
  break_reminder_minutes SMALLINT DEFAULT NULL,
  alert_away_minutes SMALLINT NOT NULL DEFAULT 5 COMMENT '切走多少分钟写 away 预警（家长可调 1..180）',
  alert_idle_minutes SMALLINT NOT NULL DEFAULT 15 COMMENT '前台无操作多少分钟写 idle 预警（家长可调 1..180）',
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
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
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
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
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  KEY idx_et_status (status),
  CONSTRAINT fk_et_file_id FOREIGN KEY (file_id) REFERENCES uploaded_files (id) ON DELETE RESTRICT,
  CONSTRAINT fk_et_student_id FOREIGN KEY (student_id) REFERENCES students (id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ============================================================
-- 12. 管理员中枢
-- ============================================================

CREATE TABLE IF NOT EXISTS llm_models (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  model_key VARCHAR(50) NOT NULL,
  name VARCHAR(100) NOT NULL,
  provider_type VARCHAR(20) NOT NULL,
  model_id VARCHAR(100) NOT NULL,
  base_url VARCHAR(255) NOT NULL,
  api_key VARCHAR(500) NOT NULL,
  context_window INT NOT NULL DEFAULT 131072,
  max_output_tokens INT NOT NULL DEFAULT 16384,
  is_enabled TINYINT(1) NOT NULL DEFAULT 1,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  UNIQUE KEY uniq_llm_models_key (model_key)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS llm_routes (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  scene VARCHAR(30) NOT NULL,
  subject VARCHAR(20) NOT NULL,
  primary_model_key VARCHAR(50) NOT NULL,
  fallback_model_key VARCHAR(50) DEFAULT NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  UNIQUE KEY uniq_llm_routes (scene, subject),
  CONSTRAINT fk_llm_routes_primary FOREIGN KEY (primary_model_key) REFERENCES llm_models (model_key)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS parent_messages (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  parent_id BIGINT DEFAULT NULL,
  type VARCHAR(20) NOT NULL,
  title VARCHAR(100) NOT NULL,
  content TEXT NOT NULL,
  is_read TINYINT(1) NOT NULL DEFAULT 0,
  read_at DATETIME(3) DEFAULT NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  KEY idx_parent_messages_parent (parent_id, is_read)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS message_reads (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  parent_id BIGINT NOT NULL,
  message_id BIGINT NOT NULL,
  read_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  UNIQUE KEY uniq_message_reads (parent_id, message_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS admin_dialogues (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  admin_id BIGINT NOT NULL,
  model_key VARCHAR(50) NOT NULL,
  title VARCHAR(200) DEFAULT NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  KEY idx_admin_dialogues_admin (admin_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS admin_messages (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  dialogue_id BIGINT NOT NULL,
  role VARCHAR(10) NOT NULL,
  content TEXT NOT NULL,
  reasoning TEXT DEFAULT NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  KEY idx_admin_messages_dialogue (dialogue_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 系统 -> 管理员通知（判题解析生成失败等；复刻 parent_messages 模式，question_id 定位题目）
CREATE TABLE IF NOT EXISTS admin_notifications (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  type VARCHAR(20) NOT NULL,
  question_id BIGINT DEFAULT NULL,
  title VARCHAR(100) NOT NULL,
  content TEXT NOT NULL,
  is_read TINYINT(1) NOT NULL DEFAULT 0,
  read_at DATETIME(3) DEFAULT NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  KEY idx_an_question_read (question_id, is_read)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ============================================================
-- 13. 闯关积分与段位体系（2026-09-17 建）
-- ============================================================
-- 学生完成 8 类任务得积分 → 积分累计升 9 个段位 → 家长可配分值/上限 → 家长可兑钱或奖励。
-- 积分是**平台级**的独立激励层，加在既有流程**旁边**而不是里面：不清零错题、不替代错题本、
-- 不参与主线解锁判定。语文古诗文 / 英语背单词仍是独立子系统，但**参与积分**（本次唯一新增的
-- 跨子系统耦合点，且单向：专项只调 PointsService，不被积分反向影响）。
--
-- **外键口径（勿「统一」掉）**：以下 6 张表**只挂 students(id)**，不指向 questions /
-- chinese_passages / english_words / exam_sessions 等任何内容表——与 chinese_passages /
-- english_words 同规矩，内容表可被管线全量重灌，入向外键会把 re-load 卡死。这是设计定案。
--
-- 段位常量（9 档阈值）**不落库**，写在 apps/server/src/modules/points/levels.ts（单一真源），
-- 由 total_earned 实时算；`student_points` 只是读优化快照，可从流水重建。
-- 设计见 docs/superpowers/specs/2026-09-17-gamification-points-design.md §4.3。

-- 家长可配的分值表。一张表装三种档位维度靠 tier_key，语义由 task_code 决定
-- （词数 / 题数 / 体裁 / 'default'）。初始化用「懒初始化 + 幂等补齐」：任何读写该学生规则的
-- 入口先跑 INSERT IGNORE ... SELECT 补默认档位——新增任务/档位**零迁移**；代价是改代码里的
-- 默认值不会回溯已初始化的学生（有意接受，家长本就要自己调）。
CREATE TABLE IF NOT EXISTS point_rules (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  student_id BIGINT NOT NULL,
  task_code  VARCHAR(40) NOT NULL,
  tier_key   VARCHAR(20) NOT NULL DEFAULT 'default',
  tier_label VARCHAR(30) NOT NULL,          -- 展示名，如「10 词」「古诗」「3 题」
  points     INT NOT NULL,
  daily_limit SMALLINT DEFAULT NULL,        -- NULL = 不限
  sort_order SMALLINT NOT NULL DEFAULT 0,
  is_active  TINYINT(1) NOT NULL DEFAULT 1,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  UNIQUE KEY uniq_point_rules (student_id, task_code, tier_key),
  CONSTRAINT fk_point_rules_student FOREIGN KEY (student_id) REFERENCES students (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 积分流水（**唯一真源**——段位与快照都由它算）。
-- dedupe_key 唯一键是**幂等的唯一实现**：INSERT 撞键 = 已发过，回查首次结果，不报错。
-- title 存**快照**：家长改了分值/档位名后历史流水不能跟着变（否则孩子看到的「+2」与实际不符）。
-- idx_point_ledger_daily 服务每日上限计数，但两个日界由**应用层算好传参**，不在 SQL 用
-- CURDATE()（DB 会话时区与应用可能不一致，会算错一天——见 spec §4.4 与仓内既有约定）。
CREATE TABLE IF NOT EXISTS point_ledger (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  student_id BIGINT NOT NULL,
  kind       VARCHAR(16) NOT NULL,          -- 'earn' | 'redeem'
  task_code  VARCHAR(40) NOT NULL,          -- kind='redeem' 时固定 'redeem'
  tier_key   VARCHAR(20) NOT NULL DEFAULT 'default',
  points     INT NOT NULL,                  -- earn 正数 / redeem 负数
  dedupe_key VARCHAR(120) NOT NULL,
  title      VARCHAR(60) NOT NULL,          -- 展示文案快照，如「英语背单词 · 10 词」
  -- 来源类型（埋点实际写入的值，勿凭印象改）：
  --   'lesson'（mainline_lesson）| 'exam_session'（math_paper）| 'training_session'（乙类）
  --   | 'passage'（语文三专项）| 'question'（error_fix）；kind='redeem' 时为 NULL
  ref_type   VARCHAR(24) DEFAULT NULL,
  ref_id     BIGINT DEFAULT NULL,
  redemption_id BIGINT DEFAULT NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  UNIQUE KEY uniq_point_ledger_dedupe (dedupe_key),
  KEY idx_point_ledger_student_time (student_id, created_at),
  KEY idx_point_ledger_daily (student_id, task_code, kind, created_at),
  CONSTRAINT fk_point_ledger_student FOREIGN KEY (student_id) REFERENCES students (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 积分快照（读优化，**可重建**）：家长端多孩子列表 + 学生端每次进页面都要读，SUM 全表流水不划算。
-- total_earned 单调递增 —— 「段位只升不降」是它的必然结果（兑换只写 redeem 负流水，不减它）。
-- 与流水**同事务**更新；快照坏了由 rebuild-student-points.ts 从流水重算。
CREATE TABLE IF NOT EXISTS student_points (
  student_id BIGINT PRIMARY KEY,
  total_earned INT NOT NULL DEFAULT 0,      -- = SUM(points) WHERE kind='earn'
  balance      INT NOT NULL DEFAULT 0,      -- = SUM(points) 全部
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  CONSTRAINT fk_student_points_student FOREIGN KEY (student_id) REFERENCES students (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 家长配的奖励清单。min_level_code 为 NULL = 无段位门槛；否则达到该段位才可兑。
CREATE TABLE IF NOT EXISTS reward_catalog (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  student_id BIGINT NOT NULL,
  name        VARCHAR(100) NOT NULL,
  description VARCHAR(300) DEFAULT NULL,
  points_cost INT NOT NULL,
  min_level_code VARCHAR(20) DEFAULT NULL,  -- 达到某段位才可兑；NULL = 无门槛
  is_active   TINYINT(1) NOT NULL DEFAULT 1,
  sort_order  SMALLINT NOT NULL DEFAULT 0,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  KEY idx_reward_catalog_student (student_id, is_active),
  CONSTRAINT fk_reward_catalog_student FOREIGN KEY (student_id) REFERENCES students (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 兑换单（家长端操作，线下给现金，不走支付）。
-- **与 `rewards` 表（§9）分工勿混**：rewards 是 PRD §7.3「课级/单元级奖励发放」的实例记录
-- （平台按闯关节点发的），本期不动它；本表是「用积分换」的兑换单。两者语义不同，要合并另开 spec。
-- reward_name / cash_amount 都是**快照**（catalog 改名/删除不影响历史）。
-- 已知限制：本期兑换**不可撤销**，status 已为后续撤销留状态位。
CREATE TABLE IF NOT EXISTS point_redemptions (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  student_id BIGINT NOT NULL,
  type       VARCHAR(10) NOT NULL,          -- 'cash' | 'reward'
  points_spent INT NOT NULL,
  cash_amount  DECIMAL(10,2) DEFAULT NULL,  -- type='cash' 时的金额快照
  reward_catalog_id BIGINT DEFAULT NULL,
  reward_name VARCHAR(100) DEFAULT NULL,    -- 快照（catalog 改名/删除不影响历史）
  status     VARCHAR(16) NOT NULL DEFAULT 'pending',  -- pending | fulfilled
  note       VARCHAR(200) DEFAULT NULL,
  ledger_id  BIGINT DEFAULT NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  fulfilled_at DATETIME(3) DEFAULT NULL,
  KEY idx_point_redemptions_student (student_id, status, created_at),
  CONSTRAINT fk_point_redemptions_student FOREIGN KEY (student_id) REFERENCES students (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 训练会话（**只服务 math_targeted / en_vocabulary**）。
-- 只给「档位打包价」的两个任务用：`3 题 8 分`是打包价，逐题发分就退化成线性「每题 2 分」，
-- 会抵消溢价设计，必须整批发。其余 6 个任务各有天然发分点（判题函数里判了几篇发几份，
-- 没有可虚报的空间），**不写这张表**。
-- 防伪造的关键：发分按**会话里记录的档位**算，不按前端传来的档位算。
-- expected_count / judged_count 只做审计留痕，**不阻断发分**（完成即给分：做了 1 题就该得 1 题的分）。
CREATE TABLE IF NOT EXISTS training_sessions (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  student_id BIGINT NOT NULL,
  task_code  VARCHAR(40) NOT NULL,
  subject_id BIGINT DEFAULT NULL,
  tier_key   VARCHAR(20) NOT NULL DEFAULT 'default',
  expected_count SMALLINT NOT NULL DEFAULT 1,   -- 本次应完成的目标数（题数）
  judged_count   SMALLINT NOT NULL DEFAULT 0,   -- 审计留痕：实际判过几题
  status     VARCHAR(16) NOT NULL DEFAULT 'in_progress',  -- in_progress | completed | abandoned
  -- 目标物类型：当前两个乙类任务（math_targeted / en_vocabulary）都写 'question'
  -- （注意与 point_ledger.ref_type 是两套值，那边才有 'exam_session'/'passage' 等）
  ref_type   VARCHAR(24) DEFAULT NULL,
  ref_id     BIGINT DEFAULT NULL,
  started_at   DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  completed_at DATETIME(3) DEFAULT NULL,
  KEY idx_training_sessions_student (student_id, status, started_at),
  CONSTRAINT fk_training_sessions_student FOREIGN KEY (student_id) REFERENCES students (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ===== 错题补偿套题（相似题专项，2026-09-21）=====
-- 折回自 migrations/2026-09-21_remediation_sets.sql（install_mysql.sh 只执行 schema.sql，迁移需同步折回）。
-- 设计：docs/superpowers/specs/2026-09-21-remediation-set-design.md

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

-- ============================================================
-- 14. 埋点与账本（2026-09-20，埋点 Phase 0）
-- ============================================================
-- 见 tools/db/migrations/2026-09-20_analytics_ledger.sql 的头部注释（口径与幂等说明）。

-- ---- llm_call_logs：每次 LLM 调用（含重试尝试、失败、超时、fallback）一行 ----
-- student_id 用 ON DELETE SET NULL（**有意**偏离仓库 CASCADE 约定）：账本是审计数据，
-- 学生被删后聚合量应保留、仅匿名化；列可空故 FK 合法。
-- input_tokens / output_tokens 允许 NULL —— **NULL = 拿不到，绝不是 0**；
-- 0 会让「用量缺失」在报表上隐身，NULL 才能被单列出来。与家长端 answered=0 → rate=null 同一纪律。
CREATE TABLE IF NOT EXISTS llm_call_logs (
  id                  BIGINT AUTO_INCREMENT PRIMARY KEY,
  request_id          VARCHAR(64)   DEFAULT NULL COMMENT '关联 api_request_logs.request_id',
  student_id          BIGINT        DEFAULT NULL COMMENT '有归属时必填；仅 admin-chat/探活/系统任务为 NULL',
  dialogue_id         BIGINT        DEFAULT NULL COMMENT '无外键：对话可删，账本不可',
  -- 可空：探活/管理员对话构造的模型配置没有路由归因，scene 真的未知（见 spec §6.5 第 5 条）；
  -- 账本是批量 INSERT，一个 NULL 不能毒掉整批。
  scene               VARCHAR(30)   DEFAULT NULL,
  subject             VARCHAR(20)   DEFAULT NULL,
  capability          VARCHAR(30)   DEFAULT NULL,
  model_key           VARCHAR(50)   DEFAULT NULL COMMENT '路由条目 key（聚合按它，不按 model_id）',
  model_id            VARCHAR(100)  DEFAULT NULL COMMENT '实际下发 model id',
  provider            VARCHAR(20)   NOT NULL,
  attempt             SMALLINT      NOT NULL DEFAULT 1,
  request_kind        VARCHAR(8)    NOT NULL COMMENT 'chat|stream',
  is_fallback         TINYINT(1)    NOT NULL DEFAULT 0,
  success             TINYINT(1)    NOT NULL,
  error_type          VARCHAR(40)   DEFAULT NULL COMMENT 'LLMClientError 子类名，如 TimeoutError',
  http_status         SMALLINT      DEFAULT NULL,
  input_tokens        INT           DEFAULT NULL,
  output_tokens       INT           DEFAULT NULL,
  usage_source        VARCHAR(12)   NOT NULL DEFAULT 'unavailable' COMMENT 'provider|estimated|unavailable',
  latency_ms          INT           NOT NULL,
  created_at          DATETIME(3)   NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  KEY idx_lcl_scene_time    (scene, created_at),
  KEY idx_lcl_model_time    (model_key, created_at),
  KEY idx_lcl_student_time  (student_id, created_at),
  KEY idx_lcl_fallback_time (is_fallback, created_at),
  KEY idx_lcl_time          (created_at),
  CONSTRAINT fk_lcl_student_id FOREIGN KEY (student_id) REFERENCES students (id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ---- api_request_logs：每个 HTTP 请求一行（技术日志，30 天滚动） ----
-- route 是**归一化模板**（如 /api/practice/:cardId/results），raw_path 才带真实 id。
CREATE TABLE IF NOT EXISTS api_request_logs (
  id          BIGINT AUTO_INCREMENT PRIMARY KEY,
  request_id  VARCHAR(64)  DEFAULT NULL,
  actor_role  VARCHAR(10)  DEFAULT NULL COMMENT 'student|parent|admin|anonymous',
  student_id  BIGINT       DEFAULT NULL,
  method      VARCHAR(8)   NOT NULL,
  route       VARCHAR(120) NOT NULL COMMENT '归一化模板：/api/practice/:cardId/results',
  raw_path    VARCHAR(255) DEFAULT NULL COMMENT '原路径（含 id），仅排查用',
  module      VARCHAR(32)  DEFAULT NULL COMMENT '由 route 前缀推导',
  status_code SMALLINT     NOT NULL,
  biz_code    INT          DEFAULT NULL COMMENT '响应体 code（1001/5001...）',
  error_code  VARCHAR(40)  DEFAULT NULL COMMENT 'TimeoutError 等',
  latency_ms  INT          NOT NULL,
  is_sse      TINYINT(1)   NOT NULL DEFAULT 0,
  created_at  DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  KEY idx_arl_route_time   (route, created_at),
  KEY idx_arl_status_time  (status_code, created_at),
  KEY idx_arl_student_time (student_id, created_at),
  KEY idx_arl_time         (created_at),
  CONSTRAINT fk_arl_student_id FOREIGN KEY (student_id) REFERENCES students (id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ============================================================
-- 15.（已移除）updated_at 自动触发器
-- ============================================================
-- 这里原有的 28 条 trg_*_updated_at 触发器已全部删除，改用**列级**
-- `ON UPDATE CURRENT_TIMESTAMP(3)`（见各表 updated_at 列定义）。
-- 原因：触发器是**独立对象**，schema.sql 与既有库不同步时会静默缺失
-- （2026-09-19 实测：dev 库 28 条只装了 1 条，且那条长在已废弃的 aux_error_books 上，
--  导致 27 张在用的表 updated_at 在行被 UPDATE 时根本不刷新）。
-- 列级写法随 CREATE/ALTER TABLE 走，不存在「忘了装」。
-- **不要再往这里加 *_updated_at 触发器**；新表直接在列上写 ON UPDATE。

-- ============================================================
-- 16. 学习会话（2026-09-21，埋点 Phase 1A）
-- ============================================================
-- 见 tools/db/migrations/2026-09-21_study_sessions.sql 的头部注释（口径与幂等说明）。

-- ---- study_sessions：一段「进入学习页 → 离开 / 挂机结束」的会话 ----
-- active_seconds 只由服务端按心跳差值累计（单次封顶 45s），客户端上报的秒数一律不采信。
-- 设备列只到「类别」，不存唯一标识；platform_class/browser 由服务端解析 UA，
-- screen_class/input_type/app_shell 由前端上报。iPadOS 的 Macintosh UA 由服务端校正为 ipad。
CREATE TABLE IF NOT EXISTS study_sessions (
  id                BIGINT AUTO_INCREMENT PRIMARY KEY,
  student_id        BIGINT       NOT NULL,
  session_uid       CHAR(36)     NOT NULL COMMENT '前端生成的幂等键',
  module            VARCHAR(32)  NOT NULL COMMENT '低基数枚举，见 spec §5.1',
  scene             VARCHAR(40)  NOT NULL COMMENT '路由级细分，比 module 细',
  subject_id        BIGINT       DEFAULT NULL,
  ref_type          VARCHAR(24)  DEFAULT NULL COMMENT 'lesson|card|paper|passage|word|dialogue',
  ref_id            BIGINT       DEFAULT NULL,
  status            VARCHAR(12)  NOT NULL DEFAULT 'active' COMMENT 'active|ended|abandoned',
  client_state      VARCHAR(10)  NOT NULL DEFAULT 'visible' COMMENT 'visible|hidden（上次心跳时的可见性）',
  active_seconds    INT          NOT NULL DEFAULT 0 COMMENT '服务端累计；客户端上报的秒数一律不采信',
  heartbeat_count   INT          NOT NULL DEFAULT 0,
  started_at        DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  last_heartbeat_at DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  ended_at          DATETIME(3)  DEFAULT NULL,
  end_reason        VARCHAR(20)  DEFAULT NULL COMMENT 'route_change|pagehide|idle_timeout|closed|hidden_timeout',
  hidden_away_seconds INT       NOT NULL DEFAULT 0 COMMENT '会话内累计「页面不可见」秒数；不参与 active_seconds 口径',
  hidden_idle_seconds INT       NOT NULL DEFAULT 0 COMMENT '会话内累计「前台无操作」秒数；不参与 active_seconds 口径',
  hidden_since        DATETIME(3) DEFAULT NULL COMMENT '当前连续挂机段起点；回到 visible 时置 NULL',
  hidden_reason       VARCHAR(10) DEFAULT NULL COMMENT '当前挂机段原因 away|idle；回到 visible 时置 NULL',
  platform_class    VARCHAR(20)  DEFAULT NULL COMMENT 'ipad|iphone|android_tablet|android_phone|mac|windows|linux|other（服务端解析 UA）',
  browser           VARCHAR(20)  DEFAULT NULL COMMENT 'chrome|safari|edge|firefox|electron|other（服务端解析 UA）',
  screen_class      VARCHAR(20)  DEFAULT NULL COMMENT 'ipad_landscape|desktop|tablet_portrait|mobile（前端上报）',
  input_type        VARCHAR(10)  DEFAULT NULL COMMENT 'touch|mouse|hybrid（前端上报）',
  app_shell         VARCHAR(10)  DEFAULT NULL COMMENT 'web|electron（前端上报）',
  created_at        DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at        DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  UNIQUE KEY uniq_ss_uid (session_uid),
  KEY idx_ss_student_time   (student_id, started_at),
  KEY idx_ss_student_module (student_id, module, started_at),
  KEY idx_ss_open           (status, last_heartbeat_at),
  KEY idx_ss_platform_time  (platform_class, started_at),
  CONSTRAINT fk_ss_student_id FOREIGN KEY (student_id) REFERENCES students (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ============================================================
-- 17. 专项练习日志（2026-09-22，埋点 Phase 1B）
-- ============================================================
-- 语文三专项 + 英语背单词的判题流水。独立子系统：只挂 student_id 一个外键，
-- ref_id 故意不设外键（内容表全量重灌会被入向外键卡死）。
-- 迁移：tools/db/migrations/2026-09-22_special_practice_logs_and_goals.sql

CREATE TABLE IF NOT EXISTS special_practice_logs (
  id             BIGINT AUTO_INCREMENT PRIMARY KEY,
  student_id     BIGINT       NOT NULL,
  module         VARCHAR(32)  NOT NULL COMMENT 'chinese_dictation|chinese_interpretation|chinese_meaning|en_vocabulary',
  subject_id     BIGINT       DEFAULT NULL,
  ref_type       VARCHAR(24)  NOT NULL COMMENT 'passage|word',
  ref_id         BIGINT       DEFAULT NULL COMMENT 'passage_id / word_id；**故意不设外键**（同 student_word_progress.word_id）',
  ref_key        VARCHAR(128) DEFAULT NULL COMMENT '篇目标题 / 词面快照，便于排查与无 id 场景',
  sentence_index SMALLINT     DEFAULT NULL COMMENT '解释/含义专项逐句；默写/背词为 NULL',
  verdict        VARCHAR(20)  NOT NULL COMMENT 'correct|incorrect|off_target|unanswered|undetermined',
  is_correct     TINYINT(1)   DEFAULT NULL COMMENT 'correct=1 / incorrect=0 / 其它 NULL（沿用「空答案不计对错」）',
  error_counted  TINYINT(1)   NOT NULL DEFAULT 0 COMMENT '必须复用 normalize-english.util 的 progressDelta 判决',
  session_uid    CHAR(36)     DEFAULT NULL,
  created_at     DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  KEY idx_spl_student_module_time (student_id, module, created_at),
  KEY idx_spl_student_ref         (student_id, module, ref_id),
  KEY idx_spl_time                (created_at),
  CONSTRAINT fk_spl_student_id FOREIGN KEY (student_id) REFERENCES students (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ============================================================
-- 18. 课时完成事件（2026-09-20，P6.5 目标设定补齐）
-- ============================================================
-- 「每周完课目标」的唯一数据源。此前 progress 表只有游标（current_lesson_id，覆盖式更新、
-- 无历史），回答不了「本周完成了几课」。**历史完课补不回来**，达成值从本表上线起算。
-- lesson_id 故意不设外键（lessons 是内容表、会全量重灌）。
-- 迁移：tools/db/migrations/2026-09-20_goals_per_subject_and_lesson_completions.sql

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

SET FOREIGN_KEY_CHECKS = 1;
