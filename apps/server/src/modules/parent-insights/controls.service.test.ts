import { describe, it, expect, vi } from 'vitest';
import { ControlsService } from './controls.service.js';

/**
 * `findByStudent` 会多读两列（兑换汇率/开关）。两个阈值**刻意取不同值**，
 * 这样「列与字段张冠李戴」（把 away 读成 idle）会红。
 */
const SNAPSHOT = {
  pointsPerYuan: 20,
  rewardRedemptionEnabled: true,
  alertAwayMinutes: 3,
  alertIdleMinutes: 22,
};

const mkRepo = () => ({
  ensure: vi.fn().mockResolvedValue(undefined),
  update: vi.fn().mockResolvedValue(1),
  findByStudent: vi.fn().mockResolvedValue(SNAPSHOT),
});

const mkSvc = (repo: ReturnType<typeof mkRepo>) => new ControlsService(repo as never);

describe('ControlsService.get（spec §4.1）', () => {
  it('先 ensure 再回读；只回两个阈值（不把兑换汇率/开关带出去）', async () => {
    const repo = mkRepo();

    const out = await mkSvc(repo).get(11);

    expect(repo.ensure).toHaveBeenCalledWith(11);
    expect(repo.findByStudent).toHaveBeenCalledWith(11);
    // 先建行再读：无行时 ensure 保证两个阈值是 NOT NULL 默认值
    expect(repo.ensure.mock.invocationCallOrder[0]).toBeLessThan(
      repo.findByStudent.mock.invocationCallOrder[0],
    );
    // 防「顺手多返回」：键集合必须恰好是这两个
    expect(Object.keys(out).sort()).toEqual(['alertAwayMinutes', 'alertIdleMinutes']);
    expect(out).toEqual({ alertAwayMinutes: 3, alertIdleMinutes: 22 });
  });
});

describe('ControlsService.update（spec §4.2）', () => {
  it('空 patch → 409/1001，且**不 ensure、不写库**', async () => {
    const repo = mkRepo();

    await expect(mkSvc(repo).update(11, {})).rejects.toMatchObject({
      status: 409,
      response: { code: 1001 },
    });

    expect(repo.update).not.toHaveBeenCalled();
    expect(repo.ensure).not.toHaveBeenCalled();
  });

  it.each([0, 181, -1, 1.5, Number.NaN])(
    '越界/非整数 %s → 409/1001，且**不写库**',
    async (value) => {
      const repo = mkRepo();

      await expect(mkSvc(repo).update(11, { alertAwayMinutes: value })).rejects.toMatchObject({
        status: 409,
        response: { code: 1001 },
      });
      // 两个字段任一越界都拦下；这里只传了一个
      await expect(mkSvc(repo).update(11, { alertIdleMinutes: value })).rejects.toMatchObject({
        status: 409,
        response: { code: 1001 },
      });

      expect(repo.update).not.toHaveBeenCalled();
    },
  );

  it('边界 1 与 180 都合法（闭区间，不是开区间）', async () => {
    const repo = mkRepo();

    await mkSvc(repo).update(11, { alertAwayMinutes: 1, alertIdleMinutes: 180 });

    expect(repo.update).toHaveBeenCalledWith(11, { alertAwayMinutes: 1, alertIdleMinutes: 180 });
  });

  it('合法 → ensure → update → 回读；返回的是**库里的值**而不是入参回声', async () => {
    const repo = mkRepo();
    // 回读值与入参刻意不同：回声入参 / 跳过回读 都会红
    repo.findByStudent.mockResolvedValue({ ...SNAPSHOT, alertAwayMinutes: 7, alertIdleMinutes: 30 });

    const out = await mkSvc(repo).update(11, { alertAwayMinutes: 2, alertIdleMinutes: 9 });

    expect(repo.update).toHaveBeenCalledWith(11, { alertAwayMinutes: 2, alertIdleMinutes: 9 });
    expect(repo.ensure.mock.invocationCallOrder[0]).toBeLessThan(
      repo.update.mock.invocationCallOrder[0],
    );
    expect(repo.update.mock.invocationCallOrder[0]).toBeLessThan(
      repo.findByStudent.mock.invocationCallOrder[0],
    );
    expect(out).toEqual({ alertAwayMinutes: 7, alertIdleMinutes: 30 });
    expect(Object.keys(out).sort()).toEqual(['alertAwayMinutes', 'alertIdleMinutes']);
  });

  it('只传一个字段时，另一个不写进 patch（不做「未传=清空」）', async () => {
    const repo = mkRepo();

    await mkSvc(repo).update(11, { alertIdleMinutes: 25 });

    expect(repo.update).toHaveBeenCalledWith(11, { alertIdleMinutes: 25 });
  });
});
