import { describe, it, expect, vi } from 'vitest';
import { VocabularyService } from './vocabulary.service.js';
import type { EnglishWordRow, EnglishWordPoolRow } from '../../database/repositories/english-words.repo.js';
import type {
  VocabularyDirection,
  VocabularyOrder,
  VocabularyQuestionItem,
  VocabularyStartInput,
} from './dto/vocabulary.dto.js';

// ---------------------------------------------------------------- 夹具

// RowDataPacket 带 `constructor: RowDataPacket`，直接 Partial<> 会因 constructor 类型不兼容而报错，
// 所以覆盖项显式排除 constructor。
type WordOverrides = Partial<Omit<EnglishWordRow, 'constructor'>>;
type PoolOverrides = Partial<Omit<EnglishWordPoolRow, 'constructor'>>;

const word = (
  id: number,
  w: string,
  meanings: unknown,
  extra: WordOverrides = {},
): EnglishWordRow =>
  ({
    id,
    word: w,
    phonetic: `/${w}/`,
    level: 'junior',
    meanings,
    has_extended_sense: 0,
    root_key: null,
    root_affixes: null,
    error_count: 0,
    sort_order: id,
    source_ref: null,
    verified: 1,
    is_active: 1,
    ...extra,
  }) as EnglishWordRow;

const poolRow = (id: number, w: string, extra: PoolOverrides = {}): EnglishWordPoolRow =>
  ({
    id,
    word: w,
    level: 'junior',
    has_extended_sense: 0,
    error_count: 0,
    sort_order: id,
    ...extra,
  }) as EnglishWordPoolRow;

const ADDRESS_MEANINGS = [
  { pos: 'n.', gloss: '地址', extended: false },
  { pos: 'n.', gloss: '演说；演讲', extended: false },
  {
    pos: 'v.',
    gloss: '处理；对付（问题）',
    extended: true,
    context: 'address the problem',
    note: '中高考高频僻义',
  },
];
const CARE_MEANINGS = [{ pos: 'n.', gloss: '照顾；小心', extended: false }];

const ADDRESS = word(1, 'address', ADDRESS_MEANINGS, { has_extended_sense: 1, root_key: null });
const CARE = word(2, 'care', CARE_MEANINGS, { root_key: 'care' });

interface Harness {
  service: VocabularyService;
  wordsRepo: Record<string, ReturnType<typeof vi.fn>>;
  progressRepo: Record<string, ReturnType<typeof vi.fn>>;
  judge: { generate: ReturnType<typeof vi.fn> };
  recordResult: ReturnType<typeof vi.fn>;
}

const harness = (opts: {
  rows?: EnglishWordRow[];
  pool?: EnglishWordPoolRow[];
  random?: () => number;
  now?: () => Date;
  judgeVerdict?: string;
} = {}): Harness => {
  const rows = opts.rows ?? [ADDRESS, CARE];
  const byId = new Map(rows.map((r) => [r.id, r]));
  const wordsRepo = {
    findById: vi.fn(async (id: number) => byId.get(id) ?? null),
    findPool: vi.fn(async () => opts.pool ?? rows.map((r) => poolRow(r.id, r.word))),
    findByIds: vi.fn(async (ids: number[]) => ids.map((id) => byId.get(id)).filter(Boolean)),
    findFamily: vi.fn(async () => []),
    incrementErrorCount: vi.fn(async () => undefined),
    countByLevel: vi.fn(async () => [
      { level: 'primary', count: 505 },
      { level: 'junior', count: 1095 },
      { level: 'senior_required', count: 500 },
      { level: 'senior_elective', count: 1000 },
    ]),
    countPoolStats: vi.fn(async () => ({
      total: 3100,
      extended: 120,
      commonWrong: 46,
      myWrong: 8,
      learned: 37,
    })),
  };
  const progressRepo = {
    findByStudentAndWord: vi.fn(async () => null),
    recordResult: vi.fn(async () => undefined),
    clearWrongCount: vi.fn(async () => undefined),
    countSeenSince: vi.fn(async () => 12),
  };
  const judge = {
    generate: vi.fn(async () => ({ verdict: opts.judgeVerdict ?? 'wrong', comment: null })),
  };
  const service = new VocabularyService(
    wordsRepo as never,
    progressRepo as never,
    {
      judge: judge as never,
      random: opts.random ?? (() => 0),
      now: opts.now ?? (() => new Date('2026-09-16T10:00:00+08:00')),
    },
  );
  return { service, wordsRepo, progressRepo, judge, recordResult: progressRepo.recordResult };
};

