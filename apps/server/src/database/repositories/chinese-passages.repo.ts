import { Injectable, Inject } from '@nestjs/common';
import type { Pool, RowDataPacket } from 'mysql2/promise';

export interface ChinesePassageRow extends RowDataPacket {
  id: number;
  work_title: string;
  author: string;
  dynasty: string;
  body: string;
  // mysql2 读 JSON 列**已自动 parse**（拿到的是数组/对象，不是字符串）——不要再 JSON.parse。
  key_terms: unknown;
  sentences: unknown;
  full_translation: string | null;
  grade_band: string;
  grade: string | null;
  semester: string;
  sort_order: number;
  source_ref: string | null;
  verified: number;
  memorize_required: number;
  is_active: number;
}

/** 解释专项：一个重点字词。`sentenceIndex` 指向 `sentences` 的下标（「属于哪一句」）。 */
export interface PassageKeyTerm {
  term: string;
  gloss: string;
  /** 来源：`textbook` 教材注释 / `llm` 模型补 —— 仅留痕，判题不用 */
  src?: string;
  sentenceIndex: number;
}

/** 解释专项：一句话。不变式 `''.join(s.text) == body`（逐字含标点），入库自检断言。 */
export interface PassageSentence {
  text: string;
  translation: string;
}

/**
 * JSON 列 → 句数组。**坏形状一律降级为空数组**，绝不抛错：
 * 库里的 JSON 是内容管线写进去的，但手工改库/迁移中途都可能留下半截数据，
 * 让它们把整个接口 500 掉不值得——空数组会让该篇被抽题池过滤掉，是安全的降级方向。
 */
export function toSentences(raw: unknown): PassageSentence[] {
  if (!Array.isArray(raw)) return [];
  const out: PassageSentence[] = [];
  for (const item of raw) {
    if (item == null || typeof item !== 'object') continue;
    const { text, translation } = item as Record<string, unknown>;
    if (typeof text !== 'string' || text === '') continue;
    out.push({ text, translation: typeof translation === 'string' ? translation : '' });
  }
  return out;
}

/**
 * JSON 列 → 字词数组。**`sentenceIndex` 不是整数的一律丢弃**——
 * 挂不到句子的字词在答题页没有落点（学生没处填），留着只会变成看不见的死数据
 * （设计裁决见 plan §7.4）。
 */
export function toKeyTerms(raw: unknown): PassageKeyTerm[] {
  if (!Array.isArray(raw)) return [];
  const out: PassageKeyTerm[] = [];
  for (const item of raw) {
    if (item == null || typeof item !== 'object') continue;
    const { term, gloss, src, sentenceIndex } = item as Record<string, unknown>;
    if (typeof term !== 'string' || term === '') continue;
    if (!Number.isInteger(sentenceIndex)) continue;
    out.push({
      term,
      gloss: typeof gloss === 'string' ? gloss : '',
      ...(typeof src === 'string' ? { src } : {}),
      sentenceIndex: sentenceIndex as number,
    });
  }
  return out;
}

export interface ChinesePassageUpsertInput {
  workTitle: string;
  author: string;
  dynasty: string;
  body: string;
  gradeBand: string;
  grade: string | null;
  semester: string;
  sortOrder: number;
  sourceRef: string | null;
  verified: number;
  memorizeRequired: number;
}

const SELECT_COLS = `dp.id, dp.work_title, dp.author, dp.dynasty, dp.body,
  dp.key_terms, dp.sentences, dp.full_translation,
  dp.grade_band, dp.grade, dp.semester, dp.sort_order, dp.source_ref, dp.verified,
  dp.memorize_required, dp.is_active`;

/** 解释专项抽题池的两个共同谓词：已校验 + 未停用 + **内容就绪**（切过句才出题）。 */
const INTERPRETATION_GATE = `dp.verified = 1 AND dp.is_active = 1 AND JSON_LENGTH(dp.sentences) > 0`;

/**
 * 题面由篇名生成——**全系统唯一口径**。
 *
 * 题面**不落库**：作者 / 朝代 / 正文才是学生要默写的答案字段，写进题面等于泄题；
 * 而 `questions.content` 那条老路还要为它付 `content_hash` 的代价（正文一改 hash 就变）。
 */
