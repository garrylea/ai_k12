import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  clearAuth,
  getToken,
  isSessionValid,
} from './auth';

/**
 * utils/auth 与 authStorage 的接线回归（终审 Finding 1）。
 *
 * 「记住我」上线后，登录态可能只存在于 sessionStorage（默认不勾时）。
 * utils/auth 若仍直连 localStorage，会出现：登录成功 → 路由闸门 `isSessionValid()`
 * 读不到 sessionStorage 里的 token → 立即被踢回登录页。
 * 钉子：getToken/clearAuth 必须经 authStorage（sessionStorage 优先、localStorage 兜底），
 * 不允许直连任何一个 storage。
 */

const AUTH_KEYS = ['token', 'userId', 'username', 'userRole'] as const;

/** 与 routeTable.test.tsx 同款：exp 在未来的假 JWT，isSessionValid 解 payload 校 exp */
function validToken(): string {
  const payload = btoa(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 3600 }));
  return `header.${payload}.signature`;
}

function setSessionIn(storage: Storage) {
  storage.setItem('token', validToken());
  storage.setItem('userId', '9');
  storage.setItem('username', 'xiaoming');
  storage.setItem('userRole', 'student');
}

beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
});

afterEach(() => {
  localStorage.clear();
  sessionStorage.clear();
});

describe('getToken 经 authStorage 读写（sessionStorage 优先、localStorage 兜底）', () => {
  it('token 仅在 sessionStorage 时可读到（默认不勾「记住我」的登录态）', () => {
    sessionStorage.setItem('token', 'jwt-session-only');

    expect(getToken()).toBe('jwt-session-only');
  });

  it('token 仅在 localStorage 时兜底可读到（勾选「记住我」的登录态）', () => {
    localStorage.setItem('token', 'jwt-local-only');

    expect(getToken()).toBe('jwt-local-only');
  });

  it('两处都没有 → null', () => {
    expect(getToken()).toBeNull();
  });
});

describe('isSessionValid 对 sessionStorage 登录态成立', () => {
  it('sessionStorage 有未过期 token → true', () => {
    setSessionIn(sessionStorage);

    expect(isSessionValid()).toBe(true);
  });
});

describe('clearAuth 覆盖双 storage', () => {
  it('清掉 localStorage 登录态', () => {
    setSessionIn(localStorage);

    clearAuth();

    for (const key of AUTH_KEYS) {
      expect(localStorage.getItem(key)).toBeNull();
    }
  });

  it('清掉 sessionStorage 登录态（修复前只清 localStorage，此处必然红）', () => {
    setSessionIn(sessionStorage);

    clearAuth();

    for (const key of AUTH_KEYS) {
      expect(sessionStorage.getItem(key)).toBeNull();
    }
  });

  it('两处同时存在时一并清空，不留矛盾残留', () => {
    setSessionIn(localStorage);
    setSessionIn(sessionStorage);

    clearAuth();

    for (const key of AUTH_KEYS) {
      expect(localStorage.getItem(key)).toBeNull();
      expect(sessionStorage.getItem(key)).toBeNull();
    }
  });
});
