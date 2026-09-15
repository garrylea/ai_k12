import type { ChatRequest } from '../../types.js';
import { OpenAICompatibleClient } from './openai-compatible-client.js';

/**
 * 让本地 llama.cpp 真正关掉 Qwen3 thinking 的请求体片段。
 *
 * llama.cpp 不认 DashScope 的 `enable_thinking` 字段，只认 chat template 的
 * `chat_template_kwargs`。2026-09-14 实测（Qwen3.8-27B @ 192.168.1.8:12345）：
 *   - 什么都不传            -> reasoning_content 45 字（照常思考）
 *   - prompt 末尾加 /no_think -> reasoning_content 49 字（软开关无效）
 *   - chat_template_kwargs  -> reasoning_content 0 字，直接出正文，1.2s
 * 用法：`modelClient.chat({ ..., extraBody: LLAMA_CPP_NO_THINKING_BODY })`。
 */
export const LLAMA_CPP_NO_THINKING_BODY = {
  chat_template_kwargs: { enable_thinking: false },
} as const;

// 本地 llama.cpp 服务（OpenAI 兼容）。它服务 Qwen3.8-27B 权重，但不是 DashScope
// 端点：去掉 enable_thinking（DashScope 专有的 thinking 开关），保留
// response_format（判题依赖 JSON 输出）。
// 要在这里关 thinking 必须走 extraBody（见 LLAMA_CPP_NO_THINKING_BODY），
// 传 `thinking: false` 对本地端点无效——它只会让上面的 delete 白删一次。
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
