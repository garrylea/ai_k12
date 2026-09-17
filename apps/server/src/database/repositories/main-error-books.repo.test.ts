import { describe, it, expect, vi } from 'vitest';
import { MainErrorBooksRepository } from './main-error-books.repo';

/**
 * mockPool 模拟 mysql2 的 pool.execute 双返回形状：
 * - INSERT -> [ResultSetHeader, fields]
 * - UPDATE -> [ResultSetHeader, fields]
 * - SELECT -> [rows[], fields]
 */
const mockPool = (rows: any[] = [], insertId = 7) => ({
  execute: vi.fn().mockImplementation((sql: string) => {
    const trimmed = sql.trim();
    if (/^INSERT/i.test(trimmed)) {
      return Promise.resolve([{ insertId, affectedRows: 1 }, []]);
    }
    if (/^UPDATE/i.test(trimmed)) {
      return Promise.resolve([{ affectedRows: 1, changedRows: 1 }, []]);
    }
    return Promise.resolve([rows, []]);
  }),
  query: vi.fn().mockResolvedValue([rows, []]),
});

describe('MainErrorBooksRepository', () => {
  it('create 插入并返回 id', async () => {
    const pool = mockPool();
    const repo = new MainErrorBooksRepository(pool as any);
    const id = await repo.create({
      student_id: 1,
      subject_id: 1,
      question_id: 2,
      source: 'practice',
      source_ref_id: 3,
      question_n: '0-1',
      lesson_id: 4,
      wrong_answer_text: null,
    });
    expect(id).toBe(7);
    // 校验 SQL 含 source_ref_id、question_n、lesson_id 列
    const [sql, params] = pool.execute.mock.calls[0];
    expect(sql).toContain('source_ref_id');
    expect(sql).toContain('question_n');
    expect(sql).toContain('lesson_id');
    expect(params).toEqual([1, 1, 2, 'practice', 3, '0-1', 4, null]);
  });

  it('create 接受 question_id=null（质量差仅存题面）', async () => {
    const repo = new MainErrorBooksRepository(mockPool() as any);
    const id = await repo.create({
      student_id: 1,
      subject_id: 1,
      question_id: null,
      source: 'practice',
      source_ref_id: 3,
      question_n: '0-2',
      lesson_id: 4,
      wrong_answer_text: '原始题面',
    });
    expect(id).toBe(7);
  });

  it('findById 返回首行，无则 null', async () => {
    const row = { id: 5, student_id: 1, subject_id: 1, question_id: 2 };
    const repo = new MainErrorBooksRepository(mockPool([row]) as any);
    const found = await repo.findById(5);
    expect(found).toEqual(row);

    const repoEmpty = new MainErrorBooksRepository(mockPool([]) as any);
    const notFound = await repoEmpty.findById(999);
    expect(notFound).toBeNull();
  });

  it('findByStudent 默认排除已清除且按 id DESC', async () => {
    const pool = mockPool([{ id: 1 }]);
    const repo = new MainErrorBooksRepository(pool as any);
    await repo.findByStudent(10);
    const [sql, params] = pool.execute.mock.calls[0];
    expect(sql).toContain('student_id = ?');
    expect(sql).toContain('is_cleared = 0');
    expect(sql).not.toContain('subject_id = ?');
    expect(sql).toContain('ORDER BY id DESC');
    expect(params).toEqual([10]);
  });

  it('findByStudent 带 subjectId 且 includeCleared=true', async () => {
    const pool = mockPool([]);
    const repo = new MainErrorBooksRepository(pool as any);
    await repo.findByStudent(10, 2, true);
    const [sql, params] = pool.execute.mock.calls[0];
    expect(sql).toContain('subject_id = ?');
    expect(sql).not.toContain('is_cleared = 0'); // includeCleared 跳过
    expect(params).toEqual([10, 2]);
  });

  it('markCleared 更新 is_cleared=1 并设 cleared_at', async () => {
    const pool = mockPool();
    const repo = new MainErrorBooksRepository(pool as any);
    await repo.markCleared(42);
    const [sql, params] = pool.execute.mock.calls[0];
    expect(sql).toContain('is_cleared = 1');
    expect(sql).toContain('cleared_at = NOW(3)');
    expect(params).toEqual([42]);
  });

  it('findUnclearedByStudentQuestion 命中返回行，否则 null', async () => {
    const row = { id: 9, student_id: 1, question_id: 2, is_cleared: 0 };
    const pool = mockPool([row]);
    const repo = new MainErrorBooksRepository(pool as any);
    const found = await repo.findUnclearedByStudentQuestion(1, 2, 5, '题面');
    expect(found).toEqual(row);

    const repoEmpty = new MainErrorBooksRepository(mockPool([]) as any);
    const notFound = await repoEmpty.findUnclearedByStudentQuestion(1, 2, 5, '题面');
    expect(notFound).toBeNull();
  });

  it('findUnclearedByStudentQuestion 传 questionId 与 null 两种参数形态', async () => {
    const pool = mockPool([]);
    const repo = new MainErrorBooksRepository(pool as any);
    // questionId 非空
    await repo.findUnclearedByStudentQuestion(1, 2, 5, '题面');
    let [, params] = pool.execute.mock.calls[0];
    expect(params).toEqual([1, 2, 2, 5, '题面']);

    // questionId 为 null（题库未入库，按 source_ref_id + wrong_answer_text 匹配）
    await repo.findUnclearedByStudentQuestion(1, null, 5, '未入库题面');
    [, params] = pool.execute.mock.calls[1];
    expect(params).toEqual([1, null, null, 5, '未入库题面']);
  });

  it('findUnclearedPracticeByStudentSubject 返回未清 practice 错题并 JOIN questions 题面 + cards 卡片所属课', async () => {
    const rows = [{ id: 9, source_ref_id: 441, question_id: null, question_n: '0-1', questionText: '题A', lesson_id: 181 }];
    const pool = mockPool(rows);
    const repo = new MainErrorBooksRepository(pool as any);
    const out = await repo.findUnclearedPracticeByStudentSubject(2, 1);
    expect(out).toEqual(rows);
    const [sql, params] = pool.execute.mock.calls[0];
    expect(sql).toContain('source = \'practice\'');
    expect(sql).toContain('is_cleared = 0');
    expect(sql).toContain('LEFT JOIN questions q');
    expect(sql).toContain('COALESCE(q.content, meb.wrong_answer_text)');
    expect(sql).toContain('LEFT JOIN cards c ON c.id = meb.source_ref_id');
    expect(sql).toContain('c.lesson_id AS lesson_id');
    expect(sql).not.toContain('textbook_version_id');
    expect(params).toEqual([2, 1]);
  });

  it('findUnclearedPracticeByStudentSubject 带版本过滤：JOIN lessons/units/semesters 并按 textbook_version_id 过滤', async () => {
    const pool = mockPool([]);
    const repo = new MainErrorBooksRepository(pool as any);
    await repo.findUnclearedPracticeByStudentSubject(2, 1, 10);
    const [sql, params] = pool.execute.mock.calls[0];
    expect(sql).toContain('LEFT JOIN lessons l ON l.id = c.lesson_id');
    expect(sql).toContain('LEFT JOIN units u ON u.id = l.unit_id');
    expect(sql).toContain('LEFT JOIN semesters s ON s.id = u.semester_id');
    expect(sql).toContain('AND s.textbook_version_id = ?');
    expect(params).toEqual([2, 1, 10]);
  });

  it('updateDialogueId 把对话 id 回写到错题本记录', async () => {
    const pool = mockPool();
    const repo = new MainErrorBooksRepository(pool as any);
    await repo.updateDialogueId(77, 300);
    const [sql, params] = pool.execute.mock.calls[0];
    expect(sql).toContain('dialogue_id = ?');
    expect(params).toEqual([300, 77]);
  });

  it('clearUnclearedByStudentQuestion 批量清零该题未清记录（questionId 非空）', async () => {
    const pool = mockPool();
    const repo = new MainErrorBooksRepository(pool as any);
    await repo.clearUnclearedByStudentQuestion(1, 2, 5, '题面');
    const [sql, params] = pool.execute.mock.calls[0];
    expect(sql).toContain('UPDATE main_error_books');
    expect(sql).toContain('is_cleared = 1');
    expect(sql).toContain('cleared_at = NOW(3)');
    expect(sql).toContain('is_cleared = 0');
    expect(sql).toContain('question_id = ?');
    expect(sql).toContain('source_ref_id = ?');
    expect(sql).toContain('wrong_answer_text = ?');
    expect(params).toEqual([1, 2, 2, 5, '题面']);
  });

  it('clearUnclearedByStudentQuestionId 返回 affectedRows（error_fix 发分判定依据）', async () => {
    // 发分规则：affectedRows > 0 = 确实清掉了一条未清零的错题（spec §6.5）。
    const pool = { execute: vi.fn().mockResolvedValue([{ affectedRows: 2 }, []]) };
    const repo = new MainErrorBooksRepository(pool as any);
    const affected = await repo.clearUnclearedByStudentQuestionId(1, 2);
    expect(affected).toBe(2);
    const [sql, params] = pool.execute.mock.calls[0];
    expect(sql).toContain('UPDATE main_error_books');
    expect(sql).toContain('is_cleared = 1');
    expect(sql).toContain('is_cleared = 0');
    expect(sql).toContain('question_id = ?');
    expect(params).toEqual([1, 2]);
  });

  it('clearUnclearedByStudentQuestionId 无未清行时返回 0（首次就答对）', async () => {
    const pool = { execute: vi.fn().mockResolvedValue([{ affectedRows: 0 }, []]) };
    const repo = new MainErrorBooksRepository(pool as any);
    expect(await repo.clearUnclearedByStudentQuestionId(1, 2)).toBe(0);
  });

  it('clearUnclearedByStudentQuestion questionId=null 走题面匹配分支', async () => {
    const pool = mockPool();
    const repo = new MainErrorBooksRepository(pool as any);
    await repo.clearUnclearedByStudentQuestion(1, null, 5, '未入库题面');
    const [, params] = pool.execute.mock.calls[0];
    expect(params).toEqual([1, null, null, 5, '未入库题面']);
  });
});
