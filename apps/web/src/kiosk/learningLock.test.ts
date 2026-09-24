import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  LEARNING_SESSION_STORAGE_KEY,
  clearPersistedSession,
  formatRemaining,
  isCurrentStudentLocked,
  isLocked,
  readPersistedSession,
  remainingMs,
  writePersistedSession,
} from './learningLock';

const T0 = Date.parse('2026-09-23T01:00:00.000Z');
const LATER = '2026-09-23T02:00:00.000Z';

beforeEach(() => localStorage.clear());
afterEach(() => localStorage.clear());

describe('isLocked', () => {
  it('未设锁（lockExpiresAt=null）→ 不锁', () => {
    expect(isLocked({ lockExpiresAt: null, unlockedAt: null }, T0)).toBe(false);
  });

  it('无会话（null）→ 不锁', () => {
    expect(isLocked(null, T0)).toBe(false);
  });

  it('截止时间在将来 → 锁', () => {
    expect(isLocked({ lockExpiresAt: LATER, unlockedAt: null }, T0)).toBe(true);
  });

  it('截止时间**恰好等于** now → 不锁（到期即解除，边界取开区间）', () => {
    expect(isLocked({ lockExpiresAt: LATER, unlockedAt: null }, Date.parse(LATER))).toBe(false);
  });

  it('截止时间已过 → 不锁（自动解除）', () => {
    expect(isLocked({ lockExpiresAt: LATER, unlockedAt: null }, Date.parse(LATER) + 1)).toBe(false);
  });

  it('家长已解除（unlockedAt 非空）→ 不锁，**哪怕截止时间还没到**', () => {
    expect(
      isLocked({ lockExpiresAt: LATER, unlockedAt: '2026-09-23T01:20:00.000Z' }, T0),
    ).toBe(false);
  });

  it('截止时间是不可解析的字符串 → 不锁（不抛错，宁可放行也不锁死）', () => {
    expect(isLocked({ lockExpiresAt: 'not-a-date', unlockedAt: null }, T0)).toBe(false);
  });
});

describe('持久化与跨学生隔离', () => {
  it('写入后能读回', () => {
    writePersistedSession({ studentId: 9, id: 7, lockExpiresAt: LATER, unlockedAt: null });
    expect(readPersistedSession(9)).toEqual({
      studentId: 9,
      id: 7,
      lockExpiresAt: LATER,
      unlockedAt: null,
    });
  });

  it('**studentId 不符 → 返回 null**（同一台设备换学生登录时，不许沿用上一个人的锁定）', () => {
    writePersistedSession({ studentId: 9, id: 7, lockExpiresAt: LATER, unlockedAt: null });
    expect(readPersistedSession(42)).toBeNull();
  });

  it('不传 studentId 时不做归属校验', () => {
    writePersistedSession({ studentId: 9, id: 7, lockExpiresAt: LATER, unlockedAt: null });
    expect(readPersistedSession()?.id).toBe(7);
  });

  it('内容损坏 → 返回 null，不抛错', () => {
    localStorage.setItem(LEARNING_SESSION_STORAGE_KEY, '{ 坏掉的 json');
    expect(readPersistedSession(9)).toBeNull();
  });

  it('形状不对（缺 id）→ 返回 null', () => {
    localStorage.setItem(LEARNING_SESSION_STORAGE_KEY, JSON.stringify({ studentId: 9 }));
    expect(readPersistedSession(9)).toBeNull();
  });

  it('clear 之后读不到', () => {
    writePersistedSession({ studentId: 9, id: 7, lockExpiresAt: LATER, unlockedAt: null });
    clearPersistedSession();
    expect(readPersistedSession(9)).toBeNull();
  });
});

describe('isCurrentStudentLocked', () => {
  it('userId 与持久化会话一致且在锁定期内 → true', () => {
    localStorage.setItem('userId', '9');
    writePersistedSession({ studentId: 9, id: 7, lockExpiresAt: LATER, unlockedAt: null });
    expect(isCurrentStudentLocked(T0)).toBe(true);
  });

  it('userId 是别的学生 → false', () => {
    localStorage.setItem('userId', '42');
    writePersistedSession({ studentId: 9, id: 7, lockExpiresAt: LATER, unlockedAt: null });
    expect(isCurrentStudentLocked(T0)).toBe(false);
  });

  it('没有 userId（未登录）→ false', () => {
    writePersistedSession({ studentId: 9, id: 7, lockExpiresAt: LATER, unlockedAt: null });
    expect(isCurrentStudentLocked(T0)).toBe(false);
  });
});

describe('remainingMs / formatRemaining', () => {
  it('remainingMs = 截止 - now', () => {
    expect(remainingMs(LATER, T0)).toBe(3_600_000);
  });

  it('已过期 → 负数（调用方负责判断）', () => {
    expect(remainingMs(LATER, Date.parse(LATER) + 5_000)).toBe(-5_000);
  });

  it.each([
    [3_600_000, '剩余 60 分钟'],
    [2_700_000, '剩余 45 分钟'],
    [60_000, '剩余 1 分钟'],
    [90_000, '剩余 2 分钟'], // 向上取整：1.5 分钟不该显示成 1 分钟（会让人以为马上能走）
    [30_000, '剩余不足 1 分钟'],
    [0, '剩余不足 1 分钟'],
  ])('formatRemaining(%s) → %s', (ms, text) => {
    expect(formatRemaining(ms)).toBe(text);
  });
});
