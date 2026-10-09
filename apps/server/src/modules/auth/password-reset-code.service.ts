import { Injectable, HttpException, HttpStatus, UnauthorizedException } from '@nestjs/common';

/** 验证码有效期：5 分钟。 */
const CODE_TTL_MS = 5 * 60_000;
/** 同手机号重发间隔：60 秒。 */
const RESEND_INTERVAL_MS = 60_000;
/** 累计错误次数上限：达到即作废（须重新获取）。 */
const MAX_ATTEMPTS = 5;

interface CodeEntry {
  code: string;
  expiresAt: number;
  attempts: number;
  lastSentAt: number;
}

/**
 * 忘记密码的模拟验证码服务：验证码存进程内存（spec 裁决：不建表、不写迁移）。
 * 服务重启后内存清空，未完成的找回流程表现为「验证码已过期」，重新获取即可。
 * 将来接真实短信时只替换「发送」环节（issue 的返回/通知方式），存储与校验不变。
 */
@Injectable()
export class PasswordResetCodeService {
  private entries = new Map<string, CodeEntry>();

  /** 生成并存储验证码。同手机号 60s 内重复请求抛 429/1008。 */
  issue(phone: string): { code: string; expiresIn: number } {
    const now = Date.now();
    const existing = this.entries.get(phone);
    if (existing && now - existing.lastSentAt < RESEND_INTERVAL_MS) {
      throw new HttpException(
        { code: 1008, message: '请求过于频繁，请稍后再试' },
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }
    const code = String(Math.floor(100_000 + Math.random() * 900_000));
    this.entries.set(phone, {
      code,
      expiresAt: now + CODE_TTL_MS,
      attempts: 0,
      lastSentAt: now,
    });
    return { code, expiresIn: CODE_TTL_MS / 1000 };
  }

  /**
   * 校验验证码：通过即消费（删除）；不匹配计次，累计错 MAX_ATTEMPTS 次作废；
   * 不存在或已过期按「已过期」报（不区分，避免泄漏码的存在性）。
   */
  verify(phone: string, code: string): void {
    const entry = this.entries.get(phone);
    if (!entry || Date.now() >= entry.expiresAt) {
      this.entries.delete(phone);
      throw new UnauthorizedException({ code: 1003, message: '验证码已过期，请重新获取' });
    }
    if (entry.code !== code) {
      entry.attempts += 1;
      if (entry.attempts >= MAX_ATTEMPTS) {
        this.entries.delete(phone);
      }
      throw new UnauthorizedException({ code: 1003, message: '验证码错误' });
    }
    this.entries.delete(phone);
  }
}
