import { describe, it, expect, vi } from 'vitest';
import { StudentScopeService } from './student-scope.service.js';

function mk(over: any = {}) {
  const deps = {
    studentsRepo: {
      findById: vi.fn().mockResolvedValue({ id: 2, grade: '初二', schoolLevel: 'junior' }),
    },
    progressRepo: {
      findByStudentAndSubject: vi.fn().mockResolvedValue({
        studentId: 2,
        subjectId: 1,
        textbookVersionId: 10,
        currentSemesterId: 21,
        currentUnitId: 205,
      }),
    },
    versionsRepo: {
      findById: vi.fn().mockResolvedValue({ id: 10, name: '人教版', publisher: '人教版', edition: '' }),
    },
    semestersRepo: {
      findByTextbookVersionId: vi.fn().mockResolvedValue([
        { id: 21, grade: 'grade_8', term: '上', sortOrder: 3 },
        { id: 22, grade: 'grade_8', term: '下', sortOrder: 4 },
      ]),
    },
    unitsRepo: {
      findBySemesterId: vi.fn().mockResolvedValue([
        { id: 201, name: '第一章 三角形', sortOrder: 1 },
        { id: 202, name: '第二章 全等三角形', sortOrder: 2 },
        { id: 205, name: '第三章 轴对称', sortOrder: 3 },
        { id: 206, name: '第四章 整式乘法', sortOrder: 4 },
      ]),
    },
    ...over,
  };
  return { deps, svc: new StudentScopeService(deps.studentsRepo, deps.progressRepo, deps.versionsRepo, deps.semestersRepo, deps.unitsRepo) };
}

describe('StudentScopeService（从 DB 推导学习信息）', () => {
  it('年级取 students.grade；教材取学习配置；已学内容只到当前单元（含）', async () => {
    const { svc } = mk();
    expect(await svc.resolve(2, 1)).toEqual({
      gradeLabel: '初二',
      textbookLabel: '人教版',
      learnedContent: '第一章 三角形、第二章 全等三角形、第三章 轴对称',
    });
  });

  it('没有 progress 行（家长没配学习配置）→ 只有年级，教材/已学内容为空串', async () => {
    const { svc } = mk({
      progressRepo: { findByStudentAndSubject: vi.fn().mockResolvedValue(null) },
    });
    expect(await svc.resolve(2, 1)).toEqual({
      gradeLabel: '初二',
      textbookLabel: '',
      learnedContent: '',
    });
  });

  it('没设当前单元 → 整册都算学过', async () => {
    const { svc } = mk({
      progressRepo: {
        findByStudentAndSubject: vi.fn().mockResolvedValue({
          textbookVersionId: 10, currentSemesterId: 21, currentUnitId: null,
        }),
      },
    });
    const r = await svc.resolve(2, 1);
    expect(r.learnedContent).toBe(
      '第一章 三角形、第二章 全等三角形、第三章 轴对称、第四章 整式乘法',
    );
  });

  it('没设当前学期 → 按学生年级的 grade_N 找学期', async () => {
    const { svc, deps } = mk({
      progressRepo: {
        findByStudentAndSubject: vi.fn().mockResolvedValue({
          textbookVersionId: 10, currentSemesterId: null, currentUnitId: null,
        }),
      },
    });
    const r = await svc.resolve(2, 1);
    expect(deps.unitsRepo.findBySemesterId).toHaveBeenCalledWith(21);
    expect(r.learnedContent).toContain('第一章 三角形');
  });

  it('教材版本查不到 → 教材为空串，但年级与已学内容仍返回', async () => {
    const { svc } = mk({ versionsRepo: { findById: vi.fn().mockResolvedValue(null) } });
    const r = await svc.resolve(2, 1);
    expect(r.textbookLabel).toBe('');
    expect(r.learnedContent).toContain('第三章 轴对称');
  });

  it('历史脏年级（grade_8 / 「八年级」）→ 统一输出标准标签「初二」并照样匹配学期', async () => {
    for (const raw of ['grade_8', '八年级', '初二']) {
      const { svc } = mk({
        studentsRepo: { findById: vi.fn().mockResolvedValue({ id: 2, grade: raw, schoolLevel: 'junior' }) },
        progressRepo: {
          findByStudentAndSubject: vi.fn().mockResolvedValue({
            textbookVersionId: 10, currentSemesterId: null, currentUnitId: null,
          }),
        },
      });
      const r = await svc.resolve(2, 1);
      expect(r.gradeLabel).toBe('初二');
      expect(r.learnedContent).toContain('第一章 三角形');
    }
  });

  it('学生查不到 → 年级空串，不抛错', async () => {
    const { svc } = mk({ studentsRepo: { findById: vi.fn().mockResolvedValue(null) } });
    expect((await svc.resolve(2, 1)).gradeLabel).toBe('');
  });
});
