import { beforeEach, describe, expect, it, vi } from 'vitest';
import { FeaturedRecommendationService } from './featured-recommendation.service.js';
import { createFeaturedContentKey } from './content-key.js';

/** 题目行夹具：默认「同一学科、paper 来源、有答案、在用」，各用例只覆盖差异字段。 */
const row = (overrides: Record<string, unknown> = {}) => ({
  id: 1,
  subject_id: 1,
  type: 'choice',
  difficulty: 3,
  content: '题面',
  options: null,
  answer: 'A',
  explanation: null,
  material_text: null,
  material_url: null,
  source: 'paper',
  content_hash: null,
  is_active: 1,
  created_at: new Date(),
  ...overrides,
});

describe('FeaturedRecommendationService.recommend', () => {
  let featuredRepo: { countSetsCreatedToday: ReturnType<typeof vi.fn>; createRecommendation: ReturnType<typeof vi.fn> };
  let questions: { findByIds: ReturnType<typeof vi.fn>; findAnsweredQuestionIds: ReturnType<typeof vi.fn> };
  let students: { findById: ReturnType<typeof vi.fn> };
  let service: FeaturedRecommendationService;

  beforeEach(() => {
    students = { findById: vi.fn().mockResolvedValue({ id: 7, grade: '初二' }) };
    questions = {
      findByIds: vi.fn().mockResolvedValue([row({ id: 1 }), row({ id: 2 })]),
      findAnsweredQuestionIds: vi.fn().mockResolvedValue(new Set([1, 2])),
    };
    featuredRepo = {
      countSetsCreatedToday: vi.fn().mockResolvedValue(0),
      createRecommendation: vi.fn().mockResolvedValue({ setId: 3, alreadyRecommended: false }),
    };
    service = new FeaturedRecommendationService(featuredRepo as never, questions as never, students as never);
  });

  it('有任意题不在该生作答事实中 -> 1004', async () => {
    questions.findByIds.mockResolvedValue([
      row({ id: 1, source: 'paper', answer: 'A' }),
      row({ id: 2, source: 'paper', answer: 'B' }),
    ]);
    questions.findAnsweredQuestionIds.mockResolvedValue(new Set([1]));

    await expect(service.recommend(7, [1, 2]))
      .rejects.toMatchObject({ response: { code: 1004, message: '只能推荐自己做过的题' } });
  });

  it('合法推荐：题 id 去重、content key 用排序集合、年级用 grade_N code，并调用仓储建集', async () => {
    questions.findByIds.mockResolvedValue([row({ id: 2 }), row({ id: 1 })]);

    await expect(service.recommend(7, [2, 1, 2])).resolves.toEqual({ setId: 3, alreadyRecommended: false });
    expect(students.findById).toHaveBeenCalledWith(7);
    expect(questions.findByIds).toHaveBeenCalledWith([2, 1]);
    expect(questions.findAnsweredQuestionIds).toHaveBeenCalledWith(7, [2, 1]);
    expect(featuredRepo.createRecommendation).toHaveBeenCalledWith({
      subjectId: 1,
      questionIds: [2, 1],
      contentKey: createFeaturedContentKey(1, [1, 2]),
      studentId: 7,
      gradeCode: 'grade_8',
    });
  });

  it('题集为空 / 超过 20 / 含非法 ID -> 1001，且在查学生之前就拒绝', async () => {
    for (const ids of [[], Array.from({ length: 21 }, (_, i) => i + 1), [0], [1.5]]) {
      await expect(service.recommend(7, ids)).rejects.toMatchObject({ response: { code: 1001 } });
    }
    expect(students.findById).not.toHaveBeenCalled();
  });

  it('学生不存在或年级无法解析 -> 1001，且不查题', async () => {
    students.findById.mockResolvedValueOnce(null).mockResolvedValueOnce({ id: 7, grade: '大学' });

    await expect(service.recommend(7, [1, 2])).rejects.toMatchObject({ response: { code: 1001 } });
    await expect(service.recommend(7, [1, 2])).rejects.toMatchObject({ response: { code: 1001 } });
    expect(questions.findByIds).not.toHaveBeenCalled();
  });

  it('任意题不存在或已下架 -> 1002', async () => {
    questions.findByIds.mockResolvedValue([row({ id: 1 })]);

    await expect(service.recommend(7, [1, 2])).rejects.toMatchObject({ response: { code: 1002 } });
    expect(questions.findAnsweredQuestionIds).not.toHaveBeenCalled();
  });

  it('任意题为 freeform -> 1004', async () => {
    questions.findByIds.mockResolvedValue([row({ id: 1 }), row({ id: 2, source: 'freeform' })]);

    await expect(service.recommend(7, [1, 2]))
      .rejects.toMatchObject({ response: { code: 1004, message: 'freeform 题不能推荐' } });
    expect(questions.findAnsweredQuestionIds).not.toHaveBeenCalled();
  });

  it('任意题无标准答案（全空白） -> 1004', async () => {
    questions.findByIds.mockResolvedValue([row({ id: 1 }), row({ id: 2, answer: '   ' })]);

    await expect(service.recommend(7, [1, 2]))
      .rejects.toMatchObject({ response: { code: 1004, message: '无标准答案的题不能推荐' } });
  });

  it('跨学科 -> 1001', async () => {
    questions.findByIds.mockResolvedValue([row({ id: 1 }), row({ id: 2, subject_id: 3 })]);

    await expect(service.recommend(7, [1, 2]))
      .rejects.toMatchObject({ response: { code: 1001, message: '只能推荐同一学科的题' } });
  });

  it('当日新题集数达到 10 -> 429/1008，且不建集', async () => {
    featuredRepo.countSetsCreatedToday.mockResolvedValue(10);

    const err = await service.recommend(7, [1, 2]).catch((e) => e);
    expect(err.getStatus()).toBe(429);
    expect(err.response).toMatchObject({ code: 1008 });
    expect(featuredRepo.createRecommendation).not.toHaveBeenCalled();
  });

  it('按固定顺序校验：freeform 优先于作答事实，作答事实优先于每日额度', async () => {
    questions.findByIds.mockResolvedValue([row({ id: 1, source: 'freeform' }), row({ id: 2 })]);
    questions.findAnsweredQuestionIds.mockResolvedValue(new Set());
    featuredRepo.countSetsCreatedToday.mockResolvedValue(10);

    await expect(service.recommend(7, [1, 2])).rejects.toMatchObject({ response: { code: 1004 } });
    expect(questions.findAnsweredQuestionIds).not.toHaveBeenCalled();
    expect(featuredRepo.countSetsCreatedToday).not.toHaveBeenCalled();

    questions.findByIds.mockResolvedValue([row({ id: 1 }), row({ id: 2 })]);
    await expect(service.recommend(7, [1, 2])).rejects.toMatchObject({ response: { code: 1004 } });
    expect(featuredRepo.countSetsCreatedToday).not.toHaveBeenCalled();
  });

  it('同一题集重复推荐：透传仓储的 alreadyRecommended=true 幂等结果', async () => {
    featuredRepo.createRecommendation.mockResolvedValue({ setId: 3, alreadyRecommended: true });

    await expect(service.recommend(7, [1, 2]))
      .resolves.toEqual({ setId: 3, alreadyRecommended: true });
  });
});
