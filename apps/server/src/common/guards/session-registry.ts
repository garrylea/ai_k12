import { Injectable } from '@nestjs/common';

type Role = 'admin' | 'parent' | 'student';

/**
 * 进程内「当前有效会话序号」注册表（仿 BanRegistry 模式，2026-10-10 单点登录互踢）：
 * AuthService 登录成功时 bump（seq 与 auth_sessions 表同点写入），AuthMiddleware
 * O(1) 比对 JWT 携带的 seq；启动时经 CommonModule.onModuleInit 从表全量重建。
 *
 * 单进程假设（家庭自部署单机，spec §4）：多实例部署需换共享存储，本期明确不做。
 * 注册表无该账号行 → matches 恒 false（宁踢勿放：内存/DB 失配时旧 token 一律重登）。
 */
@Injectable()
export class SessionRegistry {
  private seqs = new Map<string, number>();

  private key(role: Role, id: number): string {
    return `${role}:${id}`;
  }

  /**
   * 单调写入（2026-10-10 终审）：仅当 incoming seq > 当前值（或 key 不存在）才写。
   * 同账号并发登录时即便 DB 层之外仍有迟到/乱序的 bump 到达，注册表也只会保留
   * 最大 seq——胜者恒为最新登录，旧 token 必然失配被踢。
   */
  bump(role: Role, id: number, seq: number): void {
    const key = this.key(role, id);
    const current = this.seqs.get(key);
    if (current !== undefined && seq <= current) return;
    this.seqs.set(key, seq);
  }

  matches(role: Role, id: number, seq: number | undefined): boolean {
    if (seq === undefined) return false;
    return this.seqs.get(this.key(role, id)) === seq;
  }

  load(rows: Array<{ role: Role; user_id: number; token_seq: number }>): void {
    this.seqs = new Map(rows.map((r) => [`${r.role}:${r.user_id}`, Number(r.token_seq)]));
  }
}
