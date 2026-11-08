/**
 * 做题入口（freeform）路由迁移：`freeform_split` / `freeform_judge` 两条 llm_routes。
 * 与 tools/db/migrations/2026-11-08_freeform_routes.sql 等价，供 CI / 管理端复用（不依赖 mysql 客户端）。
 * 幂等：路由走 ON DUPLICATE KEY UPDATE；索引先查 information_schema 再建。
 *
 * 运行：cd apps/server && npx tsx src/scripts/migrate-freeform-routes.ts
 * 生效：脚本不改内存 registry —— 重启后端（node dist/main.js）后路由生效。
 */
import * as dotenv from 'dotenv';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import mysql from 'mysql2/promise';

const __dirname = dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: join(__dirname, '../../.env') });

const ROUTES = [
  { scene: 'freeform_split', primary: 'local', fallback: 'qwen3.8-max' },
  { scene: 'freeform_judge', primary: 'qwen3.8-max', fallback: null },
] as const;

async function main() {
  const conn = await mysql.createConnection({
    host: process.env.DB_HOST ?? 'localhost',
    port: Number(process.env.DB_PORT ?? 3306),
    user: process.env.DB_USER ?? 'ai_k12',
    // 仓库内既有 .env 用 DB_PASS；兼容 DB_PASSWORD
    password: process.env.DB_PASSWORD ?? process.env.DB_PASS ?? '',
    database: process.env.DB_NAME ?? 'ai_k12',
  });

  try {
    await conn.execute(
      `INSERT INTO llm_routes (scene, subject, primary_model_key, fallback_model_key)
       VALUES
         ('freeform_split', '*', 'local', 'qwen3.8-max'),
         ('freeform_judge', '*', 'qwen3.8-max', NULL)
       ON DUPLICATE KEY UPDATE
         primary_model_key = VALUES(primary_model_key),
         fallback_model_key = VALUES(fallback_model_key)`,
    );
    for (const r of ROUTES) {
      console.log(`[freeform] 路由 ${r.scene}/* -> ${r.primary} / ${r.fallback ?? '-'}`);
    }

    const [rows] = await conn.execute<mysql.RowDataPacket[]>(
      `SELECT COUNT(*) AS n
         FROM information_schema.statistics
        WHERE table_schema = DATABASE()
          AND table_name = 'uploaded_files'
          AND index_name = 'idx_uf_uploader_url'`,
    );
    if (Number(rows[0]?.n ?? 0) === 0) {
      await conn.execute('ALTER TABLE uploaded_files ADD INDEX idx_uf_uploader_url (uploader_id, url)');
      console.log('[freeform] 索引 idx_uf_uploader_url 已创建');
    } else {
      console.log('[freeform] 索引 idx_uf_uploader_url 已存在，跳过');
    }

    console.log('[freeform] 完成。重启后端（node dist/main.js）后生效。');
  } finally {
    await conn.end();
  }
}

main().catch((e) => { console.error('[freeform] 迁移失败:', e); process.exit(1); });
