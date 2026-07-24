// ========== Model Router Types (§3.1.2) ==========

export type Scene = 'tutoring' | 'grading' | 'explanation' | 'variation' | 'analysis' | 'safety';
export type Subject = 'math' | 'chinese' | 'english';
export type Provider = 'kimi' | 'qwen' | 'gemini' | 'deepseek';
export type Difficulty = 1 | 2 | 3;
export type Track = 'mainline' | 'auxiliary';

export interface RouteRequest {
  scene: Scene;
  subject: Subject;
  difficulty?: Difficulty;
  estimatedInputTokens?: number;
  requiresHeavyReasoning?: boolean;
}

export interface ModelConfig {
  modelId: string;
  provider: Provider;
  baseUrl: string;
  contextWindow: number;
  maxOutputTokens: number;
  costPer1K: { input: number; output: number };
  supportsStreaming: boolean;
}

export interface RouteResult {
  primary: ModelConfig;
  fallback?: ModelConfig;
  reason: string;
}

// ========== Prompt Builder Types (§3.2.3) ==========

export type CapabilityType = 'tutoring' | 'grading' | 'explanation' | 'variation' | 'analysis' | 'fallback';
export type QuestionType = 'proof' | 'calculation' | 'reading' | 'essay' | 'translation';
export type ExplanationMode = 'error_analysis' | 'knowledge_retry';

export interface PromptBuildRequest {
  capability: CapabilityType;
  subject: Subject;
  track?: Track;
  questionType?: QuestionType;
  mode?: ExplanationMode;
  context: PromptContext;
}

export interface PromptContext {
  student: { grade: string; gradeLevel: string };
  cardContent?: string;
  knowledgePoint?: { id: string; name: string; description?: string };
  question?: { content: string; answer?: string; difficulty?: Difficulty; rubric?: string };
  studentAnswer?: string;
  dialogueHistory?: Message[];
  userMessage: string;
  customVariables?: Record<string, unknown>;
}

export interface PromptBuildResult {
  messages: ChatMessage[];
  estimatedTokens: number;
  templateVersion: string;
}

/** LLM API payload message (prompt sent to model). */
export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

// ========== Model Client Types (§3.3.3-§3.3.5) ==========

export interface ChatRequest {
  model: ModelConfig;
  messages: ChatMessage[];
  temperature?: number;
  maxTokens?: number;
  stopSequences?: string[];
  responseFormat?: 'text' | 'json_object';
  timeout?: number;
  stream?: boolean;
}

export interface ChatResponse {
  id: string;
  model: string;
  content: string;
  reasoningContent?: string;          // thinking 内容(reasoner 模型的 reasoning_content 聚合)
  finishReason: 'stop' | 'length' | 'content_filter' | 'error';
  usage: { inputTokens: number; outputTokens: number; cost: number };
  latencyMs: number;
}

export interface StreamChunk {
  content: string;
  reasoningContent?: string;          // 增量 thinking delta(reasoning_content)
  finishReason?: 'stop' | 'length' | 'content_filter' | 'error';
}

// ========== LLM Client Error Hierarchy (§3.3.4, based on ../llm-client.js) ==========

export interface ErrorContext {
  provider: string;
  statusCode: number;          // 0 if no response received
  providerCode: string | null; // provider-specific error code string
  retryable: boolean;
  retryAfterMs: number | null; // parsed Retry-After header, if any
  hint: string;                // human-readable remediation hint
  modelId: string;
}

/** Abstract base for every LLM client error. Subclasses set default retryable. */
export class LLMClientError extends Error {
  provider: string;
  statusCode: number;
  providerCode: string | null;
  retryable: boolean;
  retryAfterMs: number | null;
  hint: string;
  modelId: string;

  constructor(message: string, ctx: ErrorContext) {
    super(message);
    this.name = new.target.name;
    this.provider = ctx.provider;
    this.statusCode = ctx.statusCode;
    this.providerCode = ctx.providerCode;
    this.retryable = ctx.retryable;
    this.retryAfterMs = ctx.retryAfterMs;
    this.hint = ctx.hint;
    this.modelId = ctx.modelId;
  }

  toString(): string {
    return `[${this.name}] provider=${this.provider} status=${this.statusCode} ` +
      `code=${this.providerCode ?? '-'} retryable=${this.retryable} :: ${this.message}`;
  }
}

/** 401 - API key missing/invalid/revoked. Non-retryable. */
export class AuthenticationError extends LLMClientError {
  constructor(ctx: ErrorContext) {
    super(`[${ctx.provider}] Authentication failed (status=${ctx.statusCode}): ${ctx.hint}`, { ...ctx, retryable: false });
  }
}

/** 402 / 429-insufficient_quota / qwen arrearage. Non-retryable. */
export class InsufficientQuotaError extends LLMClientError {
  constructor(ctx: ErrorContext) {
    super(`[${ctx.provider}] Quota or balance exhausted (status=${ctx.statusCode}): ${ctx.hint}`, { ...ctx, retryable: false });
  }
}

