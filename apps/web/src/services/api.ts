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

/**
 * `POST /api/progress/update` 追加的可选积分反馈（计划一新增，向后兼容：
 * 老后端不返回该字段时 `points === undefined`）。
 * 幂等命中 / 无规则时 `awarded === 0`——**不是错误**，静默处理。
 */
export interface UpdateProgressPoints {
  awarded: number;
  /** `award_failed` 分支后端可能回 `null`（积分入账失败）——前端勿用 null 覆盖本地积分快照（计划 §1.1#3） */
  balance: number | null;
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
  if (json.code !== 0) throw new ApiError(json.code, json.message, json.retryable);
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
   * **排除 `not_cleared`**：那是甲类逐目标发分（答对但本无未清错题行）特有的原因，
   * complete 端点永远不返回它（openapi `CompleteSessionResult.reason` 枚举同此）。
   */
  reason?: Exclude<PointsAwardReason, 'not_cleared'> | 'already_completed' | 'award_failed';
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
