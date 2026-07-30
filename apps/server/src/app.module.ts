import { Module, MiddlewareConsumer, NestModule, RequestMethod } from '@nestjs/common';
import { APP_FILTER, APP_INTERCEPTOR } from '@nestjs/core';
import { HttpExceptionFilter } from './common/filters/http-exception.filter.js';
import { ResponseInterceptor } from './common/interceptors/response.interceptor.js';
import { AuthMiddleware } from './common/middleware/auth.middleware.js';
import { DatabaseModule } from './database/database.module.js';
import { AuthModule } from './modules/auth/auth.module.js';
import { ContentModule } from './modules/content/content.module.js';
import { ProgressModule } from './modules/progress/progress.module.js';

@Module({
  imports: [
    DatabaseModule,
    AuthModule,
    ContentModule,
    ProgressModule,
  ],
  providers: [
    { provide: APP_FILTER, useClass: HttpExceptionFilter },
    { provide: APP_INTERCEPTOR, useClass: ResponseInterceptor },
  ],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    // Populate request.user from the Bearer token for protected routes.
    consumer
      .apply(AuthMiddleware)
      .forRoutes({ path: 'api/progress/*', method: RequestMethod.ALL });
  }
}
