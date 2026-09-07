import type { RowDataPacket } from 'mysql2/promise';

/** 会话场景分型：按使用场景隔离各系统的对话历史（共用 ai_dialogues 一张表）。 */
export type AiDialogueScene = 'aux_qna' | 'aux_training' | 'mainline_question' | 'mainline_card';

export interface AiDialogueRow extends RowDataPacket {
  id: number;
  student_id: number;
  subject_id: number | null;
  track: 'mainline' | 'auxiliary';
  scene: AiDialogueScene;
  card_id: number | null;
  question_id: number | null;
  knowledge_point_id: number | null;
  title: string | null;
  status: 'active' | 'archived' | 'completed';
  flow_state: 'idle' | 'awaiting_selection' | 'awaiting_confirmation';
  pending_question: string | null;
  pending_questions: string | null;
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
  reasoning: string | null;
  type: 'socratic' | 'hint' | 'explain' | 'fallback' | 'block' | 'chat' | 'transcription' | null;
  attachments: string | null;
  model: string | null;
  token_input: number | null;
  token_output: number | null;
  response_time_ms: number | null;
  safety_flag: number;
  created_at: Date;
  deleted_at: Date | null;
}

export interface MainErrorBookRow extends RowDataPacket {
  id: number;
  student_id: number;
  subject_id: number;
  question_id: number | null; // 可空：质量差仅存题面时为 null
  level: number;
  is_cleared: number;
  source: string; // 'practice' | 'discuss' | 'homework' | 'unit_test' | 'midterm' | 'final' | ...
  source_ref_id: number | null;
  /** 卡内复合题号（如 "0-1"），错题清零展示与判题复用所需。可空（discuss/历史行）。 */
  question_n: string | null;
  /** 错题所属课时 id（冗余字段，用于按课聚合/统计）。 */
  lesson_id: number | null;
  wrong_answer_text: string | null;
  /** 关联的 mainline 讨论对话 id（B方案：跨刷新/跨设备续接同一讨论线）。软引用，可空。 */
  dialogue_id: number | null;
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
  explanation: string | null;
  source: string | null;
  content_hash: string | null;
  is_active: number;
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

export interface ErrorRedoLogRow extends RowDataPacket {
  id: number;
  error_book_type: 'main' | 'aux';
  error_item_id: number;
  student_id: number;
  answer_text: string | null;
  attachments: string | null;
  is_correct: number;
  error_level_before: number;
  error_level_after: number;
  created_at: Date;
}

export interface PracticeResultRow extends RowDataPacket {
  id: number;
  student_id: number;
  subject_id: number;
  card_id: number;
  lesson_id: number;
  question_id: number | null;
  question_n: string;
  question_text: string;
  student_answer: string;
  is_correct: number;
  method: 'exact' | 'ai';
  analysis: string | null;
  error_type: 'logic' | 'calculation' | 'format' | 'missing' | null;
  judged_at: Date;
  created_at: Date;
  updated_at: Date;
}

export interface StudentHiddenQuestionRow extends RowDataPacket {
  id: number;
  student_id: number;
  subject_id: number;
  question_id: number;
  created_at: Date;
  updated_at: Date;
}

/** 不再展示清单展示用行（JOIN questions + qkp 聚合后）。 */
export interface HiddenQuestionListRow extends RowDataPacket {
  questionId: number;
  questionText: string;
  type: string;
  kpName: string | null;
  markedAt: Date;
}
