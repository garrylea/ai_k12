import type { ClientState, EndReason, HiddenReason } from '@/analytics/types';

const API_BASE = '/api';

export interface ApiResponse<T> {
  code: number;
  message: string;
  data: T;
  retryable?: boolean;  // present on AI/LLM error responses (see mapLLMErrorToClient)
}

export class ApiError extends Error {
  code: number;
  retryable?: boolean;
  /** HTTP 状态码（业务码 `code` 之外的原始信号）。网络层失败（DNS/断网）没有响应，为 undefined。
   *  调用方用它区分「客户端 4xx，重试也不会好」与「5xx / 网络抖动，可重试」。 */
  status?: number;
  constructor(code: number, message: string, retryable?: boolean, status?: number) {
    super(message);
    this.code = code;
    this.retryable = retryable;
    this.status = status;
    this.name = 'ApiError';
  }
}

async function fetchApi<T>(path: string, options?: RequestInit): Promise<T> {
  const token = localStorage.getItem('token');
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...(options?.headers as Record<string, string>),
  };
  if (token) {
    headers['Authorization'] = `Bearer ${token}`;
  }

  const res = await fetch(`${API_BASE}${path}`, { ...options, headers });
  const json: ApiResponse<T> = await res.json();

  if (json.code !== 0) {
    throw new ApiError(json.code, json.message, json.retryable, res.status);
  }

  return json.data;
}

// --- Auth ---

export type UserRole = 'admin' | 'parent' | 'student';

export interface LoginResult {
  token: string;
  user: {
    id: number;
    role: UserRole;
    name: string | null;
    username?: string;
    grade?: string | null;
    phone?: string;
    parentId?: number;
  };
}

export function login(username: string, password: string): Promise<LoginResult> {
  return fetchApi<LoginResult>('/auth/login', {
    method: 'POST',
    body: JSON.stringify({ username, password }),
  });
}

/** 家长注册（注册即登录）。 */
export function registerParent(phone: string, password: string, name?: string): Promise<LoginResult> {
  return fetchApi<LoginResult>('/auth/register', {
    method: 'POST',
    body: JSON.stringify({ phone, password, name: name || undefined }),
  });
}

// --- Parent: student accounts ---

export interface MyStudentItem {
  id: number;
  parentId: number;
  username: string;
  name: string;
  age: number | null;
  grade: string | null;
  schoolLevel: string | null;
  isActive: boolean;
}

export function listMyStudents(): Promise<MyStudentItem[]> {
  return fetchApi<MyStudentItem[]>('/parent/students');
}

export function createStudent(req: {
  name: string;
  username: string;
  password: string;
  age: number;
  grade: string;
}): Promise<{ id: number }> {
  return fetchApi<{ id: number }>('/parent/students', {
    method: 'POST',
    body: JSON.stringify(req),
  });
}

export function resetStudentPassword(id: number, newPassword: string): Promise<null> {
  return fetchApi<null>(`/parent/students/${id}/reset-password`, {
    method: 'PATCH',
    body: JSON.stringify({ newPassword }),
  });
}

export function setStudentStatus(id: number, isActive: boolean): Promise<null> {
  return fetchApi<null>(`/parent/students/${id}/status`, {
    method: 'PATCH',
    body: JSON.stringify({ isActive }),
  });
}

// --- Parent: student subject configs（按学科配置教材：年级/册别/版本） ---

export interface SubjectConfigVersionOption {
  id: number;
  name: string;
  publisher: string | null;
  edition: string;
  gradeBand: string;
  terms: string[];
}

export interface SubjectConfigGradeOption {
  code: string;
  label: string;
  versions: SubjectConfigVersionOption[];
}

export interface SubjectConfigOption {
  subjectId: number;
  subjectName: string;
  grades: SubjectConfigGradeOption[];
}

export interface SubjectConfigState {
  subjectId: number;
  subjectName: string;
  configured: boolean;
  started: boolean;
  gradeCode: string | null;
  term: string | null;
  textbookVersionId: number | null;
  publisher: string | null;
  edition: string;
}

export interface SubjectConfigsResponse {
  studentId: number;
  studentName: string | null;
  subjects: SubjectConfigState[];
  options: SubjectConfigOption[];
}

export function getStudentSubjectConfigs(studentId: number): Promise<SubjectConfigsResponse> {
  return fetchApi<SubjectConfigsResponse>(`/parent/students/${studentId}/subject-configs`);
}

export function updateStudentSubjectConfig(
  studentId: number,
  subjectId: number,
  req: { gradeCode: string; term: 'first' | 'second'; textbookVersionId?: number },
): Promise<{ subjectId: number; textbookVersionId: number; semesterId: number; reset: boolean }> {
  return fetchApi(`/parent/students/${studentId}/subject-configs/${subjectId}`, {
    method: 'PUT',
    body: JSON.stringify(req),
  });
}

// --- Content ---

export interface SubjectItem {
  id: number;
  name: string;
  code: string;
  gradeBands: string[];
}

export function fetchSubjects(): Promise<SubjectItem[]> {
  return fetchApi<SubjectItem[]>('/content/subjects');
}

export interface VersionItem {
  id: number;
  subjectId: number;
  name: string;
  code: string;
  publisher: string | null;
  edition: string;
}

export function fetchVersions(subjectId: number): Promise<VersionItem[]> {
  return fetchApi<VersionItem[]>(`/content/versions?subjectId=${subjectId}`);
}

// --- Progress (Star Map) ---

export interface SectionData {
  id: string;
  title: string;
  order: number;
  knowledgePointCount: number;
  status: 'completed' | 'current' | 'locked';
  progress: number;
}

export interface ChapterData {
  id: string;
  title: string;
  order: number;
  importance: 'large' | 'medium' | 'small';
  status: 'completed' | 'current' | 'locked';
  progress: number;
  sections: SectionData[];
}

export interface StarMapData {
  subjectName: string;
  gradeName: string;
  publisher: string;
  totalUnits: number;
  completedUnits: number;
  chapters: ChapterData[];
}

export function fetchStarMap(studentId: number, subjectId: number): Promise<StarMapData> {
  return fetchApi<StarMapData>(
    `/progress/students/${studentId}/star-map?subjectId=${subjectId}`,
  );
}

// --- Lesson cards (P2.2 课程详情/卡片阅读) ---

export interface CardImage {
  url: string;
  alt?: string;
  position?: string;
}

export interface PracticeQuestionMeta {
  n: number;
  text: string;
}

export interface PracticeGroupMeta {
  intro?: string;
  questions: PracticeQuestionMeta[];
}

export interface CardMetadata {
  images?: CardImage[];
  layout_hint?: string;
  override_scroll?: 'allow' | 'disable';
  /** Practice-specific fields (populated by data-refinery for practice cards) */
  groups?: PracticeGroupMeta[];
  needs_fallback?: boolean;
}

export interface LessonCard {
  id: number;
  sortOrder: number;
  cardType: 'concept' | 'example' | 'practice' | 'explore' | 'summary' | 'reading';
  title: string | null;
  content: string;
  metadata: CardMetadata | null;
  textbookPage: string | null;
}

export interface LessonCardsData {
  lessonId: number;
  lessonName: string;
  totalCards: number;
  cards: LessonCard[];
}

export function fetchLessonCards(lessonId: number): Promise<LessonCardsData> {
  return fetchApi<LessonCardsData>(`/content/lessons/${lessonId}/cards`);
}

// --- Uncleared Errors (错题清零：进每节课前清空错题本里所有 practice 未清题) ---

export interface PreviousErrorDetail {
  errorBookId: number;
  cardId: number;
  questionN: string;
  questionText: string;
  questionId: number | null;
  /** 卡片所属课的 lesson_id（cards.lesson_id，可能为 null）。 */
  lessonId: number | null;
}

export interface UnclearedErrorsResult {
  errors: PreviousErrorDetail[];
}

/** 取学生某学科所有未清 practice 错题（计数 = errors.length，与详情同源）。
 * 传 lessonId 时只返回「当前课之前」的错题——本课练习刚产生的错题不触发清零门禁。 */
export function getUnclearedErrors(subjectId: number, lessonId?: number | string): Promise<UnclearedErrorsResult> {
  const lessonQuery = lessonId !== undefined && lessonId !== null && lessonId !== ''
    ? `&lessonId=${lessonId}` : '';
  return fetchApi<UnclearedErrorsResult>(`/practice/uncleared-errors?subjectId=${subjectId}${lessonQuery}`);
}

export function bumpErrorLevels(errorBookIds: number[]): Promise<void> {
  return fetchApi<void>('/practice/bump-error-levels', {
    method: 'POST',
    body: JSON.stringify({ errorBookIds }),
  });
}

/**
 * `POST /api/progress/update` 追加的可选积分反馈（计划一新增，向后兼容：
 * 老后端不返回该字段时 `points === undefined`）。
 * 幂等命中 / 无规则时 `awarded === 0`——**不是错误**，静默处理。
 *
 * 由服务端 `toPointsAwardDto` 产出（`progress/update` 与 `exams/submit` 共用）：
 * 发分失败时它整体返回 `undefined`，JSON 里**没有 `points` 键**，因此这里的 `balance`
 * 是**非空 number**——`balance: null` 只属于会话完成端点（`CompleteTrainingSessionResult`）。
 */
export interface UpdateProgressPoints {
  awarded: number;
  balance: number;
  /** 段位 code 字符串（不是对象）；非空表示本次升级，庆祝交给全屏 `CelebrationOverlay` */
  levelUp: { from: string; to: string } | null;
}

export function updateProgress(data: { subjectId: number; lessonId: number; cardSortOrder: number }): Promise<{ advanced: boolean; nextLessonId?: number; completed?: boolean; nextUnlockType?: string; reason?: string; currentLessonId?: number; points?: UpdateProgressPoints }> {
  return fetchApi<{ advanced: boolean; nextLessonId?: number; completed?: boolean; nextUnlockType?: string; reason?: string; currentLessonId?: number; points?: UpdateProgressPoints }>('/progress/update', {
    method: 'POST',
    body: JSON.stringify(data),
  });
}

// --- Files (auxiliary upload) ---

export interface UploadedFileResult {
  fileId: number;
  url: string;
  taskId?: number;  // PDF extraction task ID returned by backend for PDF files
}

export async function uploadFile(file: File, signal?: AbortSignal): Promise<UploadedFileResult> {
  const token = localStorage.getItem('token');
  const form = new FormData();
  form.append('file', file);
  const res = await fetch(`${API_BASE}/files/upload`, {
    method: 'POST',
    headers: token ? { Authorization: `Bearer ${token}` } : {},
    // NOTE: do NOT set Content-Type - browser sets multipart boundary
    body: form,
    signal,
  });
  const json: ApiResponse<UploadedFileResult> = await res.json();
  if (json.code !== 0) throw new ApiError(json.code, json.message, json.retryable, res.status);
  return json.data;
}

// --- Conversations (auxiliary) ---

// 会话场景分型：与后端 ai_dialogues.scene 对应，用于按系统隔离对话历史。
export type AiConversationScene = 'aux_qna' | 'aux_training' | 'mainline_question' | 'mainline_card';

export interface ConversationItem {
  id: number;
  track: 'mainline' | 'auxiliary';
  scene: AiConversationScene;
  title: string | null;
  status: string;
  created_at: string;
}

export function createConversation(req: {
  track: 'mainline' | 'auxiliary';
  scene?: AiConversationScene;
  subjectId?: number;
  knowledgePointId?: number;
  cardId?: number;
  // 训练讲一讲：按题锚定 + 题面锚消息（scene='aux_training' 时用）
  questionId?: number;
  questionText?: string;
}): Promise<ConversationItem> {
  return fetchApi<ConversationItem>('/conversations', {
    method: 'POST',
    body: JSON.stringify(req),
  });
}

export function listConversations(
  track: 'auxiliary',
  scene: AiConversationScene,
  cursor?: number,
): Promise<ConversationItem[]> {
  const qs = cursor ? `?track=${track}&scene=${scene}&cursor=${cursor}` : `?track=${track}&scene=${scene}`;
  return fetchApi<ConversationItem[]>(`/conversations${qs}`);
}

