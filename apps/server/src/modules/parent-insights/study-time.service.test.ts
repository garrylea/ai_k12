import { describe, it, expect, vi } from 'vitest';
import { StudyTimeService } from './study-time.service.js';
import type { ParentAnalyticsRepository } from '../../database/repositories/parent-analytics.repo.js';
import type { ControlsRepository } from '../../database/repositories/controls.repo.js';
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

const makeControls = (limit: number | null) =>
  ({ findDailyTimeLimit: vi.fn().mockResolvedValue(limit) } as unknown as ControlsRepository);

const makeSessions = () => ({ closeStale: vi.fn().mockResolvedValue(0) } as unknown as StudySessionsService);

describe('StudyTimeService.getStudyTime', () => {
  it('组装窗口、总量、按天/模块/学科，并回显 source=sessions', async () => {
    const repo = makeRepo();
    const service = new StudyTimeService(repo, makeControls(null), makeSessions());

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
    const service = new StudyTimeService(makeRepo(), makeControls(null), sessions);
    await service.getStudyTime(9);
    expect(sessions.closeStale).toHaveBeenCalledWith(9);
  });

  it('收尾失败不阻断查询（埋点不得影响主链路）', async () => {
    const sessions = { closeStale: vi.fn().mockRejectedValue(new Error('db down')) } as unknown as StudySessionsService;
    const service = new StudyTimeService(makeRepo(), makeControls(null), sessions);
    await expect(service.getStudyTime(9)).resolves.toBeTruthy();
  });
});

describe('StudyTimeService.getTodayUsage', () => {
  it('未设上限 → limitMinutes:null、exceeded:false', async () => {
    const service = new StudyTimeService(makeRepo(), makeControls(null), makeSessions());
    const out = await service.getTodayUsage(9);
    expect(out.limitMinutes).toBeNull();
    expect(out.exceeded).toBe(false);
    expect(out.activeSeconds).toBe(3661);
    expect(out.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(out.byModule).toEqual([{ module: 'en_vocabulary', seconds: 600 }]);
  });

  it('达到上限即 exceeded（用满就该停，不是严格大于）', async () => {
    const repo = makeRepo({ getStudyTimeTotal: vi.fn().mockResolvedValue(30 * 60) });
    const service = new StudyTimeService(repo, makeControls(30), makeSessions());
    const out = await service.getTodayUsage(9);
    expect(out.exceeded).toBe(true);
  });

  it('未达上限 → exceeded:false', async () => {
    const repo = makeRepo({ getStudyTimeTotal: vi.fn().mockResolvedValue(29 * 60) });
    const service = new StudyTimeService(repo, makeControls(30), makeSessions());
    expect((await service.getTodayUsage(9)).exceeded).toBe(false);
  });
});
