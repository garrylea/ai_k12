import { describe, it, expect } from 'vitest';
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
  return new ProgressService(progressRepo as any, studentsRepo as any, lessonsRepo, unitsRepo, semestersRepo, contentService as any);
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
