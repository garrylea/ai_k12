-- 手写识别转写路由（语文专项手写输入，2026-10-08）：幂等，依赖 llm_models 已有 model_key='local' 行。
INSERT INTO llm_routes (scene, subject, primary_model_key, fallback_model_key)
SELECT 'handwriting', 'chinese', 'local', 'qwen3.8-max'
WHERE NOT EXISTS (
  SELECT 1 FROM llm_routes WHERE scene = 'handwriting' AND subject = 'chinese'
);
