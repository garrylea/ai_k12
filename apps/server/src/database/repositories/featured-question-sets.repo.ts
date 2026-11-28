import { HttpException, HttpStatus, Injectable, Inject } from '@nestjs/common';
import type { Pool, PoolConnection, ResultSetHeader, RowDataPacket } from 'mysql2/promise';
import { PAPER_QUESTION_NO_SQL } from './questions.repo.js';

export interface CreateRecommendationInput {
  subjectId: number;
  questionIds: number[];
  contentKey: string;
  studentId: number;
  gradeCode: string;
  /** 服务层 Step 9 统计出的「今日新建题集数已达上限」信号；仅对新建题集生效。 */
  dailyLimitReached: boolean;
}

/** 打开精选题时从 questions 读出的原始题面（交给 mapper 转成运行器题目）。 */
export interface FeaturedSourceQuestion {
  id: number;
  subject_id: number;
  content: string;
  type: string;
  options: string | null;
  answer: string;
  explanation: string | null;
  material_text: string | null;
  material_url: string | null;
  sub_no: number;
  source: string | null;
  question_no: number | null;
}

export interface CreateRecommendationResult {
  setId: number;
  alreadyRecommended: boolean;
}

export interface StudentFeaturedPublication {
  publicationId: number;
  setId: number;
  title: string;
  subjectId: number;
  subjectName: string;
  questionCount: number;
  publishedAt: Date;
  isRead: boolean;
}

export interface FeaturedUnreadSummary {
  count: number;
  latest: { publicationId: number; title: string } | null;
}

export type ReviewStatus = 'pending' | 'approved' | 'rejected';

export interface ReviewSetListItem {
  setId: number;
  subjectId: number;
  subjectName: string;
  questionCount: number;
  recommendationCount: number;
  gradeDistribution: Array<{ gradeCode: string; count: number }>;
  reviewStatus: ReviewStatus;
  createdAt: Date;
}

export interface ReviewQuestion {
  questionId: number;
  text: string;
  type: string;
  answer: string;
  explanation: string | null;
}

export interface ReviewPublication {
  publicationId: number;
  gradeCode: string;
  title: string;
  reachCount: number;
  status: 'published' | 'withdrawn';
  publishedAt: Date;
}

export interface ReviewSetDetail extends ReviewSetListItem {
  questions: ReviewQuestion[];
  publications: ReviewPublication[];
}

export interface OpenPublicationResult {
  publicationId: number;
  setId: number;
  title: string;
  subjectId: number;
  questions: FeaturedSourceQuestion[];
}

/** 当前在架题数（精选题单只投递仍可作答的题目）。 */
const AVAILABLE_COUNT_SQL = `(SELECT COUNT(*) FROM featured_question_set_items fqsi
    JOIN questions q ON q.id = fqsi.question_id
   WHERE fqsi.set_id = p.set_id AND q.is_active = 1)`;

@Injectable()
export class FeaturedQuestionSetsRepository {
  constructor(@Inject('DATABASE_POOL') private readonly pool: Pool) {}

  /** 每日额度只数「今日新建题集」，重复推荐同一题集不占额度。 */
  async countSetsCreatedToday(studentId: number): Promise<number> {
    const [rows] = await this.pool.execute<(RowDataPacket & { cnt: number | string })[]>(
      `SELECT COUNT(*) AS cnt FROM featured_question_sets
       WHERE created_by_student_id = ? AND created_at >= CURDATE()`,
      [studentId],
    );
    return Number(rows[0]?.cnt ?? 0);
  }

