import { Injectable, Inject } from '@nestjs/common';
import type { Pool, RowDataPacket } from 'mysql2/promise';
import type { VocabularyVerdict } from '../../common/utils/normalize-english.util.js';

export interface StudentWordProgressRow extends RowDataPacket {
  id: number;
  student_id: number;
  word_id: number;
  learned: number;
  wrong_count: number;
  last_result: string | null;
  last_seen_at: Date | null;
}

export interface RecordWordResultInput {
  studentId: number;
  wordId: number;
  /** 由 `progressDelta(verdict)` 给出，仓储层不含记账规则 */
  learned: 0 | 1;
  wrongDelta: 0 | 1;
  lastResult: VocabularyVerdict;
}

/**
 * 学生背词进度 repo（轻量，不做艾宾浩斯排程）。
 *
 * 存在的唯一目的是让四个筛选项与「今日已背 N/15」成立——没有它，「每天背 10-20 个」
 * 就是每天在 1600 词里重抽：会的词反复碰到，不会的词未必抽得到。
 *
 * `word_id` 上**故意不设外键**（见 schema 注释）：内容表必须能被内容管线随时全量重灌，
 * 入向外键会让 full-reload 的业务数据守卫与重灌互相卡死。
 */
@Injectable()
export class StudentWordProgressRepository {
  constructor(@Inject('DATABASE_POOL') private readonly pool: Pool) {}

  async findByStudentAndWord(
    studentId: number,
    wordId: number,
  ): Promise<StudentWordProgressRow | null> {
    const [rows] = await this.pool.execute<StudentWordProgressRow[]>(
      `SELECT id, student_id, word_id, learned, wrong_count, last_result, last_seen_at
       FROM student_word_progress
       WHERE student_id = ? AND word_id = ?
       LIMIT 1`,
      [studentId, wordId],
    );
    return rows[0] ?? null;
  }

  /**
   * 落一次答题结果（幂等 upsert，业务键 `(student_id, word_id)`）。
   *
   * 两个累加器都是**单调**的，这就是它不需要读改写的全部原因：
   *   `learned`     = GREATEST(旧值, 新值) —— 答对过就永远是 1，之后答错也不回退
   *   `wrong_count` = 旧值 + 增量        —— 只增；学生「移除易错标记」是另一条独立 UPDATE
   * 增量由 `progressDelta(verdict)` 算好传进来（off_target / unanswered / undetermined 都是 0），
   * 所以本方法**不判断结论**，只做算术——记账规则只有一处。
   *
   * 用行别名（`AS new`）而非已弃用的 `VALUES()`：MySQL 8.0.20 起后者会打弃用告警。
   */
  async recordResult(input: RecordWordResultInput): Promise<void> {
    await this.pool.execute(
      `INSERT INTO student_word_progress
         (student_id, word_id, learned, wrong_count, last_result, last_seen_at)
       VALUES (?, ?, ?, ?, ?, NOW(3)) AS new
       ON DUPLICATE KEY UPDATE
         learned = GREATEST(student_word_progress.learned, new.learned),
         wrong_count = student_word_progress.wrong_count + new.wrong_count,
         last_result = new.last_result,
         last_seen_at = new.last_seen_at`,
      [input.studentId, input.wordId, input.learned, input.wrongDelta, input.lastResult],
    );
  }

  /**
   * 「移除易错标记」：只把该学生该词的 `wrong_count` 清零。
   *
   * 刻意不动 `learned`（背过就是背过），也刻意不动 `english_words.error_count`
   * （那是全平台的统计，不该被单个学生抹掉）。没有进度行时影响行数为 0，是正常的空操作。
   */
  async clearWrongCount(studentId: number, wordId: number): Promise<void> {
    await this.pool.execute(
      `UPDATE student_word_progress SET wrong_count = 0
       WHERE student_id = ? AND word_id = ?`,
      [studentId, wordId],
    );
  }

  /**
   * 今日已背词数。`since` 由服务层用**服务器本地时区**算出当日 00:00 后传入，
   * 刻意不在 SQL 里用 `CURDATE()`——DB 会话时区与应用时区不一致时会算错一天。
   * 「见过就算」：答错/不认识/判题失败也算背过（它们都更新 last_seen_at）。
   */
  async countSeenSince(studentId: number, since: Date): Promise<number> {
    const [rows] = await this.pool.execute<(RowDataPacket & { count: number })[]>(
      `SELECT COUNT(*) AS count FROM student_word_progress
       WHERE student_id = ? AND last_seen_at >= ?`,
      [studentId, since],
    );
    return Number(rows[0]?.count ?? 0);
  }
}
