import { Injectable, Inject } from '@nestjs/common';
import type { Pool, RowDataPacket } from 'mysql2/promise';
import {
  ENGLISH_LEVELS,
  type EnglishLevel,
  type EnglishWordMeaning,
  type LevelPool,
  type RootAffix,
  levelsForPool,
} from '../../common/utils/normalize-english.util.js';

export interface EnglishWordRow extends RowDataPacket {
  id: number;
  word: string;
  phonetic: string | null;
  level: string;
  // mysql2 读 JSON 列**已自动 parse**（拿到的是数组/对象，不是字符串）——不要再 JSON.parse。
  meanings: unknown;
  has_extended_sense: number;
  root_key: string | null;
  root_affixes: unknown;
  error_count: number;
  sort_order: number;
  source_ref: string | null;
  verified: number;
  is_active: number;
}

/** 抽题池只取「选词」需要的最小列，**绝不带 meanings**（题面在挑题阶段不能含答案）。 */
export interface EnglishWordPoolRow extends RowDataPacket {
  id: number;
  word: string;
  level: string;
  has_extended_sense: number;
  error_count: number;
  sort_order: number;
}

/**
 * JSON 列 → 义项数组。**坏形状一律降级为空数组**，绝不抛错（同 toSentences/toKeyTerms 的理据：
 * 手工改库/迁移中途的半截数据不值得把接口 500 掉；空义项会让该词在选词阶段被过滤掉，
 * 是安全的降级方向）。
 *
 * `extended` 缺省 false（**默认按常见义处理**）：这一列读错方向的代价不对称——
 * 把僻义误当常见义，最坏是学生答了常见义却判错（可在结果页看到标准释义纠正）；
 * 反过来把常见义误当僻义，会让普通背词凭空冒出「僻义题」并迫使学生答一个他没学过的义项。
 */
export function toMeanings(raw: unknown): EnglishWordMeaning[] {
  if (!Array.isArray(raw)) return [];
  const out: EnglishWordMeaning[] = [];
  for (const item of raw) {
    if (item == null || typeof item !== 'object') continue;
    const { pos, gloss, extended, context, note } = item as Record<string, unknown>;
    if (typeof gloss !== 'string' || gloss === '') continue;
    out.push({
      pos: typeof pos === 'string' ? pos : '',
      gloss,
      extended: extended === true,
      ...(typeof context === 'string' && context !== '' ? { context } : {}),
      ...(typeof note === 'string' && note !== '' ? { note } : {}),
    });
  }
  return out;
}

/**
 * JSON 列 → 词缀注记数组。`type` 非 prefix/suffix 或 `code` 为空的项丢弃
 * （渲染不出来，留着是看不见的死数据）；`gloss` 缺省补空串（只有词缀形态没释义也还能显示）。
 */
export function toRootAffixes(raw: unknown): RootAffix[] {
  if (!Array.isArray(raw)) return [];
  const out: RootAffix[] = [];
  for (const item of raw) {
    if (item == null || typeof item !== 'object') continue;
    const { type, code, gloss, posHint } = item as Record<string, unknown>;
    if (type !== 'prefix' && type !== 'suffix') continue;
    if (typeof code !== 'string' || code === '') continue;
    out.push({
      type,
      code,
      gloss: typeof gloss === 'string' ? gloss : '',
      ...(typeof posHint === 'string' && posHint !== '' ? { posHint } : {}),
    });
  }
  return out;
}

/** 配置页选词条件。服务层把请求 DTO 规整成它，SQL 构造只认它。 */
export interface VocabularyPoolFilter {
  levelPool: LevelPool;
  /** 「只出没背过的」：progress 行不存在或 learned = 0 */
  onlyNotLearned?: boolean;
  /** 「我错过的词」：学生自己的 wrong_count > 0 */
  onlyMyWrong?: boolean;
  /** 「易错词（全平台高频）」：全局 error_count > 0 */
  onlyCommonWrong?: boolean;
  /** 「只出熟词僻义」：has_extended_sense = 1 */
  onlyExtendedSense?: boolean;
  /** 「指定字母开头」：单字母 a-z */
  letter?: string | null;
  /** 学生筛选条件需要 JOIN 进度表时才用得上 */
  studentId?: number;
}

const SELECT_COLS = `ew.id, ew.word, ew.phonetic, ew.level, ew.meanings, ew.has_extended_sense,
  ew.root_key, ew.root_affixes, ew.error_count, ew.sort_order, ew.source_ref,
  ew.verified, ew.is_active`;

const POOL_COLS = `ew.id, ew.word, ew.level, ew.has_extended_sense, ew.error_count, ew.sort_order`;

