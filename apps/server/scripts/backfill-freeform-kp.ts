/**
 * 一次性补标：给已入库但没有知识点的 freeform 题补 KP。
 *
 * 运行：cd apps/server && npx tsx scripts/backfill-freeform-kp.ts
 * 约束：一条命令跑完（无 dry-run 前置）；已挂 KP 的题跳过；单题失败只记日志。
 */
import * as dotenv from 'dotenv';
import { createPool } from 'mysql2/promise';
import { FreeformTagCapability } from '../src/ai-core/capabilities/freeform-tag.capability.js';

dotenv.config({ path: new URL('../.env', import.meta.url).pathname });

const pool = createPool({
  host: process.env.DB_HOST,
  port: Number(process.env.DB_PORT ?? 3306),
  user: process.env.DB_USER,
  password: process.env.DB_PASS,
  database: process.env.DB_NAME,
  connectionLimit: 2,
});

const tagger = new FreeformTagCapability();
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const [rows] = await pool.query<any[]>(
    `SELECT q.id, q.subject_id, q.content, s.name AS subject_name
       FROM questions q
       JOIN subjects s ON s.id = q.subject_id
      WHERE q.source = 'freeform' AND q.is_active = 1 AND q.answer <> ''
        AND NOT EXISTS (SELECT 1 FROM question_knowledge_points qkp WHERE qkp.question_id = q.id)
      ORDER BY q.id`,
  );
  const [kps] = await pool.query<any[]>('SELECT id, subject_id, name FROM knowledge_points');
  const kpBySubject = new Map<number, Array<{ id: number; name: string }>>();
  for (const k of kps) {
    const list = kpBySubject.get(Number(k.subject_id)) ?? [];
    list.push({ id: Number(k.id), name: k.name });
    kpBySubject.set(Number(k.subject_id), list);
  }

  let tagged = 0;
  let failed = 0;
  for (const q of rows) {
    const subjectId = Number(q.subject_id);
    const options = kpBySubject.get(subjectId) ?? [];
    if (options.length === 0) continue;

    const run = async () =>
      tagger.tag({
        question: q.content,
        subjectId,
        subjectName: q.subject_name ?? '数学',
        gradeBand: 'junior',
        knowledgePointOptions: options,
      });
    let result = await run().catch(() => null);
    if (!result) result = await run().catch(() => null); // 重试 1 次
    if (!result || result.knowledgePointIds.length === 0) {
      failed += 1;
      console.warn(`[backfill] question=${q.id} 未标注出知识点`);
      continue;
    }
    for (const [i, kpId] of result.knowledgePointIds.entries()) {
      await pool.execute(
        `INSERT IGNORE INTO question_knowledge_points (question_id, knowledge_point_id, role) VALUES (?, ?, ?)`,
        [q.id, kpId, i === 0 ? 'primary' : 'secondary'],
      );
    }
    tagged += 1;
    await sleep(300);
  }

  console.log(`[backfill] scanned=${rows.length} tagged=${tagged} failed=${failed}`);
  await pool.end();
}

main().catch((err) => {
  console.error('[backfill] failed:', err);
  process.exitCode = 1;
  pool.end().catch(() => {});
});
