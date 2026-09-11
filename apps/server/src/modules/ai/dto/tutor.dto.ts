export interface TutorAttachment {
  type: 'image' | 'file';
  fileId: string;
  taskId?: number;  // PDF extraction task ID (from RefineryService.createTask)
}

export interface TutorDto {
  mode: 'mainline' | 'auxiliary';
  message: string;
  cardId?: string;        // mainline only
  knowledgeId?: string;   // auxiliary optional
  dialogueId?: string;    // optional; if absent, a new dialogue is created
  attachments?: TutorAttachment[];
  subjectId?: number;     // Task 14a: for structured question ingestion (defaults to math)
  retry?: boolean;        // P2: true when regenerating after an error - the user
                          // message is already persisted, so skip re-persisting it.
}
