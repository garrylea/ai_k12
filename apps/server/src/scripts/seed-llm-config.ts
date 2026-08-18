/**
 * 把 model-routes.yaml 的 models/routes 幂等导入 llm_models/llm_routes（apiKey 加密落库）。
 *
 * YAML 的 difficulty 细分规则合并：同 scene+subject 只保留第一条（DB 不存难度维度）。
 * 如 tutoring/math 有 difficulty [1,2] 与 [3] 两条，循环里第二条被 EXISTS 跳过，
 * 保留第一条（qwen3.7-max 主路由），符合"DB 不存难度"的合并决策。
 *
 * 运行：cd apps/server && npx tsx src/scripts/seed-llm-config.ts
 * 幂等：按 model_key / (scene,subject) EXISTS 跳过已存在行，重复运行安全。
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
  const pool = mysql.createPool({
    host: process.env.DB_HOST ?? 'localhost',
    port: Number(process.env.DB_PORT ?? 3306),
    user: process.env.DB_USER ?? 'ai_k12',
    password: process.env.DB_PASS ?? 'ai_k12',
    database: process.env.DB_NAME ?? 'ai_k12',
  });

  let importedModels = 0;
  for (const [key, m] of Object.entries(routeConfig.models)) {
    const [exists] = await pool.execute<mysql.RowDataPacket[]>(
      'SELECT id FROM llm_models WHERE model_key = ?', [key]);
    if (exists.length > 0) continue;
    await pool.execute(
      `INSERT INTO llm_models (model_key, name, provider_type, model_id, base_url, api_key, context_window, max_output_tokens)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [key, key, m.provider, m.modelId, m.baseUrl, encryptApiKey(m.apiKey ?? ''),
       m.contextWindow ?? 131072, m.maxOutputTokens ?? 16384]);
    importedModels += 1;
    console.log(`[seed] 模型 ${key} 已导入`);
  }

  const modelKeys = new Set(Object.keys(routeConfig.models));
  let importedRoutes = 0;
  for (const [scene, rules] of Object.entries(routeConfig.routes)) {
    for (const r of rules) {
      const [exists] = await pool.execute<mysql.RowDataPacket[]>(
        'SELECT id FROM llm_routes WHERE scene = ? AND subject = ?', [scene, r.subject]);
      if (exists.length > 0) continue; // 同 scene+subject 第二条（difficulty 细分）在此合并跳过
      if (!modelKeys.has(r.primary) || (r.fallback && !modelKeys.has(r.fallback))) continue;
      await pool.execute(
        'INSERT INTO llm_routes (scene, subject, primary_model_key, fallback_model_key) VALUES (?, ?, ?, ?)',
        [scene, r.subject, r.primary, r.fallback ?? null]);
      importedRoutes += 1;
      console.log(`[seed] 路由 ${scene}/${r.subject} -> ${r.primary} 已导入`);
    }
  }
  console.log(`[seed] 完成：模型 +${importedModels}，路由 +${importedRoutes}（已存在的跳过）`);
  await pool.end();
}

main().catch((e) => { console.error('[seed] 失败:', e); process.exit(1); });
