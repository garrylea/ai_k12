import { describe, it, expect, beforeEach } from 'vitest';
import {
  getAuthItem,
  getAuthToken,
  saveAuthSession,
  clearAuthSession,
} from './authStorage';

describe('authStorage', () => {
  beforeEach(() => {
    localStorage.clear();
    sessionStorage.clear();
  });

  it('getAuthItem：sessionStorage 优先于 localStorage', () => {
    localStorage.setItem('token', 'from-local');
    sessionStorage.setItem('token', 'from-session');
    expect(getAuthItem('token')).toBe('from-session');
  });

  it('getAuthItem：sessionStorage 没有时兜底读 localStorage', () => {
    localStorage.setItem('userId', '9');
    expect(getAuthItem('userId')).toBe('9');
  });

  it('getAuthItem：两边都没有返回 null', () => {
    expect(getAuthItem('userRole')).toBeNull();
  });

  it('getAuthToken 是 token 的快捷方式', () => {
    sessionStorage.setItem('token', 'jwt');
    expect(getAuthToken()).toBe('jwt');
  });

  it('saveAuthSession(remember=true) 写 localStorage，不写 sessionStorage', () => {
    saveAuthSession(
      { token: 'jwt', username: '小明', userId: '9', userRole: 'student' },
      true,
    );
    expect(localStorage.getItem('token')).toBe('jwt');
    expect(localStorage.getItem('username')).toBe('小明');
    expect(localStorage.getItem('userId')).toBe('9');
    expect(localStorage.getItem('userRole')).toBe('student');
    expect(sessionStorage.getItem('token')).toBeNull();
  });

  it('saveAuthSession(remember=false) 写 sessionStorage，不写 localStorage', () => {
    saveAuthSession(
      { token: 'jwt', username: '13800000000', userId: '1', userRole: 'parent' },
      false,
    );
    expect(sessionStorage.getItem('token')).toBe('jwt');
    expect(sessionStorage.getItem('userRole')).toBe('parent');
    expect(localStorage.getItem('token')).toBeNull();
  });

  it('saveAuthSession 前先清掉两个 storage 的旧鉴权键（避免两份矛盾数据）', () => {
    // 上一次「记住我」的残留
    localStorage.setItem('token', 'old-jwt');
    localStorage.setItem('userRole', 'student');
    localStorage.setItem('unrelated', 'keep-me'); // 非鉴权键不许被误删
    saveAuthSession(
      { token: 'new-jwt', username: 'x', userId: '2', userRole: 'parent' },
      false,
    );
    expect(localStorage.getItem('token')).toBeNull();
    expect(localStorage.getItem('userRole')).toBeNull();
    expect(localStorage.getItem('unrelated')).toBe('keep-me');
    expect(sessionStorage.getItem('token')).toBe('new-jwt');
  });

  it('clearAuthSession 把 4 个键从两个 storage 都删掉', () => {
    localStorage.setItem('token', 'a');
    localStorage.setItem('userId', '1');
    localStorage.setItem('username', 'x');
    localStorage.setItem('userRole', 'student');
    sessionStorage.setItem('token', 'b');
    sessionStorage.setItem('userRole', 'parent');
    clearAuthSession();
    for (const key of ['token', 'userId', 'username', 'userRole']) {
      expect(localStorage.getItem(key)).toBeNull();
      expect(sessionStorage.getItem(key)).toBeNull();
    }
  });
});
