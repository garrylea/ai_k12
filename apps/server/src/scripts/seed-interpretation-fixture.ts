/**
 * 【开发假数据】语文古诗文「解释（翻译）」链路验证种子。
 *
 * 警告：这里的数据**不是生产内容**，只为打通「训练 → 语文 → 专项 → 解释 → 逐句判题」链路。
 * 生产内容由用户整理字词后交内容管线入库
 * （tools/data-refinery/src/interpretation_cli.py，见
 *  docs/superpowers/plans/2026-09-16-chinese-interpretation-special.md §7）。
 *
 * 为什么需要它：解释专项抽题池要求 `JSON_LENGTH(sentences) > 0`（内容就绪），
 * 而内容管线本轮未跑、库里 50 篇的三列全是 NULL —— 不加假数据的话，
 * 配置页会是空清单、答题页一进去就被踢回，整条链路无法手测。
 *
 * 安全阀（照 seed-dictation-fixture.ts）：
 *   - 目标行若已存在且 `source_ref !== 'DEV-FIXTURE'` → **跳过并告警**，绝不覆盖真实内容；
 *   - 只在没有该行时才 INSERT（并标 source_ref='DEV-FIXTURE'）；
 *   - 写库前断言 `''.join(sentences[].text) === body`（入库自检的同一条不变式）。
 *
 * 幂等：按 (work_title, semester) 业务键先查后写。
 * 运行：npx tsx src/scripts/seed-interpretation-fixture.ts
 */
import 'dotenv/config';
import mysql from 'mysql2/promise';

interface FixtureSentence { text: string; translation: string }
interface FixtureKeyTerm { term: string; gloss: string; sentenceIndex: number; src?: string }

interface Fixture {
  workTitle: string;
  author: string;
  dynasty: string;
  body: string;
  semester: string;
  sortOrder: number;
  sentences: FixtureSentence[];
  keyTerms: FixtureKeyTerm[];
  fullTranslation: string;
}

const FIXTURES: Fixture[] = [
  {
    workTitle: '静夜思',
    author: '李白',
    dynasty: '唐',
    body: '床前明月光，疑是地上霜。举头望明月，低头思故乡。',
    semester: '上册',
    sortOrder: 9001,
    sentences: [
      { text: '床前明月光，疑是地上霜。', translation: '明亮的月光洒在床前，好像地上泛起了一层白霜。' },
      { text: '举头望明月，低头思故乡。', translation: '我抬起头望着天上的明月，低下头思念起了故乡。' },
    ],
    keyTerms: [
      { term: '疑', gloss: '好像，以为', sentenceIndex: 0 },
      { term: '举头', gloss: '抬起头', sentenceIndex: 1 },
      { term: '思', gloss: '思念，怀念', sentenceIndex: 1 },
    ],
    fullTranslation: '明亮的月光洒在床前，好像地上泛起了一层白霜。我抬起头望着天上的明月，低下头思念起了故乡。',
  },
  {
    workTitle: '登鹳雀楼',
    author: '王之涣',
    dynasty: '唐',
    body: '白日依山尽，黄河入海流。欲穷千里目，更上一层楼。',
    semester: '上册',
    sortOrder: 9002,
    sentences: [
      { text: '白日依山尽，黄河入海流。', translation: '夕阳依傍着群山缓缓落下，黄河朝着大海奔流而去。' },
      { text: '欲穷千里目，更上一层楼。', translation: '想要看到千里之外的风光，就要再登上一层楼。' },
    ],
    keyTerms: [
      { term: '依', gloss: '依傍，靠着', sentenceIndex: 0 },
      { term: '尽', gloss: '消失，这里指太阳落山', sentenceIndex: 0 },
      { term: '欲', gloss: '想要', sentenceIndex: 1 },
      { term: '穷', gloss: '穷尽，达到极点', sentenceIndex: 1 },
    ],
    fullTranslation: '夕阳依傍着群山缓缓落下，黄河朝着大海奔流而去。想要看到千里之外的风光，就要再登上一层楼。',
  },
];

/** 入库自检的同一条不变式：切句拼接必须逐字还原正文（含标点）。 */
function assertJoinEqualsBody(f: Fixture) {
  const joined = f.sentences.map((s) => s.text).join('');
  if (joined !== f.body) {
    throw new Error(
      `[seed-interpretation-fixture] 《${f.workTitle}》切句拼不回正文：\n  拼接=${joined}\n  正文=${f.body}`,
    );
  }
  for (const t of f.keyTerms) {
    if (t.sentenceIndex < 0 || t.sentenceIndex >= f.sentences.length) {
      throw new Error(`[seed-interpretation-fixture] 《${f.workTitle}》字词「${t.term}」的 sentenceIndex 越界`);
    }
    if (!f.sentences[t.sentenceIndex].text.includes(t.term)) {
      throw new Error(
        `[seed-interpretation-fixture] 《${f.workTitle}》字词「${t.term}」不在第 ${t.sentenceIndex} 句里`,
      );
    }
  }
}

async function main() {
  const pool = mysql.createPool({
    host: process.env.DB_HOST ?? 'localhost',
    port: Number(process.env.DB_PORT ?? 3306),
    user: process.env.DB_USER ?? 'ai_k12',
    password: process.env.DB_PASS ?? 'ai_k12',
    database: process.env.DB_NAME ?? 'ai_k12',
  });

  for (const f of FIXTURES) {
    assertJoinEqualsBody(f);

    const [existing] = await pool.execute<mysql.RowDataPacket[]>(
      `SELECT id, source_ref FROM chinese_passages
        WHERE work_title = ? AND semester = ? LIMIT 1`,
      [f.workTitle, f.semester],
    );

    let passageId: number;
    if (existing.length > 0) {
      if (existing[0].source_ref !== 'DEV-FIXTURE') {
        console.warn(
          `[seed-interpretation-fixture] 跳过《${f.workTitle}》：该篇目已存在且 source_ref=${existing[0].source_ref}，非开发假数据`,
        );
        continue;
      }
      passageId = existing[0].id as number;
    } else {
      const [ins] = await pool.execute<mysql.ResultSetHeader>(
        `INSERT INTO chinese_passages
           (work_title, author, dynasty, body, grade_band, grade, semester,
            sort_order, source_ref, verified, memorize_required)
         VALUES (?, ?, ?, ?, 'junior', '九年级', ?, ?, 'DEV-FIXTURE', 1, 0)`,
        [f.workTitle, f.author, f.dynasty, f.body, f.semester, f.sortOrder],
      );
      passageId = ins.insertId;
    }

    await pool.execute(
      `UPDATE chinese_passages
          SET key_terms = ?, sentences = ?, full_translation = ?
        WHERE id = ?`,
      [
        JSON.stringify(f.keyTerms.map((t) => ({ ...t, src: t.src ?? 'textbook' }))),
        JSON.stringify(f.sentences),
        f.fullTranslation,
        passageId,
      ],
    );
    console.log(
      `seeded 《${f.workTitle}》（${f.semester}，id=${passageId}）：${f.sentences.length} 句 / ${f.keyTerms.length} 个重点字词`,
    );
  }

  await pool.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
