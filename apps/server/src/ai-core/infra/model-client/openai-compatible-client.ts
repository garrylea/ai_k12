import type { ChatRequest, ChatResponse, StreamChunk } from '../../types.js';
import { TimeoutError } from '../../types.js';
import type { ProviderAdapter } from './types.js';
import { classifyError } from './errors.js';
import { timeoutConfig } from '../../config.js';

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
    body.enable_thinking = request.thinking !== false;
    // 与非流式 chat() 对齐：流式路径同样下发 response_format，否则
    // judgment/grading/structuring 的 json_object 约束会被静默丢弃。
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
      // qwen3.8-max / deepseek emit reasoning_content with literal "\n" (backslash
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
    // Idle/stall timeout, NOT a wall-clock cap. A reasoner model (qwen3.8-max)
    // can legitimately stream thinking for minutes; the request is only stuck
    // when no data arrives for a while. The deadline is re-armed on every
    // received chunk — firstTokenTimeoutMs before the first byte,
    // interTokenTimeoutMs once streaming has started (see retry.yaml).
    const firstTokenMs = timeoutConfig.streaming?.firstTokenTimeoutMs ?? request.timeout ?? 30000;
    const interTokenMs = timeoutConfig.streaming?.interTokenTimeoutMs ?? request.timeout ?? 30000;
    const idle = new AbortController();
    let idleFired = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const onExternalAbort = () => idle.abort();
    const arm = (ms: number) => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        idleFired = true;
        idle.abort();
      }, ms);
    };
    const cleanup = () => {
      clearTimeout(timer);
      request.signal?.removeEventListener('abort', onExternalAbort);
    };

    let response: Response;
    try {
      request.signal?.addEventListener('abort', onExternalAbort, { once: true });
      arm(firstTokenMs);
      response = await fetch(`${request.model.baseUrl}/v1/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify(this.buildRequestBody(request, true)),
        signal: idle.signal,
      });
    } catch (netErr) {
      cleanup();
      // A user stop (external signal) keeps AbortError semantics so the
      // capability treats it as a deliberate stop, not a failure.
      if (request.signal?.aborted) throw netErr;
      // Idle timeout -> a real TimeoutError, so the client maps it to
      // "AI 响应超时" instead of the generic "服务异常" fallback.
      if (idleFired) throw this.idleTimeoutError(request);
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
      cleanup();
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
    if (!reader) {
      cleanup();
      throw new Error('No response body');
    }

    const decoder = new TextDecoder();
    let buffer = '';

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        // Any byte received (content, reasoning, or keep-alive) proves the
        // upstream is still alive -> re-arm the idle deadline.
        arm(interTokenMs);

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
    } catch (err) {
      if (idleFired) throw this.idleTimeoutError(request);
      // User stop (AbortError) and genuine network errors propagate unchanged.
      throw err;
    } finally {
      cleanup();
    }
  }

  /** Idle/stall timeout: no stream data for the configured window. statusCode
   *  408 routes to the "AI 响应超时" client message (not the generic 5000). */
  private idleTimeoutError(request: ChatRequest): TimeoutError {
    return new TimeoutError({
      provider: this.providerName,
      statusCode: 408,
      providerCode: 'idle_timeout',
      retryable: true,
      retryAfterMs: null,
      hint: 'No stream data received within the idle window (first-token/inter-token) - the upstream may be stuck.',
      modelId: request.model.modelId,
    });
  }

  protected calculateCost(inputTokens: number, outputTokens: number, costPer1K: { input: number; output: number }): number {
    return (inputTokens / 1000) * costPer1K.input + (outputTokens / 1000) * costPer1K.output;
  }
}
