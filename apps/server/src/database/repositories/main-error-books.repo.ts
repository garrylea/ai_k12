import { Injectable, Inject } from '@nestjs/common';
import type { Pool, ResultSetHeader, RowDataPacket } from 'mysql2/promise';
import type { MainErrorBookRow } from './types.js';

@Injectable()
export class MainErrorBooksRepository {
  constructor(@Inject('DATABASE_POOL') private readonly pool: Pool) {}

  /**
   * 插入一条主线错题。level / is_cleared 走 DB 默认值（1 / 0）。
   * question_id 可为 null（题库无匹配、质量差仅存题面场景）。
   * question_n 为卡内复合题号（practice 来源由 judge 传入；discuss 等可传 null）。
   */
  async create(row: {
    student_id: number;
    subject_id: number;
    question_id: number | null;
    source: string;
    source_ref_id: number | null;
    question_n: string | null;
    lesson_id: number | null;
    wrong_answer_text: string | null;
  }): Promise<number> {
    const [result] = await this.pool.execute<ResultSetHeader>(
      `INSERT INTO main_error_books
       (student_id, subject_id, question_id, source, source_ref_id, question_n, lesson_id, wrong_answer_text)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [row.student_id, row.subject_id, row.question_id, row.source, row.source_ref_id, row.question_n, row.lesson_id, row.wrong_answer_text],
    );
    return result.insertId;
  }

  async findById(id: number): Promise<MainErrorBookRow | null> {
    const [rows] = await this.pool.execute<RowDataPacket[]>(
      `SELECT * FROM main_error_books WHERE id = ?`,
      [id],
    );
    return (rows[0] as MainErrorBookRow) ?? null;
  }

  async findByStudent(studentId: number, subjectId?: number, includeCleared = false): Promise<MainErrorBookRow[]> {
    const conditions = ['student_id = ?'];
    const params: any[] = [studentId];
    if (!includeCleared) {
      conditions.push('is_cleared = 0');
    }
    if (subjectId) {
      conditions.push('subject_id = ?');
      params.push(subjectId);
    }
    const [rows] = await this.pool.execute<RowDataPacket[]>(
      `SELECT * FROM main_error_books WHERE ${conditions.join(' AND ')} ORDER BY id DESC`,
      params,
    );
    return rows as MainErrorBookRow[];
  }

  /**
   * 幂等查找：该学生是否已有一条「未清除」的错题记录指向此题。
   * 命中条件（OR）：
   *   - question_id 非空且匹配（题库已入库的题）
   *   - question_id 为空但 source_ref_id(=cardId) + wrong_answer_text(=题面) 匹配
   *     （题库未入库、仅存题面的场景）
   * 用于「打开讨论即入错题本」的 find-or-create：命中则跳过插入，避免重复。
   */
  async findUnclearedByStudentQuestion(
    studentId: number,
    questionId: number | null,
    cardId: number,
    questionText: string,
  ): Promise<MainErrorBookRow | null> {
    const [rows] = await this.pool.execute<RowDataPacket[]>(
      `SELECT * FROM main_error_books
       WHERE student_id = ? AND is_cleared = 0 AND (
         (? IS NOT NULL AND question_id = ?) OR
         (question_id IS NULL AND source_ref_id = ? AND wrong_answer_text = ?)
       )
       LIMIT 1`,
      [studentId, questionId, questionId, cardId, questionText],
    );
    return (rows[0] as MainErrorBookRow) ?? null;
  }

  /** 题中心变体：只按 question_id 匹配（训练模块用，训练题必来自题库、question_id 恒非空）。 */
  async findUnclearedByStudentQuestionId(
    studentId: number,
    questionId: number,
  ): Promise<MainErrorBookRow | null> {
    const [rows] = await this.pool.execute<RowDataPacket[]>(
      `SELECT * FROM main_error_books
       WHERE student_id = ? AND is_cleared = 0 AND question_id = ?
       LIMIT 1`,
      [studentId, questionId],
    );
    return (rows[0] as MainErrorBookRow) ?? null;
  }

  /** 该学生此题是否已有错题本行（不限 source、含已清零）。用于幂等补写。 */
  async existsByStudentAndQuestionId(studentId: number, questionId: number): Promise<boolean> {
    const [rows] = await this.pool.execute<RowDataPacket[]>(
      `SELECT 1 FROM main_error_books WHERE student_id = ? AND question_id = ? LIMIT 1`,
      [studentId, questionId],
    );
    return rows.length > 0;
  }

  /**
   * 题中心变体清零：该学生此题所有未清行一次性 is_cleared=1（不限 source）。
   *
   * **返回 `affectedRows`**——积分体系据此判定「确实清掉了一条未清零的错题」：
   * `> 0` 才发 `error_fix` 分，首次就答对（本无未清行）为 `0`、不发分（spec §6.5）。
   * 返回值从 `void` 改为 `number` 对既有 `await` 调用方兼容（它们忽略返回值）。
   */
  async clearUnclearedByStudentQuestionId(studentId: number, questionId: number): Promise<number> {
    const [result] = await this.pool.execute<ResultSetHeader>(
      `UPDATE main_error_books SET is_cleared = 1, cleared_at = NOW(3)
       WHERE student_id = ? AND is_cleared = 0 AND question_id = ?`,
      [studentId, questionId],
    );
    return result.affectedRows;
  }

  async markCleared(id: number): Promise<void> {
    await this.pool.execute(
      `UPDATE main_error_books SET is_cleared = 1, cleared_at = NOW(3) WHERE id = ?`,
      [id],
    );
  }

  /**
   * 窗口内**清零**的错题数，即目标 `weekly_clear_errors` 的达成值（埋点 Phase 1B）。
   *
   * 口径：按 `cleared_at` 落在窗口内数（`is_cleared = 1 AND cleared_at IS NOT NULL`）。
   * 同一道题清了又被做错会**再新建一行**（`create`），所以这里数的是「清零动作次数」而不是
   * 「去重题数」——这正是家长要的「这周订正掉几道」。`cleared_at` 为 NULL 的历史行不计
   * （老数据 `is_cleared=1` 但没时间戳，无法判断属于哪一周，宁少不猜）。
   *
   * 窗口边界由**应用层**算好传参（半开区间），不用 `CURDATE()`——DB 会话时区与 Node 可能不一致。
   */
  async countClearedBetween(studentId: number, from: Date, toExclusive: Date): Promise<number> {
    const [rows] = await this.pool.execute<(RowDataPacket & { n: number | string | null })[]>(
      `SELECT COUNT(*) AS n
       FROM main_error_books
       WHERE student_id = ? AND is_cleared = 1 AND cleared_at IS NOT NULL
         AND cleared_at >= ? AND cleared_at < ?`,
      [studentId, from, toExclusive],
    );
    return Number(rows[0]?.n ?? 0);
  }

  /**
   * 答对清零（card+题面变体）：把该学生此题所有「未清」错题记录一次性 is_cleared=1
   * （兼容历史重复记录）。匹配条件镜像 findUnclearedByStudentQuestion
   * （question_id 或 题面+cardId），不限 source。
   *
   * **返回 `affectedRows`**——与题中心变体 `clearUnclearedByStudentQuestionId` 同义：
   * 积分体系据此判定「确实清掉了一条未清零的错题」，`> 0` 才发 `error_fix` 分
   * （spec §6.5）。返回值从 `void` 改为 `number` 对既有 `await` 调用方兼容。
   * best-effort：调用方（PracticeService / JudgeCoreService 答对路径）负责 try/catch。
   */
  async clearUnclearedByStudentQuestion(
    studentId: number,
    questionId: number | null,
    cardId: number,
    questionText: string,
  ): Promise<number> {
    const [result] = await this.pool.execute<ResultSetHeader>(
      `UPDATE main_error_books
       SET is_cleared = 1, cleared_at = NOW(3)
       WHERE student_id = ? AND is_cleared = 0 AND (
         (? IS NOT NULL AND question_id = ?) OR
         (question_id IS NULL AND source_ref_id = ? AND wrong_answer_text = ?)
       )`,
      [studentId, questionId, questionId, cardId, questionText],
    );
    return result.affectedRows;
  }

  async updateLevel(id: number, level: number): Promise<void> {
    await this.pool.execute(
      `UPDATE main_error_books SET level = ? WHERE id = ?`,
      [level, id],
    );
  }

  /**
   * B方案：把新建的 mainline 对话 id 回写到错题本记录。
   * 重开讨论时据此复用同一对话（跨刷新/跨设备续接），而非每次另起对话。
   */
  async updateDialogueId(id: number, dialogueId: number): Promise<void> {
    await this.pool.execute(
      `UPDATE main_error_books SET dialogue_id = ? WHERE id = ?`,
      [dialogueId, id],
    );
  }

  /**
   * 查询学生某学科所有未清零的课堂练习错题（source='practice' + is_cleared=0）。
   * LEFT JOIN questions 补全题面：question_id 非空取 questions.content，否则用 wrong_answer_text 兜底。
   * LEFT JOIN cards 补全卡片所属课的 lesson_id——清零阶段判题时必须写卡片真正所属的课，
   * 否则 practice_results.lesson_id 会记成「判题时所在课」，导致课程级重置（按 lesson_id 删）漏删。
   * 用于「错题清零」门禁。本查询不限课时（返回该学科全部未清 practice 错题），
   * 「只清当前课之前」的课时过滤由 PracticeService.getUnclearedErrorDetails 按
   * currentLessonId 后置过滤（lesson_id null 的孤儿行在 service 层保留）。
   *
   * @param textbookVersionId 可选：按当前教材版本过滤（cards→lessons→units→semesters 链路）。
   *   家长切换教材版本后，旧版错题保留在库但不再出现在清零门禁/列表中。为 null 时不过滤（无法确定版本时兜底全量）。
   */
  async findUnclearedPracticeByStudentSubject(
    studentId: number,
    subjectId: number,
    textbookVersionId?: number | null,
  ): Promise<Array<{
    id: number;
    source_ref_id: number | null;
    question_id: number | null;
    question_n: string | null;
    questionText: string | null;
    lesson_id: number | null;
  }>> {
    const versionJoin = textbookVersionId != null
      ? 'LEFT JOIN lessons l ON l.id = c.lesson_id\n        LEFT JOIN units u ON u.id = l.unit_id\n        LEFT JOIN semesters s ON s.id = u.semester_id'
      : '';
    const versionFilter = textbookVersionId != null ? 'AND s.textbook_version_id = ?' : '';
    const params: any[] = textbookVersionId != null
      ? [studentId, subjectId, textbookVersionId]
      : [studentId, subjectId];
    const [rows] = await this.pool.execute<RowDataPacket[]>(
      `SELECT meb.id, meb.source_ref_id, meb.question_id, meb.question_n,
              COALESCE(q.content, meb.wrong_answer_text) AS questionText,
              c.lesson_id AS lesson_id
       FROM main_error_books meb
       LEFT JOIN questions q ON meb.question_id = q.id
       LEFT JOIN cards c ON c.id = meb.source_ref_id
       ${versionJoin}
       WHERE meb.student_id = ? AND meb.subject_id = ? AND meb.source = 'practice' AND meb.is_cleared = 0
       ${versionFilter}
       ORDER BY meb.id`,
      params,
    );
    return rows as Array<{
      id: number;
      source_ref_id: number | null;
      question_id: number | null;
      question_n: string | null;
      questionText: string | null;
      lesson_id: number | null;
    }>;
  }

  /**
   * 错题练习筛选：时间范围（created_at）/题型（JOIN questions）/专项（EXISTS qkp）。
   *  返回未清零记录，每行带 kp_id（同题多 KP 会出多行，service 层聚合）。
   *  options 为 questions.options 的 JSON 字符串（选择题选项，service 层解析）；
   *  多行聚合时同值重复无碍（service 只取首行）。
   */
  async findErrorBookEntries(studentId: number, subjectId: number, filters: {
    from?: string; to?: string; type?: string; kpId?: number;
  }): Promise<Array<{ id: number; question_id: number | null; questionText: string | null; type: string | null; level: number; created_at: Date; kp_id: number | null; options: string | null }>> {
    const conditions = ['meb.student_id = ?', 'meb.subject_id = ?', 'meb.is_cleared = 0'];
    const params: any[] = [studentId, subjectId];
    if (filters.from) { conditions.push('meb.created_at >= ?'); params.push(filters.from); }
    if (filters.to) { conditions.push('meb.created_at < DATE_ADD(?, INTERVAL 1 DAY)'); params.push(filters.to); }
    if (filters.type) { conditions.push('q.type = ?'); params.push(filters.type); }
    if (filters.kpId) { conditions.push('EXISTS (SELECT 1 FROM question_knowledge_points qkp WHERE qkp.question_id = meb.question_id AND qkp.knowledge_point_id = ?)'); params.push(filters.kpId); }
    const [rows] = await this.pool.execute<RowDataPacket[]>(
      `SELECT meb.id, meb.question_id, COALESCE(q.content, meb.wrong_answer_text) AS questionText,
              q.type, meb.level, meb.created_at, q.options AS options, qkp.knowledge_point_id AS kp_id
       FROM main_error_books meb
       LEFT JOIN questions q ON meb.question_id = q.id
       LEFT JOIN question_knowledge_points qkp ON qkp.question_id = meb.question_id
       WHERE ${conditions.join(' AND ')}
       ORDER BY meb.created_at DESC`,
      params,
    );
    return rows as any[];
  }

  /**
   * 批量递增错题严重程度（level + 1）。
   * 用于清零后仍有错误的题，标记未掌握。
   * studentId 可选归属校验：传入时只更新该学生自己的记录（防 IDOR——
   * 客户端提交的 errorBookIds 不可信，跨学生 id 一律不命中）。
   */
  async bumpLevels(ids: number[], studentId?: number): Promise<void> {
    if (ids.length === 0) return;
    const placeholders = ids.map(() => '?').join(',');
    await this.pool.execute(
      `UPDATE main_error_books SET level = level + 1
       WHERE id IN (${placeholders}) AND (? IS NULL OR student_id = ?)`,
      studentId != null ? [...ids, studentId, studentId] : [...ids, null, null],
    );
  }
}
