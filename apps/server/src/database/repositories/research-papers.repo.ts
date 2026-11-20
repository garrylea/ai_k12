import { Inject, Injectable, Logger } from '@nestjs/common';
import type { Pool, RowDataPacket } from 'mysql2/promise';
import { ContentAuditRepository, type AuditActor } from './content-audit.repo.js';

export interface AdminPaperFilters {
  subjectId?: number;
  year?: number;
  gradeBand?: string;
  keyword?: string;
  page: number;
  pageSize: number;
}

export interface AdminPaperListRow extends RowDataPacket {
  id: number;
  subject_id: number;
  subject_name: string;
  title: string;
  grade: string | null;
  grade_band: string | null;
  semester: string | null;
  year: number | null;
  district: string | null;
  exam_type: string | null;
  source_key: string;
  created_at: Date;
  linked_question_count: number;
  session_count: number;
}

export interface PaperImpact {
  questionCount: number;
  sharedCount: number;
  exclusiveCount: number;
  deletableCount: number;
  retainedCount: number;
  sessionCount: number;
  answerCount: number;
}

export interface PaperDeleteOutcome {
  paperTitle: string;
  deletedQuestions: number;
  retainedQuestions: number;
  deletedSessions: number;
  deletedAnswers: number;
}

/** 删除题时会触发 ON DELETE RESTRICT 的表（schema 固定 7 张，勿凭印象增删）。 */
const BLOCKING_TABLES = [
  'main_error_books',
  'aux_error_books',
  'answers',
  'exam_answers',
  'variation_questions',
  'special_answer_records',
  'remediation_set_items',
] as const;

/** 只用到 execute 的最小执行器接口（Pool 与 PoolConnection 都满足）。 */
type Queryable = {
  execute(sql: string, values?: unknown): Promise<unknown>;
};

function escapeLike(input: string): string {
  return input.replace(/[\\%_]/g, (ch) => `\\${ch}`);
}

/** 卷内独占题 id（不被其它卷引用）。 */
async function findExclusiveIds(db: Queryable, paperId: number): Promise<number[]> {
  const result = (await db.execute(
    `SELECT pq.question_id AS qid FROM paper_questions pq
      WHERE pq.paper_id = ?
        AND NOT EXISTS (
          SELECT 1 FROM paper_questions x
           WHERE x.question_id = pq.question_id AND x.paper_id <> ?
        )`,
    [paperId, paperId],
  )) as [Array<{ qid: number }>, unknown];
  return result[0].map((r) => Number(r.qid));
}

/** 在被学生数据引用的题 id 集合。
 *  `exam_answers` 必须排除本卷会话：这些会话执行删除时先清掉，算进来会让预览虚高。 */
async function findBlockedIds(db: Queryable, ids: number[], paperId: number): Promise<Set<number>> {
  if (ids.length === 0) return new Set();
  const placeholders = ids.map(() => '?').join(',');
  const branches = [
    ...BLOCKING_TABLES
      .filter((t) => t !== 'exam_answers')
      .map((t) => ({
        sql: `SELECT question_id AS qid FROM ${t} WHERE question_id IN (${placeholders})`,
        params: ids,
      })),
    {
      sql: `SELECT question_id AS qid FROM exam_answers
             WHERE question_id IN (${placeholders})
               AND session_id NOT IN (SELECT id FROM exam_sessions WHERE paper_id = ?)`,
      params: [...ids, paperId],
    },
  ];
  const union = branches.map((b) => b.sql).join(' UNION ALL ');
  const params = branches.flatMap((b) => b.params);
  const result = (await db.execute(
    `SELECT DISTINCT qid FROM (${union}) t`,
    params,
  )) as [Array<{ qid: number }>, unknown];
  return new Set(result[0].map((r) => Number(r.qid)));
}

/**
 * 教研端试卷仓储（由 admin-papers.repo.ts 迁移，SQL 规则原样保留）。
 *
 * 列表分页用 `pool.query`：mysql2 的 `execute` 对 `LIMIT ?` 会预编译失败
 * （护栏测试 `limit-placeholder.guard.test.ts`）。计数/详情用 execute。
 */
@Injectable()
export class ResearchPapersRepository {
  private readonly logger = new Logger(ResearchPapersRepository.name);

  constructor(
    @Inject('DATABASE_POOL') private readonly pool: Pool,
    private readonly audit: ContentAuditRepository,
  ) {}

