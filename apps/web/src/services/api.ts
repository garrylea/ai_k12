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
  constructor(code: number, message: string, retryable?: boolean) {
    super(message);
    this.code = code;
    this.retryable = retryable;
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
    throw new ApiError(json.code, json.message, json.retryable);
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

export function updateProgress(data: { subjectId: number; lessonId: number; cardSortOrder: number }): Promise<{ advanced: boolean; nextLessonId?: number; completed?: boolean; nextUnlockType?: string; reason?: string; currentLessonId?: number }> {
  return fetchApi<{ advanced: boolean; nextLessonId?: number; completed?: boolean; nextUnlockType?: string; reason?: string; currentLessonId?: number }>('/progress/update', {
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
  if (json.code !== 0) throw new ApiError(json.code, json.message, json.retryable);
  return json.data;
}

// --- Conversations (auxiliary) ---

export interface ConversationItem {
  id: number;
  track: 'mainline' | 'auxiliary';
  title: string | null;
  status: string;
  created_at: string;
}

export function createConversation(req: {
  track: 'mainline' | 'auxiliary';
  subjectId?: number;
  knowledgePointId?: number;
  cardId?: number;
}): Promise<ConversationItem> {
  return fetchApi<ConversationItem>('/conversations', {
    method: 'POST',
    body: JSON.stringify(req),
  });
}

export function listConversations(track: 'auxiliary', cursor?: number): Promise<ConversationItem[]> {
  const qs = cursor ? `?track=${track}&cursor=${cursor}` : `?track=${track}`;
  return fetchApi<ConversationItem[]>(`/conversations${qs}`);
}

// Fetch ALL conversations by walking the cursor-paginated list endpoint
// (backend ConversationsService.PAGE_SIZE = 10, ORDER BY id DESC, cursor = id).
// Used by the sidebar so the "展开全部" button can reveal history beyond the
// first page. Capped at 50 pages (500 items) as a safety valve against a
// runaway loop; a K12 student won't approach that.
export async function listAllConversations(track: 'auxiliary'): Promise<ConversationItem[]> {
  const PAGE = 10;
  const all: ConversationItem[] = [];
  let cursor: number | undefined;
  for (let i = 0; i < 50; i++) {
    const page = await listConversations(track, cursor);
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
  isCorrect: boolean;
  method: 'exact' | 'ai';
  analysis: string | null;
  errorType?: 'logic' | 'calculation' | 'format' | 'missing' | null;
  errorBookId?: number;
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
  analysis: string | null;
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
}): Promise<{ questions: TargetedPracticeQuestion[] }> {
  return fetchApi<{ questions: TargetedPracticeQuestion[] }>('/training/targeted/start', {
    method: 'POST',
    body: JSON.stringify(payload),
  });
}
