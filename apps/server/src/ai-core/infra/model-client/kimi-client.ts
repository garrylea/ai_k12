import type { ChatRequest, ChatResponse, StreamChunk } from '../../types.js';
import type { ProviderAdapter } from './types.js';

// OpenAI-compatible chat client. Kimi, Qwen, and DeepSeek all speak this protocol,
// so QwenClient and DeepSeekClient extend this class.
export class KimiClient implements ProviderAdapter {
  constructor(protected apiKey: string) {}

  async chat(request: ChatRequest): Promise<ChatResponse> {
    const response = await fetch(`${request.model.baseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify({
        model: request.model.modelId,
        messages: request.messages,
        temperature: request.temperature ?? 0.7,
        max_tokens: request.maxTokens ?? request.model.maxOutputTokens,
        stop: request.stopSequences,
        response_format: request.responseFormat === 'json_object' ? { type: 'json_object' } : undefined,
      }),
      signal: AbortSignal.timeout(request.timeout ?? 30000),
    });

    if (!response.ok) {
      const err = await response.text();
      throw new Error(`Kimi API error ${response.status}: ${err}`);
    }

    const data = await response.json();
    const choice = data.choices[0];

    return {
      id: data.id,
      model: data.model,
      content: choice.message.content,
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
    const response = await fetch(`${request.model.baseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify({
        model: request.model.modelId,
        messages: request.messages,
        temperature: request.temperature ?? 0.7,
        max_tokens: request.maxTokens ?? request.model.maxOutputTokens,
        stream: true,
      }),
      signal: AbortSignal.timeout(request.timeout ?? 30000),
    });

    if (!response.ok) {
      throw new Error(`Kimi API error ${response.status}`);
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