// Fetch ALL conversations by walking the cursor-paginated list endpoint
// (backend ConversationsService.PAGE_SIZE = 10, ORDER BY id DESC, cursor = id).
// Used by the sidebar so the "展开全部" button can reveal history beyond the
// first page. Capped at 50 pages (500 items) as a safety valve against a
// runaway loop; a K12 student won't approach that.
export async function listAllConversations(track: 'auxiliary', scene: AiConversationScene): Promise<ConversationItem[]> {
  const PAGE = 10;
  const all: ConversationItem[] = [];
  let cursor: number | undefined;
  for (let i = 0; i < 50; i++) {
    const page = await listConversations(track, scene, cursor);
    all.push(...page);
    if (page.length < PAGE) break;
    cursor = page[page.length - 1].id;
  }
  return all;
}

export function renameConversation(id: number, title: string): Promise<void> {
  return fetchApi<void>(`/conversations/${id}`, {
    method: 'PATCH',
    body: JSON.stringify({ title }),
  });
}

export function deleteConversation(id: number): Promise<void> {
  return fetchApi<void>(`/conversations/${id}`, { method: 'DELETE' });
}

export interface MessageItem {
  id: number;
  dialogue_id: number;
  role: 'system' | 'user' | 'assistant';
  content: string;
  reasoning: string | null;
  type: string | null;
  attachments: string | null;
  created_at: string;
}

export function getMessages(dialogueId: number, lastMessageId?: number): Promise<MessageItem[]> {
  const qs = lastMessageId ? `?lastMessageId=${lastMessageId}` : '';
  return fetchApi<MessageItem[]>(`/conversations/${dialogueId}/messages${qs}`);
}

export function deleteMessage(dialogueId: number, messageId: number): Promise<void> {
  return fetchApi(`/conversations/${dialogueId}/messages/${messageId}`, { method: 'DELETE' });
}

// --- AI Tutor (auxiliary) ---

export interface AttachmentRequest {
  type: 'image' | 'file';
  fileId: string;
  taskId?: number;  // PDF extraction task ID
}

export interface TutorResponse {
  dialogueId: string;
  message: { role: string; content: string; type?: string };
  reasoning?: string;
  safety: { isLearningRelated: boolean; alertLevel: string };
  fallback: boolean;
  consecutiveFailCount: number;
}

export function tutor(req: {
  mode: 'mainline' | 'auxiliary';
  message: string;
  dialogueId?: string;
  knowledgeId?: string;
  cardId?: string;
  attachments?: AttachmentRequest[];
  retry?: boolean;  // P2: regenerate after error - skip re-persisting the user message
}): Promise<TutorResponse> {
  return fetchApi<TutorResponse>('/ai/tutor', {
    method: 'POST',
    body: JSON.stringify(req),
  });
}

// SSE 流式辅导（/ai/tutor/stream）。复用于辅线答疑（useAuxChat）与主线课堂讨论
// （useDiscussChat）。消费 reasoning/content(含 replace)/done/error 事件。
export interface TutorStreamRequest {
  mode: 'mainline' | 'auxiliary';
  message: string;
  dialogueId?: string;
  cardId?: string;
  knowledgeId?: string;
  attachments?: AttachmentRequest[];
}

export interface TutorStreamEvent {
  type: 'reasoning' | 'content' | 'done' | 'error';
  delta?: string;
  replace?: boolean;
  message?: string;
}

export async function* streamTutorEvents(
  req: TutorStreamRequest,
  signal?: AbortSignal,
): AsyncIterable<TutorStreamEvent> {
  const token = localStorage.getItem('token') ?? '';
  const res = await fetch(`${API_BASE}/ai/tutor/stream`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(req),
    signal,
  });
  if (!res.ok || !res.body) throw new Error('stream unavailable');

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop() ?? '';
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed.startsWith('data: ')) continue;
      try {
        yield JSON.parse(trimmed.slice(6)) as TutorStreamEvent;
      } catch {
        // skip non-JSON lines
      }
    }
  }
  // Flush the final partial line so we don't silently drop the last event
  // (e.g. a { type: 'done' } not terminated by \n).
  buffer += decoder.decode();
  if (buffer.trim().startsWith('data: ') && buffer.trim() !== 'data: [DONE]') {
    try { yield JSON.parse(buffer.trim().slice(6)) as TutorStreamEvent; } catch { /* skip */ }
  }
}

// --- Refinery (auxiliary extraction) ---

export function extract(req: { fileId: number; source: 'auxiliary' }): Promise<{ taskId: number }> {
  return fetchApi<{ taskId: number }>('/refinery/extract', {
    method: 'POST',
    body: JSON.stringify(req),
  });
}

export interface ExtractTaskResult {
  id: number;
  status: 'pending' | 'processing' | 'completed' | 'failed';
  result: { markdown: string; structured: unknown } | null;
  errorMessage: string | null;
}

export function getExtractTask(taskId: number): Promise<ExtractTaskResult> {
  return fetchApi<ExtractTaskResult>(`/refinery/tasks/${taskId}`);
}

// SSE 监听 MinerU 提取结果（替代轮询 GET /api/refinery/tasks/:taskId）
export async function* streamExtraction(
  taskId: number,
  signal?: AbortSignal,
): AsyncIterable<{ type: 'done' | 'error'; message?: string }> {
  const token = localStorage.getItem('token') ?? '';
  const res = await fetch(`${API_BASE}/refinery/tasks/${taskId}/stream`, {
    headers: token ? { Authorization: `Bearer ${token}` } : {},
    signal,
  });
  if (!res.ok || !res.body) throw new Error('extraction stream unavailable');

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop() ?? '';
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed.startsWith('data: ') || trimmed === 'data: [DONE]') continue;
      try {
        yield JSON.parse(trimmed.slice(6));
      } catch {
        // skip non-JSON lines
      }
    }
  }
  // Flush any final partial line + decoder state so we don't silently drop
  // the last event (e.g. a { type: 'done' } not terminated by \n).
  buffer += decoder.decode(); // flush decoder state
  if (buffer.trim().startsWith('data: ') && buffer.trim() !== 'data: [DONE]') {
    try { yield JSON.parse(buffer.trim().slice(6)); } catch { /* skip */ }
  }
}

// --- Practice (mainline 课堂练习判对错) ---

export interface JudgeResult {
  questionId: number | null;
  /** null = 未判定（主观题待自评 / 客观题空答案不计对错） */
  isCorrect: boolean | null;
  method: 'exact' | 'ai' | 'self_assess' | 'unanswered';
  errorType?: 'logic' | 'calculation' | 'format' | 'missing' | null;
  errorBookId?: number;
  /** 主观题 self_assess 模式：渲染自评 UI，参考答案/解析随判题返回 */
  needsSelfAssessment?: boolean;
  referenceAnswer?: string | null;
  explanation?: string | null;
  /** 客观题空答案：不计对错（中性展示） */
  noStandardAnswer?: boolean;
  /**
   * 本次**实际入账**的积分（甲类逐目标发分）。`0 = 本次没加`：答错 / `source='exam'` /
   * 未清掉任何错题（`not_cleared`）/ 无题库身份（`questionId=null`）/ 幂等命中
   * （`duplicate`，本次未入账）/ 已达上限（`daily_limit`）/ `no_rule` / `tier_inactive` /
   * 发分失败。**只有 `> 0` 才弹「+N 分」轻反馈。**
   */
  pointsAwarded: number;
  /**
   * 未发分原因，**缺省 = 静默**。`duplicate`（幂等命中）刻意不在枚举内——本次没入账，
   * 一律按 0 静默处理，不能弹假 `+N 分`（openapi `PointsAwardReason`）。
   */
  awardReason?: PointsAwardReason;
}

export function judgePractice(payload: {
  cardId: number;
  lessonId: number;
  subjectId: number;
  questionN: string;
  questionText: string;
  studentAnswer: string;
}): Promise<JudgeResult> {
  return fetchApi<JudgeResult>('/practice/judge', {
    method: 'POST',
    body: JSON.stringify(payload),
  });
}

// --- Practice results（课堂练习判题结果持久化） ---

export interface PracticeResult {
  questionN: string;
  questionText: string;
  studentAnswer: string;
  isCorrect: boolean;
  method: 'exact' | 'ai';
  errorType: 'logic' | 'calculation' | 'format' | 'missing' | null;
}

export function getPracticeResults(cardId: number): Promise<PracticeResult[]> {
  return fetchApi<PracticeResult[]>(`/practice/results?cardId=${cardId}`);
}

export function resetPracticeCard(cardId: number): Promise<void> {
  return fetchApi<void>(`/practice/results?cardId=${cardId}`, { method: 'DELETE' });
}

export function resetPracticeLesson(lessonId: number): Promise<void> {
  return fetchApi<void>(`/practice/results?lessonId=${lessonId}`, { method: 'DELETE' });
}

// --- Practice hint (课堂练习提示 - AI 生成 + Card 级缓存) ---

export interface HintResult {
  hint: string;
  /** true = 命中后端 cards.hints 缓存直返；false = 本次 AI 新生成并已写回缓存。 */
  cached: boolean;
}

export function getPracticeHint(payload: {
  cardId: number;
  lessonId: number;
  subjectId: number;
  questionText: string;
}): Promise<HintResult> {
  return fetchApi<HintResult>('/practice/hint', {
    method: 'POST',
    body: JSON.stringify(payload),
  });
}

// --- Practice discuss (课堂练习「让 AI 讲一讲」- 苏格拉底讨论) ---
// 打开讨论即：① 记入主线错题本（幂等）；② 创建带 card_id 的 mainline 对话。
// 前端拿到 dialogueId 后走 streamTutorEvents（mode='mainline'）做苏格拉底讨论。

export interface DiscussStartResult {
  /** mainline 对话 id，喂给 streamTutorEvents。 */
  dialogueId: string;
  /** 本次命中或新建的错题本记录 id。 */
  errorBookId: number;
  /** 题库中的题目 id（未命中为 null）。 */
  questionId: number | null;
}

export function startDiscuss(payload: {
  cardId: number;
  lessonId: number;
  subjectId: number;
  questionText: string;
}): Promise<DiscussStartResult> {
  return fetchApi<DiscussStartResult>('/practice/discuss', {
    method: 'POST',
    body: JSON.stringify(payload),
  });
}

// 卡片级「思辨答疑」：find-or-create 该学生在该卡片的 mainline 对话。
// 与题目级区别：讨论整张卡片（非某题）、不入错题本，故只返回 dialogueId。
export function startCardDiscuss(payload: {
  cardId: number;
  lessonId: number;
  subjectId: number;
}): Promise<{ dialogueId: string }> {
  return fetchApi<{ dialogueId: string }>('/practice/discuss-card', {
    method: 'POST',
    body: JSON.stringify(payload),
  });
}

// --- Admin: models & routes ---
export interface AdminModelItem {
  modelKey: string; name: string; providerType: string; modelId: string;
  baseUrl: string; apiKeyMasked: string; contextWindow: number; maxOutputTokens: number; isEnabled: boolean;
}
export function listAdminModels(): Promise<AdminModelItem[]> { return fetchApi('/admin/models'); }
export function createAdminModel(req: { modelKey: string; name: string; providerType: string; modelId: string; baseUrl: string; apiKey: string; contextWindow?: number; maxOutputTokens?: number }): Promise<null> {
  return fetchApi('/admin/models', { method: 'POST', body: JSON.stringify(req) });
}
export function updateAdminModel(modelKey: string, req: Partial<{ name: string; providerType: string; modelId: string; baseUrl: string; apiKey: string }>): Promise<null> {
  return fetchApi(`/admin/models/${modelKey}`, { method: 'PATCH', body: JSON.stringify(req) });
}
export function setAdminModelStatus(modelKey: string, isEnabled: boolean): Promise<null> {
  return fetchApi(`/admin/models/${modelKey}/status`, { method: 'PATCH', body: JSON.stringify({ isEnabled }) });
}
export interface AdminRouteItem { scene: string; subject: string; primaryModelKey: string; fallbackModelKey: string | null; }
export function listAdminRoutes(): Promise<{ routes: AdminRouteItem[]; scenes: string[]; providerTypes: string[] }> { return fetchApi('/admin/routes'); }
export function saveAdminRoutes(routes: AdminRouteItem[]): Promise<null> {
  return fetchApi('/admin/routes', { method: 'PUT', body: JSON.stringify({ routes }) });
}
export function validateModelConnection(modelKey: string): Promise<{ ok: boolean; latencyMs: number; sample: string }> {
  return fetchApi('/admin/routes/validate-connection', { method: 'POST', body: JSON.stringify({ modelKey }) });
}

