/**
 * 【开发假数据】英语背单词链路验证种子。
 *
 * 警告：这里的数据**不是生产词库**，仅为打通「训练 → 英语 → 背单词」链路。
 * 生产词库由内容管线导入（课标官方 PDF 附录词汇表：义务教育 2022 版 1600 词 +
 * 高中 2017 版 2020 修订 3000 词），见
 * docs/superpowers/specs/2026-09-16-english-vocabulary-special-design.md §6。
 * 每条以 `source_ref = 'DEV-FIXTURE'` 标记，便于后续清理。
 *
 * 覆盖到手工验证需要的全部形态：
 *   熟词僻义（address / book / subject / desert）、词根族（care 族、use 族）、
 *   拼写变体（colour / analyse）、带连字符与撇号（ice-cream / o'clock）、
 *   两个 level 层（junior / senior_required，好验证「仅高中」不是空池）、
 *   非零 error_count（好验证「易错词（全平台高频）」筛选）。
 *
 * 幂等：走 `word` 业务键 upsert。运行：npx tsx src/scripts/seed-vocabulary-fixture.ts
 */
import 'dotenv/config';
import mysql from 'mysql2/promise';
import { computeHasExtendedSense } from '../common/utils/normalize-english.util.js';

interface Fixture {
  word: string;
  phonetic: string | null;
  level: 'junior' | 'senior_required';
  meanings: Array<{ pos: string; gloss: string; extended?: boolean; context?: string; note?: string }>;
  rootKey?: string;
  rootAffixes?: Array<{ type: 'prefix' | 'suffix'; code: string; gloss: string; posHint?: string }>;
  /** 预置的全平台错次，用来验证「易错词」筛选（真库由答题累加） */
  errorCount?: number;
}

const FIXTURES: Fixture[] = [
  // ---- care 族（词根族展开：中心词 + 三个派生） ----
  {
    word: 'care',
    phonetic: '/keə(r)/',
    level: 'junior',
    meanings: [
      { pos: 'n.', gloss: '照顾；小心' },
      { pos: 'v.', gloss: '关心；在意' },
    ],
    rootKey: 'care',
  },
  {
    word: 'careful',
    phonetic: '/ˈkeəfl/',
    level: 'junior',
    meanings: [{ pos: 'adj.', gloss: '仔细的；小心的' }],
    rootKey: 'care',
    rootAffixes: [{ type: 'suffix', code: '-ful', gloss: '充满…的；有…性质的', posHint: '→ 形容词' }],
  },
  {
    word: 'careless',
    phonetic: '/ˈkeələs/',
    level: 'junior',
    meanings: [{ pos: 'adj.', gloss: '粗心的；漫不经心的' }],
    rootKey: 'care',
    rootAffixes: [{ type: 'suffix', code: '-less', gloss: '无…的；没有…的', posHint: '→ 形容词' }],
  },
  {
    word: 'carefully',
    phonetic: '/ˈkeəfəli/',
    level: 'junior',
    meanings: [{ pos: 'adv.', gloss: '仔细地；小心地' }],
    rootKey: 'care',
    rootAffixes: [{ type: 'suffix', code: '-ly', gloss: '以…方式', posHint: '→ 副词' }],
  },
  // ---- use 族（成员带前缀与后缀各一） ----
  {
    word: 'use',
    phonetic: '/juːz/',
    level: 'junior',
    meanings: [
      { pos: 'v.', gloss: '使用；利用' },
      { pos: 'n.', gloss: '用途；使用' },
    ],
    rootKey: 'use',
  },
  {
    word: 'useful',
    phonetic: '/ˈjuːsfl/',
    level: 'junior',
    meanings: [{ pos: 'adj.', gloss: '有用的；有益的' }],
    rootKey: 'use',
    rootAffixes: [{ type: 'suffix', code: '-ful', gloss: '充满…的；有…性质的', posHint: '→ 形容词' }],
  },
  {
    word: 'useless',
    phonetic: '/ˈjuːsləs/',
    level: 'junior',
    meanings: [{ pos: 'adj.', gloss: '无用的；无效的' }],
    rootKey: 'use',
    rootAffixes: [{ type: 'suffix', code: '-less', gloss: '无…的；没有…的', posHint: '→ 形容词' }],
  },
  // ---- 熟词僻义（表格里的核心形态） ----
  {
    word: 'address',
    phonetic: '/əˈdres/',
    level: 'junior',
    meanings: [
      { pos: 'n.', gloss: '地址' },
      { pos: 'n.', gloss: '演说；演讲' },
      {
        pos: 'v.',
        gloss: '处理；对付（问题）',
        extended: true,
        context: 'address the problem',
        note: '中高考阅读完型高频僻义',
      },
    ],
    errorCount: 7,
  },
  {
    word: 'book',
    phonetic: '/bʊk/',
    level: 'junior',
    meanings: [
      { pos: 'n.', gloss: '书；书籍' },
      {
        pos: 'v.',
        gloss: '预订；预定',
        extended: true,
        context: 'book a ticket',
        note: '常见名词的不常见动词义',
      },
    ],
    errorCount: 3,
  },
  // ---- 拼写 / 形态边界 ----
  { word: 'colour', phonetic: '/ˈkʌlə(r)/', level: 'junior', meanings: [{ pos: 'n.', gloss: '颜色' }] },
  { word: "o'clock", phonetic: '/əˈklɒk/', level: 'junior', meanings: [{ pos: 'adv.', gloss: '…点钟' }] },
  { word: 'ice-cream', phonetic: '/ˈaɪskriːm/', level: 'junior', meanings: [{ pos: 'n.', gloss: '冰淇淋' }] },
  // ---- 高中层（验证「仅高中」不是空池） ----
  {
    word: 'analyse',
    phonetic: '/ˈænəlaɪz/',
    level: 'senior_required',
    meanings: [{ pos: 'v.', gloss: '分析；解析' }],
  },
  { word: 'abandon', phonetic: '/əˈbændən/', level: 'senior_required', meanings: [{ pos: 'v.', gloss: '抛弃；放弃' }] },
  {
    word: 'subject',
    phonetic: '/ˈsʌbdʒɪkt/',
    level: 'senior_required',
    meanings: [
      { pos: 'n.', gloss: '科目；学科' },
      { pos: 'n.', gloss: '主题；话题' },
      {
        pos: 'v.',
        gloss: '使经受；使遭受',
        extended: true,
        context: 'be subjected to',
        note: '高频僻义，常见于阅读说明文',
      },
    ],
    errorCount: 1,
  },
  {
    word: 'desert',
    phonetic: '/ˈdezət/',
    level: 'senior_required',
    meanings: [
      { pos: 'n.', gloss: '沙漠' },
      {
        pos: 'v.',
        gloss: '抛弃；遗弃',
        extended: true,
        context: "desert one's family",
        note: '名词/动词重音不同，考频高',
      },
    ],
  },
];