const startInput = (over: Partial<VocabularyStartInput> = {}): VocabularyStartInput => ({
  levelPool: 'all',
  count: 10,
  order: 'random',
  letter: null,
  direction: 'en2cn',
  ...over,
});

/** 抽到「address 的僻义」还是「常见义」由 random 决定；固定 random 可稳定复现。 */
const findQuestion = (questions: VocabularyQuestionItem[], wordId: number) =>
  questions.find((q) => q.wordId === wordId)!;

// ---------------------------------------------------------------- 开练：防泄漏

describe('VocabularyService.start — 防泄漏', () => {
  it('中→英题**不返回** word / phonetic / context / hasFamily（每一项都能顺出答案）', async () => {
    const { service } = harness({ random: () => 0 });
    // random=0 → 常见义候选，再掷一次 0 < 0.5 → en2cn；要拿 cn2en 得让第二次掷出 >= 0.5
    const { questions } = await service.start(
      startInput({ direction: 'cn2en', rows: [CARE] } as never),
      9,
    );
    const q = questions[0];
    expect(q.promptKind).toBe('cn2en');
    // 题面是中文释义
    expect(q.prompt).toBe('照顾；小心');
    expect(q.phonetic).toBeNull();
    expect(q.context).toBeNull();
    expect(q.hasFamily).toBe(false);
    // 整个对象里不能出现英文单词本身
    expect(JSON.stringify(q)).not.toContain('care');
  });

  it('英→中题给单词与音标，并按词根族有无给出 hasFamily', async () => {
    const { service } = harness({ rows: [CARE] });
    const { questions } = await service.start(startInput({ direction: 'en2cn' }), 9);
    expect(questions[0].promptKind).toBe('en2cn');
    expect(questions[0].prompt).toBe('care');
    expect(questions[0].phonetic).toBe('/care/');
    expect(questions[0].hasFamily).toBe(true);
  });
});

// ---------------------------------------------------------------- 开练：抽题

