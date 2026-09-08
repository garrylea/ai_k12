// ========== Multimodal Content Parts (Task 14a) ==========

export interface TextPart { type: 'text'; text: string; }
export interface ImagePart { type: 'image_url'; image_url: { url: string }; }
export type ContentPart = TextPart | ImagePart;

/** Coerce Message/ChatMessage content (string | ContentPart[]) to plain text. */
export function contentToText(content: string | ContentPart[]): string {
  if (typeof content === 'string') return content;
  return content.filter(p => p.type === 'text').map(p => (p as TextPart).text).join('\n');
}

// ========== Model Router Types (§3.1.2) ==========

export type Scene = 'tutoring' | 'grading' | 'judgment' | 'explanation' | 'variation' | 'analysis' | 'safety' | 'structuring' | 'hint' | 'transcribe';
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
  hasImage?: boolean;  // Task 14a: when true, route to multimodal model (qwen-vl-max)
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

/** 路由结果模型带 apiKey（registry 快照/新 YAML 路径不再剥离；供 ModelClient 直接取用） */
export type RoutedModel = ModelConfig & { apiKey?: string };

export interface RouteResult {
  primary: RoutedModel;
  fallback?: RoutedModel;
  reason: string;
}

// ========== Prompt Builder Types (§3.2.3) ==========

export type CapabilityType = 'tutoring' | 'grading' | 'judgment' | 'explanation' | 'variation' | 'analysis' | 'fallback' | 'structuring' | 'hint' | 'transcribe';
export type QuestionType = 'proof' | 'calculation' | 'reading' | 'essay' | 'translation';
export type ExplanationMode = 'error_analysis' | 'knowledge_retry' | 'solution';

// ========== Question Structuring Types ==========

export interface QuestionStructuringRequest {
  rawInput: string;           // text or markdown from MinerU
  inputType: 'text' | 'image_markdown';
  studentId: string;
  subjectHint?: string;       // e.g. 'math'
  gradeBand?: string;         // e.g. 'junior'
}

export interface StructuredOption {
  label: string;
  text: string;
  isCorrect: boolean;
}

/**
 * LLM output: raw structured question. subjectId/contentHash/knowledgePointIds
 * are resolved by the consuming ErrorBookService (Task 8), NOT by the LLM.
 */
export interface StructuredQuestion {
  type: 'choice' | 'fill_blank' | 'true_false' | 'short_answer' | 'proof';
  difficulty: 1 | 2 | 3;
  content: string;
  options?: StructuredOption[];
  answer: string;
  explanation: string;
  knowledgePoints: string[];  // names from LLM; service layer resolves to IDs
  quality: 'good' | 'poor';
  qualityIssues?: string[];
}

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

/** LLM API payload message (prompt sent to model). content is string for text-only
 *  or ContentPart[] for multimodal (image_url parts). */
export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string | ContentPart[];
}

// ========== Model Client Types (§3.3.3-§3.3.5) ==========

