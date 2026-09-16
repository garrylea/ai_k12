import { describe, it, expect, vi } from 'vitest';
import { EnglishWordsRepository, toMeanings, toRootAffixes } from './english-words.repo';

const mockPool = (rows: any[] = []) => ({
  execute: vi.fn().mockResolvedValue([rows, []]),
  query: vi.fn().mockResolvedValue([rows, []]),
});

const repoWith = (rows: any[] = []) => {
  const pool = mockPool(rows);
  return { pool, repo: new EnglishWordsRepository(pool as any) };
};

// ==================== JSON 列 → 强类型 ====================

describe('toMeanings（JSON 列 → 义项，坏形状降级不抛错）', () => {
  it('正常项原样映射，保留 pos / extended / context / note', () => {
    expect(
      toMeanings([
        { pos: 'n.', gloss: '地址', extended: false },
        {
          pos: 'v.',
          gloss: '处理；对付（问题）',
          extended: true,
          context: 'address the problem',
          note: '中高考高频僻义',
        },
      ]),
    ).toEqual([
      { pos: 'n.', gloss: '地址', extended: false },
      {
        pos: 'v.',
        gloss: '处理；对付（问题）',
        extended: true,
        context: 'address the problem',
        note: '中高考高频僻义',
      },
    ]);
  });

  it('null / 非数组 / 元素非对象 / gloss 为空 → 逐项丢弃而非抛错', () => {
    expect(toMeanings(null)).toEqual([]);
    expect(toMeanings('not-an-array')).toEqual([]);
    expect(toMeanings({})).toEqual([]);
    expect(toMeanings([null, 42, 'x', {}, { gloss: '' }, { gloss: 123 }])).toEqual([]);
  });

  it('extended 不是布尔 true 时一律按**常见义**处理', () => {
    // 方向不对称：把僻义误当常见义，最坏是白判一次；把常见义误当僻义，会让普通背词
    // 凭空冒出僻义题、逼学生答一个没学过的义项。所以要写成 === true。
    expect(toMeanings([{ gloss: '地址', extended: 'true' }])).toEqual([
      { pos: '', gloss: '地址', extended: false },
    ]);
    expect(toMeanings([{ gloss: '地址', extended: 1 }])[0].extended).toBe(false);
    expect(toMeanings([{ gloss: '地址' }])[0].extended).toBe(false);
    expect(toMeanings([{ gloss: '地址', extended: true }])[0].extended).toBe(true);
  });

  it('pos 缺省补空串；context / note 为空串或非字符串时不带该字段', () => {
    expect(toMeanings([{ gloss: '地址', context: '', note: 42 }])).toEqual([
      { pos: '', gloss: '地址', extended: false },
    ]);
  });
});

describe('toRootAffixes（JSON 列 → 词缀注记）', () => {
  it('正常项原样映射', () => {
    expect(
      toRootAffixes([
        { type: 'suffix', code: '-less', gloss: '无…的', posHint: '→ 形容词' },
        { type: 'prefix', code: 're-', gloss: '再；重新' },
      ]),
    ).toEqual([
      { type: 'suffix', code: '-less', gloss: '无…的', posHint: '→ 形容词' },
      { type: 'prefix', code: 're-', gloss: '再；重新' },
    ]);
  });

  it('type 非 prefix/suffix 或 code 为空的项丢弃（渲染不出来 = 看不见的死数据）', () => {
    expect(
      toRootAffixes([
        { type: 'suffix', code: '-ful', gloss: '充满…的' },
        { type: 'infix', code: '-x-', gloss: 'g' },
        { type: 'suffix', code: '', gloss: 'g' },
        { type: 'suffix', gloss: 'g' },
        null,
        'x',
      ]),
    ).toEqual([{ type: 'suffix', code: '-ful', gloss: '充满…的' }]);
  });

  it('gloss 缺省补空串（只有词缀形态也还能显示）', () => {
    expect(toRootAffixes([{ type: 'suffix', code: '-ly' }])).toEqual([
      { type: 'suffix', code: '-ly', gloss: '' },
    ]);
  });

  it('null / 非数组 → 空数组', () => {
    expect(toRootAffixes(null)).toEqual([]);
    expect(toRootAffixes('x')).toEqual([]);
  });
});

