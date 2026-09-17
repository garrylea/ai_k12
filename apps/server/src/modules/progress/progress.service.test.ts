import { describe, it, expect, vi } from 'vitest';
import { ProgressService } from './progress.service.js';

/**
 * Unit tests for ProgressService.getStarMap semester/version selection.
 * Repositories and ContentService are injected as light mocks — no DB needed.
 */

const SUBJECTS = [{ id: 1, name: '数学', code: 'math' }];

const VERSIONS = [
  { id: 1, subjectId: 1, name: '人教版', code: 'math_primary', gradeBand: 'primary', publisher: '人教版' },
  { id: 76, subjectId: 1, name: '人教版', code: 'math_junior', gradeBand: 'junior', publisher: '人教版' },
];

// version 76 (junior) carries two semesters: 九上 (66, sort 18) then 九下 (65, sort 19)
const UNITS_BY_VERSION: Record<number, any[]> = {
  1: [
    { semester: { id: 1, name: '三年级上册', grade: 'grade_3', term: 'first' }, units: [{ id: 1, name: 'U1', order: 1 }] },
  ],
  76: [
    { semester: { id: 66, name: '九年级上册', grade: 'grade_9', term: 'first' }, units: [{ id: 69, name: '九上U1', order: 21 }, { id: 70, name: '九上U2', order: 22 }] },
    { semester: { id: 65, name: '九年级下册', grade: 'grade_9', term: 'second' }, units: [{ id: 65, name: '九下U1', order: 26 }] },
  ],
};

function makeService(opts: {
  progress: any | null;
  student?: any | null;
  practiceService?: any;
  versions?: any[];
}) {
  const progressRepo = {
    findByStudentAndSubject: async () => opts.progress,
  };
  const studentsRepo = {
    findById: async () => opts.student ?? null,
  };
  const lessonsRepo = {} as any;
  const unitsRepo = {} as any;
  const semestersRepo = {} as any;
  const versions = opts.versions ?? VERSIONS;
  const contentService = {
    getSubjects: async () => SUBJECTS,
    getVersions: async () => versions,
    getUnits: async (versionId: number) => UNITS_BY_VERSION[versionId] ?? [],
    getLessons: async () => [],
    // 默认规则 mock（与 ContentService.pickDefaultVersion 同规则）：edition 非空优先，id 大者优先
    pickDefaultVersion: (list: any[], band: string | null) => {
      const matched = band ? list.filter((v: any) => v.gradeBand === band) : [];
      const pool = matched.length > 0 ? matched : list;
      const sorted = [...pool].sort((a: any, b: any) => {
        const ea = a.edition ? 1 : 0;
        const eb = b.edition ? 1 : 0;
        if (ea !== eb) return eb - ea;
        return b.id - a.id;
      });
      return sorted[0] ?? null;
    },
  };
  const practiceService = opts.practiceService ?? {};
  return new ProgressService(progressRepo as any, studentsRepo as any, lessonsRepo, unitsRepo, semestersRepo, contentService as any, practiceService as any, {} as any);
}

describe('ProgressService.getStarMap — semester/version selection', () => {
  it('honors progress.currentSemesterId (九下) instead of the lowest sort_order', async () => {
    const svc = makeService({
      progress: { textbookVersionId: 76, currentSemesterId: 65, currentUnitId: 65, currentLessonId: null },
    });
    const result = await svc.getStarMap(2, 1);
    expect(result.gradeName).toBe('九年级下册');
    expect(result.totalUnits).toBe(1);
    expect(result.chapters.map(c => c.title)).toEqual(['九下U1']);
  });

  it('picks 九上 when progress points at semester 66', async () => {
    const svc = makeService({
      progress: { textbookVersionId: 76, currentSemesterId: 66, currentUnitId: 69, currentLessonId: null },
    });
    const result = await svc.getStarMap(2, 1);
    expect(result.gradeName).toBe('九年级上册');
    expect(result.totalUnits).toBe(2);
  });

  it('without progress, resolves version by student grade band (junior) via default rule and falls back to lowest sort_order semester (上册)', async () => {
    const svc = makeService({
      progress: null,
      student: { id: 2, schoolLevel: 'junior' },
    });
    const result = await svc.getStarMap(2, 1);
    // junior version 76's first semester in sort order is 九上
    expect(result.gradeName).toBe('九年级上册');
    expect(result.publisher).toBe('人教版');
  });

  it('without progress, matches semester by student grade (初三 -> grade_9) when the version spans grades', async () => {
    // 临时给 junior version 76 挂八/九两个年级的册别，验证按学生年级命中九年级
    const saved = UNITS_BY_VERSION[76];
    UNITS_BY_VERSION[76] = [
      { semester: { id: 50, name: '八年级上册', grade: 'grade_8', term: 'first' }, units: [{ id: 80, name: '八上U1', order: 11 }] },
      ...saved,
    ];
    try {
      const svc = makeService({
        progress: null,
        student: { id: 2, schoolLevel: 'junior', grade: '初三' },
      });
      const result = await svc.getStarMap(2, 1);
      expect(result.gradeName).toBe('九年级上册');
    } finally {
      UNITS_BY_VERSION[76] = saved;
    }
  });

  it('without progress, 同学段多版并存时默认规则取 edition 非空的新版（id 大者优先）', async () => {
    const versions = [
      ...VERSIONS,
      { id: 90, subjectId: 1, name: '人教版（2024）', code: 'math_junior_2024', gradeBand: 'junior', publisher: '人教版', edition: '根据2022年版课程标准修订' },
    ];
    const svc = makeService({
      versions,
      progress: null,
      student: { id: 2, schoolLevel: 'junior' },
    });
    const result = await svc.getStarMap(2, 1);
    // 90 号版本无 units 数据 -> 选中新版后 chapters 为空、totalUnits 0
    expect(result.publisher).toBe('人教版');
    expect(result.totalUnits).toBe(0);
  });
});

