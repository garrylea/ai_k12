import { describe, it, expect, vi } from 'vitest';
import { Logger } from '@nestjs/common';
import { AlertsService } from './alerts.service.js';
import type { StudentsRepository } from '../../database/repositories/students.repo.js';
import type { StudySessionsService } from '../analytics/study-sessions.service.js';
import type { SafetyAlertsRepository } from '../../database/repositories/safety-alerts.repo.js';

const mkRow = (over: Record<string, unknown> = {}) => ({
  id: 12,
  parent_id: 3,
  student_id: 11,
  dialogue_id: 88,
  message_id: null,
  type: 'off_topic',
  level: 'warning',
  message: '检测到孩子在学习中发起了与学习无关的闲聊',
  context: '你喜欢什么游戏？',
  is_read: 0,
  read_at: null,
  created_at: new Date('2026-09-20T10:00:00.000Z'),
  student_name: '小明',
  ...over,
});

const mkRepo = () => ({
  listByParent: vi.fn().mockResolvedValue({ items: [], total: 0 }),
  findById: vi.fn().mockResolvedValue(null),
  markRead: vi.fn().mockResolvedValue(undefined),
});

const mkSvc = (repo: ReturnType<typeof mkRepo>) =>
  new AlertsService(
    repo as never,
    { closeStale: vi.fn().mockResolvedValue(0) } as never,
    { findByParentId: vi.fn().mockResolvedValue([]) } as never,
  );

describe('AlertsService.list（spec §4.3）', () => {
  it('行 → DTO：列名转驼峰、is_read 转 boolean、student_name 可空；不泄漏 message_id/read_at/parent_id', async () => {
    const repo = mkRepo();
    repo.listByParent.mockResolvedValue({
      items: [mkRow(), mkRow({ id: 13, is_read: 1, student_name: null, type: 'away', level: 'info' })],
      total: 2,
    });

    const out = await mkSvc(repo).list(3, { page: 1, pageSize: 20 });

    expect(out.items[0]).toEqual({
      id: 12,
      studentId: 11,
      studentName: '小明',
      type: 'off_topic',
      level: 'warning',
      message: '检测到孩子在学习中发起了与学习无关的闲聊',
      context: '你喜欢什么游戏？',
      dialogueId: 88,
      isRead: false,
      createdAt: new Date('2026-09-20T10:00:00.000Z'),
    });
    // 键集合精确相等：多带 parent_id / message_id / read_at 都要红
    expect(Object.keys(out.items[0]).sort()).toEqual([
      'context',
      'createdAt',
      'dialogueId',
      'id',
      'isRead',
      'level',
      'message',
      'studentId',
      'studentName',
      'type',
    ]);
    // 已读行的两个信号都变：isRead=true、取不到名字不报错
    expect(out.items[1].isRead).toBe(true);
    expect(out.items[1].studentName).toBeNull();
  });

  it('分页：offset = (page-1)*pageSize，limit = pageSize，筛选原样下传', async () => {
    const repo = mkRepo();

    await mkSvc(repo).list(3, { studentId: 11, unreadOnly: true, page: 3, pageSize: 20 });

    // offset 40（不是 60）：公式写错会红
    expect(repo.listByParent).toHaveBeenCalledWith(3, { studentId: 11, unreadOnly: true }, 20, 40);
  });

  it('第 2 页 offset 递增（不写死 0）', async () => {
    const repo = mkRepo();

    await mkSvc(repo).list(3, { page: 2, pageSize: 5 });

    expect(repo.listByParent).toHaveBeenCalledWith(3, { studentId: undefined, unreadOnly: undefined }, 5, 5);
  });

  it('空结果是正常态：items: []、total: 0，回显 page/pageSize', async () => {
    const repo = mkRepo();
    repo.listByParent.mockResolvedValue({ items: [], total: 0 });

    const out = await mkSvc(repo).list(3, { page: 1, pageSize: 20 });

    expect(out).toEqual({ items: [], total: 0, page: 1, pageSize: 20 });
  });
});

