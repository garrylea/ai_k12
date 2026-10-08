import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module.js';
import * as dotenv from 'dotenv';
import { NestExpressApplication } from '@nestjs/platform-express';
import * as express from 'express';
import type { IncomingMessage, ServerResponse } from 'http';
import * as path from 'path';
import * as fs from 'fs';

dotenv.config({ path: new URL('../.env', import.meta.url).pathname });

// 复刻 Nest 的 rawBody 捕获（@nestjs/platform-express get-body-parser-options 的 verify 钩子）：
// bodyParser:false 后 Nest 不再注册自己的 parser，req.rawBody 由下面的显式 parser 负责 ——
// 支付回调验签（BillingCallbackController）依赖 req.rawBody 取原始字节，缺失会静默验签失败。
const rawBodyVerify = (req: IncomingMessage, _res: ServerResponse, buffer: Buffer): void => {
  if (Buffer.isBuffer(buffer)) {
    (req as IncomingMessage & { rawBody?: Buffer }).rawBody = buffer;
  }
};

async function bootstrap() {
  // rawBody: 支付回调验签需要原始请求字节（微信验签串/支付宝原文验签），
  // 重序列化后的 body 会验签失败 —— BillingCallbackController 里用 req.rawBody 取。
  const app = await NestFactory.create<NestExpressApplication>(AppModule, {
    rawBody: true,
    // bodyParser 全接管（fix round 2）：上轮「路径限定 json({limit:'8mb'})」的自定义 parser
    // 函数名同为 `json`，Nest 的 ExpressAdapter 按 parser 函数名去重注册（isMiddlewareApplied），
    // 会顶掉 Nest 自己的全局 JSON parser —— 非手写路径 req.body 全变空（全局 P0 回归）。
    // 故关闭 Nest 默认 parser，显式注册：手写路径 8mb 先注册，其余路径 100kb 兜底
    // （body-parser 靠 req._body 对已解析请求自动跳过，故一条请求只会被一个 parser 消费）。
    // json + urlencoded 两条都要注册：Nest 默认两者皆有，且支付宝回调是
    // form-urlencoded（alipay adapter 用 URLSearchParams 解析 rawBody），漏掉会空 body。
    bodyParser: false,
  });

  // 手写转写端点：手写图 base64 可达 ~5.5MB（解码 4MB 上限），默认 100kb 会 413。
  app.use('/api/ai/handwriting', express.json({ limit: '8mb', verify: rawBodyVerify }));
  // 全局默认，等价 Nest 原默认（json 100kb + urlencoded extended/100kb）。
  app.use(express.json({ limit: '100kb', verify: rawBodyVerify }));
  app.use(express.urlencoded({ extended: true, limit: '100kb', verify: rawBodyVerify }));

  app.enableCors({
    origin: ['http://localhost:5173', 'http://localhost:5174', 'http://localhost:3000'],
    credentials: true,
  });

  // 让 OnModuleDestroy 生效，退出时把埋点 buffer 里剩余的行 flush 掉
  app.enableShutdownHooks();

  // 物化图片静态服务：/assets/* → tools/data-refinery/output/assets/*
  // 前端 ASSET_BASE 默认 /assets/，图片 url（如 textbooks/math/xxx/1/xx.jpg）挂在 /assets 下。
  const assetsDir = path.resolve(import.meta.dirname, '../../../tools/data-refinery/output/assets');
  if (fs.existsSync(assetsDir)) {
    app.useStaticAssets(assetsDir, { prefix: '/assets/' });
    console.log(`Serving assets from ${assetsDir} at /assets/`);
  } else {
    console.warn(`[WARN] assets dir not found: ${assetsDir}`);
  }

  // 用户上传图片静态服务：/uploads/* -> UPLOAD_DIR（默认 ./uploads）
  // 答疑历史回放需要通过此 URL 重新展示用户发送过的图片。
  const uploadsDir = path.resolve(process.env.UPLOAD_DIR ?? './uploads');
  if (fs.existsSync(uploadsDir)) {
    app.useStaticAssets(uploadsDir, { prefix: '/uploads/' });
    console.log(`Serving uploads from ${uploadsDir} at /uploads/`);
  } else {
    console.warn(`[WARN] uploads dir not found: ${uploadsDir}`);
  }

  const port = process.env.PORT || 3001;
  await app.listen(port);
  console.log(`K12 Server running on http://localhost:${port}`);
}

bootstrap();
