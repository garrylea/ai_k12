import { describe, expect, it } from 'vitest';
import { resolveTrialDays } from './billing.config.js';

/**
 * 终审必修 3 回归钉：`SUBSCRIPTION_TRIAL_DAYS` 配空串时 `Number('')===0`，
 * 原实现会让全员注册即锁死（试用 0 天）。防御逻辑提为纯函数便于穷举。
 */
describe('resolveTrialDays（TRIAL_DAYS 防御）', () => {
  it.each([
    ['未配置（undefined）→ 默认 7', undefined, 7],
    ['空串 → 默认 7（Number("")===0 陷阱）', '', 7],
    ['负数 → 默认 7', '-3', 7],
    ['非数字 → 默认 7', 'abc', 7],
    ['0 → 默认 7', '0', 7],
    ['正常值透传', '14', 14],
    ['小数透传（不过度设计，合法即用）', '0.5', 0.5],
  ])('%s', (_name, raw, expected) => {
    expect(resolveTrialDays(raw as string | undefined)).toBe(expected);
  });
});
