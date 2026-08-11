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

export interface LoginResult {
  token: string;
  user: { id: number; role: string; name: string; username: string; grade?: string };
}

export function login(username: string, password: string): Promise<LoginResult> {
  return fetchApi<LoginResult>('/auth/login', {
    method: 'POST',
    body: JSON.stringify({ username, password }),
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

export interface PreviousErrorsResult {
  lessonId: number | null;
  count: number;
}

export function getPreviousLessonErrors(lessonId: number): Promise<PreviousErrorsResult> {
  return fetchApi<PreviousErrorsResult>(`/practice/previous-errors?lessonId=${lessonId}`);
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
