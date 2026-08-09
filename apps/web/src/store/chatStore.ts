import { create } from 'zustand';

export interface ChatError {
  code: number;
  message: string;
  retryable: boolean;
  stage?: 'transcribe' | 'tutor';  // which stage failed (for two-stage retry, P2)
}

// P1: image two-stage flow UI state attached to the assistant message that
// ended in a flow step (transcription awaiting selection/confirmation).
export interface ChatFlow {
  stage: 'select' | 'confirm' | 'unrecognizable';
  question?: string;                // stage='confirm' - the transcribed problem
  problems?: { index: number; text: string }[];  // stage='select' - all problems
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
  flow?: ChatFlow;
}

interface ChatState {
  messages: ChatMessage[];
  isStreaming: boolean;
  setMessages: (msgs: ChatMessage[]) => void;
  appendMessage: (msg: ChatMessage) => void;
  updateLastAssistant: (content: string, reasoning?: string) => void;
  appendLastAssistant: (opts: { content?: string; reasoning?: string }) => void;
  setLastAssistantError: (err: ChatError) => void;
  resetLastAssistantToStreaming: () => void;
  setLastAssistantFlow: (flow: ChatFlow, content: string) => void;
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
  resetLastAssistantToStreaming: () =>
    set((s) => {
      const messages = [...s.messages];
      const last = messages[messages.length - 1];
      if (last && last.role === 'assistant') {
        // Replace the error bubble with a fresh streaming placeholder (retry).
        messages[messages.length - 1] = { role: 'assistant', content: '', streaming: true };
      } else {
        // No assistant message yet (e.g. reload after an error left the last
        // user message unanswered) - append a streaming placeholder.
        messages.push({ role: 'assistant', content: '', streaming: true });
      }
      return { messages, isStreaming: true };
    }),
  setLastAssistantFlow: (flow, content) =>
    set((s) => {
      const messages = [...s.messages];
      const last = messages[messages.length - 1];
      if (last && last.role === 'assistant') {
        // Populate the streaming placeholder with the flow result + attach the
        // flow UI state (buttons). Stop streaming.
        messages[messages.length - 1] = { ...last, content, streaming: false, flow };
      }
      return { messages, isStreaming: false };
    }),
  setIsStreaming: (v) => set({ isStreaming: v }),
  reset: () => set({ messages: [], isStreaming: false }),
}));
