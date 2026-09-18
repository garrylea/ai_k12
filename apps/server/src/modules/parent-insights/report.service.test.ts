import { describe, it, expect, vi, afterEach } from 'vitest';
import { ReportService } from './report.service.js';

afterEach(() => {
  vi.useRealTimers();
});

const mkRepo = () => ({
  getActivitySummary: vi.fn().mockResolvedValue({
    lastActiveAt: new Date('2026-09-18T20:11:00Z'), activeDays: 3,
  }),
  getAccuracyBySubject: vi.fn().mockResolvedValue([{ subjectId: 1, answered: 42, correct: 31 }]),
  getSelfAssessBySubject: vi.fn().mockResolvedValue([{ subjectId: 1, count: 5, correctCount: 3 }]),
  getExamCounts: vi.fn().mockResolvedValue([{ subjectId: 1, count: 2 }]),
  getErrorDateCounts: vi.fn().mockResolvedValue({ added: 6, cleared: 4 }),
  getAccuracyTrend: vi.fn().mockResolvedValue([{ date: '2026-09-15', answered: 10, correct: 7 }]),
  getWeakPoints: vi.fn().mockResolvedValue([
    { knowledgePointId: 42, name: '分数加减', unclearedCount: 3, totalWrongCount: 5 },
  ]),
  countUncoveredUnclearedErrors: vi.fn().mockResolvedValue(8),
  listSubmittedExams: vi.fn().mockResolvedValue([
    {
      sessionId: 7, paperTitle: '2025 学年七年级上期中', subjectId: 1,
      submittedAt: new Date('2026-09-16T19:20:00Z'), correctCount: 18, objectiveCount: 22,
    },
  ]),
});

const mk = (overrides: Record<string, any> = {}) => ({
  repo: mkRepo(),
  subjectsRepo: { findAll: vi.fn().mockResolvedValue([{ id: 1, name: '数学' }]) },
  ...overrides,
});

const mkSvc = (d: ReturnType<typeof mk>) => new ReportService(d.repo as any, d.subjectsRepo as any);

describe('ReportService', () => {
  it('weekly：窗口 7 天，聚合 stats / trend / subjects / weakPoints / exams', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-18T15:30:00'));
    const d = mk();

    const result = await mkSvc(d).getReport(11, 'weekly');

    expect(result.studentId).toBe(11);
    expect(result.period).toBe('weekly');
    expect(result.windowStart).toBe('2026-09-12');
    expect(result.windowEnd).toBe('2026-09-18');
    expect(result.stats).toEqual({
      activeDays: 3, answered: 42, correct: 31, rate: 73.8,
      selfAssessCount: 5, errorsAdded: 6, errorsCleared: 4, examCount: 2,
    });
    expect(result.trend).toEqual([{ date: '2026-09-15', answered: 10, correct: 7, rate: 70 }]);
    expect(result.subjects).toEqual([
      { subjectId: 1, subjectName: '数学', answered: 42, correct: 31, rate: 73.8 },
    ]);
    expect(result.weakPoints).toEqual([
      { knowledgePointId: 42, name: '分数加减', unclearedCount: 3, totalWrongCount: 5 },
    ]);
    expect(result.weakPointsUncoveredCount).toBe(8);
    expect(result.exams).toEqual([
      {
        sessionId: 7, paperTitle: '2025 学年七年级上期中', subjectName: '数学',
        submittedAt: new Date('2026-09-16T19:20:00Z'), correctCount: 18, objectiveCount: 22, rate: 81.8,
      },
    ]);
  });

  it('窗口口径：五个窗口聚合方法都收到同一对 [start, endExclusive)', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-18T15:30:00'));
    const d = mk();
    const from = new Date(2026, 8, 12);
    const to = new Date(2026, 8, 19);

    await mkSvc(d).getReport(11, 'weekly');

    expect(d.repo.getActivitySummary).toHaveBeenCalledWith(11, from);
    expect(d.repo.getAccuracyBySubject).toHaveBeenCalledWith(11, from, to);
    expect(d.repo.getSelfAssessBySubject).toHaveBeenCalledWith(11, from, to);
    expect(d.repo.getExamCounts).toHaveBeenCalledWith(11, from, to);
    expect(d.repo.getErrorDateCounts).toHaveBeenCalledWith(11, from, to);
    expect(d.repo.getAccuracyTrend).toHaveBeenCalledWith(11, from, to);
  });

  it('weakPoints 与 uncovered 是**累计**口径；exams 也不限窗口', async () => {
    const d = mk();

    await mkSvc(d).getReport(11, 'monthly');

    expect(d.repo.getWeakPoints).toHaveBeenCalledWith(11, 10);
    expect(d.repo.countUncoveredUnclearedErrors).toHaveBeenCalledWith(11);
    expect(d.repo.listSubmittedExams).toHaveBeenCalledWith(11, 20);
  });

  it('跨学科汇总 stats：answered/correct 是各学科之和，rate 现算', async () => {
    const d = mk({
      repo: {
        ...mkRepo(),
        getAccuracyBySubject: vi.fn().mockResolvedValue([
          { subjectId: 1, answered: 30, correct: 20 },
          { subjectId: 2, answered: 10, correct: 9 },
        ]),
      },
    });

    const result = await mkSvc(d).getReport(11, 'weekly');

    expect(result.stats.answered).toBe(40);
    expect(result.stats.correct).toBe(29);
    expect(result.stats.rate).toBe(72.5);
  });

  it('完全无数据 → 全 0 / rate null / 空数组（不是 404）', async () => {
    const d = mk({
      repo: {
        ...mkRepo(),
        getActivitySummary: vi.fn().mockResolvedValue({ lastActiveAt: null, activeDays: 0 }),
        getAccuracyBySubject: vi.fn().mockResolvedValue([]),
        getSelfAssessBySubject: vi.fn().mockResolvedValue([]),
        getExamCounts: vi.fn().mockResolvedValue([]),
        getErrorDateCounts: vi.fn().mockResolvedValue({ added: 0, cleared: 0 }),
        getAccuracyTrend: vi.fn().mockResolvedValue([]),
        getWeakPoints: vi.fn().mockResolvedValue([]),
        countUncoveredUnclearedErrors: vi.fn().mockResolvedValue(0),
        listSubmittedExams: vi.fn().mockResolvedValue([]),
      },
    });

    const result = await mkSvc(d).getReport(11, 'weekly');

    expect(result.stats).toMatchObject({
      activeDays: 0, answered: 0, correct: 0, rate: null, selfAssessCount: 0,
    });
    expect(result.trend).toEqual([]);
    expect(result.subjects).toEqual([]);
    expect(result.weakPoints).toEqual([]);
    expect(result.exams).toEqual([]);
  });

  it('学科名缺失时兜底为空串（不崩）', async () => {
    const d = mk({ subjectsRepo: { findAll: vi.fn().mockResolvedValue([]) } });

    const result = await mkSvc(d).getReport(11, 'weekly');

    expect(result.subjects[0].subjectName).toBe('');
  });
});
