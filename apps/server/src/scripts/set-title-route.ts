/**
 * 会话标题生成路由：`title` 场景 = 本地模型优先、deepseek-v4-flash 兜底。
 * 读 YAML routes.title，幂等 upsert 进 llm_routes。已 seed 的库靠本脚本补路由
 * （seed-llm-config.ts 是 skip-if-exists，不会更新既有行）。
 *
 * 运行：cd apps/server && npx tsx src/scripts/set-title-route.ts
 * 生效：脚本不改内存 registry —— 重启后端，或后台保存一次路由触发 reload。
 */
import * as dotenv from 'dotenv';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import mysql from 'mysql2/promise';
import { routeConfig } from '../ai-core/config.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: join(__dirname, '../../.env') });

async function main() {
  const rule = routeConfig.routes.title?.find((r) => r.subject === '*') ?? routeConfig.routes.title?.[0];
  if (!rule) throw new Error('YAML 缺少 routes.title');

  const pool = mysql.createPool({
    host: process.env.DB_HOST ?? 'localhost',
    port: Number(process.env.DB_PORT ?? 3306),
    user: process.env.DB_USER ?? 'ai_k12',
    password: process.env.DB_PASS ?? 'ai_k12',
    database: process.env.DB_NAME ?? 'ai_k12',
  });

  // 主模型缺失时（如未 seed local）降级为 fallback 顶上，避免 FK 失败。
  const [rows] = await pool.execute<mysql.RowDataPacket[]>(
    'SELECT model_key FROM llm_models WHERE is_enabled = 1 AND model_key IN (?, ?)',
    [rule.primary, rule.fallback ?? ''],
  );
  const present = new Set(rows.map((r) => r.model_key));
  let primary = rule.primary;
  let fallback: string | null = rule.fallback ?? null;
  if (!present.has(primary)) {
    if (fallback && present.has(fallback)) {
      console.warn(`[title-route] 主模型 ${primary} 不在库中，降级用 ${fallback} 作 primary`);
      primary = fallback;
      fallback = null;
    } else {
      throw new Error(`[title-route] 主模型 ${primary} 与 fallback 都不在库中，先 seed 模型`);
    }
  }

  const [routeRows] = await pool.execute<mysql.RowDataPacket[]>(
    'SELECT id FROM llm_routes WHERE scene = ? AND subject = ?', ['title', '*']);
  if (routeRows.length > 0) {
    await pool.execute(
      `UPDATE llm_routes
         SET primary_model_key = ?, fallback_model_key = ?, updated_at = CURRENT_TIMESTAMP(3)
       WHERE scene = ? AND subject = ?`,
      [primary, fallback, 'title', '*']);
    console.log(`[title-route] 路由 title/* 已更新 -> ${primary} / ${fallback ?? '-'}`);
  } else {
    await pool.execute(
      'INSERT INTO llm_routes (scene, subject, primary_model_key, fallback_model_key) VALUES (?, ?, ?, ?)',
      ['title', '*', primary, fallback]);
    console.log(`[title-route] 路由 title/* 已插入 -> ${primary} / ${fallback ?? '-'}`);
  }

  console.log('[title-route] 完成。重启后端（或后台保存路由）后生效。');
  await pool.end();
}

main().catch((e) => { console.error('[title-route] 失败:', e); process.exit(1); });
