import { describe, it, expect, vi } from 'vitest';
import { DeviceCommandsController } from './device-commands.controller.js';
import type { LearningSessionsService } from './learning-sessions.service.js';

const mkSvc = () =>
  ({
    poll: vi.fn().mockResolvedValue({ commands: [], lock: null }),
  } as unknown as LearningSessionsService);

const USER = { sub: 9, role: 'student' as const };

describe('DeviceCommandsController', () => {
  it('poll 用 JWT 里的 studentId，**不接受 query/body 传学生 id**', async () => {
    const svc = mkSvc();
    const out = await new DeviceCommandsController(svc).poll(USER);
    expect(svc.poll).toHaveBeenCalledWith(9);
    // 空结果是正常态（不是 404）：客户端据此判定「没有命令、没有进行中会话」
    expect(out).toEqual({ commands: [], lock: null });
  });
});