/** 403 - account tier/region/model permission denied. Non-retryable. */
export class PermissionError extends LLMClientError {
  constructor(ctx: ErrorContext) {
    super(`[${ctx.provider}] Permission denied (status=${ctx.statusCode}): ${ctx.hint}`, { ...ctx, retryable: false });
  }
}

/** 404 - model name/endpoint not found. Non-retryable. */
export class ResourceNotFoundError extends LLMClientError {
  constructor(ctx: ErrorContext) {
    super(`[${ctx.provider}] Resource not found (status=${ctx.statusCode}): ${ctx.hint}`, { ...ctx, retryable: false });
  }
}

/** 413 - request payload exceeded input-size cap. Non-retryable. (was CONTEXT_TOO_LONG) */
export class RequestTooLargeError extends LLMClientError {
  constructor(ctx: ErrorContext) {
    super(`[${ctx.provider}] Request payload too large (status=${ctx.statusCode}): ${ctx.hint}`, { ...ctx, retryable: false });
  }
}

/** 400/422 - request body failed validation. Non-retryable. */
export class ValidationFailedError extends LLMClientError {
  constructor(ctx: ErrorContext) {
    super(`[${ctx.provider}] Request validation failed (status=${ctx.statusCode}): ${ctx.hint}`, { ...ctx, retryable: false });
  }
}

/** 406 / gemini SAFETY - content safety filtered. Non-retryable. (ai-core extension, llm-client.js has no equivalent) */
export class ContentFilteredError extends LLMClientError {
  constructor(ctx: ErrorContext) {
    super(`[${ctx.provider}] Content filtered (status=${ctx.statusCode}): ${ctx.hint}`, { ...ctx, retryable: false });
  }
}

/** 429 rate limit (retryable body code). Surfaced after retries exhausted. */
export class RateLimitError extends LLMClientError {
  constructor(ctx: ErrorContext) {
    super(`[${ctx.provider}] Rate limit hit (status=${ctx.statusCode}): ${ctx.hint}`, { ...ctx, retryable: true });
  }
}

/** 5xx upstream server failure. Surfaced after retries exhausted. */
export class ServerError extends LLMClientError {
  constructor(ctx: ErrorContext) {
    super(`[${ctx.provider}] Server error (status=${ctx.statusCode}): ${ctx.hint}`, { ...ctx, retryable: true });
  }
}

/** AbortController timeout / network failure. Surfaced after retries exhausted. */
export class TimeoutError extends LLMClientError {
  constructor(ctx: ErrorContext) {
    super(`[${ctx.provider}] Request timed out (status=${ctx.statusCode}): ${ctx.hint}`, { ...ctx, retryable: true });
  }
}

// ========== Retry Options (§3.3.5, based on ../llm-client.js) ==========

export interface RetryOptions {
  maxRetries: number;       // max retry attempts after the first try
  baseDelayMs: number;      // base for exponential backoff
  maxBackoffMs: number;     // upper cap for jittered delay
  onRetry?: (err: LLMClientError | Error, attempt: number, delayMs: number) => void;
}

// ========== Safety Guard Types (§3.4.3) ==========

export interface SafetyCheckRequest {
  studentId: string;
  message: string;
  dialogueHistory: Message[];
  track: Track;
}

export type Classification = 'learning' | 'off_topic' | 'anomaly';
export type AnomalyType = 'emotional' | 'sensitive' | 'abusive';
export type AlertLevel = 'none' | 'info' | 'warning' | 'critical';

export interface SafetyCheckResult {
  isLearningRelated: boolean;
  classification: Classification;
  anomalyType?: AnomalyType;
  alertLevel: AlertLevel;
  shouldBlock: boolean;
  blockResponse?: string;
  alertPayload?: SafetyAlert;
}

export interface SafetyAlert {
  studentId: string;
  level: AlertLevel;
  type: 'off_topic' | 'emotional' | 'sensitive' | 'abusive';
  message: string;
  timestamp: Date;
}

// ========== Response Parser Types (§3.5.3-§3.5.4) ==========

export type ParseMode = 'text' | 'latex' | 'json' | 'hybrid';

export interface ParseRequest {
  rawContent: string;
  mode: ParseMode;
  schema?: object;
  defaultResult?: unknown;
}

export interface ParseResult<T = unknown> {
  success: boolean;
  data: T | null;
  rawText?: string;
  errors?: string[];
}

export interface GradingResult {
  totalScore: number;
  maxScore: number;
  steps: StepGrade[];
  feedback: string;
  suggestions: string[];
  reasoning?: string;                // thinking(reasoning_content), filled by capability (not LLM JSON)
}

export interface StepGrade {
  stepNumber: number;
  description: string;
  score: number;
  maxScore: number;
  isCorrect: boolean;
  comment: string;
  errorType?: 'logic' | 'calculation' | 'format' | 'missing';
}

// ========== Fallback Handler Types (§3.6.3) ==========