  /**
   * 学生推荐：同一 content_key 幂等建集 + 挂推荐票，全程同连接事务。
   *
   * 去重判定必须用 `affectedRows`，不能用 `insertId === selected id`：
   * `ON DUPLICATE KEY UPDATE id = LAST_INSERT_ID(id)` 在重复分支下 insertId 也被
   * 置成既有行 id（mysql2 从 OK 包拿到的是会话 LAST_INSERT_ID），两种分支都相等。
   * - `affectedRows === 1`：fresh INSERT，只在这一支写 items；
   * - `affectedRows === 2`：duplicate UPDATE，复用既有题集、不写 items；
   * - `affectedRows === 0`：duplicate 的 NO-OP（`id` 被更新成自身，值未变），
   *   同样不写 items。这一支在真库上可能出现，不能当作异常 fail。
   *
   * 推荐票用 `INSERT IGNORE`：`affectedRows === 1` 为新票（alreadyRecommended=false），
   * `0` 为命中 (set_id, student_id) 唯一键被忽略（alreadyRecommended=true）。
   */
  async createRecommendation(input: CreateRecommendationInput): Promise<CreateRecommendationResult> {
    const conn = await this.pool.getConnection();
    try {
      await conn.beginTransaction();

      const [upsert] = await conn.execute<ResultSetHeader>(
        `INSERT INTO featured_question_sets
           (content_key, subject_id, created_by_student_id, question_count)
         VALUES (?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE id = LAST_INSERT_ID(id)`,
        [input.contentKey, input.subjectId, input.studentId, input.questionIds.length],
      );
      const affectedRows = upsert.affectedRows;
      if (affectedRows !== 1 && affectedRows !== 2 && affectedRows !== 0) {
        throw new Error(`featured_question_sets upsert: unexpected affectedRows=${affectedRows}`);
      }
      const isNewSet = affectedRows === 1;

      // §3.1/§10：额度只约束「新建题集」。重复命中既有题集永不占额度、永不 429；
      // 只有确认为 fresh INSERT 且额度已满才回滚（由下方 catch 统一 rollback）并拒绝。
      if (isNewSet && input.dailyLimitReached) {
        throw new HttpException(
          { code: 1008, message: '今日推荐已达上限，请明天再试' },
          HttpStatus.TOO_MANY_REQUESTS,
        );
      }

      const [rows] = await conn.execute<(RowDataPacket & { id: number })[]>(
        `SELECT id FROM featured_question_sets WHERE content_key = ?`,
        [input.contentKey],
      );
      const setId = rows[0]?.id;
      if (setId === undefined) {
        throw new Error(`featured_question_sets upsert: missing row for content_key=${input.contentKey}`);
      }

      // 只有新建题集才写 items；重复命中时 items 已存在，再写会撞唯一键。
      if (isNewSet) {
        for (const [index, questionId] of input.questionIds.entries()) {
          await conn.execute(
            `INSERT INTO featured_question_set_items (set_id, question_id, sort_order)
             VALUES (?, ?, ?)`,
            [setId, questionId, index],
          );
        }
      }

      const [recommend] = await conn.execute<ResultSetHeader>(
        `INSERT IGNORE INTO featured_question_set_recommendations
           (set_id, student_id, student_grade_code)
         VALUES (?, ?, ?)`,
        [setId, input.studentId, input.gradeCode],
      );
      const alreadyRecommended = recommend.affectedRows === 0;

      await conn.commit();
      return { setId: Number(setId), alreadyRecommended };
    } catch (err) {
      await conn.rollback();
      throw err;
    } finally {
      conn.release();
    }
  }

