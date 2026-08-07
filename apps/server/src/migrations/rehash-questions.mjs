// 一次性迁移：用 NFKC 归一重算 questions.content_hash，对齐 refinery db_loader.py::normalize_content。
//
// 背景：apps/server/src/modules/error-book/content-hash.util.ts 此前去标点 + 手写全角数字转换，
// 与 refinery（NFKC + 去空白 + lower，不删标点）不一致，导致跨源（管线入库 vs aux 错题本入库）
// 同一题 content_hash 不同，findByContentHash 漏判。本脚本把存量 questions.content_hash 重算为 NFKC 口径。
//
// 运行：node apps/server/src/migrations/rehash-questions.mjs
//   （需 .env 中 DB_HOST/DB_USER/DB_PASSWORD/DB_NAME；可用 dotenv-cli 或提前 source）
//
// 注意：本脚本内联 NFKC 归一逻辑，与 content-hash.util.ts::normalizeForHash 对齐。
// 若 util 侧归一逻辑再变更，需同步本脚本。自包含为纯 .mjs，零依赖 TypeScript，直接 node 可跑。
import mysql from 'mysql2/promise';
import { createHash } from 'node:crypto';

/** 对齐 apps/server/src/modules/error-book/content-hash.util.ts::normalizeForHash
 *  与 tools/data-refinery/src/db_loader.py::normalize_content：
 *  NFKC 全半角归一 + 去所有空白 + 转小写（不删标点）。 */
function normalizeForHash(content) {
  return content
    .normalize('NFKC')
    .replace(/\s+/g, '')
    .toLowerCase();
}

function computeContentHash(content) {
  return createHash('sha256').update(normalizeForHash(content)).digest('hex');
}

const pool = mysql.createPool({
  host: process.env.DB_HOST,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
});

try {
  const [rows] = await pool.query(
    'SELECT id, content FROM questions WHERE content_hash IS NOT NULL',
  );
  let changed = 0;
  for (const r of rows) {
    const h = computeContentHash(r.content);
    if (h !== r.content_hash) {
      await pool.query('UPDATE questions SET content_hash = ? WHERE id = ?', [
        h,
        r.id,
      ]);
      changed += 1;
    }
  }
  console.log(
    `rehashed ${changed}/${rows.length} questions (NFKC alignment; skipped ${rows.length - changed} already-aligned)`,
  );
} finally {
  await pool.end();
}