describe('VocabularyService.start — 抽题与顺序', () => {
  it('题库为空 → 空题目、poolSize=0（不是报错）', async () => {
    const { service } = harness({ pool: [], rows: [] });
    expect(await service.start(startInput(), 9)).toEqual({ questions: [], poolSize: 0 });
  });

  it('会话长度 == count（一个词一道题，不是每个僻义各一道）', async () => {
    const rows = Array.from({ length: 30 }, (_, i) => word(i + 1, `w${i + 1}`, CARE_MEANINGS));
    const { service } = harness({ rows, random: () => 0.5 });
    const { questions, poolSize } = await service.start(startInput({ count: 12 }), 9);
    expect(questions).toHaveLength(12);
    expect(poolSize).toBe(30);
  });

  it('count 夹到 10–20 区间（越界不报错，也不放行超大请求）', async () => {
    const rows = Array.from({ length: 40 }, (_, i) => word(i + 1, `w${i + 1}`, CARE_MEANINGS));
    const { service } = harness({ rows, random: () => 0.5 });
    expect((await service.start(startInput({ count: 3 }), 9)).questions).toHaveLength(10);
    expect((await service.start(startInput({ count: 999 }), 9)).questions).toHaveLength(20);
  });

  it('alpha 升序 / alpha_desc 降序（按 word 字典序）', async () => {
    const rows = [word(1, 'zebra', CARE_MEANINGS), word(2, 'apple', CARE_MEANINGS), word(3, 'mango', CARE_MEANINGS)];
    const { service } = harness({ rows });
    const asc = await service.start(startInput({ order: 'alpha' }), 9);
    expect(asc.questions.map((q) => q.prompt)).toEqual(['apple', 'mango', 'zebra']);
    const desc = await service.start(startInput({ order: 'alpha_desc' }), 9);
    expect(desc.questions.map((q) => q.prompt)).toEqual(['zebra', 'mango', 'apple']);
  });

  it('随机模式下注入的 random 让结果可复现（洗牌由注入源驱动，不碰 Math.random）', async () => {
    const rows = [word(1, 'aaa', CARE_MEANINGS), word(2, 'bbb', CARE_MEANINGS), word(3, 'ccc', CARE_MEANINGS)];
    const a = await harness({ rows, random: () => 0 }).service.start(startInput({ count: 10 }), 9);
    const b = await harness({ rows, random: () => 0 }).service.start(startInput({ count: 10 }), 9);
    expect(a.questions.map((q) => q.prompt)).toEqual(b.questions.map((q) => q.prompt));
  });

  it('order=letter 时把字母交给仓储；其它模式一律传 null', async () => {
    const { service, wordsRepo } = harness();
    await service.start(startInput({ order: 'letter', letter: 'a' }), 9);
    expect(wordsRepo.findPool.mock.calls[0][0].letter).toBe('a');
    await service.start(startInput({ order: 'random', letter: null }), 9);
    expect(wordsRepo.findPool.mock.calls[1][0].letter).toBeNull();
    // 非 letter 模式即便带了字母也不透传到 SQL
    await service.start(startInput({ order: 'alpha', letter: 'b' }), 9);
    expect(wordsRepo.findPool.mock.calls[2][0].letter).toBeNull();
  });

  it('四个筛选原样透传给仓储', async () => {
    const { service, wordsRepo } = harness();
    await service.start(
      startInput({ onlyNotLearned: true, onlyMyWrong: true, onlyCommonWrong: true, onlyExtendedSense: true }),
      9,
    );
    const filter = wordsRepo.findPool.mock.calls[0][0];
    expect(filter).toMatchObject({
      onlyNotLearned: true,
      onlyMyWrong: true,
      onlyCommonWrong: true,
      onlyExtendedSense: true,
      studentId: 9,
    });
  });

  it('抽到的词中途被删（findByIds 少一行）不炸，按取到的行出题', async () => {
    const rows = [word(1, 'aaa', CARE_MEANINGS), word(2, 'bbb', CARE_MEANINGS)];
    const { service, wordsRepo } = harness({ rows });
    wordsRepo.findByIds.mockResolvedValueOnce([rows[0]]);
    const { questions } = await service.start(startInput(), 9);
    expect(questions).toHaveLength(1);
  });

  it('没有可用释义的词被跳过（出不了题，但也不该让整个会话失败）', async () => {
    const rows = [word(1, 'broken', []), word(2, 'care', CARE_MEANINGS)];
    const { service } = harness({ rows });
    const { questions } = await service.start(startInput({ direction: 'en2cn' }), 9);
    expect(questions.map((q) => q.prompt)).toEqual(['care']);
  });
});

// ---------------------------------------------------------------- 开练：熟词僻义

