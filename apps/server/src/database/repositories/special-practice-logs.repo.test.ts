import { describe, it, expect, vi } from 'vitest';
import { SpecialPracticeLogsRepository } from './special-practice-logs.repo.js';

/** 复刻 mysql2 的双返回形状 [rows, fields]（同 point-ledger.repo.test.ts） */
const mockPool = () => ({
  execute: vi.fn().mockResolvedValue([[], []]),
  query: vi.fn().mockResolvedValue([[], []]),
});

describe('SpecialPracticeLogsRepository', () => {
  it('insert：11 个占位符按列顺序绑参，subject_id 显式传 null', async () => {
    const pool = mockPool();
    pool.execute.mockResolvedValueOnce([{ insertId: 77 }, []]);
    const repo = new SpecialPracticeLogsRepository(pool as any);

    const id = await repo.insert({
      studentId: 11,
      module: 'chinese_dictation',
      refType: 'passage',
      refId: 3,
      refKey: '静夜思',
      sentenceIndex: null,
      verdict: 'incorrect',
      isCorrect: false,
      errorCounted: true,
      sessionUid: null,
    });

    expect(id).toBe(77);
    const [sql, params] = pool.execute.mock.calls[0];
    expect(sql).toContain('INSERT INTO special_practice_logs');
    expect(sql).toContain('(student_id, module, subject_id, ref_type, ref_id, ref_key, sentence_index, verdict, is_correct, error_counted, session_uid)');
    expect(params).toEqual([11, 'chinese_dictation', null, 'passage', 3, '静夜思', null, 'incorrect', 0, 1, null]);
  });

  it('aggregateByModule：SUM/COUNT 的字符串结果被 Number() 化，空结果给 []', async () => {
    const pool = mockPool();
    pool.execute.mockResolvedValueOnce([
      [
        { module: 'chinese_dictation', units: '5', answered: '4', correct: '3' },
        { module: 'en_vocabulary', units: 2, answered: 2, correct: 1 },
      ],
      [],
    ]);
    const repo = new SpecialPracticeLogsRepository(pool as any);

    const rows = await repo.aggregateByModule(11, new Date('2026-09-13'), new Date('2026-09-20'));

    expect(rows).toEqual([
      { module: 'chinese_dictation', units: 5, answered: 4, correct: 3 },
      { module: 'en_vocabulary', units: 2, answered: 2, correct: 1 },
    ]);
    // answered 必须用 is_correct IS NOT NULL，不能用 COUNT(*)
    expect(pool.execute.mock.calls[0][0]).toContain('SUM(is_correct IS NOT NULL) AS answered');
    // 窗口参数化 + 半开区间，绝不用 CURDATE()
    expect(pool.execute.mock.calls[0][1]).toEqual([11, new Date('2026-09-13'), new Date('2026-09-20')]);
    expect(pool.execute.mock.calls[0][0]).not.toContain('CURDATE()');
  });

  it('aggregateByModule：无数据 → 空数组（由 service 补四个模块的 0，不在这里造行）', async () => {
    const repo = new SpecialPracticeLogsRepository(mockPool() as any);
    expect(await repo.aggregateByModule(11, new Date(), new Date())).toEqual([]);
  });

  it('countByDayByModule：按 module + 本地日期分组，计数 Number() 化', async () => {
    const pool = mockPool();
    pool.execute.mockResolvedValueOnce([
      [
        { module: 'chinese_meaning', day: '2026-09-15', count: '3' },
        { module: 'chinese_meaning', day: '2026-09-16', count: 1 },
      ],
      [],
    ]);
    const repo = new SpecialPracticeLogsRepository(pool as any);

    const rows = await repo.countByDayByModule(11, new Date('2026-09-13'), new Date('2026-09-20'));

    expect(rows).toEqual([
      { module: 'chinese_meaning', day: '2026-09-15', count: 3 },
      { module: 'chinese_meaning', day: '2026-09-16', count: 1 },
    ]);
    // 对齐 parent-analytics.repo 的 byDay 写法
    expect(pool.execute.mock.calls[0][0]).toContain("DATE_FORMAT(created_at, '%Y-%m-%d') AS day");
    expect(pool.execute.mock.calls[0][0]).toContain('GROUP BY module, day');
  });

  it('countDistinctCorrectWords：只数 en_vocabulary 且 verdict=correct 的去重 ref_id', async () => {
    const pool = mockPool();
    pool.execute.mockResolvedValueOnce([[{ words: '12' }], []]);
    const repo = new SpecialPracticeLogsRepository(pool as any);

    expect(await repo.countDistinctCorrectWords(11, new Date('2026-09-13'), new Date('2026-09-20'))).toBe(12);
    const sql = pool.execute.mock.calls[0][0] as string;
    expect(sql).toContain('COUNT(DISTINCT ref_id)');
    expect(sql).toContain("module = 'en_vocabulary'");
    expect(sql).toContain("verdict = 'correct'");
  });

  it('countDistinctCorrectWords：无数据返回 0（不是 null）', async () => {
    const pool = mockPool();
    pool.execute.mockResolvedValueOnce([[{ words: null }], []]);
    const repo = new SpecialPracticeLogsRepository(pool as any);

    expect(await repo.countDistinctCorrectWords(11, new Date(), new Date())).toBe(0);
  });
});
