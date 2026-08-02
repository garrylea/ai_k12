export interface CreateAuxErrorDto {
  subjectId: number;
  rawContent?: string;
  extractTaskId?: number;
  source: 'auxiliary' | 'photo';
}
