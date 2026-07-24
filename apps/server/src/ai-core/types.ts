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
  finishReason: 'stop' | 'length' | 'content_filter' | 'error';
  usage: { inputTokens: number; outputTokens: number; cost: number };
  latencyMs: number;
}

export interface StreamChunk {
  content: string;
  finishReason?: 'stop' | 'length' | 'content_filter' | 'error';
}

export enum ModelErrorCode {
  RATE_LIMITED = 'RATE_LIMITED',
  QUOTA_EXCEEDED = 'QUOTA_EXCEEDED',
  CONTEXT_TOO_LONG = 'CONTEXT_TOO_LONG',
  CONTENT_FILTERED = 'CONTENT_FILTERED',
  SERVICE_UNAVAILABLE = 'SERVICE_UNAVAILABLE',
  TIMEOUT = 'TIMEOUT',
  UNKNOWN = 'UNKNOWN',
}

export class ModelClientError extends Error {
  constructor(
    public code: ModelErrorCode,
    public modelId: string,
    message: string,
    public retryable: boolean = true,
  ) {
    super(message);
    this.name = 'ModelClientError';
  }
}

export interface RetryConfig {
  maxRetries: number;
  initialDelayMs: number;
  backoffMultiplier: number;
  retryableCodes: ModelErrorCode[];
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
