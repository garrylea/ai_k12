import { create } from 'zustand';
import { listAllConversations, type ConversationItem } from '@/services/api';

interface AuxiliaryState {
  currentDialogueId: number | null;
  conversations: ConversationItem[];
  auxErrorCount: number;
  setCurrentDialogueId: (id: number | null) => void;
  setConversations: (list: ConversationItem[]) => void;
  prependConversation: (c: ConversationItem) => void;
  updateConversationTitle: (id: number, title: string) => void;
  removeConversation: (id: number) => void;
  fetchConversations: () => Promise<void>;
  setAuxErrorCount: (n: number) => void;
}

export const useAuxiliaryStore = create<AuxiliaryState>((set) => ({
  currentDialogueId: null,
  conversations: [],
  auxErrorCount: 0,
  setCurrentDialogueId: (id) => set({ currentDialogueId: id }),
  setConversations: (list) => set({ conversations: list }),
  prependConversation: (c) => set((s) => ({ conversations: [c, ...s.conversations] })),
  updateConversationTitle: (id, title) =>
    set((s) => ({
      conversations: s.conversations.map((c) => (c.id === id ? { ...c, title } : c)),
    })),
  removeConversation: (id) =>
    set((s) => ({ conversations: s.conversations.filter((c) => c.id !== id) })),
  fetchConversations: async () => {
    try {
      const items = await listAllConversations('auxiliary');
      set({ conversations: items });
    } catch {
      // ignore - the list will retry on the next interaction
    }
  },
  setAuxErrorCount: (n) => set({ auxErrorCount: n }),
}));
