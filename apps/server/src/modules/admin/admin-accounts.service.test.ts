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
