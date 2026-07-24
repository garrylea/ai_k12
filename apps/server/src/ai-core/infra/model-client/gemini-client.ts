import type { ChatRequest, ChatResponse, StreamChunk } from '../../types.js';
import type { ProviderAdapter } from './types.js';

// Gemini uses its own generateContent protocol (not OpenAI-compatible).
// MVP: non-streaming chat implemented; streaming deferred.
export class GeminiClient implements ProviderAdapter {
  constructor(private apiKey: string) {}

  async chat(request: ChatRequest): Promise<ChatResponse> {
    const response = await fetch(
      `${request.model.baseUrl}/v1/models/${request.model.modelId}:generateContent?key=${this.apiKey}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: request.messages.map(m => ({
            role: m.role === 'assistant' ? 'model' : 'user',
            parts: [{ text: m.content }],
          })),
          generationConfig: {
            temperature: request.temperature ?? 0.7,
            maxOutputTokens: request.maxTokens ?? request.model.maxOutputTokens,
          },
        }),
        signal: AbortSignal.timeout(request.timeout ?? 30000),
      }
    );

    if (!response.ok) {
      throw new Error(`Gemini API error ${response.status}`);
    }

    const data = await response.json();
    const text = data.candidates?.[0]?.content?.parts?.[0]?.text ?? '';

    return {
      id: data.candidates?.[0]?.content?.parts?.[0]?.text?.slice(0, 20) ?? 'gemini',
      model: request.model.modelId,
      content: text,
      finishReason: data.candidates?.[0]?.finishReason === 'STOP' ? 'stop' : 'error',
      usage: {
        inputTokens: data.usageMetadata?.promptTokenCount ?? 0,
        outputTokens: data.usageMetadata?.candidatesTokenCount ?? 0,
        cost: 0,
      },
      latencyMs: 0,
    };
  }

  async *streamChat(_request: ChatRequest): AsyncIterable<StreamChunk> {
    throw new Error('Gemini streaming not implemented for MVP');
  }
}
