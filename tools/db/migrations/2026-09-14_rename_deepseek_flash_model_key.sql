-- 2026-09-14 DeepSeek 模型改名：llm_models.model_key / llm_routes 引用
-- 「deepseek-v4-flash」->「deepseek-flash」。
--
-- 背景：DeepSeek 官方端点现已只认两个模型名（实测 /v1/chat/completions）：
--   deepseek-flash、deepseek-v4-pro —— 传其它名字直接 400：
--   "The supported API model names are deepseek-flash, deepseek-v4-pro"。
--   deepseek-v4-flash 目前仍是能解析的旧别名（响应 model 字段已回落成
--   deepseek-flash），但既然已不在支持列表里，就不再依赖它。
--
-- 为什么不能直接 UPDATE model_key：llm_routes.primary_model_key 对
-- llm_models.model_key 有外键（fk_llm_routes_primary），且 UPDATE_RULE = NO ACTION，
-- 改主表会因「子表仍引用旧值」直接失败。故采用「先建新行 -> 改引用 -> 删旧行」。
-- （fallback_model_key 没有外键，但同样要改，否则路由指向不存在的 key。）
--
-- 幂等：旧 key 不存在时全部为 no-op；重复执行安全。
-- 本迁移只修存量库。全新安装由 seed-llm-config.ts 从 model-routes.yaml
-- （模型块已改名）直接 seed 出 deepseek-flash。

-- ① 建新行：复制旧行的全部连接参数（含 api_key 密文，同 provider 原样搬），
--    model_id 一并对齐成新名。旧行不存在、或新行已存在时不建。
SET @old_exists := (SELECT COUNT(*) FROM llm_models WHERE model_key = 'deepseek-v4-flash');
SET @new_exists := (SELECT COUNT(*) FROM llm_models WHERE model_key = 'deepseek-flash');

SET @ddl := IF(
  @old_exists > 0 AND @new_exists = 0,
  'INSERT INTO llm_models
     (model_key, name, provider_type, model_id, base_url, api_key,
      context_window, max_output_tokens, is_enabled)
   SELECT ''deepseek-flash'', ''deepseek-flash'', provider_type, ''deepseek-flash'', base_url, api_key,
          context_window, max_output_tokens, is_enabled
   FROM llm_models WHERE model_key = ''deepseek-v4-flash''',
  'SELECT 1'
);
PREPARE stmt FROM @ddl;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

-- ② 改引用：先 fallback（无外键，顺序无关，但先改它更直观），再 primary。
UPDATE llm_routes SET fallback_model_key = 'deepseek-flash'
  WHERE fallback_model_key = 'deepseek-v4-flash';
UPDATE llm_routes SET primary_model_key = 'deepseek-flash'
  WHERE primary_model_key = 'deepseek-v4-flash';

-- ③ 删旧行：仅当替代行确已在库、且再无任何路由引用旧 key 时才删
--   （@new_exists 是 ① 之前的快照，这里重新取一次，避免 ① 被跳过时误删）。
SET @new_ready := (SELECT COUNT(*) FROM llm_models WHERE model_key = 'deepseek-flash');
SET @still_ref := (
  SELECT COUNT(*) FROM llm_routes
  WHERE primary_model_key = 'deepseek-v4-flash' OR fallback_model_key = 'deepseek-v4-flash'
);

SET @ddl := IF(
  @old_exists > 0 AND @new_ready > 0 AND @still_ref = 0,
  'DELETE FROM llm_models WHERE model_key = ''deepseek-v4-flash''',
  'SELECT 1'
);
PREPARE stmt FROM @ddl;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

-- 自检：应只剩 deepseek-flash，且无路由再指向旧 key。
SELECT model_key, provider_type, model_id, is_enabled FROM llm_models ORDER BY model_key;
SELECT COUNT(*) AS routes_still_pointing_to_old_key FROM llm_routes
  WHERE primary_model_key = 'deepseek-v4-flash' OR fallback_model_key = 'deepseek-v4-flash';
