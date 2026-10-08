import { BadRequestException, NotFoundException, ServiceUnavailableException, BadGatewayException } from '@nestjs/common';
import { getModelConfigRegistry } from '../../ai-core/infra/model-config-registry.js';
import { ModelClient } from '../../ai-core/infra/model-client/index.js';
import { timeoutConfig } from '../../ai-core/config.js';
import type { ChatMessage, RoutedModel } from '../../ai-core/types.js';

/**
 * 手写识别率调研 demo（spec 2026-10-08）：纯转写、不落库、不写 request-log。
 * 注意：**不写 @Injectable()**——构造参数是对象字面量类型（DI 坑），
 * DevModule 用 useFactory 手动实例化。
 */
export const HANDWRITING_SYSTEM_PROMPT =
  '你是 OCR 引擎。把图片中的手写汉字逐字转写为简体中文纯文本，只输出转写结果本身，不要输出任何解释或多余符号。无法辨认的字输出最接近的猜测。';

const IMAGE_PREFIX = /^data:image\/(png|jpeg);base64,/;
const MAX_IMAGE_BYTES = 4 * 1024 * 1024;

export interface DevModelListResult {
  models: { key: string; provider: string; modelId: string }[];
}

export interface DevRecognizeResult {
  text: string;
  modelKey: string;
  elapsedMs: number;
}

export class DevHandwritingService {
  private modelClient: ModelClient;

  constructor(deps?: { modelClient?: ModelClient }) {
    this.modelClient = deps?.modelClient ?? new ModelClient();
  }

  listModels(): DevModelListResult {
    const registry = getModelConfigRegistry();
    if (!registry) {
      throw new ServiceUnavailableException({ code: 5300, message: '模型配置未初始化' });
    }
    const snapshot = registry.getSnapshot();
    return {
      models: Object.entries(snapshot.models).map(([key, m]) => ({
        key,
        provider: m.provider,
        modelId: m.modelId,
      })),
    };
  }

  async recognize(image: string, modelKey: string): Promise<DevRecognizeResult> {
    // 1. image 格式与大小（spec §5.2 校验表）
    if (typeof image !== 'string' || !IMAGE_PREFIX.test(image)) {
      throw new BadRequestException({ code: 4001, message: 'image 必须是 data:image/png|jpeg;base64 格式' });
    }
    const base64 = image.slice(image.indexOf(',') + 1);
    if (Buffer.from(base64, 'base64').length > MAX_IMAGE_BYTES) {
      throw new BadRequestException({ code: 4002, message: '图片解码后超过 4MB' });
    }
    // 2. modelKey 必须在 registry
    const registry = getModelConfigRegistry();
    const cfg = registry?.getSnapshot().models[modelKey];
    if (!cfg) {
      throw new NotFoundException({ code: 4404, message: `未知模型：${modelKey}` });
    }
    // 3. 构造消息：system 转写指令 + user（text + image_url 部件，与 tutoring 同构）
    const messages: ChatMessage[] = [
      { role: 'system', content: HANDWRITING_SYSTEM_PROMPT },
      {
        role: 'user',
        content: [
          { type: 'text', text: '转写' },
          { type: 'image_url', image_url: { url: image } },
        ],
      },
    ];
    const model: RoutedModel = { ...cfg, modelKey };
    const start = Date.now();
    try {
      // meta 显式 studentId:null = 明确不归属任何学生（llm 账本不记到学生头上）
      const res = await this.modelClient.chat({
        model,
        messages,
        timeout: timeoutConfig.timeout.default,
        meta: { studentId: null, capability: 'handwriting_demo' },
      });
      return { text: res.content.trim(), modelKey, elapsedMs: Date.now() - start };
    } catch (err) {
      throw new BadGatewayException({
        code: 5502,
        message: `识别模型调用失败：${err instanceof Error ? err.message : String(err)}`,
      });
    }
  }
}
