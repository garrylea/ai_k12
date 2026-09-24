import { ConflictException, Inject, Injectable } from '@nestjs/common';
import { LearningSessionsRepository } from '../../database/repositories/learning-sessions.repo.js';
import { DeviceCommandsRepository } from '../../database/repositories/device-commands.repo.js';
import type { DeviceCommandName } from '../../database/repositories/device-commands.repo.js';
import type { IssuedCommandView } from './dto/device-control.dto.js';

/**
 * 家长下发命令（spec §5.4）。
 *
 * **没有进行中会话就 409**：否则一条命令会悬在那里，解锁掉**将来某次**锁定。
 * `pollAndConsume` 的 10 分钟惰性过期只是兜底，不该当主防线（spec §4.3）。
 */
@Injectable()
export class DeviceCommandsService {
  constructor(
    @Inject(LearningSessionsRepository) private readonly sessions: LearningSessionsRepository,
    @Inject(DeviceCommandsRepository) private readonly commands: DeviceCommandsRepository,
  ) {}

  async issue(
    studentId: number,
    parentId: number,
    command: DeviceCommandName,
  ): Promise<IssuedCommandView> {
    const open = await this.sessions.findOpen(studentId);
    if (!open) {
      throw new ConflictException({
        code: 1001,
        message: '当前没有进行中的学习会话',
      });
    }

    const created = await this.commands.insert({
      studentId,
      command,
      issuedByParentId: parentId,
    });

    return {
      id: created.id,
      command: created.command,
      status: 'pending',
      learningSessionId: open.id,
      createdAt: created.created_at.toISOString(),
    };
  }
}
