import { describe, it, expect } from 'vitest';
import {
  LEVELS,
  levelOf,
  nextLevelOf,
  pointsToNextLevel,
  progressPercent,
  detectLevelUp,
} from './levels.js';

describe('LEVELS', () => {
  it('共 9 档，门槛严格递增', () => {
    expect(LEVELS).toHaveLength(9);
    for (let i = 1; i < LEVELS.length; i++) {
      expect(LEVELS[i].threshold).toBeGreaterThan(LEVELS[i - 1].threshold);
    }
  });
});

describe('levelOf', () => {
  it('0 分是劈柴', () => {
    expect(levelOf(0).code).toBe('pichai');
    expect(levelOf(0).name).toBe('劈柴');
  });

  it('499 分仍不到门槛，还是劈柴', () => {
    expect(levelOf(499).code).toBe('pichai');
  });

  it('500 分整升铸铁', () => {
    expect(levelOf(500).code).toBe('zhutie');
  });

  it('1199 分仍是铸铁', () => {
    expect(levelOf(1199).code).toBe('zhutie');
  });

  it('1200 分升青铜', () => {
    expect(levelOf(1200).code).toBe('qingtong');
  });

  it('19999 分是星耀', () => {
    expect(levelOf(19999).code).toBe('xingyao');
  });

  it('20000 分是王者', () => {
    expect(levelOf(20000).code).toBe('wangzhe');
  });

  it('999999 分封顶在王者', () => {
    expect(levelOf(999999).code).toBe('wangzhe');
  });

  it('负数按 0 处理（脏数据兜底）', () => {
    expect(levelOf(-100).code).toBe('pichai');
  });
});

describe('nextLevelOf', () => {
  it('20000 已满级（王者），没有下一档', () => {
    expect(nextLevelOf(20000)).toBeNull();
  });

  it('0 分的下一档是铸铁（门槛 500）', () => {
    const next = nextLevelOf(0);
    expect(next?.code).toBe('zhutie');
    expect(next?.threshold).toBe(500);
  });

  it('499 分的下一档仍是铸铁', () => {
    expect(nextLevelOf(499)?.code).toBe('zhutie');
  });
});

describe('pointsToNextLevel', () => {
  it('20000 已满级，没有「还差多少」', () => {
    expect(pointsToNextLevel(20000)).toBeNull();
  });

  it('0 分距铸铁还差 500', () => {
    expect(pointsToNextLevel(0)).toBe(500);
  });

  it('499 分距铸铁只差 1', () => {
    expect(pointsToNextLevel(499)).toBe(1);
  });

  it('12000 分距王者还差 8000', () => {
    expect(pointsToNextLevel(12000)).toBe(8000);
  });
});

describe('progressPercent', () => {
  it('满级（20000）直接 100，避免除零', () => {
    expect(progressPercent(20000)).toBe(100);
  });

  it('250 分在劈柴档（0→500）走了一半 → 50', () => {
    expect(progressPercent(250)).toBe(50);
  });

  it('0 分是 0', () => {
    expect(progressPercent(0)).toBe(0);
  });

  it('750 分在铸铁档（500→1200）走了 250/700 → 35（向下取整）', () => {
    expect(progressPercent(750)).toBe(35);
  });

  it('1199 分（差 1 分到青铜）不能报 100，必须是 99', () => {
    expect(progressPercent(1199)).toBe(99);
    expect(progressPercent(1199)).not.toBe(100);
  });

  it('19999 分（差 1 分到王者，span 8000）必须 < 100', () => {
    expect(progressPercent(19999)).toBeLessThan(100);
  });
});

describe('detectLevelUp', () => {
  it('490 → 510 跨档：劈柴升铸铁', () => {
    const up = detectLevelUp(490, 510);
    expect(up?.from.name).toBe('劈柴');
    expect(up?.to.name).toBe('铸铁');
  });

  it('500 → 510 未跨档返回 null', () => {
    expect(detectLevelUp(500, 510)).toBeNull();
  });

  it('499 → 500 恰好踩线也算跨档', () => {
    expect(detectLevelUp(499, 500)?.to.code).toBe('zhutie');
  });

  it('分数下降（510 → 490）不降级，返回 null', () => {
    expect(detectLevelUp(510, 490)).toBeNull();
  });
});
