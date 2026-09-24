import { describe, it, expect, vi } from 'vitest';
import { DeviceCommandsService } from './device-commands.service.js';
import type { LearningSessionsRepository } from '../../database/repositories/learning-sessions.repo.js';
import type { DeviceCommandsRepository } from '../../database/repositories/device-commands.repo.js';

const mkSessions = (open: unknown) =>
  ({ findOpen: vi.fn().mockResolvedValue(open) } as unknown as LearningSessionsRepository);

const mkCommands = () => ({
  insert: vi.fn().mockResolvedValue({
    id: 3,
    student_id: 9,
    command: 'unlock',
    status: 'pending',
    issued_by_parent_id: 5,
    created_at: new Date('2026-09-23T01:10:00.000Z'),
    consumed_at: null,
  }),
});

const mkSvc = (
  sessions: LearningSessionsRepository,
  commands: ReturnType<typeof mkCommands>,
) => new DeviceCommandsService(sessions, commands as unknown as DeviceCommandsRepository);

describe('DeviceCommandsService.issue（spec §5.4）', () => {
  it('**没有进行中会话 → 409/1001**，且不写任何命令', async () => {
    const commands = mkCommands();
    await expect(mkSvc(mkSessions(null), commands).issue(9, 5, 'unlock')).rejects.toMatchObject({
      status: 409,
      response: { code: 1001 },
    });
    expect(commands.insert).not.toHaveBeenCalled();
  });

  it('有进行中会话 → 插 pending 命令，并带上 learningSessionId', async () => {
    const commands = mkCommands();
    const out = await mkSvc(mkSessions({ id: 7 }), commands).issue(9, 5, 'unlock');

    expect(commands.insert).toHaveBeenCalledWith({
      studentId: 9,
      command: 'unlock',
      issuedByParentId: 5,
    });
    expect(out).toEqual({
      id: 3,
      command: 'unlock',
      status: 'pending',
      learningSessionId: 7,
      createdAt: '2026-09-23T01:10:00.000Z',
    });
  });
});