// --- updateProgress 课程完成门禁（练习作答覆盖校验） ---

/** 构造 updateProgress 专用依赖（mock repos + contentService + practiceService）。 */
function makeUpdateService(opts: {
  progress: any;
  cards: any[];
  nextLesson?: { id: number; unitId: number } | null;
  practiceComplete?: boolean;
  withPracticeService?: boolean;
  lesson?: { id: number; unitId: number } | null;
  pointsService?: any;
}) {
  const progressRepo = {
    findByStudentAndSubject: async () => opts.progress,
    advanceLesson: vi.fn().mockResolvedValue(undefined),
    markCompleted: vi.fn().mockResolvedValue(undefined),
    updateCardSort: vi.fn().mockResolvedValue(undefined),
    adoptLesson: vi.fn().mockResolvedValue(undefined),
  };
  const lessonsRepo = {
    findById: async (id: number) => opts.lesson === undefined ? null : (opts.lesson?.id === id ? opts.lesson : null),
  };
  const contentService = {
    getLessonCards: async () => ({ cards: opts.cards }),
    getNextLesson: async () => opts.nextLesson ?? null,
  };
  // 非门禁场景（课程无练习卡）不需要 practiceService；传 true 时校验是否被调用
  const practiceService = opts.withPracticeService
    ? { isLessonPracticeComplete: vi.fn().mockResolvedValue(opts.practiceComplete ?? true) }
    : {};
  // 缺省发分 mock：返回 null（未发分）——老用例的响应形状保持不变（points 走 undefined）
  const pointsService = opts.pointsService ?? { award: vi.fn().mockResolvedValue(null) };
  const svc = new ProgressService(
    progressRepo as any,
    {} as any,
    lessonsRepo as any,
    {} as any,
    {} as any,
    contentService as any,
    practiceService as any,
    pointsService as any,
  );
  return { svc, progressRepo, contentService, practiceService, pointsService };
}

describe('ProgressService.updateProgress — practice gate', () => {
  it('到达最后一张卡但练习未全部作答 -> 拒绝完成（practice_incomplete），不 advanceLesson', async () => {
    const { svc, progressRepo, practiceService } = makeUpdateService({
      progress: { id: 1, currentLessonId: 9, currentCardSort: 0 },
      cards: [
        { id: 5, sortOrder: 1, cardType: 'concept' },
        { id: 6, sortOrder: 2, cardType: 'practice' },
      ],
      practiceComplete: false,
      withPracticeService: true,
    });
    const res = await svc.updateProgress(2, 1, 9, 2);
    expect(res).toEqual({ advanced: false, reason: 'practice_incomplete' });
    expect(practiceService.isLessonPracticeComplete).toHaveBeenCalledWith(2, 9);
    expect(progressRepo.advanceLesson).not.toHaveBeenCalled();
    expect(progressRepo.updateCardSort).not.toHaveBeenCalled();
  });

  it('到达最后一张卡且练习全部作答 -> 正常 advanceLesson 到下一课', async () => {
    const { svc, progressRepo, practiceService } = makeUpdateService({
      progress: { id: 1, currentLessonId: 9, currentCardSort: 0, currentUnitId: 1 },
      cards: [
        { id: 5, sortOrder: 1, cardType: 'concept' },
        { id: 6, sortOrder: 2, cardType: 'practice' },
      ],
      nextLesson: { id: 99, unitId: 1 },
      practiceComplete: true,
      withPracticeService: true,
    });
    const res = await svc.updateProgress(2, 1, 9, 2);
    expect(res).toEqual({ advanced: true, nextLessonId: 99 });
    expect(practiceService.isLessonPracticeComplete).toHaveBeenCalledWith(2, 9);
    expect(progressRepo.advanceLesson).toHaveBeenCalledWith(1, 99, null);
  });

  it('课程无练习卡 -> 不调 practiceService，到达最后一张卡正常完成', async () => {
    const { svc, progressRepo, practiceService } = makeUpdateService({
      progress: { id: 1, currentLessonId: 9, currentCardSort: 0 },
      cards: [
        { id: 5, sortOrder: 1, cardType: 'concept' },
        { id: 6, sortOrder: 2, cardType: 'summary' },
      ],
      nextLesson: null,
      withPracticeService: true,
    });
    const res = await svc.updateProgress(2, 1, 9, 2);
    expect(res).toEqual({ advanced: true, completed: true });
    expect(practiceService.isLessonPracticeComplete).not.toHaveBeenCalled();
    expect(progressRepo.markCompleted).toHaveBeenCalledWith(1);
  });

  it('非最后一张卡 -> 不触发门禁，仅更新 cardSort', async () => {
    const { svc, progressRepo, practiceService } = makeUpdateService({
      progress: { id: 1, currentLessonId: 9, currentCardSort: 0 },
      cards: [
        { id: 5, sortOrder: 1, cardType: 'concept' },
        { id: 6, sortOrder: 2, cardType: 'practice' },
      ],
      withPracticeService: true,
    });
    const res = await svc.updateProgress(2, 1, 9, 1);
    expect(res).toEqual({ advanced: false, nextUnlockType: 'lesson' });
    expect(practiceService.isLessonPracticeComplete).not.toHaveBeenCalled();
    expect(progressRepo.updateCardSort).toHaveBeenCalledWith(1, 1, 'lesson');
  });
});

