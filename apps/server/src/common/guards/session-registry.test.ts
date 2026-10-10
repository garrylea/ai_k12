import { describe, it, expect } from 'vitest';
import { SessionRegistry } from './session-registry';

describe('SessionRegistry', () => {
  it('bump 后 matches(同 seq) 为 true，别的 seq 为 false', () => {
    const r = new SessionRegistry();
    r.bump('student', 7, 3);
    expect(r.matches('student', 7, 3)).toBe(true);
    expect(r.matches('student', 7, 2)).toBe(false);
  });

  it('注册表无该账号行 → matches 恒 false（宁踢勿放）', () => {
    const r = new SessionRegistry();
    expect(r.matches('parent', 3, 1)).toBe(false);
  });

  it('旧格式 token（seq undefined）→ false', () => {
    const r = new SessionRegistry();
    r.bump('parent', 3, 1);
    expect(r.matches('parent', 3, undefined)).toBe(false);
  });

  it('role 隔离：同 id 不同角色互不影响', () => {
    const r = new SessionRegistry();
    r.bump('student', 1, 5);
    r.bump('parent', 1, 2);
    expect(r.matches('student', 1, 5)).toBe(true);
    expect(r.matches('parent', 1, 2)).toBe(true);
    expect(r.matches('parent', 1, 5)).toBe(false);
  });

  it('load 整表重建（替换而非合并）', () => {
    const r = new SessionRegistry();
    r.bump('student', 7, 1);
    r.load([{ role: 'student', user_id: 7, token_seq: 4 }]);
    expect(r.matches('student', 7, 4)).toBe(true);
    expect(r.matches('student', 7, 1)).toBe(false);
  });
});
