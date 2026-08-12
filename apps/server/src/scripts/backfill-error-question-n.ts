/**
 * 回填 main_error_books.question_n（卡内复合题号，形如 "0-1"）。
 *
 * 背景：question_n 列在 2026-08-12 迁移中新增。迁移 SQL 已从 practice_results 回填了
 * 能匹配的行；但 08-11 持久化功能上线前的历史错题没有 practice_results 行，
 * 需按 card.content_metadata 的 groups 题面文本匹配补全。
 *
 * 匹配策略（对 question_n IS NULL 的 practice 行）：
 *   - 取 source_ref_id(=cardId) 的 content_metadata.groups，展平为 [{groupIdx, n, text}]；
 *   - question_id 非空 -> 用 questions.content 归一化后与 group 题面归一化比对；
 *   - question_id 为空 -> 用 wrong_answer_text 归一化比对；
 *   - 命中 -> question_n = `${groupIdx}-${n}`；
 *   - 未命中 -> question_n = `cleanup-glm_5.2_ark_toC`（合成唯一键，清零仍可用）。
 *
 * 运行：cd apps/server && npx tsx src/scripts/backfill-error-question-n.ts
 * 幂等：只处理 question_n IS NULL 的行，重复运行安全。
 */
import * as dotenv from 'dotenv';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import mysql from 'mysql2/promise';

const __dirname = dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: join(__dirname, '../../../.env') });

/** 题面归一化：去 $、空白、行首 "(N)"/"（N）" 编号、"解方程：" 等前缀，转小写。 */
function normalizeText(s: string | null): string {
  if (!s) return '';
  let r = s.normalize('NFKC').replace(/\$+/g, '').replace(/\s+/g, '');
  // 去行首题号 (1) （1） 1. 等
  r = r.replace(/^[(（]\d+[)）]\s*/, '');
  r = r.replace(/^\d+\.\s*/, '');
  // 去常见前缀
  r = r.replace(/^解方程[：:]?/, '');
  return r.toLowerCase();
}

interface GroupQuestion { groupIdx: number; n: number; text: string; }

/** 解析 card.content_metadata，展平为 [{groupIdx, n, text}]。 */
function flattenCardQuestions(metadataRaw: string | null): GroupQuestion[] {
  if (!metadataRaw) return [];
  try {
    const md = JSON.parse(metadataRaw) as { groups?: Array<{ questions?: Array<{ n: number; text: string }> }> };
    if (!md.groups) return [];
    const out: GroupQuestion[] = [];
    md.groups.forEach((g, gi) => {
      (g.questions ?? []).forEach(q => out.push({ groupIdx: gi, n: q.n, text: q.text }));
    });
    return out;
  } catch {
    return [];
  }
}

async function main() {
  const pool = mysql.createPool({
    host: process.env.DB_HOST || 'localhost',
    port: parseInt(process.env.DB_PORT || '3306', 10),
    user: process.env.DB_USER || 'ai_k12',
    password: process.env.DB_PASS || 'ai_k12',
    database: process.env.DB_NAME || 'ai_k12',
    charset: 'utf8mb4',
  });

  // 取所有 question_n IS NULL 且有 source_ref_id(=cardId) 的行
  const [rows] = await pool.query<any[]>(
    `SELECT id, question_id, source_ref_id AS card_id, wrong_answer_text
     FROM main_error_books
     WHERE question_n IS NULL AND source_ref_id IS NOT NULL`,
  );
  console.log(`待回填: ${rows.length} 行`);

  // 预取涉及到的 card 元数据
  const cardIds = [...new Set(rows.map(r => r.card_id as number))];
  const cardMeta = new Map<number, GroupQuestion[]>();
  if (cardIds.length) {
    const [cards] = await pool.query<any[]>(
      `SELECT id, content_metadata FROM cards WHERE id IN (${cardIds.map(() => '?').join(',')})`,
      cardIds,
    );
    for (const c of cards) cardMeta.set(c.id, flattenCardQuestions(c.content_metadata));
  }

  // 预取涉及到的 question 内容
  const qIds = rows.map(r => r.question_id).filter((v): v is number => v != null);
  const qContent = new Map<number, string>();
  if (qIds.length) {
    const [qs] = await pool.query<any[]>(
      `SELECT id, content FROM questions WHERE id IN (${qIds.map(() => '?').join(',')})`,
      qIds,
    );
    for (const q of qs) qContent.set(q.id, q.content);
  }

  let matched = 0, synthetic = 0;
  for (const r of rows) {
    const groups = cardMeta.get(r.card_id) ?? [];
    const needle = r.question_id != null
      ? qContent.get(r.question_id) ?? null
      : r.wrong_answer_text;
    const normNeedle = normalizeText(needle);
    let qn: string | null = null;
    if (normNeedle) {
      for (const g of groups) {
        if (normalizeText(g.text) === normNeedle) {
          qn = `${g.groupIdx}-${g.n}`;
          matched++;
          break;
        }
      }
    }
    if (!qn) {
      qn = `cleanup-${r.id}`;
      synthetic++;
    }
    await pool.execute(
      `UPDATE main_error_books SET question_n = ? WHERE id = ?`,
      [qn, r.id],
    );
    console.log(`  id=${r.id} card=${r.card_id} qid=${r.question_id ?? 'null'} -> ${qn}`);
  }

  console.log(`\n完成: 匹配 ${matched}, 合成 ${synthetic}`);
  await pool.end();
}

main().catch(err => { console.error(err); process.exit(1); });
