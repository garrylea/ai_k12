import type { ChatRequest, ChatResponse, StreamChunk } from '../../types.js';

export interface ProviderAdapter {
  chat(request: ChatRequest): Promise<ChatResponse>;
  streamChat(request: ChatRequest): AsyncIterable<StreamChunk>;
}
