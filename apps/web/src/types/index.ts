export type ThemeMode = 'student-day' | 'student-night' | 'parent';
export type SchoolLevel = 'primary' | 'junior' | 'senior';
export type TrackType = 'mainline' | 'auxiliary';
export type Difficulty = 'easy' | 'medium' | 'hard';
export type Subject = 'math' | 'chinese' | 'english';

export interface StudentProfile {
  id: string;
  username: string;
  name: string;
  grade: SchoolLevel;
  textbookVersion: string;
}

export interface Section {
  id: string;
  title: string;
  order: number;
  knowledgePointCount: number;
  status: 'completed' | 'current' | 'locked';
  progress: number;
}

export interface Chapter {
  id: string;
  title: string;
  order: number;
  importance: 'large' | 'medium' | 'small';
  status: 'completed' | 'current' | 'locked';
  progress: number;
  sections: Section[];
}

export interface Question {
  id: string;
  difficulty: Difficulty;
  track: TrackType;
  subject: Subject;
  knowledgePoints: string[];
  source: 'homework' | 'unit-test' | 'midterm' | 'final' | 'auxiliary';
  content: string;
  answer: string;
  studentAnswer?: string;
  isCorrect?: boolean;
}

export interface ErrorBookItem {
  id: string;
  question: Question;
  level: 1 | 2 | 3 | 4 | 5;
  lastErrorTime: string;
  timesErrored: number;
}

/** 卡片内单张图片的元信息 */
export interface ImageMeta {
  url: string;
  alt?: string;
  position: 'inline';
  width: number;
  height: number;
}

/** 教材学习卡片（对应 cards 表 + content_metadata） */
export interface CardContent {
  id: number;
  lesson_id: number;
  sort_order: number;
  card_type: 'concept' | 'example' | 'practice' | 'explore' | 'summary' | 'reading';
  title?: string;
  content: string;  // Markdown 原文
  content_metadata?: {
    images: ImageMeta[];
  };
  knowledge_point_ids?: string[];
  textbook_page?: string;
}

// Re-export from API service for convenience
export type { StarMapData, ChapterData, SectionData } from '@/services/api';