export function buildDictationPrompt(workTitle: string): string {
  return `请默写《${workTitle}》`;
}

/**
 * 语文古诗文专项篇目 repo。
 *
 * **独立子系统**（2026-09-15）：本表不挂 `questions`、无外键，因此三条抽题查询
 * 不再 `JOIN questions`——原先由 `questions` 承担的三件事改由本表承担：
 *   题面 `content` → 由 `work_title` 生成（`buildDictationPrompt`，不落库）
 *   学科 `subject_id = 2` → 表本身就是语文，谓词取消
 *   停用 `is_active` → 本表自己的 `is_active` 列
 * 「不再展示」(`student_hidden_questions`) 与错题本已按设计**整体移除**。
 */
@Injectable()
export class ChinesePassagesRepository {
  constructor(@Inject('DATABASE_POOL') private readonly pool: Pool) {}

  /** 判定路径按篇目 id 取单篇。**有意不设门禁**——见 spec §6 的守卫适用范围说明。 */
  async findById(passageId: number): Promise<ChinesePassageRow | null> {
    const [rows] = await this.pool.execute<ChinesePassageRow[]>(
      `SELECT ${SELECT_COLS} FROM chinese_passages dp WHERE dp.id = ? LIMIT 1`,
      [passageId],
    );
    return rows[0] ?? null;
  }

  /** 配置页清单：默写专项抽题池（三道闸门） */
  async findVerifiedForDictation(): Promise<ChinesePassageRow[]> {
    const [rows] = await this.pool.execute<ChinesePassageRow[]>(
      `SELECT ${SELECT_COLS} FROM chinese_passages dp
       WHERE dp.verified = 1 AND dp.memorize_required = 1 AND dp.is_active = 1
       ORDER BY dp.sort_order, dp.id`,
    );
    return rows;
  }

  /** 随机抽篇（semester=null 即「全部册次」） */
  async findRandomVerified(semester: string | null, count: number): Promise<ChinesePassageRow[]> {
    const params: unknown[] = [];
    // 抽题池 = 已校验 且 必背：verified 只说内容对，memorize_required 才是教学上要背的。
    let sql = `SELECT ${SELECT_COLS} FROM chinese_passages dp
       WHERE dp.verified = 1 AND dp.memorize_required = 1 AND dp.is_active = 1`;
    if (semester != null) {
      sql += ' AND dp.semester = ?';
      params.push(semester);
    } else {
      // 「全部册次」时按**篇名**去重：实测九上/九下有 9 篇重复收录（两册的第六单元都是
      // 文言文单元，同一篇各印一次，如《出师表》上册第 26 课、下册第 23 课），
      // 业务键含 semester 故会各存一行 → 不过滤册次时同一篇可能被抽到两次。
      // 每个篇名只取一行（最小 id，确定性）。
      // ⚠️ 只在无册次过滤时加：子查询跨册取 MIN(id)，若外层已按册过滤会把该册的行
      // 整体排除掉（上册行 id 更小 → 下册行不等于它）。
      sql += ` AND dp.id = (
        SELECT MIN(dp2.id) FROM chinese_passages dp2
          WHERE dp2.work_title = dp.work_title
            AND dp2.verified = 1 AND dp2.memorize_required = 1 AND dp2.is_active = 1
      )`;
    }
    sql += ' ORDER BY RAND() LIMIT ?';
    params.push(count);
    // LIMIT ? 不能走 prepared statement（mysql2 execute 报 Incorrect arguments），用 query
    const [rows] = await this.pool.query<ChinesePassageRow[]>(sql, params);
    return rows;
  }

  /** 指定篇目出题（按 id 批量取，忽略册次） */
  async findVerifiedByIds(passageIds: number[]): Promise<ChinesePassageRow[]> {
    if (passageIds.length === 0) return [];
    const placeholders = passageIds.map(() => '?').join(',');
    const [rows] = await this.pool.execute<ChinesePassageRow[]>(
      `SELECT ${SELECT_COLS} FROM chinese_passages dp
       WHERE dp.verified = 1 AND dp.memorize_required = 1 AND dp.is_active = 1
         AND dp.id IN (${placeholders})`,
      [...passageIds],
    );
    return rows;
  }

