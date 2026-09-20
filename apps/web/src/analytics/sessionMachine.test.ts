import { describe, it, expect } from 'vitest';
import { transition } from './sessionMachine';

const NO_FX = { start: false, end: null, heartbeat: null };

describe('sessionMachine.transition', () => {
  it('idle + ROUTE_ENTER → active，起会话并立刻发一次 visible 心跳（reason=null）', () => {
    expect(transition('idle', 'ROUTE_ENTER')).toEqual({
      state: 'active',
      effects: { start: true, end: null, heartbeat: { state: 'visible', reason: null } },
    });
  });

  it('active + IDLE_TIMEOUT → hidden，发 hidden 心跳且 reason=idle（暂停计时但不断会话）', () => {
    expect(transition('active', 'IDLE_TIMEOUT')).toEqual({
      state: 'hidden',
      effects: { start: false, end: null, heartbeat: { state: 'hidden', reason: 'idle' } },
    });
  });

  it('hidden + VISIBLE → active，恢复计时（reason=null）', () => {
    expect(transition('hidden', 'VISIBLE')).toEqual({
      state: 'active',
      effects: { start: false, end: null, heartbeat: { state: 'visible', reason: null } },
    });
  });

  it('active + HIDDEN → hidden，发 hidden 心跳且 reason=away（visibilitychange 切后台）', () => {
    expect(transition('active', 'HIDDEN')).toEqual({
      state: 'hidden',
      effects: { start: false, end: null, heartbeat: { state: 'hidden', reason: 'away' } },
    });
  });

  it('active + ROUTE_LEAVE → ended（reason=route_change）', () => {
    expect(transition('active', 'ROUTE_LEAVE')).toEqual({
      state: 'ended',
      effects: { start: false, end: 'route_change', heartbeat: null },
    });
  });

  it('hidden + ROUTE_LEAVE → ended（reason=route_change）', () => {
    expect(transition('hidden', 'ROUTE_LEAVE').effects.end).toBe('route_change');
  });

  it('active + PAGEHIDE → ended（reason=pagehide）', () => {
    expect(transition('active', 'PAGEHIDE')).toEqual({
      state: 'ended',
      effects: { start: false, end: 'pagehide', heartbeat: null },
    });
  });

  it('hidden + PAGEHIDE → ended（reason=pagehide）', () => {
    expect(transition('hidden', 'PAGEHIDE').effects.end).toBe('pagehide');
  });

  it('ended + ROUTE_ENTER → active：连续走两个学习场景不必回 idle', () => {
    expect(transition('ended', 'ROUTE_ENTER')).toEqual({
      state: 'active',
      effects: { start: true, end: null, heartbeat: { state: 'visible', reason: null } },
    });
  });

  it.each([
    ['idle', 'ROUTE_LEAVE'],
    ['idle', 'VISIBLE'],
    ['idle', 'HIDDEN'],
    ['idle', 'IDLE_TIMEOUT'],
    ['idle', 'PAGEHIDE'],
    ['ended', 'ROUTE_LEAVE'],
    ['ended', 'VISIBLE'],
    ['ended', 'HIDDEN'],
    ['ended', 'IDLE_TIMEOUT'],
    ['ended', 'PAGEHIDE'],
    ['hidden', 'HIDDEN'],
    ['hidden', 'IDLE_TIMEOUT'],
  ] as const)('幂等/忽略：%s + %s 不产生任何副作用', (state, event) => {
    expect(transition(state, event)).toEqual({ state, effects: NO_FX });
  });

  it('active + VISIBLE 是空操作（已经在前台，不该重复发心跳）', () => {
    expect(transition('active', 'VISIBLE')).toEqual({ state: 'active', effects: NO_FX });
  });
});
