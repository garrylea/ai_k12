-- 2026-09-20 埋点 Phase 0：模型调用账本 + API 请求日志 + 模型单价列。
--
-- 背景（见 docs/superpowers/specs/2026-09-19-analytics-instrumentation-design.md §2.3）：
--   * `ai_messages` 的 model/token_input/token_output/response_time_ms 四列**生产恒写 NULL**；
--   * `ModelClient.chat()` 默认走流式，`aggregateStream()` 把 usage 硬编码成 {0,0,0}；
--   * `model-config-registry.ts:70` 把 costPer1K 写死 {input:0,output:0}；`llm_models` 根本没有价格列。
--   即「次数 / token / 钱」三样全算不出。本迁移只补**存储**；采集修复在代码侧。
--
-- 幂等：建表用 CREATE TABLE IF NOT EXISTS；ADD COLUMN 先查 information_schema 再 PREPARE
-- （沿用 2026-09-16_chinese_interpretation_columns.sql 的固定套路）。本文件**没有任何
-- DELETE/DROP**——2026-09-15 那次迁移因级联删题静默清空 50 行的教训见
-- docs/superpowers/plans/2026-09-15-chinese-passages-standalone.md Task 9。

-- ---- llm_models 单价列 ----
SET @has_col := (
  SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE()
    AND TABLE_NAME = 'llm_models'
    AND COLUMN_NAME = 'input_price_per_1k'
);
SET @ddl := IF(
  @has_col = 0,
  'ALTER TABLE llm_models ADD COLUMN input_price_per_1k DECIMAL(10,6) NOT NULL DEFAULT 0 COMMENT ''每 1K 输入 token 价，单位与 model-routes.yaml 的 costPer1K.input 一致'' AFTER max_output_tokens',
  'SELECT 1'
);
PREPARE stmt FROM @ddl;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

SET @has_col := (
  SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE()
    AND TABLE_NAME = 'llm_models'
    AND COLUMN_NAME = 'output_price_per_1k'
);
SET @ddl := IF(
  @has_col = 0,
  'ALTER TABLE llm_models ADD COLUMN output_price_per_1k DECIMAL(10,6) NOT NULL DEFAULT 0 COMMENT ''每 1K 输出 token 价，单位与 costPer1K.output 一致'' AFTER input_price_per_1k',
  'SELECT 1'
);
PREPARE stmt FROM @ddl;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

-- ---- llm_call_logs：每次 LLM 调用（含重试尝试、失败、超时、fallback）一行 ----
-- student_id 用 ON DELETE SET NULL（**有意**偏离仓库 CASCADE 约定）：账本是审计数据，
-- 学生被删后聚合量应保留、仅匿名化；列可空故 FK 合法。
-- cost / input_tokens / output_tokens 允许 NULL —— **NULL = 算不出，绝不是 0**；
-- 0 只代表「真免费」（本地模型）。与家长端 answered=0 → rate=null 同一纪律。
CREATE TABLE IF NOT EXISTS llm_call_logs (
  id                  BIGINT AUTO_INCREMENT PRIMARY KEY,
  request_id          VARCHAR(64)   DEFAULT NULL COMMENT '关联 api_request_logs.request_id',
  student_id          BIGINT        DEFAULT NULL COMMENT '有归属时必填；仅 admin-chat/探活/系统任务为 NULL',
  dialogue_id         BIGINT        DEFAULT NULL COMMENT '无外键：对话可删，账本不可',
  scene               VARCHAR(30)   NOT NULL,
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
  input_price_per_1k  DECIMAL(10,6) DEFAULT NULL COMMENT '价格快照，防改价后历史成本漂移',
  output_price_per_1k DECIMAL(10,6) DEFAULT NULL,
  cost                DECIMAL(12,6) DEFAULT NULL COMMENT 'NULL = 算不出，绝不写 0',
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