  // ==================== 解释（翻译）专项（2026-09-16） ====================
  //
  // 抽题池与默写的差别（都是**有意**的，不要「统一」掉）：
  //   不设 memorize_required —— 「要背诵」不是「要理解翻译」的必要条件
  //   增设「内容就绪」        —— 没切过句的篇目点进去没题目

  /** 配置页清单：解释专项抽题池（verified + is_active + 内容就绪） */
  async findVerifiedForInterpretation(): Promise<ChinesePassageRow[]> {
    const [rows] = await this.pool.execute<ChinesePassageRow[]>(
      `SELECT ${SELECT_COLS} FROM chinese_passages dp
       WHERE ${INTERPRETATION_GATE}
       ORDER BY dp.sort_order, dp.id`,
    );
    return rows;
  }

  /** 解释专项随机抽篇（semester=null 即「全部册次」） */
  async findRandomVerifiedForInterpretation(
    semester: string | null,
    count: number,
  ): Promise<ChinesePassageRow[]> {
    const params: unknown[] = [];
    let sql = `SELECT ${SELECT_COLS} FROM chinese_passages dp
       WHERE ${INTERPRETATION_GATE}`;
    if (semester != null) {
      sql += ' AND dp.semester = ?';
      params.push(semester);
    } else {
      // 「全部册次」按**篇名**去重（同 findRandomVerified）：九上/九下有 9 篇重复收录
      // （同一篇两册各印一次，业务键含 semester 故各存一行），不过滤册次时同一篇会被抽到两次。
      // ⚠️ 只在无册次过滤时加：子查询跨册取 MIN(id)，外层若已按册过滤会把该册的行整体排除掉。
      sql += ` AND dp.id = (
        SELECT MIN(dp2.id) FROM chinese_passages dp2
          WHERE dp2.work_title = dp.work_title
            AND dp2.verified = 1 AND dp2.is_active = 1
            AND JSON_LENGTH(dp2.sentences) > 0
      )`;
    }
    sql += ' ORDER BY RAND() LIMIT ?';
    params.push(count);
    // LIMIT ? 不能走 prepared statement（mysql2 execute 报 Incorrect arguments），用 query
    const [rows] = await this.pool.query<ChinesePassageRow[]>(sql, params);
    return rows;
  }

  /** 解释专项指定篇目出题（按 id 批量取，忽略册次） */
  async findVerifiedByIdsForInterpretation(passageIds: number[]): Promise<ChinesePassageRow[]> {
    if (passageIds.length === 0) return [];
    const placeholders = passageIds.map(() => '?').join(',');
    const [rows] = await this.pool.execute<ChinesePassageRow[]>(
      `SELECT ${SELECT_COLS} FROM chinese_passages dp
       WHERE ${INTERPRETATION_GATE}
         AND dp.id IN (${placeholders})`,
      [...passageIds],
    );
    return rows;
  }

  /**
   * 按 (work_title, semester) 业务主键 upsert：正文修正后重跑仍更新同一行（幂等）。
   *
   * ⚠️ 注意：**这里按入参覆盖 `memorize_required`**（调用方显式给出该值，如后台管理/
   * 开发种子）。内容管线的 loader（`tools/data-refinery/src/dictation_loader.py`）
   * **刻意不在它的冲突分支动这一列**——否则重跑管线会把用户标好的「必背」刷回 0。
   * 两处写法**不一致是有意的**，不要为了「统一」把 loader 也改成覆盖。
   */
  async upsert(row: ChinesePassageUpsertInput): Promise<void> {
    await this.pool.execute(
      `INSERT INTO chinese_passages
         (work_title, author, dynasty, body, grade_band, grade, semester,
          sort_order, source_ref, verified, memorize_required)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE
         author = VALUES(author), dynasty = VALUES(dynasty),
         body = VALUES(body), grade_band = VALUES(grade_band), grade = VALUES(grade),
         sort_order = VALUES(sort_order), source_ref = VALUES(source_ref), verified = VALUES(verified),
         memorize_required = VALUES(memorize_required)`,
      [
        row.workTitle, row.author, row.dynasty, row.body,
        row.gradeBand, row.grade, row.semester, row.sortOrder, row.sourceRef, row.verified,
        row.memorizeRequired,
      ],
    );
  }
}
