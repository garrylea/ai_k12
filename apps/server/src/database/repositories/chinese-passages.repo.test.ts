import { describe, it, expect, vi } from 'vitest';
import {
  ChinesePassagesRepository,
  buildDictationPrompt,
  toSentences,
  toKeyTerms,
} from './chinese-passages.repo';

const mockPool = (rows: any[] = []) => ({
  execute: vi.fn().mockResolvedValue([rows, []]),
  query: vi.fn().mockResolvedValue([rows, []]),
});

describe('buildDictationPrompt', () => {
  it('题面由篇名生成，且不含「并写出作者与朝代」这类噪音（写进题面等于泄题）', () => {
    expect(buildDictationPrompt('岳阳楼记')).toBe('请默写《岳阳楼记》');
    expect(buildDictationPrompt('岳阳楼记')).not.toContain('并写出');
  });
});

describe('ChinesePassagesRepository', () => {
  it('findVerifiedForDictation：三道闸门齐备 + 按 sort_order 排序 + 不再 JOIN questions', async () => {
    const pool = mockPool([]);
    const repo = new ChinesePassagesRepository(pool as any);
    await repo.findVerifiedForDictation();
    const [sql] = pool.execute.mock.calls[0];
    expect(sql).toContain('FROM chinese_passages dp');
    // 独立化的核心：表本身就是边界，不得再出现 questions
    expect(sql).not.toContain('questions');
    expect(sql).toContain('dp.verified = 1');
    expect(sql).toContain('dp.memorize_required = 1');
    expect(sql).toContain('dp.is_active = 1');
    expect(sql).toContain('ORDER BY dp.sort_order');
  });

  it('findRandomVerified：带册次过滤与 LIMIT，且抽题池守卫齐全', async () => {
    const pool = mockPool([]);
    const repo = new ChinesePassagesRepository(pool as any);
    await repo.findRandomVerified('上册', 5);
    const [sql, params] = pool.query.mock.calls[0];
    expect(sql).not.toContain('questions');
    expect(sql).not.toContain('student_hidden_questions');
    expect(sql).toContain('dp.verified = 1');
    expect(sql).toContain('dp.memorize_required = 1');
    expect(sql).toContain('dp.is_active = 1');
    expect(sql).toContain('dp.semester = ?');
    expect(sql).toContain('ORDER BY RAND()');
    expect(sql).toContain('LIMIT ?');
    expect(params).toEqual(['上册', 5]);
  });

  it('findRandomVerified：semester=null 时不含册次过滤，参数只有 count', async () => {
    const pool = mockPool([]);
    const repo = new ChinesePassagesRepository(pool as any);
    await repo.findRandomVerified(null, 5);
    const [sql, params] = pool.query.mock.calls[0];
    expect(sql).not.toContain('dp.semester = ?');
    expect(params).toEqual([5]);
  });

  it('findRandomVerified：「全部册次」时按篇名去重（MIN(id) 子查询）', async () => {
    // 实测九上/九下有 9 篇重复收录（同一篇两册各印一次，业务键含 semester 故各存一行）：
    // 不过滤册次时同一篇会被抽到两次，故必须按 work_title 去重。
    const pool = mockPool([]);
    const repo = new ChinesePassagesRepository(pool as any);
    await repo.findRandomVerified(null, 5);
    const [sql] = pool.query.mock.calls[0];
    expect(sql).toContain('MIN(dp2.id)');
    expect(sql).toContain('dp2.work_title = dp.work_title');
    // 子查询也必须守抽题池门禁，否则会挑到一个未校验/未标必背的同名行
    expect(sql).toContain('dp2.verified = 1');
    expect(sql).toContain('dp2.memorize_required = 1');
    expect(sql).toContain('dp2.is_active = 1');
  });

  it('findRandomVerified：指定册次时**不**加去重子查询', async () => {
    // 关键：子查询跨册取 MIN(id)，若外层已按册过滤会把该册的行整体排除掉
    // （上册行 id 更小 → 下册行 != 它）。单册内不会同名重复，无需去重。
    const pool = mockPool([]);
    const repo = new ChinesePassagesRepository(pool as any);
    await repo.findRandomVerified('下册', 5);
    const [sql] = pool.query.mock.calls[0];
    expect(sql).not.toContain('MIN(dp2.id)');
  });

  it('findVerifiedByIds：空数组直接返回空，不查库', async () => {
    const pool = mockPool([]);
    const repo = new ChinesePassagesRepository(pool as any);
    const rows = await repo.findVerifiedByIds([]);
    expect(rows).toEqual([]);
    expect(pool.execute).not.toHaveBeenCalled();
  });

  it('findVerifiedByIds：IN 占位符数量与参数顺序正确', async () => {
    const pool = mockPool([]);
    const repo = new ChinesePassagesRepository(pool as any);
    await repo.findVerifiedByIds([10, 11]);
    const [sql, params] = pool.execute.mock.calls[0];
    // 只测空数组短路的话，参数顺序写反也不会被发现
    expect(sql).toContain('dp.id IN (?,?)');
    expect(sql).toContain('dp.memorize_required = 1');
    expect(params).toEqual([10, 11]);
  });

  it('findById：按篇目 id 查单篇（判定路径，不设 verified/is_active 守卫）', async () => {
    const pool = mockPool([]);
    const repo = new ChinesePassagesRepository(pool as any);
    await repo.findById(100);
    const [sql, params] = pool.execute.mock.calls[0];
    expect(sql).toContain('WHERE dp.id = ?');
    expect(sql).toContain('LIMIT 1');
    expect(params).toEqual([100]);
    // 反面断言，防日后「顺手补门禁」：spec §6 明确裁决判定路径**有意不设门禁**
    // （不要为该路径补——那会误伤「按 ID 直接练某篇」等合法用法）。
    // 只有正面断言时，给 WHERE 加上 AND dp.verified = 1 测试仍会全绿。
    // 注意断言的是 `AND dp.xxx` 而非 `dp.xxx`——后者在 SELECT_COLS 里本来就出现。
    expect(sql).not.toContain('AND dp.verified');
    expect(sql).not.toContain('AND dp.is_active');
    expect(sql).not.toContain('AND dp.memorize_required');
  });

  it('upsert：按 (work_title, semester) 业务主键 upsert，verified 由入参决定', async () => {
    const pool = mockPool([]);
    const repo = new ChinesePassagesRepository(pool as any);
    await repo.upsert({
      workTitle: '静夜思', author: '李白', dynasty: '唐',
      body: '床前明月光', gradeBand: 'junior', grade: '九年级', semester: '上册',
      sortOrder: 1, sourceRef: 'DEV-FIXTURE', verified: 0, memorizeRequired: 0,
    });
    const [sql, params] = pool.execute.mock.calls[0];
    expect(sql).toContain('INSERT INTO chinese_passages');
    expect(sql).toContain('ON DUPLICATE KEY UPDATE');
    expect(sql).not.toContain('question_id');
    // 全参断言：若 verified 被写死成 1（覆盖导入器的校验闸门决定），只断 params[0] 不会发现
    expect(params).toEqual(['静夜思', '李白', '唐', '床前明月光', 'junior', '九年级', '上册', 1, 'DEV-FIXTURE', 0, 0]);
  });
});