// --- updateProgress 家长配置行（currentLessonId=NULL）首次学习收养 ---
// 家长端 createConfig / applyConfig(reset) 创建的 progress 行 current_lesson_id 为
// NULL。此前 updateProgress 只处理"行不存在"的自动初始化，行存在但 lesson 为空时
// 每次 fall through 到 not_current_lesson，学生永远无法完成任何课程。

describe('ProgressService.updateProgress — 家长配置行（currentLessonId=NULL）', () => {
  it('行存在但 currentLessonId 为空 -> 收养当前课，最后一张卡正常 advanceLesson（不再卡在 not_current_lesson）', async () => {
    const { svc, progressRepo } = makeUpdateService({
      progress: { id: 6, currentLessonId: null, currentUnitId: null, currentCardSort: null },
      cards: [
        { id: 1, sortOrder: 1, cardType: 'reading' },
        { id: 2, sortOrder: 2, cardType: 'reading' },
      ],
      nextLesson: { id: 1113, unitId: 310 },
      lesson: { id: 1112, unitId: 310 },
    });
    const res = await svc.updateProgress(7, 1, 1112, 2);
    expect(res).toEqual({ advanced: true, nextLessonId: 1113 });
    expect(progressRepo.adoptLesson).toHaveBeenCalledWith(6, 310, 1112);
    expect(progressRepo.advanceLesson).toHaveBeenCalledWith(6, 1113, null);
  });

  it('行存在但 currentLessonId 为空 -> 收养当前课，非最后一张卡仅更新 cardSort', async () => {
    const { svc, progressRepo } = makeUpdateService({
      progress: { id: 6, currentLessonId: null, currentUnitId: null, currentCardSort: null },
      cards: [
        { id: 1, sortOrder: 1, cardType: 'reading' },
        { id: 2, sortOrder: 2, cardType: 'reading' },
      ],
      lesson: { id: 1112, unitId: 310 },
    });
    const res = await svc.updateProgress(7, 1, 1112, 1);
    expect(res).toEqual({ advanced: false, nextUnlockType: 'lesson' });
    expect(progressRepo.adoptLesson).toHaveBeenCalledWith(6, 310, 1112);
    expect(progressRepo.updateCardSort).toHaveBeenCalledWith(6, 1, 'lesson');
  });
});

// --- updateProgress 发分埋点（Task 9：mainline_lesson） ---
// 学完一课（advanceLesson 与 markCompleted 两条 return）各发一次分；
// dedupeKey 不带日期（主线单向，一课只能算一次）；积分故障绝不能阻塞推进。

/** 一条完整 AwardResult；levelUp 里是 LevelInfo 对象，wire 形状要求压成 code 字符串。 */
const awardResult = (overrides: any = {}) => ({
  pointsAwarded: 10,
  balance: 60,
  totalEarned: 510,
  levelUp: {
    from: { code: 'pichai', name: '劈柴', index: 0, threshold: 0 },
    to: { code: 'zhutie', name: '铸铁', index: 1, threshold: 500 },
  },
  ...overrides,
});