describe('VocabularyService.start — 熟词僻义', () => {
  it('普通模式下也会抽到僻义题（否则学生默认根本碰不到熟词僻义）', async () => {
    // random=0 → 在 [常见义, 僻义] 里取第 0 个 = 常见义；要让两次都选僻义，用返回 0.99 的源
    const { service } = harness({ rows: [ADDRESS], random: () => 0.99 });
    const q = findQuestion((await service.start(startInput({ direction: 'en2cn' }), 9)).questions, 1);
    expect(q.isExtendedSense).toBe(true);
  });

  it('僻义题是英→中 + 带锁定僻义的语境（三档判题口径的前提）', async () => {
    const { service } = harness({ rows: [ADDRESS], random: () => 0.99 });
    const q = findQuestion((await service.start(startInput({ direction: 'en2cn' }), 9)).questions, 1);
    expect(q.promptKind).toBe('en2cn');
    expect(q.prompt).toBe('address');
    expect(q.context).toBe('address the problem');
    expect(q.senseIndex).toBe(2); // 僻义在 meanings 的下标
  });

  it('抽到常见义时不带语境、也不算僻义题', async () => {
    const { service } = harness({ rows: [ADDRESS], random: () => 0 });
    const q = findQuestion((await service.start(startInput({ direction: 'en2cn' }), 9)).questions, 1);
    expect(q.isExtendedSense).toBe(false);
    expect(q.context).toBeNull();
  });

  it('勾「只出熟词僻义」→ 方向被强制成英→中（即便请求里传了中→英）', async () => {
    // 三档判题（含 off_target）建立在「题面给单词 + 语境、学生答中文」之上；
    // 若允许中→英，题面就成了僻义中文、答案是单词，off_target 这一档失去意义。
    const { service } = harness({ rows: [ADDRESS], random: () => 0.99 });
    const { questions } = await service.start(
      startInput({ onlyExtendedSense: true, direction: 'cn2en' }),
      9,
    );
    expect(questions[0].promptKind).toBe('en2cn');
    expect(questions[0].isExtendedSense).toBe(true);
    // 必须给出单词原文，否则学生不知道在考哪个词
    expect(questions[0].prompt).toBe('address');
  });

  it('勾「只出熟词僻义」→ 没有僻义的词一道不出', async () => {
    const { service } = harness({ rows: [ADDRESS, CARE], random: () => 0.99 });
    const { questions } = await service.start(startInput({ onlyExtendedSense: true }), 9);
    expect(questions.map((q) => q.wordId)).toEqual([1]);
  });
});

// ---------------------------------------------------------------- 判题：三条路由

const judgeInput = (over: Partial<Parameters<VocabularyService['judge']>[0]> = {}) => ({
  wordId: 1,
  senseIndex: 0,
  promptKind: 'en2cn' as const,
  answer: '地址',
  ...over,
});

describe('VocabularyService.judge — 路由 1：中→英纯程序', () => {
  it('拼对即对，且**不调 LLM**', async () => {
    const h = harness();
    const res = await h.service.judge(judgeInput({ promptKind: 'cn2en', answer: 'address' }), 9);
    expect(res.verdict).toBe('correct');
    expect(res.method).toBe('exact');
    expect(h.judge.generate).not.toHaveBeenCalled();
  });

  it('忽略大小写、首尾空白、末尾句号、拼写变体', async () => {
    for (const answer of ['Address', ' address ', 'address.', 'adress']) {
      const h = harness();
      const res = await h.service.judge(judgeInput({ promptKind: 'cn2en', answer }), 9);
      // 'adress' 是拼错，其余都对
      expect(res.verdict, `answer=${answer}`).toBe(answer === 'adress' ? 'wrong' : 'correct');
    }
  });

  it('拼错 → wrong + 给出逐字符差异（供前端高亮）；也不调 LLM', async () => {
    const h = harness();
    const res = await h.service.judge(judgeInput({ promptKind: 'cn2en', answer: 'adress' }), 9);
    expect(res.verdict).toBe('wrong');
    expect(res.method).toBe('exact');
    expect(res.spellingDiff?.some((op) => op.type === 'wrong')).toBe(true);
    expect(h.judge.generate).not.toHaveBeenCalled();
  });

  it('答对时 spellingDiff 为 null（没错就不用高亮）', async () => {
    const h = harness();
    expect((await h.service.judge(judgeInput({ promptKind: 'cn2en', answer: 'address' }), 9)).spellingDiff).toBeNull();
  });
});