async function main() {
  const pool = mysql.createPool({
    host: process.env.DB_HOST ?? 'localhost',
    port: Number(process.env.DB_PORT ?? 3306),
    user: process.env.DB_USER ?? 'ai_k12',
    password: process.env.DB_PASS ?? 'ai_k12',
    database: process.env.DB_NAME ?? 'ai_k12',
  });

  let seeded = 0;
  let skipped = 0;

  for (const f of FIXTURES) {
    // 安全阀：该词若已属真实内容（内容管线导入的），绝不覆盖——本脚本只碰自己的假数据。
    const [existing] = await pool.execute<mysql.RowDataPacket[]>(
      `SELECT id, source_ref FROM english_words WHERE word = ? LIMIT 1`,
      [f.word],
    );
    if (existing.length > 0 && existing[0].source_ref !== 'DEV-FIXTURE') {
      console.warn(
        `[seed-vocabulary-fixture] 跳过 "${f.word}"：已存在且 source_ref=${existing[0].source_ref}，非开发假数据`,
      );
      skipped += 1;
      continue;
    }

    const meanings = f.meanings.map((m) => ({
      pos: m.pos,
      gloss: m.gloss,
      extended: m.extended === true,
      ...(m.context ? { context: m.context } : {}),
      ...(m.note ? { note: m.note } : {}),
    }));

    // has_extended_sense 的算法与管线共用同一个纯函数，免得两处各写一遍
    // （这列的冗余存在理由见 schema 注释：MySQL 搜不了 JSON 里的布尔值）。
    const hasExtended = computeHasExtendedSense(meanings);

    await pool.execute(
      `INSERT INTO english_words
         (word, phonetic, level, meanings, has_extended_sense, root_key, root_affixes,
          error_count, sort_order, source_ref, verified, is_active)
       VALUES (?, ?, ?, CAST(? AS JSON), ?, ?, CAST(? AS JSON), ?, ?, 'DEV-FIXTURE', 1, 1) AS new
       ON DUPLICATE KEY UPDATE
         phonetic = new.phonetic,
         level = new.level,
         meanings = new.meanings,
         has_extended_sense = new.has_extended_sense,
         root_key = new.root_key,
         root_affixes = new.root_affixes,
         sort_order = new.sort_order,
         verified = new.verified,
         is_active = new.is_active`,
      // 注意 UPDATE 子句里**故意没有 error_count**：它是全平台累计错次，重跑种子不该把它刷回去
      // （同内容管线 loader 的规则，见 schema 注释）。所以只在 INSERT 时给初值。
      [
        f.word,
        f.phonetic,
        f.level,
        JSON.stringify(meanings),
        hasExtended,
        f.rootKey ?? null,
        f.rootAffixes ? JSON.stringify(f.rootAffixes) : null,
        f.errorCount ?? 0,
        9000 + FIXTURES.indexOf(f),
      ],
    );
    seeded += 1;
  }

  console.log(`[seed-vocabulary-fixture] 完成：写入/更新 ${seeded} 条，跳过 ${skipped} 条（非假数据）`);
  await pool.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
