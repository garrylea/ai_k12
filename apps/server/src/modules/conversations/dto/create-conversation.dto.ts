export interface CreateConversationDto {
  track: 'mainline' | 'auxiliary';
  subjectId?: number;
  knowledgePointId?: number;
  // mainline 讨论按 cardId 限定范围（loadContext 据此解析 cardContent 作 prompt 边界）；
  // auxiliary 无卡片，留空。
  cardId?: number;
}