// --- Admin: accounts ---
export interface AdminParentItem { id: number; phone: string; name: string | null; isActive: boolean; studentCount: number; createdAt: string; }
export function searchParents(search: string): Promise<AdminParentItem[]> { return fetchApi(`/admin/parents?search=${encodeURIComponent(search)}`); }
export function setParentStatus(id: number, isActive: boolean): Promise<null> {
  return fetchApi(`/admin/parents/${id}/status`, { method: 'PATCH', body: JSON.stringify({ isActive }) });
}
export interface AdminStudentItem { id: number; username: string; name: string; grade: string | null; isActive: boolean; parentId: number; }
export function searchStudents(search: string): Promise<AdminStudentItem[]> { return fetchApi(`/admin/students?search=${encodeURIComponent(search)}`); }
export function setStudentStatusAdmin(id: number, isActive: boolean): Promise<null> {
  return fetchApi(`/admin/students/${id}/status`, { method: 'PATCH', body: JSON.stringify({ isActive }) });
}

// --- Admin: messages ---
export function sendAdminMessage(req: { type: string; title: string; content: string; parentId?: number }): Promise<null> {
  return fetchApi('/admin/messages', { method: 'POST', body: JSON.stringify(req) });
}
export interface AdminMessageItem { id: number; type: string; title: string; isBroadcast: boolean; reachCount: number; readCount: number; createdAt: string; }
export function listAdminMessages(): Promise<AdminMessageItem[]> { return fetchApi('/admin/messages'); }
export function deleteAdminMessage(id: number): Promise<null> { return fetchApi(`/admin/messages/${id}`, { method: 'DELETE' }); }

// --- Admin: notifications（系统通知，如题解生成失败待人工补） ---
export interface AdminNotificationItem {
  id: number;
  type: string;
  questionId: number | null;
  title: string;
  content: string;
  isRead: boolean;
  createdAt: string;
}
export function listAdminNotifications(): Promise<AdminNotificationItem[]> { return fetchApi('/admin/notifications'); }
export function adminNotificationsUnreadCount(): Promise<number> { return fetchApi('/admin/notifications/unread-count'); }
export function markAdminNotificationRead(id: number): Promise<null> {
  return fetchApi(`/admin/notifications/${id}/read`, { method: 'POST' });
}

// --- Admin: chat ---
export function createAdminDialogue(modelKey: string): Promise<{ id: number }> {
  return fetchApi('/admin/chat/dialogues', { method: 'POST', body: JSON.stringify({ modelKey }) });
}
export function listAdminDialogues(): Promise<Array<{ id: number; modelKey: string; title: string | null; updatedAt: string }>> { return fetchApi('/admin/chat/dialogues'); }
export function deleteAdminDialogue(id: number): Promise<null> { return fetchApi(`/admin/chat/dialogues/${id}`, { method: 'DELETE' }); }
export interface AdminChatMessage { id: number; role: 'user' | 'assistant'; content: string; reasoning: string | null; }
export function listAdminChatMessages(dialogueId: number): Promise<AdminChatMessage[]> {
  return fetchApi(`/admin/chat/messages?dialogueId=${dialogueId}`);
}
export async function* streamAdminChat(dialogueId: number, message: string): AsyncGenerator<{ type: string; delta?: string; code?: number; message?: string }> {
  const token = localStorage.getItem('token');
  const res = await fetch('/api/admin/chat/stream', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify({ dialogueId, message }),
  });
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    const parts = buf.split('\n\n');
    buf = parts.pop() ?? '';
    for (const p of parts) {
      if (p.startsWith('data: ')) yield JSON.parse(p.slice(6));
    }
  }
}

// --- Admin: dashboard & password ---
export interface AdminDashboard {
  parentCount: number; studentCount: number; todayAiCalls: number; enabledModelCount: number;
  recentParents: AdminParentItem[];
}
export function fetchAdminDashboard(): Promise<AdminDashboard> { return fetchApi('/admin/dashboard'); }
export function changeAdminPassword(oldPassword: string, newPassword: string): Promise<null> {
  return fetchApi('/admin/password', { method: 'PATCH', body: JSON.stringify({ oldPassword, newPassword }) });
}

// --- Admin: 预警数据（保留期清理） ---
export interface AdminAlertRetentionPreview {
  /** 固定 30（后端常量，接口不带参数）。 */
  retentionDays: number;
  /** `created_at < cutoff` 的预警会被清理；ISO 字符串。 */
  cutoff: string;
  total: number;
  unread: number;
}
export interface AdminAlertPurgeResult {
  retentionDays: number;
  cutoff: string;
  deleted: number;
}
/** 预览：有多少条 30 天前的预警（含未读）。 */
export function getExpiredAlertStats(): Promise<AdminAlertRetentionPreview> {
  return fetchApi('/admin/alerts/expired');
}
/** 执行清理：物理删除 30 天前的预警（含未读）。 */
export function purgeExpiredAlerts(): Promise<AdminAlertPurgeResult> {
  return fetchApi('/admin/alerts/expired', { method: 'DELETE' });
}

// --- Parent: messages ---
export interface ParentMessageItem { id: number; type: string; title: string; content: string; isRead: boolean; isBroadcast: boolean; createdAt: string; }
export function listMyMessages(): Promise<ParentMessageItem[]> { return fetchApi('/parent/messages'); }
export function getUnreadMessageCount(): Promise<number> { return fetchApi('/parent/messages/unread-count'); }
export function markMessageRead(id: number): Promise<null> { return fetchApi(`/parent/messages/${id}/read`, { method: 'PATCH' }); }

// --- Training（训练轨：错题练习 / 专项练习，P2 Task 1-3 端点） ---

export interface TrainingErrorBookEntry {
  errorBookId: number;
  questionId: number | null;
  questionText: string;
  type: string | null;
  level: number;
  createdAt: string;
  kpIds: number[];
  /** 选择题选项（JSON 数组：字符串选项或 {label,text}），非选择题/无选项为 null。 */
  options: unknown[] | null;
}

export function getTrainingErrorBook(params: {
  subjectId: number;
  from?: string;
  to?: string;
  type?: string;
  kpId?: number;
}): Promise<TrainingErrorBookEntry[]> {
  const qs = new URLSearchParams();
  qs.set('subjectId', String(params.subjectId));
  if (params.from) qs.set('from', params.from);
  if (params.to) qs.set('to', params.to);
  if (params.type) qs.set('type', params.type);
  if (params.kpId != null) qs.set('kpId', String(params.kpId));
  return fetchApi<TrainingErrorBookEntry[]>(`/training/error-book?${qs.toString()}`);
}

export function judgeTraining(payload: {
  questionId: number;
  subjectId: number;
  studentAnswer: string;
  source: 'targeted' | 'error_practice';
  /**
   * 可选：本轮训练会话 id（乙类会话页收尾要拿它发分）。只用于后端累加
   * `training_sessions.judged_count` 审计留痕，不传也能判题。背单词的判题端点
   * **不接受**这个字段，别往 `judgeVocabularyWord` 上加。
   */
  sessionId?: number;
}): Promise<JudgeResult> {
  return fetchApi<JudgeResult>('/training/judge', {
    method: 'POST',
    body: JSON.stringify(payload),
  });
}

export function bumpTrainingErrorLevels(errorBookIds: number[]): Promise<void> {
  return fetchApi<void>('/training/bump-error-levels', {
    method: 'POST',
    body: JSON.stringify({ errorBookIds }),
  });
}

export function getTrainingHint(questionId: number): Promise<HintResult> {
  return fetchApi<HintResult>('/training/hint', {
    method: 'POST',
    body: JSON.stringify({ questionId }),
  });
}

// --- Training: explanations（判题解析缓存化，2026-09-08） ---

/** 批量拉解析（末题后结果页用）：ids 逗号分隔；后端等 in-flight 生成完成（60s 兜底），不触发新生成。
 *  返回键为 questionId 的映射，未就绪的题值为 null。 */
export function getTrainingExplanations(ids: number[]): Promise<{ explanations: Record<number, string | null> }> {
  const qs = new URLSearchParams({ ids: ids.join(',') });
  return fetchApi<{ explanations: Record<number, string | null> }>(`/training/questions/explanations?${qs.toString()}`);
}

/** 单题刷新等待（120s 倒计时）：DB 无解析且无在途 -> 重新触发生成；超时返回 null 并写管理员通知。 */
export function waitTrainingExplanation(questionId: number): Promise<{ explanation: string | null }> {
  return fetchApi<{ explanation: string | null }>(`/training/questions/${questionId}/explanation-wait`);
}

/** 主观题学生自评（self_assess 模式）：incorrect 入错题本 / correct 清零。 */
export function selfAssessTraining(payload: {
  questionId: number;
  subjectId: number;
  assessment: 'correct' | 'incorrect';
  source: 'targeted' | 'error_practice' | 'exam';
  sourceRefId?: number;
}): Promise<{ errorBookId?: number }> {
  return fetchApi<{ errorBookId?: number }>('/training/self-assess', {
    method: 'POST',
    body: JSON.stringify(payload),
  });
}

/** 课堂练习主观题自评：补写 practice_results + 留痕 + 错题本写入/清零。 */
export function selfAssessPractice(payload: {
  cardId: number;
  lessonId: number;
  subjectId: number;
  questionN: string;
  questionText: string;
  questionId: number | null;
  studentAnswer: string;
  assessment: 'correct' | 'incorrect';
}): Promise<void> {
  return fetchApi<void>('/practice/self-assess', {
    method: 'POST',
    body: JSON.stringify(payload),
  });
}

// --- Training: targeted practice（专项练习，Task 8 端点） ---

export interface TrainingKnowledgePoint {
  id: number;
  name: string;
  parentKpId: number | null;
  gradeBand: string;
}

/** 专项练习 KP 树：后端平铺透传（parentKpId 为 null 是一级），树形组装放前端。 */
export function getKnowledgePoints(subjectId: number): Promise<TrainingKnowledgePoint[]> {
  const qs = new URLSearchParams({ subjectId: String(subjectId) });
  return fetchApi<TrainingKnowledgePoint[]>(`/training/knowledge-points?${qs.toString()}`);
}

/** 专项练习题单条目：白名单序列化（无 answer/explanation），options 为 JSON 数组（字符串选项）。 */
export interface TargetedPracticeQuestion {
  questionId: number;
  text: string;
  type: string;
  options: unknown[] | null;
}

/** 专项练习开练：type 为 null 表示不限题型；抽不到题返回空数组（前端判空提示）。 */
export function startTargetedPractice(payload: {
  subjectId: number;
  kpId: number;
  type: string | null;
  count: number;
}): Promise<{
  questions: TargetedPracticeQuestion[];
  /**
   * 训练会话 id，run 页收尾时拿它调 `completeTrainingSession` 发分（乙类唯一的发分入口）。
   * **可能是 null**（计划一 Task 12：会话 INSERT 未包住、DB 故障时降级为 null）——此时
   * 学习照走，只是不发分：run 页跳过 `complete`、不弹任何积分反馈、也不报错。
   */
  sessionId: number | null;
}> {
  return fetchApi<{
    questions: TargetedPracticeQuestion[];
    sessionId: number | null;
  }>('/training/targeted/start', {
    method: 'POST',
    body: JSON.stringify(payload),
  });
}

