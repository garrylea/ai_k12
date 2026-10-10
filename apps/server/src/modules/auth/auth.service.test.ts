import { describe, it, expect, vi } from 'vitest';
import * as bcrypt from 'bcrypt';
import { AuthService } from './auth.service';
import { SessionRegistry } from '../../common/guards/session-registry.js';

const HASH = bcrypt.hashSync('pw', 4);

const mkDeps = (overrides: Record<string, any> = {}) => ({
  studentsRepo: {
    findByUsername: vi.fn().mockResolvedValue(null),
  },
  parentsRepo: {
    findByPhone: vi.fn().mockResolvedValue(null),
    create: vi.fn().mockResolvedValue(9),
    updatePassword: vi.fn().mockResolvedValue(undefined),
  },
  adminsRepo: {
    findByUsername: vi.fn().mockResolvedValue(null),
  },
  jwtService: { sign: vi.fn().mockReturnValue('fake-token') },
  subscriptionsService: {
    ensureTrial: vi.fn().mockResolvedValue(undefined),
  },
  resetCodeService: {
    issue: vi.fn().mockReturnValue({ code: '123456', expiresIn: 300 }),
    verify: vi.fn(),
  },
  authSessionsRepo: { bumpAndReturnSeq: vi.fn().mockResolvedValue(1) },
  sessionRegistry: { bump: vi.fn() },
  ...overrides,
});

