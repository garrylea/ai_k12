import { describe, it, expect, vi } from 'vitest';
import { NotFoundException } from '@nestjs/common';
import { DashboardService } from './dashboard.service.js';

const BOY = {
  id: 11, parentId: 3, username: 'xiaoming', passwordHash: 'h', name: '小明',
  age: 13, grade: '初一', schoolLevel: 'junior', isActive: true,
};

/** 与 ProgressService.getStarMap 的 StarMapData 同形状（注意 id 是 string、百分比字段叫 progress）。 */
const STAR_MAP = {
  subjectName: '数学',
  gradeName: '七年级上册',
  publisher: '人教版',
  totalUnits: 8,
  completedUnits: 2,
  chapters: [
    {
      id: '1', title: '第一章', order: 1, importance: 'medium',
      status: 'completed', progress: 100, sections: [],
    },
    {
      id: '2', title: '第二章 整式的加减', order: 2, importance: 'medium',
      status: 'current', progress: 30,
      sections: [
        { id: '5', title: '2.0 章综述', order: 0, knowledgePointCount: 0, status: 'completed', progress: 100 },
        { id: '6', title: '2.1 整式', order: 1, knowledgePointCount: 3, status: 'current', progress: 30 },
      ],
    },
  ],
};

const mkRepo = () => ({
  listTrackedSubjectIds: vi.fn().mockResolvedValue([1]),
  getActivitySummary: vi.fn().mockResolvedValue({
    lastActiveAt: new Date('2026-09-18T20:11:00Z'), activeDays: 3,
  }),
  getAccuracyBySubject: vi.fn().mockResolvedValue([{ subjectId: 1, answered: 42, correct: 31 }]),
  getSelfAssessBySubject: vi.fn().mockResolvedValue([{ subjectId: 1, count: 5, correctCount: 3 }]),
  getErrorBookSummary: vi.fn().mockResolvedValue([{ subjectId: 1, uncleared: 12, total: 20 }]),
  getExamCounts: vi.fn().mockResolvedValue([{ subjectId: 1, count: 4 }]),
});

const mk = (overrides: Record<string, any> = {}) => ({
  studentsRepo: { findByParentId: vi.fn().mockResolvedValue([BOY]) },
  subjectsRepo: { findAll: vi.fn().mockResolvedValue([{ id: 1, name: '数学' }]) },
  progressService: { getStarMap: vi.fn().mockResolvedValue(STAR_MAP) },
  repo: mkRepo(),
  ...overrides,
});

const mkSvc = (d: ReturnType<typeof mk>) =>
  new DashboardService(
    d.studentsRepo as any,
    d.subjectsRepo as any,
    d.progressService as any,
    d.repo as any,
  );

describe('DashboardService', () => {
  it('编排：多孩 × 已开始学科，拼出进度/正确率/自评/错题/考试数', async () => {
    const d = mk();

    const result = await mkSvc(d).getDashboard(3);

    expect(result.students).toHaveLength(1);
    const s = result.students[0];
    expect(s).toMatchObject({
      studentId: 11, name: '小明', grade: '初一', schoolLevel: 'junior', activeDays7: 3, unreadAlerts: 0,
    });
    expect(s.subjects).toEqual([
      {
        subjectId: 1,
        subjectName: '数学',
        progress: {
          completedUnits: 2,
          totalUnits: 8,
          currentUnitName: '第二章 整式的加减',
          currentLessonName: '2.1 整式',
          percent: 25,
        },
        accuracy: { answered: 42, correct: 31, rate: 73.8 },
        selfAssessed: { count: 5, correctCount: 3 },
        errorBook: { uncleared: 12, total: 20 },
        examCount: 4,
      },
    ]);
    // 累计口径：聚合方法都**不传窗口**
    expect(d.repo.getAccuracyBySubject).toHaveBeenCalledWith(11);
    expect(d.repo.getSelfAssessBySubject).toHaveBeenCalledWith(11);
  });

  it('已开始学科为空 → subjects 为空数组（不调 getStarMap）', async () => {
    const d = mk({ repo: { ...mkRepo(), listTrackedSubjectIds: vi.fn().mockResolvedValue([]) } });

    const result = await mkSvc(d).getDashboard(3);

    expect(result.students[0].subjects).toEqual([]);
    expect(d.progressService.getStarMap).not.toHaveBeenCalled();
  });

  it('answered = 0 → rate 为 null（不是 0）', async () => {
    const d = mk({
      repo: {
        ...mkRepo(),
        getAccuracyBySubject: vi.fn().mockResolvedValue([{ subjectId: 1, answered: 0, correct: 0 }]),
      },
    });

    const result = await mkSvc(d).getDashboard(3);

    expect(result.students[0].subjects[0].accuracy).toEqual({ answered: 0, correct: 0, rate: null });
  });

  it('totalUnits = 0 → percent 为 0，当前单元/课为 null（不除零）', async () => {
    const d = mk({
      progressService: {
        getStarMap: vi.fn().mockResolvedValue({
          ...STAR_MAP, totalUnits: 0, completedUnits: 0, chapters: [],
        }),
      },
    });

    const result = await mkSvc(d).getDashboard(3);

    expect(result.students[0].subjects[0].progress).toEqual({
      completedUnits: 0, totalUnits: 0, currentUnitName: null, currentLessonName: null, percent: 0,
    });
  });

  it('某学科 getStarMap 抛 1002（学科被停用/无教材版本）→ 跳过该学科，不炸整页', async () => {
    const d = mk({
      progressService: {
        getStarMap: vi
          .fn()
          .mockRejectedValueOnce(new NotFoundException({ code: 1002, message: '学科不存在' }))
          .mockResolvedValueOnce(STAR_MAP),
      },
      repo: { ...mkRepo(), listTrackedSubjectIds: vi.fn().mockResolvedValue([9, 1]) },
    });

    const result = await mkSvc(d).getDashboard(3);

    expect(result.students[0].subjects.map((x: any) => x.subjectId)).toEqual([1]);
  });

  it('非 1002 的异常照常抛出（不吞 bug）', async () => {
    const d = mk({
      progressService: { getStarMap: vi.fn().mockRejectedValue(new Error('DB 挂了')) },
    });

    await expect(mkSvc(d).getDashboard(3)).rejects.toThrow('DB 挂了');
  });

  it('多个孩子各自出卡片', async () => {
    const d = mk({
      studentsRepo: {
        findByParentId: vi.fn().mockResolvedValue([BOY, { ...BOY, id: 12, name: '小美' }]),
      },
    });

    const result = await mkSvc(d).getDashboard(3);

    expect(result.students.map((s: any) => s.studentId)).toEqual([11, 12]);
  });

  it('unreadAlerts 恒为 0（safety_alerts 无写入，字段先占位）', async () => {
    const d = mk();
    const result = await mkSvc(d).getDashboard(3);
    expect(result.unreadAlerts).toBe(0);
    expect(result.students[0].unreadAlerts).toBe(0);
  });
});