describe('VocabularyService.judge — 路由 2：英→中常见义', () => {
  it('与释义原子归一化相等 → correct，**不调 LLM**（程序短路）', async () => {
    const h = harness();
    const res = await h.service.judge(judgeInput({ senseIndex: 0, answer: '地址' }), 9);
    expect(res.verdict).toBe('correct');
    expect(res.method).toBe('exact');
    expect(h.judge.generate).not.toHaveBeenCalled();
  });

  it('同义词（程序判不了）→ 交给 LLM 判', async () => {
    const h = harness({ judgeVerdict: 'correct' });
    const res = await h.service.judge(judgeInput({ senseIndex: 0, answer: '住址' }), 9);
    expect(res.verdict).toBe('correct');
    expect(res.method).toBe('ai');
    expect(h.judge.generate).toHaveBeenCalledTimes(1);
  });

  it('常见义模式给模型的是**全部常见义**，且不带语境', async () => {
    const h = harness();
    await h.service.judge(judgeInput({ senseIndex: 0, answer: '住址' }), 9);
    const req = h.judge.generate.mock.calls[0][0];
    expect(req.mode).toBe('common');
    expect(req.context).toBeNull();
    expect(req.target.gloss).toContain('地址');
    expect(req.target.gloss).toContain('演说'); // 同属常见义，答到任一个都算对
    // 僻义要作为「其他义项」列出，模型才能判出学生是不是答了僻义
    expect(req.otherGlosses.join()).toContain('处理');
  });
});

describe('VocabularyService.judge — 路由 3：英→中熟词僻义', () => {
  it('答中目标僻义 → correct，程序短路不调 LLM', async () => {
    const h = harness();
    const res = await h.service.judge(judgeInput({ senseIndex: 2, answer: '处理' }), 9);
    expect(res.verdict).toBe('correct');
    expect(res.method).toBe('exact');
    expect(h.judge.generate).not.toHaveBeenCalled();
  });

  it('答成常见义（「地址」）→ 走 LLM 判 off_target，且**必须把语境与常见义交给模型**', async () => {
    const h = harness({ judgeVerdict: 'off_target' });
    const res = await h.service.judge(judgeInput({ senseIndex: 2, answer: '住的地方' }), 9);
    expect(res.verdict).toBe('off_target');
    expect(res.method).toBe('ai');
    const req = h.judge.generate.mock.calls[0][0];
    expect(req.mode).toBe('extended');
    // 语境是本题的考点所在，漏传模型就无从判断「在这个搭配里它是什么意思」
    expect(req.context).toBe('address the problem');
    expect(req.target.gloss).toBe('处理；对付（问题）');
    // 常见义必须作为「其他义项」列出，否则模型判不出 off_target
    expect(req.otherGlosses.join()).toContain('地址');
  });
});

describe('VocabularyService.judge — 未作答 / 模型失败 / 越界', () => {
  it('空作答 → unanswered，不调 LLM、不计错', async () => {
    const h = harness();
    const res = await h.service.judge(judgeInput({ answer: '   ' }), 9);
    expect(res.verdict).toBe('unanswered');
    expect(h.judge.generate).not.toHaveBeenCalled();
    expect(h.wordsRepo.incrementErrorCount).not.toHaveBeenCalled();
    expect(h.recordResult.mock.calls[0][0]).toMatchObject({ learned: 0, wrongDelta: 0 });
  });

  it('非字符串作答（如 number）在服务层也安全降级为未作答，不抛 TypeError', async () => {
    const h = harness();
    const res = await h.service.judge(judgeInput({ answer: 123 as never }), 9);
    expect(res.verdict).toBe('unanswered');
  });

  it('模型失败 → undetermined，不计错、不判错（判题失败不该让学生背锅）', async () => {
    const h = harness();
    h.judge.generate.mockRejectedValueOnce(new Error('llm down'));
    const res = await h.service.judge(judgeInput({ senseIndex: 0, answer: '住址' }), 9);
    expect(res.verdict).toBe('undetermined');
    expect(h.wordsRepo.incrementErrorCount).not.toHaveBeenCalled();
    expect(h.recordResult.mock.calls[0][0]).toMatchObject({ wrongDelta: 0 });
  });

  it('senseIndex 越界（内容重灌后下标漂移）→ 按「全义项都接受」判，宁放过不错杀', async () => {
    const h = harness();
    const res = await h.service.judge(judgeInput({ senseIndex: 99, answer: '演说' }), 9);
    expect(res.verdict).toBe('correct');
    expect(h.judge.generate).not.toHaveBeenCalled();
  });

  it('wordId 不存在 → 404', async () => {
    const h = harness();
    await expect(h.service.judge(judgeInput({ wordId: 404 }), 9)).rejects.toThrow(/单词不存在/);
  });

  it('判题结果里带标准答案（判完就该让学生看见，含僻义标记与搭配）', async () => {
    const h = harness();
    const res = await h.service.judge(judgeInput({ senseIndex: 2, answer: '处理' }), 9);
    expect(res.standard.word).toBe('address');
    expect(res.standard.meanings).toHaveLength(3);
    expect(res.standard.target).toMatchObject({ gloss: '处理；对付（问题）', extended: true, context: 'address the problem' });
  });
});

