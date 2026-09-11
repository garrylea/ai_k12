/**
 * 把判题主模型切到本地 llama.cpp（读 YAML models.local + routes.judgment），
 * 幂等 upsert 进 llm_models / llm_routes。已 seed 的库靠本脚本更新
 * （seed-llm-config.ts 是 skip-if-exists，不会更新既有行）。
 *
 * 运行：cd apps/server && npx tsx src/scripts/set-judging-local.ts
 * 生效：脚本不改内存 registry —— 重启后端，或后台保存一次路由触发 reload。
 */
import * as dotenv from 'dotenv';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import mysql from 'mysql2/promise';
import { routeConfig } from '../ai-core/config.js';
import { encryptApiKey } from '../common/utils/api-key-crypto.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: join(__dirname, '../../.env') });

async function main() {
  const model = routeConfig.models.local;
  const rule = routeConfig.routes.judgment?.find((r) => r.subject === 'math');

  if (!model) throw new Error('YAML 缺少 models.local');
  if (!rule) throw new Error('YAML 缺少 routes.judgment（subject=math）');
  if (!model.baseUrl) throw new Error('LOCAL_LLM_BASE_URL 未配置（检查 apps/server/.env）');
  if (!model.apiKey) throw new Error('LOCAL_LLM_API_KEY 未配置（检查 apps/server/.env）');

  const pool = mysql.createPool({
    host: process.env.DB_HOST ?? 'localhost',
    port: Number(process.env.DB_PORT ?? 3306),
    user: process.env.DB_USER ?? 'ai_k12',
    password: process.env.DB_PASS ?? 'ai_k12',
    database: process.env.DB_NAME ?? 'ai_k12',
  });

  // 1) llm_models upsert（FK 要求 primary_model_key 先存在）
  const [modelRows] = await pool.execute<mysql.RowDataPacket[]>(
    'SELECT id FROM llm_models WHERE model_key = ?', ['local']);
  const encryptedKey = encryptApiKey(model.apiKey);
  if (modelRows.length > 0) {
    await pool.execute(
      `UPDATE llm_models
         SET name = ?, provider_type = ?, model_id = ?, base_url = ?, api_key = ?,
             context_window = ?, max_output_tokens = ?, is_enabled = 1,
             updated_at = CURRENT_TIMESTAMP(3)
       WHERE model_key = ?`,
      [model.modelId, model.provider, model.modelId, model.baseUrl, encryptedKey,
       model.contextWindow, model.maxOutputTokens, 'local']);
    console.log('[judging-local] 模型 local 已更新');
  } else {
    await pool.execute(
      `INSERT INTO llm_models
         (model_key, name, provider_type, model_id, base_url, api_key, context_window, max_output_tokens, is_enabled)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1)`,
      ['local', model.modelId, model.provider, model.modelId, model.baseUrl, encryptedKey,
       model.contextWindow, model.maxOutputTokens]);
    console.log('[judging-local] 模型 local 已插入');
  }

  // 2) llm_routes upsert
  const [routeRows] = await pool.execute<mysql.RowDataPacket[]>(
    'SELECT id FROM llm_routes WHERE scene = ? AND subject = ?', ['judgment', 'math']);
  if (routeRows.length > 0) {
    await pool.execute(
      `UPDATE llm_routes
         SET primary_model_key = ?, fallback_model_key = ?, updated_at = CURRENT_TIMESTAMP(3)
       WHERE scene = ? AND subject = ?`,
      [rule.primary, rule.fallback ?? null, 'judgment', 'math']);
    console.log(`[judging-local] 路由 judgment/math 已更新 -> ${rule.primary} / ${rule.fallback ?? '-'}`);
  } else {
    await pool.execute(
      'INSERT INTO llm_routes (scene, subject, primary_model_key, fallback_model_key) VALUES (?, ?, ?, ?)',
      ['judgment', 'math', rule.primary, rule.fallback ?? null]);
    console.log(`[judging-local] 路由 judgment/math 已插入 -> ${rule.primary} / ${rule.fallback ?? '-'}`);
  }

  console.log('[judging-local] 完成。重启后端（或后台保存路由）后生效。');
  await pool.end();
}

main().catch((e) => { console.error('[judging-local] 失败:', e); process.exit(1); });
