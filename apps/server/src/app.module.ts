import { Module, MiddlewareConsumer, NestModule, RequestMethod } from '@nestjs/common';
import { APP_FILTER, APP_INTERCEPTOR } from '@nestjs/core';
import { HttpExceptionFilter } from './common/filters/http-exception.filter.js';
import { ResponseInterceptor } from './common/interceptors/response.interceptor.js';
import { AuthMiddleware } from './common/middleware/auth.middleware.js';
import { CommonModule } from './common/common.module.js';
import { DatabaseModule } from './database/database.module.js';
import { AuthModule } from './modules/auth/auth.module.js';
import { ContentModule } from './modules/content/content.module.js';
import { ProgressModule } from './modules/progress/progress.module.js';
import { FilesModule } from './modules/files/files.module.js';
import { ConversationsModule } from './modules/conversations/conversations.module.js';
import { AIModule } from './modules/ai/ai.module.js';
import { RefineryModule } from './modules/refinery/refinery.module.js';
import { PracticeModule } from './modules/practice/practice.module.js';
import { ParentModule } from './modules/parent/parent.module.js';
import { ConfigModule } from './modules/config/config.module.js';
import { AdminModule } from './modules/admin/admin.module.js';
import { TrainingModule } from './modules/training/training.module.js';
import { ExamsModule } from './modules/exams/exams.module.js';
import { PointsModule } from './modules/points/points.module.js';
import { ParentInsightsModule } from './modules/parent-insights/parent-insights.module.js';
import { KnowledgeGraphModule } from './modules/knowledge-graph/knowledge-graph.module.js';
import { DeviceControlModule } from './modules/device-control/device-control.module.js';
import { AnalyticsModule } from './modules/analytics/analytics.module.js';
import { AnalyticsInterceptor } from './common/interceptors/analytics.interceptor.js';
import { RequestContextMiddleware } from './common/middleware/request-context.middleware.js';

@Module({
  imports: [
    DatabaseModule,
    CommonModule,
    AuthModule,
    ContentModule,
    ProgressModule,
    // Auxiliary track modules (Tasks 4-8)
    FilesModule,
    ConversationsModule,
    AIModule,
    RefineryModule,
    PracticeModule,
    TrainingModule,
    ExamsModule,
    ParentModule,
    ConfigModule,
    AdminModule,
    // 闯关积分与段位（2026-09-17）——学生端查询端点；ParentPointsController 见 Task 8
    PointsModule,
    // 家长端「看得见」批（2026-09-18）——仪表盘/学情报告/错题查看/AI 对话回放（纯只读）
    ParentInsightsModule,
    // 埋点 Phase 0（2026-09-19）——持有两个 TelemetryBuffer + 注册 ai-core 的 LLM 账本 sink
    AnalyticsModule,
    // 数学薄弱点图谱（2026-09-23）——学生端训练轨第 4 张卡；两个只读端点
    KnowledgeGraphModule,
    // PC App 学习管控（2026-09-23）—— 学习会话 + 家长解除命令（学生端 3 + 家长端 2 端点）
    DeviceControlModule,
  ],
  providers: [
    { provide: APP_FILTER, useClass: HttpExceptionFilter },
    { provide: APP_INTERCEPTOR, useClass: ResponseInterceptor },
    // 埋点拦截器排在 ResponseInterceptor 之后。用 useExisting 而不是 useClass：
    // AnalyticsInterceptor 已由 AnalyticsModule 提供（它依赖同一个 TelemetryService
    // 实例），useClass 会new 出第二个实例、连带第二个 buffer，日志会被劈成两半。
    { provide: APP_INTERCEPTOR, useExisting: AnalyticsInterceptor },
  ],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    // AuthMiddleware populates request.user from the Bearer token (graceful no-op
    // if missing/invalid). Apply to ALL routes EXCEPT public auth/content routes.
    // Using exclude + wildcard ensures root-level routes (e.g. POST /api/conversations)
    // are matched, which the explicit `api/conversations/*` pattern missed
    // (Express 4 path-to-regexp requires a trailing segment after the wildcard).
    consumer
      .apply(AuthMiddleware)
      .exclude(
        { path: 'api/auth', method: RequestMethod.ALL },
        { path: 'api/auth/*', method: RequestMethod.ALL },
        { path: 'api/content', method: RequestMethod.ALL },
        { path: 'api/content/*', method: RequestMethod.ALL },
      )
      .forRoutes({ path: '*', method: RequestMethod.ALL });

    // ALS 上下文要读 AuthMiddleware 填的 request.user，因此必须在其后注册。
    // 同样排除公开路径（登录/学科列表），它们本来也没有学生身份。
    consumer
      .apply(RequestContextMiddleware)
      .exclude(
        { path: 'api/auth', method: RequestMethod.ALL },
        { path: 'api/auth/*', method: RequestMethod.ALL },
        { path: 'api/content', method: RequestMethod.ALL },
        { path: 'api/content/*', method: RequestMethod.ALL },
      )
      .forRoutes({ path: '*', method: RequestMethod.ALL });
  }
}
