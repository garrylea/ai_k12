/**
 * seed：首个管理员账号 + 历史学生占位家长。
 *
 * - 管理员：读 .env 的 ADMIN_INITIAL_USERNAME / ADMIN_INITIAL_PASSWORD（缺省 admin/admin123，
 *   仅开发便利；生产必须显式设置）。已存在同名管理员则跳过（幂等）。
 * - 占位家长：确保 id=1 的 parent 存在（phone='legacy'），接管 auth 旧实现挂在
 *   parent_id=1 下的存量学生。已存在则不动。
 *
 * 运行：cd apps/server && npx tsx src/scripts/seed-admin.ts   （幂等可重复跑）
 */
import * as dotenv from 'dotenv';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import mysql from 'mysql2/promise';
import * as bcrypt from 'bcrypt';

const __dirname = dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: join(__dirname, '../../../.env') });

async function main() {
  const pool = mysql.createPool({
    host: process.env.DB_HOST ?? 'localhost',
    port: Number(process.env.DB_PORT ?? 3306),
    user: process.env.DB_USER ?? 'ai_k12',
    password: process.env.DB_PASS ?? 'ai_k12',
    database: process.env.DB_NAME ?? 'ai_k12',
  });

  // 1) 管理员
  const username = process.env.ADMIN_INITIAL_USERNAME || 'admin';
  const password = process.env.ADMIN_INITIAL_PASSWORD || 'admin123';
  // 空字符串视为未设置：空密码会建出无法登录且无处改密的管理员，直接报错退出。
  if (!password || password.length < 6) {
    console.error('[seed] ADMIN_INITIAL_PASSWORD 未设置或长度 <6。生产必须显式设置（开发缺省 admin123 仅限本机）。');
    process.exit(1);
  }
  const [adminRows] = await pool.execute<mysql.RowDataPacket[]>(
    'SELECT id FROM admins WHERE username = ? AND deleted_at IS NULL',
    [username],
  );
  if (adminRows.length > 0) {
    console.log(`[seed] 管理员 "${username}" 已存在(id=${adminRows[0].id})，跳过`);
  } else {
    const hash = await bcrypt.hash(password, 10);
    await pool.execute(
      'INSERT INTO admins (username, password_hash, name) VALUES (?, ?, ?)',
      [username, hash, '超级管理员'],
    );
    console.log(`[seed] 管理员 "${username}" 已创建（初始密码来自 .env，请尽快修改）`);
  }

  // 2) 占位家长（id=1）
  const [parentRows] = await pool.execute<mysql.RowDataPacket[]>(
    'SELECT id FROM parents WHERE id = 1',
  );
  if (parentRows.length > 0) {
    console.log('[seed] parent id=1 已存在，跳过');
  } else {
    const hash = await bcrypt.hash('legacy-placeholder', 10);
    await pool.execute(
      "INSERT INTO parents (id, phone, password_hash, name) VALUES (1, 'legacy', ?, '历史学生托管账号')",
      [hash],
    );
    console.log('[seed] 占位家长 id=1 已创建（phone=legacy，密码为随机串不可登录）');
  }

  await pool.end();
}

main().catch((err) => {
  console.error('[seed] 失败:', err);
  process.exit(1);
});
