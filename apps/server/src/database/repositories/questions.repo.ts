import { Injectable, Inject } from '@nestjs/common';
import type { Pool, ResultSetHeader, RowDataPacket } from 'mysql2/promise';
import type { QuestionRow } from './types.js';
import { contentPrefix } from '../../common/utils/content-hash.util.js';

/**
 * 抽题时带出「题目在试卷中的题号」（paper_questions.question_no）。
 *
 * 一道题可能被多份卷收录（去重后关联到多卷，题号各不相同），此时**优先取
 * questions.source 对应的那份卷**：入库时 source 就是卷目录名（与
 * exam_papers.source_key 尾段一致），能唯一对上；少数老数据 source 是卷内
 * 文件名，对不上就退回最小题号（仅 19 道多卷题受影响）。
 *
 * 老批量导入的题（2026-09 之前）没有 paper_questions 关联，但 questions.group_order
 * 就是入库时的卷面题号（db_loader 口径，2026-10-31），无关联时退回它 —— 否则这类题
 * 在专项作答页 / 练习记录里只剩来源、没有题号（lc1 的 4686 即此例）。
 * freeform / practice / remediation 等无卷来源的 group_order 为 NULL，仍返回 NULL。
 */
const PAPER_QUESTION_NO_SQL = `COALESCE((
  SELECT pq.question_no FROM paper_questions pq
  JOIN exam_papers ep ON ep.id = pq.paper_id
  WHERE pq.question_id = q.id
  ORDER BY (SUBSTRING_INDEX(ep.source_key, '/', -1) = q.source) DESC, pq.question_no
  LIMIT 1
), q.group_order)`;

/** 该生「做过 + 最后作答时间」派生表，4 个 ? 依次是 student_id。
 *  与「从未做过」判定同源：专项/考试「已判**或已作答**」 + 主线非跳过未答 + 主观题自评。
 *  2026-11-26：加自评表——主观题提交时 sar.is_correct 停在 NULL，真正的对错
 *  落在 question_self_assessments，只认 sar 会把这类题误判成「从未做过」。
 *  2026-11-26 二次修：判据从「有对错」放宽为「**有非空答案文本也算做过**」——
 *  考试主观题 is_correct 恒为 NULL（考试只算客观题），学生答了但没在结果页自评时，
 *  只认 is_correct 会把它当从未做过，专项抽题反复优先抽出。含旧专项行（is_correct=NULL
 *  但 answer_text 有值）。占位行的 answer_text 为 NULL，天然排除。
 *  外层按 question_id 聚合：同一题可能同时命中多表/多行，不去重会让
 *  findRandomByKpAndType 的 LEFT JOIN 抽出重复题。 */
const ANSWERED_TIMES_SQL = `SELECT question_id, MAX(answered_at) AS answered_at FROM (
  SELECT sar.question_id AS question_id, MAX(COALESCE(sar.judged_at, sar.created_at)) AS answered_at
    FROM special_answer_records sar
    JOIN special_practice_sessions sps ON sps.id = sar.session_id
    WHERE sps.student_id = ?
      AND (sar.is_correct IS NOT NULL
           OR (sar.answer_text IS NOT NULL AND TRIM(sar.answer_text) <> ''))
    GROUP BY sar.question_id
  UNION ALL
  SELECT ea.question_id, MAX(COALESCE(ea.judged_at, ea.created_at))
    FROM exam_answers ea
    JOIN exam_sessions es ON es.id = ea.session_id
    WHERE es.student_id = ?
      AND (ea.is_correct IS NOT NULL
           OR (ea.answer_text IS NOT NULL AND TRIM(ea.answer_text) <> ''))
    GROUP BY ea.question_id
  UNION ALL
  SELECT pr.question_id, MAX(COALESCE(pr.judged_at, pr.created_at))
    FROM practice_results pr
    WHERE pr.student_id = ? AND pr.method <> 'unanswered'
    GROUP BY pr.question_id
  UNION ALL
  SELECT qsa.question_id, MAX(qsa.created_at)
    FROM question_self_assessments qsa
    WHERE qsa.student_id = ?
    GROUP BY qsa.question_id
) all_answered GROUP BY question_id`;

export interface PaperPositionOptionRow extends RowDataPacket {
  grade: string;
  semester: string;
  question_count: number;
  papers: number;
}

