import { Injectable, Inject } from '@nestjs/common';
import type { Pool, ResultSetHeader, RowDataPacket } from 'mysql2/promise';

/** 四个专项模块（与 `special_practice_logs.module` 的列注释逐字一致）。 */
export type SpecialPracticeModule =
  | 'chinese_dictation'
  | 'chinese_interpretation'
  | 'chinese_meaning'
  | 'en_vocabulary';

/**
 * 统一 verdict 字典（与 `special_practice_logs.verdict` 的列注释一致）。
 *
 * ⚠️ 英语那边原始枚举里叫 `wrong`，**入库前映射成 `incorrect`**（见 Task 4）：
 * 这一列是跨专项的统一字典，不该出现 `wrong` 这个同义词。
 */
export type SpecialPracticeVerdict =
  | 'correct'
  | 'incorrect'
  | 'off_target'
  | 'unanswered'
  | 'undetermined';

export interface SpecialPracticeLogInsert {
  studentId: number;
  module: SpecialPracticeModule;
  refType: 'passage' | 'word';
  /** passage_id / word_id；无 id 场景可为 null（故列上不设外键）。 */
  refId: number | null;
  /** 篇目标题 / 词面快照，便于排查。 */
  refKey: string | null;
  /** 解释/含义专项逐句；默写/背词为 null。 */
  sentenceIndex: number | null;
  verdict: SpecialPracticeVerdict;
  /** correct → true / incorrect → false / 其它 → null（沿用「空答案不计对错」）。 */
  isCorrect: boolean | null;
  errorCounted: boolean;
  sessionUid: string | null;
}

/**
 * 专项练习日志：**唯一写入口** + 三个聚合读（埋点 Phase 1B）。
 *
 * 独立子系统：只挂 `student_id` 一个外键。**不挂 `questions`、不进错题本、不参与清零门禁**。
 */
@Injectable()
export class SpecialPracticeLogsRepository {
  constructor(@Inject('DATABASE_POOL') private readonly pool: Pool) {}

