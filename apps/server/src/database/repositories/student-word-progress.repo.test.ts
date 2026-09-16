import { describe, it, expect, vi } from 'vitest';
import { StudentWordProgressRepository } from './student-word-progress.repo';

const mockPool = (rows: any[] = []) => ({
  execute: vi.fn().mockResolvedValue([rows, []]),
  query: vi.fn().mockResolvedValue([rows, []]),
});

const repoWith = (rows: any[] = []) => {
  const pool = mockPool(rows);
  return { pool, repo: new StudentWordProgressRepository(pool as any) };
};

describe('StudentWordProgressRepository.recordResult', () => {
  it('按 (student_id, word_id) 幂等 upsert，两个累加器都单调', async () => {
    const { pool, repo } = repoWith([]);
    await repo.recordResult({ studentId: 9, wordId: 12, learned: 1, wrongDelta: 0, lastResult: 'correct' });
    const [sql, params] = pool.execute.mock.calls[0];
    expect(sql).toContain('INSERT INTO student_word_progress');
    expect(sql).toContain('ON DUPLICATE KEY UPDATE');
    // 答对过就永远是 1，之后答错也不回退
    expect(sql).toContain('learned = GREATEST(student_word_progress.learned, new.learned)');
    // 错次只增（清零是另一条独立 UPDATE）
    expect(sql).toContain('wrong_count = student_word_progress.wrong_count + new.wrong_count');
    expect(sql).toContain('last_result = new.last_result');
    // 时间戳用 DB 时钟（NOW(3)）算，不由应用传 —— 免得应用与 DB 时钟漂移；
    // 冲突分支把 new.last_seen_at 抄过去，也就顺带刷新了「今日已背」的判定依据
    expect(sql).toContain('VALUES (?, ?, ?, ?, ?, NOW(3))');
    expect(sql).toContain('last_seen_at = new.last_seen_at');
    expect(params).toEqual([9, 12, 1, 0, 'correct']);
  });

  it('用行别名而非已弃用的 VALUES()', async () => {
    const { pool, repo } = repoWith([]);
    await repo.recordResult({ studentId: 9, wordId: 12, learned: 0, wrongDelta: 1, lastResult: 'wrong' });
    const [sql] = pool.execute.mock.calls[0];
    expect(sql).toContain('AS new');
    expect(sql).not.toContain('VALUES(');
  });

  it('增量由入参决定，仓储自己不做结论判断——wrongDelta=0 时错次不动', async () => {
    // off_target / unanswered / undetermined 三个结论都由 progressDelta 给出 0 增量，
    // 仓储若自作主张按结论记账，这里就会与 progressDelta 的口径分叉。
    const { pool, repo } = repoWith([]);
    await repo.recordResult({ studentId: 9, wordId: 12, learned: 0, wrongDelta: 0, lastResult: 'off_target' });
    const [, params] = pool.execute.mock.calls[0];
    expect(params).toEqual([9, 12, 0, 0, 'off_target']);
  });

  it('答错时置 last_result=wrong 并加错次，但不置 learned', async () => {
    const { pool, repo } = repoWith([]);
    await repo.recordResult({ studentId: 9, wordId: 12, learned: 0, wrongDelta: 1, lastResult: 'wrong' });
    const [, params] = pool.execute.mock.calls[0];
    expect(params).toEqual([9, 12, 0, 1, 'wrong']);
  });
});

describe('StudentWordProgressRepository.clearWrongCount', () => {
  it('只清学生自己的 wrong_count，不碰 learned、不碰全局 error_count', async () => {
    const { pool, repo } = repoWith([]);
    await repo.clearWrongCount(9, 12);
    const [sql, params] = pool.execute.mock.calls[0];
    expect(sql).toContain('UPDATE student_word_progress SET wrong_count = 0');
    expect(sql).toContain('WHERE student_id = ? AND word_id = ?');
    expect(params).toEqual([9, 12]);
    // 反面断言：这三个一旦出现就说明「移除易错标记」越界了
    expect(sql).not.toContain('learned');
    expect(sql).not.toContain('english_words');
    expect(sql).not.toContain('error_count');
  });
});

describe('StudentWordProgressRepository.countSeenSince', () => {
  it('按「见过就算」计数：只要 last_seen_at 在起点之后，答错/不认识/判题失败都算', async () => {
    const { pool, repo } = repoWith([{ count: 12 }]);
    const since = new Date('2026-09-16T00:00:00+08:00');
    expect(await repo.countSeenSince(9, since)).toBe(12);
    const [sql, params] = pool.execute.mock.calls[0];
    expect(sql).toContain('last_seen_at >= ?');
    expect(params).toEqual([9, since]);
  });

  it('不在 SQL 里用 CURDATE()（DB 会话时区与应用时区不一致会算错一天）', async () => {
    const { pool, repo } = repoWith([{ count: 0 }]);
    await repo.countSeenSince(9, new Date());
    const [sql] = pool.execute.mock.calls[0];
    expect(sql).not.toContain('CURDATE');
    expect(sql).not.toContain('NOW()');
  });

  it('无行时返回 0 而不是 NaN', async () => {
    const { repo } = repoWith([]);
    expect(await repo.countSeenSince(9, new Date())).toBe(0);
  });
});

describe('StudentWordProgressRepository.findByStudentAndWord', () => {
  it('按学生 + 词查单行', async () => {
    const { pool, repo } = repoWith([]);
    await repo.findByStudentAndWord(9, 12);
    const [sql, params] = pool.execute.mock.calls[0];
    expect(sql).toContain('WHERE student_id = ? AND word_id = ?');
    expect(sql).toContain('LIMIT 1');
    expect(params).toEqual([9, 12]);
  });

  it('没有进度行时返回 null', async () => {
    const { repo } = repoWith([]);
    expect(await repo.findByStudentAndWord(9, 12)).toBeNull();
  });
});