export interface PaperPositionCountRow extends RowDataPacket {
  question_no: number;
  total: number;
  wrong_count: number;
  untried_count: number;
}

@Injectable()
export class QuestionsRepository {
  constructor(@Inject('DATABASE_POOL') private readonly pool: Pool) {}

  async findByContentHash(contentHash: string): Promise<QuestionRow | null> {
    const [rows] = await this.pool.execute<RowDataPacket[]>(
      `SELECT * FROM questions WHERE content_hash = ? AND is_active = 1`,
      [contentHash],
    );
    return (rows[0] as QuestionRow) ?? null;
  }

  /**
   * 题目前缀兜底匹配：hash 未命中时，用「归一化去标点后的前 20 字」比对，
   * 解决同一道题因文字/格式微调导致 hash 不一致的问题。先用前 6 字做
   * LIKE 粗筛（needle 无标点，能穿过题库内容的标点），再在 JS 里精确比对
   * 前缀；返回按 id 倒序（最新优先）的候选。
   */
  async findByContentPrefix(
    content: string,
    opts?: { subjectId?: number; limit?: number },
  ): Promise<QuestionRow[]> {
    const prefix = contentPrefix(content);
    if (prefix.length < 4) return [];
    const needle = prefix.slice(0, Math.min(6, prefix.length));
    const conditions = ['is_active = 1', "content LIKE CONCAT('%', ?, '%')"];
    const params: Array<number | string> = [needle];
    if (opts?.subjectId != null) {
      conditions.push('subject_id = ?');
      params.push(opts.subjectId);
    }
    const [rows] = await this.pool.execute<RowDataPacket[]>(
      `SELECT * FROM questions WHERE ${conditions.join(' AND ')} ORDER BY id DESC LIMIT 50`,
      params,
    );
    return (rows as QuestionRow[]).filter((r) => contentPrefix(r.content) === prefix).slice(0, opts?.limit ?? 20);
  }

  /** 题中心定位：按主键取在用题目（训练模块用，训练题必来自题库）。 */
  async findById(id: number): Promise<QuestionRow | null> {
    const [rows] = await this.pool.execute<RowDataPacket[]>(
      `SELECT * FROM questions WHERE id = ? AND is_active = 1`,
      [id],
    );
    return (rows[0] as QuestionRow) ?? null;
  }

  /** 判错解析缓存：LLM 生成/长答案直写后回写 questions.explanation。 */
  async updateExplanation(id: number, explanation: string): Promise<void> {
    await this.pool.execute(
      'UPDATE questions SET explanation = ? WHERE id = ?',
      [explanation, id],
    );
  }

  /**
   * 题目真实学科 code（math/physics/politics…）。
   * 解析缓存要按它选提示词角色：QuestionRow 只有 subject_id，写死 'math' 会让
   * 物理/化学的题解顶着「数学老师」生成（2026-11-01）。
   */
  async findSubjectCode(id: number): Promise<string | null> {
    const [rows] = await this.pool.execute<RowDataPacket[]>(
      `SELECT s.code FROM questions q JOIN subjects s ON s.id = q.subject_id WHERE q.id = ?`,
      [id],
    );
    return (rows[0]?.code as string) ?? null;
  }

