import { describe, expect, it, vi } from 'vitest';
import { StudentsRepository } from './students.repo.js';

describe('StudentsRepository.listAllActive', () => {
  it('只取未软删且 is_active=1 的学生，字段映射与既有方法一致', async () => {
    const execute = vi.fn().mockResolvedValue([[
      {
        id: 7,
        parent_id: 3,
        username: 'student7',
        password_hash: 'hash',
        name: '学生七',
        age: 13,
        grade: '初二',
        school_level: 'junior',
        grade_updated_at: null,
        created_at: new Date('2026-11-01T00:00:00.000Z'),
        is_active: 1,
        deleted_at: null,
      },
    ], []]);
    const repo = new StudentsRepository({ execute } as never);

    const students = await repo.listAllActive();

    expect(execute).toHaveBeenCalledTimes(1);
    expect(execute.mock.calls[0][0]).toContain('WHERE deleted_at IS NULL AND is_active = 1');
    expect(students).toEqual([expect.objectContaining({
      id: 7, parentId: 3, grade: '初二', schoolLevel: 'junior', isActive: true,
    })]);
  });
});