// ==================== 抽题池 ====================

describe('EnglishWordsRepository.findPool — 门禁与 level', () => {
  it('带两道内容闸门，且按 level 过滤', async () => {
    const { pool, repo } = repoWith([]);
    await repo.findPool({ levelPool: 'junior' });
    const [sql] = pool.execute.mock.calls[0];
    expect(sql).toContain('FROM english_words ew');
    expect(sql).toContain('ew.verified = 1');
    expect(sql).toContain('ew.is_active = 1');
    expect(sql).toContain('ew.level IN (?,?)');
  });

  it('junior 池含 primary（小学词并入初中池，页面不单列一档）', async () => {
    const { pool, repo } = repoWith([]);
    await repo.findPool({ levelPool: 'junior' });
    const [, params] = pool.execute.mock.calls[0];
    expect(params).toEqual(['primary', 'junior']);
  });

  it('senior 池只含高中两层，绝不落回初中/小学', async () => {
    const { pool, repo } = repoWith([]);
    await repo.findPool({ levelPool: 'senior' });
    const [, params] = pool.execute.mock.calls[0];
    expect(params).toEqual(['senior_required', 'senior_elective']);
    expect(params).not.toContain('junior');
    expect(params).not.toContain('primary');
  });

  it('all 池含四层', async () => {
    const { pool, repo } = repoWith([]);
    await repo.findPool({ levelPool: 'all' });
    const [sql, params] = pool.execute.mock.calls[0];
    expect(sql).toContain('ew.level IN (?,?,?,?)');
    expect(params).toEqual(['primary', 'junior', 'senior_required', 'senior_elective']);
  });

  it('不查 meanings（挑题阶段不得把答案带出来）', async () => {
    const { pool, repo } = repoWith([]);
    await repo.findPool({ levelPool: 'all' });
    const [sql] = pool.execute.mock.calls[0];
    expect(sql).not.toContain('meanings');
    expect(sql).not.toContain('root_affixes');
  });

  it('不在 SQL 里排序随机/截断（顺序模式与切 N 都在服务层，四种模式共用这一条 SQL）', async () => {
    const { pool, repo } = repoWith([]);
    await repo.findPool({ levelPool: 'all' });
    const [sql] = pool.execute.mock.calls[0];
    expect(sql).not.toContain('RAND()');
    expect(sql).not.toContain('LIMIT');
    expect(sql).toContain('ORDER BY ew.sort_order');
  });
});

