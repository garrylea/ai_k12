import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PasswordResetCodeService } from './password-reset-code.service';

/**
 * 内存验证码服务：全部时间相关行为用 vitest fake timers 驱动，
 * 不依赖真实等待。参数（5 分钟有效期 / 60s 重发间隔 / 5 次作废）与
 * spec §3.4 一致，这里逐条钉住。
 */
describe('PasswordResetCodeService', () => {
  let svc: PasswordResetCodeService;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-09T12:00:00Z'));
    svc = new PasswordResetCodeService();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('issue 返回 6 位数字验证码，expiresIn 为 300 秒', () => {
    const { code, expiresIn } = svc.issue('13800000000');
    expect(code).toMatch(/^\d{6}$/);
    expect(expiresIn).toBe(300);
  });

  it('同一手机号 60 秒内重复 issue -> 429 / code 1008', () => {
    svc.issue('13800000000');
    vi.advanceTimersByTime(59_000);
    let caught: any;
    try {
      svc.issue('13800000000');
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeDefined();
    expect(caught).toMatchObject({ status: 429, response: { code: 1008, message: '请求过于频繁，请稍后再试' } });
  });

  it('超过 60 秒后可以重新 issue，旧码被替换', () => {
    const first = svc.issue('13800000000');
    vi.advanceTimersByTime(61_000);
    const second = svc.issue('13800000000');
    expect(second.code).toMatch(/^\d{6}$/);
    // 旧码已不可用
    expect(() => svc.verify('13800000000', first.code)).toThrowError(/验证码错误/);
    // 新码可用
    expect(() => svc.verify('13800000000', second.code)).not.toThrow();
  });

  it('不同手机号互不影响（60s 间隔只按手机号算）', () => {
    svc.issue('13800000000');
    expect(() => svc.issue('13900000000')).not.toThrow();
  });

  it('verify 正确验证码 -> 通过且消费（第二次同码报过期）', () => {
    const { code } = svc.issue('13800000000');
    expect(() => svc.verify('13800000000', code)).not.toThrow();
    expect(() => svc.verify('13800000000', code)).toThrowError(/验证码已过期/);
  });

  it('verify 未知手机号 -> 1003 过期文案（不泄漏码是否存在）', () => {
    let caught: any;
    try {
      svc.verify('13700000000', '123456');
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeDefined();
    expect(caught).toMatchObject({ status: 401, response: { code: 1003, message: '验证码已过期，请重新获取' } });
  });

  it('verify 错误码 -> 1003「验证码错误」，且不消费（改对后仍可通过）', () => {
    const { code } = svc.issue('13800000000');
    expect(() => svc.verify('13800000000', '000000')).toThrowError(/验证码错误/);
    expect(() => svc.verify('13800000000', code)).not.toThrow();
  });

  it('累计错 5 次作废该码，之后即使码正确也报过期', () => {
    const { code } = svc.issue('13800000000');
    for (let i = 0; i < 4; i++) {
      expect(() => svc.verify('13800000000', '000000')).toThrowError(/验证码错误/);
    }
    // 第 5 次错误：码被作废
    expect(() => svc.verify('13800000000', '000000')).toThrowError(/验证码错误/);
    expect(() => svc.verify('13800000000', code)).toThrowError(/验证码已过期/);
  });

  it('有效期 5 分钟：4分59秒可用，5分钟后报过期', () => {
    const { code } = svc.issue('13800000000');
    vi.advanceTimersByTime(4 * 60_000 + 59_000);
    expect(() => svc.verify('13800000000', code)).not.toThrow();

    const { code: code2 } = svc.issue('13900000000');
    vi.advanceTimersByTime(5 * 60_000 + 1_000);
    expect(() => svc.verify('13900000000', code2)).toThrowError(/验证码已过期/);
  });
});