// ---------------------------------------------------------------- 判题：记账

describe('VocabularyService.judge — 记账规则', () => {
  it('correct → 置 learned、不加错次、不动全局计数', async () => {
    const h = harness();
    await h.service.judge(judgeInput({ senseIndex: 0, answer: '地址' }), 9);
    expect(h.recordResult.mock.calls[0][0]).toMatchObject({
      studentId: 9, wordId: 1, learned: 1, wrongDelta: 0, lastResult: 'correct',
    });
    expect(h.wordsRepo.incrementErrorCount).not.toHaveBeenCalled();
  });

  it('wrong → 学生错次 + 全局 error_count 各加一，且不置 learned', async () => {
    const h = harness();
    await h.service.judge(judgeInput({ promptKind: 'cn2en', answer: 'nope' }), 9);
    expect(h.recordResult.mock.calls[0][0]).toMatchObject({ learned: 0, wrongDelta: 1, lastResult: 'wrong' });
    expect(h.wordsRepo.incrementErrorCount).toHaveBeenCalledWith(1);
  });

  it('off_target → 两份错次都不动（学生答的没错，只是没答到考点）', async () => {
    const h = harness({ judgeVerdict: 'off_target' });
    await h.service.judge(judgeInput({ senseIndex: 2, answer: '住的地方' }), 9);
    expect(h.recordResult.mock.calls[0][0]).toMatchObject({ learned: 0, wrongDelta: 0, lastResult: 'off_target' });
    expect(h.wordsRepo.incrementErrorCount).not.toHaveBeenCalled();
  });

  it('无论哪种结论都会落一次进度行（「今日已背」按见过算）', async () => {
    for (const answer of ['地址', '住的地方', '']) {
      const h = harness();
      await h.service.judge(judgeInput({ answer }), 9);
      expect(h.recordResult).toHaveBeenCalledTimes(1);
    }
  });

  it('返回的进度是**读回值**，不是本地推算', async () => {
    const h = harness();
    h.progressRepo.findByStudentAndWord.mockResolvedValueOnce({ learned: 1, wrong_count: 3 });
    const res = await h.service.judge(judgeInput({ senseIndex: 0, answer: '地址' }), 9);
    expect(res.progress).toEqual({ learned: true, wrongCount: 3 });
  });
});

// ---------------------------------------------------------------- 配置页 / 易错标记 / 词根族