  /** 教研审核列表：推荐人数与年级分布只来自聚合，绝不返回学生身份。 */
  async listReviewSets(
    status: ReviewStatus = 'pending',
    page = 1,
    pageSize = 20,
  ): Promise<{ items: ReviewSetListItem[]; total: number }> {
    const [countRows] = await this.pool.execute<(RowDataPacket & { cnt: number | string })[]>(
      `SELECT COUNT(*) AS cnt FROM featured_question_sets WHERE review_status = ?`,
      [status],
    );
    const total = Number(countRows[0]?.cnt ?? 0);
    const offset = Math.max(0, (page - 1) * pageSize);

    // LIMIT ? 必须走 pool.query（客户端转义）：MySQL 预处理语句拒绝 LIMIT 占位符。
    const [rows] = await this.pool.query<(RowDataPacket & {
      set_id: number;
      subject_id: number;
      subject_name: string;
      question_count: number;
      review_status: ReviewStatus;
      created_at: Date;
      recommendation_count: number | string;
    })[]>(
      `SELECT s.id AS set_id, s.subject_id, subj.name AS subject_name, s.question_count,
              s.review_status, s.created_at,
              (SELECT COUNT(*) FROM featured_question_set_recommendations r
                WHERE r.set_id = s.id) AS recommendation_count
         FROM featured_question_sets s
         JOIN subjects subj ON subj.id = s.subject_id
        WHERE s.review_status = ?
        ORDER BY s.created_at ASC
        LIMIT ? OFFSET ?`,
      [status, pageSize, offset],
    );
    if (rows.length === 0) return { items: [], total };

    const setIds = rows.map((r) => Number(r.set_id));
    const placeholders = setIds.map(() => '?').join(',');
    const [distRows] = await this.pool.execute<(RowDataPacket & {
      set_id: number;
      grade_code: string;
      cnt: number | string;
    })[]>(
      `SELECT set_id, student_grade_code AS grade_code, COUNT(*) AS cnt
         FROM featured_question_set_recommendations
        WHERE set_id IN (${placeholders})
        GROUP BY set_id, student_grade_code`,
      setIds,
    );
    const distribution = new Map<number, Array<{ gradeCode: string; count: number }>>();
    for (const r of distRows) {
      const list = distribution.get(Number(r.set_id)) ?? [];
      list.push({ gradeCode: r.grade_code, count: Number(r.cnt) });
      distribution.set(Number(r.set_id), list);
    }

    return {
      items: rows.map((r) => ({
        setId: Number(r.set_id),
        subjectId: Number(r.subject_id),
        subjectName: r.subject_name,
        questionCount: Number(r.question_count),
        recommendationCount: Number(r.recommendation_count ?? 0),
        gradeDistribution: distribution.get(Number(r.set_id)) ?? [],
        reviewStatus: r.review_status,
        createdAt: r.created_at,
      })),
      total,
    };
  }

  /** 审核详情：基础信息 + 题目 + 按年级聚合的推荐分布 + 各年级 publication。 */
  async getReviewSet(id: number): Promise<ReviewSetDetail | null> {
    const [rows] = await this.pool.execute<(RowDataPacket & {
      set_id: number;
      subject_id: number;
      subject_name: string;
      question_count: number;
      review_status: ReviewStatus;
      created_at: Date;
      recommendation_count: number | string;
    })[]>(
      `SELECT s.id AS set_id, s.subject_id, subj.name AS subject_name, s.question_count,
              s.review_status, s.created_at,
              (SELECT COUNT(*) FROM featured_question_set_recommendations r
                WHERE r.set_id = s.id) AS recommendation_count
         FROM featured_question_sets s
         JOIN subjects subj ON subj.id = s.subject_id
        WHERE s.id = ?`,
      [id],
    );
    const base = rows[0];
    if (!base) return null;

    const [distRows] = await this.pool.execute<(RowDataPacket & {
      grade_code: string;
      cnt: number | string;
    })[]>(
      `SELECT student_grade_code AS grade_code, COUNT(*) AS cnt
         FROM featured_question_set_recommendations
        WHERE set_id = ?
        GROUP BY student_grade_code`,
      [id],
    );
    const [questionRows] = await this.pool.execute<(RowDataPacket & {
      question_id: number;
      text: string;
      type: string;
      answer: string;
      explanation: string | null;
    })[]>(
      `SELECT q.id AS question_id, q.content AS text, q.type, q.answer, q.explanation
         FROM featured_question_set_items fqsi
         JOIN questions q ON q.id = fqsi.question_id
        WHERE fqsi.set_id = ? AND q.is_active = 1
        ORDER BY fqsi.sort_order, q.sub_no`,
      [id],
    );
    const [pubRows] = await this.pool.execute<(RowDataPacket & {
      publication_id: number;
      grade_code: string;
      title: string;
      reach_count: number | string;
      status: 'published' | 'withdrawn';
      published_at: Date;
    })[]>(
      `SELECT p.id AS publication_id, p.grade_code, p.title, p.reach_count, p.status, p.published_at
         FROM featured_question_set_publications p
        WHERE p.set_id = ?
        ORDER BY p.published_at DESC`,
      [id],
    );

    return {
      setId: Number(base.set_id),
      subjectId: Number(base.subject_id),
      subjectName: base.subject_name,
      questionCount: Number(base.question_count),
      recommendationCount: Number(base.recommendation_count ?? 0),
      gradeDistribution: distRows.map((r) => ({ gradeCode: r.grade_code, count: Number(r.cnt) })),
      reviewStatus: base.review_status,
      createdAt: base.created_at,
      questions: questionRows.map((r) => ({
        questionId: Number(r.question_id),
        text: r.text,
        type: r.type,
        answer: r.answer,
        explanation: r.explanation ?? null,
      })),
      publications: pubRows.map((r) => ({
        publicationId: Number(r.publication_id),
        gradeCode: r.grade_code,
        title: r.title,
        reachCount: Number(r.reach_count),
        status: r.status,
        publishedAt: r.published_at,
      })),
    };
  }

