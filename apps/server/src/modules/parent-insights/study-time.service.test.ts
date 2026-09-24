import { describe, it, expect, vi } from 'vitest';
import { StudyTimeService } from './study-time.service.js';
import type { ParentAnalyticsRepository } from '../../database/repositories/parent-analytics.repo.js';
import type { StudySessionsService } from '../analytics/study-sessions.service.js';

function makeRepo(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    getStudyTimeTotal: vi.fn().mockResolvedValue(3661),
    getStudyTimeByDay: vi.fn().mockResolvedValue([{ day: '2026-09-19', seconds: 600 }]),
    getStudyTimeByModule: vi.fn().mockResolvedValue([{ module: 'en_vocabulary', seconds: 600 }]),
    getStudyTimeBySubject: vi.fn().mockResolvedValue([{ subjectId: 1, seconds: 600 }]),
    getActiveDays: vi.fn().mockResolvedValue(3),
    ...overrides,
  } as unknown as ParentAnalyticsRepository;
}

const makeSessions = () =>
  ({ closeStale: vi.fn().mockResolvedValue({ closedCount: 0, hidden: [] }) } as unknown as StudySessionsService);

describe('StudyTimeService.getStudyTime', () => {
  it('组装窗口、总量、按天/模块/学科，并回显 source=sessions', async () => {
    const repo = makeRepo();
    const service = new StudyTimeService(repo, makeSessions());

    const out = await service.getStudyTime(9, '2026-09-13', '2026-09-19');
    expect(out).toEqual({
      totalSeconds: 3661,
      activeDays: 3,
      byDay: [{ date: '2026-09-19', seconds: 600 }],
      byModule: [{ module: 'en_vocabulary', seconds: 600 }],
      bySubject: [{ subjectId: 1, seconds: 600 }],
      source: 'sessions',
    });
    const [totalArgs] = (repo.getStudyTimeTotal as any).mock.calls[0];
    expect(totalArgs).toBe(9);
  });

  it('查询前先惰性收尾这个学生的孤儿会话（否则今日已用永远不更新）', async () => {
    const sessions = makeSessions();
    const service = new StudyTimeService(makeRepo(), sessions);
    await service.getStudyTime(9);
    expect(sessions.closeStale).toHaveBeenCalledWith(9);
  });

  it('收尾失败不阻断查询（埋点不得影响主链路）', async () => {
    const sessions = { closeStale: vi.fn().mockRejectedValue(new Error('db down')) } as unknown as StudySessionsService;
    const service = new StudyTimeService(makeRepo(), sessions);
    await expect(service.getStudyTime(9)).resolves.toMatchObject({ source: 'sessions' });
  });

  // getStudyTime 的 7 天窗口必须与 getTodayUsage 的单日窗口区分开
  it('getStudyTime 缺省用近 7 天窗口（168 小时），不是单日', async () => {
    const repo = makeRepo();
    const service = new StudyTimeService(repo, makeSessions());
    await service.getStudyTime(9);

    const [, from, toExclusive] = (repo.getStudyTimeTotal as any).mock.calls[0];
    expect((toExclusive.getTime() - from.getTime()) / 3_600_000).toBe(24 * 7);
  });
});

describe('StudyTimeService.getTodayUsage（spec §5.7：每日上限概念已废除）', () => {
  it('只回 date / activeSeconds / byModule —— 不再有 limitMinutes 与 exceeded', async () => {
    const service = new StudyTimeService(makeRepo(), makeSessions());
    const out = await service.getTodayUsage(9);
    expect(Object.keys(out).sort()).toEqual(['activeSeconds', 'byModule', 'date']);
    expect(out.activeSeconds).toBe(3661);
    expect(out.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(out.byModule).toEqual([{ module: 'en_vocabulary', seconds: 600 }]);
  });

  it('今日已用只取**单日**窗口（今天 00:00 → 次日 00:00），不是近 7 天', async () => {
    const repo = makeRepo();
    const service = new StudyTimeService(repo, makeSessions());
    await service.getTodayUsage(9);

    const [, from, toExclusive] = (repo.getStudyTimeTotal as any).mock.calls[0];
    expect(from.getHours()).toBe(0);
    expect(from.getMinutes()).toBe(0);
    expect(from.getSeconds()).toBe(0);
    expect((toExclusive.getTime() - from.getTime()) / 3_600_000).toBe(24);
  });
});
