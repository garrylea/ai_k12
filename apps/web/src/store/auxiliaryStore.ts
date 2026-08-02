import { create } from 'zustand';
import type { ConversationItem } from '@/services/api';

interface AuxiliaryState {
  currentDialogueId: number | null;
  conversations: ConversationItem[];
  auxErrorCount: number;
  setCurrentDialogueId: (id: number | null) => void;
  setConversations: (list: ConversationItem[]) => void;
  prependConversation: (c: ConversationItem) => void;
  setAuxErrorCount: (n: number) => void;
}

export const useAuxiliaryStore = create<AuxiliaryState>((set) => ({
  currentDialogueId: null,
  conversations: [],
  auxErrorCount: 0,
  setCurrentDialogueId: (id) => set({ currentDialogueId: id }),
  setConversations: (list) => set({ conversations: list }),
  prependConversation: (c) => set((s) => ({ conversations: [c, ...s.conversations] })),
  setAuxErrorCount: (n) => set({ auxErrorCount: n }),
}));
