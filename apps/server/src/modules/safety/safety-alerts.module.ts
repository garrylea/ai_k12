import { Module } from '@nestjs/common';
import { SafetyAlertsService } from './safety-alerts.service.js';
import { SafetyAlertsRepository } from '../../database/repositories/safety-alerts.repo.js';
import { StudentsRepository } from '../../database/repositories/students.repo.js';

/**
 * 预警写入口的共享模块。三个消费方：
 *   - `AIModule`（辅导链路：闲聊 / 情绪 / 敏感）
 *   - `AnalyticsModule`（心跳链路：走神）
 *   - `ParentInsightsModule`（家长端列表 / 标记已读，直接用 `SafetyAlertsRepository`）
 * 注意：**不要**在别的模块重复 provide 这两个仓储/服务（会分裂实例与去重语义）。
 */
@Module({
  providers: [SafetyAlertsService, SafetyAlertsRepository, StudentsRepository],
  exports: [SafetyAlertsService, SafetyAlertsRepository],
})
export class SafetyAlertsModule {}
