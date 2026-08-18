import { describe, it, expect, vi } from 'vitest';
import * as bcrypt from 'bcrypt';
import { AuthService } from './auth.service';

const HASH = bcrypt.hashSync('pw', 4);

const mkDeps = (overrides: Record<string, any> = {}) => ({
  studentsRepo: {
    findByUsername: vi.fn().mockResolvedValue(null),
  },
  parentsRepo: {
    findByPhone: vi.fn().mockResolvedValue(null),
    create: vi.fn().mockResolvedValue(9),
  },
  adminsRepo: {
    findByUsername: vi.fn().mockResolvedValue(null),
  },
  jwtService: { sign: vi.fn().mockReturnValue('fake-token') },
  ...overrides,
});

const mkSvc = (d: ReturnType<typeof mkDeps>) =>
  new AuthService(d.studentsRepo as any, d.adminsRepo as any, d.parentsRepo as any, d.jwtService as any);

const student = {
  id: 7, parentId: 3, username: 'xiaoming', passwordHash: HASH,
  name: '小明', age: 13, grade: '初二', schoolLevel: 'junior', isActive: true,
};
const parent = { id: 3, phone: '13800000000', passwordHash: HASH, name: '家长甲', isActive: true };
const admin = { id: 1, username: 'admin', passwordHash: HASH, name: '超管', isActive: true };

describe('AuthService.login 三角色', () => {
  it('管理员用户名命中 -> admin token', async () => {
    const d = mkDeps({ adminsRepo: { findByUsername: vi.fn().mockResolvedValue(admin) } });
    const r = await mkSvc(d).login('admin', 'pw');
    expect(r.user.role).toBe('admin');
    expect(d.jwtService.sign).toHaveBeenCalledWith({ sub: 1, role: 'admin' });
  });

  it('手机号命中 parents -> parent token', async () => {
    const d = mkDeps({ parentsRepo: { findByPhone: vi.fn().mockResolvedValue(parent) } });
    const r = await mkSvc(d).login('13800000000', 'pw');
    expect(r.user.role).toBe('parent');
    expect(d.jwtService.sign).toHaveBeenCalledWith({ sub: 3, role: 'parent' });
  });

  it('学生用户名命中 -> student token 带 familyId/parentId', async () => {
    const d = mkDeps({ studentsRepo: { findByUsername: vi.fn().mockResolvedValue(student) } });
    const r = await mkSvc(d).login('xiaoming', 'pw');
    expect(r.user.role).toBe('student');
    expect(d.jwtService.sign).toHaveBeenCalledWith({ sub: 7, role: 'student', familyId: 3, parentId: 3 });
  });

  it('密码错误 -> 1003', async () => {
    const d = mkDeps({ studentsRepo: { findByUsername: vi.fn().mockResolvedValue(student) } });
    await expect(mkSvc(d).login('xiaoming', 'wrong'))
      .rejects.toMatchObject({ response: { code: 1003 } });
  });

  it('学生被停用 -> 1003 且文案为「账号已停用」', async () => {
    const s = { ...student, isActive: false };
    const d = mkDeps({ studentsRepo: { findByUsername: vi.fn().mockResolvedValue(s) } });
    await expect(mkSvc(d).login('xiaoming', 'pw'))
      .rejects.toMatchObject({ response: { code: 1003, message: '账号已停用' } });
  });

  it('家长被停用 -> 1003 停用文案；全部未命中 -> 1003', async () => {
    const d = mkDeps({ parentsRepo: { findByPhone: vi.fn().mockResolvedValue({ ...parent, isActive: false }) } });
    await expect(mkSvc(d).login('13800000000', 'pw'))
      .rejects.toMatchObject({ response: { code: 1003, message: '账号已停用' } });
    const d2 = mkDeps();
    await expect(mkSvc(d2).login('nobody', 'pw'))
      .rejects.toMatchObject({ response: { code: 1003, message: '用户名或密码错误' } });
  });
});

describe('AuthService.register 家长注册', () => {
  it('新手机号 -> 创建 + 发 parent token', async () => {
    const d = mkDeps({ parentsRepo: { findByPhone: vi.fn().mockResolvedValue(null), create: vi.fn().mockResolvedValue(9) } as any });
    const r = await mkSvc(d).register({ phone: '13900000000', password: '123456', name: '乙' });
    expect(r.user.role).toBe('parent');
    expect(d.parentsRepo.create).toHaveBeenCalledWith(expect.objectContaining({ phone: '13900000000' }));
    expect(d.jwtService.sign).toHaveBeenCalledWith({ sub: 9, role: 'parent' });
  });

  it('手机号已存在 -> 1004', async () => {
    const d = mkDeps({ parentsRepo: { findByPhone: vi.fn().mockResolvedValue(parent), create: vi.fn() } as any });
    await expect(mkSvc(d).register({ phone: '13800000000', password: '123456' }))
      .rejects.toMatchObject({ response: { code: 1004, message: '该手机号已注册' } });
    expect(d.parentsRepo.create).not.toHaveBeenCalled();
  });
});
