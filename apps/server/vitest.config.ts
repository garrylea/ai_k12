import { defineConfig } from 'vitest/config';

/**
 * 固定测试时区为 Asia/Shanghai。
 *
 * 仓储层有依赖「本地时区」语义的用例（`parent-insights.repo.test.ts` 的
 * 「MySQL 返回 Date 时按本地日期拼」）——`TZ=UTC` 的 runner 上
 * `toISOString().slice(0,10)` 会与本地拼法得到同一天，用例会**假绿**。
 * 固定 TZ 后那条回归在任何 runner 上都真的钉得住（见 branch review 验证）。
 */
export default defineConfig({
  test: {
    env: { TZ: 'Asia/Shanghai' },
  },
});