describe('VocabularyService.getOptions', () => {
  it('三档范围的词数按层级求和（junior 含 primary）', async () => {
    const { service } = harness();
    const res = await service.getOptions(9);
    expect(res.pools).toEqual([
      { key: 'junior', label: '仅初中', count: 1600 },   // 505 + 1095
      { key: 'senior', label: '仅高中', count: 1500 },   // 500 + 1000
      { key: 'all', label: '初中 + 高中全部', count: 3100 },
    ]);
  });

  it('notLearned = 总数 - 已背过；其余三项直取聚合', async () => {
    const { service } = harness();
    const res = await service.getOptions(9);
    expect(res.counts).toEqual({
      notLearned: 3100 - 37,
      myWrong: 8,
      commonWrong: 46,
      extended: 120,
    });
  });

  it('「今日」用服务器本地时区的当日 00:00 起算（不用 SQL 的 CURDATE）', async () => {
    const { service, progressRepo } = harness({
      now: () => new Date('2026-09-16T10:30:00+08:00'),
    });
    await service.getOptions(9);
    const since = progressRepo.countSeenSince.mock.calls[0][1] as Date;
    expect(since.getFullYear()).toBe(2026);
    expect(since.getMonth()).toBe(8); // 9 月
    expect(since.getDate()).toBe(16);
    expect(since.getHours()).toBe(0);
    expect(since.getMinutes()).toBe(0);
    expect(since.getSeconds()).toBe(0);
  });
});

describe('VocabularyService.clearWrongMark', () => {
  it('只清该学生自己的错次', async () => {
    const h = harness();
    expect(await h.service.clearWrongMark(1, 9)).toEqual({ ok: true });
    expect(h.progressRepo.clearWrongCount).toHaveBeenCalledWith(9, 1);
    // 全局计数与学生 learned 都不该被碰
    expect(h.wordsRepo.incrementErrorCount).not.toHaveBeenCalled();
    expect(h.progressRepo.recordResult).not.toHaveBeenCalled();
  });
});

describe('VocabularyService.getFamily', () => {
  const familyRows = [
    word(2, 'care', CARE_MEANINGS, { root_key: 'care', sort_order: 2, root_affixes: null }),
    word(3, 'careful', [{ pos: 'adj.', gloss: '仔细的', extended: false }], {
      root_key: 'care',
      sort_order: 3,
      root_affixes: [{ type: 'suffix', code: '-ful', gloss: '充满…的', posHint: '→ 形容词' }],
    }),
    word(4, 'careless', [{ pos: 'adj.', gloss: '粗心的', extended: false }], {
      root_key: 'care',
      sort_order: 4,
      root_affixes: [{ type: 'suffix', code: '-less', gloss: '无…的' }],
    }),
  ];

  it('中心词排最前且不挂词缀；成员带词缀注记与释义', async () => {
    const h = harness({ rows: familyRows });
    h.wordsRepo.findFamily.mockResolvedValueOnce(familyRows);
    const res = await h.service.getFamily(2);
    expect(res.root).toEqual({ word: 'care', phonetic: '/care/', gloss: '照顾；小心' });
    expect(res.members.map((m) => m.word)).toEqual(['care', 'careful', 'careless']);
    const head = res.members[0];
    expect(head.isHead).toBe(true);
    expect(head.affixes).toEqual([]);
    const careful = res.members[1];
    expect(careful.isHead).toBe(false);
    expect(careful.gloss).toBe('仔细的');
    expect(careful.affixes[0]).toMatchObject({ code: '-ful' });
  });

  it('成员词也能查到所属族（用它的 root_key 去查）', async () => {
    const h = harness({ rows: familyRows });
    h.wordsRepo.findFamily.mockResolvedValueOnce(familyRows);
    await h.service.getFamily(3);
    expect(h.wordsRepo.findFamily).toHaveBeenCalledWith('care');
  });

  it('没有族的词 → 404', async () => {
    const h = harness({ rows: [word(9, 'solo', CARE_MEANINGS, { root_key: null })] });
    h.wordsRepo.findFamily.mockResolvedValueOnce([]);
    await expect(h.service.getFamily(9)).rejects.toThrow(/没有词根族/);
  });

  it('族里只有自己一行 → 404（不算族）', async () => {
    const h = harness({ rows: [CARE] });
    h.wordsRepo.findFamily.mockResolvedValueOnce([CARE]);
    await expect(h.service.getFamily(2)).rejects.toThrow(/没有词根族/);
  });

  it('wordId 不存在 → 404', async () => {
    const h = harness();
    await expect(h.service.getFamily(404)).rejects.toThrow(/单词不存在/);
  });
});
