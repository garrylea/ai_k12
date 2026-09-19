import { describe, it, expect, vi } from 'vitest';
import { ParentInsightsController } from './parent-insights.controller.js';
import type { ParentService } from '../parent/parent.service.js';
import type { StudyTimeService } from './study-time.service.js';

function makeController(requireOwnedStudent: ReturnType<typeof vi.fn>) {
  const parentService = { requireOwnedStudent } as unknown as ParentService;
  const studyTime = {
    getStudyTime: vi.fn().mockResolvedValue({ totalSeconds: 0 }),
    getTodayUsage: vi.fn().mockResolvedValue({ activeSeconds: 0 }),
  } as unknown as StudyTimeService;
  const controller = new ParentInsightsController(
    parentService,
    {} as never, // dashboardService
    {} as never, // reportService
    {} as never, // errorsService
    {} as never, // chatLogsService
    studyTime,
  );
  return { controller, studyTime };
}

const USER = { sub: 3, role: 'parent' as const };

describe('ParentInsightsController 学习时长端点', () => {
  it('study-time 先做归属校验，再取数', async () => {
    const order: string[] = [];
    const requireOwned = vi.fn().mockImplementation(async () => {
      order.push('ownership');
    });
    const { controller, studyTime } = makeController(requireOwned);
    (studyTime.getStudyTime as any).mockImplementation(async () => {
      order.push('query');
      return { totalSeconds: 0 };
    });

    await controller.getStudyTime(USER, 11, '2026-09-13', '2026-09-19');
    expect(order).toEqual(['ownership', 'query']);
    expect(requireOwned).toHaveBeenCalledWith(3, 11);
    expect(studyTime.getStudyTime).toHaveBeenCalledWith(11, '2026-09-13', '2026-09-19');
  });

  it('归属校验失败时**不取数**（1005 不许泄漏存在性）', async () => {
    const requireOwned = vi.fn().mockRejectedValue(new Error('1005'));
    const { controller, studyTime } = makeController(requireOwned);
    await expect(controller.getTodayUsage(USER, 11)).rejects.toThrow();
    expect(studyTime.getTodayUsage).not.toHaveBeenCalled();
  });
});
