const API_BASE = '/api';

export interface ApiResponse<T> {
  code: number;
  message: string;
  data: T;
}

export class ApiError extends Error {
  code: number;
  constructor(code: number, message: string) {
    super(message);
    this.code = code;
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
    throw new ApiError(json.code, json.message);
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

export interface CardMetadata {
  images?: CardImage[];
  layout_hint?: string;
  override_scroll?: 'allow' | 'disable';
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
}

export async function uploadFile(file: File): Promise<UploadedFileResult> {
  const token = localStorage.getItem('token');
  const form = new FormData();
  form.append('file', file);
  const res = await fetch(`${API_BASE}/files/upload`, {
    method: 'POST',
    headers: token ? { Authorization: `Bearer ${token}` } : {},
    // NOTE: do NOT set Content-Type - browser sets multipart boundary
    body: form,
  });
  const json: ApiResponse<UploadedFileResult> = await res.json();
  if (json.code !== 0) throw new ApiError(json.code, json.message);
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
  track: 'auxiliary';
  subjectId?: number;
  knowledgePointId?: number;
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

export interface MessageItem {
  id: number;
  dialogue_id: number;
  role: 'system' | 'user' | 'assistant';
  content: string;
  type: string | null;
  created_at: string;
}

export function getMessages(dialogueId: number, lastMessageId?: number): Promise<MessageItem[]> {
  const qs = lastMessageId ? `?lastMessageId=${lastMessageId}` : '';
  return fetchApi<MessageItem[]>(`/conversations/${dialogueId}/messages${qs}`);
}

// --- AI Tutor (auxiliary) ---

export interface AttachmentRequest {
  type: 'image';
  fileId: string;
}

export interface TutorResponse {
  dialogueId: string;
  message: { role: string; content: string; type?: string };
  safety: { isLearningRelated: boolean; alertLevel: string };
  fallback: boolean;
  consecutiveFailCount: number;
}

export function tutor(req: {
  mode: 'auxiliary';
  message: string;
  dialogueId?: string;
  knowledgeId?: string;
  cardId?: string;
  attachments?: AttachmentRequest[];
}): Promise<TutorResponse> {
  return fetchApi<TutorResponse>('/ai/tutor', {
    method: 'POST',
    body: JSON.stringify(req),
  });
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

// --- Error Book (auxiliary) ---

export interface AuxErrorItem {
  id: number;
  question_id: number | null;
  level: number;
  is_cleared: number;
  source: string;
  created_at: string;
}

export function listAuxErrors(
  studentId: number,
  subjectId?: number,
  includeCleared = false,
): Promise<AuxErrorItem[]> {
  const params = new URLSearchParams();
  if (subjectId) params.set('subject', String(subjectId));
  if (includeCleared) params.set('includeCleared', 'true');
  const qs = params.toString() ? `?${params.toString()}` : '';
  return fetchApi<AuxErrorItem[]>(`/error-book/students/${studentId}/aux${qs}`);
}

export function createAuxError(req: {
  subjectId: number;
  source: 'auxiliary' | 'photo';
  rawContent?: string;
  extractTaskId?: number;
}): Promise<{ errorId: number; questionId: number | null; structured: unknown }> {
  return fetchApi<{ errorId: number; questionId: number | null; structured: unknown }>('/error-book/aux', {
    method: 'POST',
    body: JSON.stringify(req),
  });
}