/** 词库行必须过的两道闸门：内容已校验 + 未停用。抽题池一律带它。 */
const WORD_GATE = `ew.verified = 1 AND ew.is_active = 1`;

/**
 * 英语背单词词库 repo。
 *
 * **独立子系统**：本表不挂 `questions`、无外键、不参与主线清零门禁。
 * 抽题**不走 `ORDER BY RAND() + LIMIT ?`**（那要 `pool.query` 绕开 prepared statement，
 * 且无法表达四种顺序模式）——改成先取候选池的 id 列表、在 Node 里洗牌/排序切 N，
 * 再按 id 取详情。池子最大 3000 行且只取索引列，开销可忽略（见 spec §8.4）。
 */
@Injectable()
export class EnglishWordsRepository {
  constructor(@Inject('DATABASE_POOL') private readonly pool: Pool) {}

  /**
   * 判定路径按 id 取单个词。**有意不设门禁**（同 ChinesePassagesRepository.findById）：
   * 学生已经抽到的词中途被下架，也该能判出结果，而不是 404 把他的答题卡住。
   */
  async findById(wordId: number): Promise<EnglishWordRow | null> {
    const [rows] = await this.pool.execute<EnglishWordRow[]>(
      `SELECT ${SELECT_COLS} FROM english_words ew WHERE ew.id = ? LIMIT 1`,
      [wordId],
    );
    return rows[0] ?? null;
  }

  /**
   * 抽题候选池：满足全部门禁与筛选条件的词 id 列表（不带释义）。
   *
   * 学生维度的两个筛选（onlyNotLearned / onlyMyWrong）走 **LEFT JOIN** 进度表：
   *   - 必须 LEFT 而非 INNER——`onlyNotLearned` 要包含**从来没有进度行**的词
   *     （没背过 = 没行，INNER JOIN 会把它们全滤掉，正好滤反）
   *   - `onlyMyWrong` 在 LEFT JOIN 下等价于 INNER（`wrong_count > 0` 天然排除 NULL 行）
   * 两者的 SQL 形状相同，所以统一用 LEFT JOIN，不写两套。
   */
  async findPool(filter: VocabularyPoolFilter): Promise<EnglishWordPoolRow[]> {
    const levels = levelsForPool(filter.levelPool);
    const studentId = filter.studentId ?? null;
    const wantsStudentFilter = filter.onlyNotLearned === true || filter.onlyMyWrong === true;
    // 前置条件检查，**不要**降级成「静默忽略该筛选」：漏传 studentId 时若只是不加条件，
    // 查询会返回整个词库、看起来一切正常，学生却发现「只出没背过的」根本没生效——
    // 这类沉默的错误比直接报错难查得多。
    if (wantsStudentFilter && studentId === null) {
      throw new Error(
        'findPool: onlyNotLearned / onlyMyWrong 需要 studentId（否则该筛选会被静默忽略）',
      );
    }
    const params: (string | number)[] = [];
    let sql = `SELECT ${POOL_COLS} FROM english_words ew`;

    const needProgressJoin = wantsStudentFilter && studentId !== null;
    if (needProgressJoin) {
      // 注意参数顺序：JOIN 的 student_id 出现在 WHERE 之前，必须先 push
      sql += ` LEFT JOIN student_word_progress swp
                 ON swp.word_id = ew.id AND swp.student_id = ?`;
      params.push(studentId);
    }

    sql += ` WHERE ${WORD_GATE} AND ew.level IN (${levels.map(() => '?').join(',')})`;
    params.push(...levels);

    if (filter.onlyExtendedSense === true) {
      sql += ' AND ew.has_extended_sense = 1';
    }
    if (filter.onlyCommonWrong === true) {
      sql += ' AND ew.error_count > 0';
    }
    if (needProgressJoin) {
      // 没有进度行时 swp.learned 为 NULL —— `NULL = 0` 求值为 UNKNOWN 而非 TRUE，故必须显式写
      // IS NULL 分支，否则「只出没背过的」会把从没背过的词漏掉（正好滤反，本查询最易写错之处）。
      if (filter.onlyNotLearned === true) {
        sql += ' AND (swp.id IS NULL OR swp.learned = 0)';
      }
      if (filter.onlyMyWrong === true) {
        sql += ' AND swp.wrong_count > 0';
      }
    }

    if (filter.letter) {
      // 指定字母开头。用 LIKE 'a%' 而非 LEFT(word,1)=? —— 前者能走 uniq_english_words_word 索引。
      // 字母在服务层已白名单校验过 a-z，这里再兜一道，杜绝把通配符带进 LIKE。
      const letter = filter.letter.toLowerCase();
      if (/^[a-z]$/.test(letter)) {
        sql += ' AND ew.word LIKE ?';
        params.push(`${letter}%`);
      }
    }

    // 不在这里 ORDER BY / LIMIT：顺序模式（随机/正序/倒序）与截断都在服务层做，
    // 这样四种模式共用一条 SQL。带上 sort_order 让服务层的「课标原序」也有据可依。
    sql += ' ORDER BY ew.sort_order, ew.id';

    const [rows] = await this.pool.execute<EnglishWordPoolRow[]>(sql, params);
    return rows;
  }