// --- 专项训练「不再展示」清单（2026-09-04） ---

/** 不再展示清单条目：题面预览（80 字截断）+ 首个 primary kp 名 + 标记时间。 */
export interface HiddenQuestion {
  questionId: number;
  questionText: string;
  type: string;
  kpName: string | null;
  markedAt: string;
}

/** 标记某题不再展示（幂等：重复标记不报错）。 */
export function markTrainingHidden(payload: {
  questionId: number;
  subjectId: number;
}): Promise<void> {
  return fetchApi<void>('/training/hidden/mark', {
    method: 'POST',
    body: JSON.stringify(payload),
  });
}

/** 拉取不再展示清单（按标记时间倒序）。 */
export function listTrainingHidden(subjectId: number): Promise<HiddenQuestion[]> {
  const qs = new URLSearchParams({ subjectId: String(subjectId) });
  return fetchApi<HiddenQuestion[]>(`/training/hidden?${qs.toString()}`);
}

/** 撤销单条标记。 */
export function unmarkTrainingHidden(questionId: number): Promise<void> {
  return fetchApi<void>(`/training/hidden/${questionId}`, { method: 'DELETE' });
}

/** 全部重置：清空该生所有不再展示标记。 */
export function unmarkAllTrainingHidden(): Promise<void> {
  return fetchApi<void>('/training/hidden', { method: 'DELETE' });
}

// --- Training · 语文古诗文默写（2026-09-13） ---

export interface DictationPassageItem {
  passageId: number;
  workTitle: string;
  semester: string;
}

export interface DictationQuestionItem {
  passageId: number;
  prompt: string;
  workTitle: string;
  semester: string;
}

export type DictationDiffOp =
  | { type: 'equal'; text: string }
  | { type: 'wrong'; expected: string; actual: string }
  | { type: 'missing'; text: string }
  | { type: 'extra'; text: string };

export interface DictationJudgeResult {
  passageId: number;
  isCorrect: boolean;
  fields: { author: { match: boolean }; dynasty: { match: boolean }; body: { match: boolean } };
  bodyDiff: DictationDiffOp[];
  reference: { author: string; dynasty: string; body: string };
  /** 判题接口恒为 null——错因已与判题解耦，改由 fetchDictationFeedback 单独取。 */
  feedback: string | null;
  /** true=判错且错因待补（应另调 fetchDictationFeedback）；答对恒 false。 */
  feedbackPending: boolean;
  /**
   * 本次实际入账的积分（甲类，整篇按 genre 档发一次）。**`0 = 本次没加`**：判错 /
   * 幂等命中（`duplicate`，本次未入账）/ `daily_limit` / `no_rule` / `tier_inactive` /
   * `genre_unset` / 发分失败。只有 `> 0` 才弹「+N 分」轻反馈。
   */
  pointsAwarded: number;
  /** 未发分原因，**缺省 = 静默**；`duplicate` 刻意不在枚举内，一律按 0 静默。 */
  awardReason?: PointsAwardReason;
}

export function fetchDictationPassages(): Promise<{ passages: DictationPassageItem[] }> {
  return fetchApi<{ passages: DictationPassageItem[] }>('/training/dictation/passages');
}

export function startDictation(payload: {
  semester: string | null;
  passageIds: number[] | null;
  count: number;
}): Promise<{ questions: DictationQuestionItem[] }> {
  return fetchApi<{ questions: DictationQuestionItem[] }>('/training/dictation/start', {
    method: 'POST',
    body: JSON.stringify(payload),
  });
}

export function judgeDictation(payload: {
  passageId: number;
  author: string;
  dynasty: string;
  body: string;
}): Promise<DictationJudgeResult> {
  return fetchApi<DictationJudgeResult>('/training/dictation/judge', {
    method: 'POST',
    body: JSON.stringify(payload),
  });
}

/** 错因文案（LLM，可选）：与判题解耦，判错后单独取；失败回 feedback=null。 */
export function fetchDictationFeedback(payload: {
  passageId: number;
  author: string;
  dynasty: string;
  body: string;
}): Promise<{ feedback: string | null }> {
  return fetchApi<{ feedback: string | null }>('/training/dictation/feedback', {
    method: 'POST',
    body: JSON.stringify(payload),
  });
}

// --- Training · 语文古诗文解释（翻译）专项（2026-09-16） ---
//
// 三行对译 + **逐句判题**：
//   start 一次给全「原文 + 该句有哪些关键字词」（不含释义/译文——那是答案）
//   judge 判**一句**，回来才有标准释义/标准译文
//   fullTranslation 只在最后一句判完时下发

export interface InterpretationPassageItem {
  passageId: number;
  workTitle: string;
  semester: string;
}

/**
 * 一个关键字词。**两个形式**（别合并）：
 *   `term`  原样带注音（`谪（zhé）守`）——展示用，学生要看得见读音
 *   `plain` 去注音（`谪守`）——在原文里高亮定位用；正文没有注音，用 term 去找永远找不到
 */
export interface InterpretationTermItem {
  term: string;
  plain: string;
}

export interface InterpretationSentenceItem {
  index: number;
  /** 该句原文 */
  text: string;
  /** 该句的关键字词（只有词名，没有释义） */
  terms: InterpretationTermItem[];
}

export interface InterpretationPassageDetail {
  passageId: number;
  workTitle: string;
  semester: string;
  sentences: InterpretationSentenceItem[];
}

/** 判定方式。`undetermined` 时 `correct` 为 `null`（模型没判出来 → 前端显示「未判定」）。 */
export type InterpretationMethod = 'exact' | 'ai' | 'unanswered' | 'undetermined';

export interface InterpretationTermResultItem {
  term: string;
  correct: boolean | null;
  method: InterpretationMethod;
  /** 标准释义 */
  standard: string;
  comment: string | null;
}

export interface InterpretationSentenceResultItem {
  correct: boolean | null;
  method: InterpretationMethod;
  /** 标准译文 */
  standard: string;
  comment: string | null;
}

export interface InterpretationJudgeResult {
  passageId: number;
  sentenceIndex: number;
  allCorrect: boolean;
  terms: InterpretationTermResultItem[];
  sentence: InterpretationSentenceResultItem;
  /** **仅当被判的是最后一句时**非 null——整篇译文提前下发等于泄题。 */
  fullTranslation: string | null;
  /**
   * 本次实际入账的积分（甲类，整篇最后一句判完才发一次）。**中间句恒为 0 且无 reason
   * → 必须静默**；`> 0` 才弹「+N 分」。其余 0 分来源同 `DictationJudgeResult`。
   */
  pointsAwarded: number;
  /** 未发分原因，**缺省 = 静默**；`duplicate` 刻意不在枚举内，一律按 0 静默。 */
  awardReason?: PointsAwardReason;
}

export function fetchInterpretationPassages(): Promise<{ passages: InterpretationPassageItem[] }> {
  return fetchApi<{ passages: InterpretationPassageItem[] }>('/training/interpretation/passages');
}

export function startInterpretation(payload: {
  semester: string | null;
  passageIds: number[] | null;
  count: number;
}): Promise<{ passages: InterpretationPassageDetail[] }> {
  return fetchApi<{ passages: InterpretationPassageDetail[] }>('/training/interpretation/start', {
    method: 'POST',
    body: JSON.stringify(payload),
  });
}

/** 判**一句**（该句的字词 + 整句翻译）。模型不可用时相关项回 correct=null + method=undetermined。 */
export function judgeInterpretation(payload: {
  passageId: number;
  sentenceIndex: number;
  terms: Array<{ term: string; answer: string }>;
  translation: string;
}): Promise<InterpretationJudgeResult> {
  return fetchApi<InterpretationJudgeResult>('/training/interpretation/judge', {
    method: 'POST',
    body: JSON.stringify(payload),
  });
}

// --- Training · 语文古诗文「含义」专项（2026-09-17） ---
//
// 与解释专项的关键差别：`MeaningMethod` **没有 `exact`** —— 本专项不做归一化全等短路，
// 判题一律交给 LLM。另一个差别是 `sentence.answerable`：没有标准含义的句子只显示、不出题。

export interface MeaningTermItem { term: string; plain: string }

export interface MeaningSentenceItem {
  index: number;
  text: string;
  terms: MeaningTermItem[];
  /** false = 无标准含义，只在顶部原文条里显示，不进作答队列 */
  answerable: boolean;
}

export interface MeaningPassageItem { passageId: number; workTitle: string; semester: string }

export interface MeaningPassageDetail {
  passageId: number;
  workTitle: string;
  semester: string;
  sentences: MeaningSentenceItem[];
}

/** 判定方式。**没有 `exact`**（理解性作答不做字符串全等短路）。 */
export type MeaningMethod = 'ai' | 'unanswered' | 'undetermined';

export interface MeaningPartResult {
  correct: boolean | null;
  method: MeaningMethod;
  standard: string;
  comment: string | null;
}

export interface MeaningTermResultItem {
  term: string;
  correct: boolean | null;
  method: MeaningMethod;
  standard: string;
  comment: string | null;
}

export interface MeaningJudgeResult {
  passageId: number;
  sentenceIndex: number;
  allCorrect: boolean;
  terms: MeaningTermResultItem[];
  meaning: MeaningPartResult;
  emotion: MeaningPartResult;
  /**
   * 本次实际入账的积分（甲类，整篇最后一句判完才发一次）。**中间句恒为 0 且无 reason
   * → 必须静默**；`> 0` 才弹「+N 分」。其余 0 分来源同 `DictationJudgeResult`。
   */
  pointsAwarded: number;
  /** 未发分原因，**缺省 = 静默**；`duplicate` 刻意不在枚举内，一律按 0 静默。 */
  awardReason?: PointsAwardReason;
}

export function fetchMeaningPassages(): Promise<{ passages: MeaningPassageItem[] }> {
  return fetchApi<{ passages: MeaningPassageItem[] }>('/training/meaning/passages');
}

export function startMeaning(payload: {
  semester: string | null;
  passageIds: number[] | null;
  count: number;
}): Promise<{ passages: MeaningPassageDetail[] }> {
  return fetchApi<{ passages: MeaningPassageDetail[] }>('/training/meaning/start', {
    method: 'POST',
    body: JSON.stringify(payload),
  });
}

/** 判**一句**（该句的字词 + 深层含义 + 作者情感）。模型不可用时相关项回 correct=null。 */
export function judgeMeaning(payload: {
  passageId: number;
  sentenceIndex: number;
  terms: Array<{ term: string; answer: string }>;
  meaning: string;
  emotion: string;
}): Promise<MeaningJudgeResult> {
  return fetchApi<MeaningJudgeResult>('/training/meaning/judge', {
    method: 'POST',
    body: JSON.stringify(payload),
  });
}

// --- Training · 英语背单词（2026-09-16） ---
//
// 独立子系统（不挂 questions、不进错题本、不参与主线清零门禁）。
// 字段与后端 modules/training/dto/vocabulary.dto.ts 一一对应，改一边要同步另一边。

/** 词库范围档位。存储是四层（小学/初中/高中必修/高中选择性必修），页面只暴露这三档。 */
export type VocabularyLevelPool = 'junior' | 'senior' | 'all';

/** 出题顺序。`letter` = 按 `letter` 指定字母开头的词，按字母序出。 */
export type VocabularyOrder = 'random' | 'alpha' | 'alpha_desc' | 'letter';

/**
 * 出题方向。`random` = 逐题随机（熟词僻义题恒为英→中，方向选择对它无效）；
 * `ph2en` = 看音标写单词（题面是音标，答案是英文单词）。
 */
export type VocabularyDirection = 'en2cn' | 'cn2en' | 'random' | 'ph2en';

/**
 * 题面类型（`random` 已在服务端落定）：`en2cn` 给单词问中文，`cn2en` 给中文问单词，
 * `ph2en` 给音标问单词。
 */
export type VocabularyPromptKind = 'en2cn' | 'cn2en' | 'ph2en';

