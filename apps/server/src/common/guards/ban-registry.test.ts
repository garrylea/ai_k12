import { describe, it, expect } from 'vitest';
import { BanRegistry } from './ban-registry';

describe('BanRegistry', () => {
  it('封禁/解封 parent 与 student 独立记账', () => {
    const r = new BanRegistry();
    r.banParent(2); r.banStudent(5);
    expect(r.isBanned('parent', 2)).toBe(true);
    expect(r.isBanned('student', 5)).toBe(true);
    expect(r.isBanned('parent', 3)).toBe(false);
    r.unbanParent(2);
    expect(r.isBanned('parent', 2)).toBe(false);
  });

  it('admin 角色永不封禁', () => {
    const r = new BanRegistry();
    expect(r.isBanned('admin', 1)).toBe(false);
  });
});
