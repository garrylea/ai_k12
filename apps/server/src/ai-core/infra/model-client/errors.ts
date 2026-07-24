import { ModelClientError, ModelErrorCode } from '../../types.js';

/**
 * Map an HTTP status code from a provider API to a ModelClientError with the
 * appropriate ModelErrorCode. Shared by all provider adapters so that
 * ModelClient can decide retryability via retryableCodes (rather than retrying
 * every error blindly).
 */
export function mapHttpError(provider: string, status: number, body: string, modelId: string): ModelClientError {
  const message = `${provider} API error ${status}: ${body}`;
  let code: ModelErrorCode;
  if (status === 429) code = ModelErrorCode.RATE_LIMITED;
  else if (status === 401 || status === 403) code = ModelErrorCode.QUOTA_EXCEEDED;
  else if (status === 413) code = ModelErrorCode.CONTEXT_TOO_LONG;
  else if (status === 406) code = ModelErrorCode.CONTENT_FILTERED;
  else if (status >= 500) code = ModelErrorCode.SERVICE_UNAVAILABLE;
  else code = ModelErrorCode.UNKNOWN;
  return new ModelClientError(code, modelId, message);
}