/**
 * 判定结论五档。
 * - `off_target`：**答成常见义**——学生答的没错，只是没答到本题考的僻义。不计错。
 * - `unanswered`：学生点了「不认识」。不计错。
 * - `undetermined`：判题模型失败。不计错，也不算对。
 */
export type VocabularyVerdict = 'correct' | 'off_target' | 'wrong' | 'unanswered' | 'undetermined';

export type VocabularyJudgeMethod = 'exact' | 'ai';

/** 逐字符差异（答案是英文单词的方向答错时给：中→英、看音标写单词），供高亮「你差在哪」。 */
export type VocabularyCharDiffOp =
  | { type: 'equal'; text: string }
  | { type: 'wrong'; actual: string; expected: string };

export interface VocabularyPoolOption {
  key: VocabularyLevelPool;
  label: string;
  count: number;
}

export interface VocabularyOptions {
  pools: VocabularyPoolOption[];
  /** 今日已背（答对/答错/不认识/判题失败都算「见过」） */
  todayAnswered: number;
  counts: {
    notLearned: number;
    myWrong: number;
    commonWrong: number;
    extended: number;
  };
}

export interface VocabularyQuestionItem {
  wordId: number;
  senseIndex: number;
  promptKind: VocabularyPromptKind;
  /** 题面。`en2cn` 是英文单词；`cn2en` 是中文释义；`ph2en` 是音标 */
  prompt: string;
  /** **`cn2en` 与 `ph2en` 下恒为 null**（前者给了等于提示答案，后者的音标已经在 `prompt` 里） */
  phonetic: string | null;
  /** 锁定僻义的搭配（如 `address the problem`）；`cn2en` / `ph2en` 下恒为 null */
  context: string | null;
  /** 熟词僻义题（题面会给「熟词僻义」标记） */
  isExtendedSense: boolean;
  /**
   * 是否有词根族可展开。**必须 `promptKind === 'en2cn' && hasFamily` 才渲染「+」号**——
   * 族树里必然包含单词本身，答案是英文单词的题（中→英、看音标写单词）点开就等于直接看答案。
   */
  hasFamily: boolean;
}

export interface VocabularyStartResult {
  questions: VocabularyQuestionItem[];
  /** 抽题池命中数。为 0 时 questions 为空（提示「当前筛选下没有词」） */
  poolSize: number;
  /**
   * 训练会话 id，run 页收尾时拿它调 `completeTrainingSession` 发分（乙类唯一的发分入口）。
   * **可能是 null**（计划一 Task 12：会话 INSERT 未包住、DB 故障时降级为 null）——此时
   * 学习照走，只是不发分：run 页跳过 `complete`、不弹任何积分反馈、也不报错。
   */
  sessionId: number | null;
}

export interface VocabularyStandardMeaning {
  pos: string;
  gloss: string;
  extended: boolean;
  context?: string;
}

export interface VocabularyJudgeResult {
  wordId: number;
  senseIndex: number;
  verdict: VocabularyVerdict;
  method: VocabularyJudgeMethod;
  standard: {
    word: string;
    phonetic: string | null;
    /** 该词全部义项（判完就该让学生看见） */
    meanings: VocabularyStandardMeaning[];
    /** 本题考的那一个义项 */
    target: { pos: string; gloss: string; extended: boolean; context?: string };
  };
  spellingDiff: VocabularyCharDiffOp[] | null;
  /** 判错/未答到考点时的提示（模型给；程序判错时为 null） */
  comment: string | null;
  familyAvailable: boolean;
  progress: { learned: boolean; wrongCount: number };
}

export interface VocabularyAffix {
  type: 'prefix' | 'suffix';
  code: string;
  gloss: string;
  posHint?: string;
}

export interface WordFamilyMember {
  word: string;
  phonetic: string | null;
  gloss: string;
  pos: string;
  affixes: VocabularyAffix[];
  isHead: boolean;
  level: string;
}

export interface WordFamilyResult {
  root: { word: string; phonetic: string | null; gloss: string };
  members: WordFamilyMember[];
}

export function fetchVocabularyOptions(): Promise<VocabularyOptions> {
  return fetchApi<VocabularyOptions>('/training/vocabulary/options');
}

export function startVocabulary(payload: {
  levelPool: VocabularyLevelPool;
  count: number;
  order: VocabularyOrder;
  /** 仅 order='letter' 时给，单字母 a-z */
  letter?: string | null;
  direction: VocabularyDirection;
  onlyNotLearned?: boolean;
  onlyMyWrong?: boolean;
  onlyCommonWrong?: boolean;
  onlyExtendedSense?: boolean;
}): Promise<VocabularyStartResult> {
  return fetchApi<VocabularyStartResult>('/training/vocabulary/start', {
    method: 'POST',
    body: JSON.stringify(payload),
  });
}

/**
 * 判一个词。服务端中→英是纯程序比对、英→中先程序短路再可能调模型，
 * 所以耗时不固定——前端**不要等它**：提交即翻下一个词，判定回来再写进累积清单。
 */
export function judgeVocabularyWord(payload: {
  wordId: number;
  senseIndex: number;
  promptKind: VocabularyPromptKind;
  answer: string;
}): Promise<VocabularyJudgeResult> {
  return fetchApi<VocabularyJudgeResult>('/training/vocabulary/judge', {
    method: 'POST',
    body: JSON.stringify(payload),
  });
}

/** 「移除易错标记」：只清该学生自己的错次，不动 learned、不动全平台统计。 */
export function clearVocabularyWordProgress(wordId: number): Promise<{ ok: boolean }> {
  return fetchApi<{ ok: boolean }>('/training/vocabulary/progress/clear', {
    method: 'POST',
    body: JSON.stringify({ wordId }),
  });
}

/** 词根族（点「+」号懒加载）。没有族的词后端回 404，调用方按「无族」处理。 */
export function fetchWordFamily(wordId: number): Promise<WordFamilyResult> {
  return fetchApi<WordFamilyResult>(`/training/vocabulary/words/${wordId}/family`);
}

// --- Exams（考试模块：试卷列表 / 会话生命周期 / 结果，字段以后端 exams 白名单序列化为准） ---

export interface ExamPaper {
  id: number;
  title: string;
  year: number | null;
  district: string | null;
  examType: string | null;
  gradeBand: string | null;
  questionCount: number;
}

/** 选择题选项为 JSON 数组（字符串选项或 {label,text} 对象选项），非选择题为 null。 */
export type ExamQuestionOptions = Array<{ label: string; text: string }> | string[] | null;

export interface ExamQuestion {
  questionId: number;
  questionNo: number;
  text: string;
  type: string;
  options: ExamQuestionOptions;
}

/** 试卷详情：题目元数据 + 推荐时长（不含 answer/explanation，防答案泄露）。 */
export interface ExamPaperDetail {
  id: number;
  title: string;
  durationMinutes: number;
  questions: ExamQuestion[];
}

/**
 * 会话信息（create 与 getSession 响应的并集，差异字段可选）：
 * create 返回 {sessionId, deadlineAt, remainingSeconds, questions}（无 status/answered）；
 * getSession 返回 {sessionId, status, remainingSeconds, questions, answered}（无 deadlineAt）。
 */
export interface ExamSessionInfo {
  sessionId: number;
  status?: 'in_progress' | 'submitted';
  deadlineAt?: string;
  remainingSeconds: number;
  questions: ExamQuestion[];
  /** questionId（JSON 序列化后为字符串键）-> 作答文本；仅 getSession 返回。 */
  answered?: Record<string, { answerText: string | null }>;
}

/** 交卷/收卷汇总（submit 响应；getResults 内嵌同构字段）。accuracy 为百分比一位小数。 */
export interface ExamSummary {
  correctCount: number;
  totalCount: number;
  accuracy: number;
  /** 主观题题数（self_assess 模式不判对错） */
  subjectiveCount?: number;
  /**
   * 交卷发分结果（丙类埋点 math_paper）。
   *
   * **可选**：交卷是幂等的——重复交卷 / 早退等分支不发分，`getResults` 也不补发分，
   * 此时 JSON 里**没有这个键**（不是 `awarded: 0`）。缺省 → 不弹任何积分反馈，也不报错。
   */
  points?: {
    awarded: number;
    balance: number;
    levelUp: { from: string; to: string } | null;
  };
}

export interface ExamResultItem {
  questionId: number;
  questionNo: number;
  text: string;
  type: string;
  options: ExamQuestionOptions;
  answerText: string | null;
  /** null = 主观题待自评 */
  isCorrect: number | null;
  analysis: string | null;
  explanation: string | null;
  /** 参考答案 */
  answer?: string | null;
  needsSelfAssessment?: boolean;
  selfAssessment?: 'correct' | 'incorrect' | null;
}

export function getExamPapers(params: {
  subjectId: number;
  year?: number;
  district?: string;
  examType?: string;
  gradeBand?: string;
}): Promise<ExamPaper[]> {
  const qs = new URLSearchParams();
  qs.set('subjectId', String(params.subjectId));
  if (params.year != null) qs.set('year', String(params.year));
  if (params.district) qs.set('district', params.district);
  if (params.examType) qs.set('examType', params.examType);
  if (params.gradeBand) qs.set('gradeBand', params.gradeBand);
  return fetchApi<ExamPaper[]>(`/exams/papers?${qs.toString()}`);
}

export function getExamPaperDetail(id: number): Promise<ExamPaperDetail> {
  return fetchApi<ExamPaperDetail>(`/exams/papers/${id}`);
}

export function createExamSession(paperId: number, durationMinutes: number): Promise<ExamSessionInfo> {
  return fetchApi<ExamSessionInfo>('/exams/sessions', {
    method: 'POST',
    body: JSON.stringify({ paperId, durationMinutes }),
  });
}

export function getExamSession(sessionId: number): Promise<ExamSessionInfo> {
  return fetchApi<ExamSessionInfo>(`/exams/sessions/${sessionId}`);
}

export function submitExamAnswer(
  sessionId: number,
  questionId: number,
  answerText: string,
): Promise<{ saved: boolean }> {
  return fetchApi<{ saved: boolean }>(`/exams/sessions/${sessionId}/answers`, {
    method: 'POST',
    body: JSON.stringify({ questionId, answerText }),
  });
}

export function submitExamSession(sessionId: number): Promise<ExamSummary> {
  return fetchApi<ExamSummary>(`/exams/sessions/${sessionId}/submit`, { method: 'POST' });
}

export function getExamResults(sessionId: number): Promise<ExamSummary & { items: ExamResultItem[] }> {
  return fetchApi<ExamSummary & { items: ExamResultItem[] }>(`/exams/sessions/${sessionId}/results`);
}

// --- Points（学生端积分：概览 / 流水 / 规则档位 / 奖励册 / 训练会话完成发分） ---
// 字段与后端 modules/points/dto/points.dto.ts 一一对应（wire 形状，不是 service 内部类型）。
// 契约见 docs/api/openapi.yaml 的 /points/me*；改一边要同步另一边。

/** 段位信息。`code` 有意用 string 而非 LevelCode 联合：后端新增段位时前端不该类型报错，
 *  图标侧 `LevelIcon` 对未知 code 已做回退。 */
export interface PointLevel {
  code: string;
  name: string;
  /** 段位序号（0 = 劈柴），可用于比较高低 */
  index: number;
  /** 该段位的累计积分门槛 */
  threshold: number;
}

/** `GET /api/points/me` —— 概览。新学生无积分行时也会返回全 0 + 劈柴，不是 404。 */
export interface MyPoints {
  balance: number;
  /** 累计获得；段位与进度都按它算（兑换只扣 balance、不影响它） */
  totalEarned: number;
  todayEarned: number;
  level: PointLevel;
  /** 已满级（王者）时为 null */
  nextLevel: PointLevel | null;
  /** 已满级时为 null */
  pointsToNextLevel: number | null;
  /** 0-100 整数；满级为 100 */
  progressPercent: number;
}

export type PointLedgerKind = 'earn' | 'redeem';

