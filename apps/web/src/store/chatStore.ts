import { create } from 'zustand';

export interface ChatError {
  code: number;
  message: string;
  retryable: boolean;
  stage?: 'transcribe' | 'tutor';  // which stage failed (for two-stage retry, P2)
}

export interface ChatMessage {
  id?: number;
  role: 'user' | 'assistant';
  content: string;
  type?: string;
  images?: string[];
  reasoning?: string;
  streaming?: boolean;
  error?: ChatError;
}

interface ChatState {
  messages: ChatMessage[];
  isStreaming: boolean;
  setMessages: (msgs: ChatMessage[]) => void;
  appendMessage: (msg: ChatMessage) => void;
  updateLastAssistant: (content: string, reasoning?: string) => void;
  appendLastAssistant: (opts: { content?: string; reasoning?: string }) => void;
  setLastAssistantError: (err: ChatError) => void;
  setIsStreaming: (v: boolean) => void;
  reset: () => void;
}

export const useChatStore = create<ChatState>((set) => ({
  messages: [],
  isStreaming: false,
  setMessages: (msgs) => set({ messages: msgs }),
  appendMessage: (msg) => set((s) => ({ messages: [...s.messages, msg] })),
  updateLastAssistant: (content, reasoning) =>
    set((s) => {
      const messages = [...s.messages];
      const last = messages[messages.length - 1];
      if (last && last.role === 'assistant') {
        messages[messages.length - 1] = {
          ...last,
          content,
          ...(reasoning !== undefined ? { reasoning } : {}),
        };
      }
      return { messages };
    }),
  appendLastAssistant: (opts) =>
    set((s) => {
      const messages = [...s.messages];
      const last = messages[messages.length - 1];
      if (last && last.role === 'assistant') {
        const updated: ChatMessage = { ...last };
        if (opts.content !== undefined) updated.content = last.content + opts.content;
        if (opts.reasoning !== undefined) updated.reasoning = (last.reasoning ?? '') + opts.reasoning;
        messages[messages.length - 1] = updated;
      }
      return { messages };
    }),
  setLastAssistantError: (err) =>
    set((s) => {
      const messages = [...s.messages];
      const last = messages[messages.length - 1];
      if (last && last.role === 'assistant') {
        // Replace the streaming placeholder with an error state: clear content
        // (no partial leaked), stop streaming, attach the structured error.
        messages[messages.length - 1] = {
          ...last,
          content: '',
          reasoning: last.reasoning,  // keep any reasoning already streamed (for context)
          streaming: false,
          error: err,
        };
      }
      return { messages, isStreaming: false };
    }),
  setIsStreaming: (v) => set({ isStreaming: v }),
  reset: () => set({ messages: [], isStreaming: false }),
}));
