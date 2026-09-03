import { describe, it, expect, vi } from 'vitest';
import { ExamsService, computeRecommendedDuration } from './exams.service';

const mk = (overrides: any = {}) => ({
  examPapersRepo: {
    findPapers: vi.fn().mockResolvedValue([]),
    findById: vi.fn().mockResolvedValue(null),
    findQuestionsByPaperId: vi.fn().mockResolvedValue([]),
  },
  ...overrides,
});
const mkSvc = (deps: ReturnType<typeof mk>) => new ExamsService(deps.examPapersRepo);

describe('ExamsService.listPapers', () => {
  it('透传筛选参数给 repo', async () => {
    const deps = mk();
    await mkSvc(deps).listPapers({ subjectId: 1, year: 2025, district: '海淀', examType: '期末', gradeBand: 'junior' });
    expect(deps.examPapersRepo.findPapers).toHaveBeenCalledWith({
      subjectId: 1, year: 2025, district: '海淀', examType: '期末', gradeBand: 'junior',
    });
  });

  it('映射行 -> ExamPaperDto（questionCount 取 repo 计数）', async () => {
    const deps = mk({
      examPapersRepo: {
        findPapers: vi.fn().mockResolvedValue([
          { id: 1, title: '2025 年期末卷', year: 2025, district: '海淀', exam_type: '期末', grade_band: 'junior', question_count: 25 },
          { id: 2, title: '2024 年中考卷', year: 2024, district: null, exam_type: null, grade_band: null, question_count: 0 },
        ]),
      },
    });
    const r = await mkSvc(deps).listPapers({ subjectId: 1 });
    expect(r).toEqual([
      { id: 1, title: '2025 年期末卷', year: 2025, district: '海淀', examType: '期末', gradeBand: 'junior', questionCount: 25 },
      { id: 2, title: '2024 年中考卷', year: 2024, district: null, examType: null, gradeBand: null, questionCount: 0 },
    ]);
  });
});

describe('computeRecommendedDuration（纯函数）', () => {
  it('choice/true_false ×1min + 其余 ×3min', () => {
    // 2 choice + 1 proof = 2*1 + 1*3 = 5 -> ceil(5/15)*15 = 15 -> clamp 到 30
    expect(computeRecommendedDuration([
      { type: 'choice' }, { type: 'choice' }, { type: 'proof' },
    ])).toBe(30);
  });

  it('40 道客观题 -> ceil(40/15)*15 = 45', () => {
    const qs = Array.from({ length: 40 }, () => ({ type: 'choice' }));
    expect(computeRecommendedDuration(qs)).toBe(45);
  });

  it('上界 clamp 180：60 道 proof = 180min 原值；80 道 proof = 240 -> 180', () => {
    expect(computeRecommendedDuration(Array.from({ length: 60 }, () => ({ type: 'proof' })))).toBe(180);
    expect(computeRecommendedDuration(Array.from({ length: 80 }, () => ({ type: 'proof' })))).toBe(180);
  });

  it('空题单 -> clamp 下界 30', () => {
    expect(computeRecommendedDuration([])).toBe(30);
  });

  it('true_false 计 1min，short_answer 计 3min', () => {
    // 10 true_false + 10 short_answer = 10 + 30 = 40 -> ceil(40/15)*15 = 45
    const qs = [
      ...Array.from({ length: 10 }, () => ({ type: 'true_false' })),
      ...Array.from({ length: 10 }, () => ({ type: 'short_answer' })),
    ];
    expect(computeRecommendedDuration(qs)).toBe(45);
  });
});

describe('ExamsService.getPaperDetail', () => {
  const paperRow = { id: 1, title: '2025 年期末卷', year: 2025, district: '海淀', exam_type: '期末', grade_band: 'junior', question_count: 3 };

  it('组装详情：推荐时长 clamp 到 30；题目按 question_no 排序透传', async () => {
    const deps = mk({
      examPapersRepo: {
        findById: vi.fn().mockResolvedValue(paperRow),
        findQuestionsByPaperId: vi.fn().mockResolvedValue([
          { questionId: 10, questionNo: 1, text: '选择题 1', type: 'choice', options: '["A. 1", "B. 2"]' },
          { questionId: 11, questionNo: 2, text: '选择题 2', type: 'choice', options: null },
          { questionId: 12, questionNo: 3, text: '证明题', type: 'proof', options: null },
        ]),
      },
    });
    const r = await mkSvc(deps).getPaperDetail(1);
    // 2 choice ×1 + 1 proof ×3 = 5 -> ceil(5/15)*15 = 15 -> clamp 30
    expect(r.durationMinutes).toBe(30);
    expect(r.id).toBe(1);
    expect(r.title).toBe('2025 年期末卷');
    expect(r.questions).toHaveLength(3);
    expect(r.questions[0]).toEqual({ questionId: 10, questionNo: 1, text: '选择题 1', type: 'choice', options: ['A. 1', 'B. 2'] });
    expect(r.questions[2].options).toBeNull();
  });

  it('40 道客观题 -> 45 分钟', async () => {
    const deps = mk({
      examPapersRepo: {
        findById: vi.fn().mockResolvedValue({ ...paperRow, question_count: 40 }),
        findQuestionsByPaperId: vi.fn().mockResolvedValue(
          Array.from({ length: 40 }, (_, i) => ({ questionId: 100 + i, questionNo: i + 1, text: `题 ${i + 1}`, type: 'choice', options: null })),
        ),
      },
    });
    const r = await mkSvc(deps).getPaperDetail(1);
    expect(r.durationMinutes).toBe(45);
    expect(r.questions).toHaveLength(40);
  });

  it('白名单序列化：questions 只含 questionId/questionNo/text/type/options，不含 answer/explanation', async () => {
    const deps = mk({
      examPapersRepo: {
        findById: vi.fn().mockResolvedValue(paperRow),
        findQuestionsByPaperId: vi.fn().mockResolvedValue([
          { questionId: 10, questionNo: 1, text: '选择题', type: 'choice', options: '["A. 1"]' },
        ]),
      },
    });
    const r = await mkSvc(deps).getPaperDetail(1);
    const q = r.questions[0];
    expect(Object.keys(q).sort()).toEqual(['options', 'questionId', 'questionNo', 'text', 'type']);
    expect(JSON.stringify(r)).not.toContain('answer');
    expect(JSON.stringify(r)).not.toContain('explanation');
  });

  it('坏 JSON options 解析为 null，不抛错', async () => {
    const deps = mk({
      examPapersRepo: {
        findById: vi.fn().mockResolvedValue(paperRow),
        findQuestionsByPaperId: vi.fn().mockResolvedValue([
          { questionId: 10, questionNo: 1, text: '选择题', type: 'choice', options: 'not json' },
        ]),
      },
    });
    const r = await mkSvc(deps).getPaperDetail(1);
    expect(r.questions[0].options).toBeNull();
  });

  it('paper 不存在 -> 404', async () => {
    const deps = mk({
      examPapersRepo: {
        findPapers: vi.fn().mockResolvedValue([]),
        findById: vi.fn().mockResolvedValue(null),
        findQuestionsByPaperId: vi.fn().mockResolvedValue([]),
      },
    });
    await expect(mkSvc(deps).getPaperDetail(999)).rejects.toMatchObject({ status: 404 });
    expect(deps.examPapersRepo.findQuestionsByPaperId).not.toHaveBeenCalled();
  });
});
