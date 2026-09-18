import { Controller, Get, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard.js';
import { RolesGuard } from '../../common/guards/roles.guard.js';
import { Roles } from '../../common/decorators/roles.js';
import { allLevels } from './levels.js';
import type { LevelInfo } from './levels.js';

/**
 * 段位表查询（`/api/points/levels`）。
 *
 * 家长端配奖励门槛（`minLevelCode` 九选一）需要完整的 9 档清单，而 `PointsOverview`
 * 只回 `level` + `nextLevel`、`minLevelName` 只是逐项名字——都给不出「白银及以上」
 * 这种可选项。spec §3.1 要求段位表**单一真源在后端**，故单独开这条静态端点。
 *
 * 与 `PointsController` **同前缀** `api/points`（Nest 允许同前缀多 controller），
 * 但**不能**挂在 `PointsController` 上：那个类标了 `@Roles('student')`，家长会被 403。
 * 这里 `@Roles('student','parent')`（学生端将来也可能用）。
 *
 * 段位是静态常量：**不做任何 DB 访问、不做归属校验、无入参**（故无 Zod）。
 */
@Controller('api/points')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles('student', 'parent')
export class LevelsController {
  /** 全量 9 档，按阈值升序，含 `index`（0 起）。 */
  @Get('levels')
  getLevels(): { levels: LevelInfo[] } {
    return { levels: allLevels() };
  }
}
