export interface ListConversationsDto {
  track: 'mainline' | 'auxiliary';
  cursor?: number;
}
