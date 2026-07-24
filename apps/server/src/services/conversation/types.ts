import type { Message, Difficulty, Track, Subject } from '../../ai-core/types.js';

export interface DialogueRecord {
  dialogueId: string;
  messages: Message[];
  failCount: number;
  currentKnowledgePoint?: { id: string; name: string; subject: string };
  currentDifficulty?: Difficulty;
  currentQuestion?: { content: string; answer?: string };
  student: { grade: string; gradeLevel: string; name: string };
  subject: Subject;
  cardContent?: string;
  track: Track;
  createdAt: Date;
  completedAt?: Date;
  completeReason?: string;
}

export interface SaveMessagesRequest {
  dialogueId: string;
  messages: import('../../ai-core/types.js').SaveMessageEntry[];
}

export interface UpdateFailCountRequest {
  dialogueId: string;
  increment: boolean;
}

export interface CompleteDialogueRequest {
  dialogueId: string;
  reason: 'student_completed' | 'fallback_triggered' | 'timeout' | 'manual_end';
}
