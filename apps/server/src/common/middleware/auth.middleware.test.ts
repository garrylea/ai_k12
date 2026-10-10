import { describe, it, expect, vi } from 'vitest';
import { AuthMiddleware } from './auth.middleware.js';
import { SessionRegistry } from '../guards/session-registry.js';

const TOKEN = 'tok';
const bearer = `Bearer ${TOKEN}`;

function mkDeps() {
  return {
    jwtService: { verify: vi.fn() },
    banRegistry: { isBanned: vi.fn().mockReturnValue(false) },
    sessionRegistry: new SessionRegistry(),
  };
}

describe('AuthMiddleware —— 单点登录互踢（seq 校验）', () => {
  it('seq 匹配 → request.user 挂载、放行', () => {
    const d = mkDeps();
    d.jwtService.verify.mockReturnValue({ sub: 7, role: 'student', seq: 3 });
    d.sessionRegistry.bump('student', 7, 3);
    const r = { headers: { authorization: bearer } } as any;
    const next = vi.fn();

    new AuthMiddleware(d.jwtService as any, d.banRegistry as any, d.sessionRegistry).use(r, {} as any, next);

    expect(next).toHaveBeenCalledTimes(1);
    expect(r.user).toMatchObject({ sub: 7, role: 'student' });
  });

  it('seq 失配（已在别处重新登录）→ 401/1013，穿透吞错分支直接抛', () => {
    const d = mkDeps();
    d.jwtService.verify.mockReturnValue({ sub: 7, role: 'student', seq: 2 });
    d.sessionRegistry.bump('student', 7, 3);
    const next = vi.fn();

    expect(() =>
      new AuthMiddleware(d.jwtService as any, d.banRegistry as any, d.sessionRegistry).use(
        { headers: { authorization: bearer } } as any, {} as any, next,
      ),
    ).toThrowError(
      expect.objectContaining({ response: { code: 1013, message: '账号已在其他设备登录' } }),
    );
    expect(next).not.toHaveBeenCalled();
  });

  it('旧格式 token（无 seq，上线前签发）→ 401/1013', () => {
    const d = mkDeps();
    d.jwtService.verify.mockReturnValue({ sub: 7, role: 'student' }); // 无 seq
    d.sessionRegistry.bump('student', 7, 1);
    const next = vi.fn();

    expect(() =>
      new AuthMiddleware(d.jwtService as any, d.banRegistry as any, d.sessionRegistry).use(
        { headers: { authorization: bearer } } as any, {} as any, next,
      ),
    ).toThrowError(expect.objectContaining({ response: expect.objectContaining({ code: 1013 }) }));
  });

  it('无效 token → 保持既有行为：吞掉、user 不挂、放行交给 guard', () => {
    const d = mkDeps();
    d.jwtService.verify.mockImplementation(() => { throw new Error('bad'); });
    const r = { headers: { authorization: bearer } } as any;
    const next = vi.fn();

    new AuthMiddleware(d.jwtService as any, d.banRegistry as any, d.sessionRegistry).use(r, {} as any, next);

    expect(next).toHaveBeenCalledTimes(1);
    expect(r.user).toBeUndefined();
  });

  it('无 Authorization 头 → no-op 放行（公开路由保持开放）', () => {
    const d = mkDeps();
    const next = vi.fn();
    new AuthMiddleware(d.jwtService as any, d.banRegistry as any, d.sessionRegistry).use({ headers: {} } as any, {} as any, next);
    expect(next).toHaveBeenCalledTimes(1);
    expect(d.jwtService.verify).not.toHaveBeenCalled();
  });
});
