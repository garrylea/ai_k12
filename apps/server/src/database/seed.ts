/**
 * Seed script: populates demo data for development.
 * Run with: npx tsx src/database/seed.ts
 *
 * Inserts:
 * - 1 parent (demo parent account)
 * - 1 student (linked to parent)
 * - 9 textbook curriculum units + 30+ lessons for 人教版三年级数学上册
 * - 1 progress record (student starts at unit 3, lesson 1)
 *
 * NOTE: This is a FALLBACK. The preferred approach is to run
 * tools/data-refinery/refinery_cli.py to load real extracted content data.
 */
import 'reflect-metadata';
import * as dotenv from 'dotenv';
import { createPool } from './connection.js';
import * as bcrypt from 'bcrypt';

dotenv.config({ path: new URL('../../.env', import.meta.url).pathname });

async function seed() {
  const pool = createPool();

  console.log('Seeding database...');

  // 1. Insert parent
  const parentHash = await bcrypt.hash('123456', 10);
  await pool.execute(
    `INSERT IGNORE INTO parents (id, phone, password_hash, name)
     VALUES (1, '13800000000', ?, '张爸爸')`,
    [parentHash],
  );
  console.log('  ✓ parent (id=1, phone=13800000000)');

  // 2. Insert student
  const studentHash = await bcrypt.hash('123456', 10);
  await pool.execute(
    `INSERT IGNORE INTO students (id, parent_id, username, password_hash, name, age, grade, school_level)
     VALUES (1, 1, 'student1', ?, '小明', 9, 'grade_3', 'primary')`,
    [studentHash],
  );
  console.log('  ✓ student (id=1, username=student1, password=123456)');

  // 3. Insert textbook version (人教版三年级数学上册)
  const textbookId = 1;
  await pool.execute(
    `INSERT IGNORE INTO textbook_versions (id, subject_id, name, code, grade_band, publisher)
     VALUES (?, 1, '人教版', 'math_人教版_primary', 'primary', '人民教育出版社')`,
    [textbookId],
  );
  console.log('  ✓ textbook_version (id=1, 人教版小学数学)');

  // 4. Insert semester (三年级上册)
  const semesterId = 1;
  await pool.execute(
    `INSERT IGNORE INTO semesters (id, textbook_version_id, name, grade, term, sort_order)
     VALUES (?, ?, '三年级上册', 'grade_3', 'first', 1)`,
    [semesterId, textbookId],
  );
  console.log('  ✓ semester (id=1, 三年级上册)');

  // 5. Insert units (8 chapters from PEP 三年级数学上册)
  const units = [
    { id: 1, name: '时、分、秒', order: 1, isMid: 0 },
    { id: 2, name: '万以内的加法和减法（一）', order: 2, isMid: 0 },
    { id: 3, name: '测量', order: 3, isMid: 0 },
    { id: 4, name: '万以内的加法和减法（二）', order: 4, isMid: 0 },
    { id: 5, name: '倍的认识', order: 5, isMid: 1 },
    { id: 6, name: '多位数乘一位数', order: 6, isMid: 0 },
    { id: 7, name: '长方形和正方形', order: 7, isMid: 0 },
    { id: 8, name: '分数的初步认识', order: 8, isMid: 0 },
  ];

  for (const u of units) {
    await pool.execute(
      `INSERT IGNORE INTO units (id, semester_id, name, sort_order, is_midterm_boundary)
       VALUES (?, ?, ?, ?, ?)`,
      [u.id, semesterId, u.name, u.order, u.isMid],
    );
  }
  console.log(`  ✓ ${units.length} units`);

  // 6. Insert lessons (sections per unit)
  const lessons: [number, number, string, number, number][] = [
    // Unit 1: 时、分、秒 (3 sections)
    [1, 1, '秒的认识', 1, 0],
    [2, 1, '时间的计算', 2, 0],
    [3, 1, '练习一', 3, 1],
    // Unit 2: 万以内的加法和减法一 (4 sections)
    [4, 2, '两位数加两位数', 1, 0],
    [5, 2, '两位数减两位数', 2, 0],
    [6, 2, '几百几十加减几百几十', 3, 0],
    [7, 2, '估算', 4, 1],
    // Unit 3: 测量 (4 sections)
    [8, 3, '毫米、分米的认识', 1, 0],
    [9, 3, '千米的认识', 2, 0],
    [10, 3, '吨的认识', 3, 0],
    [11, 3, '练习三', 4, 1],
    // Unit 4: 万以内的加法和减法二 (3 sections)
    [12, 4, '加法', 1, 0],
    [13, 4, '减法', 2, 0],
    [14, 4, '加减法的验算', 3, 1],
    // Unit 5: 倍的认识 (2 sections)
    [15, 5, '倍的认识', 1, 0],
    [16, 5, '解决问题', 2, 1],
    // Unit 6: 多位数乘一位数 (3 sections)
    [17, 6, '口算乘法', 1, 0],
    [18, 6, '笔算乘法', 2, 0],
    [19, 6, '解决问题', 3, 1],
    // Unit 7: 长方形和正方形 (2 sections)
    [20, 7, '四边形', 1, 0],
    [21, 7, '周长', 2, 1],
    // Unit 8: 分数的初步认识 (2 sections)
    [22, 8, '分数的初步认识', 1, 0],
    [23, 8, '分数的简单计算', 2, 1],
  ];

  for (const [id, unitId, name, order, isLast] of lessons) {
    await pool.execute(
      `INSERT IGNORE INTO lessons (id, unit_id, name, sort_order, is_unit_last)
       VALUES (?, ?, ?, ?, ?)`,
      [id, unitId, name, order, isLast],
    );
  }
  console.log(`  ✓ ${lessons.length} lessons`);

  // 7. Insert demo cards (at least 1 per lesson for knowledge point count)
  const cardData: [number, number, string, string][] = [
    [10, 1, '秒的认识基础概念', 'kp_1,kp_2,kp_3'],
    [20, 2, '时间换算与计算', 'kp_1,kp_2,kp_3,kp_4'],
    [30, 4, '两位数加法心算', 'kp_5,kp_6,kp_7,kp_8'],
    [40, 5, '两位数减法心算', 'kp_5,kp_6,kp_7,kp_8'],
    [50, 6, '几百几十的加减运算', 'kp_5,kp_6,kp_7'],
    [60, 8, '毫米与分米', 'kp_9,kp_10,kp_11,kp_12,kp_13'],
    [70, 9, '千米的概念与换算', 'kp_9,kp_10,kp_11,kp_12'],
    [80, 10, '吨的认识与换算', 'kp_9,kp_10,kp_11'],
  ];

  for (const [id, lessonId, title, kpIds] of cardData) {
    await pool.execute(
      `INSERT IGNORE INTO cards (id, lesson_id, sort_order, card_type, title, content, knowledge_point_ids)
       VALUES (?, ?, 1, 'concept', ?, ?, ?)`,
      [id, lessonId, title, `${title}的教材内容`, kpIds],
    );
  }
  console.log(`  ✓ ${cardData.length} cards (with knowledge point references)`);

  // 8. Insert progress (student starts at unit 3, lesson 1 = 毫米、分米的认识)
  await pool.execute(
    `INSERT IGNORE INTO progress
     (id, student_id, subject_id, textbook_version_id, current_semester_id,
      current_unit_id, current_lesson_id, current_card_sort, next_unlock_type, is_clear, status)
     VALUES (1, 1, 1, 1, 1, 3, 8, 0, 'lesson', 1, 'in_progress')`,
  );
  console.log('  ✓ progress (student at unit 3, lesson 1)');

  await pool.end();
  console.log('\nSeed complete!');
}

seed().catch((err) => {
  console.error('Seed failed:', err);
  process.exit(1);
});