export interface FallbackRequest {
  studentId: string;
  dialogueId: string;
  knowledgePoint: { id: string; name: string; subject: Subject };
  question?: { content: string; answer?: string };
  dialogueHistory: Message[];
  track: Track;
}

export interface FallbackResponse {
  type: 'fallback';
  content: string;
  includesCompleteAnswer: true;
  summary: string;
  recommendations: string[];
  reasoning?: string;                // thinking(reasoning_content) for frontend display
}

// ========== Tutoring Types (§4.1.4) ==========

export interface TutoringRequest {
  studentId: string;
  mode: Track;
  cardId?: string;
  knowledgeId?: string;
  message: string;
  attachments?: Attachment[];
  dialogueId?: string;
}

export interface Attachment {
  type: 'image' | 'formula';
  url: string;
  extractedText?: string;
}

export interface TutoringResponse {
  dialogueId: string;
  message: {
    role: 'assistant';
    content: string;
    type: 'socratic' | 'fallback' | 'block' | 'complete';
  };
  reasoning?: string;                // thinking(reasoning_content) for frontend display
  safety: { isLearningRelated: boolean; alertLevel: AlertLevel };
  isFallback: boolean;
  consecutiveFailCount: number;
}

// ========== Grading Types (§4.2.3) ==========

export interface GradingRequest {
  questionId: string;
  questionType: 'proof' | 'calculation' | 'reading' | 'essay' | 'translation';
  subject: Subject;
  questionContent: string;
  standardAnswer?: string;
  rubric?: string;
  maxScore: number;
  studentAnswer: string;
}

// ========== Explanation Types (§4.3.3) ==========

export interface ExplanationRequest {
  mode: 'error_analysis' | 'knowledge_retry';
  studentId: string;
  subject: Subject;
  question: { content: string; answer?: string };
  wrongAnswer: string;
  errorHistory?: { question: string; wrongAnswer: string; attempts: number }[];
  knowledgePoint: { id: string; name: string };
}

// ========== Variation Types (§4.4.4) ==========

export interface VariationRequest {
  originalQuestion: { content: string; answer?: string; difficulty?: Difficulty };
  knowledgePoint: { id: string; name: string };
  count: number;
  targetDifficulty?: Difficulty;
}

export interface VariationQuestion {
  content: string;
  options?: { label: string; text: string; isCorrect: boolean }[];
  answer: string;
  explanation: string;
  difficulty: Difficulty;
  variationType: '换数' | '换场景' | '调整条件' | '组合';
}

export interface VariationResponse {
  variations: VariationQuestion[];
  generatedBy: string;
  reasoning?: string;                // thinking(reasoning_content) for frontend display
}

// ========== Analytics Types (§4.5.2-§4.5.3) ==========

export interface AnalyticsRequest {
  studentId: string;
  subject: Subject;
  period: 'weekly' | 'monthly' | 'semester';
  stats: {
    totalStudyMinutes: number;
    completedLessons: number;
    totalLessons: number;
    accuracyRate: number;
    accuracyTrend: { week: string; rate: number }[];
    topWeakPoints: { knowledgePoint: string; errorCount: number; mastery: number }[];
    streak: number;
    timeDistribution: { label: string; minutes: number }[];
  };
}

export interface AnalyticsResponse {
  reportTitle: string;
  summary: string;
  highlights: { icon: string; title: string; description: string }[];
  weakPointAnalysis: string;
  suggestions: string[];
  encouragement: string;
  reasoning?: string;                // thinking(reasoning_content) for frontend display
}

// ========== Conversation Service Types (§6.1.2) ==========

export interface LoadContextRequest {
  dialogueId: string;
  tokenBudget?: number;
}

export interface LoadContextResponse {
  messages: Message[];
  student: { grade: string; gradeLevel: string; name: string };
  subject: Subject;
  cardContent?: string;
  currentKnowledgePoint?: { id: string; name: string; subject: string };
  currentDifficulty?: Difficulty;
  currentQuestion?: { content: string; answer?: string };
  consecutiveFailCount: number;
  dialogueMetadata: {
    track: Track;
    createdAt: Date;
    messageCount: number;
  };
}

export interface SaveMessageEntry {
  role: 'user' | 'assistant';
  content: string;
  type?: 'socratic' | 'hint' | 'explain' | 'fallback' | 'block';
  model?: string;
  tokenInput?: number;
  tokenOutput?: number;
  latencyMs?: number;
}

// ========== Logging Types (§9.1) ==========

export interface AgentLog {
  timestamp: string;
  traceId: string;
  level: 'debug' | 'info' | 'warn' | 'error';
  component: string;
  action: string;
  input: Record<string, unknown>;
  output: Record<string, unknown>;
  duration: number;
  error?: string;
}

// ========== Message Type (shared) ==========

/** Stored dialogue history entry (conversation state). */
export interface Message {
  role: 'user' | 'assistant' | 'system';
  content: string;
}
