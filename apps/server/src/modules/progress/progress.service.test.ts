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
  const contentService = {
    getSubjects: async () => SUBJECTS,
    getVersions: async () => VERSIONS,
    getUnits: async (versionId: number) => UNITS_BY_VERSION[versionId] ?? [],
    getLessons: async () => [],
  };
  const practiceService = opts.practiceService ?? {};
  return new ProgressService(progressRepo as any, studentsRepo as any, lessonsRepo, unitsRepo, semestersRepo, contentService as any, practiceService as any);
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

  it('without progress, resolves version by student grade band (junior) and falls back to lowest sort_order semester (上册)', async () => {
    const svc = makeService({
      progress: null,
      student: { id: 2, schoolLevel: 'junior' },
    });
    const result = await svc.getStarMap(2, 1);
    // junior version 76's first semester in sort order is 九上
    expect(result.gradeName).toBe('九年级上册');
    expect(result.publisher).toBe('人教版');
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
}) {
  const progressRepo = {
    findByStudentAndSubject: async () => opts.progress,
    advanceLesson: vi.fn().mockResolvedValue(undefined),
    markCompleted: vi.fn().mockResolvedValue(undefined),
    updateCardSort: vi.fn().mockResolvedValue(undefined),
  };
  const contentService = {
    getLessonCards: async () => ({ cards: opts.cards }),
    getNextLesson: async () => opts.nextLesson ?? null,
  };
  // 非门禁场景（课程无练习卡）不需要 practiceService；传 true 时校验是否被调用
  const practiceService = opts.withPracticeService
    ? { isLessonPracticeComplete: vi.fn().mockResolvedValue(opts.practiceComplete ?? true) }
    : {};
  const svc = new ProgressService(
    progressRepo as any,
    {} as any,
    {} as any,
    {} as any,
    {} as any,
    contentService as any,
    practiceService as any,
  );
  return { svc, progressRepo, contentService, practiceService };
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
