import { describe, it, expect, vi } from 'vitest';
import { DeviceControlController } from './device-control.controller.js';
import type { LearningSessionsService } from './learning-sessions.service.js';

const mkSvc = () =>
  ({
    openOrGet: vi.fn().mockResolvedValue({
      id: 7,
      startedAt: '2026-09-23T01:00:00.000Z',
      lockMinutes: 60,
      lockExpiresAt: '2026-09-23T02:00:00.000Z',
      unlockedAt: null,
    }),
  } as unknown as LearningSessionsService);

const USER = { sub: 9, role: 'student' as const };

describe('DeviceControlController', () => {
  it('openOrGet 用 JWT 里的 studentId，**不接受 body 传学生 id**', async () => {
    const svc = mkSvc();
    const out = await new DeviceControlController(svc).openOrGet(USER);
    expect(svc.openOrGet).toHaveBeenCalledWith(9);
    expect(out.id).toBe(7);
  });

  it('end 透传 studentId 与数字化的 id', async () => {
    const svc = mkSvc();
    (svc as any).end = vi.fn().mockResolvedValue({ id: 7, endedAt: '2026-09-23T01:45:00.000Z' });
    const out = await new DeviceControlController(svc).end(USER, 7);
    expect((svc as any).end).toHaveBeenCalledWith(9, 7);
    expect(out.endedAt).toBe('2026-09-23T01:45:00.000Z');
  });
});