export interface PointLedgerEntry {
  id: number;
  kind: PointLedgerKind;
  /** 展示文案快照（家长后来改分值/档位名，历史流水不变） */
  title: string;
  /** earn 正数 / redeem 负数 */
  points: number;
  createdAt: string;
  refType: string | null;
}

/** `GET /api/points/me/ledger` —— 分页流水（最新在前）。 */
export interface PointLedgerPage {
  items: PointLedgerEntry[];
  total: number;
  page: number;
  pageSize: number;
}

export interface PointRuleTier {
  tierKey: string;
  /** 按钮文字，如「3 题」「15 词」 */
  tierLabel: string;
  points: number;
  /** null = 不限次数 */
  dailyLimit: number | null;
  /** 今日已发分条数；dailyLimit == null（不限）时为 null */
  completedToday: number | null;
  /** 今日还剩几次；dailyLimit == null（不限）时为 null。
   *  注意 === 0 时**仍可开练**，只是不发分——别拦着孩子练（计划 §3 Task 6）。 */
  remainingToday: number | null;
  /** 该档是否已启用。
   *  **学生端 `GET /points/me/rules` 恒为 `true`**（controller 把下架档过滤掉了，
   *  `points.controller.ts:71`）；**家长端 `.../points/rules` 才可能为 `false`**
   *  （要显示下架档并支持重新启用，计划 §1.1#1）。 */
  isActive: boolean;
}

export interface PointRuleTask {
  taskCode: string;
  taskName: string;
  /** **可能为空数组**（该任务档位被家长全部下架）：调用方不能写 `tiers[0].tierKey` 默认取值。 */
  tiers: PointRuleTier[];
}

/** `GET /api/points/me/rules` —— 训练配置页的「档位即可选项」数据源（只含已启用档位）。 */
export interface MyPointRules {
  tasks: PointRuleTask[];
}

export interface StudentRewardItem {
  id: number;
  name: string;
  description: string | null;
  pointsCost: number;
  minLevelCode: string | null;
  /** `minLevelCode` 对应的段位名；无段位门槛或脏 code 时为 null。
   *  段位表单一真源在后端，前端不维护段位表（spec §3.1）。 */
  minLevelName: string | null;
  /** 余额够不够 */
  affordable: boolean;
  /** 段位够不够 */
  levelOk: boolean;
  /** `max(0, pointsCost - balance)` */
  gap: number;
}

/** `GET /api/points/me/rewards` —— 奖励册（只含已上架；学生只能看，兑换在家长端）。 */
export interface MyRewards {
  balance: number;
  level: PointLevel;
  items: StudentRewardItem[];
}

/**
 * 未发分原因。`duplicate`（幂等命中）刻意不在枚举里——一律按 `pointsAwarded: 0` 静默处理。
 * `not_cleared` 只见于甲类逐目标发分：答对但本无未清错题行，没有可订正的错题，故不发分。
 */
export type PointsAwardReason =
  | 'daily_limit'
  | 'no_rule'
  | 'tier_inactive'
  | 'genre_unset'
  | 'not_cleared';

/** `POST /api/training/sessions/:id/complete` 的响应（数学专项 / 背单词专用）。 */
export interface CompleteTrainingSessionResult {
  /** 幂等命中、已达上限、无规则时都是 0——**不是错误** */
  pointsAwarded: number;
  /** 发分失败（`reason: 'award_failed'`）时为 **null**：不要拿它覆盖本地积分快照，
   *  会话留在 `in_progress`，允许重试（服务端会补发）。 */
  balance: number | null;
  totalEarned: number | null;
  /** 段位晋升的 from/to code；无晋升为 null */
  levelUp: { from: string; to: string } | null;
  /**
   * **与 openapi `CompleteSessionResult.reason` 枚举逐字一致**：
   * `daily_limit` / `no_rule` / `tier_inactive` 是发分引擎的正常未发分原因，
   * `already_completed` 是幂等命中，`award_failed` 是发分失败（`balance` 为 null、可重试）。
   *
   * 这里**不含** `genre_unset`（只由语文默写/解释端点产出）与 `not_cleared`
   * （只由甲类逐目标发分产出）——complete 端点永远不会返回它们。
   */
  reason?: 'daily_limit' | 'no_rule' | 'tier_inactive' | 'already_completed' | 'award_failed';
}

export function getMyPoints(): Promise<MyPoints> {
  return fetchApi<MyPoints>('/points/me');
}

export function getMyLedger(page = 1, pageSize = 20): Promise<PointLedgerPage> {
  const qs = new URLSearchParams({ page: String(page), pageSize: String(pageSize) });
  return fetchApi<PointLedgerPage>(`/points/me/ledger?${qs.toString()}`);
}

export function getMyPointRules(): Promise<MyPointRules> {
  return fetchApi<MyPointRules>('/points/me/rules');
}

export function getMyRewards(): Promise<MyRewards> {
  return fetchApi<MyRewards>('/points/me/rewards');
}

/**
 * 训练会话完成发分。**幂等**：重复调用（前端重试）返回
 * `reason: 'already_completed'` + `pointsAwarded: 0`，不报错。
 * 只有数学专项与背单词走会话；其余四个专项的 `pointsAwarded` 在判题响应里。
 */
export function completeTrainingSession(sessionId: number): Promise<CompleteTrainingSessionResult> {
  return fetchApi<CompleteTrainingSessionResult>(`/training/sessions/${sessionId}/complete`, {
    method: 'POST',
  });
}

// --- Parent: points & rewards（家长端积分配置 / 奖励清单 / 兑换 / 兑换记录 / 兑换设置） ---
// 字段与后端 modules/points/parent-points.controller.ts 的 wire 形状一一对应；契约见
// docs/api/openapi.yaml 的 /parent/students/{id}*。类型**复用**上面 Points 分区的定义
// （学生端与家长端共用同一批 service / DTO），这里只新增家长端独有的形状。

/** 奖励清单一行（家长端视角：**含已下架行**，家长要能重新上架）。
 *  与学生端 `StudentRewardItem` 不同：那个带 `affordable`/`levelOk`/`gap` 等个人化判定。 */
export interface RewardCatalogView {
  id: number;
  name: string;
  description: string | null;
  pointsCost: number;
  /** 兑换所需最低段位 code；null = 无门槛 */
  minLevelCode: string | null;
  isActive: boolean;
  sortOrder: number;
}

/** 整表保存奖励清单的一条。无 `id` 新增、有 `id` 整行覆盖、清单里消失的 `id` 软删。
 *  **`isActive` 必填**：漏回传会把已下架的奖励静默重新上架。 */
export interface RewardCatalogItemInput {
  id?: number;
  name: string;
  description: string | null;
  pointsCost: number;
  minLevelCode: string | null;
  isActive: boolean;
  sortOrder: number;
}

export type RedemptionType = 'cash' | 'reward';
export type RedemptionStatus = 'pending' | 'fulfilled';

export interface RedemptionView {
  id: number;
  type: RedemptionType;
  /** 本次消耗的积分（cash 与 reward 都有） */
  pointsSpent: number;
  /** 换钱金额（由服务端按汇率 `pointsPerYuan` 推导）；`type='reward'` 时为 null */
  cashAmount: number | null;
  /** `type='reward'` 时的奖励 id；`type='cash'` 时为 null */
  rewardCatalogId: number | null;
  /** 兑换时的奖励名快照（奖励后来改名/软删也不变）；`type='cash'` 时为 null */
  rewardName: string | null;
  status: RedemptionStatus;
  note: string | null;
  ledgerId: number | null;
  createdAt: string;
  fulfilledAt: string | null;
}

export interface RedemptionList {
  items: RedemptionView[];
  total: number;
  page: number;
  pageSize: number;
}

export interface RedeemResult {
  redemption: RedemptionView;
  /** 兑换后的实时余额 */
  balance: number;
  /** 累计获得（兑换只扣 balance、不影响它，故段位只升不降） */
  totalEarned: number;
  level: PointLevel;
}

/** `GET|PUT /api/parent/students/:id/points/settings` —— 兑换设置。 */
export interface PointsSettings {
  /** 多少积分兑 1 元 */
  pointsPerYuan: number;
  /** 关闭后 `POST .../points/redeem` 一律拒（3004 兑换已关闭；3003 是「奖励已下架」，见 plan §2.8） */
  rewardRedemptionEnabled: boolean;
}

/** 保存分值规则的一条。三个可改字段**全必填**（后端 Zod 三个都是必填，缺一个 400 1001）。
 *  `dailyLimit` 只允许 `null`（不限）或 1–99；填 0 会让该档位永久不发分。 */
export interface PointRuleSaveInput {
  taskCode: string;
  tierKey: string;
  points: number;
  dailyLimit: number | null;
  isActive: boolean;
}

/** `GET /api/points/levels` —— 全量段位表（9 项、升序）。**唯一不需要 `studentId`** 的积分端点，
 *  家长端用它填奖励的 `minLevelCode` 下拉（段位表单一真源在后端，前端不硬编码）。 */
export function getLevels(): Promise<{ levels: PointLevel[] }> {
  return fetchApi<{ levels: PointLevel[] }>('/points/levels');
}

/** `GET /api/parent/students/:id/points` —— 概览。**形状与学生端 `getMyPoints()` 完全相同**
 *  （后端 `ParentPointsController.getPoints` 直接复用 `PointsService.getOverview`），
 *  故复用 `MyPoints` 类型而不另造一份。 */
export function getParentPoints(studentId: number): Promise<MyPoints> {
  return fetchApi<MyPoints>(`/parent/students/${studentId}/points`);
}

/** `GET /api/parent/students/:id/points/rules` —— **含已下架档位**，家长要能看到并重新启用。 */
export function getParentPointRules(studentId: number): Promise<MyPointRules> {
  return fetchApi<MyPointRules>(`/parent/students/${studentId}/points/rules`);
}

/** 批量保存分值规则（一个事务，要么全成要么全不成）。 */
export function saveParentPointRules(
  studentId: number,
  rules: PointRuleSaveInput[],
): Promise<null> {
  return fetchApi<null>(`/parent/students/${studentId}/points/rules`, {
    method: 'PUT',
    body: JSON.stringify({ rules }),
  });
}

/** 流水分页。`pageSize` 省略时**不传该 query**，按后端默认 20（上限 100，越界 400）。
 *
 *  ⚠️ **当前无消费方**（终审 2026-09-18 裁决：保留）。家长端本期没有「积分流水」Tab
 *  ——学生端的流水在个人中心。这条留着是给后续**家长端流水页**预留（端点 §4.21 已
 *  在服务端实现并有集成用例），`api.test.ts` 的 query 拼接用例同步保留；若要删，
 *  请连用例一起删，别只删函数。 */
export function getParentPointLedger(
  studentId: number,
  page: number,
  pageSize?: number,
): Promise<PointLedgerPage> {
  const qs = new URLSearchParams({ page: String(page) });
  if (pageSize !== undefined) qs.set('pageSize', String(pageSize));
  return fetchApi<PointLedgerPage>(`/parent/students/${studentId}/points/ledger?${qs.toString()}`);
}

/** `GET /api/parent/students/:id/reward-catalog` —— **含已下架行**（整表 PUT 时要原样带回）。 */
export function getParentRewardCatalog(studentId: number): Promise<RewardCatalogView[]> {
  return fetchApi<RewardCatalogView[]>(`/parent/students/${studentId}/reward-catalog`);
}

/** 整表保存奖励清单，返回保存后的完整清单。清单里消失的 `id` 会被**软删**，
 *  因此必须把当前列表（含已下架的 `isActive: false` 行）原样整表提交。 */
export function saveParentRewardCatalog(
  studentId: number,
  items: RewardCatalogItemInput[],
): Promise<RewardCatalogView[]> {
  return fetchApi<RewardCatalogView[]>(`/parent/students/${studentId}/reward-catalog`, {
    method: 'PUT',
    body: JSON.stringify({ items }),
  });
}

