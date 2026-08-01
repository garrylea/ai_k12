import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module.js';
import * as dotenv from 'dotenv';
import { NestExpressApplication } from '@nestjs/platform-express';
import * as path from 'path';
import * as fs from 'fs';

dotenv.config({ path: new URL('../.env', import.meta.url).pathname });

async function bootstrap() {
  const app = await NestFactory.create<NestExpressApplication>(AppModule);

  app.enableCors({
    origin: ['http://localhost:5173', 'http://localhost:5174', 'http://localhost:3000'],
    credentials: true,
  });

  // 物化图片静态服务：/assets/* → tools/data-refinery/output/assets/*
  // 前端 ASSET_BASE 默认 /assets/，图片 url（如 textbooks/math/xxx/1/xx.jpg）挂在 /assets 下。
  const assetsDir = path.resolve(import.meta.dirname, '../../../tools/data-refinery/output/assets');
  if (fs.existsSync(assetsDir)) {
    app.useStaticAssets(assetsDir, { prefix: '/assets/' });
    console.log(`Serving assets from ${assetsDir} at /assets/`);
  } else {
    console.warn(`[WARN] assets dir not found: ${assetsDir}`);
  }

  const port = process.env.PORT || 3001;
  await app.listen(port);
  console.log(`K12 Server running on http://localhost:${port}`);
}

bootstrap();
