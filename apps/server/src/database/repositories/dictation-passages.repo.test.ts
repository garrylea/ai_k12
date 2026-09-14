import { describe, it, expect, vi } from 'vitest';
import { DictationPassagesRepository } from './dictation-passages.repo';

const mockPool = (rows: any[] = []) => ({
  execute: vi.fn().mockResolvedValue([rows, []]),
  query: vi.fn().mockResolvedValue([rows, []]),
});

describe('DictationPassagesRepository', () => {
  it('findVerifiedBySubject：只出 verified=1 且题未停用，按 sort_order 排序', async () => {
    const pool = mockPool([]);
    const repo = new DictationPassagesRepository(pool as any);
    await repo.findVerifiedBySubject(2);
    const [sql, params] = pool.execute.mock.calls[0];
    expect(sql).toContain('FROM dictation_passages dp');
    expect(sql).toContain('JOIN questions q ON q.id = dp.question_id');
    expect(sql).toContain('dp.verified = 1');
    expect(sql).toContain('dp.memorize_required = 1');
    expect(sql).toContain('q.is_active = 1');
    expect(sql).toContain('q.subject_id = ?');
    expect(sql).toContain('ORDER BY dp.sort_order');
    expect(params).toEqual([2]);
  });

  it('findRandomVerified：排除已标记不再展示的题，带 LIMIT 与册次过滤', async () => {
    const pool = mockPool([]);
    const repo = new DictationPassagesRepository(pool as any);
    await repo.findRandomVerified(7, 2, '上册', 5);
    const [sql, params] = pool.query.mock.calls[0];
    expect(sql).toContain('LEFT JOIN student_hidden_questions shq');
    expect(sql).toContain('shq.question_id = dp.question_id AND shq.student_id = ?');
    expect(sql).toContain('shq.id IS NULL');
    // 抽题池守卫（spec §6）：未校验篇目与已停用题绝不能进抽题池——若这两条守卫
    // 被误删，其余断言仍会全绿，故必须显式钉住
    expect(sql).toContain('dp.verified = 1');
    expect(sql).toContain('dp.memorize_required = 1');
    expect(sql).toContain('q.is_active = 1');
    expect(sql).toContain('dp.semester = ?');
    expect(sql).toContain('ORDER BY RAND()');
    expect(sql).toContain('LIMIT ?');
    expect(params).toEqual([7, 2, '上册', 5]);
  });

  it('findRandomVerified：semester=null 时不含册次过滤', async () => {
    const pool = mockPool([]);
    const repo = new DictationPassagesRepository(pool as any);
    await repo.findRandomVerified(7, 2, null, 5);
    const [sql, params] = pool.query.mock.calls[0];
    expect(sql).not.toContain('dp.semester = ?');
    expect(params).toEqual([7, 2, 5]);
  });

  it('findRandomVerified：「全部册次」时按篇名去重（MIN(id) 子查询）', async () => {
    // 实测九上/九下有 9 篇重复收录（同一篇在两册各印一次，业务键含 semester 故各存一行）：
    // 不过滤册次时同一篇会被抽到两次，故必须按 work_title 去重。
    const pool = mockPool([]);
    const repo = new DictationPassagesRepository(pool as any);
    await repo.findRandomVerified(7, 2, null, 5);
    const [sql] = pool.query.mock.calls[0];
    expect(sql).toContain('MIN(dp2.id)');
    expect(sql).toContain('dp2.work_title = dp.work_title');
    // 子查询也必须守抽题池门禁，否则会挑到一个未校验/未标必背的同名行
    expect(sql).toContain('dp2.verified = 1');
    expect(sql).toContain('dp2.memorize_required = 1');
  });

  it('findRandomVerified：指定册次时**不**加去重子查询', async () => {
    // 关键：子查询跨册取 MIN(id)，若外层已按册过滤会把该册的行整体排除掉
    // （上册行 id 更小 → 下册行 != 它）。单册内不会同名重复，无需去重。
    const pool = mockPool([]);
    const repo = new DictationPassagesRepository(pool as any);
    await repo.findRandomVerified(7, 2, '下册', 5);
    const [sql] = pool.query.mock.calls[0];
    expect(sql).not.toContain('MIN(dp2.id)');
  });

  it('findVerifiedByQuestionIds：空数组直接返回空，不查库', async () => {
    const pool = mockPool([]);
    const repo = new DictationPassagesRepository(pool as any);
    const rows = await repo.findVerifiedByQuestionIds(2, []);
    expect(rows).toEqual([]);
    expect(pool.execute).not.toHaveBeenCalled();
  });

  it('findVerifiedByQuestionIds：非空时 IN 占位符数量与参数顺序正确', async () => {
    const pool = mockPool([]);
    const repo = new DictationPassagesRepository(pool as any);
    await repo.findVerifiedByQuestionIds(2, [10, 11]);
    const [sql, params] = pool.execute.mock.calls[0];
    // 只测空数组短路的话，subjectId 与 ids 顺序写反也不会被发现
    expect(sql).toContain('dp.question_id IN (?,?)');
    expect(sql).toContain('dp.memorize_required = 1');
    expect(params).toEqual([2, 10, 11]);
  });

  it('findByQuestionId：按题 id 查单篇（供判题内部使用，不设 verified/is_active 守卫）', async () => {
    const pool = mockPool([]);
    const repo = new DictationPassagesRepository(pool as any);
    await repo.findByQuestionId(100);
    const [sql, params] = pool.execute.mock.calls[0];
    expect(sql).toContain('WHERE dp.question_id = ?');
    expect(sql).toContain('LIMIT 1');
    expect(params).toEqual([100]);
  });

  it('upsert：按 (work_title, semester) 业务主键 upsert，且 verified 由入参决定', async () => {
    const pool = mockPool([]);
    const repo = new DictationPassagesRepository(pool as any);
    await repo.upsert({
      questionId: 100, workTitle: '静夜思', author: '李白', dynasty: '唐',
      body: '床前明月光', gradeBand: 'junior', grade: '九年级', semester: '上册',
      sortOrder: 1, sourceRef: 'DEV-FIXTURE', verified: 0, memorizeRequired: 0,
    });
    const [sql, params] = pool.execute.mock.calls[0];
    expect(sql).toContain('INSERT INTO dictation_passages');
    expect(sql).toContain('ON DUPLICATE KEY UPDATE');
    expect(sql).toContain('work_title');
    // 全参断言：若 verified 被写死成 1（覆盖导入器的校验闸门决定），只断 params[0] 不会发现
    expect(params).toEqual([100, '静夜思', '李白', '唐', '床前明月光', 'junior', '九年级', '上册', 1, 'DEV-FIXTURE', 0, 0]);
  });
});