  /** 按 id 批量取完整词条（抽题池切出 N 个后再取详情）。空数组直接返回，不查库。 */
  async findByIds(wordIds: number[]): Promise<EnglishWordRow[]> {
    if (wordIds.length === 0) return [];
    const placeholders = wordIds.map(() => '?').join(',');
    const [rows] = await this.pool.execute<EnglishWordRow[]>(
      `SELECT ${SELECT_COLS} FROM english_words ew
       WHERE ${WORD_GATE} AND ew.id IN (${placeholders})`,
      [...wordIds],
    );
    return rows;
  }

  /**
   * 取整个词根族。
   *
   * 族的定义就是「`root_key` 指向同一个中心词」——不建新表，中心词自己也是族内一行
   * （它的 `root_key` 等于自己的 `word`，这条不变式由内容管线 check 保证）。
   * 因此一句 `WHERE root_key = ?` 就能把 care / careful / careless / carefully 全取出来。
   */
  async findFamily(rootKey: string): Promise<EnglishWordRow[]> {
    const [rows] = await this.pool.execute<EnglishWordRow[]>(
      `SELECT ${SELECT_COLS} FROM english_words ew
       WHERE ${WORD_GATE} AND ew.root_key = ?
       ORDER BY ew.sort_order, ew.id`,
      [rootKey],
    );
    return rows;
  }

  /**
   * 全局错次自增（**只增**，不提供清零）。
   * 行级锁 + 自增表达式，多学生同时答错同一词也安全。
   * 学生自己的错次另存 progress 表，两者互不影响——「移除易错标记」只动学生那一份。
   */
  async incrementErrorCount(wordId: number): Promise<void> {
    await this.pool.execute(
      `UPDATE english_words SET error_count = error_count + 1 WHERE id = ?`,
      [wordId],
    );
  }

  /** 各层的词条数（配置页显示「仅初中 / 仅高中 / 全部」各有多少词）。 */
  async countByLevel(): Promise<{ level: EnglishLevel; count: number }[]> {
    const [rows] = await this.pool.execute<(RowDataPacket & { level: string; count: number })[]>(
      `SELECT ew.level, COUNT(*) AS count FROM english_words ew
       WHERE ${WORD_GATE}
       GROUP BY ew.level`,
    );
    const found = new Map(rows.map((r) => [r.level as EnglishLevel, Number(r.count)]));
    // 补齐 0：某一层还没有内容时配置页也要显示 0，而不是整项消失
    return ENGLISH_LEVELS.map((level) => ({ level, count: found.get(level) ?? 0 }));
  }

  /**
   * 配置页四个筛选各自的池子规模 + 已背过多少（一次聚合查询，不把 3000 行拉回来数）。
   *
   * 口径与 `findPool` 的对应筛选**必须一致**，否则会出现「显示 120 词，勾上却抽不到」：
   *   extended / commonWrong 只看词表列
   *   myWrong / learned 看进度表，故 LEFT JOIN（没进度行 = 没背过，同 findPool 的理据）
   */
  async countPoolStats(studentId: number): Promise<{
    total: number;
    extended: number;
    commonWrong: number;
    myWrong: number;
    learned: number;
  }> {
    const [rows] = await this.pool.execute<
      (RowDataPacket & {
        total: number;
        extended: number;
        commonWrong: number;
        myWrong: number;
        learned: number;
      })[]
    >(
      `SELECT
         COUNT(*) AS total,
         COUNT(CASE WHEN ew.has_extended_sense = 1 THEN 1 END) AS extended,
         COUNT(CASE WHEN ew.error_count > 0 THEN 1 END) AS commonWrong,
         COUNT(CASE WHEN swp.wrong_count > 0 THEN 1 END) AS myWrong,
         COUNT(CASE WHEN swp.learned = 1 THEN 1 END) AS learned
       FROM english_words ew
       LEFT JOIN student_word_progress swp ON swp.word_id = ew.id AND swp.student_id = ?
       WHERE ${WORD_GATE}`,
      [studentId],
    );
    const row = rows[0];
    return {
      total: Number(row?.total ?? 0),
      extended: Number(row?.extended ?? 0),
      commonWrong: Number(row?.commonWrong ?? 0),
      myWrong: Number(row?.myWrong ?? 0),
      learned: Number(row?.learned ?? 0),
    };
  }
}