  async findPapers(filters: AdminPaperFilters): Promise<{ items: AdminPaperListRow[]; total: number }> {
    const where: string[] = [];
    const params: Array<number | string> = [];
    if (filters.subjectId !== undefined) {
      where.push('p.subject_id = ?');
      params.push(filters.subjectId);
    }
    if (filters.year !== undefined) {
      where.push('p.year = ?');
      params.push(filters.year);
    }
    if (filters.gradeBand !== undefined && filters.gradeBand !== '') {
      where.push('p.grade_band = ?');
      params.push(filters.gradeBand);
    }
    if (filters.keyword !== undefined && filters.keyword !== '') {
      where.push("p.title LIKE ? ESCAPE '\\\\'");
      params.push(`%${escapeLike(filters.keyword)}%`);
    }
    const whereSql = where.length > 0 ? `WHERE ${where.join(' AND ')}` : '';

    const [countRows] = await this.pool.execute<RowDataPacket[]>(
      `SELECT COUNT(*) AS total FROM exam_papers p ${whereSql}`,
      params,
    );
    const [rows] = await this.pool.query<AdminPaperListRow[]>(
      `SELECT p.id, p.subject_id, s.name AS subject_name, p.title, p.grade, p.grade_band,
              p.semester, p.year, p.district, p.exam_type, p.source_key, p.created_at,
              (SELECT COUNT(*) FROM paper_questions pq WHERE pq.paper_id = p.id) AS linked_question_count,
              (SELECT COUNT(*) FROM exam_sessions es WHERE es.paper_id = p.id) AS session_count
         FROM exam_papers p JOIN subjects s ON s.id = p.subject_id
         ${whereSql}
        ORDER BY p.id DESC
        LIMIT ? OFFSET ?`,
      [...params, filters.pageSize, (filters.page - 1) * filters.pageSize],
    );
    return { items: rows, total: Number(countRows[0]?.total ?? 0) };
  }

  async findPaper(id: number): Promise<{ id: number; title: string; subjectName: string } | null> {
    const [rows] = await this.pool.execute<RowDataPacket[]>(
      `SELECT p.id, p.title, s.name AS subject_name
         FROM exam_papers p JOIN subjects s ON s.id = p.subject_id
        WHERE p.id = ?`,
      [id],
    );
    const row = rows[0];
    if (!row) return null;
    return { id: Number(row.id), title: String(row.title), subjectName: String(row.subject_name) };
  }

  /** 试卷详情：先取卷元信息（不存在直接 null），再按卷内题号取题目原始字段。 */
  async findPaperDetail(paperId: number): Promise<{
    paper: Record<string, unknown>; questions: Record<string, unknown>[];
  } | null> {
    const [paperRows] = await this.pool.execute<RowDataPacket[]>(
      `SELECT p.*, s.name AS subject_name FROM exam_papers p
         JOIN subjects s ON s.id = p.subject_id WHERE p.id = ?`, [paperId],
    );
    if (paperRows.length === 0) return null;
    const [rows] = await this.pool.execute<RowDataPacket[]>(
      `SELECT q.id, pq.question_no, q.type, q.difficulty, q.full_score, q.content, q.options,
              q.answer, q.explanation, q.approach, q.source, q.source_year,
              q.answer_verified, q.is_active
         FROM paper_questions pq JOIN questions q ON q.id = pq.question_id
        WHERE pq.paper_id = ? ORDER BY pq.question_no`, [paperId],
    );
    return { paper: paperRows[0], questions: rows };
  }

  /**
   * 删卷前收集「真正会被物理删除的独占题」五字段里的 research 图 URL。
   * 用与 deletePaperCascade 同一套 exclusive/blocked 口径：共享题与被学生数据引用的
   * 独占题都保留，其图不能清。结果供 service 在删卷 commit 后调 cleanupUnreferenced。
   */
  async findResearchImageUrlsByPaper(paperId: number): Promise<string[]> {
    const exclusiveIds = await findExclusiveIds(this.pool, paperId);
    const blocked = await findBlockedIds(this.pool, exclusiveIds, paperId);
    const deletable = exclusiveIds.filter((id) => !blocked.has(id));
    if (deletable.length === 0) return [];
    const ph = deletable.map(() => '?').join(',');
    const [rows] = await this.pool.execute<RowDataPacket[]>(
      `SELECT content, options, answer, explanation, approach FROM questions WHERE id IN (${ph})`,
      deletable,
    );
    const re = /\/uploads\/research\/[0-9a-f-]+(?:\.[a-zA-Z0-9]+)?/g;
    return [...new Set(rows.flatMap((r) =>
      ['content', 'options', 'answer', 'explanation', 'approach']
        .flatMap((k) => String(r[k] ?? '').match(re) ?? []))),
    ];
  }

