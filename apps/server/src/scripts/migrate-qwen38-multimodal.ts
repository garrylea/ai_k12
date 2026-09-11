/**
 * 把已 seed 的库迁到 qwen3.8-max + 去 VL/两阶段配置：
 *   1) upsert qwen3.8-max 模型行（必须先于路由改名：primary FK 指向 llm_models.model_key）
 *   2) 路由 qwen3.7-max -> qwen3.8-max（primary + fallback）
 *   3) judgment/math 路由设为 local / qwen3.8-max
 *   4) 删 transcribe 路由
 *   5) 删旧模型行 qwen3.7-max / qwen3-vl-plus / qwen-vl-max（在 1-4 之后，确保无 primary 引用）
 *   6) 重置 ai_dialogues 遗留 flow 状态（best-effort，列结构不动）
 *
 * 运行：cd apps/server && npx tsx src/scripts/migrate-qwen38-multimodal.ts
 * 生效：重启后端，或在后台保存一次路由触发 registry.reload()。幂等，可重复运行。
 */
import * as dotenv from 'dotenv';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import mysql from 'mysql2/promise';
import { routeConfig } from '../ai-core/config.js';
import { encryptApiKey } from '../common/utils/api-key-crypto.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: join(__dirname, '../../.env') });

const OLD_QWEN = 'qwen3.7-max';
const NEW_QWEN = 'qwen3.8-max';
const DROP_MODELS = [OLD_QWEN, 'qwen3-vl-plus', 'qwen-vl-max'];

async function main() {
  const model = routeConfig.models[NEW_QWEN];
  const judgment = routeConfig.routes.judgment?.find((r) => r.subject === 'math');
  if (!model) throw new Error(`YAML 缺少 models.${NEW_QWEN}`);
  if (!judgment) throw new Error('YAML 缺少 routes.judgment（subject=math）');
  if (!model.baseUrl) throw new Error('QWEN_BASE_URL 未配置（检查 apps/server/.env）');
  if (!model.apiKey) throw new Error('QWEN_API_KEY 未配置（检查 apps/server/.env）');

  const pool = mysql.createPool({
    host: process.env.DB_HOST ?? 'localhost',
    port: Number(process.env.DB_PORT ?? 3306),
    user: process.env.DB_USER ?? 'ai_k12',
    password: process.env.DB_PASS ?? 'ai_k12',
    database: process.env.DB_NAME ?? 'ai_k12',
  });

  // 1) upsert 新模型
  const [mRows] = await pool.execute<mysql.RowDataPacket[]>(
    'SELECT id FROM llm_models WHERE model_key = ?', [NEW_QWEN]);
  const encryptedKey = encryptApiKey(model.apiKey);
  if (mRows.length > 0) {
    await pool.execute(
      `UPDATE llm_models SET name=?, provider_type=?, model_id=?, base_url=?, api_key=?,
         context_window=?, max_output_tokens=?, is_enabled=1, updated_at=CURRENT_TIMESTAMP(3)
       WHERE model_key=?`,
      [NEW_QWEN, model.provider, model.modelId, model.baseUrl, encryptedKey,
       model.contextWindow, model.maxOutputTokens, NEW_QWEN]);
    console.log(`[migrate-qwen38] 模型 ${NEW_QWEN} 已更新`);
  } else {
    await pool.execute(
      `INSERT INTO llm_models
         (model_key, name, provider_type, model_id, base_url, api_key, context_window, max_output_tokens, is_enabled)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1)`,
      [NEW_QWEN, NEW_QWEN, model.provider, model.modelId, model.baseUrl, encryptedKey,
       model.contextWindow, model.maxOutputTokens]);
    console.log(`[migrate-qwen38] 模型 ${NEW_QWEN} 已插入`);
  }

  // 2) 路由改名
  const [p] = await pool.execute(
    'UPDATE llm_routes SET primary_model_key=?, updated_at=CURRENT_TIMESTAMP(3) WHERE primary_model_key=?',
    [NEW_QWEN, OLD_QWEN]);
  const [f] = await pool.execute(
    'UPDATE llm_routes SET fallback_model_key=?, updated_at=CURRENT_TIMESTAMP(3) WHERE fallback_model_key=?',
    [NEW_QWEN, OLD_QWEN]);
  console.log(`[migrate-qwen38] 路由改名：primary ${(p as mysql.ResultSetHeader).affectedRows} 行 / fallback ${(f as mysql.ResultSetHeader).affectedRows} 行`);

  // 3) 判题路由
  const [j] = await pool.execute(
    `UPDATE llm_routes SET primary_model_key=?, fallback_model_key=?, updated_at=CURRENT_TIMESTAMP(3)
     WHERE scene='judgment' AND subject='math'`,
    [judgment.primary, judgment.fallback ?? null]);
  console.log(`[migrate-qwen38] 判题路由：${(j as mysql.ResultSetHeader).affectedRows} 行 -> ${judgment.primary} / ${judgment.fallback ?? '-'}`);

  // 4) 删 transcribe 路由
  const [t] = await pool.execute("DELETE FROM llm_routes WHERE scene='transcribe'");
  console.log(`[migrate-qwen38] 删除 transcribe 路由：${(t as mysql.ResultSetHeader).affectedRows} 行`);

  // 5) 删旧模型行
  const [d] = await pool.execute(
    `DELETE FROM llm_models WHERE model_key IN (?, ?, ?)`, DROP_MODELS);
  console.log(`[migrate-qwen38] 删除旧模型行：${(d as mysql.ResultSetHeader).affectedRows} 行（${DROP_MODELS.join(', ')}）`);

  // 6) 重置遗留 flow 状态
  const [r] = await pool.execute(
    `UPDATE ai_dialogues SET flow_state='idle', pending_question=NULL, pending_questions=NULL
     WHERE flow_state IS NOT NULL AND flow_state <> 'idle'`);
  console.log(`[migrate-qwen38] 重置遗留 flow 状态：${(r as mysql.ResultSetHeader).affectedRows} 行`);

  console.log('[migrate-qwen38] 完成。重启后端（或后台保存路由）后生效。');
  await pool.end();
}

main().catch((e) => { console.error('[migrate-qwen38] 失败:', e); process.exit(1); });
