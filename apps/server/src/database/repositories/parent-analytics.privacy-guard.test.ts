import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/** delta spec §3 第 3 锁：家长端查询源码绝不出现 ops 难堪信号事件名。 */
describe('parent-analytics.repo 隐私守卫', () => {
  it('不含任何 ops-only 事件名字符串', () => {
    const src = readFileSync(new URL('./parent-analytics.repo.ts', import.meta.url), 'utf8');
    for (const banned of ['hint_requested', 'answer_revealed', 'self_assess_answered', 'consecutive_failures', 'study_session_idle']) {
      expect(src).not.toContain(banned);
    }
  });
});
