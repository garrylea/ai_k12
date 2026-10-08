import { BadRequestException, BadGatewayException } from '@nestjs/common';
import { ModelRouter } from '../../ai-core/infra/model-router.js';
import { getModelConfigRegistry } from '../../ai-core/infra/model-config-registry.js';
import { ModelClient } from '../../ai-core/infra/model-client/index.js';
import { timeoutConfig } from '../../ai-core/config.js';
import type { ChatMessage } from '../../ai-core/types.js';

/**
 * 手写识别转写（语文专项手写输入，spec 2026-10-08 §5.1）。
 * 与 dev 调研端点的三点不同：走 ModelRouter（fallback+账本打标）；
 * meta 不带 studentId（HTTP 路径 ALS 归属学生）；thinking:false。
 * **不写 @Injectable()**（DI 坑），AIModule 用 useFactory。
 */
export const HANDWRITING_TRANSCRIBE_PROMPT =
  '你是 OCR 引擎。把图片中的手写汉字逐字转写为简体中文纯文本，只输出转写结果本身，不要输出任何解释或多余符号。无法辨认的字输出最接近的猜测。';

const IMAGE_PREFIX = /^data:image\/(png|jpeg);base64,/;
const MAX_IMAGE_BYTES = 4 * 1024 * 1024;

export interface HandwritingTranscribeResult {
  text: string;
  modelKey: string;
  elapsedMs: number;
}

export class HandwritingService {
  private modelRouter: ModelRouter;
  private modelClient: ModelClient;

  constructor(deps?: { modelRouter?: ModelRouter; modelClient?: ModelClient }) {
    this.modelRouter = deps?.modelRouter ?? new ModelRouter(getModelConfigRegistry());
    this.modelClient = deps?.modelClient ?? new ModelClient();
  }

  async transcribe(image: string): Promise<HandwritingTranscribeResult> {
    if (typeof image !== 'string' || !IMAGE_PREFIX.test(image)) {
      throw new BadRequestException({ code: 4001, message: 'image 必须是 data:image/png|jpeg;base64 格式' });
    }
    const base64 = image.slice(image.indexOf(',') + 1);
    if (Buffer.from(base64, 'base64').length > MAX_IMAGE_BYTES) {
      throw new BadRequestException({ code: 4002, message: '图片解码后超过 4MB' });
    }
    const routeResult = this.modelRouter.route({ scene: 'handwriting', subject: 'chinese' });
    const messages: ChatMessage[] = [
      { role: 'system', content: HANDWRITING_TRANSCRIBE_PROMPT },
      {
        role: 'user',
        content: [
          { type: 'text', text: '转写' },
          { type: 'image_url', image_url: { url: image } },
        ],
      },
    ];
    const start = Date.now();
    try {
      const res = await this.modelClient.chat({
        model: routeResult.primary,
        messages,
        timeout: timeoutConfig.timeout.default,
        thinking: false,
        meta: { capability: 'handwriting_transcribe' },
      });
      return {
        text: res.content.trim(),
        modelKey: routeResult.primary.modelKey ?? '',
        elapsedMs: Date.now() - start,
      };
    } catch (err) {
      throw new BadGatewayException({
        code: 5502,
        message: `识别模型调用失败：${err instanceof Error ? err.message : String(err)}`,
      });
    }
  }
}
