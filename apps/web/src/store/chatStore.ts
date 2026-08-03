import { create } from 'zustand';

export interface ChatMessage {
  id?: number;
  role: 'user' | 'assistant';
  content: string;
  type?: string;
  streaming?: boolean;
}

interface ChatState {
  messages: ChatMessage[];
  isStreaming: boolean;
  streamingContent: string;
  setMessages: (msgs: ChatMessage[]) => void;
  appendMessage: (msg: ChatMessage) => void;
  updateLastAssistant: (content: string) => void;
  appendToLastAssistant: (content: string) => void;
  setIsStreaming: (v: boolean) => void;
  setStreamingContent: (v: string) => void;
  reset: () => void;
}

export const useChatStore = create<ChatState>((set) => ({
  messages: [],
  isStreaming: false,
  streamingContent: '',
  setMessages: (msgs) => set({ messages: msgs }),
  appendMessage: (msg) => set((s) => ({ messages: [...s.messages, msg] })),
  updateLastAssistant: (content) =>
    set((s) => {
      const messages = [...s.messages];
      const last = messages[messages.length - 1];
      if (last && last.role === 'assistant') {
        last.content = content;
      }
      return { messages };
    }),
  appendToLastAssistant: (content) =>
    set((s) => {
      const messages = [...s.messages];
      const last = messages[messages.length - 1];
      if (last && last.role === 'assistant') {
        last.content = last.content + content;
      }
      return { messages };
    }),
  setIsStreaming: (v) => set({ isStreaming: v }),
  setStreamingContent: (v) => set({ streamingContent: v }),
  reset: () => set({ messages: [], isStreaming: false, streamingContent: '' }),
}));
