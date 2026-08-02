import type { RowDataPacket } from 'mysql2/promise';

export interface AiDialogueRow extends RowDataPacket {
  id: number;
  student_id: number;
  subject_id: number | null;
  track: 'mainline' | 'auxiliary';
  card_id: number | null;
  knowledge_point_id: number | null;
  title: string | null;
  status: 'active' | 'archived' | 'completed';
  consecutive_fail_count: number;
  created_at: Date;
  updated_at: Date;
  deleted_at: Date | null;
}

export interface AiMessageRow extends RowDataPacket {
  id: number;
  dialogue_id: number;
  role: 'system' | 'user' | 'assistant';
  content: string;
  type: 'socratic' | 'hint' | 'explain' | 'fallback' | 'block' | 'chat' | null;
  attachments: string | null;
  model: string | null;
  token_input: number | null;
  token_output: number | null;
  response_time_ms: number | null;
  safety_flag: number;
  created_at: Date;
  deleted_at: Date | null;
}

export interface AuxErrorBookRow extends RowDataPacket {
  id: number;
  student_id: number;
  subject_id: number;
  question_id: number | null;
  level: number;
  is_cleared: number;
  source: 'auxiliary' | 'photo';
  wrong_answer_text: string | null;
  cleared_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

export interface ExtractTaskRow extends RowDataPacket {
  id: number;
  file_id: number;
  student_id: number | null;
  provider: string;
  status: 'pending' | 'processing' | 'completed' | 'failed';
  result: string | null;
  error_message: string | null;
  created_at: Date;
  updated_at: Date;
}

export interface SafetyAlertRow extends RowDataPacket {
  id: number;
  parent_id: number;
  student_id: number;
  dialogue_id: number | null;
  message_id: number | null;
  type: 'off_topic' | 'emotional' | 'sensitive' | 'abusive';
  level: 'info' | 'warning' | 'critical';
  message: string;
  context: string | null;
  is_read: number;
  read_at: Date | null;
  created_at: Date;
}

export interface QuestionRow extends RowDataPacket {
  id: number;
  subject_id: number;
  type: string;
  difficulty: number;
  content: string;
  options: string | null;
  answer: string;
  explanation: string;
  source: string;
  content_hash: string;
  created_at: Date;
}

export interface UploadedFileRow extends RowDataPacket {
  id: number;
  uploader_id: number;
  uploader_type: string;
  url: string;
  mime_type: string;
  size_bytes: number;
  source: string;
  created_at: Date;
}