  async pendingCount(): Promise<number> {
    const [rows] = await this.pool.execute<(RowDataPacket & { cnt: number | string })[]>(
      `SELECT COUNT(*) AS cnt FROM featured_question_sets WHERE review_status = 'pending'`,
    );
    return Number(rows[0]?.cnt ?? 0);
  }

  /**
   * 发布：事务内锁题集、校验非 rejected、按 (set_id, grade_code) upsert publication，
   * 写独立标题与 reach_count 快照、题集置 approved；撤回后重发时清掉旧 read 行。
   */
  async publish(input: {
    setId: number;
    title: string;
    gradeCode: string;
    reviewerId: number;
    reachCount: number;
  }): Promise<{ publicationId: number }> {
    const conn = await this.pool.getConnection();
    try {
      await conn.beginTransaction();

      const [setRows] = await conn.execute<(RowDataPacket & { id: number; review_status: ReviewStatus })[]>(
        `SELECT id, review_status FROM featured_question_sets WHERE id = ? FOR UPDATE`,
        [input.setId],
      );
      const set = setRows[0];
      if (!set) throw new Error(`featured question set ${input.setId} not found`);
      if (set.review_status === 'rejected') {
        throw new Error(`featured question set ${input.setId} is rejected`);
      }

      const [existingRows] = await conn.execute<(RowDataPacket & {
        id: number;
        status: 'published' | 'withdrawn';
      })[]>(
        `SELECT id, status FROM featured_question_set_publications
          WHERE set_id = ? AND grade_code = ?`,
        [input.setId, input.gradeCode],
      );
      const existing = existingRows[0];

      // 用行别名 `AS new` 而非已弃用的 `VALUES()`（MySQL 8.0.20+ 打弃用告警）。
      await conn.execute<ResultSetHeader>(
        `INSERT INTO featured_question_set_publications
           (set_id, grade_code, title, reach_count, status, published_by, published_at, withdrawn_by, withdrawn_at)
         VALUES (?, ?, ?, ?, 'published', ?, NOW(3), NULL, NULL) AS new
         ON DUPLICATE KEY UPDATE
           title = new.title, reach_count = new.reach_count, status = 'published',
           published_by = new.published_by, published_at = NOW(3),
           withdrawn_by = NULL, withdrawn_at = NULL`,
        [input.setId, input.gradeCode, input.title, input.reachCount, input.reviewerId],
      );

      const [pubRows] = await conn.execute<(RowDataPacket & { id: number })[]>(
        `SELECT id FROM featured_question_set_publications
          WHERE set_id = ? AND grade_code = ?`,
        [input.setId, input.gradeCode],
      );
      const publicationId = pubRows[0]?.id;
      if (publicationId === undefined) {
        throw new Error(`publication not found for set ${input.setId} / ${input.gradeCode}`);
      }

      // 撤回后重发 = 一次新的未读投递：旧已读记录必须清掉。
      if (existing?.status === 'withdrawn') {
        await conn.execute(
          `DELETE FROM featured_question_set_reads WHERE publication_id = ?`,
          [publicationId],
        );
      }

      // 已 approved 的题集追加其它年级时不再改写审核人与时间。
      await conn.execute<ResultSetHeader>(
        `UPDATE featured_question_sets
            SET review_status = 'approved', reviewed_by = ?, reviewed_at = NOW(3)
          WHERE id = ? AND review_status <> 'approved'`,
        [input.reviewerId, input.setId],
      );

      await conn.commit();
      return { publicationId: Number(publicationId) };
    } catch (err) {
      await conn.rollback();
      throw err;
    } finally {
      conn.release();
    }
  }

