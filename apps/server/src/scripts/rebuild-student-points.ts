/**
 * 从流水重算 `student_points` 快照（手工修复用）。
 *
 * 存在理由：`student_points` 只是**读优化的快照**（家长端多孩子列表、学生端每次进页面都要读，
 * SUM 全表流水不划算），`point_ledger` 才是积分的**唯一真源**——段位与余额都应由流水算。
 * 快照与流水一旦不一致（历史事故、人工误改、绕过事务的写入），正确做法是从流水**重算覆盖**，
 * 而不是猜哪个数字对、手编 `student_points` 的行。
 *
 * 重算口径（与 `PointLedgerRepository` 对重建脚本的承诺一致）：
 *   totalEarned = SUM(points) WHERE kind = 'earn'   —— 段位依据，单调递增
 *   balance     = SUM(points) 全部 kind              —— earn 正 + redeem 负
 *
 * **只读流水、绝不写流水**：本脚本只 SELECT `point_ledger`，唯一写的是
 * `StudentPointsRepository.overwrite`（对 `student_points` 做整行覆盖，不做增量）。
 *
 * 运行：cd apps/server && npx tsx src/scripts/rebuild-student-points.ts
 * 幂等：重跑结果不变（纯重算）。逐学生打印「前 → 后」供人眼核对漂移。
 */
import 'dotenv/config';
import mysql from 'mysql2/promise';
import { PointLedgerRepository } from '../database/repositories/point-ledger.repo.js';
import { StudentPointsRepository } from '../database/repositories/student-points.repo.js';

async function main() {
  const pool = mysql.createPool({
    host: process.env.DB_HOST ?? 'localhost',
    port: parseInt(process.env.DB_PORT ?? '3306', 10),
    user: process.env.DB_USER ?? 'ai_k12',
    password: process.env.DB_PASS ?? 'ai_k12',
    database: process.env.DB_NAME ?? 'ai_k12',
    charset: 'utf8mb4',
  });

  const ledgerRepo = new PointLedgerRepository(pool as never);
  const pointsRepo = new StudentPointsRepository(pool as never);

  // 只遍历「流水中出现过」的学生：快照行不该存在于流水之外（新学生第一次发分才建行）。
  const [rows] = await pool.query<mysql.RowDataPacket[]>(
    'SELECT DISTINCT student_id FROM point_ledger ORDER BY student_id',
  );
  console.log(`[rebuild-student-points] 流水中出现 ${rows.length} 名学生`);

  let drifted = 0;
  for (const row of rows) {
    const studentId = Number(row.student_id);
    const before = await pointsRepo.find(studentId);
    const totalEarned = await ledgerRepo.sumEarned(studentId);
    const balance = await ledgerRepo.sumAll(studentId);

    await pointsRepo.overwrite(studentId, totalEarned, balance);

    const changed = before.totalEarned !== totalEarned || before.balance !== balance;
    if (changed) drifted += 1;
    console.log(
      `  student #${studentId}: totalEarned ${before.totalEarned} -> ${totalEarned}, `
      + `balance ${before.balance} -> ${balance}${changed ? '  [已修正]' : ''}`,
    );
  }

  console.log(`[rebuild-student-points] 完成：重算 ${rows.length} 名，快照漂移 ${drifted} 名`);
  await pool.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