export interface ChatRequest {
  /** 模型配置；apiKey 可选（DB/路由条目自带，ModelClient 优先于 env） */
  model: RoutedModel;
  messages: ChatMessage[];
  temperature?: number;
  maxTokens?: number;
  stopSequences?: string[];
  responseFormat?: 'text' | 'json_object';
  timeout?: number;
  stream?: boolean;
  signal?: AbortSignal;  // caller-controlled abort (e.g. client disconnect) combined with timeout
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

// Streaming event yielded by capability streaming methods (e.g. tutorStream)
// and forwarded to the frontend over SSE. `delta` appends; when `replace` is
// true the frontend SETS content to `delta` (used to strip the structured-
// question JSON block after the stream completes).
export interface StreamEvent {
  type: 'reasoning' | 'content' | 'done' | 'error' | 'flow';
  delta?: string;
  replace?: boolean;
  fallback?: boolean;
  structuredQuestion?: StructuredQuestionOutput;  // surfaced on `done` for ingestion
  message?: string;                   // error detail (human-readable)
  code?: number;                      // error code (see mapLLMErrorToClient) - error events only
  retryable?: boolean;                // whether the frontend should offer a retry button - error events only
  // flow event fields (P1 image two-stage):
  stage?: 'select' | 'confirm' | 'unrecognizable';  // flow step
  problems?: TranscribedProblem[];                  // stage='select' - the transcribed problems
  question?: string;                                // stage='confirm' - the transcribed problem text
}

/** P1: a problem transcribed from an image by the VL model. */
export interface TranscribedProblem {
  index: number;  // 1-based
  text: string;   // problem text (geometry figure descriptions in parentheses)
}

/** P1: VL transcription output (JSON from qwen3-vl-plus). */
export interface TranscribeResult {
  recognizable: boolean;
  problems: TranscribedProblem[];
}

/** P1: selection classification (JSON from deepseek-v4-flash). */
export interface SelectionClassification {
  intent: 'select' | 'all' | 'unclear';
  index?: number;  // 1-based, when intent='select'
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
  // True when an image attachment is present. A photo of a problem is
  // inherently learning-related, so off_topic keyword classification is
  // relaxed when this is true (anomaly/abuse text still blocks).
  hasImage?: boolean;
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
  retry?: boolean;        // P2: true when regenerating after an error - skip
                          // re-persisting the (already-stored) user message.
  flowAction?: 'confirm' | 'reidentify' | 'correct';  // P1: image two-stage actions
}

export interface Attachment {
  type: 'image' | 'file';
  url: string;
  imageUrl?: string;          // base64 data URL for multimodal LLM input (image only)
  extractedText?: string;     // text content for txt/md/pdf attachments
  extractedImages?: string[]; // PDF extracted image paths (for routing to multimodal model)
  fileId?: string;            // reference to uploaded_files row
  fileName?: string;          // original file name (derived from uploaded_files.url basename)
}

/** Structured question output from the tutoring model (Task 14a). The model
 *  appends this as a JSON block at the end of its Socratic reply; the backend
 *  extracts it and ingests into the questions bank (dedup via content_hash).
 *  Uses the same StructuredOption type as StructuredQuestion for choice questions.
 */
export interface StructuredQuestionOutput {
  type: 'choice' | 'fill_blank' | 'true_false' | 'short_answer' | 'proof';
  difficulty: 1 | 2 | 3;
  content: string;
  options?: StructuredOption[];
  answer: string;
  explanation: string;
  knowledgePoints: string[];
  quality: 'good' | 'poor';
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
  structuredQuestion?: StructuredQuestionOutput;  // Task 14a: extracted from model reply
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

// ========== Judgment Types (对错判定, 非判分) ==========

export interface JudgmentRequest {
  questionContent: string;
  standardAnswer: string;
  reference: string;
  studentAnswer: string;
  subject: Subject;
  questionType: 'proof' | 'calculation';
}

export interface JudgmentResult {
  isCorrect: boolean;
  analysis: string;
  errorType?: 'logic' | 'calculation' | 'format' | 'missing' | null;
  reasoning?: string;
}

// ========== Explanation Types (§4.3.3) ==========

export interface ExplanationRequest {
  mode: 'error_analysis' | 'knowledge_retry' | 'solution';
  studentId: string;
  subject: Subject;
  question: { content: string; answer?: string };
  wrongAnswer: string;
  errorHistory?: { question: string; wrongAnswer: string; attempts: number }[];
  knowledgePoint: { id: string; name: string };
}

// ========== Hint Types (课堂练习提示 - 苏格拉底式启发，不给答案) ==========

export interface HintRequest {
  questionContent: string;
  subject: Subject;
}

export interface HintResponse {
  content: string;
  reasoning?: string;                // thinking(reasoning_content) for frontend display
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
  flowState: 'idle' | 'awaiting_selection' | 'awaiting_confirmation';
  pendingQuestion: string | null;
  pendingQuestions: string | null;
  dialogueMetadata: {
    track: Track;
    createdAt: Date;
    messageCount: number;
  };
}

export interface SaveMessageEntry {
  role: 'user' | 'assistant';
  content: string | ContentPart[];  // DB stores text only; ConversationService coerces arrays to text
  reasoning?: string;               // thinking(reasoning_content) - persisted for history replay
  type?: 'socratic' | 'hint' | 'explain' | 'fallback' | 'block' | 'transcription';
  model?: string;
  tokenInput?: number;
  tokenOutput?: number;
  latencyMs?: number;
  // Durable attachment URLs (e.g. /uploads/xxx.jpg) to persist alongside the
  // message so history can re-render images. Base64 data URLs are NOT stored
  // here (too large) - only the server URL.
  attachments?: { type: 'image'; url: string }[];
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

/** Stored dialogue history entry (conversation state). content is string for
 *  text-only messages or ContentPart[] for multimodal (image_url parts).
 *  DB stores text only; ConversationService coerces arrays to text on save. */
export interface Message {
  role: 'user' | 'assistant' | 'system';
  content: string | ContentPart[];
}
