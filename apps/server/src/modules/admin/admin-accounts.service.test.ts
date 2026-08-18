import { describe, it, expect, vi } from 'vitest';
import { AdminAccountsService } from './admin-accounts.service';

const mk = (o: any = {}) => ({
  parentsRepo: { search: vi.fn().mockResolvedValue([]), findById: vi.fn().mockResolvedValue(null), setActive: vi.fn() },
  studentsRepo: { search: vi.fn().mockResolvedValue([]), findByParentId: vi.fn().mockResolvedValue([]), setActive: vi.fn(), findById: vi.fn().mockResolvedValue(null) },
  banRegistry: { banParent: vi.fn(), unbanParent: vi.fn(), banStudent: vi.fn(), unbanStudent: vi.fn() },
  ...o,
});
const svc = (d: any) => new AdminAccountsService(d.parentsRepo, d.studentsRepo, d.banRegistry);

describe('AdminAccountsService', () => {
  it('封家长连封其名下学生 + BanRegistry 同步', async () => {
    const d = mk({
      parentsRepo: { ...mk().parentsRepo, findById: vi.fn().mockResolvedValue({ id: 2, isActive: true }) },
      studentsRepo: { ...mk().studentsRepo, findByParentId: vi.fn().mockResolvedValue([{ id: 5, isActive: true }, { id: 6, isActive: true }]) },
    });
    await svc(d).setParentStatus(2, false);
    expect(d.parentsRepo.setActive).toHaveBeenCalledWith(2, false);
    expect(d.studentsRepo.setActive).toHaveBeenCalledWith(5, false);
    expect(d.studentsRepo.setActive).toHaveBeenCalledWith(6, false);
    expect(d.banRegistry.banParent).toHaveBeenCalledWith(2);
    expect(d.banRegistry.banStudent).toHaveBeenCalledWith(5);
    expect(d.banRegistry.banStudent).toHaveBeenCalledWith(6);
  });

  it('解封家长反向全部解封', async () => {
    const d = mk({
      parentsRepo: { ...mk().parentsRepo, findById: vi.fn().mockResolvedValue({ id: 2, isActive: false }) },
      studentsRepo: { ...mk().studentsRepo, findByParentId: vi.fn().mockResolvedValue([{ id: 5 }]) },
    });
    await svc(d).setParentStatus(2, true);
    expect(d.parentsRepo.setActive).toHaveBeenCalledWith(2, true);
    expect(d.studentsRepo.setActive).toHaveBeenCalledWith(5, true);
    expect(d.banRegistry.unbanParent).toHaveBeenCalledWith(2);
    expect(d.banRegistry.unbanStudent).toHaveBeenCalledWith(5);
  });

  it('家长不存在 -> 1002', async () => {
    await expect(svc(mk()).setParentStatus(99, false)).rejects.toMatchObject({ response: { code: 1002 } });
  });

  it('单独封/解学生（不影响家长）', async () => {
    const d = mk({ studentsRepo: { ...mk().studentsRepo, findById: vi.fn().mockResolvedValue({ id: 5, isActive: true }) } });
    await svc(d).setStudentStatus(5, false);
    expect(d.studentsRepo.setActive).toHaveBeenCalledWith(5, false);
    expect(d.banRegistry.banStudent).toHaveBeenCalledWith(5);
    expect(d.parentsRepo.setActive).not.toHaveBeenCalled();
  });

  it('学生不存在 -> 1002', async () => {
    await expect(svc(mk()).setStudentStatus(99, false)).rejects.toMatchObject({ response: { code: 1002 } });
  });
});

describe('AdminAccountsService 脱敏', () => {
  it('搜索家长/学生不泄漏 passwordHash', async () => {
    const parentRow = { id: 1, phone: '13800000000', passwordHash: '$2b$10$secret', name: '甲', isActive: true, studentCount: 2 };
    const d = mk({ parentsRepo: { ...mk().parentsRepo, search: vi.fn().mockResolvedValue([parentRow]) } });
    const list = await svc(d).searchParents('138');
    expect(JSON.stringify(list)).not.toContain('secret');
    expect(list[0].studentCount).toBe(2);

    const studentRow = { id: 5, parentId: 1, username: 's1', passwordHash: '$2b$10$secret2', name: '小', age: 13, grade: '初二', schoolLevel: 'junior', isActive: true };
    const d2 = mk({ studentsRepo: { ...mk().studentsRepo, search: vi.fn().mockResolvedValue([studentRow]) } });
    const list2 = await svc(d2).searchStudents('s1');
    expect(JSON.stringify(list2)).not.toContain('secret2');
    expect(list2[0].username).toBe('s1');
  });
});
