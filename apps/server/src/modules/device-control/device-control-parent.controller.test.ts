import { describe, it, expect, vi } from 'vitest';
import { DeviceControlParentController } from './device-control-parent.controller.js';
import type { ParentService } from '../parent/parent.service.js';
import type { DeviceCommandsService } from './device-commands.service.js';

const USER = { sub: 5, role: 'parent' as const };

const mkController = (requireOwned: ReturnType<typeof vi.fn> = vi.fn().mockResolvedValue(undefined)) => {
  const parentService = { requireOwnedStudent: requireOwned } as unknown as ParentService;
  const commands = {
    issue: vi.fn().mockResolvedValue({
      id: 3,
      command: 'unlock',
      status: 'pending',
      learningSessionId: 7,
      createdAt: '2026-09-23T01:10:00.000Z',
    }),
  } as unknown as DeviceCommandsService;
  return { controller: new DeviceControlParentController(parentService, commands), commands, requireOwned };
};

describe('DeviceControlParentController.issue（spec §5.4）', () => {
  it('归属校验先于下发（用 JWT 的 parentId，不是 body 里的）', async () => {
    const order: string[] = [];
    const { controller, commands } = mkController(
      vi.fn().mockImplementation(async () => {
        order.push('ownership');
      }),
    );
    (commands.issue as any).mockImplementation(async () => {
      order.push('issue');
      return { id: 3, command: 'unlock', status: 'pending', learningSessionId: 7, createdAt: 'x' };
    });

    await controller.issue(USER, 9, { command: 'unlock' });

    expect(order).toEqual(['ownership', 'issue']);
    expect(commands.issue).toHaveBeenCalledWith(9, 5, 'unlock');
  });

  it('command 不在白名单 → 400/1001 且不下发；body 形状错同样 400', async () => {
    const { controller, commands } = mkController();

    await expect(controller.issue(USER, 9, { command: 'force_close' })).rejects.toMatchObject({
      status: 400,
      response: { code: 1001 },
    });
    await expect(controller.issue(USER, 9, {})).rejects.toMatchObject({ status: 400 });
    await expect(controller.issue(USER, 9, null)).rejects.toMatchObject({ status: 400 });

    expect(commands.issue).not.toHaveBeenCalled();
  });

  it('归属失败 → 不下发命令（不许越权操作别人家孩子）', async () => {
    const { controller, commands } = mkController(vi.fn().mockRejectedValue(new Error('1005')));

    await expect(controller.issue(USER, 9, { command: 'unlock' })).rejects.toThrow();

    expect(commands.issue).not.toHaveBeenCalled();
  });
});
