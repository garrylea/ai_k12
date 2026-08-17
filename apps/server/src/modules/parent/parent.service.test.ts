import { describe, it, expect, vi } from 'vitest';
import { ParentService } from './parent.service';

const mk = (overrides: Record<string, any> = {}) => ({
  studentsRepo: {
    findById: vi.fn().mockResolvedValue(null),
    findByUsername: vi.fn().mockResolvedValue(null),
    findByParentId: vi.fn().mockResolvedValue([]),
    create: vi.fn().mockResolvedValue(11),
    updatePassword: vi.fn().mockResolvedValue(undefined),
    setActive: vi.fn().mockResolvedValue(undefined),
    createDefaultSettings: vi.fn().mockResolvedValue(undefined),
  },
  ...overrides,
});

const mkSvc = (d: ReturnType<typeof mk>) => new ParentService(d.studentsRepo as any);

const own = { id: 5, parentId: 3, username: 'xiaoming', passwordHash: 'h', name: '小明', age: 13, grade: '初二', schoolLevel: 'junior', isActive: true };

describe('ParentService 学生子账号管理', () => {
  it('新建：grade 推导 school_level + 连带建 settings', async () => {
    const d = mk();
    await mkSvc(d).createStudent(3, { name: '二宝', username: 'erbao', password: '123456', age: 8, grade: '小学三年级' });
    expect(d.studentsRepo.create).toHaveBeenCalledWith(expect.objectContaining({ schoolLevel: 'primary', parentId: 3 }));
    expect(d.studentsRepo.createDefaultSettings).toHaveBeenCalledWith(11, 'primary');
  });

  it('新建：用户名已存在 -> 1004', async () => {
    const d = mk({ studentsRepo: Object.assign(mk().studentsRepo, { findByUsername: vi.fn().mockResolvedValue(own) }) });
    await expect(mkSvc(d).createStudent(3, { name: 'x', username: 'xiaoming', password: '123456', age: 13, grade: '初二' }))
      .rejects.toMatchObject({ response: { code: 1004, message: '用户名已存在' } });
  });

  it('新建：非法年级 -> 1001', async () => {
    const d = mk();
    await expect(mkSvc(d).createStudent(3, { name: 'x', username: 'newbie', password: '123456', age: 13, grade: '大学' }))
      .rejects.toMatchObject({ response: { code: 1001 } });
  });

  it('重置密码：非自己名下学生 -> 1005（不泄漏存在性）', async () => {
    const d = mk({ studentsRepo: Object.assign(mk().studentsRepo, { findById: vi.fn().mockResolvedValue({ ...own, parentId: 999 }) }) });
    await expect(mkSvc(d).resetPassword(3, 5, 'newpass123'))
      .rejects.toMatchObject({ response: { code: 1005, message: '无权操作该学生' } });
  });

  it('重置密码：学生不存在 -> 1002；成功 -> updatePassword', async () => {
    const d = mk();
    await expect(mkSvc(d).resetPassword(3, 5, 'newpass123'))
      .rejects.toMatchObject({ response: { code: 1002, message: '学生不存在' } });
    const d2 = mk({ studentsRepo: Object.assign(mk().studentsRepo, { findById: vi.fn().mockResolvedValue(own) }) });
    await mkSvc(d2).resetPassword(3, 5, 'newpass123');
    expect(d2.studentsRepo.updatePassword).toHaveBeenCalledWith(5, expect.any(String));
  });

  it('重置密码：长度不合法 -> 1001 且不落库', async () => {
    const d = mk({ studentsRepo: Object.assign(mk().studentsRepo, { findById: vi.fn().mockResolvedValue(own) }) });
    await expect(mkSvc(d).resetPassword(3, 5, '123'))
      .rejects.toMatchObject({ response: { code: 1001 } });
    expect(d.studentsRepo.updatePassword).not.toHaveBeenCalled();
  });

  it('停用/启用：归属校验 + setActive', async () => {
    const d = mk({ studentsRepo: Object.assign(mk().studentsRepo, { findById: vi.fn().mockResolvedValue(own) }) });
    await mkSvc(d).setStatus(3, 5, false);
    expect(d.studentsRepo.setActive).toHaveBeenCalledWith(5, false);
  });

  it('列表：只传 parentId，脱敏 passwordHash', async () => {
    const d = mk({ studentsRepo: Object.assign(mk().studentsRepo, { findByParentId: vi.fn().mockResolvedValue([own]) }) });
    const list = await mkSvc(d).listStudents(3);
    expect(list[0]).not.toHaveProperty('passwordHash');
    expect(list[0]).toMatchObject({ username: 'xiaoming', isActive: true });
  });
});
