import type { ChatRequest, ChatResponse, StreamChunk } from '../../types.js';
import type { ProviderAdapter } from './types.js';
import { classifyError } from './errors.js';

// OpenAI-compatible chat client. Kimi, Qwen, DeepSeek and local llama.cpp all
// speak this protocol, so KimiClient/QwenClient/DeepSeekClient/LocalClient
// extend this class and only differ in the provider label / request body.
export class OpenAICompatibleClient implements ProviderAdapter {
  constructor(protected apiKey: string, protected providerName = 'OpenAI-Compatible') {}

  /** Request body for /v1/chat/completions. Subclasses override to add or drop
   *  provider-specific fields (e.g. LocalClient omits enable_thinking). */
  protected buildRequestBody(request: ChatRequest, stream: boolean): Record<string, unknown> {
    const body: Record<string, unknown> = {
      model: request.model.modelId,
      messages: request.messages,
      temperature: request.temperature ?? 0.7,
      max_tokens: request.maxTokens ?? request.model.maxOutputTokens,
    };
    // 逐字段复刻改动前的两个请求体：非流式带 stop、流式带 stream。
    if (stream) {
      body.stream = true;
    } else {
      body.stop = request.stopSequences;
    }
    body.enable_thinking = true;
    body.response_format = request.responseFormat === 'json_object' ? { type: 'json_object' } : undefined;
    return body;
  }

  async chat(request: ChatRequest): Promise<ChatResponse> {
    let response: Response;
    try {
      response = await fetch(`${request.model.baseUrl}/v1/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify(this.buildRequestBody(request, false)),
        signal: AbortSignal.any([AbortSignal.timeout(request.timeout ?? 30000), ...(request.signal ? [request.signal] : [])]),
      });
    } catch (netErr) {
      // 网络错误(DNS/连接失败/abort)归一为 status=0 -> TimeoutError
      throw classifyError({
        provider: this.providerName,
        status: 0,
        body: { message: netErr instanceof Error ? netErr.message : String(netErr) },
        headers: new Headers(),
        modelId: request.model.modelId,
      });
    }

    if (!response.ok) {
      const raw = await response.text();
      let parsed: unknown = null;
      try { parsed = raw ? JSON.parse(raw) : null; } catch { parsed = { message: raw }; }
      throw classifyError({
        provider: this.providerName,
        status: response.status,
        body: parsed,
        headers: response.headers,
        modelId: request.model.modelId,
      });
    }

    const data = await response.json();
    const choice = data.choices[0];

    return {
      id: data.id,
      model: data.model,
      content: choice.message.content,
      // qwen3.7-max / deepseek emit reasoning_content with literal "\n" (backslash
      // + n) as line separators instead of real newlines. Normalize at source so
      // streaming, persistence, and history all see real newlines.
      reasoningContent: choice.message.reasoning_content
        ? choice.message.reasoning_content.replace(/\\n/g, '\n')
        : undefined,
      finishReason: choice.finish_reason,
      usage: {
        inputTokens: data.usage?.prompt_tokens ?? 0,
        outputTokens: data.usage?.completion_tokens ?? 0,
        cost: this.calculateCost(data.usage?.prompt_tokens ?? 0, data.usage?.completion_tokens ?? 0, request.model.costPer1K),
      },
      latencyMs: 0,
    };
  }

  async *streamChat(request: ChatRequest): AsyncIterable<StreamChunk> {
    let response: Response;
    try {
      response = await fetch(`${request.model.baseUrl}/v1/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify(this.buildRequestBody(request, true)),
        signal: AbortSignal.any([AbortSignal.timeout(request.timeout ?? 30000), ...(request.signal ? [request.signal] : [])]),
      });
    } catch (netErr) {
      // 网络错误(DNS/连接失败/abort)归一为 status=0 -> TimeoutError
      throw classifyError({
        provider: this.providerName,
        status: 0,
        body: { message: netErr instanceof Error ? netErr.message : String(netErr) },
        headers: new Headers(),
        modelId: request.model.modelId,
      });
    }

    if (!response.ok) {
      const raw = await response.text();
      let parsed: unknown = null;
      try { parsed = raw ? JSON.parse(raw) : null; } catch { parsed = { message: raw }; }
      throw classifyError({
        provider: this.providerName,
        status: response.status,
        body: parsed,
        headers: response.headers,
        modelId: request.model.modelId,
      });
    }

    const reader = response.body?.getReader();
    if (!reader) throw new Error('No response body');

    const decoder = new TextDecoder();
    let buffer = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || !trimmed.startsWith('data: ')) continue;
        const data = trimmed.slice(6);
        if (data === '[DONE]') return;

        try {
          const parsed = JSON.parse(data);
          const delta = parsed.choices?.[0]?.delta;
          if (delta?.reasoning_content) {
            yield { content: '', reasoningContent: delta.reasoning_content.replace(/\\n/g, '\n') };
          }
          if (delta?.content) {
            yield { content: delta.content };
          }
          if (parsed.choices?.[0]?.finish_reason) {
            yield { content: '', finishReason: parsed.choices[0].finish_reason };
          }
        } catch {
          // skip malformed SSE chunks
        }
      }
    }
  }

  protected calculateCost(inputTokens: number, outputTokens: number, costPer1K: { input: number; output: number }): number {
    return (inputTokens / 1000) * costPer1K.input + (outputTokens / 1000) * costPer1K.output;
  }
}