  async create(row: Omit<QuestionRow, 'id' | 'created_at' | 'is_active'>): Promise<number> {
    const [result] = await this.pool.execute<ResultSetHeader>(
      `INSERT INTO questions
       (subject_id, type, difficulty, content, options, answer, approach, explanation, source, content_hash)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [row.subject_id, row.type, row.difficulty, row.content, row.options, row.answer, row.approach ?? null, row.explanation, row.source, row.content_hash],
    );
    return result.insertId;
  }

  /**
   * Race-safe dedup: find by content_hash, else create. The UNIQUE constraint on
   * content_hash catches the TOCTOU race (two concurrent inserts with same hash);
   * ER_DUP_ENTRY is caught and resolved by re-reading the existing row.
   */
  async findOrCreate(row: Omit<QuestionRow, 'id' | 'created_at' | 'is_active'>): Promise<{ id: number; created: boolean }> {
    const existing = await this.findByContentHash(row.content_hash);
    if (existing) return { id: existing.id, created: false };
    try {
      const id = await this.create(row);
      return { id, created: true };
    } catch (err: any) {
      // ER_DUP_ENTRY: race condition - another request inserted the same hash
      if (err.code === 'ER_DUP_ENTRY' || err.errno === 1062) {
        const existing = await this.findByContentHash(row.content_hash);
        if (existing) return { id: existing.id, created: false };
      }
      throw err;
    }
  }

  /**
   * freeform（AI 生成的自由作答/解答题）落库：与 create 分开，是因为它必须写
   * full_score 并把 answer_verified 固定为 0（未经人工/权威校验）、is_active=1。
   * 不绑知识点（question_knowledge_points 无行）。
   */
  async createFreeform(row: {
    subject_id: number; type: string; difficulty: number; full_score: number;
    content: string; options: string | null; answer: string;
    approach: string | null; explanation: string | null; source: 'freeform';
    content_hash: string;
  }): Promise<number> {
    try {
      const [r] = await this.pool.execute<ResultSetHeader>(
        `INSERT INTO questions
          (subject_id, type, difficulty, full_score, content, options, answer, approach, explanation, source, content_hash, answer_verified, is_active)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 1)`,
        [row.subject_id, row.type, row.difficulty, row.full_score, row.content, row.options,
         row.answer, row.approach, row.explanation, row.source, row.content_hash],
      );
      return r.insertId;
    } catch (err: any) {
      // ER_DUP_ENTRY：并发提交同一道题（content_hash UNIQUE）—— 另一路已插入，
      // 回读既有行返回其 id，避免第二次请求在 LLM 花费之后报错。
      if (err.code === 'ER_DUP_ENTRY' || err.errno === 1062) {
        const existing = await this.findByContentHash(row.content_hash);
        if (existing) return existing.id;
      }
      throw err;
    }
  }

  /** 只允许改 freeform 行：题库题（source 非 freeform）绝不被 AI 侧覆写。 */
  async updateFreeform(id: number, row: {
    type: string; difficulty: number; full_score: number; content: string;
    options: string | null; answer: string; approach: string | null;
    explanation: string | null; content_hash: string;
  }): Promise<void> {
    await this.pool.execute(
      `UPDATE questions SET type=?, difficulty=?, full_score=?, content=?, options=?,
         answer=?, approach=?, explanation=?, content_hash=? WHERE id=? AND source='freeform'`,
      [row.type, row.difficulty, row.full_score, row.content, row.options,
       row.answer, row.approach, row.explanation, row.content_hash, id],
    );
  }

  async deleteById(id: number): Promise<void> {
    await this.pool.execute(`DELETE FROM questions WHERE id = ?`, [id]);
  }

  async bindKnowledgePoint(questionId: number, knowledgePointId: number, role = 'primary'): Promise<void> {
    await this.pool.execute(
      `INSERT IGNORE INTO question_knowledge_points (question_id, knowledge_point_id, role) VALUES (?, ?, ?)`,
      [questionId, knowledgePointId, role],
    );
  }

  /** 该题绑定的知识点 id（掌握度回写用；无绑定返回空数组，不是 null）。 */
  async findKnowledgePointIdsByQuestion(questionId: number): Promise<number[]> {
    const [rows] = await this.pool.execute<(RowDataPacket & { knowledge_point_id: number })[]>(
      `SELECT knowledge_point_id FROM question_knowledge_points WHERE question_id = ?`,
      [questionId],
    );
    return rows.map((r) => Number(r.knowledge_point_id));
  }

  /**
   * 专项练习随机抽题（训练模块 Task 8）：按学科 + 知识点（JOIN qkp）随机取 count 题。
   * type 传 null 时不过滤题型；空答案题一律排除（判题体系重构 2026-09-09）：客观题判不了对，
   * 主观题（self_assess 模式）没有参考答案可对照自评——两类都不进专项练习。
   *
   * 「不再展示」排除（2026-09-04）：LEFT JOIN student_hidden_questions，
   * 该生已标记的题 shq.id 非空 -> WHERE shq.id IS NULL 过滤掉。
   * studentId 由 TrainingService 从 controller JWT user.sub 透传。
   *
   * 2026-11-25：没做过的题优先（池内仍 RAND()），全做过后按最后作答时间从久到新补，
   * 与试卷题号模式同一口径；六科共用的按知识点抽题都走这里。
   */
  async findRandomByKpAndType(
    studentId: number,
    subjectId: number,
    kpId: number,
    type: string | null,
    count: number,
  ): Promise<QuestionRow[]> {
    const typeFilter = type != null ? ' AND q.type = ?' : '';
    const sql = `SELECT q.*, ${PAPER_QUESTION_NO_SQL} AS question_no FROM questions q
      JOIN question_knowledge_points qkp ON qkp.question_id = q.id
      LEFT JOIN student_hidden_questions shq
        ON shq.question_id = q.id AND shq.student_id = ?
      LEFT JOIN (${ANSWERED_TIMES_SQL}) ans ON ans.question_id = q.id
      WHERE q.subject_id = ? AND qkp.knowledge_point_id = ? AND q.is_active = 1${typeFilter}
        AND q.answer <> ''
        AND shq.id IS NULL
      ORDER BY (ans.question_id IS NULL) DESC,
        CASE WHEN ans.question_id IS NULL THEN RAND() ELSE UNIX_TIMESTAMP(ans.answered_at) END ASC,
        q.id ASC
      LIMIT ?`;
    // 2026-11-25：没做过的优先（池内仍随机），全做过后按最后作答时间从久到新补。
    const params = type != null
      ? [studentId, studentId, studentId, studentId, studentId, subjectId, kpId, type, count]
      : [studentId, studentId, studentId, studentId, studentId, subjectId, kpId, count];
    // Use pool.query (client-side escaping) instead of pool.execute (server-side
    // prepared statements): MySQL rejects `LIMIT ?` as a prepared-statement
    // placeholder with "Incorrect arguments to mysqld_stmt_execute"（联调实测；
    // 与 ai-dialogues.repo.ts findByStudentAndTrack 同款处理）。? 值仍经 mysql2
    // 转义，无注入风险。
    const [rows] = await this.pool.query<RowDataPacket[]>(sql, params);
    return rows as QuestionRow[];
  }

  /** 模型微专题：该生可练题数（与抽题谓词同源；confidence 阈值 0.70）。 */
  async countModelSpecialQuestions(
    studentId: number,
    subjectId: number,
    category: string,
    model: string,
  ): Promise<number> {
    const sql = `SELECT COUNT(*) AS count FROM questions q
      JOIN question_model_tags qmt ON qmt.question_id = q.id
      LEFT JOIN student_hidden_questions shq
        ON shq.question_id = q.id AND shq.student_id = ?
      WHERE q.subject_id = ? AND qmt.category = ? AND qmt.model = ?
        AND qmt.confidence >= 0.70
        AND q.is_active = 1 AND q.answer <> '' AND shq.id IS NULL`;
    const [rows] = await this.pool.query<RowDataPacket[]>(
      sql, [studentId, subjectId, category, model],
    );
    return Number((rows[0] as { count: number } | undefined)?.count ?? 0);
  }

  /** 模型微专题抽题：固定 q.id 升序（本期 2 条为 7093→7094）。 */
  async findModelSpecialQuestions(
    studentId: number,
    subjectId: number,
    category: string,
    model: string,
    count: number,
  ): Promise<QuestionRow[]> {
    // 倍长中线是「完整题 → 第二问」的固定序列，必须 id 升序；
    // 其他模型题池较大，随机抽，避免每次都出前几条。
    const orderBy = model === 'median_doubling'
      ? 'ORDER BY q.id ASC'
      : 'ORDER BY RAND()';
    const sql = `SELECT q.*, ${PAPER_QUESTION_NO_SQL} AS question_no FROM questions q
      JOIN question_model_tags qmt ON qmt.question_id = q.id
      LEFT JOIN student_hidden_questions shq
        ON shq.question_id = q.id AND shq.student_id = ?
      WHERE q.subject_id = ? AND qmt.category = ? AND qmt.model = ?
        AND qmt.confidence >= 0.70
        AND q.is_active = 1 AND q.answer <> '' AND shq.id IS NULL
      ${orderBy} LIMIT ?`;
    // pool.query：LIMIT ? 不能走 execute 的 server-side prepare（仓库既有约定）。
    const [rows] = await this.pool.query<RowDataPacket[]>(
      sql, [studentId, subjectId, category, model, count],
    );
    return rows as QuestionRow[];
  }

  /** 「试卷题号」选项：按年级+学期+卷面题数分组统计卷数（只算可判题，避免空卷占位）。 */
  async listPaperPositionOptions(subjectId: number): Promise<PaperPositionOptionRow[]> {
    const sql = `SELECT p.grade, p.semester, p.question_count, COUNT(DISTINCT p.id) AS papers
      FROM exam_papers p
      JOIN paper_questions pq ON pq.paper_id = p.id
      JOIN questions q ON q.id = pq.question_id
      WHERE p.subject_id = ? AND p.semester IN ('first', 'second')
        AND q.is_active = 1 AND q.answer <> ''
      GROUP BY p.grade, p.semester, p.question_count`;
    const [rows] = await this.pool.query<RowDataPacket[]>(sql, [subjectId]);
    return rows as PaperPositionOptionRow[];
  }

  /**
   * 「试卷题号」每个题号的三个数：
   * - total：排除 hidden 后的可判题数；
   * - wrong_count：未清错题本中的题数；
   * - untried_count：不在错题本、且专项/考试/主线三处都无已判记录的题数
   *   （主线跳过未答 `method='unanswered'` 的占位行不算做过）。
   * 参数顺序：错题 2 + 未做 5 + 范围 3 + hidden 2。
   */
  async countPaperPositionQuestions(
    studentId: number,
    subjectId: number,
    grade: string,
    semester: string,
  ): Promise<PaperPositionCountRow[]> {
    const sql = `SELECT pq.question_no,
        COUNT(DISTINCT q.id) AS total,
        COUNT(DISTINCT CASE WHEN EXISTS (
          SELECT 1 FROM main_error_books meb
          WHERE meb.student_id = ? AND meb.subject_id = ?
            AND meb.question_id = q.id AND meb.is_cleared = 0
        ) THEN q.id END) AS wrong_count,
        COUNT(DISTINCT CASE WHEN NOT EXISTS (
          SELECT 1 FROM main_error_books meb
          WHERE meb.student_id = ? AND meb.subject_id = ?
            AND meb.question_id = q.id AND meb.is_cleared = 0
        ) AND NOT EXISTS (
          SELECT 1 FROM special_answer_records sar
          JOIN special_practice_sessions sps ON sps.id = sar.session_id
          WHERE sar.question_id = q.id AND sps.student_id = ?
            AND (sar.is_correct IS NOT NULL
                 OR (sar.answer_text IS NOT NULL AND TRIM(sar.answer_text) <> ''))
        ) AND NOT EXISTS (
          SELECT 1 FROM exam_answers ea
          JOIN exam_sessions es ON es.id = ea.session_id
          WHERE ea.question_id = q.id AND es.student_id = ?
            AND (ea.is_correct IS NOT NULL
                 OR (ea.answer_text IS NOT NULL AND TRIM(ea.answer_text) <> ''))
        ) AND NOT EXISTS (
          SELECT 1 FROM practice_results pr
          WHERE pr.question_id = q.id AND pr.student_id = ?
            AND pr.method <> 'unanswered'
        ) AND NOT EXISTS (
          SELECT 1 FROM question_self_assessments qsa
          WHERE qsa.question_id = q.id AND qsa.student_id = ?
        ) THEN q.id END) AS untried_count
      FROM paper_questions pq
      JOIN exam_papers p ON p.id = pq.paper_id
      JOIN questions q ON q.id = pq.question_id
      WHERE p.subject_id = ? AND p.grade = ? AND p.semester = ?
        AND q.is_active = 1 AND q.answer <> ''
        AND NOT EXISTS (
          SELECT 1 FROM student_hidden_questions shq
          WHERE shq.student_id = ? AND shq.subject_id = ? AND shq.question_id = q.id
        )
      GROUP BY pq.question_no`;
    const [rows] = await this.pool.query<RowDataPacket[]>(
      sql,
      [studentId, subjectId, studentId, subjectId, studentId, studentId, studentId, studentId,
        subjectId, grade, semester, studentId, subjectId],
    );
    return rows as PaperPositionCountRow[];
  }

  /** 错题优先池：未清错题本中的同题号题，level 高→低、同级别最近答错在前。 */
  async findPaperPositionWrongQuestions(
    studentId: number,
    subjectId: number,
    grade: string,
    semester: string,
    questionNo: number,
    limit: number,
  ): Promise<QuestionRow[]> {
    const sql = `SELECT q.*, MIN(pq.question_no) AS question_no,
        MAX(meb.level) AS wrong_level, MAX(meb.created_at) AS last_wrong_at
      FROM paper_questions pq
      JOIN exam_papers p ON p.id = pq.paper_id
      JOIN questions q ON q.id = pq.question_id
      JOIN main_error_books meb ON meb.question_id = q.id
        AND meb.student_id = ? AND meb.subject_id = ? AND meb.is_cleared = 0
      WHERE p.subject_id = ? AND p.grade = ? AND p.semester = ? AND pq.question_no = ?
        AND q.is_active = 1 AND q.answer <> ''
        AND NOT EXISTS (
          SELECT 1 FROM student_hidden_questions shq
          WHERE shq.student_id = ? AND shq.subject_id = ? AND shq.question_id = q.id
        )
      GROUP BY q.id
      ORDER BY wrong_level DESC, last_wrong_at DESC, q.id ASC
      LIMIT ?`;
    // pool.query：LIMIT ? 不能走 execute 的 server-side prepare（仓库既有约定）。
    const [rows] = await this.pool.query<RowDataPacket[]>(
      sql,
      [studentId, subjectId, subjectId, grade, semester, questionNo, studentId, subjectId, limit],
    );
    return rows as QuestionRow[];
  }

  /** 补足池：不在错题本、且三处都无已判记录的题（主线跳过未答 `method='unanswered'` 不算做过）；id 升序确定性取。 */
  async findPaperPositionUntriedQuestions(
    studentId: number,
    subjectId: number,
    grade: string,
    semester: string,
    questionNo: number,
    limit: number,
  ): Promise<QuestionRow[]> {
    const sql = `SELECT q.*, MIN(pq.question_no) AS question_no
      FROM paper_questions pq
      JOIN exam_papers p ON p.id = pq.paper_id
      JOIN questions q ON q.id = pq.question_id
      WHERE p.subject_id = ? AND p.grade = ? AND p.semester = ? AND pq.question_no = ?
        AND q.is_active = 1 AND q.answer <> ''
        AND NOT EXISTS (
          SELECT 1 FROM student_hidden_questions shq
          WHERE shq.student_id = ? AND shq.subject_id = ? AND shq.question_id = q.id
        )
        AND NOT EXISTS (
          SELECT 1 FROM main_error_books meb
          WHERE meb.student_id = ? AND meb.subject_id = ?
            AND meb.question_id = q.id AND meb.is_cleared = 0
        )
        AND NOT EXISTS (
          SELECT 1 FROM special_answer_records sar
          JOIN special_practice_sessions sps ON sps.id = sar.session_id
          WHERE sar.question_id = q.id AND sps.student_id = ?
            AND (sar.is_correct IS NOT NULL
                 OR (sar.answer_text IS NOT NULL AND TRIM(sar.answer_text) <> ''))
        )
        AND NOT EXISTS (
          SELECT 1 FROM exam_answers ea
          JOIN exam_sessions es ON es.id = ea.session_id
          WHERE ea.question_id = q.id AND es.student_id = ?
            AND (ea.is_correct IS NOT NULL
                 OR (ea.answer_text IS NOT NULL AND TRIM(ea.answer_text) <> ''))
        )
        AND NOT EXISTS (
          SELECT 1 FROM practice_results pr
          WHERE pr.question_id = q.id AND pr.student_id = ?
            AND pr.method <> 'unanswered'
        )
        AND NOT EXISTS (
          SELECT 1 FROM question_self_assessments qsa
          WHERE qsa.question_id = q.id AND qsa.student_id = ?
        )
      GROUP BY q.id
      ORDER BY q.id ASC
      LIMIT ?`;
    // pool.query：同上，LIMIT ? 必须走 client-side escaping。
    const [rows] = await this.pool.query<RowDataPacket[]>(
      sql,
      [subjectId, grade, semester, questionNo, studentId, subjectId,
        studentId, subjectId, studentId, studentId, studentId, studentId, limit],
    );
    return rows as QuestionRow[];
  }

  /** 补足池②：做过的题里按最后作答时间升序取（最久没碰的在前）；
   *  排除未清错题，避免与先取的错题池重复。作答判定与未做池同源：专项/考试已判 + 主线非「跳过未答」。 */
  async findPaperPositionAnsweredQuestions(
    studentId: number,
    subjectId: number,
    grade: string,
    semester: string,
    questionNo: number,
    limit: number,
  ): Promise<QuestionRow[]> {
    const sql = `SELECT q.*, MIN(pq.question_no) AS question_no,
        MAX(ans.answered_at) AS last_answered_at
      FROM paper_questions pq
      JOIN exam_papers p ON p.id = pq.paper_id
      JOIN questions q ON q.id = pq.question_id
      JOIN (${ANSWERED_TIMES_SQL}) ans ON ans.question_id = q.id
      WHERE p.subject_id = ? AND p.grade = ? AND p.semester = ? AND pq.question_no = ?
        AND q.is_active = 1 AND q.answer <> ''
        AND NOT EXISTS (
          SELECT 1 FROM student_hidden_questions shq
          WHERE shq.student_id = ? AND shq.subject_id = ? AND shq.question_id = q.id
        )
        AND NOT EXISTS (
          SELECT 1 FROM main_error_books meb
          WHERE meb.student_id = ? AND meb.subject_id = ?
            AND meb.question_id = q.id AND meb.is_cleared = 0
        )
      GROUP BY q.id
      ORDER BY last_answered_at ASC, q.id ASC
      LIMIT ?`;
    // pool.query：同上，LIMIT ? 不能走 execute 的 server-side prepare。
    const [rows] = await this.pool.query<RowDataPacket[]>(sql, [
      studentId, studentId, studentId, studentId,
      subjectId, grade, semester, questionNo,
      studentId, subjectId, studentId, subjectId,
      limit,
    ]);
    return rows as QuestionRow[];
  }

  /** 补偿套题抽题（2026-09-21）：同考点 + 同题型 + 难度档（数组）随机取题。
   *  谓词与 findRandomByKpAndType 同源（「不再展示」排除、空答案排除、is_active）；
   *  难度由调用方按放宽阶梯（先同档，再 ±1 档）分次传入；
   *  excludeQuestionIds 排除原错题与套题已有题。kp 匹配不限 role（与专项抽题一致，次级标注也算考过该点）。 */
  async findRandomByKpTypeDifficulty(
    studentId: number,
    subjectId: number,
    kpId: number,
    type: string,
    difficulties: number[],
    count: number,
    excludeQuestionIds: number[],
    opts?: { requireAllKpRootCodes?: string[] },
  ): Promise<QuestionRow[]> {
    // 空难度数组会生成 `q.difficulty IN ()` → MySQL ER_PARSE_ERROR（500）。调用方理论上
    // 已经收敛过，这里再兜一层：无档位可抽时直接返回空，不发 SQL。
    if (difficulties.length === 0) return [];
    const diffFilter = difficulties.map(() => '?').join(',');
    const exclusion = excludeQuestionIds.length > 0
      ? ` AND q.id NOT IN (${excludeQuestionIds.map(() => '?').join(',')})`
      : '';
    // 语文「同类型」：候选题的所有知识点都必须落在指定顶层 code（C01/C02）下，
    // 否则抽到的可能是同考点的现代文阅读题（2026-11-08）。
    const roots = opts?.requireAllKpRootCodes ?? [];
    const rootPlaceholders = roots.map(() => '?').join(',');
    const rootFilter = roots.length > 0
      ? ` AND EXISTS (
            SELECT 1 FROM question_knowledge_points qkp2
            JOIN knowledge_points kp2 ON kp2.id = qkp2.knowledge_point_id
            LEFT JOIN knowledge_points pk2 ON pk2.id = kp2.parent_kp_id
            WHERE qkp2.question_id = q.id
              AND COALESCE(pk2.code, kp2.code) IN (${rootPlaceholders})
          )
          AND NOT EXISTS (
            SELECT 1 FROM question_knowledge_points qkp3
            JOIN knowledge_points kp3 ON kp3.id = qkp3.knowledge_point_id
            LEFT JOIN knowledge_points pk3 ON pk3.id = kp3.parent_kp_id
            WHERE qkp3.question_id = q.id
              AND (COALESCE(pk3.code, kp3.code) IS NULL
                   OR COALESCE(pk3.code, kp3.code) NOT IN (${rootPlaceholders}))
          )`
      : '';
    const sql = `SELECT q.* FROM questions q
      JOIN question_knowledge_points qkp ON qkp.question_id = q.id
      LEFT JOIN student_hidden_questions shq
        ON shq.question_id = q.id AND shq.student_id = ?
      WHERE q.subject_id = ? AND qkp.knowledge_point_id = ? AND q.is_active = 1
        AND q.type = ? AND q.difficulty IN (${diffFilter})
        AND q.answer <> ''
        AND shq.id IS NULL${rootFilter}${exclusion}
      ORDER BY RAND() LIMIT ?`;
    // pool.query（非 execute）：LIMIT 占位符会被 MySQL prepared statement 拒绝
    //（见 findRandomByKpAndType 注释，联调实测过的问题）。
    const [rows] = await this.pool.query<RowDataPacket[]>(sql, [
      studentId, subjectId, kpId, type, ...difficulties,
      ...roots, ...roots, ...excludeQuestionIds, count,
    ]);
    return rows as QuestionRow[];
  }

  /** 批量按主键取在用题（补偿套题生成：由错题 id 反查题型/难度/题干）。 */
  async findByIds(ids: number[]): Promise<QuestionRow[]> {
    if (ids.length === 0) return [];
    const placeholders = ids.map(() => '?').join(',');
    const [rows] = await this.pool.execute<RowDataPacket[]>(
      `SELECT * FROM questions WHERE is_active = 1 AND id IN (${placeholders})`,
      ids,
    );
    return rows as QuestionRow[];
  }

  /** question_id -> primary 知识点 id（补偿套题按 primary 考点分组；无 primary 的题由调用方跳过）。 */
  async findPrimaryKpIds(questionIds: number[]): Promise<Map<number, number>> {
    if (questionIds.length === 0) return new Map();
    const placeholders = questionIds.map(() => '?').join(',');
    const [rows] = await this.pool.query<(RowDataPacket & { question_id: number; knowledge_point_id: number })[]>(
      `SELECT question_id, knowledge_point_id FROM question_knowledge_points
       WHERE role = 'primary' AND question_id IN (${placeholders})`,
      questionIds,
    );
    return new Map(rows.map((r) => [Number(r.question_id), Number(r.knowledge_point_id)]));
  }

  /** question_id -> 优先 primary 的最小知识点 id（详情判断 canSimilar / 同类型取种子 KP）。 */
  async findKpIdsByQuestionIds(questionIds: number[]): Promise<Map<number, number>> {
    if (questionIds.length === 0) return new Map();
    const placeholders = questionIds.map(() => '?').join(',');
    const [rows] = await this.pool.query<
      (RowDataPacket & { question_id: number; knowledge_point_id: number })[]
    >(
      `SELECT question_id, knowledge_point_id
       FROM question_knowledge_points
       WHERE question_id IN (${placeholders})
       ORDER BY question_id, (role = 'primary') DESC, knowledge_point_id`,
      questionIds,
    );
    const map = new Map<number, number>();
    for (const r of rows) {
      const qid = Number(r.question_id);
      if (!map.has(qid)) map.set(qid, Number(r.knowledge_point_id));
    }
    return map;
  }

  /**
   * question_id -> 该题挂的全部知识点（id + 所属顶层 code）。
   * 语文「同类型练习」按顶层 code 判定可练范围（C01/C02 开放）；
   * 详情页与抽题共用同一口径。
   */
  async findKpRefsByQuestionIds(
    questionIds: number[],
  ): Promise<Map<number, Array<{ id: number; rootCode: string | null }>>> {
    if (questionIds.length === 0) return new Map();
    const placeholders = questionIds.map(() => '?').join(',');
    const [rows] = await this.pool.query<
      (RowDataPacket & { question_id: number; id: number; root_code: string | null })[]
    >(
      `SELECT qkp.question_id, kp.id, COALESCE(pk.code, kp.code) AS root_code
       FROM question_knowledge_points qkp
       JOIN knowledge_points kp ON kp.id = qkp.knowledge_point_id
       LEFT JOIN knowledge_points pk ON pk.id = kp.parent_kp_id
       WHERE qkp.question_id IN (${placeholders})
       ORDER BY qkp.question_id, kp.id`,
      questionIds,
    );
    const map = new Map<number, Array<{ id: number; rootCode: string | null }>>();
    for (const r of rows) {
      const qid = Number(r.question_id);
      const list = map.get(qid) ?? [];
      list.push({ id: Number(r.id), rootCode: r.root_code ?? null });
      map.set(qid, list);
    }
    return map;
  }
}
