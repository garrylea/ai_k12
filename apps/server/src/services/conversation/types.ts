import type { SaveMessageEntry } from '../../ai-core/types.js';

export interface SaveMessagesRequest {
  dialogueId: string;
  messages: SaveMessageEntry[];
}

export interface UpdateFailCountRequest {
  dialogueId: string;
  increment: boolean;
}

export interface CompleteDialogueRequest {
  dialogueId: string;
}
