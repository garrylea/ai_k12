import type { ChatRequest } from '../../types.js';
import { OpenAICompatibleClient } from './openai-compatible-client.js';

// 本地 llama.cpp 服务（OpenAI 兼容）。它服务 Qwen3.8-27B 权重，但不是 DashScope
// 端点：去掉 enable_thinking（DashScope 专有的 thinking 开关），保留
// response_format（判题依赖 JSON 输出）。
export class LocalClient extends OpenAICompatibleClient {
  constructor(apiKey: string) {
    super(apiKey, 'Local');
  }

  protected buildRequestBody(request: ChatRequest, stream: boolean): Record<string, unknown> {
    const body = super.buildRequestBody(request, stream);
    delete body.enable_thinking;
    return body;
  }
}
