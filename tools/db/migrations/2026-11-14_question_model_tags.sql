-- 2026-11-14：数学题中考模型标签（两级：大类 + 具体模型）。
-- 纯新增；幂等，可重复 apply。设计见
-- docs/superpowers/specs/2026-11-14-math-model-tags-design.md §5.1。
--
-- 为什么独立于 knowledge_points：判题后 MasteryService 会对题目关联的所有
-- 知识点 upsert 掌握度；把「倍长中线」等模型挂进知识点树会污染掌握度与
-- 薄弱点图谱。模型还跨知识点（倍长中线同时涉及三角形/全等/中位线）。

CREATE TABLE IF NOT EXISTS question_model_tags (
  id            BIGINT AUTO_INCREMENT PRIMARY KEY,
  question_id   BIGINT       NOT NULL,
  category      VARCHAR(32)  NOT NULL COMMENT '大类代码，见 §4.1',
  category_name VARCHAR(32)  NOT NULL COMMENT '大类中文名（冗余，供读侧直接展示）',
  model         VARCHAR(64)  NOT NULL DEFAULT '' COMMENT '模型代码；无二级时为空串',
  model_name    VARCHAR(64)  NOT NULL DEFAULT '' COMMENT '模型中文名',
  confidence    DECIMAL(3,2) NOT NULL DEFAULT 0.00 COMMENT '0-1，LLM 自评，仅用于排序抽检',
  reason        VARCHAR(255) NOT NULL DEFAULT '' COMMENT '一句话依据，供抽检',
  source        VARCHAR(16)  NOT NULL DEFAULT 'llm' COMMENT 'llm|manual',
  created_at    DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at    DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  UNIQUE KEY uniq_qmt_question_cat_model (question_id, category, model),
  KEY idx_qmt_category_model (category, model, confidence),
  KEY idx_qmt_confidence (confidence),
  CONSTRAINT fk_qmt_question FOREIGN KEY (question_id) REFERENCES questions (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
