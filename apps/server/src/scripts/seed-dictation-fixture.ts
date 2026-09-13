/**
 * 【开发假数据】语文默写链路验证种子。
 *
 * 警告：这里的数据**不是生产题库**，仅为打通「训练 → 语文 → 专项 → 默写」链路。
 * 生产篇目由内容管线（爬 smartedu 教材 + 逐篇校验）导入，见
 * docs/superpowers/specs/2026-09-13-chinese-dictation-special-design.md §6。
 * 两条记录以 source_ref = 'DEV-FIXTURE' 标记，便于后续清理。
 *
 * 幂等：questions 走 content_hash 去重，dictation_passages 走 (work_title, semester) upsert。
 * 运行：npx tsx src/scripts/seed-dictation-fixture.ts
 */
import 'dotenv/config';
import mysql from 'mysql2/promise';
import { computeContentHash } from '../common/utils/content-hash.util.js';
import { DictationPassagesRepository } from '../database/repositories/dictation-passages.repo.js';

const CHINESE_SUBJECT_ID = 2;

const FIXTURES = [
  {
    workTitle: '静夜思',
    author: '李白',
    dynasty: '唐',
    body: '床前明月光，疑是地上霜。举头望明月，低头思故乡。',
    semester: '上册',
    sortOrder: 9001,
  },
  {
    workTitle: '登鹳雀楼',
    author: '王之涣',
    dynasty: '唐',
    body: '白日依山尽，黄河入海流。欲穷千里目，更上一层楼。',
    semester: '上册',
    sortOrder: 9002,
  },
];

/**
 * 守卫：本脚本的幂等性完全依赖 uniq_q_content_hash（ON DUPLICATE KEY UPDATE 要有东西可冲突）。
 * 老库可能因为 CREATE TABLE IF NOT EXISTS 的语义缺这个键——那时 INSERT 会静默插重复行。
 * 故启动时先断言它存在，缺了直接报错退出，而不是安静地产生脏数据。
 */
async function assertContentHashUniqueIndex(pool: mysql.Pool): Promise<void> {
  const [rows] = await pool.execute<any[]>(
    `SELECT COUNT(*) AS c FROM information_schema.STATISTICS
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'questions'
       AND COLUMN_NAME = 'content_hash' AND NON_UNIQUE = 0`,
  );
  if (Number(rows[0]?.c ?? 0) === 0) {
    throw new Error(
      'questions.content_hash 缺少唯一索引 uniq_q_content_hash——' +
      '本脚本的幂等依赖它，继续跑会插重复行。' +
      '请先执行 tools/db/migrations/2026-09-13_ensure_uniq_q_content_hash.sql。',
    );
  }
}

async function main() {
  const pool = mysql.createPool({
    host: process.env.DB_HOST ?? 'localhost',
    user: process.env.DB_USER ?? 'ai_k12',
    password: process.env.DB_PASS ?? 'ai_k12',
    database: process.env.DB_NAME ?? 'ai_k12',
  });
  await assertContentHashUniqueIndex(pool);
  const repo = new DictationPassagesRepository(pool as never);

  for (const f of FIXTURES) {
    const content = `请默写《${f.workTitle}》（并写出作者与朝代）`;
    const answer = `作者：${f.author}\n朝代：${f.dynasty}\n正文：${f.body}`;
    const hash = computeContentHash(content);

    await pool.execute(
      `INSERT INTO questions
         (subject_id, type, difficulty, content, answer, grade_band, source, content_hash, answer_verified, is_active)
       VALUES (?, 'poem_dictation', 2, ?, ?, 'junior', 'DEV-FIXTURE', ?, 0, 1)
       ON DUPLICATE KEY UPDATE
         answer = VALUES(answer), source = VALUES(source), is_active = 1`,
      [CHINESE_SUBJECT_ID, content, answer, hash],
    );
    const [rows] = await pool.execute<any[]>(
      'SELECT id FROM questions WHERE content_hash = ? LIMIT 1',
      [hash],
    );
    const questionId = rows[0].id as number;

    await repo.upsert({
      questionId,
      workTitle: f.workTitle,
      author: f.author,
      dynasty: f.dynasty,
      body: f.body,
      gradeBand: 'junior',
      grade: '九年级',
      semester: f.semester,
      sortOrder: f.sortOrder,
      sourceRef: 'DEV-FIXTURE',
      verified: 1,
    });
    console.log(`seeded questionId=${questionId} 《${f.workTitle}》`);
  }

  await pool.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
