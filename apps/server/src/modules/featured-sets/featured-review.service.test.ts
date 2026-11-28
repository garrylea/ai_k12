import { beforeEach, describe, expect, it, vi } from 'vitest';
import { FeaturedReviewService } from './featured-review.service.js';
import type { JwtUser } from '../../common/guards/jwt-auth.guard.js';
import type { ReviewSetDetail } from '../../database/repositories/featured-question-sets.repo.js';

const reviewer: JwtUser = { sub: 8, role: 'researcher' };

/** 审核详情夹具：默认 pending，各用例只覆盖差异字段。 */
const detail = (overrides: Partial<ReviewSetDetail> = {}): ReviewSetDetail => ({
  setId: 5,
  subjectId: 1,
  subjectName: '数学',
  questionCount: 3,
  recommendationCount: 36,
  gradeDistribution: [{ gradeCode: 'grade_8', count: 36 }],
  reviewStatus: 'pending',
  createdAt: new Date('2026-11-28T00:00:00.000Z'),
  questions: [],
  publications: [],
  ...overrides,
});

/** 36 名在架初二学生 + 其它年级/无法解析/空年级；用于钉住 reachCount=36。 */
const activeStudents = () => [
  ...Array.from({ length: 36 }, (_, i) => ({ id: i + 1, grade: '初二' })),
  { id: 90, grade: '初一' },
  { id: 91, grade: '大学' },
  { id: 92, grade: null },
];

