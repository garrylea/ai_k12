import { describe, it, expect, vi } from 'vitest';
import { StudentKnowledgeMasteryRepository } from './student-knowledge-mastery.repo.js';

const mockPool = () => ({
  execute: vi.fn().mockResolvedValue([[], []]),
  query: vi.fn().mockResolvedValue([[], []]),
});

describe('StudentKnowledgeMasteryRepository', () => {
  it('upsertOnJudge：用 AS new 别名写法（VALUES() 在 MySQL 8.0.20+ 已废弃）', async () => {
    const pool = mockPool();
    const repo = new StudentKnowledgeMasteryRepository(pool as any);

    await repo.upsertOnJudge(11, 42, true);

    const sql = pool.execute.mock.calls[0][0] as string;
    expect(sql).toContain('INSERT INTO student_knowledge_mastery');
    expect(sql).toContain('AS new');
    expect(sql).not.toContain('VALUES(');          // 不许用已废弃写法
    expect(sql).toContain('ON DUPLICATE KEY UPDATE');
    // 累加而不是覆盖
    expect(sql).toContain('correct_count = student_knowledge_mastery.correct_count + new.correct_count');
    expect(sql).toContain('error_count   = student_knowledge_mastery.error_count   + new.error_count');
    // 分数与段位由累计值现算，且分母用 NULLIF 防除零
    expect(sql).toContain('NULLIF');
    expect(sql).toContain('FLOOR(5 *');
    // 首次插入：答对 → correct=1,error=0,score=1,level=5
    expect(pool.execute.mock.calls[0][1]).toEqual([11, 42, 1, 0, 1, 5]);
  });

  it('upsertOnJudge：赋值顺序 = 先计数后分数，且分数**不得**再累加 new.*（2026-09-22 实测坑）', async () => {
    const pool = mockPool();
    const repo = new StudentKnowledgeMasteryRepository(pool as any);
    await repo.upsertOnJudge(11, 42, true);
    const sql = pool.execute.mock.calls[0][0] as string;

    // ODKU 的 SET 从左到右求值、读到的是已更新的列：计数必须先写，
    // 否则 score 用的是旧计数（1 对 + 1 错会算成 1/3 而不是 1/2）。
    expect(sql.indexOf('error_count   = student_knowledge_mastery.error_count'))
      .toBeLessThan(sql.indexOf('mastery_score ='));

    // score/level 里再出现 `+ new.x` 就会把本次增量算两遍（实测 1 对 1 错得 0.333，应为 0.500）。
    const scorePart = sql.slice(sql.indexOf('mastery_score = student_knowledge_mastery.mastery_score'));
    expect(scorePart).not.toContain('new.correct_count');
    expect(scorePart).not.toContain('new.error_count');
  });

  it('upsertOnJudge：答错 → correct=0,error=1,score=0,level=0', async () => {
    const pool = mockPool();
    const repo = new StudentKnowledgeMasteryRepository(pool as any);

    await repo.upsertOnJudge(11, 42, false);

    expect(pool.execute.mock.calls[0][1]).toEqual([11, 42, 0, 1, 0, 0]);
  });

  it('listWeakest：JOIN knowledge_points 取名字，按 mastery_score 升序，Number() 化', async () => {
    const pool = mockPool();
    pool.query.mockResolvedValueOnce([
      [{ knowledge_point_id: 42, name: '分数加减', mastery_score: '0.500', level: '2',
         correct_count: '3', error_count: '3', last_seen_at: new Date('2026-09-16T10:00:00Z') }],
      [],
    ]);
    const repo = new StudentKnowledgeMasteryRepository(pool as any);

    const rows = await repo.listWeakest(11, 10);

    expect(rows).toEqual([{
      knowledgePointId: 42, name: '分数加减', masteryScore: 0.5, level: 2,
      correctCount: 3, errorCount: 3, lastSeenAt: new Date('2026-09-16T10:00:00Z'),
    }]);
    const [sql, params] = pool.query.mock.calls[0];
    expect(sql).toContain('ORDER BY mastery_score ASC');
    // LIMIT ? 必须用 query（客户端转义），execute 会被 MySQL 拒绝——既有约定
    expect(params).toEqual([11, 10]);
  });

  it('countQuestionCoverage：分母是 questions 总数，分子是去重后有 KP 的题数', async () => {
    const pool = mockPool();
    pool.execute.mockResolvedValueOnce([[{ total: '530', covered: '203' }], []]);
    const repo = new StudentKnowledgeMasteryRepository(pool as any);

    expect(await repo.countQuestionCoverage()).toEqual({ coveredQuestions: 203, totalQuestions: 530 });
    const sql = pool.execute.mock.calls[0][0] as string;
    expect(sql).toContain('COUNT(DISTINCT question_id)');
    expect(sql).toContain('FROM questions');
  });
});
