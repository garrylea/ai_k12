import {
  LLMClientError, AuthenticationError, InsufficientQuotaError, PermissionError,
  ResourceNotFoundError, RequestTooLargeError, ValidationFailedError, ContentFilteredError,
  RateLimitError, ServerError, TimeoutError,
} from '../../types.js';
import type { ErrorContext, RetryOptions } from '../../types.js';
import { randomInt } from 'node:crypto';

/**
 * LLM client error handling - ported from ../llm-client.js (§3.3.4-§3.3.5).
 * Shared by all provider adapters: classifyError maps (provider, status, body)
 * to the right LLMClientError subclass; callWithRetry wraps an async call with
 * full-jitter exponential backoff, honoring Retry-After and skipping non-retryable
 * errors immediately.
 */

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * Parse the Retry-After header. Accepts integer seconds or an HTTP-date (RFC 7231).
 * Returns milliseconds, or null on parse failure.
 */
export function parseRetryAfter(value: string | null | undefined): number | null {
  if (!value) return null;
  const trimmed = String(value).trim();
  if (/^\d+(\.\d+)?$/.test(trimmed)) {
    return Math.max(0, Math.ceil(parseFloat(trimmed) * 1000));
  }
  const ts = Date.parse(trimmed);
  if (!Number.isNaN(ts)) {
    return Math.max(0, ts - Date.now());
  }
  return null;
}

/**
 * Pull a nested error code from a provider body, tolerating common shapes:
 *   body.error.code (OpenAI/DeepSeek) | body.error.type (Anthropic) |
 *   body.error.status (Gemini) | body.code/body.message (Qwen/Kimi).
 */
function extractCode(body: unknown): string | null {
  if (!body || typeof body !== 'object') return null;
  const b = body as Record<string, unknown>;
  if (typeof b.code === 'string') return b.code;
  const err = b.error as Record<string, unknown> | undefined;
  if (err) {
    if (typeof err.code === 'string') return err.code;
    if (typeof err.type === 'string') return err.type;
    if (typeof err.status === 'string') return err.status;
    if (typeof err.message === 'string' && err.message) return err.message as string;
  }
  if (typeof b.message === 'string') return b.message;
  return null;
}

function buildHint(provider: string, status: number, code: string | null): string {
  switch (status) {
    case 401: return `Verify the ${provider} API key; it may be missing, revoked, or expired.`;
    case 402: return `Top up the ${provider} account balance or activate billing.`;
    case 403: return `Account tier/model/region not permitted - check the plan or request access for "${code ?? 'this resource'}".`;
    case 404: return `Confirm the model name and base URL - the endpoint does not exist for this account.`;
    case 406: return `Request content was filtered by ${provider}'s safety policy; rephrase the prompt.`;
    case 408: return `The server cut the request off mid-flight - retry with a smaller payload.`;
    case 413: return `Shrink the prompt (trim history, drop images, lower max_tokens) and retry.`;
    case 422: return `Inspect the request body - a parameter failed validation: ${code ?? 'unknown'}.`;
    case 429:
      return code && /quota|insufficient|billing|balance|arrearage/i.test(code)
        ? `Quota/billing issue (${code}) - top up or upgrade; do not retry blindly.`
        : `Rate limit window active - the retry engine will back off and try again.`;
    case 500: return `Upstream internal error - already retried; consider a fallback model.`;
    case 503: return `Service overloaded or deploying - already retried; consider a fallback.`;
    case 504: return `Gateway timed out waiting for ${provider} - already retried.`;
    case 0: return `No HTTP response received - check connectivity, DNS, or the per-request timeout.`;
    default: return `Unhandled status ${status} from ${provider} (code=${code ?? 'n/a'}).`;
  }
}

export interface ClassifyInput {
  provider: string;
  status: number;
  body: unknown;
  headers: Headers | Record<string, string> | null;
  modelId: string;
}

/**
 * Map (provider, status, body, headers) to the right LLMClientError subclass.
 * Network/timeout errors should be normalized to status=0 before calling this.
 */
