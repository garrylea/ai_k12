import { Module, MiddlewareConsumer, NestModule, RequestMethod } from '@nestjs/common';
import { APP_FILTER, APP_INTERCEPTOR } from '@nestjs/core';
import { HttpExceptionFilter } from './common/filters/http-exception.filter.js';
import { ResponseInterceptor } from './common/interceptors/response.interceptor.js';
import { AuthMiddleware } from './common/middleware/auth.middleware.js';
import { BanRegistry } from './common/guards/ban-registry.js';
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

@Module({
  imports: [
    DatabaseModule,
    AuthModule,
    ContentModule,
    ProgressModule,
    // Auxiliary track modules (Tasks 4-8)
    FilesModule,
    ConversationsModule,
    AIModule,
    RefineryModule,
    PracticeModule,
    ParentModule,
    ConfigModule,
    AdminModule,
  ],
  providers: [
    BanRegistry,
    { provide: APP_FILTER, useClass: HttpExceptionFilter },
    { provide: APP_INTERCEPTOR, useClass: ResponseInterceptor },
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
  }
}