describe('ProgressService.updateProgress — 学完一课发分（mainline_lesson）', () => {
  it('学完最后一卡（有下一课）-> award 一次：taskCode/dedupeKey 正确，响应 points 段位是 code 字符串', async () => {
    const pointsService = { award: vi.fn().mockResolvedValue(awardResult()) };
    const { svc } = makeUpdateService({
      progress: { id: 1, currentLessonId: 9, currentCardSort: 0, currentUnitId: 1 },
      cards: [
        { id: 5, sortOrder: 1, cardType: 'concept' },
        { id: 6, sortOrder: 2, cardType: 'summary' },
      ],
      nextLesson: { id: 99, unitId: 1 },
      pointsService,
    });
    const res = await svc.updateProgress(2, 1, 9, 2);

    expect(pointsService.award).toHaveBeenCalledTimes(1);
    expect(pointsService.award).toHaveBeenCalledWith({
      studentId: 2,
      taskCode: 'mainline_lesson',
      dedupeKey: 'lesson:2:9',
      refType: 'lesson',
      refId: 9,
    });
    // wire 形状：from/to 是段位 code 字符串，不是 LevelInfo 对象（前端拿 code 查图标）
    expect(res.points).toEqual({ awarded: 10, balance: 60, levelUp: { from: 'pichai', to: 'zhutie' } });
    expect(typeof (res.points as any)?.levelUp?.from).toBe('string');
  });

  it('学完最后一课（无下一课，markCompleted 分支）-> 同样发分', async () => {
    const pointsService = { award: vi.fn().mockResolvedValue(awardResult({ levelUp: null })) };
    const { svc, progressRepo } = makeUpdateService({
      progress: { id: 1, currentLessonId: 9, currentCardSort: 0, currentUnitId: 1 },
      cards: [
        { id: 5, sortOrder: 1, cardType: 'concept' },
        { id: 6, sortOrder: 2, cardType: 'summary' },
      ],
      nextLesson: null,
      pointsService,
    });
    const res = await svc.updateProgress(2, 1, 9, 2);

    expect(progressRepo.markCompleted).toHaveBeenCalledWith(1);
    expect(pointsService.award).toHaveBeenCalledTimes(1);
    expect(pointsService.award).toHaveBeenCalledWith(expect.objectContaining({
      studentId: 2, taskCode: 'mainline_lesson', dedupeKey: 'lesson:2:9',
    }));
    // 未跨档：levelUp 保持 null（不发明字段）
    expect(res.points).toEqual({ awarded: 10, balance: 60, levelUp: null });
  });

  it('advanced:false（reviewing）-> 不发分，响应不带 points 字段', async () => {
    const pointsService = { award: vi.fn() };
    const { svc } = makeUpdateService({
      progress: { id: 1, currentLessonId: 9, currentCardSort: 5, currentUnitId: 1 },
      cards: [
        { id: 5, sortOrder: 1, cardType: 'concept' },
        { id: 6, sortOrder: 2, cardType: 'summary' },
      ],
      pointsService,
    });
    const res = await svc.updateProgress(2, 1, 9, 1);

    expect(res).toEqual({ advanced: false, reason: 'reviewing' });
    expect('points' in res).toBe(false);
    expect(pointsService.award).not.toHaveBeenCalled();
  });

  it('advanced:false（not_current_lesson）-> 不发分，响应不带 points 字段', async () => {
    const pointsService = { award: vi.fn() };
    const { svc } = makeUpdateService({
      progress: { id: 1, currentLessonId: 9, currentCardSort: 0, currentUnitId: 1 },
      cards: [],
      nextLesson: null,
      pointsService,
    });
    const res = await svc.updateProgress(2, 1, 5, 1);

    expect(res).toEqual({ advanced: false, reason: 'not_current_lesson', currentLessonId: 9 });
    expect('points' in res).toBe(false);
    expect(pointsService.award).not.toHaveBeenCalled();
  });

  it('award 抛错 -> updateProgress 仍正常返回（积分故障不阻塞主线推进）', async () => {
    const pointsService = { award: vi.fn().mockRejectedValue(new Error('ledger down')) };
    const { svc, progressRepo } = makeUpdateService({
      progress: { id: 1, currentLessonId: 9, currentCardSort: 0, currentUnitId: 1 },
      cards: [
        { id: 5, sortOrder: 1, cardType: 'concept' },
        { id: 6, sortOrder: 2, cardType: 'summary' },
      ],
      nextLesson: { id: 99, unitId: 1 },
      pointsService,
    });
    const res = await svc.updateProgress(2, 1, 9, 2);

    expect(res).toEqual({ advanced: true, nextLessonId: 99 });
    expect(res.points).toBeUndefined();
    expect(progressRepo.advanceLesson).toHaveBeenCalledWith(1, 99, null);
    expect(pointsService.award).toHaveBeenCalledTimes(1);
  });
});