export function classifyError({ provider, status, body, headers, modelId }: ClassifyInput): LLMClientError {
  const headersObj = headers instanceof Headers ? headers : new Headers(headers || {});
  const retryAfterMs = parseRetryAfter(headersObj.get('retry-after'));
  const code = extractCode(body);
  const hint = buildHint(provider, status, code);

  const ctx = (extra: Partial<ErrorContext>): ErrorContext => ({
    provider,
    statusCode: status,
    providerCode: code,
    retryAfterMs,
    hint,
    modelId,
    retryable: false,
    ...extra,
  });

  if (status === 401) return new AuthenticationError(ctx({ retryable: false }));
  if (status === 402) return new InsufficientQuotaError(ctx({ retryable: false }));
  if (status === 403) return new PermissionError(ctx({ retryable: false }));
  if (status === 404) return new ResourceNotFoundError(ctx({ retryable: false }));
  if (status === 406) return new ContentFilteredError(ctx({ retryable: false }));
  if (status === 408) return new TimeoutError(ctx({ retryable: true }));
  if (status === 413) return new RequestTooLargeError(ctx({ retryable: false }));
  if (status === 422) return new ValidationFailedError(ctx({ retryable: false }));

  if (status === 429) {
    if (provider === 'openai' && code === 'insufficient_quota') {
      return new InsufficientQuotaError(ctx({ retryable: false }));
    }
    if (provider === 'qwen' && code && /arrearage/i.test(code)) {
      return new InsufficientQuotaError(ctx({ retryable: false }));
    }
    return new RateLimitError(ctx({ retryable: true }));
  }

  if (status >= 500 && status <= 599) {
    return new ServerError(ctx({ retryable: true }));
  }

  if (status === 400 && provider === 'qwen') {
    if (code && /arrearage/i.test(code)) {
      return new InsufficientQuotaError(ctx({ retryable: false }));
    }
    return new ValidationFailedError(ctx({ retryable: false }));
  }

  if (status === 400) return new ValidationFailedError(ctx({ retryable: false }));

  if (status === 0) return new TimeoutError(ctx({ retryable: true }));

  return new ServerError(ctx({ retryable: true }));
}

/**
 * Full-jitter exponential backoff: delay = random(0, min(maxBackoff, base * 2^attempt)).
 */
export function jitteredBackoff(attempt: number, baseDelay: number, maxBackoff: number): number {
  const cap = Math.min(maxBackoff, baseDelay * 2 ** attempt);
  return randomInt(0, cap + 1);
}

/**
 * Wrap an async operation with full-jitter exponential-backoff retry logic.
 *   - Non-retryable LLMClientError -> re-throw immediately.
 *   - Retries exhausted -> re-throw last error.
 *   - retryAfterMs set -> honor it (capped at maxBackoffMs).
 *   - otherwise -> jitteredBackoff(attempt).
 * Non-LLMClientError errors (raw network/abort) are treated as retryable.
 */
export async function callWithRetry<T>(fn: () => Promise<T>, options: RetryOptions): Promise<T> {
  const { maxRetries, baseDelayMs, maxBackoffMs, onRetry } = options;
  let attempt = 0;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    try {
      return await fn();
    } catch (err) {
      const llmErr = err instanceof LLMClientError ? err : null;
      const retryable = llmErr ? llmErr.retryable : true;

      if (llmErr && retryable === false) {
        throw err;
      }
      if (attempt >= maxRetries) {
        throw err;
      }

      let delay: number;
      if (llmErr && llmErr.retryAfterMs != null) {
        delay = Math.min(llmErr.retryAfterMs, maxBackoffMs);
      } else {
        delay = jitteredBackoff(attempt, baseDelayMs, maxBackoffMs);
      }

      if (typeof onRetry === 'function') {
        try { onRetry(llmErr ?? (err as Error), attempt + 1, delay); } catch { /* hook errors must not break the loop */ }
      }

      await sleep(delay);
      attempt += 1;
    }
  }
}