// ==================== 解释（翻译）专项（2026-09-16） ====================

describe('ChinesePassagesRepository — 解释专项抽题池', () => {
  it('findVerifiedForInterpretation：三道闸门 = verified + is_active + 内容就绪，**不含** memorize_required', async () => {
    const pool = mockPool([]);
    const repo = new ChinesePassagesRepository(pool as any);
    await repo.findVerifiedForInterpretation();
    const [sql] = pool.execute.mock.calls[0];
    expect(sql).toContain('FROM chinese_passages dp');
    expect(sql).not.toContain('questions');
    expect(sql).toContain('dp.verified = 1');
    expect(sql).toContain('dp.is_active = 1');
    expect(sql).toContain('JSON_LENGTH(dp.sentences) > 0');
    // 与默写门禁的关键差别：「要背诵」不是「要理解翻译」的必要条件
    expect(sql).not.toContain('memorize_required = 1');
    expect(sql).toContain('ORDER BY dp.sort_order');
  });

  it('findRandomVerifiedForInterpretation：带册次过滤 + LIMIT + 解释门禁', async () => {
    const pool = mockPool([]);
    const repo = new ChinesePassagesRepository(pool as any);
    await repo.findRandomVerifiedForInterpretation('上册', 3);
    const [sql, params] = pool.query.mock.calls[0];
    expect(sql).toContain('dp.verified = 1');
    expect(sql).toContain('dp.is_active = 1');
    expect(sql).toContain('JSON_LENGTH(dp.sentences) > 0');
    expect(sql).not.toContain('memorize_required = 1');
    expect(sql).toContain('dp.semester = ?');
    expect(sql).toContain('ORDER BY RAND()');
    expect(sql).toContain('LIMIT ?');
    expect(params).toEqual(['上册', 3]);
  });

  it('findRandomVerifiedForInterpretation：semester=null 时按篇名去重，子查询同样守解释门禁', async () => {
    const pool = mockPool([]);
    const repo = new ChinesePassagesRepository(pool as any);
    await repo.findRandomVerifiedForInterpretation(null, 3);
    const [sql, params] = pool.query.mock.calls[0];
    expect(sql).not.toContain('dp.semester = ?');
    expect(sql).toContain('MIN(dp2.id)');
    expect(sql).toContain('dp2.work_title = dp.work_title');
    expect(sql).toContain('JSON_LENGTH(dp2.sentences) > 0');
    expect(sql).not.toContain('memorize_required = 1');
    expect(params).toEqual([3]);
  });

  it('findRandomVerifiedForInterpretation：指定册次时**不**加去重子查询', async () => {
    const pool = mockPool([]);
    const repo = new ChinesePassagesRepository(pool as any);
    await repo.findRandomVerifiedForInterpretation('下册', 3);
    const [sql] = pool.query.mock.calls[0];
    expect(sql).not.toContain('MIN(dp2.id)');
  });

  it('findVerifiedByIdsForInterpretation：空数组直接返回空，不查库', async () => {
    const pool = mockPool([]);
    const repo = new ChinesePassagesRepository(pool as any);
    expect(await repo.findVerifiedByIdsForInterpretation([])).toEqual([]);
    expect(pool.execute).not.toHaveBeenCalled();
  });

  it('findVerifiedByIdsForInterpretation：IN 占位符与参数顺序正确 + 解释门禁', async () => {
    const pool = mockPool([]);
    const repo = new ChinesePassagesRepository(pool as any);
    await repo.findVerifiedByIdsForInterpretation([7, 8]);
    const [sql, params] = pool.execute.mock.calls[0];
    expect(sql).toContain('dp.id IN (?,?)');
    expect(sql).toContain('JSON_LENGTH(dp.sentences) > 0');
    expect(sql).not.toContain('memorize_required = 1');
    expect(params).toEqual([7, 8]);
  });

  it('两条门禁确实不同：默写查询含 memorize_required 且不含内容就绪', async () => {
    // 反向对照，防日后有人「顺手统一」两条抽题池
    const pool = mockPool([]);
    const repo = new ChinesePassagesRepository(pool as any);
    await repo.findVerifiedForDictation();
    const [sql] = pool.execute.mock.calls[0];
    expect(sql).toContain('dp.memorize_required = 1');
    expect(sql).not.toContain('JSON_LENGTH');
  });
});