describe('FeaturedReviewService', () => {
  let repository: {
    listReviewSets: ReturnType<typeof vi.fn>;
    getReviewSet: ReturnType<typeof vi.fn>;
    pendingCount: ReturnType<typeof vi.fn>;
    publish: ReturnType<typeof vi.fn>;
    reject: ReturnType<typeof vi.fn>;
    reopen: ReturnType<typeof vi.fn>;
    withdraw: ReturnType<typeof vi.fn>;
  };
  let students: { listAllActive: ReturnType<typeof vi.fn> };
  let service: FeaturedReviewService;

  beforeEach(() => {
    repository = {
      listReviewSets: vi.fn().mockResolvedValue({ items: [], total: 0 }),
      getReviewSet: vi.fn().mockResolvedValue(detail()),
      pendingCount: vi.fn().mockResolvedValue(3),
      publish: vi.fn().mockResolvedValue({ publicationId: 22 }),
      reject: vi.fn().mockResolvedValue(undefined),
      reopen: vi.fn().mockResolvedValue(undefined),
      withdraw: vi.fn().mockResolvedValue(undefined),
    };
    students = { listAllActive: vi.fn().mockResolvedValue(activeStudents()) };
    service = new FeaturedReviewService(repository as never, students as never);
  });

  it('同一题集发八年级时使用八年级自己的标题', async () => {
    await expect(service.publish(5, { title: '八年级数学精选题', gradeCode: 'grade_8' }, reviewer))
      .resolves.toEqual({ publicationId: 22 });
    expect(repository.publish).toHaveBeenCalledWith({
      setId: 5, title: '八年级数学精选题', gradeCode: 'grade_8',
      reviewerId: 8, reachCount: 36,
    });
  });

  it('空标题/纯空白/超 60 字与非法年级均为 1001，且不读题集', async () => {
    for (const body of [
      { title: '', gradeCode: 'grade_8' },
      { title: '   ', gradeCode: 'grade_8' },
      { title: 'x'.repeat(61), gradeCode: 'grade_8' },
      { title: 'x', gradeCode: '大学' },
      { title: 'x' },
      null,
    ]) {
      await expect(service.publish(5, body, reviewer))
        .rejects.toMatchObject({ response: { code: 1001 } });
    }
    expect(repository.getReviewSet).not.toHaveBeenCalled();
    expect(repository.publish).not.toHaveBeenCalled();
  });

  it('rejected 题集不能直接发布 -> 1004；题集不存在 -> 1002', async () => {
    repository.getReviewSet.mockResolvedValueOnce(detail({ reviewStatus: 'rejected' }));
    await expect(service.publish(5, { title: 'x', gradeCode: 'grade_8' }, reviewer))
      .rejects.toMatchObject({ response: { code: 1004 } });
    expect(students.listAllActive).not.toHaveBeenCalled();
    expect(repository.publish).not.toHaveBeenCalled();

    repository.getReviewSet.mockResolvedValueOnce(null);
    await expect(service.publish(5, { title: 'x', gradeCode: 'grade_8' }, reviewer))
      .rejects.toMatchObject({ response: { code: 1002 } });
    expect(repository.publish).not.toHaveBeenCalled();
  });

  it('reach_count 只数目标年级的有效学生，grade_N 与宽容写法同源', async () => {
    students.listAllActive.mockResolvedValueOnce([
      ...Array.from({ length: 34 }, (_, i) => ({ id: i + 1, grade: '初二' })),
      { id: 80, grade: 'grade_8' },
      { id: 81, grade: '八年级' },
      { id: 82, grade: '初一' },
      { id: 83, grade: '大学' },
      { id: 84, grade: null },
    ]);
    await service.publish(5, { title: ' 八年级标题 ', gradeCode: 'grade_8' }, reviewer);

    expect(students.listAllActive).toHaveBeenCalledTimes(1);
    expect(repository.publish).toHaveBeenCalledWith({
      setId: 5, title: '八年级标题', gradeCode: 'grade_8',
      reviewerId: 8, reachCount: 36,
    });
  });

  it('reject 只允许 pending', async () => {
    await expect(service.reject(5, reviewer)).resolves.toBeUndefined();
    expect(repository.reject).toHaveBeenCalledWith(5, 8);

    repository.getReviewSet.mockResolvedValueOnce(detail({ reviewStatus: 'approved' }));
    await expect(service.reject(5, reviewer)).rejects.toMatchObject({ response: { code: 1004 } });
    expect(repository.reject).toHaveBeenCalledTimes(1);

    repository.getReviewSet.mockResolvedValueOnce(null);
    await expect(service.reject(5, reviewer)).rejects.toMatchObject({ response: { code: 1002 } });
  });

  it('reopen 只允许 rejected', async () => {
    repository.getReviewSet.mockResolvedValueOnce(detail({ reviewStatus: 'rejected' }));
    await expect(service.reopen(5)).resolves.toBeUndefined();
    expect(repository.reopen).toHaveBeenCalledWith(5);

    await expect(service.reopen(5)).rejects.toMatchObject({ response: { code: 1004 } });
    expect(repository.reopen).toHaveBeenCalledTimes(1);

    repository.getReviewSet.mockResolvedValueOnce(null);
    await expect(service.reopen(5)).rejects.toMatchObject({ response: { code: 1002 } });
  });

  it('withdraw 把 publicationId 与 reviewerId 交给仓储（仓储 SQL 守卫 published）', async () => {
    await expect(service.withdraw(22, reviewer)).resolves.toBeUndefined();
    expect(repository.withdraw).toHaveBeenCalledWith(22, 8);
    expect(repository.getReviewSet).not.toHaveBeenCalled();
  });

  it('list 缺省 pending 第 1 页，显式参数透传', async () => {
    const result = { items: [], total: 0 };
    repository.listReviewSets.mockResolvedValueOnce(result);

    await expect(service.list(undefined, undefined)).resolves.toEqual(result);
    expect(repository.listReviewSets).toHaveBeenCalledWith('pending', 1);

    await service.list('approved', '3');
    expect(repository.listReviewSets).toHaveBeenCalledWith('approved', 3);
  });

  it('非法 status/page -> 1001', async () => {
    for (const [status, page] of [['all', '1'], ['pending', '0'], ['pending', 'x']] as const) {
      await expect(service.list(status, page)).rejects.toMatchObject({ response: { code: 1001 } });
    }
    expect(repository.listReviewSets).not.toHaveBeenCalled();
  });

  it('pendingCount 与 detail 透传，detail 不存在 -> 1002', async () => {
    await expect(service.pendingCount()).resolves.toBe(3);
    const found = detail();
    repository.getReviewSet.mockResolvedValueOnce(found);
    await expect(service.detail(5)).resolves.toEqual(found);
    repository.getReviewSet.mockResolvedValueOnce(null);
    await expect(service.detail(5)).rejects.toMatchObject({ response: { code: 1002 } });
  });
});
