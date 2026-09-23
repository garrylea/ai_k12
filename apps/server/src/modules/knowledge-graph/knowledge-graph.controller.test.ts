import { describe, it, expect, vi } from 'vitest';
import { KnowledgeGraphController } from './knowledge-graph.controller.js';

/** 造一个只关心入参/归属校验的 controller：service 全 mock。 */
function makeCtrl() {
  const service = { getMastery: vi.fn(), getWeakPoints: vi.fn() };
  return { ctrl: new KnowledgeGraphController(service as any), service };
}

const user = { sub: 7 } as any;

describe('KnowledgeGraphController 归属校验', () => {
  it('studentId 非本人 → 403 + code 1005（不是默认的 1003）', async () => {
    const { ctrl, service } = makeCtrl();

    await expect(ctrl.getMastery(9, user, 1)).rejects.toMatchObject({
      response: { code: 1005, message: '无权访问该资源' },
      status: 403,
    });
    expect(service.getMastery).not.toHaveBeenCalled();
  });

  it('weak-points 同样拦非本人', async () => {
    const { ctrl, service } = makeCtrl();

    await expect(ctrl.getWeakPoints(9, user, 1, undefined)).rejects.toMatchObject({
      response: { code: 1005 },
      status: 403,
    });
    expect(service.getWeakPoints).not.toHaveBeenCalled();
  });
});

describe('KnowledgeGraphController subjectId 校验', () => {
  it('subjectId 非 1 → 400 + code 1001', async () => {
    const { ctrl, service } = makeCtrl();

    await expect(ctrl.getMastery(7, user, 2)).rejects.toMatchObject({
      response: { code: 1001 },
      status: 400,
    });
    expect(service.getMastery).not.toHaveBeenCalled();
  });

  it('weak-points 的 subjectId 非 1 → 400 + code 1001', async () => {
    const { ctrl, service } = makeCtrl();

    await expect(ctrl.getWeakPoints(7, user, 3, undefined)).rejects.toMatchObject({
      response: { code: 1001 },
      status: 400,
    });
  });
});

describe('KnowledgeGraphController limit 校验', () => {
  it('缺省 → 1；空串 → 1', async () => {
    const { ctrl, service } = makeCtrl();
    service.getWeakPoints.mockResolvedValue({});

    await ctrl.getWeakPoints(7, user, 1, undefined);
    await ctrl.getWeakPoints(7, user, 1, '');

    expect(service.getWeakPoints).toHaveBeenNthCalledWith(1, 7, 1, 1);
    expect(service.getWeakPoints).toHaveBeenNthCalledWith(2, 7, 1, 1);
  });

  it('非整数 / 0 / 11 / 负数 → 400 + code 1001', async () => {
    const { ctrl, service } = makeCtrl();

    for (const bad of ['abc', '0', '11', '-1', '1.5']) {
      await expect(ctrl.getWeakPoints(7, user, 1, bad)).rejects.toMatchObject({
        response: { code: 1001 },
        status: 400,
      });
    }
    expect(service.getWeakPoints).not.toHaveBeenCalled();
  });

  it('合法 limit 透传（含上界 10）', async () => {
    const { ctrl, service } = makeCtrl();
    service.getWeakPoints.mockResolvedValue({});

    await ctrl.getWeakPoints(7, user, 1, '10');

    expect(service.getWeakPoints).toHaveBeenCalledWith(7, 1, 10);
  });
});

describe('KnowledgeGraphController 透传', () => {
  it('mastery 合法入参：studentId 取 URL 段、subjectId 透传', async () => {
    const { ctrl, service } = makeCtrl();
    service.getMastery.mockResolvedValue({ subjectId: 1, nodes: [], coverage: {} });

    await expect(ctrl.getMastery(7, user, 1)).resolves.toEqual({
      subjectId: 1, nodes: [], coverage: {},
    });
    expect(service.getMastery).toHaveBeenCalledWith(7, 1);
  });
});