describe('EnglishWordsRepository.findPool — 四个筛选', () => {
  it('只出熟词僻义 → has_extended_sense = 1（冗余列的存在理由：走索引，不搜 JSON）', async () => {
    const { pool, repo } = repoWith([]);
    await repo.findPool({ levelPool: 'all', onlyExtendedSense: true });
    const [sql] = pool.execute.mock.calls[0];
    expect(sql).toContain('ew.has_extended_sense = 1');
    expect(sql).not.toContain('JSON_');
  });

  it('易错词（全平台高频）→ 全局 error_count > 0，不 JOIN 进度表', async () => {
    const { pool, repo } = repoWith([]);
    await repo.findPool({ levelPool: 'all', onlyCommonWrong: true });
    const [sql] = pool.execute.mock.calls[0];
    expect(sql).toContain('ew.error_count > 0');
    expect(sql).not.toContain('JOIN');
  });

  it('无学生筛选时不 JOIN 进度表（别为省事常连，会平白多一次索引扫描）', async () => {
    const { pool, repo } = repoWith([]);
    await repo.findPool({ levelPool: 'all' });
    const [sql] = pool.execute.mock.calls[0];
    expect(sql).not.toContain('JOIN');
  });

  it('「只出没背过的」→ LEFT JOIN + IS NULL 分支（必须包含从没有进度行的词）', async () => {
    const { pool, repo } = repoWith([]);
    await repo.findPool({ levelPool: 'all', onlyNotLearned: true, studentId: 9 });
    const [sql] = pool.execute.mock.calls[0];
    // 必须是 LEFT JOIN：没背过 = 没进度行，INNER JOIN 会把它们全滤掉（正好滤反）
    expect(sql).toContain('LEFT JOIN student_word_progress swp');
    expect(sql).toContain('swp.student_id = ?');
    // 没有进度行时 swp.learned 是 NULL，`NULL = 0` 求值为 UNKNOWN，必须显式写 IS NULL
    expect(sql).toContain('(swp.id IS NULL OR swp.learned = 0)');
  });

  it('「我错过的词」→ LEFT JOIN + wrong_count > 0', async () => {
    const { pool, repo } = repoWith([]);
    await repo.findPool({ levelPool: 'all', onlyMyWrong: true, studentId: 9 });
    const [sql] = pool.execute.mock.calls[0];
    expect(sql).toContain('LEFT JOIN student_word_progress swp');
    expect(sql).toContain('swp.wrong_count > 0');
  });

  it('参数顺序：JOIN 的 studentId 在 level 之前（SQL 里 JOIN 写在 WHERE 前）', async () => {
    // 只断 SQL 文本的话，参数顺序写反也不会被发现，而它会让查询静默查错人
    const { pool, repo } = repoWith([]);
    await repo.findPool({ levelPool: 'junior', onlyNotLearned: true, studentId: 9 });
    const [, params] = pool.execute.mock.calls[0];
    expect(params).toEqual([9, 'primary', 'junior']);
  });

  it('漏传 studentId 时**报错**，而不是静默忽略筛选', async () => {
    const { pool, repo } = repoWith([]);
    await expect(repo.findPool({ levelPool: 'all', onlyNotLearned: true })).rejects.toThrow(
      /studentId/,
    );
    expect(pool.execute).not.toHaveBeenCalled();
  });

  it('筛选可以叠加，多个条件同时进 WHERE', async () => {
    const { pool, repo } = repoWith([]);
    await repo.findPool({
      levelPool: 'junior',
      onlyExtendedSense: true,
      onlyCommonWrong: true,
      onlyNotLearned: true,
      studentId: 9,
    });
    const [sql] = pool.execute.mock.calls[0];
    expect(sql).toContain('ew.has_extended_sense = 1');
    expect(sql).toContain('ew.error_count > 0');
    expect(sql).toContain('(swp.id IS NULL OR swp.learned = 0)');
  });
});

describe('EnglishWordsRepository.findPool — 指定字母开头', () => {
  it('用 LIKE a% 而不是 LEFT(word,1)', async () => {
    const { pool, repo } = repoWith([]);
    await repo.findPool({ levelPool: 'all', letter: 'a' });
    const [sql, params] = pool.execute.mock.calls[0];
    expect(sql).toContain('ew.word LIKE ?');
    expect(params).toContain('a%');
  });

  it('字母统一小写', async () => {
    const { pool, repo } = repoWith([]);
    await repo.findPool({ levelPool: 'all', letter: 'A' });
    const [, params] = pool.execute.mock.calls[0];
    expect(params).toContain('a%');
  });

  it('非法字母（多字符/通配符/数字）不产生 LIKE 条件，杜绝通配符注入', async () => {
    for (const bad of ['ab', '%', '_', 'a1', '中']) {
      const { pool, repo } = repoWith([]);
      await repo.findPool({ levelPool: 'all', letter: bad });
      const [sql, params] = pool.execute.mock.calls[0];
      expect(sql).not.toContain('LIKE');
      expect(params).toEqual(['primary', 'junior', 'senior_required', 'senior_elective']);
    }
  });

  it('letter 为 null / undefined 时不加条件', async () => {
    const { pool, repo } = repoWith([]);
    await repo.findPool({ levelPool: 'all', letter: null });
    const [sql] = pool.execute.mock.calls[0];
    expect(sql).not.toContain('LIKE');
  });
});

// ==================== 取详情 / 词根族 / 计数 ====================