  async reject(setId: number, reviewerId: number): Promise<void> {
    await this.pool.execute<ResultSetHeader>(
      `UPDATE featured_question_sets
          SET review_status = 'rejected', reviewed_by = ?, reviewed_at = NOW(3)
        WHERE id = ? AND review_status = 'pending'`,
      [reviewerId, setId],
    );
  }

  async reopen(setId: number): Promise<void> {
    await this.pool.execute<ResultSetHeader>(
      `UPDATE featured_question_sets
          SET review_status = 'pending', reviewed_by = NULL, reviewed_at = NULL
        WHERE id = ? AND review_status = 'rejected'`,
      [setId],
    );
  }

  /** 撤回只改 publication 状态与审计字段；阅读与作答历史一律保留。 */
  async withdraw(publicationId: number, reviewerId: number): Promise<void> {
    const conn = await this.pool.getConnection();
    try {
      await conn.beginTransaction();
      await conn.execute<ResultSetHeader>(
        `UPDATE featured_question_set_publications
            SET status = 'withdrawn', withdrawn_by = ?, withdrawn_at = NOW(3)
          WHERE id = ? AND status = 'published'`,
        [reviewerId, publicationId],
      );
      await conn.commit();
    } catch (err) {
      await conn.rollback();
      throw err;
    } finally {
      conn.release();
    }
  }

  /** 学生完整列表：目标年级 + published + 至少一题在架；questionCount 取当前在架题数。 */
  async listStudentPublications(
    studentId: number,
    gradeCode: string,
    page = 1,
    pageSize = 20,
  ): Promise<{ items: StudentFeaturedPublication[]; total: number }> {
    const [countRows] = await this.pool.execute<(RowDataPacket & { cnt: number | string })[]>(
      `SELECT COUNT(*) AS cnt FROM (
         SELECT p.id, ${AVAILABLE_COUNT_SQL} AS available_count
           FROM featured_question_set_publications p
          WHERE p.status = 'published' AND p.grade_code = ?
       ) t WHERE t.available_count > 0`,
      [gradeCode],
    );
    const total = Number(countRows[0]?.cnt ?? 0);
    const offset = Math.max(0, (page - 1) * pageSize);

    // LIMIT ? 必须走 pool.query（客户端转义）：MySQL 预处理语句拒绝 LIMIT 占位符。
    const [rows] = await this.pool.query<(RowDataPacket & {
      publication_id: number;
      set_id: number;
      title: string;
      subject_id: number;
      subject_name: string;
      published_at: Date;
      available_count: number | string;
      is_read: number | boolean;
    })[]>(
      `SELECT t.publication_id, t.set_id, t.title, t.subject_id, t.subject_name,
              t.published_at, t.available_count,
              (r.student_id IS NOT NULL) AS is_read
         FROM (
           SELECT p.id AS publication_id, p.set_id, p.title, s.subject_id,
                  subj.name AS subject_name, p.published_at,
                  ${AVAILABLE_COUNT_SQL} AS available_count
             FROM featured_question_set_publications p
             JOIN featured_question_sets s ON s.id = p.set_id
             JOIN subjects subj ON subj.id = s.subject_id
            WHERE p.status = 'published' AND p.grade_code = ?
         ) t
         LEFT JOIN featured_question_set_reads r
                ON r.publication_id = t.publication_id AND r.student_id = ?
        WHERE t.available_count > 0
        ORDER BY t.published_at DESC
        LIMIT ? OFFSET ?`,
      [gradeCode, studentId, pageSize, offset],
    );

    return {
      items: rows.map((r) => ({
        publicationId: Number(r.publication_id),
        setId: Number(r.set_id),
        title: r.title,
        subjectId: Number(r.subject_id),
        subjectName: r.subject_name,
        questionCount: Number(r.available_count),
        publishedAt: r.published_at,
        isRead: Boolean(r.is_read),
      })),
      total,
    };
  }