const mkSvc = (d: ReturnType<typeof mkDeps>) =>
  new AuthService(
    d.studentsRepo as any,
    d.adminsRepo as any,
    d.parentsRepo as any,
    d.jwtService as any,
    d.subscriptionsService as any,
    d.resetCodeService as any,
    d.authSessionsRepo as any,
    d.sessionRegistry as any,
  );

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
    expect(d.jwtService.sign).toHaveBeenCalledWith({ sub: 1, role: 'admin', seq: 1 });
    expect(d.authSessionsRepo.bumpAndReturnSeq).toHaveBeenCalledWith('admin', 1);
  });

  it('手机号命中 parents -> parent token', async () => {
    const d = mkDeps({ parentsRepo: { findByPhone: vi.fn().mockResolvedValue(parent) } });
    const r = await mkSvc(d).login('13800000000', 'pw');
    expect(r.user.role).toBe('parent');
    expect(d.jwtService.sign).toHaveBeenCalledWith({ sub: 3, role: 'parent', seq: 1 });
    expect(d.authSessionsRepo.bumpAndReturnSeq).toHaveBeenCalledWith('parent', 3);
  });

  it('学生用户名命中 -> student token 带 familyId/parentId', async () => {
    const d = mkDeps({ studentsRepo: { findByUsername: vi.fn().mockResolvedValue(student) } });
    const r = await mkSvc(d).login('xiaoming', 'pw');
    expect(r.user.role).toBe('student');
    expect(d.jwtService.sign).toHaveBeenCalledWith({ sub: 7, role: 'student', familyId: 3, parentId: 3, seq: 1 });
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

describe('AuthService 登录 bump（单点登录互踢）', () => {
  it('登录成功 → bump（写库 + 注册表）先于签名，seq 进入 token', async () => {
    const d = mkDeps({ studentsRepo: { findByUsername: vi.fn().mockResolvedValue(student) } });
    d.authSessionsRepo.bumpAndReturnSeq.mockResolvedValue(7);
    await mkSvc(d).login('xiaoming', 'pw');
    expect(d.authSessionsRepo.bumpAndReturnSeq).toHaveBeenCalledWith('student', 7);
    expect(d.sessionRegistry.bump).toHaveBeenCalledWith('student', 7, 7);
    expect(d.jwtService.sign).toHaveBeenCalledWith(
      expect.objectContaining({ sub: 7, role: 'student', seq: 7 }),
    );
  });

  it('密码错误 → 不 bump（不产生新会话序号）', async () => {
    const d = mkDeps({ studentsRepo: { findByUsername: vi.fn().mockResolvedValue(student) } });
    await expect(mkSvc(d).login('xiaoming', 'wrong'))
      .rejects.toMatchObject({ response: { code: 1003 } });
    expect(d.authSessionsRepo.bumpAndReturnSeq).not.toHaveBeenCalled();
  });

  it('bump 写库失败 → 登录整体失败（500），绝不签发无 seq / 旧 seq 的 token', async () => {
    const d = mkDeps({ studentsRepo: { findByUsername: vi.fn().mockResolvedValue(student) } });
    d.authSessionsRepo.bumpAndReturnSeq.mockRejectedValue(new Error('db down'));
    await expect(mkSvc(d).login('xiaoming', 'pw')).rejects.toThrow('db down');
    expect(d.jwtService.sign).not.toHaveBeenCalled();
  });

  it('同账号二次登录 → 第一次的 token seq 失配（互踢语义，服务级链路）', async () => {
    const registry = new SessionRegistry();
    // 用真实 SessionRegistry + bumpAndReturnSeq mock 计数 1、2：
    let n = 0;
    const d = mkDeps({ studentsRepo: { findByUsername: vi.fn().mockResolvedValue(student) } });
    d.authSessionsRepo.bumpAndReturnSeq.mockImplementation(async () => ++n);
    d.sessionRegistry = registry as any; // 用真实实例注入 svc
    const svc = mkSvc(d);
    await svc.login('xiaoming', 'pw');
    await svc.login('xiaoming', 'pw');
    expect(registry.matches('student', 7, 1)).toBe(false); // 第一个 token 已被踢
    expect(registry.matches('student', 7, 2)).toBe(true);
  });
});

describe('AuthService.register 家长注册', () => {
  it('新手机号 -> 创建 + 发 parent token', async () => {
    const d = mkDeps({ parentsRepo: { findByPhone: vi.fn().mockResolvedValue(null), create: vi.fn().mockResolvedValue(9) } as any });
    const r = await mkSvc(d).register({ phone: '13900000000', password: '123456', name: '乙' });
    expect(r.user.role).toBe('parent');
    expect(d.parentsRepo.create).toHaveBeenCalledWith(expect.objectContaining({ phone: '13900000000' }));
    expect(d.jwtService.sign).toHaveBeenCalledWith({ sub: 9, role: 'parent', seq: 1 });
  });

  it('注册成功后送 7 天试用（ensureTrial 以新 parentId 调用）', async () => {
    const d = mkDeps();
    await mkSvc(d).register({ phone: '13900000000', password: '123456', name: '乙' });
    expect(d.subscriptionsService.ensureTrial).toHaveBeenCalledTimes(1);
    expect(d.subscriptionsService.ensureTrial).toHaveBeenCalledWith(9);
  });

  it('送试用失败 -> 注册整体失败（不发 token）', async () => {
    const d = mkDeps({
      subscriptionsService: { ensureTrial: vi.fn().mockRejectedValue(new Error('db down')) },
    });
    await expect(mkSvc(d).register({ phone: '13900000000', password: '123456' }))
      .rejects.toThrow('db down');
    expect(d.jwtService.sign).not.toHaveBeenCalled();
  });

  it('手机号已存在 -> 1004', async () => {
    const d = mkDeps({ parentsRepo: { findByPhone: vi.fn().mockResolvedValue(parent), create: vi.fn() } as any });
    await expect(mkSvc(d).register({ phone: '13800000000', password: '123456' }))
      .rejects.toMatchObject({ response: { code: 1004, message: '该手机号已注册' } });
    expect(d.parentsRepo.create).not.toHaveBeenCalled();
  });
});

describe('AuthService.requestPasswordReset', () => {
  it('未注册手机号 -> 1002「该手机号未注册」，不 issue', async () => {
    const d = mkDeps();
    await expect(mkSvc(d).requestPasswordReset('13800000000'))
      .rejects.toMatchObject({ response: { code: 1002, message: '该手机号未注册' } });
    expect(d.resetCodeService.issue).not.toHaveBeenCalled();
  });

  it('已注册手机号 -> issue 并返回 {code, expiresIn}', async () => {
    const d = mkDeps({ parentsRepo: { findByPhone: vi.fn().mockResolvedValue(parent) } });
    const r = await mkSvc(d).requestPasswordReset('13800000000');
    expect(r).toEqual({ code: '123456', expiresIn: 300 });
    expect(d.resetCodeService.issue).toHaveBeenCalledWith('13800000000');
  });
});

describe('AuthService.resetPassword', () => {
  const dto = { phone: '13800000000', code: '123456', newPassword: 'new-pass-1' };

  it('验证码校验失败 -> 原样上抛（1003），不动数据库', async () => {
    const d = mkDeps({
      resetCodeService: {
        issue: vi.fn(),
        verify: vi.fn().mockImplementation(() => {
          throw Object.assign(new Error('验证码错误'), {
            response: { code: 1003, message: '验证码错误' },
          });
        }),
      },
    });
    await expect(mkSvc(d).resetPassword(dto)).rejects.toMatchObject({ response: { code: 1003 } });
    expect(d.parentsRepo.updatePassword).not.toHaveBeenCalled();
  });

  it('验证通过但家长已不存在（竞态）-> 1002，不更新密码', async () => {
    const d = mkDeps(); // findByPhone 默认 null
    await expect(mkSvc(d).resetPassword(dto))
      .rejects.toMatchObject({ response: { code: 1002, message: '该手机号未注册' } });
    expect(d.parentsRepo.updatePassword).not.toHaveBeenCalled();
  });

  it('成功路径 -> bcrypt 新哈希写入 updatePassword，返回 {success: true}，不签发 token', async () => {
    const d = mkDeps({ parentsRepo: { findByPhone: vi.fn().mockResolvedValue(parent), updatePassword: vi.fn().mockResolvedValue(undefined) } });
    const r = await mkSvc(d).resetPassword(dto);
    expect(r).toEqual({ success: true });
    expect(d.parentsRepo.updatePassword).toHaveBeenCalledTimes(1);
    const [id, hash] = (d.parentsRepo.updatePassword as any).mock.calls[0];
    expect(id).toBe(parent.id);
    expect(hash).not.toBe(dto.newPassword);
    // bcrypt 可比对：新哈希确实对应新密码（bcrypt 已在文件顶部 `import * as bcrypt`）
    expect(await bcrypt.compare(dto.newPassword, hash)).toBe(true);
    expect(d.jwtService.sign).not.toHaveBeenCalled(); // 不失效/不新发 token
  });
});
