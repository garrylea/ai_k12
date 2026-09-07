import type { AiDialogueScene } from '../../../database/repositories/types.js';

export interface CreateConversationDto {
  track: 'mainline' | 'auxiliary';
  subjectId?: number;
  knowledgePointId?: number;
  // mainline 讨论按 cardId 限定范围（loadContext 据此解析 cardContent 作 prompt 边界）；
  // auxiliary 无卡片，留空。
  cardId?: number;
  // 会话场景分型（缺省 auxiliary -> aux_qna，mainline -> 由调用方显式传）。
  scene?: AiDialogueScene;
  // 训练讲一讲按题锚：scene='aux_training' 时用于 (student, track, scene, question_id) find-or-create。
  questionId?: number;
  // 题面锚消息：新建（非复用）会话时把题面作为一条 assistant 消息写入历史，
  // 让 AI 每轮靠对话历史带题面，学生消息保持干净。复用旧会话时不补写。
  questionText?: string;
}
