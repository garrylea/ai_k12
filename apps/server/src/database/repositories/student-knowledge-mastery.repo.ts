import { Injectable, Inject } from '@nestjs/common';
import type { Pool, RowDataPacket } from 'mysql2/promise';

export interface WeakMasteryRow {
  knowledgePointId: number;
  name: string;
  masteryScore: number;
  level: number;
  correctCount: number;
  errorCount: number;
  lastSeenAt: Date | null;
}

/**
 * 知识点掌握度：**唯一写入口** + 家长端两个读（埋点 Phase 1B）。
 *
 * 这张表在 1B 之前是**死表**（全仓唯一命中是一句注释），本批由 `MasteryService` 在判题出口回写。
 * 写侧只碰 `student_knowledge_mastery`；`question_knowledge_points` 的读取在 `questions.repo.ts`。
 */
@Injectable()
export class StudentKnowledgeMasteryRepository {
  constructor(@Inject('DATABASE_POOL') private readonly pool: Pool) {}

  /**
   * 判题后 UPSERT 一条（spec §4.8）。
   *
   * 用 `AS new` 别名而不是 `VALUES()`（后者在 MySQL 8.0.20+ 已废弃）。
   * 首次插入时 score/level 由**本次**的对错给出（答对 1.0/5、答错 0.0/0）。
   *
   * ⚠️ **两条易踩的坑，改动前必读（2026-09-22 实测）**
   *
   * 1. **赋值顺序有意义，且每个赋值看到的是「已更新」的列值。**
   *    MySQL 对 `ON DUPLICATE KEY UPDATE` 的 SET 子句**从左到右求值**，
   *    后面的表达式读到的是前面刚写进去的值（不是本行更新前的旧值）。
   *    所以 `correct_count` / `error_count` 必须写在前面，score/level 才能拿到「累计后的计数」。
   *
   * 2. **score/level 里绝不能再写 `+ new.correct_count`**：新增量会被算两遍。
   *    实测（1 对 + 1 错，本应 1/2 = 0.500）用
   *    `(correct_count + new.correct_count) / (correct_count + new.correct_count + error_count + new.error_count)`
   *    会得到 1/3 = **0.333**，且这个错值会被后续每次判题继续放大——掌握度是长期累计列，
   *    错了不会自愈。评测口径与家长端「真掌握度」卡都按这一列读，故必须只引用更新后的列。
   *
   *    分母 `NULLIF(..., 0)` 防除零（首插时分子分母都非零，防御的是极端历史数据）。
   */
  async upsertOnJudge(studentId: number, knowledgePointId: number, isCorrect: boolean): Promise<void> {
    const correctDelta = isCorrect ? 1 : 0;
    const errorDelta = isCorrect ? 0 : 1;
    const score = isCorrect ? 1 : 0;
    const level = isCorrect ? 5 : 0;
    await this.pool.execute(
      `INSERT INTO student_knowledge_mastery
         (student_id, knowledge_point_id, correct_count, error_count, mastery_score, level, last_seen_at)
       VALUES (?, ?, ?, ?, ?, ?, NOW(3)) AS new
       ON DUPLICATE KEY UPDATE
         correct_count = student_knowledge_mastery.correct_count + new.correct_count,
         error_count   = student_knowledge_mastery.error_count   + new.error_count,
         mastery_score = student_knowledge_mastery.correct_count
                       / NULLIF(student_knowledge_mastery.correct_count + student_knowledge_mastery.error_count, 0),
         level         = FLOOR(5 * (student_knowledge_mastery.correct_count
                       / NULLIF(student_knowledge_mastery.correct_count + student_knowledge_mastery.error_count, 0))),
         last_seen_at  = NOW(3)`,
      [studentId, knowledgePointId, correctDelta, errorDelta, score, level],
    );
  }

  /** 最弱的 N 个知识点（家长端 `/mastery`）；`limit` 由 service 夹在 1..50。 */
  async listWeakest(studentId: number, limit: number): Promise<WeakMasteryRow[]> {
    // LIMIT ? 必须用 pool.query（客户端转义），execute 会被 MySQL 拒绝——既有约定
    const [rows] = await this.pool.query<
      (RowDataPacket & {
        knowledge_point_id: number; name: string; mastery_score: number | string | null;
        level: number; correct_count: number | string | null; error_count: number | string | null;
        last_seen_at: Date | null;
      })[]
    >(
      `SELECT skm.knowledge_point_id, kp.name, skm.mastery_score, skm.level,
              skm.correct_count, skm.error_count, skm.last_seen_at
       FROM student_knowledge_mastery skm
       JOIN knowledge_points kp ON kp.id = skm.knowledge_point_id
       WHERE skm.student_id = ?
       ORDER BY mastery_score ASC, error_count DESC, skm.knowledge_point_id ASC
       LIMIT ?`,
      [studentId, limit],
    );
    return rows.map((r) => ({
      knowledgePointId: Number(r.knowledge_point_id),
      name: r.name,
      masteryScore: Number(r.mastery_score ?? 0),
      level: Number(r.level ?? 0),
      correctCount: Number(r.correct_count ?? 0),
      errorCount: Number(r.error_count ?? 0),
      lastSeenAt: r.last_seen_at,
    }));
  }

  /**
   * 题库的 KP 覆盖率（家长端必须展示，否则家长会以为「薄弱点只有这几个」）。
   * 实测基线：530 题里 203 题有 KP（38%）。
   */
  async countQuestionCoverage(): Promise<{ coveredQuestions: number; totalQuestions: number }> {
    const [rows] = await this.pool.execute<
      (RowDataPacket & { total: number | string | null; covered: number | string | null })[]
    >(
      `SELECT (SELECT COUNT(*) FROM questions)                          AS total,
              (SELECT COUNT(DISTINCT question_id) FROM question_knowledge_points) AS covered`,
    );
    return {
      coveredQuestions: Number(rows[0]?.covered ?? 0),
      totalQuestions: Number(rows[0]?.total ?? 0),
    };
  }
}