  async countImpact(paperId: number): Promise<PaperImpact> {
    const [questionRows] = await this.pool.execute<RowDataPacket[]>(
      'SELECT COUNT(*) AS cnt FROM paper_questions WHERE paper_id = ?',
      [paperId],
    );
    const [sharedRows] = await this.pool.execute<RowDataPacket[]>(
      `SELECT COUNT(*) AS cnt FROM paper_questions pq
        WHERE pq.paper_id = ?
          AND EXISTS (
            SELECT 1 FROM paper_questions x
             WHERE x.question_id = pq.question_id AND x.paper_id <> ?
          )`,
      [paperId, paperId],
    );
    const [sessionRows] = await this.pool.execute<RowDataPacket[]>(
      'SELECT COUNT(*) AS cnt FROM exam_sessions WHERE paper_id = ?',
      [paperId],
    );
    const [answerRows] = await this.pool.execute<RowDataPacket[]>(
      `SELECT COUNT(*) AS cnt FROM exam_answers ea
         JOIN exam_sessions es ON es.id = ea.session_id
        WHERE es.paper_id = ?`,
      [paperId],
    );

    const exclusiveIds = await findExclusiveIds(this.pool, paperId);
    const blocked = await findBlockedIds(this.pool, exclusiveIds, paperId);

    const questionCount = Number(questionRows[0]?.cnt ?? 0);
    const sharedCount = Number(sharedRows[0]?.cnt ?? 0);
    return {
      questionCount,
      sharedCount,
      exclusiveCount: exclusiveIds.length,
      deletableCount: exclusiveIds.length - blocked.size,
      retainedCount: blocked.size,
      sessionCount: Number(sessionRows[0]?.cnt ?? 0),
      answerCount: Number(answerRows[0]?.cnt ?? 0),
    };
  }

  /**
   * 单事务级联删除：会话（级联作答）→ 可删独占题 → 试卷（级联剩余关联）→ paper.delete 审计。
   *
   * 顺序不可换：先删本卷会话，后面查到的 `exam_answers` 引用才只来自其它来源。
   * 审计必须走同一 `conn`（spec §9.2）：插不进去就整笔回滚，卷不会被删。
   * 返回 null 表示卷不存在（service 转 404）；外键冲突原样抛（service 转 409）。
   */
  async deletePaperCascade(paperId: number, actor: AuditActor): Promise<PaperDeleteOutcome | null> {
    const conn = await this.pool.getConnection();
    try {
      await conn.beginTransaction();
      const [paperRows] = await conn.execute<RowDataPacket[]>(
        'SELECT id, title FROM exam_papers WHERE id = ? FOR UPDATE',
        [paperId],
      );
      if (paperRows.length === 0) {
        await conn.rollback();
        return null;
      }
      const paperTitle = String(paperRows[0].title);

      const [sessionRows] = await conn.execute<RowDataPacket[]>(
        'SELECT COUNT(*) AS cnt FROM exam_sessions WHERE paper_id = ?',
        [paperId],
      );
      const [answerRows] = await conn.execute<RowDataPacket[]>(
        'SELECT COUNT(*) AS cnt FROM exam_answers ea JOIN exam_sessions es ON es.id = ea.session_id WHERE es.paper_id = ?',
        [paperId],
      );
      const deletedSessions = Number(sessionRows[0]?.cnt ?? 0);
      const deletedAnswers = Number(answerRows[0]?.cnt ?? 0);

      await conn.execute('DELETE FROM exam_sessions WHERE paper_id = ?', [paperId]);

      const exclusiveIds = await findExclusiveIds(conn, paperId);
      const blocked = await findBlockedIds(conn, exclusiveIds, paperId);
      const deletable = exclusiveIds.filter((id) => !blocked.has(id));
      if (deletable.length > 0) {
        const placeholders = deletable.map(() => '?').join(',');
        await conn.execute(`DELETE FROM questions WHERE id IN (${placeholders})`, deletable);
      }

      await conn.execute('DELETE FROM exam_papers WHERE id = ?', [paperId]);

      // 同一事务连接写审计：审计失败会被下面的 catch 回滚，卷不会被删。
      await this.audit.appendOnConnection(conn, {
        actorId: actor.sub,
        actorRole: actor.role,
        actorName: actor.name ?? null,
        action: 'paper.delete',
        targetType: 'paper',
        targetId: paperId,
        paperId,
      });

      await conn.commit();

      return {
        paperTitle,
        deletedQuestions: deletable.length,
        retainedQuestions: exclusiveIds.length - deletable.length,
        deletedSessions,
        deletedAnswers,
      };
    } catch (err) {
      // rollback 失败绝不能盖掉原始错误（否则调用方只看到 rollback 异常）。
      try {
        await conn.rollback();
      } catch (rollbackErr) {
        this.logger.warn(`rollback 失败（原错误仍抛出）：${String(rollbackErr)}`);
      }
      throw err;
    } finally {
      conn.release();
    }
  }
}