/** 兑换（Nest `@Post` 默认 **201**）。余额不足 / 段位不够 / 开关关闭 / 已下架等业务拒绝
 *  由 service 抛 3001-3004 —— **不要**本地判余额后就乐观放行（并发下服务端才准）。 */
export function redeemParentPoints(
  studentId: number,
  body: { type: 'cash'; points: number } | { type: 'reward'; catalogId: number },
): Promise<RedeemResult> {
  return fetchApi<RedeemResult>(`/parent/students/${studentId}/points/redeem`, {
    method: 'POST',
    body: JSON.stringify(body),
  });
}

/** 兑换记录分页（`pageSize` 由服务端固定 20，故这里只传 `page`）。 */
export function getParentRedemptions(studentId: number, page: number): Promise<RedemptionList> {
  const qs = new URLSearchParams({ page: String(page) });
  return fetchApi<RedemptionList>(`/parent/students/${studentId}/redemptions?${qs.toString()}`);
}

/** 只改兑换单状态（pending ⇄ fulfilled），**不动积分**。
 *  ⚠️ 路径里**没有 studentId**：服务端先按 id 反查兑换单拿 `student_id` 再校验归属。 */
export function setRedemptionStatus(
  redemptionId: number,
  status: RedemptionStatus,
): Promise<null> {
  return fetchApi<null>(`/parent/redemptions/${redemptionId}`, {
    method: 'PATCH',
    body: JSON.stringify({ status }),
  });
}

export function getParentPointsSettings(studentId: number): Promise<PointsSettings> {
  return fetchApi<PointsSettings>(`/parent/students/${studentId}/points/settings`);
}

/** 部分更新兑换设置（至少给一个字段，空 patch 后端 400）。返回更新后的全量。 */
export function saveParentPointsSettings(
  studentId: number,
  patch: Partial<PointsSettings>,
): Promise<PointsSettings> {
  return fetchApi<PointsSettings>(`/parent/students/${studentId}/points/settings`, {
    method: 'PUT',
    body: JSON.stringify(patch),
  });
}

// --- Parent: 学情可见性（仪表盘/报告/错题/对话回放） ---
// 形状与后端 `apps/server/src/modules/parent-insights/dto/parent-insights.dto.ts` 一一对应；
// `Date` 经 JSON 变成 ISO 字符串。

export interface ParentRateSummary {
  answered: number;
  correct: number;
  /** 未作答时是 null（不是 0）——「暂无数据」与「全错」是两回事。 */
  rate: number | null;
}

export interface ParentDashboardSubject {
  subjectId: number;
  subjectName: string;
  progress: {
    completedUnits: number;
    totalUnits: number;
    currentUnitName: string | null;
    currentLessonName: string | null;
    percent: number;
  };
  accuracy: ParentRateSummary;
  selfAssessed: { count: number; correctCount: number };
  errorBook: { uncleared: number; total: number };
  examCount: number;
}

export interface ParentDashboardStudent {
  studentId: number;
  name: string;
  grade: string | null;
  schoolLevel: string | null;
  lastActiveAt: string | null;
  /** 近 7 天有记录的天数（「学习时长」的代理指标）。 */
  activeDays7: number;
  /** 本期恒 0：`safety_alerts` 尚无写入。 */
  unreadAlerts: number;
  subjects: ParentDashboardSubject[];
}

export interface ParentDashboard {
  students: ParentDashboardStudent[];
  unreadAlerts: number;
}

export function getParentDashboard(): Promise<ParentDashboard> {
  return fetchApi<ParentDashboard>('/parent/dashboard');
}

export type ParentReportPeriod = 'weekly' | 'monthly';

export interface ParentTrendPoint {
  date: string;
  answered: number;
  correct: number;
  rate: number | null;
}

export interface ParentReportStats {
  activeDays: number;
  answered: number;
  correct: number;
  rate: number | null;
  selfAssessCount: number;
  errorsAdded: number;
  errorsCleared: number;
  examCount: number;
}

export interface ParentReportSubjectRow {
  subjectId: number;
  subjectName: string;
  answered: number;
  correct: number;
  rate: number | null;
}

export interface ParentWeakPoint {
  knowledgePointId: number;
  name: string;
  unclearedCount: number;
  totalWrongCount: number;
}

export interface ParentExamRecord {
  sessionId: number;
  paperTitle: string;
  subjectName: string;
  submittedAt: string;
  correctCount: number;
  objectiveCount: number;
  rate: number | null;
}

export interface ParentLearningReport {
  studentId: number;
  period: ParentReportPeriod;
  windowStart: string;
  windowEnd: string;
  stats: ParentReportStats;
  trend: ParentTrendPoint[];
  subjects: ParentReportSubjectRow[];
  weakPoints: ParentWeakPoint[];
  /** 未清零错题里映射不到知识点的条数——UI 必须显式提示口径。 */
  weakPointsUncoveredCount: number;
  exams: ParentExamRecord[];
}

export function getParentReport(
  studentId: number,
  period: ParentReportPeriod,
): Promise<ParentLearningReport> {
  const qs = new URLSearchParams();
  qs.set('period', period);
  return fetchApi<ParentLearningReport>(`/parent/students/${studentId}/reports?${qs.toString()}`);
}

// --- Parent: 学习时长（会话口径，埋点 Phase 1A） ---
// ⚠️ 与 `ParentDashboardStudent.activeDays7`（四路时间戳代理）是**两套口径**，
// 必须并列展示、文案区分，不得相互替换（spec §10 第 1 条）。

export interface ParentStudyTime {
  totalSeconds: number;
  /** 会话口径的「有学习的天数」，与 `activeDays7` 刻意不同。 */
  activeDays: number;
  byDay: Array<{ date: string; seconds: number }>;
  byModule: Array<{ module: string; seconds: number }>;
  /** 只含 `subject_id IS NOT NULL` 的会话——**选学科之前**开始的会话不在这个列表里，
   *  UI 标注「按学科」时要说明这一点（与 `totalSeconds` 对不上是正常的）。 */
  bySubject: Array<{ subjectId: number; seconds: number }>;
  /** 口径标记：永远是 'sessions'，用于 UI 上明确这是会话时长。 */
  source: 'sessions';
}

export interface ParentTodayUsage {
  date: string;
  activeSeconds: number;
  /** `null` = 家长未设限（不是「上限 0 分钟」）。 */
  limitMinutes: number | null;
  /** `>=` 判定：用满上限即算超出。 */
  exceeded: boolean;
  byModule: Array<{ module: string; seconds: number }>;
}

export function getParentStudyTime(
  studentId: number,
  from?: string,
  to?: string,
): Promise<ParentStudyTime> {
  const qs = new URLSearchParams();
  if (from) qs.set('from', from);
  if (to) qs.set('to', to);
  const suffix = qs.toString() ? `?${qs.toString()}` : '';
  return fetchApi<ParentStudyTime>(`/parent/students/${studentId}/study-time${suffix}`);
}

export function getParentTodayUsage(studentId: number): Promise<ParentTodayUsage> {
  return fetchApi<ParentTodayUsage>(`/parent/students/${studentId}/today-usage`);
}

// --- Parent: 专项学情 / 真掌握度 / 目标达成（埋点 Phase 1B） ---

/** 目标维度（与后端 `goals.metric` 的列注释逐字一致）。 */
export type ParentGoalMetric =
  | 'daily_study_minutes'
  | 'weekly_lessons'
  | 'daily_words'
  | 'weekly_passages'
  | 'weekly_clear_errors';

/**
 * 一个专项模块的窗口内聚合。
 * ⚠️ `rate` 为 `null` = **本期没有可判对错的作答**，不是 0——显示「暂无数据」，不要显示 0%。
 */
export interface ParentSpecialModule {
  /** 作答单位数：默写=篇、解释/含义=句、背单词=题。 */
  units: number;
  correct: number;
  rate: number | null;
  byDay: Array<{ date: string; count: number }>;
}

/**
 * 四个专项模块。后端**保证四个键都在**（没数据给 0 / `rate: null` / `byDay: []`），
 * 所以前端不必做「模块缺失」兜底；只有 `vocabulary` 多一个 `newWords`。
 */
export interface ParentSpecials {
  dictation: ParentSpecialModule;
  interpretation: ParentSpecialModule;
  meaning: ParentSpecialModule;
  vocabulary: ParentSpecialModule & { newWords: number };
}

/**
 * 真掌握度（`student_knowledge_mastery`）的一行。
 * `masteryScore` 是 **0..1 的比值**（后端已算好，前端不要再除 100）。
 * `lastSeenAt` 为 null = 从未见过。
 */
export interface ParentMasteryItem {
  knowledgePointId: number;
  name: string;
  masteryScore: number;
  level: number;
  correctCount: number;
  errorCount: number;
  lastSeenAt: string | null;
}

/**
 * `/mastery` 响应。三个覆盖率计数必须一起展示：题库只有 **38%** 的题绑了知识点，
 * 只列最弱几项会让家长以为「孩子的问题只有这几个」。
 */
export interface ParentMastery {
  items: ParentMasteryItem[];
  coveredQuestions: number;
  totalQuestions: number;
  /** = totalQuestions - coveredQuestions（后端算好，前端不要自己减）。 */
  uncovered: number;
}

/** 目标达成的一行。`rate` 允许 > 100（超额完成），前端**不要截断**。 */
export interface ParentGoalAttainmentItem {
  metric: ParentGoalMetric;
  /** 学科（P6.5 起所有目标都按学科）。**渲染 key 必须用 `${subjectId}:${metric}`** ——
   *  同一个 metric 会在多个学科各有一行，只用 metric 当 key 会撞。 */
  subjectId: number;
  subjectName: string;
  period: 'daily' | 'weekly';
  title: string;
  target: number;
  achieved: number;
  rate: number | null;
}

export interface ParentGoalAttainment {
  items: ParentGoalAttainmentItem[];
}

/**
 * 专项学情。`from`/`to` 形如 `YYYY-MM-DD`，缺省近 7 天；
 * 非法值后端**宽容回落**默认窗口、不报错（与 `getParentStudyTime` 一致）。
 */
export function getParentSpecials(
  studentId: number,
  from?: string,
  to?: string,
): Promise<ParentSpecials> {
  const qs = new URLSearchParams();
  if (from) qs.set('from', from);
  if (to) qs.set('to', to);
  const suffix = qs.toString() ? `?${qs.toString()}` : '';
  return fetchApi<ParentSpecials>(`/parent/students/${studentId}/specials${suffix}`);
}

/** 真掌握度。`limit` 缺省 10、上限 50（越界后端 400，前端不要传超）。 */
export function getParentMastery(studentId: number, limit?: number): Promise<ParentMastery> {
  const qs = new URLSearchParams();
  if (limit !== undefined) qs.set('limit', String(limit));
  const suffix = qs.toString() ? `?${qs.toString()}` : '';
  return fetchApi<ParentMastery>(`/parent/students/${studentId}/mastery${suffix}`);
}

/** 目标达成（首次调用后端会懒初始化四个默认目标）。 */
export function getParentGoalAttainment(studentId: number): Promise<ParentGoalAttainment> {
  return fetchApi<ParentGoalAttainment>(`/parent/students/${studentId}/goals/attainment`);
}

/**
 * 改某个目标的值。响应是**该 metric 的最新达成情况**——调用方应拿它原地替换该行，
 * 不要再发一次 GET（省一次往返，也避免写后读不一致的窗口）。
 */
export function putParentGoalTarget(
  studentId: number,
  metric: ParentGoalMetric,
  target: number,
  subjectId: number,
): Promise<ParentGoalAttainmentItem> {
  // subjectId 走 body（不是路径）：所有目标都按学科，但再加一条同深度模板路径没必要，
  // 也容易和 `goals/:metric` 的匹配产生歧义。
  return fetchApi<ParentGoalAttainmentItem>(
    `/parent/students/${studentId}/goals/${metric}`,
    { method: 'PUT', body: JSON.stringify({ target, subjectId }) },
  );
}

export interface ParentErrorQuestion {
  content: string;
  type: string;
  difficulty: number | null;
  knowledgePoints: Array<{ id: number; name: string }>;
}