  /** 写一行。返回自增 id（调用方只用于日志，不落业务字段）。 */
  async insert(row: SpecialPracticeLogInsert): Promise<number> {
    // subject_id 恒传 null：专项内容表本身没有学科维度，学科可由 module 前缀推出（chinese_* / en_vocabulary）。
    // 若将来要按学科过滤，正确做法是按 module 白名单筛，而不是回填这一列。
    const [result] = await this.pool.execute<ResultSetHeader>(
      `INSERT INTO special_practice_logs
       (student_id, module, subject_id, ref_type, ref_id, ref_key, sentence_index, verdict, is_correct, error_counted, session_uid)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        row.studentId,
        row.module,
        null,
        row.refType,
        row.refId,
        row.refKey,
        row.sentenceIndex,
        row.verdict,
        row.isCorrect === null ? null : row.isCorrect ? 1 : 0,
        row.errorCounted ? 1 : 0,
        row.sessionUid,
      ],
    );
    return result.insertId;
  }

  /**
   * 按 module 聚合「单位数 / 有明确对错数 / 正确数」。
   *
   * `units = COUNT(*)`：每个专项**一行就是一个作答单位**（默写=一篇、解释/含义=一句、背单词=一道题）。
   * `answered = SUM(is_correct IS NOT NULL)`：与家长端既有正确率口径一致，**排除**没有明确对错的行。
   * `rate` 不在这里算——service 层用 `toRate(answered, correct)`（注意签名是 (answered, correct)）。
   */
  async aggregateByModule(
    studentId: number,
    from: Date,
    toExclusive: Date,
  ): Promise<
    Array<{ module: SpecialPracticeModule; units: number; answered: number; correct: number }>
  > {
    const [rows] = await this.pool.execute<
      (RowDataPacket & {
        module: SpecialPracticeModule;
        units: number | string | null;
        answered: number | string | null;
        correct: number | string | null;
      })[]
    >(
      `SELECT module,
              COUNT(*)                    AS units,
              SUM(is_correct IS NOT NULL) AS answered,
              SUM(is_correct = 1)         AS correct
       FROM special_practice_logs
       WHERE student_id = ? AND created_at >= ? AND created_at < ?
       GROUP BY module
       ORDER BY module`,
      [studentId, from, toExclusive],
    );
    return rows.map((r) => ({
      module: r.module,
      units: Number(r.units ?? 0),
      answered: Number(r.answered ?? 0),
      correct: Number(r.correct ?? 0),
    }));
  }

  /**
   * 按 module + 日期分组的单位数（喂家长端柱状图）。
   *
   * 日期在 SQL 里用 `DATE_FORMAT(created_at, '%Y-%m-%d')` 切——与 `parent-analytics.repo.ts`
   * 的 byDay 完全同一写法（同机同库，DB 会话时区与 Node 一致，故和「应用层算窗口」不冲突）。
   * **窗口边界仍然由应用层算好传参**，不用 `CURDATE()`。
   */
  async countByDayByModule(
    studentId: number,
    from: Date,
    toExclusive: Date,
  ): Promise<Array<{ module: SpecialPracticeModule; day: string; count: number }>> {
    const [rows] = await this.pool.execute<
      (RowDataPacket & { module: SpecialPracticeModule; day: string; count: number | string | null })[]
    >(
      `SELECT module,
              DATE_FORMAT(created_at, '%Y-%m-%d') AS day,
              COUNT(*)                            AS count
       FROM special_practice_logs
       WHERE student_id = ? AND created_at >= ? AND created_at < ?
       GROUP BY module, day
       ORDER BY day`,
      [studentId, from, toExclusive],
    );
    return rows.map((r) => ({ module: r.module, day: r.day, count: Number(r.count ?? 0) }));
  }

  /**
   * 窗口内**答对过的去重词数**，即 `/specials` 里 vocabulary 的 `newWords`。
   *
   * 口径说明（写进注释是为了别被「新词」二字带偏）：它是「本期答对过的不同单词数」，
   * 不是「本期第一次学会的词数」——后者需要跨窗口历史，`special_practice_logs` 单窗口查不出来。
   */
  async countDistinctCorrectWords(
    studentId: number,
    from: Date,
    toExclusive: Date,
  ): Promise<number> {
    const [rows] = await this.pool.execute<(RowDataPacket & { words: number | string | null })[]>(
      `SELECT COUNT(DISTINCT ref_id) AS words
       FROM special_practice_logs
       WHERE student_id = ? AND module = 'en_vocabulary' AND verdict = 'correct'
         AND ref_id IS NOT NULL AND created_at >= ? AND created_at < ?`,
      [studentId, from, toExclusive],
    );
    return Number(rows[0]?.words ?? 0);
  }

  /**
   * 窗口内**答过的去重篇目数**，即目标 `weekly_passages` 的达成值（2026-09-22 用户裁决）。
   *
   * 为什么必须去重而不是 COUNT(*)：本表**一行 = 一个作答单位**——默写一篇一行，
   * 解释/含义却是**一句一行**。直接数行数会把「8 句」当成「8 篇」汇报给家长。
   * 三个语文专项合并统计：孩子只要在任一个专项里碰过这篇，就算「本周学过这篇」。
   */
  async countDistinctPassages(
    studentId: number,
    from: Date,
    toExclusive: Date,
  ): Promise<number> {
    const [rows] = await this.pool.execute<(RowDataPacket & { passages: number | string | null })[]>(
      `SELECT COUNT(DISTINCT ref_id) AS passages
       FROM special_practice_logs
       WHERE student_id = ?
         AND module IN ('chinese_dictation', 'chinese_interpretation', 'chinese_meaning')
         AND ref_id IS NOT NULL
         AND created_at >= ? AND created_at < ?`,
      [studentId, from, toExclusive],
    );
    return Number(rows[0]?.passages ?? 0);
  }
}
