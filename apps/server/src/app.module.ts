import { Module, MiddlewareConsumer, NestModule, RequestMethod } from '@nestjs/common';
import { APP_FILTER, APP_INTERCEPTOR } from '@nestjs/core';
import { HttpExceptionFilter } from './common/filters/http-exception.filter.js';
import { ResponseInterceptor } from './common/interceptors/response.interceptor.js';
import { AuthMiddleware } from './common/middleware/auth.middleware.js';
import { DatabaseModule } from './database/database.module.js';
import { AuthModule } from './modules/auth/auth.module.js';
import { ContentModule } from './modules/content/content.module.js';
import { ProgressModule } from './modules/progress/progress.module.js';
import { FilesModule } from './modules/files/files.module.js';
import { ConversationsModule } from './modules/conversations/conversations.module.js';
import { AIModule } from './modules/ai/ai.module.js';
import { RefineryModule } from './modules/refinery/refinery.module.js';
import { ErrorBookModule } from './modules/error-book/error-book.module.js';

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
    ErrorBookModule,
  ],
  providers: [
    { provide: APP_FILTER, useClass: HttpExceptionFilter },
    { provide: APP_INTERCEPTOR, useClass: ResponseInterceptor },
  ],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    // Populate request.user from the Bearer token for protected routes.
    // AuthMiddleware is a no-op when the token is missing/invalid, so public
    // routes (api/auth/login, api/auth/register, api/content/*) remain open
    // even if they happen to be matched here. Each protected controller
    // declares @UseGuards(JwtAuthGuard) which reads request.user.
    consumer
      .apply(AuthMiddleware)
      .forRoutes(
        { path: 'api/progress/*', method: RequestMethod.ALL },
        { path: 'api/files/*', method: RequestMethod.ALL },
        { path: 'api/conversations/*', method: RequestMethod.ALL },
        { path: 'api/ai/*', method: RequestMethod.ALL },
        { path: 'api/refinery/*', method: RequestMethod.ALL },
        { path: 'api/error-book/*', method: RequestMethod.ALL },
      );
  }
}