describe('AlertsService.markRead（spec §4.4）', () => {
  it.each(['abc', '0', '-1', '1.5', '', '12abc'])(
    'alertId = %j 非正整数 → 409/1001，且**不查库**',
    async (raw) => {
      const repo = mkRepo();

      await expect(mkSvc(repo).markRead(3, raw)).rejects.toMatchObject({
        status: 409,
        response: { code: 1001 },
      });

      expect(repo.findById).not.toHaveBeenCalled();
      expect(repo.markRead).not.toHaveBeenCalled();
    },
  );

  it('预警不存在 → 404/1002，且不改库', async () => {
    const repo = mkRepo();
    repo.findById.mockResolvedValue(null);

    await expect(mkSvc(repo).markRead(3, 404)).rejects.toMatchObject({
      status: 404,
      response: { code: 1002 },
    });

    expect(repo.markRead).not.toHaveBeenCalled();
  });

  it('不是本家长的预警 → 403/1005，且**真的没调 markRead**（不泄漏存在性）', async () => {
    const repo = mkRepo();
    repo.findById.mockResolvedValue(mkRow({ parent_id: 999 }));

    await expect(mkSvc(repo).markRead(3, 12)).rejects.toMatchObject({
      status: 403,
      response: { code: 1005 },
    });

    // 关键：不能只看返回值——必须断言写库方法没被调用
    expect(repo.markRead).not.toHaveBeenCalled();
  });

  it('本人且存在 → 调 markRead(alertId)', async () => {
    const repo = mkRepo();
    repo.findById.mockResolvedValue(mkRow({ parent_id: 3 }));

    await mkSvc(repo).markRead(3, 12);

    expect(repo.markRead).toHaveBeenCalledWith(12);
  });

  it('幂等：已读的再标记一次不报错，仍调 markRead', async () => {
    const repo = mkRepo();
    repo.findById.mockResolvedValue(mkRow({ parent_id: 3, is_read: 1, read_at: new Date() }));

    await expect(mkSvc(repo).markRead(3, 12)).resolves.toBeUndefined();

    expect(repo.markRead).toHaveBeenCalledWith(12);
  });
});

describe('AlertsService.unread（轮询端点 + 补判）', () => {
  function makeUnreadDeps() {
    const alertsRepo = {
      listByParent: vi.fn().mockResolvedValue({
        items: [
          {
            id: 26, student_id: 7, student_name: '小刚', type: 'idle', level: 'info',
            message: '孩子在学习页面 5 分钟无操作', context: '无操作 5 分钟',
            dialogue_id: null, is_read: 0, created_at: new Date('2026-09-20T19:26:27Z'),
          },
        ],
        total: 1,
      }),
    } as unknown as SafetyAlertsRepository;
    const sessions = { closeStale: vi.fn().mockResolvedValue(1) } as unknown as StudySessionsService;
    const studentsRepo = {
      findByParentId: vi.fn().mockResolvedValue([{ id: 7 }, { id: 8 }]),
    } as unknown as StudentsRepository;
    return { alertsRepo, sessions, studentsRepo };
  }

  it('先补判（名下每个孩子各一次 closeStale）再查未读；items 只带展示字段', async () => {
    const { alertsRepo, sessions, studentsRepo } = makeUnreadDeps();
    const service = new AlertsService(alertsRepo, sessions, studentsRepo);

    const result = await service.unread(4);

    expect(sessions.closeStale).toHaveBeenCalledTimes(2);
    expect(sessions.closeStale).toHaveBeenCalledWith(7);
    expect(sessions.closeStale).toHaveBeenCalledWith(8);
    expect(alertsRepo.listByParent).toHaveBeenCalledWith(4, { unreadOnly: true }, 5, 0);
    expect(result).toEqual({
      items: [
        {
          id: 26, type: 'idle', level: 'info',
          message: '孩子在学习页面 5 分钟无操作',
          studentName: '小刚', createdAt: new Date('2026-09-20T19:26:27Z'),
        },
      ],
      total: 1,
    });
  });

  it('补判失败只 warn、不 500，仍返回未读列表', async () => {
    const { alertsRepo, studentsRepo } = makeUnreadDeps();
    const sessions = { closeStale: vi.fn().mockRejectedValue(new Error('db down')) } as unknown as StudySessionsService;
    const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const service = new AlertsService(alertsRepo, sessions, studentsRepo);

    try {
      const result = await service.unread(4);
      expect(result.total).toBe(1);
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('补判失败'));
    } finally {
      warn.mockRestore();
    }
  });

  it('家长名下无孩子 → 不补判、listByParent 仍返回空', async () => {
    const alertsRepo = {
      listByParent: vi.fn().mockResolvedValue({ items: [], total: 0 }),
    } as unknown as SafetyAlertsRepository;
    const sessions = { closeStale: vi.fn().mockResolvedValue(1) } as unknown as StudySessionsService;
    const studentsRepo = {
      findByParentId: vi.fn().mockResolvedValue([]),
    } as unknown as StudentsRepository;
    const service = new AlertsService(alertsRepo, sessions, studentsRepo);

    const result = await service.unread(4);

    expect(studentsRepo.findByParentId).toHaveBeenCalledWith(4);
    expect(sessions.closeStale).not.toHaveBeenCalled();
    expect(alertsRepo.listByParent).toHaveBeenCalledWith(4, { unreadOnly: true }, 5, 0);
    expect(result).toEqual({ items: [], total: 0 });
  });
});
