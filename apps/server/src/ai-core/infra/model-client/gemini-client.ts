import type { ChatRequest, ChatResponse, StreamChunk } from '../../types.js';
import type { ProviderAdapter } from './types.js';
import { mapHttpError } from './errors.js';

// Gemini uses its own generateContent protocol (not OpenAI-compatible).
// MVP: non-streaming chat implemented; streaming deferred.
export class GeminiClient implements ProviderAdapter {
  constructor(private apiKey: string) {}

  async chat(request: ChatRequest): Promise<ChatResponse> {
    // Gemini has no 'system' role in `contents`; system prompts go in the
    // top-level systemInstruction field. Map the rest: user->user, assistant->model.
    const systemMessages = request.messages.filter(m => m.role === 'system');
    const contents = request.messages
      .filter(m => m.role !== 'system')
      .map(m => ({
        role: m.role === 'assistant' ? 'model' : 'user',
        parts: [{ text: m.content }],
      }));

    const response = await fetch(
      `${request.model.baseUrl}/v1/models/${request.model.modelId}:generateContent?key=${this.apiKey}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents,
          ...(systemMessages.length > 0
            ? { systemInstruction: { parts: [{ text: systemMessages.map(m => m.content).join('\n\n') }] } }
            : {}),
          generationConfig: {
            temperature: request.temperature ?? 0.7,
            maxOutputTokens: request.maxTokens ?? request.model.maxOutputTokens,
          },
        }),
        signal: AbortSignal.timeout(request.timeout ?? 30000),
      }
    );

    if (!response.ok) {
      throw mapHttpError('Gemini', response.status, await response.text(), request.model.modelId);
    }

    const data = await response.json();
    const text = data.candidates?.[0]?.content?.parts?.[0]?.text ?? '';
    const inputTokens = data.usageMetadata?.promptTokenCount ?? 0;
    const outputTokens = data.usageMetadata?.candidatesTokenCount ?? 0;

    return {
      id: data.responseId ?? 'gemini',
      model: request.model.modelId,
      content: text,
      finishReason: this.mapFinishReason(data.candidates?.[0]?.finishReason),
      usage: {
        inputTokens,
        outputTokens,
        cost: this.calculateCost(inputTokens, outputTokens, request.model.costPer1K),
      },
      latencyMs: 0,
    };
  }

  private mapFinishReason(reason: string | undefined): 'stop' | 'length' | 'content_filter' | 'error' {
    switch (reason) {
      case 'STOP': return 'stop';
      case 'MAX_TOKENS': return 'length';
      case 'SAFETY': return 'content_filter';
      default: return 'error';
    }
  }

  private calculateCost(inputTokens: number, outputTokens: number, costPer1K: { input: number; output: number }): number {
    return (inputTokens / 1000) * costPer1K.input + (outputTokens / 1000) * costPer1K.output;
  }

  async *streamChat(_request: ChatRequest): AsyncIterable<StreamChunk> {
    throw new Error('Gemini streaming not implemented for MVP');
  }
}
