export interface CreateConversationDto {
  track: 'mainline' | 'auxiliary';
  subjectId?: number;
  knowledgePointId?: number;
}
