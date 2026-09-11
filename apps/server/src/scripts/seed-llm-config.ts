/**
 * 把 model-routes.yaml 的 models/routes 幂等导入 llm_models/llm_routes（apiKey 加密落库）。
 *
 * YAML 的 difficulty 细分规则合并：同 scene+subject 只保留第一条（DB 不存难度维度）。
 * 如 tutoring/math 有 difficulty [1,2] 与 [3] 两条，循环里第二条被 EXISTS 跳过，
 * 保留第一条（qwen3.8-max 主路由），符合"DB 不存难度"的合并决策。
 *
 * 路由降级：若某条路由的 primary 模型未成功 seed（如 .env 缺 LOCAL_LLM_* 导致 local
 * 未配置），但 fallback 已 seed，则该路由以 fallback 顶上当 primary 落库并打 warning，
 * 避免整条路由缺失后 ModelRouter 静默落到全局 default（慢模型）；两者都未配置才跳过。
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
import { resolveSeedRoute, type SeedRouteRule } from './llm-route-seed.util.js';

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

  // 已成功落库的 model_key 集合（含此前已存在行），路由导入时只允许引用这些模型。
  const seededModelKeys = new Set<string>();
  let importedModels = 0;
  let skippedModels = 0;
  for (const [key, m] of Object.entries(routeConfig.models)) {
    const [exists] = await pool.execute<mysql.RowDataPacket[]>(
      'SELECT id FROM llm_models WHERE model_key = ?', [key]);
    if (exists.length > 0) {
      seededModelKeys.add(key);
      continue;
    }
    // 未配置的模型（缺 baseUrl 或 apiKey）不导入：环境变量未填时 YAML 插值会得到 null/空，
    // 插入 NOT NULL 列会失败，且空凭据的模型没有任何用处。
    if (!m.baseUrl || !m.apiKey) {
      console.log(`[seed] 跳过未配置的模型 ${key}（缺少 baseUrl 或 apiKey）`);
      skippedModels += 1;
      continue;
    }
    await pool.execute(
      `INSERT INTO llm_models (model_key, name, provider_type, model_id, base_url, api_key, context_window, max_output_tokens)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [key, key, m.provider, m.modelId, m.baseUrl, encryptApiKey(m.apiKey),
       m.contextWindow ?? 131072, m.maxOutputTokens ?? 16384]);
    seededModelKeys.add(key);
    importedModels += 1;
    console.log(`[seed] 模型 ${key} 已导入`);
  }

  let importedRoutes = 0;
  for (const [scene, rules] of Object.entries(routeConfig.routes)) {
    for (const r of rules) {
      const [exists] = await pool.execute<mysql.RowDataPacket[]>(
        'SELECT id FROM llm_routes WHERE scene = ? AND subject = ?', [scene, r.subject]);
      if (exists.length > 0) continue; // 同 scene+subject 第二条（difficulty 细分）在此合并跳过
      const resolved = resolveSeedRoute(r as SeedRouteRule, seededModelKeys);
      if (resolved.skipped) {
        console.warn(`[seed] 路由 ${scene}/${r.subject} 跳过：主模型 ${r.primary} 与备用 ${r.fallback ?? '-'} 均未配置`);
        continue;
      }
      if (resolved.degraded) {
        console.warn(`[seed] 路由 ${scene}/${r.subject} 降级：主模型 ${r.primary} 未配置，改用备用模型 ${resolved.primary}`);
      } else if (r.fallback && !resolved.fallback) {
        console.warn(`[seed] 路由 ${scene}/${r.subject} 备用模型 ${r.fallback} 未配置，落库时置空`);
      }
      await pool.execute(
        'INSERT INTO llm_routes (scene, subject, primary_model_key, fallback_model_key) VALUES (?, ?, ?, ?)',
        [scene, r.subject, resolved.primary, resolved.fallback]);
      importedRoutes += 1;
      console.log(`[seed] 路由 ${scene}/${r.subject} -> ${resolved.primary} 已导入`);
    }
  }
  console.log(`[seed] 完成：模型 +${importedModels}（跳过 ${skippedModels} 个未配置），路由 +${importedRoutes}（已存在的跳过）`);
  await pool.end();
}

main().catch((e) => { console.error('[seed] 失败:', e); process.exit(1); });
