/**
 * 【开发假数据】语文默写链路验证种子。
 *
 * 警告：这里的数据**不是生产题库**，仅为打通「训练 → 语文 → 专项 → 默写」链路。
 * 生产篇目由内容管线（爬 smartedu 教材 + 逐篇校验）导入，见
 * docs/superpowers/specs/2026-09-13-chinese-dictation-special-design.md §6。
 * 真篇目入库时 memorizeRequired=0（内容对的未必要求背），待用户标定必背后才进抽题池；
 * 本脚本的假数据则直接置 memorizeRequired=1，好让专项在标定前仍有题可练。
 * 两条记录以 source_ref = 'DEV-FIXTURE' 标记，便于后续清理。
 *
 * 2026-09-15 独立化：**不再写 questions 行**——古诗文专项已是独立子系统
 * （不挂 questions、不进错题本，PRD §6.3 / §7.4），表 chinese_passages 就是全部。
 *
 * 幂等：走 (work_title, semester) 业务键 upsert。
 * 运行：npx tsx src/scripts/seed-dictation-fixture.ts
 */
import 'dotenv/config';
import mysql from 'mysql2/promise';
import { ChinesePassagesRepository } from '../database/repositories/chinese-passages.repo.js';

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

async function main() {
  const pool = mysql.createPool({
    host: process.env.DB_HOST ?? 'localhost',
    user: process.env.DB_USER ?? 'ai_k12',
    password: process.env.DB_PASS ?? 'ai_k12',
    database: process.env.DB_NAME ?? 'ai_k12',
  });
  const repo = new ChinesePassagesRepository(pool as never);

  for (const f of FIXTURES) {
    // 安全阀：若该篇目已属真实内容（内容管线导入的），绝不覆盖——本脚本只碰自己的假数据。
    const [existing] = await pool.execute<any[]>(
      `SELECT id, source_ref FROM chinese_passages
        WHERE work_title = ? AND semester = ? LIMIT 1`,
      [f.workTitle, f.semester],
    );
    if (existing.length > 0 && existing[0].source_ref !== 'DEV-FIXTURE') {
      console.warn(
        `[seed-dictation-fixture] 跳过《${f.workTitle}》：该篇目已存在且 source_ref=${existing[0].source_ref}，非开发假数据`,
      );
      continue;
    }

    await repo.upsert({
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
      // 假数据置「必背」：否则抽题池（verified AND memorize_required）会空掉，
      // 管线落地到真篇目标定必背之前，专项将无可练之题。
      memorizeRequired: 1,
    });
    console.log(`seeded 《${f.workTitle}》（${f.semester}）`);
  }

  await pool.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