describe('toSentences / toKeyTerms（JSON 列 → 强类型，坏形状降级不抛错）', () => {
  it('toSentences：正常数组原样映射，缺 translation 补空串', () => {
    expect(toSentences([{ text: '庆历四年春。', translation: '庆历四年的春天。' }, { text: '越明年。' }]))
      .toEqual([
        { text: '庆历四年春。', translation: '庆历四年的春天。' },
        { text: '越明年。', translation: '' },
      ]);
  });

  it('toSentences：null / 非数组 / 元素非对象 / text 为空 → 逐项丢弃而非抛错', () => {
    // 手工改库或迁移中途都可能留下半截数据，让它把接口 500 掉不值得
    expect(toSentences(null)).toEqual([]);
    expect(toSentences('not-an-array')).toEqual([]);
    expect(toSentences({})).toEqual([]);
    expect(toSentences([null, 42, 'x', {}, { text: '' }, { text: 123 }])).toEqual([]);
  });

  it('toKeyTerms：正常项原样映射，含可选 src', () => {
    expect(toKeyTerms([
      { term: '谪守', gloss: '因罪贬谪流放', src: 'textbook', sentenceIndex: 0 },
      { term: '越明年', gloss: '到了第二年', sentenceIndex: 1 },
    ])).toEqual([
      { term: '谪守', gloss: '因罪贬谪流放', src: 'textbook', sentenceIndex: 0 },
      { term: '越明年', gloss: '到了第二年', sentenceIndex: 1 },
    ]);
  });

  it('toKeyTerms：sentenceIndex 不是整数的项**丢弃**（挂不到句子 = 学生没处填）', () => {
    expect(toKeyTerms([
      { term: '谪守', gloss: 'g', sentenceIndex: 0 },
      { term: '无归属', gloss: 'g' },              // 缺 sentenceIndex
      { term: '字符串下标', gloss: 'g', sentenceIndex: '0' },
      { term: '小数', gloss: 'g', sentenceIndex: 1.5 },
      { term: '', gloss: 'g', sentenceIndex: 0 },  // 空 term
    ])).toEqual([{ term: '谪守', gloss: 'g', sentenceIndex: 0 }]);
  });

  it('toKeyTerms：gloss 缺省补空串（不因缺解释就丢掉整个词）', () => {
    expect(toKeyTerms([{ term: '则', sentenceIndex: 2 }])).toEqual([{ term: '则', gloss: '', sentenceIndex: 2 }]);
  });
});
