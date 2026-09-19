import type { ChatRequest, ChatResponse, StreamChunk } from '../../types.js';
import { contentToText } from '../../types.js';
import type { ProviderAdapter } from './types.js';
import { classifyError } from './errors.js';

// Gemini uses its own generateContent protocol (not OpenAI-compatible).
// MVP: non-streaming chat implemented; streaming deferred.
export class GeminiClient implements ProviderAdapter {
  constructor(private apiKey: string) {}

  async chat(request: ChatRequest): Promise<ChatResponse> {
    // Gemini has no 'system' role in `contents`; system prompts go in the
    // top-level systemInstruction field. Map the rest: user->user, assistant->model.
    // Task 14a: content may be string | ContentPart[]; coerce to text (Gemini
    // multimodal would need inline_data parts, not implemented for MVP).
    const systemMessages = request.messages.filter(m => m.role === 'system');
    const contents = request.messages
      .filter(m => m.role !== 'system')
      .map(m => ({
        role: m.role === 'assistant' ? 'model' : 'user',
        parts: [{ text: contentToText(m.content) }],
      }));

    let response: Response;
    try {
      response = await fetch(
        `${request.model.baseUrl}/v1/models/${request.model.modelId}:generateContent?key=${this.apiKey}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            contents,
            ...(systemMessages.length > 0
              ? { systemInstruction: { parts: [{ text: systemMessages.map(m => contentToText(m.content)).join('\n\n') }] } }
              : {}),
            generationConfig: {
              temperature: request.temperature ?? 0.7,
              maxOutputTokens: request.maxTokens ?? request.model.maxOutputTokens,
            },
          }),
          signal: AbortSignal.any([AbortSignal.timeout(request.timeout ?? 30000), ...(request.signal ? [request.signal] : [])]),
        }
      );
    } catch (netErr) {
      // 网络错误(DNS/连接失败/abort)归一为 status=0 -> TimeoutError
      throw classifyError({
        provider: 'Gemini',
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
        provider: 'Gemini',
        status: response.status,
        body: parsed,
        headers: response.headers,
        modelId: request.model.modelId,
      });
    }

    const data = await response.json();
    const text = data.candidates?.[0]?.content?.parts?.[0]?.text ?? '';
    // 没有 usageMetadata 时**不能**编造 0 并标 source:'provider'——「没拿到」
    // 必须与「测到 0」可区分，否则报表上看不出缺口。缺块 -> unavailable/NULL。
    const usageMeta = data.usageMetadata;
    const hasUsage = usageMeta && typeof usageMeta.promptTokenCount === 'number' && typeof usageMeta.candidatesTokenCount === 'number';
    const inputTokens = hasUsage ? usageMeta.promptTokenCount : null;
    const outputTokens = hasUsage ? usageMeta.candidatesTokenCount : null;

    return {
      id: data.responseId ?? 'gemini',
      model: request.model.modelId,
      content: text,
      finishReason: this.mapFinishReason(data.candidates?.[0]?.finishReason),
      usage: hasUsage
        ? {
            inputTokens: inputTokens as number,
            outputTokens: outputTokens as number,
            cost: this.calculateCost(inputTokens as number, outputTokens as number, request.model.costPer1K),
            source: 'provider' as const,
          }
        : { inputTokens: null, outputTokens: null, cost: null, source: 'unavailable' as const },
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
    // TODO: implement streamGenerateContent (SSE). Deferred - needs GEMINI_API_KEY
    // to integration-test. ModelClient falls back to non-streaming chat for gemini.
    throw new Error('Gemini streaming not implemented (TODO: streamGenerateContent, needs GEMINI_API_KEY)');
  }
}