describe('EnglishWordsRepository 其余方法', () => {
  it('findByIds：空数组直接返回空，不查库', async () => {
    const { pool, repo } = repoWith([]);
    expect(await repo.findByIds([])).toEqual([]);
    expect(pool.execute).not.toHaveBeenCalled();
  });

  it('findByIds：IN 占位符与参数顺序正确，且守门禁', async () => {
    const { pool, repo } = repoWith([]);
    await repo.findByIds([3, 4]);
    const [sql, params] = pool.execute.mock.calls[0];
    expect(sql).toContain('ew.id IN (?,?)');
    expect(sql).toContain('ew.verified = 1');
    expect(sql).toContain('ew.is_active = 1');
    expect(params).toEqual([3, 4]);
  });

  it('findById：判定路径**有意不设门禁**（抽到的词中途下架也要能判出结果）', async () => {
    const { pool, repo } = repoWith([]);
    await repo.findById(7);
    const [sql, params] = pool.execute.mock.calls[0];
    expect(sql).toContain('WHERE ew.id = ?');
    expect(sql).toContain('LIMIT 1');
    expect(params).toEqual([7]);
    // 反面断言：日后「顺手补门禁」会让这里变红。断 AND ew.xxx 而非 ew.xxx —— 后者在 SELECT_COLS 里本来就有。
    expect(sql).not.toContain('AND ew.verified');
    expect(sql).not.toContain('AND ew.is_active');
  });

  it('findFamily：一句 root_key = ? 取全族 + 守门禁 + 按课标原序', async () => {
    const { pool, repo } = repoWith([]);
    await repo.findFamily('care');
    const [sql, params] = pool.execute.mock.calls[0];
    expect(sql).toContain('ew.root_key = ?');
    expect(sql).toContain('ew.verified = 1');
    expect(sql).toContain('ew.is_active = 1');
    expect(sql).toContain('ORDER BY ew.sort_order');
    expect(params).toEqual(['care']);
  });

  it('incrementErrorCount：自增表达式，绝不用读改写', async () => {
    const { pool, repo } = repoWith([]);
    await repo.incrementErrorCount(12);
    const [sql, params] = pool.execute.mock.calls[0];
    expect(sql).toContain('UPDATE english_words SET error_count = error_count + 1');
    expect(sql).toContain('WHERE id = ?');
    expect(params).toEqual([12]);
  });

  it('countByLevel：缺内容的层补 0，而不是整项消失', async () => {
    const { repo } = repoWith([
      { level: 'junior', count: 1095 },
      { level: 'senior_required', count: 500 },
    ]);
    expect(await repo.countByLevel()).toEqual([
      { level: 'primary', count: 0 },
      { level: 'junior', count: 1095 },
      { level: 'senior_required', count: 500 },
      { level: 'senior_elective', count: 0 },
    ]);
    void repo;
  });

  it('countPoolStats：四个筛选的池子规模 + 已背过，走一次聚合且 LEFT JOIN 进度表', async () => {
    const { pool, repo } = repoWith([
      { total: 3000, extended: 120, commonWrong: 46, myWrong: 8, learned: 37 },
    ]);
    const stats = await repo.countPoolStats(9);
    const [sql, params] = pool.execute.mock.calls[0];
    expect(sql).toContain('LEFT JOIN student_word_progress swp');
    expect(sql).toContain('COUNT(CASE WHEN ew.has_extended_sense = 1 THEN 1 END)');
    expect(sql).toContain('COUNT(CASE WHEN ew.error_count > 0 THEN 1 END)');
    expect(sql).toContain('COUNT(CASE WHEN swp.wrong_count > 0 THEN 1 END)');
    expect(params).toEqual([9]);
    expect(stats).toEqual({ total: 3000, extended: 120, commonWrong: 46, myWrong: 8, learned: 37 });
  });

  it('countPoolStats：无行时全为 0（空库不该让配置页 500）', async () => {
    const { repo } = repoWith([]);
    expect(await repo.countPoolStats(9)).toEqual({
      total: 0,
      extended: 0,
      commonWrong: 0,
      myWrong: 0,
      learned: 0,
    });
  });
});