export interface ParentErrorItem {
  id: number;
  questionId: number | null;
  /**
   * 轨道档位，由后端按 `source` 现算（分档表见 `apps/server` 的 `TRACK_SOURCES`）：
   * `main` = 课堂练习/讨论/考试；`training` = 训练轨错题 + 辅线答疑里问过的题。
   */
  track: 'main' | 'training';
  source: string;
  level: number;
  isCleared: boolean;
  /**
   * ⚠️ 列名历史误导：它装的**不是**学生作答，而是「题库未命中时保存的题面原文」
   * （`questionId` 非空时该字段为 null，题面取 `question.content`）。
   */
  wrongAnswerText: string | null;
  createdAt: string;
  clearedAt: string | null;
  /** `questionId` 为 null 时整个为 null，此时只能展示 `wrongAnswerText`。 */
  question: ParentErrorQuestion | null;
}

export interface ParentErrorPage {
  items: ParentErrorItem[];
  page: number;
  pageSize: number;
  total: number;
}

export interface ParentErrorListParams {
  studentId: number;
  subject?: number;
  source?: string;
  track?: 'main' | 'training';
  cleared?: 'uncleared' | 'cleared' | 'all';
  from?: string;
  to?: string;
  /** 从 1 起；不传则后端取 1。`pageSize` 服务端固定 20，前端**不传**。 */
  page?: number;
}

export function getParentErrors(params: ParentErrorListParams): Promise<ParentErrorPage> {
  const qs = new URLSearchParams();
  if (params.subject !== undefined) qs.set('subject', String(params.subject));
  if (params.source) qs.set('source', params.source);
  if (params.track) qs.set('track', params.track);
  if (params.cleared) qs.set('cleared', params.cleared);
  if (params.from) qs.set('from', params.from);
  if (params.to) qs.set('to', params.to);
  if (params.page) qs.set('page', String(params.page));
  const query = qs.toString();
  return fetchApi<ParentErrorPage>(
    `/parent/students/${params.studentId}/errors${query ? `?${query}` : ''}`,
  );
}

// --- Parent: 行为管控 P6.6（spec §4.1/§4.2） ---

/**
 * 行为管控 —— **只含两个预警灵敏度阈值**。
 *
 * ⚠️ 奖励兑换开关**故意不在这里**：它归 `GET|PUT .../points/settings`（同一字段两个归属
 * 会打架，见 spec §4.1）。页面要展示兑换状态时另调 `getParentPointsSettings`。
 */
export interface ParentControls {
  /** 孩子切走页面连续多少分钟算「离开」（1..180，默认 5）。 */
  alertAwayMinutes: number;
  /** 孩子前台无操作连续多少分钟算「走神」（1..180，默认 15）。 */
  alertIdleMinutes: number;
}

export function getParentControls(studentId: number): Promise<ParentControls> {
  return fetchApi<ParentControls>(`/parent/students/${studentId}/controls`);
}

/**
 * 部分更新预警灵敏度。**至少给一个字段**（空 patch 后端 409/1001），
 * 且**只发改动过的字段**（后端语义是「未提供即不动」）。返回服务端回读的全量。
 */
export function putParentControls(
  studentId: number,
  patch: Partial<ParentControls>,
): Promise<ParentControls> {
  return fetchApi<ParentControls>(`/parent/students/${studentId}/controls`, {
    method: 'PUT',
    body: JSON.stringify(patch),
  });
}

/** 一条家长端异常预警（`safety_alerts` 的展示投影，见 spec §4.3）。 */
export interface ParentAlertItem {
  id: number;
  studentId: number;
  /** join `students` 得到；两个 FK 都是 `ON DELETE CASCADE`，理论上取不到，前端兜底显示「未知学生」。 */
  studentName: string | null;
  /**
   * 必须与后端 6 值一致（含 `abusive`）。后端 DTO 用的是 `SafetyAlertRow['type']`，
   * 若这里收窄成 5 值，遇到 `abusive` 行会缺分支而 **tsc 不报**（见 Task 6 报告 §9 硬要求）。
   */
  type: 'off_topic' | 'emotional' | 'sensitive' | 'abusive' | 'away' | 'idle';
  level: 'info' | 'warning' | 'critical';
  message: string;
  context: string | null;
  /** 闲聊类预警带对话 id（可跳回放）；其余为 null。 */
  dialogueId: number | null;
  isRead: boolean;
  createdAt: string;
}

export interface ParentAlertPage {
  items: ParentAlertItem[];
  page: number;
  pageSize: number;
  total: number;
}

export interface ParentAlertListParams {
  /** 不传 = **全部孩子**（spec §3.7）。传了就由后端校验归属。 */
  studentId?: number;
  /** 只看未读。后端只认 `'1'`。 */
  unreadOnly?: boolean;
  /** 从 1 起；不传则后端取 1。 */
  page?: number;
  /** 1..50；不传则后端取 20。 */
  pageSize?: number;
}

export function getParentAlerts(params: ParentAlertListParams = {}): Promise<ParentAlertPage> {
  const qs = new URLSearchParams();
  if (params.studentId !== undefined) qs.set('studentId', String(params.studentId));
  if (params.unreadOnly) qs.set('unreadOnly', '1');
  if (params.page) qs.set('page', String(params.page));
  if (params.pageSize) qs.set('pageSize', String(params.pageSize));
  const query = qs.toString();
  return fetchApi<ParentAlertPage>(`/parent/alerts${query ? `?${query}` : ''}`);
}

/** 轮询用的未读预警（spec §3.3：banner 只需要展示字段）。 */
export interface ParentUnreadAlertItem {
  id: number;
  type: string;
  level: string;
  message: string;
  studentName: string | null;
  createdAt: string;
}

export interface ParentUnreadAlerts {
  items: ParentUnreadAlertItem[];
  total: number;
}

export function getParentUnreadAlerts(): Promise<ParentUnreadAlerts> {
  return fetchApi<ParentUnreadAlerts>('/parent/alerts/unread');
}

/** 标记单条预警已读（幂等）。后端返回 `null`。 */
export function markParentAlertRead(alertId: number): Promise<null> {
  return fetchApi<null>(`/parent/alerts/${alertId}/read`, { method: 'PATCH' });
}

// --- Parent: 账号设置 P6.10（spec §4.5/§4.6） ---

/**
 * 家长自己的账号信息（**只读**）。
 *
 * ⚠️ 后端**不返回**订阅/额度/订单（那些表不存在，spec §2.7 的文档漂移已订正）——
 * 别照旧 openapi 的 `subscription`/`AIQuota` 补字段。
 */
export interface ParentAccount {
  id: number;
  /** 家长姓名，可空（注册时不强制）。 */
  name: string | null;
  phone: string;
}

export function getParentAccount(): Promise<ParentAccount> {
  return fetchApi<ParentAccount>('/parent/account');
}

/**
 * 家长改**自己**的密码。后端返回 `null`。
 *
 * 失败口径：旧密码错 → `401`/`1003`（页面据此给旧密码框标错）；新密码长度或
 * 与旧密码相同 → `409`/`1001`。**改后不失效旧 token**（本仓无 token 版本机制，
 * 旧 token 在 7 天有效期内仍可用）。
 */
export function changeParentPassword(oldPassword: string, newPassword: string): Promise<null> {
  return fetchApi<null>('/parent/password', {
    method: 'PATCH',
    body: JSON.stringify({ oldPassword, newPassword }),
  });
}

export interface ParentChatLogItem {
  id: number;
  track: string;
  scene: string;
  title: string | null;
  subjectId: number | null;
  createdAt: string;
  updatedAt: string;
  messageCount: number;
  /**
   * 该会话里 `safety_flag = 1` 的消息数（「偏离学习」）→ UI 打红色标记。
   * 两个来源（2026-09-20 裁决）：模型自报闲聊、或助手消息 `type === 'block'`
   * （现在只剩 anomaly：情绪 / 敏感被阻断）。故文案是「偏离学习」而非「闲聊」。
   */
  blockCount: number;
}

export interface ParentChatLogMessage {
  id: number;
  role: 'system' | 'user' | 'assistant';
  content: string;
  reasoning: string | null;
  type: string | null;
  model: string | null;
  safetyFlag: number;
  createdAt: string;
  /**
   * 孩子随消息发的图片 URL（形如 `/uploads/auxiliary/xxx.jpg`，由 Vite proxy 转给后端）。
   * 服务端已从 `attachments` 的 JSON 串里解析好，**无附件时是空数组**（不是 null）。
   * 注意不要对它用 `resolveAsset`——那是给 `/assets/` 相对路径补前缀的，`/uploads/` 已是绝对路径。
   */
  images: string[];
}

export interface ParentChatLogDetail extends ParentChatLogItem {
  messages: ParentChatLogMessage[];
}

export interface ParentChatLogPage {
  items: ParentChatLogItem[];
  page: number;
  pageSize: number;
  total: number;
}

export interface ParentChatLogListParams {
  studentId: number;
  track?: 'mainline' | 'auxiliary';
  scene?: string;
  from?: string;
  to?: string;
  /** 只搜会话标题（不搜消息正文）。 */
  q?: string;
  page?: number;
}

export function getParentChatLogs(params: ParentChatLogListParams): Promise<ParentChatLogPage> {
  const qs = new URLSearchParams();
  if (params.track) qs.set('track', params.track);
  if (params.scene) qs.set('scene', params.scene);
  if (params.from) qs.set('from', params.from);
  if (params.to) qs.set('to', params.to);
  if (params.q) qs.set('q', params.q);
  if (params.page) qs.set('page', String(params.page));
  const query = qs.toString();
  return fetchApi<ParentChatLogPage>(
    `/parent/students/${params.studentId}/chat-logs${query ? `?${query}` : ''}`,
  );
}

export function getParentChatLogDetail(
  studentId: number,
  dialogueId: number,
): Promise<ParentChatLogDetail> {
  return fetchApi<ParentChatLogDetail>(
    `/parent/students/${studentId}/chat-logs/${dialogueId}`,
  );
}

// --- 学习会话采集（student 角色，埋点 Phase 1A） ---

export interface StartStudySessionBody {
  sessionUid: string;
  module: string;
  scene: string;
  subjectId?: number;
  refType?: string;
  refId?: number;
  screenClass?: string;
  inputType?: string;
  appShell?: string;
}

/** `@Post` 默认 201；`fetchApi` 只判 `code === 0`，无需特殊处理。 */
export function startStudySession(
  body: StartStudySessionBody,
): Promise<{ sessionUid: string; startedAt: string }> {
  return fetchApi<{ sessionUid: string; startedAt: string }>('/study-sessions', {
    method: 'POST',
    body: JSON.stringify(body),
  });
}

export function heartbeatStudySession(
  uid: string,
  state: ClientState,
  subjectId?: number | null,
  reason?: HiddenReason | null,
): Promise<{ activeSeconds: number | null }> {
  // subjectId 只在拿到时带：会话开头可能还没有学科（星图未加载完），后端会用它**补写**
  // 会话的 subject_id（只补不覆盖）——否则这段时长永远归不了科（P6.5）。
  // reason 只在 state='hidden' 时有意义（服务端据此分 away/idle 两口径累计，spec §3.3）；
  // 后端是**可选**字段（兼容旧客户端），所以只在有值时带上。
  return fetchApi<{ activeSeconds: number | null }>(
    `/study-sessions/${encodeURIComponent(uid)}/heartbeat`,
    {
      method: 'PATCH',
      body: JSON.stringify({
        state,
        ...(subjectId ? { subjectId } : {}),
        ...(reason ? { reason } : {}),
      }),
    },
  );
}

export function endStudySession(
  uid: string,
  reason: EndReason,
): Promise<{ activeSeconds: number | null; endedAt: string | null }> {
  return fetchApi<{ activeSeconds: number | null; endedAt: string | null }>(
    `/study-sessions/${encodeURIComponent(uid)}/end`,
    { method: 'PATCH', body: JSON.stringify({ reason }) },
  );
}
