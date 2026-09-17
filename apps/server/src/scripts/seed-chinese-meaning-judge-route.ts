/**
 * 语文古诗文含义专项判题路由：`chinese_meaning_judge` 场景 = 本地模型优先、deepseek-flash 兜底。
 * 读 YAML routes.chinese_meaning_judge，幂等写进 llm_routes（已 seed 的库靠本脚本补路由；
 * seed-llm-config.ts 是 skip-if-exists，不会更新既有行）。
 * 镜像 seed-interpretation-judge-route.ts。
 *
 * 运行：cd apps/server && npx tsx src/scripts/seed-chinese-meaning-judge-route.ts
 * 生效：脚本不改内存 registry —— 重启后端，或后台保存一次路由触发 reload。
 */
import * as dotenv from 'dotenv';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import mysql from 'mysql2/promise';
import { routeConfig } from '../ai-core/config.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: join(__dirname, '../../.env') });

const SCENE = 'chinese_meaning_judge';

async function main() {
  const rule = routeConfig.routes.chinese_meaning_judge?.find((r) => r.subject === '*')
    ?? routeConfig.routes.chinese_meaning_judge?.[0];
  if (!rule) throw new Error('YAML 缺少 routes.chinese_meaning_judge');

  const pool = mysql.createPool({
    host: process.env.DB_HOST ?? 'localhost',
    port: Number(process.env.DB_PORT ?? 3306),
    user: process.env.DB_USER ?? 'ai_k12',
    password: process.env.DB_PASS ?? 'ai_k12',
    database: process.env.DB_NAME ?? 'ai_k12',
  });

  // 主模型缺失时降级用 fallback 顶上，避免选到不存在的模型
  const [rows] = await pool.execute<mysql.RowDataPacket[]>(
    'SELECT model_key FROM llm_models WHERE is_enabled = 1 AND model_key IN (?, ?)',
    [rule.primary, rule.fallback ?? ''],
  );
  const present = new Set(rows.map((r) => r.model_key as string));
  let primary = rule.primary;
  let fallback: string | null = rule.fallback ?? null;
  if (!present.has(primary)) {
    if (fallback && present.has(fallback)) {
      console.warn(`[${SCENE}] 主模型 ${primary} 不在库中，降级用 ${fallback} 作 primary`);
      primary = fallback;
      fallback = null;
    } else {
      throw new Error(`[${SCENE}] 主模型 ${primary} 与 fallback 都不在库中，先 seed 模型`);
    }
  }

  const [routeRows] = await pool.execute<mysql.RowDataPacket[]>(
    'SELECT id FROM llm_routes WHERE scene = ? AND subject = ?', [SCENE, '*']);
  if (routeRows.length > 0) {
    await pool.execute(
      `UPDATE llm_routes
         SET primary_model_key = ?, fallback_model_key = ?, updated_at = CURRENT_TIMESTAMP(3)
       WHERE scene = ? AND subject = ?`,
      [primary, fallback, SCENE, '*']);
    console.log(`[${SCENE}] 路由 ${SCENE}/* 已更新 -> ${primary} / ${fallback ?? '-'}`);
  } else {
    await pool.execute(
      'INSERT INTO llm_routes (scene, subject, primary_model_key, fallback_model_key) VALUES (?, ?, ?, ?)',
      [SCENE, '*', primary, fallback]);
    console.log(`[${SCENE}] 路由 ${SCENE}/* 已插入 -> ${primary} / ${fallback ?? '-'}`);
  }

  console.log(`[${SCENE}] 完成。重启后端（或后台保存路由）后生效。`);
  await pool.end();
}

main().catch((e) => { console.error(`[${SCENE}] 失败:`, e); process.exit(1); });
