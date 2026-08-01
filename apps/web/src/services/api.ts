const API_BASE = '/api';

export interface ApiResponse<T> {
  code: number;
  message: string;
  data: T;
}

class ApiError extends Error {
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
