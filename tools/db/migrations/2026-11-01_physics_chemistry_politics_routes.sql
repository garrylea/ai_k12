-- 物理/化学/道法 AI 路由（2026-11-01）：物化道各自成档（此前共用 math 档位）。
-- 幂等；依赖 llm_models 已有 model_key IN ('local','qwen3.8-max','deepseek-flash','kimi')。
--
-- 选址口径（用户 2026-11-01 裁决）：物化跟数学（理科快模型），道法跟语文（文科 kimi）。
--   judgment    : 物化道一律 local -> qwen3.8-max（同数学；本地不可用回退 reasoner）
--   grading     : 物化 deepseek-flash -> qwen3.8-max（同数学）；道法 kimi -> qwen3.8-max（同语文）
--   explanation : 物化 qwen3.8-max -> deepseek-flash（同数学）；道法 kimi -> qwen3.8-max（同语文）
--
-- 注意：本迁移只补数据。代码侧 Subject 类型与 subjectCodeOf 映射、运营页学科下拉
-- 同批改动（见 apps/server/src/common/subject-config.ts 与 apps/web/src/pages/admin/AdminModelsPage.tsx）。

INSERT INTO llm_routes (scene, subject, primary_model_key, fallback_model_key)
SELECT 'judgment', 'physics', 'local', 'qwen3.8-max'
WHERE NOT EXISTS (SELECT 1 FROM llm_routes WHERE scene = 'judgment' AND subject = 'physics');

INSERT INTO llm_routes (scene, subject, primary_model_key, fallback_model_key)
SELECT 'judgment', 'chemistry', 'local', 'qwen3.8-max'
WHERE NOT EXISTS (SELECT 1 FROM llm_routes WHERE scene = 'judgment' AND subject = 'chemistry');

INSERT INTO llm_routes (scene, subject, primary_model_key, fallback_model_key)
SELECT 'judgment', 'politics', 'local', 'qwen3.8-max'
WHERE NOT EXISTS (SELECT 1 FROM llm_routes WHERE scene = 'judgment' AND subject = 'politics');

INSERT INTO llm_routes (scene, subject, primary_model_key, fallback_model_key)
SELECT 'grading', 'physics', 'deepseek-flash', 'qwen3.8-max'
WHERE NOT EXISTS (SELECT 1 FROM llm_routes WHERE scene = 'grading' AND subject = 'physics');

INSERT INTO llm_routes (scene, subject, primary_model_key, fallback_model_key)
SELECT 'grading', 'chemistry', 'deepseek-flash', 'qwen3.8-max'
WHERE NOT EXISTS (SELECT 1 FROM llm_routes WHERE scene = 'grading' AND subject = 'chemistry');

INSERT INTO llm_routes (scene, subject, primary_model_key, fallback_model_key)
SELECT 'grading', 'politics', 'kimi', 'qwen3.8-max'
WHERE NOT EXISTS (SELECT 1 FROM llm_routes WHERE scene = 'grading' AND subject = 'politics');

INSERT INTO llm_routes (scene, subject, primary_model_key, fallback_model_key)
SELECT 'explanation', 'physics', 'qwen3.8-max', 'deepseek-flash'
WHERE NOT EXISTS (SELECT 1 FROM llm_routes WHERE scene = 'explanation' AND subject = 'physics');

INSERT INTO llm_routes (scene, subject, primary_model_key, fallback_model_key)
SELECT 'explanation', 'chemistry', 'qwen3.8-max', 'deepseek-flash'
WHERE NOT EXISTS (SELECT 1 FROM llm_routes WHERE scene = 'explanation' AND subject = 'chemistry');

INSERT INTO llm_routes (scene, subject, primary_model_key, fallback_model_key)
SELECT 'explanation', 'politics', 'kimi', 'qwen3.8-max'
WHERE NOT EXISTS (SELECT 1 FROM llm_routes WHERE scene = 'explanation' AND subject = 'politics');

-- hint（训练轨提示）：三科一律 deepseek-flash -> qwen3.8-max（同数学的轻量启发档）。
INSERT INTO llm_routes (scene, subject, primary_model_key, fallback_model_key)
SELECT 'hint', 'physics', 'deepseek-flash', 'qwen3.8-max'
WHERE NOT EXISTS (SELECT 1 FROM llm_routes WHERE scene = 'hint' AND subject = 'physics');

INSERT INTO llm_routes (scene, subject, primary_model_key, fallback_model_key)
SELECT 'hint', 'chemistry', 'deepseek-flash', 'qwen3.8-max'
WHERE NOT EXISTS (SELECT 1 FROM llm_routes WHERE scene = 'hint' AND subject = 'chemistry');

INSERT INTO llm_routes (scene, subject, primary_model_key, fallback_model_key)
SELECT 'hint', 'politics', 'deepseek-flash', 'qwen3.8-max'
WHERE NOT EXISTS (SELECT 1 FROM llm_routes WHERE scene = 'hint' AND subject = 'politics');