  /** 未读数与最新一条；口径与学生列表一致（published / 目标年级 / 在架 / 未读）。 */
  async unreadSummary(studentId: number, gradeCode: string): Promise<FeaturedUnreadSummary> {
    const [countRows] = await this.pool.execute<(RowDataPacket & { c: number | string })[]>(
      `SELECT COUNT(*) AS c FROM (
         SELECT p.id, ${AVAILABLE_COUNT_SQL} AS available_count
           FROM featured_question_set_publications p
          WHERE p.status = 'published' AND p.grade_code = ?
            AND NOT EXISTS (
              SELECT 1 FROM featured_question_set_reads r
               WHERE r.publication_id = p.id AND r.student_id = ?
            )
       ) t WHERE t.available_count > 0`,
      [gradeCode, studentId],
    );

    const [latestRows] = await this.pool.execute<(RowDataPacket & {
      publicationId: number;
      title: string;
    })[]>(
      `SELECT p.id AS publicationId, p.title
         FROM featured_question_set_publications p
        WHERE p.status = 'published' AND p.grade_code = ?
          AND NOT EXISTS (
            SELECT 1 FROM featured_question_set_reads r
             WHERE r.publication_id = p.id AND r.student_id = ?
          )
          AND ${AVAILABLE_COUNT_SQL} > 0
        ORDER BY p.published_at DESC
        LIMIT 1`,
      [gradeCode, studentId],
    );

    const latest = latestRows[0];
    return {
      count: Number(countRows[0]?.c ?? 0),
      latest: latest ? { publicationId: Number(latest.publicationId), title: latest.title } : null,
    };
  }

  /**
   * open 事务内使用：先锁 publication 再读在架题，题目按 sort_order, q.sub_no 排序。
   *
   * 锁只在传入事务连接（executor）时真正生效——autocommit 下 SELECT ... FOR UPDATE
   * 语句结束即释放。Task 6 的 open 必须把同一事务连接传进来（设计 §6.1 步骤 1），
   * 这样并发的 withdraw / 重新发布会被串行化，不会读到已撤回或换题后的题单。
   */
  async findOpenPublication(
    publicationId: number,
    gradeCode: string,
    executor?: PoolConnection,
  ): Promise<OpenPublicationResult | null> {
    const db = executor ?? this.pool;
    const [pubRows] = await db.execute<(RowDataPacket & {
      publication_id: number;
      set_id: number;
      title: string;
      subject_id: number;
    })[]>(
      `SELECT p.id AS publication_id, p.set_id, p.title, s.subject_id
         FROM featured_question_set_publications p
         JOIN featured_question_sets s ON s.id = p.set_id
        WHERE p.id = ? AND p.grade_code = ? AND p.status = 'published'
        FOR UPDATE`,
      [publicationId, gradeCode],
    );
    const pub = pubRows[0];
    if (!pub) return null;

    const [questionRows] = await db.execute<(RowDataPacket & FeaturedSourceQuestion)[]>(
      `SELECT q.id, q.subject_id, q.content, q.type, q.options, q.answer, q.explanation,
              q.material_text, q.material_url, q.sub_no, q.source,
              ${PAPER_QUESTION_NO_SQL} AS question_no
         FROM featured_question_set_items fqsi
         JOIN questions q ON q.id = fqsi.question_id
        WHERE fqsi.set_id = ? AND q.is_active = 1
        ORDER BY fqsi.sort_order, q.sub_no`,
      [pub.set_id],
    );
    // 与学生列表/未读数同口径：0 道在架题视为不可投递（service 侧对应 1002，不写已读）。
    if (questionRows.length === 0) return null;

    return {
      publicationId: Number(pub.publication_id),
      setId: Number(pub.set_id),
      title: pub.title,
      subjectId: Number(pub.subject_id),
      questions: questionRows as FeaturedSourceQuestion[],
    };
  }

  async markRead(
    publicationId: number,
    studentId: number,
    executor?: PoolConnection,
  ): Promise<void> {
    const db = executor ?? this.pool;
    await db.execute<ResultSetHeader>(
      `INSERT IGNORE INTO featured_question_set_reads (publication_id, student_id)
       VALUES (?, ?)`,
      [publicationId, studentId],
    );
  }
}
